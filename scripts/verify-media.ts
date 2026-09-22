import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { clips } from '../src/catalog';
import type { MediaAsset } from '../src/types';

const exec = promisify(execFile);
const directory = 'artifacts/qa';
interface Check { clipId: string; url?: string; generatedAt?: string; duration: number; width: number; height: number; fps: string; meanVolumeDb: number; transcript: string; expected: string; technicalPass: boolean; checkedAt: string; }
await mkdir(directory, { recursive: true });
const assets: MediaAsset[] = JSON.parse(await readFile('data/assets.json','utf8'));
let checks: Check[] = [];
try { checks = JSON.parse(await readFile(`${directory}/report.json`,'utf8')); } catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
for(const asset of assets) {
  if(checks.some(c=>c.clipId===asset.clipId && (c.url??`/media/${c.clipId}.mp4`)===asset.url && (!c.generatedAt||c.generatedAt===asset.generatedAt)))continue;
  const clip = clips.find(c=>c.id===asset.clipId)!;
  const file = `public${asset.url}`;
  const { stdout } = await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file]);
  const info = JSON.parse(stdout);
  const video = info.streams.find((s:{codec_type:string})=>s.codec_type==='video');
  const audio = info.streams.find((s:{codec_type:string})=>s.codec_type==='audio');
  const { stderr } = await exec('ffmpeg',['-hide_banner','-i',file,'-af','volumedetect','-vn','-sn','-f','null','-']);
  const meanVolumeDb = Number(stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1] ?? '-100');
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',file,'-vf','fps=1,scale=180:320,tile=6x2','-frames:v','1',`${directory}/${clip.id}-contact.jpg`]);
  let transcript = '';
  if(clip.text) {
    await exec('whisper',[file,'--model','base','--language','zh','--device','cpu','--fp16','False','--threads','4','--output_dir',directory,'--output_format','json','--verbose','False'],{timeout:180000,maxBuffer:1024*1024});
    transcript = JSON.parse(await readFile(`${directory}/${path.basename(asset.url,'.mp4')}.json`,'utf8')).text;
  }
  const duration = Number(info.format.duration);
  const technicalPass = video?.codec_name==='h264' && video?.width===720 && video?.height===1280 && video?.r_frame_rate==='30/1' && Math.abs(duration-clip.duration)<1.5 && Boolean(audio) && (clip.text ? meanVolumeDb > -50 && transcript.trim().length>0 : meanVolumeDb < -60);
  const check: Check = { clipId:clip.id, url:asset.url, generatedAt:asset.generatedAt, duration, width:video?.width, height:video?.height, fps:video?.r_frame_rate, meanVolumeDb, transcript, expected:clip.text, technicalPass, checkedAt:new Date().toISOString() };
  checks = checks.filter(c=>c.clipId!==clip.id);
  checks.push(check);
  await writeFile(`${directory}/report.json.tmp`,JSON.stringify(checks,null,2)+'\n');await rename(`${directory}/report.json.tmp`,`${directory}/report.json`);
  console.log(JSON.stringify({clipId:check.clipId,technicalPass,transcript}));
}
if(checks.some(c=>!c.technicalPass))process.exitCode=2;
