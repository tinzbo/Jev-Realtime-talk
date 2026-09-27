import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { voiceRouter } from '../server/voice-api';
import { validateAudio, VoiceError } from '../server/asr-audio';
import { encodeWav } from '../src/audio';
import type { LocalASR } from '../server/asr';

const samples = Buffer.from(encodeWav(new Float32Array(16000).fill(.1), 16000));
async function fixture(transcribe?: LocalASR['transcribe']) {
  let calls = 0;
  const app = express();
  app.use('/voice', voiceRouter({ start: async () => {}, status: { state: 'ready', engine: 'whisper-local', model: 'base' },
    transcribe: async (bytes, signal) => {
      calls++;
      if (transcribe) return transcribe(bytes, signal);
      const audio = validateAudio(bytes);
      return { text: audio.silent ? '' : '你好', latencyMs: 10, duration: audio.duration, engine: 'whisper-local' };
    },
  }));
  app.use((error: { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.type === 'entity.too.large' ? 413 : 500).json({ error: 'Request rejected' });
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/voice`;
  const session = await fetch(`${base}/session`).then(response => response.json()) as { token: string };
  return { base, token: session.token, calls: () => calls,
    post: (body = samples, token = session.token, type = 'audio/wav') => fetch(`${base}/transcribe`, {
      method: 'POST', headers: { 'Content-Type': type, 'X-Voice-Token': token }, body,
    }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('voice API requires a fresh local session and WAV before calling inference', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post(samples, '')).status, 403);
    assert.equal((await f.post(samples, f.token, 'application/octet-stream')).status, 415);
    assert.equal(f.calls(), 0);
    const response = await f.post(); assert.equal(response.status, 200);
    assert.equal((await response.json()).text, '你好');
  } finally { await f.close(); }
});
test('malformed WAV and uploads over 20 seconds are rejected', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post(Buffer.from('not a recording'))).status, 400);
    assert.equal((await f.post(Buffer.alloc(640045))).status, 413);
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});
test('recognition errors preserve safe codes without internal exception details', async () => {
  const f = await fixture(async () => { throw new Error('private runtime details'); });
  try {
    const response = await f.post(); assert.equal(response.status, 503);
    const body = await response.text(); assert.ok(!body.includes('private')); assert.ok(body.includes('asr_unavailable'));
  } finally { await f.close(); }
});
test('busy model response is distinct from connectivity failure', async () => {
  const f = await fixture(async () => { throw new VoiceError('请稍后再说', 429, 'asr_busy'); });
  try { const response = await f.post(); assert.equal(response.status, 429); assert.equal((await response.json()).code, 'asr_busy'); }
  finally { await f.close(); }
});
test('disconnecting the browser cancels server inference', async () => {
  let beganResolve!: () => void, canceledResolve!: () => void;
  const began = new Promise<void>(resolve => { beganResolve = resolve; });
  const canceled = new Promise<void>(resolve => { canceledResolve = resolve; });
  const f = await fixture(async (_bytes, signal) => {
    beganResolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { canceledResolve(); reject(new VoiceError('取消', 499)); }, { once: true }));
  });
  try {
    const controller = new AbortController();
    const request = fetch(`${f.base}/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Voice-Token': f.token }, body: samples, signal: controller.signal }).catch(() => {});
    await began; controller.abort();
    await Promise.race([canceled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('inference was not canceled')), 1000); timer.unref(); })]);
    await request;
  } finally { await f.close(); }
});
test('request bursts stop at the configured limit', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 30; i++) assert.equal((await f.post()).status, 200);
    assert.equal((await f.post()).status, 429); assert.equal(f.calls(), 30);
  } finally { await f.close(); }
});
