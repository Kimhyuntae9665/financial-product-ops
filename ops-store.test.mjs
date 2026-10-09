import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OpsStore,parseSource} from './ops-store.mjs';
import {OpsIntegrations} from './ops-integrations.mjs';

const now=()=>new Date('2026-10-08T12:00:00Z');
const withStore=run=>{const store=new OpsStore({now});try{return run(store);}finally{store.close();}};
const approval=(item,decisionId='approve-1',decision='approve')=>({decision,sourceRevision:item.sourceRevision,expectedProductVersion:item.expectedProductVersion,decisionId,actor:'demo-reviewer'});

test('independent parser preserves quotes, rejects duplicates, unknown keys, dates and ranges',()=>withStore(store=>{
  const sample=store.samples().normal;const result=parseSource(sample.sourceText);assert.deepEqual(result.errors,[]);assert.deepEqual(result.candidate.changes,{rate:3.76});assert.ok(result.candidate.evidence.some(e=>e.field==='rate'&&e.quote==='rate=3.76'));
  for(const source of [sample.sourceText+'\nrate=6',sample.sourceText+'\nsecret=x',sample.sourceText.replace('2026-10-08','2026-02-30'),sample.sourceText.replace('rate=3.76','rate=31'),sample.sourceText.replace('rate=3.76','limit=3.5'),sample.sourceText.replace('rate=3.76','active=1'),sample.sourceText.replace('rate=3.76','reviewId=REAL-123')])assert.ok(parseSource(source).errors.length);
}));
test('source failures held; future and competitor never write product DB',()=>withStore(store=>{
  const before=store.rows('products');const samples=store.samples();
  for(const [key,status] of [['conflict','held'],['missingDate','held'],['competitor','research'],['future','scheduled']]){const result=store.receive(samples[key]);assert.equal(result.case.status,status);assert.throws(()=>store.decision(result.case.id,approval(result.case)),error=>error.status===400||error.status===409);}
  assert.deepEqual(store.rows('products'),before);assert.equal(store.rows('tickets').length,2);
}));
test('receive and decision idempotency retain exactly one product write and audit',()=>withStore(store=>{
  const sample=store.samples().normal;const first=store.receive(sample);assert.equal(first.case.status,'pending');assert.equal(store.receive(sample).duplicate,true);assert.equal(store.state().metrics.duplicateReceipts,1);
  const decision=approval(first.case);const applied=store.decision(first.case.id,decision);assert.equal(applied.case.status,'applied');assert.equal(applied.product.version,2);assert.equal(applied.product.rate,3.76);
  const replay=store.decision(first.case.id,{...decision});assert.equal(replay.duplicate,true);assert.deepEqual(replay.case,applied.case);
  assert.equal(store.rows('events').filter(e=>e.type==='applied').length,1);
  assert.throws(()=>store.decision(first.case.id,{...decision,decision:'hold'}),error=>error.status===409);
}));
test('same notice ID modified text conflicts without overwriting fresh pending review',()=>withStore(store=>{
  const sample=store.samples().normal,first=store.receive(sample);const changed=store.receive({...sample,sourceText:sample.sourceText.replace('3.76','3.9')});assert.equal(changed.conflict,true);assert.equal(changed.case.sourceText,sample.sourceText);assert.equal(changed.case.status,'pending');assert.equal(store.state().cases.length,1);assert.equal(store.rows('tickets').length,1);assert.equal(store.decision(first.case.id,approval(first.case)).product.rate,3.76);
}));
test('revised source rejects stale approval but leaves the new pending revision usable',()=>withStore(store=>{
  const item=store.receive(store.samples().normal).case,old=approval(item);const revised=store.revise(item.id,{sourceText:item.sourceText.replace('3.76','3.9')}).case;
  assert.equal(revised.sourceRevision,2);assert.notEqual(revised.sourceHash,item.sourceHash);assert.equal(revised.status,'pending');assert.throws(()=>store.decision(item.id,old),error=>error.status===409);assert.equal(store.requiredCase(item.id).status,'pending');assert.equal(store.decision(item.id,approval(revised,'new-decision')).product.rate,3.9);assert.throws(()=>store.revise(item.id,{sourceText:item.sourceText}),error=>error.status===409);
}));
test('competing pending cases cannot overwrite product after another approval advances version',()=>withStore(store=>{
  const sample=store.samples().normal,a=store.receive(sample).case,b=store.receive({...sample,noticeId:'other-notice',sourceText:sample.sourceText.replace('3.76','3.95')}).case;
  store.decision(a.id,approval(a));assert.throws(()=>store.decision(b.id,approval(b,'approve-b')),error=>error.status===409);assert.equal(store.get('products','P1').rate,3.76);assert.equal(store.requiredCase(b.id).status,'pending');
}));
test('reset rotates epoch and identifiers; late approval cannot approve new case',()=>withStore(store=>{
  const sample=store.samples().normal,old=store.receive(sample).case,epoch=store.state().epoch;store.reset({scope:'synthetic-demo'});const fresh=store.receive(sample).case;assert.notEqual(store.state().epoch,epoch);assert.notEqual(fresh.id,old.id);assert.throws(()=>store.decision(old.id,approval(old)),error=>error.status===404);assert.equal(store.get('products','P1').version,1);assert.equal(store.requiredCase(fresh.id).status,'pending');
}));
test('SQLite restart preserves source snapshots, product, audit, tickets and decision receipts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'product-ops-'));const path=join(dir,'ops.sqlite');let store=new OpsStore({path,now});try{const item=store.receive(store.samples().normal).case,request=approval(item);store.decision(item.id,request);const held=store.receive(store.samples().conflict).case;const snapshot=store.state();store.close();store=new OpsStore({path,now});assert.deepEqual(store.state(),snapshot);assert.equal(store.decision(item.id,request).duplicate,true);assert.equal(store.requiredCase(held.id).status,'held');}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('transaction rolls back product and case when audit insert fails',()=>withStore(store=>{
  const item=store.receive(store.samples().normal).case;store.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");assert.throws(()=>store.decision(item.id,approval(item)),/audit unavailable/);assert.equal(store.get('products','P1').version,1);assert.equal(store.requiredCase(item.id).status,'pending');assert.equal(store.db.prepare('SELECT COUNT(*) count FROM decisions').get().count,0);
}));
test('hold keeps source data and product binding; revise cannot change the bound product',()=>withStore(store=>{
  const item=store.receive(store.samples().normal).case;assert.equal(store.decision(item.id,approval(item,'hold-1','hold')).case.status,'held');const revised=store.revise(item.id,{sourceText:item.sourceText.replace('productId=P1','productId=P2')}).case;assert.equal(revised.status,'held');assert.equal(revised.productId,'P1');assert.match(revised.reason,/상품 식별자/);assert.equal(store.get('products','P1').version,1);
}));
test('n8n status requires received workflow execution evidence; dedupes events and failed creates ticket',()=>withStore(store=>{
  const item=store.receive({...store.samples().normal,sourceChannel:'n8n',executionId:'exec-1'}).case,adapters=new OpsIntegrations(store,{env:{},fetchImpl:()=>{throw new Error('no network');}});assert.equal(adapters.status().find(i=>i.id==='n8n').mode,'off');const payload={caseId:item.id,type:'workflow-started',executionId:'exec-1',message:'actual workflow received'};store.automationEvent(payload);assert.equal(store.automationEvent(payload).duplicate,true);assert.equal(adapters.status().find(i=>i.id==='n8n').mode,'connected');store.automationEvent({...payload,type:'workflow-failed',message:'validation branch failure'});assert.equal(store.rows('tickets').length,1);assert.equal(store.get('products','P1').version,1);assert.equal(adapters.status().find(i=>i.id==='n8n').mode,'failed');assert.throws(()=>store.automationEvent({...payload,caseId:'missing'}),error=>error.status===404);
}));
test('completion average uses applied, held and research cases and exposes its denominator',()=>{
  let time=Date.parse('2026-10-08T12:00:00Z');const store=new OpsStore({now:()=>new Date(time)});
  try{
    assert.equal(store.state().metrics.completedCount,0);assert.equal(store.state().metrics.elapsedMsAverage,null);
    const applied=store.receive(store.samples().normal).case;
    assert.equal(store.state().metrics.completedCount,0);assert.equal(store.state().metrics.elapsedMsAverage,null);
    time+=10000;store.decision(applied.id,approval(applied));
    store.receive(store.samples().conflict);store.receive(store.samples().competitor);
    const metrics=store.state().metrics;assert.equal(metrics.applied,1);assert.equal(metrics.completedCount,3);assert.equal(metrics.elapsedMsAverage,3333);
  }finally{store.close();}
});
