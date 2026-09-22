import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { clips } from '../src/catalog';
import { readAssets } from '../server/assets';

const assets = await readAssets();
if(!clips.every(c=>assets.some(a=>a.clipId===c.id && a.status==='ready'))) throw new Error('全部 24 条视频验收后才能打包交付。');
const checks: {clipId:string;url?:string;technicalPass:boolean}[] = JSON.parse(await readFile('artifacts/qa/report.json','utf8'));
if(!clips.every(c=>checks.some(q=>q.clipId===c.id && q.technicalPass && (q.url??`/media/${q.clipId}.mp4`)===assets.find(a=>a.clipId===c.id)?.url))) throw new Error('尚有视频未通过媒体检查。');
const directory = path.resolve('artifacts/delivery');
await mkdir(directory,{recursive:true});
const entries = [];
for(const clip of clips) {
  const asset = assets.find(a=>a.clipId===clip.id)!;
  const bytes = await readFile(`public${asset.url}`);
  await copyFile(`public${asset.url}`,`${directory}/${clip.id}.mp4`);
  entries.push({id:clip.id,title:clip.title,text:clip.text,kind:clip.kind,loop:clip.loop,duration:asset.duration,file:`${clip.id}.mp4`,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await writeFile(`${directory}/catalog.json`,JSON.stringify({name:'小岚 · 24 条互动数字人视频',createdAt:new Date().toISOString(),generator:'RunningHub sparkvideo-2.0-mini',editor:'Hypit 0.2.12',resolution:'720x1280',fps:30,clips:entries},null,2)+'\n');
await writeFile(`${directory}/README.txt`,'小岚 · 互动数字人内容库\n\n24 条独立 MP4：22 条中文口播、2 条静音过渡。\n统一 H.264/AAC、720×1280、30fps。catalog.json 包含台词、用途、时长和文件校验值。\n\n本地互动页面：http://127.0.0.1:4173\n需要启动 xtasy 项目的本地服务，使用 Jev 选择对应内容。打开单个 MP4 无需服务或 API Key。\n\n已做格式、音轨、时长、语音转写和画面抽帧检查。语音转写中可能出现同音字及专有名词误识别；没有承诺跨片绝对音色一致或逐帧口型误差。\n\n本包不包含任何服务凭证。\n');
const temporary=path.resolve(`artifacts/xtasy-videos-${process.pid}.zip`);
await promisify(execFile)('zip',['-q','-j',temporary,...entries.map(e=>path.join(directory,e.file)),`${directory}/catalog.json`,`${directory}/README.txt`]);
await rename(temporary,path.resolve('artifacts/xtasy-videos.zip'));
console.log(JSON.stringify({archive:'artifacts/xtasy-videos.zip',count:entries.length,totalSeconds:entries.reduce((n,e)=>n+e.duration,0)}));
