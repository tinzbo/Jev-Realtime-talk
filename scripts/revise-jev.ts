// One tracked quality revision: give the brand a clear Mandarin pronunciation.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { RunningHub } from './runninghub';
import { exportClip } from './export-hypit';
import { clips } from '../src/catalog';
const file='production/jev-revision.json';
const clip={...clips.find(c=>c.id==='jev')!,id:'jev-revised',text:'杰夫负责判断该接哪段内容。它从准备好的候选中做选择，播放器负责把画面接上。'};
let job:{taskId?:string;status:string;duration?:number;sourceUrl?:string;reason:string}={status:'new',reason:'Original Jev pronunciation produced repeated ambiguous transcripts; use Mandarin 杰夫.'};
try{job=JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const save=()=>writeFile(file,JSON.stringify(job,null,2)+'\n',{mode:0o600});
const service=new RunningHub(process.env.RUNNINGHUB_API_KEY!,process.env.RUNNINGHUB_BASE_URL);
if(job.status==='new'){
  job.status='submitting';await save();
  const result=await service.submit(clip,process.env.AVATAR_IMAGE_URL!);job.taskId=result.taskId;job.status=result.status;await save();console.log('Jev 发音修订版已提交。');
}
if(!job.taskId)throw new Error('修订任务提交状态不确定；保留记录，不重复提交。');
if(job.status==='complete'){console.log('修订版已完成。');process.exit(0);}
for(let attempt=0;attempt<180;attempt++){
  const result=await service.query(job.taskId);job.status=result.status;await save();
  if(result.status==='FAILED')throw new Error(`修订失败：${result.errorCode||'未知原因'}`);
  if(result.status==='SUCCESS'){
    const video=result.results?.find(r=>r.url&&(/mp4|video/i.test(r.outputType||'')||new URL(r.url).pathname.endsWith('.mp4')));
    if(!video?.url)throw new Error('修订任务没有视频');
    if(new URL(video.url).protocol!=='https:')throw new Error('无效结果地址');
    const response=await fetch(video.url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error('修订视频下载失败');
    await mkdir('production/raw',{recursive:true});await writeFile('production/raw/jev-revised.mp4',new Uint8Array(await response.arrayBuffer()));
    job.sourceUrl=video.url;await save();job.duration=await exportClip(clip,'production/raw/jev-revised.mp4');job.status='complete';await save();console.log('Jev 修订版已导出。');break;
  }
  await wait(10000);
}
if(job.status!=='complete')throw new Error('修订任务仍在运行，可使用同一命令继续收集。');
