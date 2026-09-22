import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clips, sampleIds } from '../src/catalog';
import { RunningHub, videoPrompt, type GenerationResult } from './runninghub';
import { exportClip } from './export-hypit';
import type { MediaAsset } from '../src/types';
import { readAssets } from '../server/assets';
const root=fileURLToPath(new URL('..',import.meta.url));process.chdir(root);
const jobFile='production/jobs.json';const lockFile='production/production.lock';
type Job={clipId:string;hash:string;status:'submitting'|'pending'|'generated'|'complete'|'failed'|'unknown';taskId?:string;sourceUrl?:string;error?:string;updatedAt:string};
async function json<T>(file:string,fallback:T):Promise<T>{try{return JSON.parse(await readFile(file,'utf8')) as T;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return fallback;throw e;}}
async function save(file:string,value:unknown){await writeFile(`${file}.tmp`,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(`${file}.tmp`,file);}
function errorMessage(error:unknown){return error instanceof Error?error.message:'未知错误';}
function https(url:string){const parsed=new URL(url);if(parsed.protocol!=='https:')throw new Error('结果地址不是 HTTPS');return url;}
async function download(url:string,file:string){const res=await fetch(https(url),{signal:AbortSignal.timeout(120000)});if(!res.ok)throw new Error(`下载 HTTP ${res.status}`);const bytes=new Uint8Array(await res.arrayBuffer());if(bytes.byteLength>200*1024*1024)throw new Error('视频超过 200MB');await writeFile(`${file}.part`,bytes);await rename(`${file}.part`,file);}
export async function main(){
  const command=process.argv[2]||'plan';await mkdir('production',{recursive:true});
  if(command==='plan'){
    const plan={name:'小岚首批交互内容',provider:'RunningHub',model:'Seedance 2.0 Mini',resolution:'720p',ratio:'9:16',fps:30,clipCount:clips.length,totalSeconds:clips.reduce((s,c)=>s+c.duration,0),sampleIds,clips:clips.map(c=>({...c,prompt:videoPrompt(c)}))};
    await save('production/manifest.json',plan);
    console.log(`已保存 production/manifest.json：${plan.clipCount} 段 / ${plan.totalSeconds} 秒；本命令仅更新清单。`);return;
  }
  if(!['sample','batch','collect','accept'].includes(command))throw new Error('命令：plan | sample | batch | collect | accept <clipId>');
  if(command==='accept'){
    const id=process.argv[3];const asset=(await readAssets()).find(a=>a.clipId===id);if(!asset)throw new Error('找不到该视频，请先生成并导出。');
    await stat(path.join(root,'public',asset.url));await mkdir('data/reviews',{recursive:true});
    await save(`data/reviews/${asset.clipId}.json`,{generatedAt:asset.generatedAt,url:asset.url,reviewedAt:new Date().toISOString()});
    console.log(`已验收 ${id}，正式播放器现在可用。`);return;
  }
  let lock;try{lock=await open(lockFile,'wx',0o600);await lock.writeFile(String(process.pid));}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new Error('生产进程已锁定。先确认没有其他进程运行；崩溃后检查锁内 PID 再移除 production/production.lock。');throw e;}
  try{
    const assets=await readAssets();
    if(command==='batch'&&!sampleIds.every(id=>assets.some(a=>a.clipId===id&&a.status==='ready')))throw new Error('请先验收 listen、greeting、mechanism 三个样片，才能生成余下批次。');
    const requestedIds=command==='sample'?sampleIds:clips.map(clip=>clip.id);
    if(command!=='collect'&&requestedIds.every(id=>assets.some(asset=>asset.clipId===id))){
      console.log('选定片段均已有素材，没有提交新任务。需要更新内容时请先创建新的片段 ID。');return;
    }
    const key=process.env.RUNNINGHUB_API_KEY;if(!key)throw new Error('缺少 RUNNINGHUB_API_KEY；请在本地 .env 配置，尚未提交生成任务。');
    const hub=new RunningHub(key,process.env.RUNNINGHUB_BASE_URL);
    const concurrency=Math.max(1,Math.min(4,Number(process.env.RUNNINGHUB_CONCURRENCY)||2));
    const jobs=await json<Job[]>(jobFile,[]);
    let imageUrl=process.env.AVATAR_IMAGE_URL;
    if(command!=='collect'&&!imageUrl){
      const form=new FormData();form.append('file',new Blob([await readFile('public/avatar-reference.png')],{type:'image/png'}),'avatar-reference.png');
      const response=await fetch((process.env.RUNNINGHUB_BASE_URL||'https://www.runninghub.ai')+'/openapi/v2/media/upload/binary',{method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw new Error(`参考图上传失败 HTTP ${response.status}`);
      const upload=await response.json() as {code:number;msg?:string;data?:{download_url?:string}};
      if(![0,200].includes(upload.code)||!upload.data?.download_url)throw new Error(`参考图上传未成功（${upload.code}）：${upload.msg||'未知原因'}`);imageUrl=https(upload.data.download_url);
    }
    const priority=['greeting','listen','capabilities','thinking','clarify','out-of-scope'];
    const selected=(command==='sample'?clips.filter(c=>sampleIds.includes(c.id)):[...clips]).sort((a,b)=>(priority.indexOf(a.id)<0?100:priority.indexOf(a.id))-(priority.indexOf(b.id)<0?100:priority.indexOf(b.id)));
    const submitAllowed=command!=='collect';
    const fillQueue=async()=>{
      if(!submitAllowed)return;
      let slots=concurrency-jobs.filter(j=>['submitting','pending','unknown'].includes(j.status)).length;
      for(const clip of selected){
        if(slots<=0)break;
        if(jobs.some(j=>j.clipId===clip.id)||assets.some(a=>a.clipId===clip.id))continue;
        const hash=createHash('sha256').update(JSON.stringify({clip,model:'seedance-2.0-mini',reference:await readFile('public/avatar-reference.png')})).digest('hex');
        const job:Job={clipId:clip.id,hash,status:'submitting',updatedAt:new Date().toISOString()};jobs.push(job);await save(jobFile,jobs);slots--;
        try{const result=await hub.submit(clip,imageUrl!);job.taskId=result.taskId;job.status=result.status==='FAILED'?'failed':'pending';await save(jobFile,jobs);console.log(`${clip.title}：已提交。`);}
        catch(error){job.status='unknown';job.error=errorMessage(error);await save(jobFile,jobs);throw new Error(`${clip.title} 提交状态不确定，请到 RunningHub 核对任务；不会自动重试，避免重复扣费。`);}
      }
    };
    const deadline=Date.now()+45*60*1000;let polls=0;
    do {
      // Collect first, preserving the provider task ID through download/render failures.
      for(const job of jobs.filter(j=>['pending','generated'].includes(j.status))){
        try {
          if(job.status==='pending'){
            const result:GenerationResult=await hub.query(job.taskId!);
            if(result.status==='FAILED'){job.status='failed';job.error=result.errorCode||'生成失败';}
            if(result.status==='SUCCESS'){
              const video=result.results?.find(r=>r.url&&(/mp4|video/i.test(r.outputType||'')||new URL(r.url).pathname.endsWith('.mp4')));
              if(!video?.url)throw new Error('任务成功但没有视频结果');job.sourceUrl=https(video.url);job.status='generated';
            }
            job.updatedAt=new Date().toISOString();await save(jobFile,jobs);
          }
          if(job.status==='generated'){
            // Keep cloud generation busy while Hypit exports completed jobs locally.
            await fillQueue();
            await mkdir('production/raw',{recursive:true});const raw=`production/raw/${job.clipId}.mp4`;
            try{await stat(raw);}catch{await download(job.sourceUrl!,raw);}
            const clip=clips.find(c=>c.id===job.clipId)!;
            const duration=await exportClip(clip,raw);
            const asset:MediaAsset={clipId:clip.id,url:`/media/${clip.id}.mp4`,duration,status:'review',source:'runninghub',generatedAt:new Date().toISOString()};
            const index=assets.findIndex(a=>a.clipId===clip.id);if(index<0)assets.push(asset);else assets[index]=asset;
            await save('data/assets.json',assets);job.status='complete';job.error=undefined;await save(jobFile,jobs);console.log(`${clip.title}：已导出，等待画面与声音验收。`);
          }
        }catch(error){job.error=errorMessage(error);await save(jobFile,jobs);console.error(`${job.clipId}：${job.error}（保留任务，不会重新付费提交）`);}
      }
      await fillQueue();
      const remaining=selected.some(c=>!assets.some(a=>a.clipId===c.id)&&!jobs.some(j=>j.clipId===c.id&&['complete','failed','unknown','submitting'].includes(j.status)));
      if(command==='collect'||!remaining)break;
      if(jobs.some(j=>j.status==='unknown'||j.status==='submitting'))throw new Error('存在提交结果不确定的任务，请先核对任务状态。');
      await wait(10000);polls++;
    }while(Date.now()<deadline&&polls<270);
    if(jobs.some(j=>j.status!=='complete'))process.exitCode=2;
    console.log(JSON.stringify({complete:jobs.filter(j=>j.status==='complete').length,pending:jobs.filter(j=>j.status==='pending').length,needsAttention:jobs.filter(j=>['unknown','submitting','failed','generated'].includes(j.status)).map(j=>j.clipId)}));
  }finally{await lock.close();await unlink(lockFile);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(errorMessage(error));process.exitCode=1;});
