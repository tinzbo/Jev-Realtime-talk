import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession, type VoiceState, type Transcription } from '../src/voice';
import type { Capture } from '../src/capture';
const result = (text: string): Transcription => ({ text, latencyMs: 100, duration: 2, engine: 'test' });
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const heard: string[] = [], errors: string[] = [], states: VoiceState[] = [];
  let frame: (samples: Float32Array) => void = () => {}, lost = () => {}, closed = false, enabled = true;
  const pending: { signal: AbortSignal; resolve: (result: Transcription) => void; reject: (error: Error) => void }[] = [];
  const timers = new Set<() => void>();
  const voice = new VoiceSession({
    capture: async (_signal, callback, onLost) => { frame = callback; lost = onLost; return { sampleRate: 16000, close: () => { closed = true; }, setEnabled: value => { enabled = value; } }; },
    transcribe: (_audio, signal) => new Promise((resolve, reject) => pending.push({ signal, resolve, reject })),
    onUtterance: text => heard.push(text), onState: state => states.push(state), onError: message => errors.push(message),
    schedule: task => { timers.add(task); return () => { timers.delete(task); }; },
  });
  const speak = () => { for (let i = 0; i < 25; i++) frame(new Float32Array(512).fill(.08)); for (let i = 0; i < 30; i++) frame(new Float32Array(512)); };
  return { voice, pending, heard, errors, states, timers, speak, lost: () => lost(), isClosed: () => closed, isEnabled: () => enabled,
    silence: () => { for (let i = 0; i < 1900; i++) frame(new Float32Array(512)); },
    flush: () => { for (const task of [...timers]) { timers.delete(task); task(); } } };
}
test('silence keeps the same live session without ASR traffic', async () => {
  const f = fixture(); await f.voice.start(); f.silence();
  assert.equal(f.pending.length, 0); assert.equal(f.states.at(-1), 'listening'); f.voice.dispose();
});
test('completed speech is recognized once, holds microphone, and resumes after the reply', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); f.speak();
  assert.equal(f.pending.length, 1); assert.equal(f.isEnabled(), false);
  f.pending[0].resolve(result('怎样制作数字人')); await settle();
  assert.deepEqual(f.heard, ['怎样制作数字人']); assert.equal(f.states.at(-1), 'responding');
  f.voice.resume(); f.flush(); assert.equal(f.isEnabled(), true); assert.equal(f.states.at(-1), 'listening');
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
test('typed questions pause capture and suppress the preceding speech result', async () => {
  const f = fixture(); await f.voice.start(); f.speak(); f.voice.hold();
  f.pending[0].resolve(result('不再需要')); await settle(); assert.deepEqual(f.heard, []);
  assert.equal(f.isEnabled(), false); f.voice.resume(); f.voice.stop(); f.flush(); assert.equal(f.states.at(-1), 'off');
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
