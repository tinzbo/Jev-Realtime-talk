import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession, type Recognition, type RecognitionResultEvent, type VoiceState } from '../src/voice';

class FakeRecognition implements Recognition {
  lang = ''; continuous = false; interimResults = false;
  onstart: (() => void) | null = null;
  onresult: ((event: RecognitionResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  aborts = 0;
  start() { this.onstart?.(); }
  abort() { this.aborts++; }
  result(text: string, isFinal = true) {
    this.onresult?.({ results: [{ isFinal, 0: { transcript: text } }], resultIndex: 0 });
  }
}
function fixture(silentStart = false) {
  const recognizers: FakeRecognition[] = [];
  const heard: string[] = [], errors: string[] = [], states: VoiceState[] = [];
  const timers = new Set<() => void>();
  const voice = new VoiceSession({
    createRecognition: () => { const r = new FakeRecognition(); if (silentStart) r.start = () => {}; recognizers.push(r); return r; },
    onUtterance: text => heard.push(text), onTranscript: () => {},
    onState: state => states.push(state), onError: message => errors.push(message),
    schedule: task => { timers.add(task); return () => { timers.delete(task); }; },
  });
  const flush = () => { for (const task of [...timers]) { timers.delete(task); task(); } };
  return { voice, recognizers, heard, errors, states, timers, flush };
}

test('silence keeps the voice session alive without submitting a reply or an error', () => {
  const f = fixture(); f.voice.start();
  f.recognizers[0].onerror?.({ error: 'no-speech' }); f.flush();
  assert.equal(f.recognizers.length, 2);
  assert.equal(f.states.at(-1), 'listening');
  assert.deepEqual(f.heard, []); assert.deepEqual(f.errors, []);
  f.voice.dispose();
});
test('an empty service disconnect automatically reconnects the same conversation', () => {
  const f = fixture(); f.voice.start(); f.recognizers[0].onend?.(); f.flush();
  assert.equal(f.recognizers.length, 2); assert.equal(f.states.at(-1), 'listening');
  f.voice.dispose();
});
test('one final utterance submits once and stops listening to the avatar speaker', () => {
  const f = fixture(); f.voice.start();
  const staleResult = f.recognizers[0].onresult, staleEnd = f.recognizers[0].onend;
  f.recognizers[0].result('怎样批量制作？');
  staleResult?.({ results: [{ isFinal: true, 0: { transcript: '重复回调' } }], resultIndex: 0 });
  staleEnd?.(); f.flush();
  assert.deepEqual(f.heard, ['怎样批量制作？']);
  assert.equal(f.states.at(-1), 'responding'); assert.equal(f.recognizers.length, 1);
  assert.equal(f.recognizers[0].aborts, 1); f.voice.dispose();
});
test('a completed avatar reply automatically opens the next voice turn', () => {
  const f = fixture(); f.voice.start(); f.recognizers[0].result('你好');
  f.voice.resume(); f.flush(); f.recognizers[1].result('你会做什么');
  assert.deepEqual(f.heard, ['你好', '你会做什么']); f.voice.dispose();
});
test('explicit stop cancels reconnect and rejects late recognition callbacks', () => {
  const f = fixture(); f.voice.start(); const stale = f.recognizers[0].onresult;
  f.recognizers[0].onend?.(); f.voice.stop(); f.flush();
  stale?.({ results: [{ isFinal: true, 0: { transcript: '不应提交' } }], resultIndex: 0 });
  f.voice.resume(); f.flush();
  assert.deepEqual(f.heard, []); assert.equal(f.recognizers.length, 1);
  assert.equal(f.states.at(-1), 'off'); assert.equal(f.timers.size, 0);
});
test('interim speech never submits after cancellation or a service disconnect', () => {
  const f = fixture(); f.voice.start(); f.recognizers[0].result('还没说完', false);
  f.recognizers[0].onend?.(); f.flush();
  assert.deepEqual(f.heard, []); f.voice.stop();
});
test('permission errors end the session with actionable guidance and no retry loop', () => {
  const f = fixture(); f.voice.start(); f.recognizers[0].onerror?.({ error: 'not-allowed' });
  f.flush(); f.voice.resume(); f.flush();
  assert.equal(f.states.at(-1), 'off'); assert.match(f.errors[0], /麦克风权限/);
  assert.equal(f.recognizers.length, 1); assert.equal(f.timers.size, 0);
});
test('typed input holds recognition, and an explicit interruption reopens it', () => {
  const f = fixture(); f.voice.start(); f.voice.hold();
  assert.equal(f.states.at(-1), 'responding');
  f.voice.interrupt(); assert.equal(f.recognizers.length, 2);
  assert.equal(f.states.at(-1), 'listening'); f.voice.dispose();
});
test('dispose releases the microphone and prevents scheduled restart', () => {
  const f = fixture(); f.voice.start(); f.recognizers[0].onend?.();
  f.voice.dispose(); f.flush();
  assert.equal(f.recognizers.length, 1); assert.equal(f.timers.size, 0);
});
test('a browser exposing the API but never starting cannot leave the microphone UI stuck', () => {
  const f = fixture(true); f.voice.start(); f.flush();
  assert.equal(f.states.at(-1), 'off');
  assert.match(f.errors[0], /未能启动语音服务/);
  assert.equal(f.timers.size, 0); assert.equal(f.recognizers[0].aborts, 1);
});
