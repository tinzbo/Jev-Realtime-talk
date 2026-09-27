import express from 'express';
import { randomBytes } from 'node:crypto';
import type { LocalASR } from './asr';
import { VoiceError } from './asr-audio';

export function voiceRouter(asr: Pick<LocalASR, 'start' | 'status' | 'transcribe'>): express.Router {
  const router = express.Router(), tokens = new Map<string, number>();
  let windowStarted = Date.now(), requests = 0;
  router.get('/session', async (_req, res) => {
    for (const [token, expires] of tokens) if (expires < Date.now()) tokens.delete(token);
    if (tokens.size >= 64) tokens.delete(tokens.keys().next().value!);
    const token = randomBytes(32).toString('hex'); tokens.set(token, Date.now() + 30 * 60 * 1000);
    void asr.start().catch(() => {});
    res.json({ token, ...asr.status });
  });
  router.post('/transcribe', (req, res, next) => {
    if ((tokens.get(req.get('X-Voice-Token') || '') || 0) < Date.now()) { res.status(403).json({ error: '语音会话已过期，请重新开始。', code: 'session_expired' }); return; }
    if (!req.is('audio/wav')) { res.status(415).json({ error: '需要 WAV 录音。', code: 'invalid_audio' }); return; }
    if (Date.now() - windowStarted > 60000) { windowStarted = Date.now(); requests = 0; }
    if (++requests > 30) { res.status(429).json({ error: '语音请求过于频繁，请稍后再试。', code: 'rate_limit' }); return; }
    next();
  }, express.raw({ type: 'audio/wav', limit: 640044 }), async (req, res) => {
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', close);
    try {
      if (!Buffer.isBuffer(req.body)) throw new VoiceError('录音为空。');
      const transcript = await asr.transcribe(req.body, controller.signal);
      if (!controller.signal.aborted) res.json(transcript);
    } catch (error) {
      if (controller.signal.aborted) return;
      const known = error instanceof VoiceError;
      res.status(known ? error.status : 503).json({ error: known ? error.message : '本地语音服务暂不可用，请重试。', code: known ? error.code : 'asr_unavailable' });
    } finally { res.off('close', close); }
  });
  return router;
}
