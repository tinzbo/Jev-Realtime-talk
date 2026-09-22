import express from 'express';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createViteServer } from 'vite';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clips } from '../src/catalog';
import { readAssets } from './assets';
import { route, jevHealth } from './router';
const root = fileURLToPath(new URL('..', import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '24kb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) { res.status(403).json({ error: '不允许跨站请求' }); return; }
  next();
});
app.get('/api/catalog', async (_req,res) => res.json({ clips, assets: await readAssets() }));
app.get('/api/status', async (_req,res) => {
  const assets = await readAssets();
  let jobs: { status: string; taskId?: string }[] = [];
  try { jobs = JSON.parse(await readFile(path.join(root,'production/jobs.json'),'utf8')); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
  res.json({ jev: Boolean(process.env.TYPESAFE_API_KEY), jevVerified: jevHealth.verified, jevModel: jevHealth.model, runninghub: Boolean(process.env.RUNNINGHUB_API_KEY), portrait: Boolean(process.env.AVATAR_IMAGE_URL) || existsSync(path.join(root,'public/avatar-reference.png')), readyClips: assets.filter(a=>a.status==='ready').length, reviewClips: assets.filter(a=>a.status==='review').length, totalClips: clips.length, production: { submitted: jobs.filter(j=>j.taskId).length, pending: jobs.filter(j=>['pending','generated','submitting'].includes(j.status)).length, complete: jobs.filter(j=>j.status==='complete').length, needsAttention: jobs.filter(j=>['failed','unknown'].includes(j.status)).length } });
});
const inputSchema = z.object({ requestId: z.number().int().min(1), text: z.string().trim().min(1).max(1500), history: z.array(z.object({ role: z.enum(['user','assistant']), text: z.string().max(1500), clipId: z.string().max(80).optional() })).max(10).default([]), currentClipId: z.string().max(80).optional(), recentlyPlayed: z.array(z.string().max(80)).max(10).default([]), mode: z.enum(['preview','live']).default('preview') });
let requestWindow = Date.now(); let requests = 0;
app.post('/api/route', async (req,res) => {
  if (Date.now()-requestWindow > 60000) { requestWindow = Date.now(); requests = 0; }
  if (++requests > 60) { res.status(429).json({ error:'请求过于频繁，请稍后再试' }); return; }
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({error:'请求格式不正确，输入最多 1500 字'}); return; }
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', onClose);
  try {
    const assets = await readAssets();
    const available = parsed.data.mode==='preview' ? clips : clips.filter(c=>assets.some(a=>a.clipId===c.id && a.status==='ready'));
    const result = await route(parsed.data, available, controller.signal);
    if (!controller.signal.aborted) res.json(result);
  } finally { res.off('close', onClose); }
});
app.use('/api', (_req,res)=>res.status(404).json({error:'接口不存在'}));
app.use('/media', express.static(path.join(root,'public/media'), {maxAge:'1h'}));
if (process.argv.includes('--production')) {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*splat}', (_req,res)=>res.sendFile(path.join(root,'dist/index.html')));
} else {
  const vite = await createViteServer({ server: { middlewareMode:true }, appType:'spa' });
  app.use(vite.middlewares);
}
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  const badBody = error instanceof SyntaxError;
  res.status(badBody ? 400 : 500).json({error: badBody ? '请求不是有效 JSON' : '服务暂不可用，请检查本地配置'});
});
app.listen(Number(process.env.PORT || 4173), '127.0.0.1', ()=>console.log(`Xtasy: http://127.0.0.1:${process.env.PORT || 4173}`));
