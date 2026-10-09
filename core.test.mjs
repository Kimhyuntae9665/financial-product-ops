import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG,createScenario,createSimulation,advance,decide,reviseSource,finishSimulation,summarize,validateCandidate} from './core.mjs';

const scenario = () => createScenario({seed:42,count:12});
const candidate = e => ({productId:e.productId,version:e.version,effectiveAt:e.effectiveAt,changes:structuredClone(e.changes),evidence:structuredClone(e.evidence)});
const waitReview = (sim,id='E1') => {
  for (let i=0;i<150 && sim.tasks.find(t=>t.id===id)?.stage!=='review';i++) advance(sim);
  assert.equal(sim.tasks.find(t=>t.id===id).stage,'review');
  return sim.tasks.find(t=>t.id===id);
};
test('seeded scenario, clone isolation, and JSON round trip retain deterministic state',()=>{
  assert.deepEqual(createScenario(),createScenario());
  assert.notDeepEqual(createScenario({seed:1}),createScenario({seed:2}));
  const input=scenario(),sim=createSimulation({},input);
  sim.products[0].rate=8;
  assert.notEqual(input.products[0].rate,8);
  advance(sim,10);const restored=JSON.parse(JSON.stringify(sim));
  advance(sim,10);advance(restored,10);assert.deepEqual(sim,restored);
  assert.equal(DEFAULT_CONFIG.autoReview,false);
});
test('important fields always require human approval in every mode',()=>{
  for (const mode of ['manual','rules','agent']) {
    const sim=finishSimulation({mode,count:6});
    for (const kind of ['rate','limit','reviewId','active']) {
      const task=sim.tasks.find(t=>t.kind===kind);
      assert.equal(task.stage,'review');
      assert.equal(sim.writes.some(w=>w.taskId===task.id),false);
      assert.equal(decide(sim,task.id,'approve',task.reviewFingerprint).ok,true);
      assert.equal(task.stage,'apply');
      advance(sim,2);
      assert.equal(task.stage,'done');
      assert.equal(sim.writes.find(w=>w.taskId===task.id).humanReviewed,true);
    }
  }
});
test('wrong approval fingerprint and revised source block writes',()=>{
  const sim=createSimulation({count:1}),task=waitReview(sim),old=task.reviewFingerprint;
  assert.equal(decide(sim,task.id,'approve','stale').ok,false);
  assert.equal(task.stage,'review');
  assert.equal(reviseSource(sim,task.id).ok,true);
  assert.notEqual(task.sourceFingerprint,old);
  assert.equal(decide(sim,task.id,'approve',old).ok,false);
  assert.equal(sim.writes.length,0);
});
test('current DB version and direct source mutations invalidate otherwise matching approval',()=>{
  const sim=createSimulation({count:1}),task=waitReview(sim);
  sim.products[0].version++;
  assert.equal(decide(sim,task.id,'approve',task.reviewFingerprint).ok,false);
  assert.equal(sim.writes.length,0);
  const other=createSimulation({count:1}),t=waitReview(other);
  t.sourceText+='\nrate=9';
  assert.equal(decide(other,t.id,'approve',t.reviewFingerprint).ok,false);
  assert.equal(other.writes.length,0);
});
test('application queue rechecks both source and DB after approval, before the write',()=>{
  for (const change of ['source','db']) {
    const sim=createSimulation({count:1}),task=waitReview(sim);
    assert.equal(decide(sim,task.id,'approve',task.reviewFingerprint).ok,true);
    assert.equal(task.stage,'apply');assert.equal(sim.writes.length,0);
    if(change==='source') task.sourceText+='\npost approval mutation';
    else sim.products[0].version++;
    advance(sim,2);
    assert.equal(task.stage,'hold');assert.equal(sim.writes.length,0);
  }
});
test('candidate validation rejects unknown, missing, mistyped, conflicting and forged evidence',()=>{
  const input=scenario(),e=input.events[0],p=input.products[0];
  assert.equal(validateCandidate(e,candidate(e),p).ok,true);
  for (const mutate of [c=>c.extra=true,c=>c.changes.extra=1,c=>delete c.changes.rate,c=>c.changes.rate='3',c=>c.changes.rate=31,c=>c.effectiveAt=null,c=>c.version=1,c=>c.version=9,c=>c.evidence[0].quote='productId=OTHER',c=>c.evidence.pop(),c=>c.productId='OTHER']) {
    const c=candidate(e);mutate(c);assert.equal(validateCandidate(e,c,p).ok,false);
  }
  const conflict=input.events.find(e=>e.kind==='conflict');
  assert.match(validateCandidate(conflict,candidate(conflict),input.products[2]).reason,/충돌/);
});
test('future, past, missing date, duplicate, competitor and conflicting source never write',()=>{
  const input=scenario(),sim=finishSimulation({count:12,autoReview:true},input);
  const expected={conflict:'hold','missing-date':'hold','past-version':'hold',future:'scheduled',duplicate:'duplicate',competitor:'research'};
  for (const [kind,stage] of Object.entries(expected)) {
    const task=sim.tasks.find(t=>t.kind===kind);assert.equal(task.stage,stage);
    assert.equal(sim.writes.some(w=>w.taskId===task.id),false);
  }
  assert.equal(sim.products[8].version,1);assert.equal(sim.research.length,1);
  assert.equal(sim.products.some(p=>p.id==='C1'),false);
});
test('automation 0,1,2 changes only permitted metadata review and preserves important review',()=>{
  const summaries=[];
  for (const automation of [0,1,2]) {
    const sim=finishSimulation({automation,count:12,autoReview:true},scenario());
    summaries.push(summarize(sim));
    for (const w of sim.writes) if (Object.keys(w.changes).some(k=>['rate','limit','reviewId','active'].includes(k))) assert.equal(w.humanReviewed,true);
    const capture=sim.writes.find(w=>w.taskId==='E2'),hash=sim.writes.find(w=>w.taskId==='E12');
    assert.equal(capture.humanReviewed,automation===0);assert.equal(hash.humanReviewed,automation<2);
  }
  assert.ok(summaries[0].totalHumanMinutes>summaries[1].totalHumanMinutes);
  assert.ok(summaries[1].totalHumanMinutes>summaries[2].totalHumanMinutes);
  assert.ok(summaries[0].automationRate<summaries[1].automationRate);
  assert.ok(summaries[1].automationRate<summaries[2].automationRate);
});
test('same supplied input produces faster assumed extraction but all modes preserve truth',()=>{
  const input=createScenario({count:24,arrivalInterval:0}),results={};
  for (const mode of ['manual','rules','agent']) {
    const sim=finishSimulation({mode,count:24,arrivalInterval:0,autoReview:true},input);
    results[mode]=summarize(sim);assert.equal(results[mode].wrongWrites,0);
    assert.equal(results[mode].unresolved,0);
    assert.deepEqual(sim.tasks.map(t=>({id:t.id,sourceText:t.sourceText})),input.events.map(t=>({id:t.id,sourceText:t.sourceText})));
  }
  assert.ok(results.manual.elapsed>results.rules.elapsed);
  assert.ok(results.rules.elapsed>results.agent.elapsed);
  assert.ok(results.manual.totalHumanMinutes>results.agent.totalHumanMinutes);
});
test('review staffing and arrival interval affect actual queue or lead time',()=>{
  const input=createScenario({count:24,arrivalInterval:0});
  const one=summarize(finishSimulation({reviewers:1,autoReview:true},input));
  const four=summarize(finishSimulation({reviewers:4,autoReview:true},input));
  assert.ok(one.elapsed>four.elapsed || one.avgLeadTime>four.avgLeadTime || one.maxReviewQueue>four.maxReviewQueue);
  const slow=summarize(finishSimulation({count:24,arrivalInterval:10,autoReview:true}));
  const fast=summarize(finishSimulation({count:24,arrivalInterval:0,autoReview:true}));
  assert.ok(slow.elapsed>fast.elapsed);assert.ok(slow.avgLeadTime<fast.avgLeadTime);
  const none=finishSimulation({reviewers:0,count:1,autoReview:true});
  assert.equal(none.tasks[0].stage,'review');assert.equal(none.time,600);assert.equal(none.writes.length,0);
});
test('review duration changes effort and bottleneck, and extra reviewers alleviate difficult reviews',()=>{
  const input=createScenario({seed:42,count:48,arrivalInterval:1});
  const fast=finishSimulation({mode:'agent',reviewMinutes:2,reviewers:1,autoReview:true},input);
  const slow=finishSimulation({mode:'agent',reviewMinutes:12,reviewers:1,autoReview:true},input);
  const staffed=finishSimulation({mode:'agent',reviewMinutes:12,reviewers:4,autoReview:true},input);
  const f=summarize(fast),s=summarize(slow),r=summarize(staffed);
  assert.deepEqual(fast.tasks.map(t=>t.sourceFingerprint),slow.tasks.map(t=>t.sourceFingerprint));
  assert.ok(s.totalHumanMinutes>f.totalHumanMinutes);
  assert.ok(s.maxReviewQueue>f.maxReviewQueue);
  assert.ok(s.elapsed>f.elapsed);
  assert.ok(s.avgLeadTime>f.avgLeadTime);
  assert.ok(r.elapsed<s.elapsed);
  assert.ok(r.avgLeadTime<s.avgLeadTime);
  assert.ok(r.maxReviewQueue<s.maxReviewQueue);
  assert.equal(f.wrongWrites,0);assert.equal(s.wrongWrites,0);assert.equal(r.wrongWrites,0);
  assert.equal(DEFAULT_CONFIG.reviewMinutes,4);
  assert.equal(createSimulation({reviewMinutes:1}).config.reviewMinutes,2);
  assert.equal(createSimulation({reviewMinutes:20}).config.reviewMinutes,12);
  assert.equal(createSimulation({reviewMinutes:4.9}).config.reviewMinutes,4);
  assert.throws(()=>createSimulation({reviewMinutes:NaN}));
});
test('pending earlier versions wait instead of permanent hold under slow high-load review',()=>{
  const input=createScenario({seed:42,count:48,arrivalInterval:1});
  for (const reviewers of [1,4]) {
    const sim=finishSimulation({mode:'agent',reviewMinutes:12,reviewers,autoReview:true},input);
    const normal=sim.tasks.filter(t=>['rate','limit','reviewId','active','capturedAt','sourceHash'].includes(t.kind));
    assert.equal(normal.length,24);assert.ok(normal.every(t=>t.stage==='done'));
    assert.equal(sim.tasks.some(t=>t.stage==='versionWait'),false);
    assert.equal(summarize(sim).wrongWrites,0);
    if (reviewers===1) assert.ok(sim.log.some(l=>l.type==='versionWait'));
    assert.deepEqual(sim.tasks.map(t=>t.sourceFingerprint),input.events.map(t=>t.sourceFingerprint));
  }
});
test('later version stays nonterminal until predecessor approval, and predecessor hold blocks it',()=>{
  const input=createScenario({count:13,arrivalInterval:1});
  const sim=createSimulation({reviewMinutes:12,autoReview:false},input);
  advance(sim,40);
  const first=sim.tasks.find(t=>t.id==='E1'),later=sim.tasks.find(t=>t.id==='E13');
  assert.equal(first.stage,'review');assert.equal(later.stage,'versionWait');
  assert.equal(later.completedAt,null);
  assert.equal(sim.seen.includes(`${later.productId}|${later.version}|${later.sourceFingerprint}`),false);
  const clone=JSON.parse(JSON.stringify(sim));
  assert.equal(decide(sim,first.id,'hold',first.reviewFingerprint).ok,true);
  advance(sim,1);assert.equal(later.stage,'hold');assert.match(later.reason,/先|先行|앞선/);
  assert.equal(sim.writes.some(w=>w.taskId===later.id),false);
  assert.equal(decide(clone,first.id,'approve',first.reviewFingerprint).ok,true);
  advance(clone,2);assert.equal(clone.tasks.find(t=>t.id===later.id).stage,'review');
  assert.equal(clone.tasks.find(t=>t.id===later.id).reviewDbVersion,2);
});
test('sample extraction parses source independently of fixture changes, evidence and expected values',()=>{
  const input=createScenario({count:1}),truth=input.events[0].changes.rate;
  input.events[0].changes.rate=25;
  input.events[0].evidence=[{field:'rate',quote:'rate=FAKE'}];
  input.events[0].expected.changes.rate=29;
  const sim=createSimulation({},input);advance(sim,2);
  assert.equal(sim.tasks[0].candidate.changes.rate,truth);
  assert.equal(sim.tasks[0].candidate.evidence.find(e=>e.field==='rate').quote,`rate=${truth}`);
  const finished=finishSimulation({autoReview:true},input);
  assert.equal(finished.products[0].rate,truth);
  assert.equal(summarize(finished).wrongWrites,1);
});
test('metrics match event log, actual writes and terminal status; human hold is terminal',()=>{
  const sim=finishSimulation({autoReview:true},scenario()),m=summarize(sim);
  assert.equal(m.completed,sim.log.filter(l=>['done','hold','scheduled','duplicate','research'].includes(l.type)).length);
  assert.equal(m.reviewed,sim.log.filter(l=>l.type==='decision').length);
  assert.equal(m.writeCount,sim.writes.length);assert.equal(m.applied,m.writeCount);
  assert.equal(m.arrived,sim.log.filter(l=>l.type==='arrive').length);
  assert.equal(m.wrongWrites,0);
  const manual=createSimulation({count:1}),t=waitReview(manual);
  assert.equal(decide(manual,t.id,'hold',t.reviewFingerprint).ok,true);
  assert.equal(summarize(manual).held,1);assert.equal(manual.writes.length,0);
});
test('truth mismatch counts wrong write independently of successful candidate validation',()=>{
  const input=createScenario({count:1});input.events[0].expected.changes.rate=99;
  const sim=finishSimulation({autoReview:true},input);
  assert.equal(sim.tasks[0].stage,'done');assert.equal(summarize(sim).wrongWrites,1);
});
test('zero denominators are null and zero tasks complete without fictitious effort',()=>{
  const sim=finishSimulation({count:0});assert.equal(sim.time,0);
  const m=summarize(sim);assert.equal(m.avgLeadTime,null);assert.equal(m.automationRate,null);
  assert.equal(m.writeCount,0);assert.equal(m.totalHumanMinutes,0);
  assert.throws(()=>advance(sim,-1));assert.throws(()=>createSimulation({mode:'unknown'}));
});
