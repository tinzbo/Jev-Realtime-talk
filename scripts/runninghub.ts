import { z } from 'zod';
import type { Clip } from '../src/types';
export const generationPath = '/openapi/v2/rhart-video/sparkvideo-2.0-mini/image-to-video';
const resultSchema = z.object({ taskId:z.string().min(1), status:z.enum(['QUEUED','RUNNING','SUCCESS','FAILED']), errorCode:z.string().optional(),errorMessage:z.string().optional(), results:z.array(z.object({url:z.string().nullable().optional(),outputType:z.string().nullable().optional()})).nullable().optional() });
export type GenerationResult = z.infer<typeof resultSchema>;
export function videoPrompt(clip: Clip): string {
  return `原创成年虚拟人物小岚，形象、服装、房间、灯光严格保持参考图一致。固定眼平中近景，单个连续镜头，不切镜，不缩放。她像在耐心地与对面的人聊天，表情${clip.emotion}，自然呼吸，动作轻微。全程以睁眼直视镜头为主，只偶尔快速短眨眼，不持续闭眼，不大幅低头或摇头。开头 0.4 秒和结尾 0.5 秒均回到同一个放松姿态：${clip.startPose}。${clip.text?`用自然、温暖、清晰的普通话，逐字说出且只说以下台词：“${clip.text}”。嘴型和语音同步，不增删台词，不抢语速，所有话在片段内完整说完。声音为同一名成年女性，中音区、平稳语速、温和清晰，避免夸张播音腔。`:'全程闭口，无台词，无哼声，无语音，只有自然呼吸和偶尔短眨眼，适合安静倾听的自然循环。'}无字幕，无文字，无水印，无背景音乐，无音效。`;
}
export function generationBody(clip:Clip,imageUrl:string) {
  if(new URL(imageUrl).protocol!=='https:')throw new Error('人物参考必须是可访问的 HTTPS 地址');
  return { prompt:videoPrompt(clip),resolution:'720p',duration:String(clip.duration),firstFrameUrl:imageUrl,lastFrameUrl:imageUrl,generateAudio:Boolean(clip.text),ratio:'9:16',realPersonMode:true,conversionSlots:['all'],returnLastFrame:true,seed:424242 };
}
export class RunningHub {
  constructor(private key:string,private baseURL='https://www.runninghub.ai',private transport:typeof fetch=fetch) {
    if(!key)throw new Error('缺少 RUNNINGHUB_API_KEY');
    const url=new URL(baseURL); if(url.protocol!=='https:' || !['www.runninghub.ai','www.runninghub.cn'].includes(url.hostname))throw new Error('仅支持 RunningHub 官方 HTTPS 地址');
  }
  private async post(path:string,body:unknown):Promise<GenerationResult> {
    const response=await this.transport(this.baseURL+path,{method:'POST',headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    // Submission is never automatically retried: a timeout may still have created a paid job.
    if(!response.ok)throw new Error(`RunningHub HTTP ${response.status}`);
    return resultSchema.parse(await response.json());
  }
  submit(clip:Clip,imageUrl:string){return this.post(generationPath,generationBody(clip,imageUrl));}
  query(taskId:string){return this.post('/openapi/v2/query',{taskId});}
}
