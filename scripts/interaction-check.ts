import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { encodeWav } from '../src/audio';
import type { Decision, Turn } from '../src/types';
import { clips } from '../src/catalog';

const run = promisify(execFile), directory = 'artifacts/interaction';
const base = process.env.INTERACTION_BASE_URL || 'http://127.0.0.1:4173';
const cases = [
  { id: 'hello', text: '你好，小岚。', expected: ['greeting', 'greeting-alt'] },
  { id: 'batch', text: '怎么批量制作数字人视频？', expected: ['batch'] },
  { id: 'website', text: '怎么把你接入我的网站？', expected: ['integration'] },
  { id: 'stop', text: '停一下。', expected: ['interrupt'] },
  { id: 'weather', text: '明天北京会下雨吗？', expected: ['out-of-scope'] },
  { id: 'thanks', text: '好的，谢谢你。', expected: ['thanks'] },
];
await mkdir(directory, { recursive: true });
for (const [index, entry] of cases.entries()) {
  try { await readFile(`${directory}/${entry.id}.wav`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (process.platform !== 'darwin') throw new Error(`缺少 ${directory}/${entry.id}.wav。请提供相同台词的合成语音 WAV。`);
    await run('say', ['-v', 'Tingting (中文（中国大陆）)', '-r', String(index % 2 ? 190 : 165), '-o', `${directory}/${entry.id}.aiff`, entry.text]);
  }
  const source = await readFile(`${directory}/${entry.id}.aiff`).then(() => `${directory}/${entry.id}.aiff`).catch(() => `${directory}/${entry.id}.wav`);
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', source, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 3 * 1024 * 1024 });
  const samples = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength));
  await writeFile(`${directory}/${entry.id}.wav`, Buffer.from(encodeWav(samples, 16000)));
}
if (process.argv.includes('--fixtures-only')) { console.log('6 条合成中文语音样例已准备。'); process.exit(0); }
const status = await fetch(`${base}/api/status`).then(response => response.json());
const { token } = await fetch(`${base}/api/voice/session`).then(response => response.json());
const history: Turn[] = [], played: string[] = [], results = [];
for (const [index, entry] of cases.entries()) {
  const start = performance.now();
  const response = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Voice-Token': token }, body: await readFile(`${directory}/${entry.id}.wav`), signal: AbortSignal.timeout(60000) });
  const recognition = await response.json();
  if (!response.ok) throw new Error(recognition.error);
  const routed = await fetch(`${base}/api/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: index + 1, text: recognition.text, history: history.slice(-10), currentClipId: played.at(-1), recentlyPlayed: played.slice(-8), mode: status.jev ? 'live' : 'preview' }), signal: AbortSignal.timeout(10000) });
  if (!routed.ok) throw new Error(`选片接口异常：${routed.status}`);
  const decision = await routed.json() as Decision;
  const success = entry.expected.includes(decision.clipId || '') && Boolean(recognition.text);
  const item = { id: entry.id, expectedText: entry.text, recognized: recognition.text, asrMs: recognition.latencyMs, routeMs: decision.latencyMs, totalMs: Math.round(performance.now() - start), clipId: decision.clipId, engine: decision.engine, success };
  results.push(item); console.log(JSON.stringify(item));
  history.push({ role: 'user', text: recognition.text });
  const clip = clips.find(clip => clip.id === decision.clipId);
  if (clip) history.push({ role: 'assistant', text: clip.text, clipId: clip.id });
  played.push(decision.clipId || '');
}
const silence = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Voice-Token': token }, body: encodeWav(new Float32Array(16000), 16000) }).then(response => response.json());
await writeFile(`${directory}/latest.json`, JSON.stringify({ checkedAt: new Date().toISOString(), input: 'synthetic Chinese speech; not a physical microphone', results, silence: { passed: silence.text === '', latencyMs: silence.latencyMs } }, null, 2) + '\n');
if (results.some(result => !result.success) || silence.text !== '') process.exitCode = 1;
