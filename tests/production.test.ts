import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generationBody, RunningHub } from '../scripts/runninghub';
import { clips } from '../src/catalog';
test('all 24 clips have unique IDs and fit the documented duration range',()=>{
  assert.equal(new Set(clips.map(c=>c.id)).size,24);
  for(const clip of clips){assert.ok(clip.duration>=4&&clip.duration<=15);assert.equal(clip.startPose,clip.endPose);}
});
test('idle clip disables generated speech and locks both ends to the same portrait',()=>{
  const body=generationBody(clips[0],'https://example.com/portrait.png');
  assert.equal(body.generateAudio,false);assert.equal(body.firstFrameUrl,body.lastFrameUrl);assert.equal(body.realPersonMode,true);
});
test('a lost paid submission is not retried',async()=>{
  let calls=0;const service=new RunningHub('test','https://www.runninghub.ai',async()=>{calls++;throw new Error('timeout');});
  await assert.rejects(()=>service.submit(clips[0],'https://example.com/p.png'));assert.equal(calls,1);
});
test('malformed successful provider response is rejected',async()=>{
  const service=new RunningHub('test','https://www.runninghub.ai',async()=>new Response(JSON.stringify({status:'SUCCESS'})));
  await assert.rejects(()=>service.query('123'));
});
test('a delivered catalog does not need provider keys or paid requests to run batch again', async () => {
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/produce.ts', 'batch'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, RUNNINGHUB_API_KEY: '', TYPESAFE_API_KEY: '' },
    timeout: 5000,
  });
  assert.match(result.stdout, /没有提交新任务/);
});
