import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeQuestions, decide, demoDecision } from '../server/router';
import { clips } from '../src/catalog';
import type { RouteInput } from '../src/types';
const input: RouteInput = { requestId: 1, text: '请讲讲原理', history: [], recentlyPlayed: [], mode: 'preview' };
const answer = (id: string, confidence = .95, probability = .92) => ({ model: 'jev-test', answers: { route: { type: 'choice', choice: id, confidence, probabilities: { [id]: probability, NONE: 1 - probability } }, interrupt: { type: 'noul', noul: .1 } }, usage: { input_tokens: 100, output_tokens: 20 } });
test('a no-match option is always present and idle clips cannot become answers', () => {
  const questions = makeQuestions(clips);
  assert.ok('NONE' in questions.route.criteria);
  assert.equal('listen' in questions.route.criteria, false);
});
test('never play an ID outside the eligible catalog', () => {
  const result = decide(input, answer('invented'), clips, 20);
  assert.equal(result.clipId, 'out-of-scope');
});
test('ambiguous decision asks for clarification', () => {
  assert.equal(decide(input, answer('mechanism', .2), clips, 20).clipId, 'clarify');
});
test('strong choice preserves raw confidence and measured latency', () => {
  const result = decide(input, answer('mechanism'), clips, 82);
  assert.equal(result.clipId, 'mechanism'); assert.equal(result.latencyMs, 82); assert.equal(result.engine, 'jev');
});
test('no available clip produces a null video, never a broken media URL', () => {
  assert.equal(decide({ ...input, mode: 'live' }, answer('mechanism'), [], 8).clipId, null);
});
test('demo mode is explicitly labelled and does not invent model confidence', () => {
  const result = demoDecision({ ...input, text: '多少钱' }, clips);
  assert.equal(result.clipId, 'pricing'); assert.equal(result.engine, 'demo'); assert.equal(result.confidence, null);
});
test('an explicit stop is immediate and does not wait for a provider', () => {
  assert.equal(demoDecision({ ...input, text: '停一下' }, clips).interrupt, true);
});
test('uncovered demo query uses no-match instead of a random relevant answer', () => {
  assert.equal(demoDecision({ ...input, text: '明天上海的天气' }, clips).clipId, 'out-of-scope');
});
test('every suggested starter has a matching response in the demo',()=>{
  for(const [text,id] of [['你是怎么接上我的话的？','mechanism'],['可以批量制作吗？','batch'],['Jev 负责什么？','jev']])assert.equal(demoDecision({...input,text},clips).clipId,id);
});
test('repeated greeting can use a second prepared variant',()=>{
  assert.equal(demoDecision({...input,text:'你好',recentlyPlayed:['greeting']},clips).clipId,'greeting-alt');
});
test('property: no model-selected string escapes the catalog',()=>{
  for(let i=0;i<100;i++){
    const id=i%2?'bad-'+i:'mechanism';const result=decide(input,answer(id,(i%11)/10),clips,1);
    assert.ok(result.clipId===null||clips.some(c=>c.id===result.clipId));
  }
});
