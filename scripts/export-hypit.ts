import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clip } from '../src/types';
const run=promisify(execFile);const root=fileURLToPath(new URL('..',import.meta.url));
const cli=path.join(root,'node_modules/@hypit/hypit/bin/hypit.mjs');
const profile=path.join(root,'production/hypit.runtime.json');
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
async function hypit(args:string[],timeout=120000){const result=await run(process.execPath,[cli,...args],{cwd:root,timeout,maxBuffer:10*1024*1024,env:{...process.env,PATH:`${path.dirname(process.execPath)}:${process.env.PATH||''}`}});return result.stdout;}
export function composition({input,duration,silent=false,still=false}:{input:string;duration:number;silent?:boolean;still?:boolean}){
 return `<?svml using="@hypit/markup@1"?>
<svml>
  <import as="asset" from="@hypit/media@1"/>
  <import as="pipeline" from="@hypit/media-pipeline@1"/>
  <import as="time" from="@hypit/timeline-author@1"/>
  <import as="space" from="@hypit/spatial@1"/>
  <import as="picture" from="@hypit/media-track@1"/>
  <import as="film" from="@hypit/film@1"/>
  <import as="render" from="@hypit/render-hyperframes@1"/>
  <import as="look" source="./look.svs"/>
  <time:Clock id="clock" frame-rate="30"/>
  <time:Timeline id="program" clock={clock} end="${Math.floor(duration*30)}f"/>
  <space:Canvas id="canvas" width="720" height="1280"/>
  <space:Frame id="frame" within={canvas} left="0%" top="0%" right="100%" bottom="100%"/>
  ${still?`<asset:Image id="raw" src="${xml(input)}"/>
  <space:Extent id="portrait-size" width="941" height="1672"/>`:`<asset:Video id="raw" src="${xml(input)}"/>
  <pipeline:Normalize id="prepared" source={raw} clock={clock} video="primary-moving" audio="${silent?'none':'default'}" span-authority="video"/>`}
  <picture:Track id="picture" timeline={program.timeline} canvas={canvas}>
    <picture:Item ${still?'image={raw} extent={portrait-size}':'media={prepared.media}'} frame={frame} during="program" appearance={look.media.portrait}${!silent&&!still?' source-audio="content"':''}/>
  </picture:Track>
  <film:Film id="main" canvas={canvas} timeline={program.timeline} appearance={look.film.main}>
    <film:Track source={picture.visual}/>
    ${!silent&&!still?'<film:Track source={picture.audio}/>':''}
  </film:Film>
  <render:Video id="final" composition={main.composition} timeline={program.timeline}/>
</svml>\n`;
}
async function prepare(){await mkdir(path.join(root,'production/hypit'),{recursive:true});await writeFile(path.join(root,'production/hypit/look.svs'),'<?svml using="@hypit/svs@1"?>\n<sheet version="1">\nmedia.portrait { stack-order: 0; fit: cover; }\nfilm.main { background: #1b221c; }\n</sheet>\n');}
async function writeSource(id:string,source:string){await prepare();const sourceFile=path.join(root,'production/hypit',`${id}.svml`);const runFile=path.join(root,'production/hypit',`${id}.svrun`);await writeFile(sourceFile,source);await writeFile(runFile,`<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"><author source="./${id}.svml"/><target output="final.video"/></svrun>\n`);return {sourceFile,runFile};}
export async function exportClip(clip:Clip,input:string):Promise<number>{
  const {stdout}=await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path.resolve(root,input)]);
  const info=JSON.parse(stdout) as {format:{duration:string};streams:{codec_type:string}[]};const duration=Number(info.format.duration);
  if(!Number.isFinite(duration)||duration<1||duration>30||Math.abs(duration-clip.duration)>1.5)throw new Error('源视频时长不符，需要人工检查');
  if(clip.text&&!info.streams.some(s=>s.codec_type==='audio'))throw new Error('有台词的片段没有音轨');
  const source=composition({input:path.relative(path.join(root,'production/hypit'),path.resolve(root,input)),duration,silent:!clip.text});
  const {runFile}=await writeSource(clip.id,source);
  await hypit(['check',runFile]);
  const receiptFile=path.join(root,'production/hypit',`${clip.id}.receipt.json`);
  const hash=createHash('sha256').update(source).digest('hex');let buildId:string|undefined;
  try{const receipt=JSON.parse(await readFile(receiptFile,'utf8'));if(receipt.hash!==hash)throw new Error('现有渲染记录对应不同内容，请检查后再创建新版本。');buildId=receipt.buildId;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!buildId){const submitted=JSON.parse(await hypit(['build',runFile,'--runtime',profile,'--json']));buildId=submitted.build?.id;if(!buildId)throw new Error('Hypit 没有返回 Build ID');await writeFile(receiptFile,JSON.stringify({buildId,hash},null,2));}
  await hypit(['status',buildId,'--runtime',profile,'--watch','--json'],15*60*1000);
  await mkdir(path.join(root,'public/media'),{recursive:true});const output=path.join(root,'public/media',`${clip.id}.mp4`);
  await hypit(['get',buildId,'--output','final.video','--to',output]);await stat(output);
  return Math.floor(duration*30)/30;
}
async function main(){
  if(process.argv[2]==='check'){
    const {sourceFile,runFile}=await writeSource('pipeline-check',composition({input:'../../public/avatar-reference.png',duration:1,silent:true,still:true}));
    console.log(await hypit(['check',sourceFile,'--json']));console.log(await hypit(['check',runFile,'--json']));return;
  }
  console.log('使用 npm run hypit:export -- check 验证流水线。实际生成结果由 production:sample / batch 自动交给 Hypit 导出。首次运行需 npx hypit runtime up --runtime production/hypit.runtime.json。');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
