import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession, type VoiceState, type Transcription } from '../src/voice';
import type { Capture } from '../src/capture';
const result = (text: string): Transcription => ({ text, latencyMs: 100, duration: 2, engine: 'test' });
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const heard: string[] = [], errors: string[] = [], states: VoiceState[] = [], starts: number[] = [];
  let frame: (samples: Float32Array) => void = () => {}, lost = () => {}, closed = false, enabled = true;
  const pending: { audio: ArrayBuffer; signal: AbortSignal; resolve: (result: Transcription) => void; reject: (error: Error) => void }[] = [];
  const timers = new Set<() => void>();
  const voice = new VoiceSession({
    capture: async (_signal, callback, onLost) => { frame = callback; lost = onLost; return { sampleRate: 16000, close: () => { closed = true; }, setEnabled: value => { enabled = value; } }; },
    transcribe: (audio, signal) => new Promise((resolve, reject) => pending.push({ audio, signal, resolve, reject })),
    onSpeechStart: () => starts.push(pending.length), onUtterance: text => heard.push(text), onState: state => states.push(state), onError: message => errors.push(message),
    schedule: task => { timers.add(task); return () => { timers.delete(task); }; },
  });
  const speak = () => { for (let i = 0; i < 25; i++) frame(new Float32Array(512).fill(.08)); for (let i = 0; i < 30; i++) frame(new Float32Array(512)); };
  return { voice, pending, heard, errors, states, starts, timers, speak, frames: (count: number, amplitude = 0) => { for (let i = 0; i < count; i++) frame(new Float32Array(512).fill(amplitude)); }, lost: () => lost(), isClosed: () => closed, isEnabled: () => enabled,
    silence: () => { for (let i = 0; i < 1900; i++) frame(new Float32Array(512)); },
    flush: () => { for (const task of [...timers]) { timers.delete(task); task(); } } };
}
test('silence keeps the same live session without ASR traffic', async () => {
  const f = fixture(); await f.voice.start(); f.silence();
  assert.equal(f.pending.length, 0); assert.equal(f.states.at(-1), 'listening'); f.voice.dispose();
});
test('completed speech is recognized once while capture stays live and immediately resumes after the reply', async () => {
  const f = fixture(); await f.voice.start(); f.speak();
  assert.equal(f.pending.length, 1); assert.equal(f.isEnabled(), true);
  f.pending[0].resolve(result('怎样制作数字人')); await settle();
  assert.deepEqual(f.heard, ['怎样制作数字人']); assert.equal(f.states.at(-1), 'responding');
  assert.equal(f.isEnabled(), true); f.voice.resume(); assert.equal(f.timers.size, 0); assert.equal(f.isEnabled(), true); assert.equal(f.states.at(-1), 'listening');
  f.speak(); assert.equal(f.pending.length, 2); f.voice.dispose();
});
test('interrupt aborts recognition and rejects late results before a new utterance', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); f.voice.interrupt();
  assert.equal(f.pending[0].signal.aborted, true); f.pending[0].resolve(result('旧结果')); await settle();
  assert.deepEqual(f.heard, []); f.speak(); f.pending[1].resolve(result('新问题')); await settle();
  assert.deepEqual(f.heard, ['新问题']); f.voice.dispose();
});
test('explicit end closes capture, cancels recognition and cannot auto restart', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); f.voice.stop(); f.voice.resume(); f.flush();
  f.pending[0].resolve(result('迟到')); await settle();
  assert.equal(f.isClosed(), true); assert.equal(f.pending[0].signal.aborted, true); assert.equal(f.states.at(-1), 'off'); assert.deepEqual(f.heard, []);
});
test('an empty recognition reopens listening without emitting a turn', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); f.pending[0].resolve(result('')); await settle();
  assert.equal(f.states.at(-1), 'listening'); assert.equal(f.isEnabled(), true); assert.deepEqual(f.heard, []); f.voice.dispose();
});
test('typed questions retain live capture and suppress the preceding speech result', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); f.voice.hold();
  f.pending[0].resolve(result('不再需要')); await settle(); assert.deepEqual(f.heard, []);
  assert.equal(f.isEnabled(), true); f.voice.resume(); f.voice.stop(); f.flush(); assert.equal(f.states.at(-1), 'off');
});
test('a disconnected microphone exits cleanly with specific guidance', async () => {
  const f = fixture(); await f.voice.start(); f.lost();
  assert.equal(f.states.at(-1), 'off'); assert.equal(f.isClosed(), true); assert.match(f.errors[0], /麦克风已断开/);
});
test('ASR failures leave text input usable and release the microphone', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); f.pending[0].reject(new Error('本地模型不可用')); await settle();
  assert.equal(f.states.at(-1), 'off'); assert.equal(f.isClosed(), true); assert.equal(f.errors[0], '本地模型不可用');
});
test('late permission approval after stop immediately closes the new stream', async () => {
  let grant!: (capture: Capture) => void, closed = false;
  const voice = new VoiceSession({ capture: () => new Promise(resolve => { grant = resolve; }), transcribe: async () => result(''), onUtterance: () => {}, onState: () => {}, onError: () => {} });
  const start = voice.start(); voice.stop(); grant({ sampleRate: 16000, setEnabled: () => {}, close: () => { closed = true; } }); await start;
  assert.equal(closed, true);
});
test('a disconnected old capture cannot stop a newly started session', async () => {
  const callbacks: (() => void)[] = [], states: VoiceState[] = [], errors: string[] = [];
  const voice = new VoiceSession({
    capture: async (_signal, _frame, lost) => { callbacks.push(lost); return { sampleRate: 16000, setEnabled: () => {}, close: () => {} }; },
    transcribe: async () => result(''), onUtterance: () => {}, onState: state => states.push(state), onError: message => errors.push(message),
  });
  await voice.start(); voice.stop(); await voice.start(); callbacks[0]();
  assert.equal(states.at(-1), 'listening'); assert.equal(errors.length, 0); voice.dispose();
});

test('confirmed speech interrupts a reply once, preserves its first samples, and short noise does not', async () => {
  const f = fixture(); await f.voice.start(); f.voice.hold();
  f.frames(1, .2); f.frames(35); f.silence();
  assert.equal(f.states.at(-1), 'responding'); assert.equal(f.starts.length, 0); assert.equal(f.pending.length, 0);
  f.frames(7, .07); assert.equal(f.starts.length, 0);
  f.frames(1, .07); assert.equal(f.starts.length, 1); assert.equal(f.states.at(-1), 'listening');
  f.frames(10, .07); f.frames(10); f.frames(10, .06); f.frames(30);
  assert.equal(f.starts.length, 1); assert.equal(f.pending.length, 1);
  const pcm = new DataView(f.pending[0].audio);
  let firstAmplitudeSamples = 0;
  for (let i = 44; i < pcm.byteLength; i += 2) if (pcm.getInt16(i, true) === Math.round(.07 * 32767)) firstAmplitudeSamples++;
  assert.equal(firstAmplitudeSamples, 18 * 512, 'onset/pre-roll and hesitation must retain the full first word');
  f.pending[0].resolve(result('等等，我还想补充')); await settle();
  assert.deepEqual(f.heard, ['等等，我还想补充']); f.voice.dispose();
});
test('speech during ASR cancels old recognition and combines the unsubmitted utterance with the supplement', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); const first = f.pending[0];
  f.frames(4, .06); assert.equal(first.signal.aborted, true); assert.equal(f.starts.length, 2);
  first.resolve(result('首句旧结果')); await settle(); assert.deepEqual(f.heard, []);
  f.frames(20, .06); f.frames(30); assert.equal(f.pending.length, 2);
  const combined = new Uint8Array(f.pending[1].audio), original = new Uint8Array(first.audio);
  assert.deepEqual(combined.slice(44, original.byteLength), original.slice(44), 'original audio is retained without dropping its opening sentence');
  assert.ok(combined.byteLength > original.byteLength);
  f.pending[1].resolve(result('首句加上补充')); await settle();
  assert.deepEqual(f.heard, ['首句加上补充']); f.voice.dispose();
});
test('ASR completion racing the first speech frame waits for the confirmed supplement', async () => {
  const f = fixture(); await f.voice.start(); f.speak();
  f.frames(1, .06); f.pending[0].resolve(result('过早完成')); await settle();
  assert.deepEqual(f.heard, []); f.frames(3, .06); assert.equal(f.pending[0].signal.aborted, true);
  f.frames(20, .06); f.frames(30); f.pending[1].resolve(result('包含补充')); await settle();
  assert.deepEqual(f.heard, ['包含补充']); f.voice.dispose();
});
test('a brief click does not consume a ready recognition or leave it indefinitely waiting', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); f.frames(1, .2);
  f.pending[0].resolve(result('完整问题')); await settle(); assert.deepEqual(f.heard, []);
  f.frames(4); assert.deepEqual(f.heard, ['完整问题']); assert.equal(f.starts.length, 1); f.voice.dispose();
});
test('a minimal confirmed supplement still completes and cannot strand the cancelled ASR', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); f.frames(4, .08); f.frames(30);
  assert.equal(f.pending[0].signal.aborted, true); assert.equal(f.pending.length, 2);
  f.pending[1].resolve(result('首句，好')); await settle(); assert.deepEqual(f.heard, ['首句，好']); f.voice.dispose();
});
test('new speech during a reply is a new turn and never repeats the committed audio', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); f.pending[0].resolve(result('第一轮')); await settle();
  f.speak(); assert.equal(f.pending.length, 2);
  assert.ok(f.pending[1].audio.byteLength <= f.pending[0].audio.byteLength + 512 * 2);
  f.pending[1].resolve(result('第二轮')); await settle(); assert.deepEqual(f.heard, ['第一轮', '第二轮']); f.voice.dispose();
});
test('reply completion preserves a word already starting and has no scheduled capture gap', async () => {
  const f = fixture(); await f.voice.start(); f.voice.hold(); f.frames(3, .08); f.voice.resume();
  assert.equal(f.timers.size, 0); f.frames(1, .08); assert.equal(f.starts.length, 1);
  f.frames(21, .08); f.frames(30); assert.equal(f.pending.length, 1);
  f.pending[0].resolve(result('刚好接上')); await settle(); assert.deepEqual(f.heard, ['刚好接上']); f.voice.dispose();
});
test('a late failed recognition cannot stop a newer speech turn', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); f.speak();
  f.pending[0].reject(new Error('过期失败')); await settle();
  assert.equal(f.isClosed(), false); assert.deepEqual(f.errors, []);
  f.pending[1].resolve(result('当前话题')); await settle(); assert.deepEqual(f.heard, ['当前话题']); f.voice.dispose();
});
test('frames retained by an old capture cannot trigger speech or ASR in a restarted session', async () => {
  const frames: ((samples: Float32Array) => void)[] = []; let starts = 0, requests = 0;
  const voice = new VoiceSession({
    capture: async (_signal, frame) => { frames.push(frame); return { sampleRate: 16000, setEnabled: () => {}, close: () => {} }; },
    transcribe: async () => { requests++; return result(''); }, onSpeechStart: () => { starts++; }, onUtterance: () => {}, onState: () => {}, onError: () => {},
  });
  await voice.start(); voice.stop(); await voice.start();
  for (let i = 0; i < 25; i++) frames[0](new Float32Array(512).fill(.08));
  for (let i = 0; i < 30; i++) frames[0](new Float32Array(512));
  await settle(); assert.equal(starts, 0); assert.equal(requests, 0); voice.dispose();
});
test('stop after a speech-start notification prevents any ASR submission', async () => {
  let frame: (samples: Float32Array) => void = () => {}, requests = 0;
  const voice = new VoiceSession({
    capture: async (_signal, callback) => { frame = callback; return { sampleRate: 16000, setEnabled: () => {}, close: () => {} }; },
    transcribe: async () => { requests++; return result(''); }, onSpeechStart: () => voice.stop(), onUtterance: () => {}, onState: () => {}, onError: () => {},
  });
  await voice.start(); for (let i = 0; i < 25; i++) frame(new Float32Array(512).fill(.08));
  for (let i = 0; i < 30; i++) frame(new Float32Array(512));
  await settle(); assert.equal(requests, 0); voice.dispose();
});
test('long accumulated supplements fail explicitly rather than dropping the opening sentence or exceeding the server limit', async () => {
  const f = fixture(); await f.voice.start(); f.frames(530, .08); f.frames(30);
  assert.equal(f.pending.length, 1); f.frames(90, .07); f.frames(30);
  assert.equal(f.pending[0].signal.aborted, true); assert.equal(f.pending.length, 1);
  assert.equal(f.isClosed(), true); assert.match(f.errors[0], /20 秒/); assert.deepEqual(f.heard, []);
});
