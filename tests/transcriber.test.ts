import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverTranscriber } from '../src/voice';
const signal = () => new AbortController().signal;
test('transcriber reuses a session while keeping both network phases cancellable', async () => {
  let sessions = 0, transcripts = 0;
  const request: typeof fetch = async (url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    if (url === '/api/voice/session') { sessions++; return Response.json({ token: 'test-token' }); }
    assert.equal(new Headers(init?.headers).get('X-Voice-Token'), 'test-token'); transcripts++;
    return Response.json({ text: '你好', latencyMs: 1, engine: 'whisper-local', duration: 1 });
  };
  const transcribe = serverTranscriber(request);
  await transcribe(new ArrayBuffer(0), signal()); await transcribe(new ArrayBuffer(0), signal());
  assert.equal(sessions, 1); assert.equal(transcripts, 2);
});
test('unreachable local service explains the actual connection failure', async () => {
  const transcribe = serverTranscriber(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(transcribe(new ArrayBuffer(0), signal()), /无法连接本地语音服务/);
});
test('expired session is discarded before the next user attempt', async () => {
  let sessions = 0, transcriptions = 0;
  const transcribe = serverTranscriber(async url => {
    if (url === '/api/voice/session') { sessions++; return Response.json({ token: String(sessions) }); }
    if (++transcriptions === 1) return Response.json({ error: '语音会话已过期' }, { status: 403 });
    return Response.json({ text: '恢复了', latencyMs: 1, engine: 'whisper-local', duration: 1 });
  });
  await assert.rejects(transcribe(new ArrayBuffer(0), signal()), /已过期/);
  assert.equal((await transcribe(new ArrayBuffer(0), signal())).text, '恢复了'); assert.equal(sessions, 2);
});
