import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunner,classifyTaskOutcome,parseCliOutput} from './runner.mjs';
import {FinanceDomain} from './domain.mjs';

const cli=text=>JSON.stringify({payloads:[{text}],meta:{durationMs:25}});
function fixture(){
  let complete,env,args;const logs=[];
  const runner=createRunner('unused-server-token',{
    execFileImpl(_file,argv,options,callback){complete=callback;env=options.env;args=argv;},
    persistRun(run,stderr){logs.push({run:structuredClone(run),stderr});},
  });
  return {runner,logs,get token(){return env.FINANCE_TOOL_TOKEN;},get args(){return args;},
    record(result,name,args={}){const lease=runner.permitTool('Bearer '+env.FINANCE_TOOL_TOKEN);runner.beginTool(lease,name,args);runner.recordTool(result,name,args,lease);runner.endTool(lease);},
    finish(error=null,stdout=cli('Finished.'),stderr=''){complete(error,stdout,stderr);}};
}
async function domainFixture(t){
  const domain=new FinanceDomain({now:()=>new Date('2026-10-10T03:00:00Z'),fetchImpl:async url=>new Response(url.endsWith('/partner')?domain.demoNotice('partner'):url.endsWith('/competitor')?domain.demoNotice('competitor'):'<title>Public page</title><p>Public research text</p>')});
  t.after(()=>domain.close());return domain;
}
async function propose(domain,sourceId){
  const fetchResult=await domain.execute('finance_fetch',{sourceId});
  assert.equal(fetchResult.ok,true);
  const lines=fetchResult.rawText.split('\n');
  return domain.execute('finance_propose',{archiveId:fetchResult.archiveId,rate:3.76,effectiveDate:'2026-10-10',quote:lines[3],dateQuote:lines[4]});
}

test('local CLI payloads display final text while metadata stays in the envelope',()=>{
  const parsed=parseCliOutput(JSON.stringify({payloads:[{text:'First'},{mediaUrl:'example'},{text:'Second'}],meta:{model:'Qwen3'}}));
  assert.equal(parsed.output,'First\n\nSecond');assert.equal(parsed.envelope.meta.model,'Qwen3');assert.equal(parsed.error,null);
  assert.equal(parseCliOutput('not JSON').output,'not JSON');assert.ok(parseCliOutput('not JSON').error);
  assert.equal(parseCliOutput('{"ok":false,"error":{"message":"model failed"}}').error,'model failed');
});

test('authorization requires the exact Bearer prefix and rotating active-run token',()=>{
  const f=fixture();assert.throws(()=>f.runner.permitTool('Bearer invalid'));
  f.runner.run('partner');const oldToken=f.token;
  for(const header of ['xxxxxxx'+oldToken,'bearer '+oldToken,'Bearer '+oldToken+'x','Bearer '+'é'.repeat(64),undefined])assert.throws(()=>f.runner.permitTool(header),/authorization/);
  f.runner.permitTool('Bearer '+oldToken);f.finish();
  assert.throws(()=>f.runner.permitTool('Bearer '+oldToken));
  f.runner.run('partner');assert.notEqual(f.token,oldToken);assert.throws(()=>f.runner.permitTool('Bearer '+oldToken));
  for(let index=0;index<12;index++)f.runner.permitTool('Bearer '+f.token);
  assert.throws(()=>f.runner.permitTool('Bearer '+f.token),/12 tool call limit/);f.finish();
});

test('CLI completion and model prose cannot claim business success',()=>{
  const f=fixture();f.runner.run('partner');
  f.record({ok:true,sources:[]},'finance_sources',{});
  f.finish(null,cli('{"ok":true,"proposal":{"status":"pending-review"}}'));
  const run=f.runner.runs[0];assert.equal(run.cliStatus,'completed');assert.equal(run.outcomeStatus,'failed');assert.equal(run.status,'error');
  assert.match(run.error,/변경 후보/);assert.equal(f.runner.busy,false);assert.equal(f.logs.length,1);
});

test('a failed domain tool retains its reason despite successful CLI exit',()=>{
  const f=fixture();f.runner.run('partner');
  f.record({ok:false,code:'EVIDENCE_MISMATCH',error:'Exact quote required'},'finance_propose',{archiveId:'a'});
  f.finish(null,cli('I created the proposal.'));
  const run=f.runner.runs[0];assert.equal(run.status,'error');assert.equal(run.cliStatus,'completed');
  assert.match(run.error,/EVIDENCE_MISMATCH/);assert.equal(run.toolErrors[0].error,'Exact quote required');assert.equal(run.output,'I created the proposal.');
});

test('real partner proposal and competitor research have distinct success criteria',async t=>{
  const domain=await domainFixture(t),partner=await propose(domain,'partner'),competitor=await propose(domain,'competitor');
  assert.equal(partner.ok,true);assert.equal(competitor.ok,true);
  const p={name:'finance_propose',args:{},result:partner},c={name:'finance_propose',args:{},result:competitor};
  assert.equal(classifyTaskOutcome('partner',[p]).status,'succeeded');
  assert.equal(classifyTaskOutcome('competitor',[c]).status,'succeeded');
  assert.equal(classifyTaskOutcome('partner',[c]).status,'failed');
  assert.equal(classifyTaskOutcome('competitor',[p]).status,'failed');
  assert.equal(classifyTaskOutcome('partner',[{...p,result:{...partner,ok:false}}]).status,'failed');
  const f=fixture();f.runner.run('partner');f.record(partner,'finance_propose',{});f.finish(null,cli('Review candidate created.'));
  assert.equal(f.runner.runs[0].status,'completed');assert.equal(f.runner.runs[0].outcome.id,partner.proposal.id);
});

test('apply succeeds only for the requested actual applied proposal and DB snapshot',async t=>{
  const domain=await domainFixture(t),proposal=(await propose(domain,'partner')).proposal;
  const denied=await domain.execute('finance_apply',{proposalId:proposal.id});
  assert.equal(classifyTaskOutcome('apply',[{name:'finance_apply',args:{proposalId:proposal.id},result:denied}],proposal.id).status,'failed');
  domain.decide(proposal.id,'approve');const applied=await domain.execute('finance_apply',{proposalId:proposal.id});
  assert.equal(applied.ok,true);const execution={name:'finance_apply',args:{proposalId:proposal.id},result:applied};
  assert.equal(classifyTaskOutcome('apply',[execution],proposal.id).status,'succeeded');
  assert.equal(classifyTaskOutcome('apply',[execution],'other-id').status,'failed');
  assert.equal(classifyTaskOutcome('apply',[{...execution,result:{...applied,snapshot:{...applied.snapshot,rate:99}}}],proposal.id).status,'failed');
  assert.equal(classifyTaskOutcome('partner',[execution]).status,'failed');
});

test('public task needs a successful public fetch, not a source list or synthetic archive',async t=>{
  const domain=await domainFixture(t),result=await domain.execute('finance_fetch',{sourceId:'banksalad'});
  const execution={name:'finance_fetch',args:{sourceId:'banksalad'},result};
  assert.equal(classifyTaskOutcome('public',[execution]).status,'succeeded');
  assert.equal(classifyTaskOutcome('public',[{...execution,result:{...result,ok:false}}]).status,'failed');
  assert.equal(classifyTaskOutcome('public',[{...execution,result:{...result,rawText:''}}]).status,'failed');
  assert.equal(classifyTaskOutcome('public',[{...execution,args:{sourceId:'partner'}}]).status,'failed');
});

test('CLI timeout displays a readable error and preserves actual business result and original diagnostics',async t=>{
  const domain=await domainFixture(t),result=await propose(domain,'partner'),f=fixture();
  f.runner.run('partner');f.record(result,'finance_propose',{});
  f.finish(Object.assign(new Error('process timed out'),{code:'ETIMEDOUT',signal:'SIGTERM',killed:true}),cli('Candidate created'),'model stderr');
  const run=f.runner.runs[0];assert.equal(run.status,'error');assert.equal(run.cliStatus,'error');assert.equal(run.outcomeStatus,'succeeded');
  assert.equal(run.error,'OpenClaw가 실행 제한시간 안에 완료되지 않았습니다.');assert.equal(run.cliError,run.error);
  assert.deepEqual(run.cliDiagnostic,{message:'process timed out',code:'ETIMEDOUT',signal:'SIGTERM',killed:true});
  assert.equal(f.logs[0].stderr,'model stderr');assert.deepEqual(f.logs[0].run.cliDiagnostic,run.cliDiagnostic);assert.equal(f.logs[0].run.cliError,run.cliError);
});

test('non-timeout CLI errors retain original stderr as cliError',()=>{
  const f=fixture();f.runner.run('partner');
  f.finish(Object.assign(new Error('process failed'),{code:1,killed:false}),cli('Unable to finish'),'original model stderr');
  const run=f.runner.runs[0];assert.equal(run.error,'original model stderr');assert.equal(run.cliError,'original model stderr');assert.equal(run.cliDiagnostic.message,'process failed');assert.equal(run.cliDiagnostic.killed,false);
});

test('failed attempts survive a successful retry; runs and results are cloned',async t=>{
  const domain=await domainFixture(t),result=await propose(domain,'partner'),f=fixture();
  f.runner.run('partner');f.record({ok:false,code:'INVALID_ARGUMENT',error:'Missing quote'},'finance_propose',{});
  f.record(result,'finance_propose',{});result.proposal.status='changed externally';f.finish();
  const run=f.runner.runs[0];assert.equal(run.status,'completed');assert.equal(run.toolErrors.length,1);
  run.status='changed externally';assert.equal(f.runner.runs[0].status,'completed');assert.throws(()=>f.runner.recordTool({ok:true},'finance_sources',{}),/inactive run/);
});

test('invalid task and missing apply id do not start a run; spawn failures release busy state',()=>{
  const f=fixture();assert.throws(()=>f.runner.run('__proto__'),/Unknown task/);assert.throws(()=>f.runner.run('apply'),/proposalId/);assert.equal(f.runner.runs.length,0);
  const runner=createRunner('unused',{execFileImpl(){throw new Error('executable missing');},persistRun(){}});
  runner.run('partner');assert.equal(runner.busy,false);assert.equal(runner.runs[0].status,'error');assert.equal(runner.runs[0].error,'executable missing');
});

test('a request authorized in run A cannot execute or record against run B',async t=>{
  const domain=await domainFixture(t),result=await propose(domain,'partner'),f=fixture();
  f.runner.run('partner');const leaseA=f.runner.permitTool('Bearer '+f.token);
  assert.equal(leaseA.task,'partner');assert.equal(Object.isFrozen(leaseA),true);
  f.finish();f.runner.run('partner');
  assert.throws(()=>f.runner.verifyTool(leaseA,'finance_propose',{}),/inactive run/);
  assert.throws(()=>f.runner.beginTool(leaseA,'finance_propose',{}),/inactive run/);
  assert.throws(()=>f.runner.recordTool(result,'finance_propose',{},leaseA),/inactive run/);
  assert.throws(()=>f.runner.verifyTool({...leaseA},'finance_propose',{}),/inactive run/);
  f.finish();const runB=f.runner.runs[1];assert.equal(runB.toolCalls,0);assert.equal(runB.outcomeStatus,'failed');assert.equal(runB.status,'error');
});

test('CLI exit drains begun tools before unlocking and preserves their original-run results',async t=>{
  const domain=await domainFixture(t),result=await propose(domain,'partner'),f=fixture();
  f.runner.run('partner');const token=f.token,lease=f.runner.permitTool('Bearer '+token),notBegun=f.runner.permitTool('Bearer '+token);
  f.runner.beginTool(lease,'finance_propose',{archiveId:result.proposal.archiveId});
  f.finish(null,cli('CLI finished while tool response was in flight.'));
  assert.equal(f.runner.busy,true);assert.equal(f.runner.runs[0].toolInFlight,1);assert.equal(f.runner.runs[0].cliStatus,'completed');assert.equal(f.logs.length,0);
  assert.throws(()=>f.runner.run('partner'),/already running/);
  assert.throws(()=>f.runner.permitTool('Bearer '+token),/authorization/);
  assert.throws(()=>f.runner.beginTool(notBegun,'finance_sources',{}),/expired/);
  f.runner.recordTool(result,'finance_propose',{archiveId:result.proposal.archiveId},lease);
  assert.equal(f.runner.busy,true);f.runner.endTool(lease);
  assert.equal(f.runner.busy,false);assert.equal(f.runner.runs[0].status,'completed');assert.equal(f.runner.runs[0].toolInFlight,0);assert.equal(f.logs.length,1);
  f.runner.run('partner');assert.throws(()=>f.runner.recordTool(result,'finance_propose',{archiveId:result.proposal.archiveId},lease),/inactive run/);f.finish();assert.equal(f.runner.runs[1].outcomeStatus,'failed');
});

test('tool scope is checked before execution, including exact source and apply identifiers',()=>{
  const scenarios=[
    ['partner',undefined,[['finance_sources',{}],['finance_fetch',{sourceId:'partner'}],['finance_snapshot',{productId:'partner-loan'}],['finance_propose',{archiveId:'a'}]],[['finance_apply',{proposalId:'p'}],['finance_fetch',{sourceId:'competitor'}],['finance_snapshot',{productId:'other'}]]],
    ['competitor',undefined,[['finance_fetch',{sourceId:'competitor'}],['finance_propose',{archiveId:'a'}]],[['finance_fetch',{sourceId:'partner'}],['finance_apply',{proposalId:'p'}],['finance_snapshot',{productId:'partner-loan'}]]],
    ['public',undefined,[['finance_sources',{}],['finance_fetch',{sourceId:'banksalad'}]],[['finance_fetch',{sourceId:'partner'}],['finance_propose',{archiveId:'a'}],['finance_apply',{proposalId:'p'}]]],
    ['apply','chosen',[['finance_apply',{proposalId:'chosen'}]],[['finance_apply',{proposalId:'other'}],['finance_fetch',{sourceId:'partner'}],['finance_sources',{}],['finance_propose',{archiveId:'a'}]]],
  ];
  for(const [task,proposalId,allowed,denied] of scenarios){
    const f=fixture();f.runner.run(task,proposalId);
    for(const [name,args] of [...allowed,['finance_report',{reason:'exception'}]]){const lease=f.runner.permitTool('Bearer '+f.token);assert.equal(f.runner.verifyTool(lease,name,args),true);}
    for(const [name,args] of [...denied,['unknown_tool',{}]]){const lease=f.runner.permitTool('Bearer '+f.token);assert.throws(()=>f.runner.beginTool(lease,name,args),/Task scope violation/);assert.equal(f.runner.runs[0].toolInFlight,0);}
    f.finish();
  }
});

test('leases require begin, bind inputs, and reject duplicate records and duplicate end',()=>{
  const f=fixture();f.runner.run('partner');const lease=f.runner.permitTool('Bearer '+f.token);
  assert.throws(()=>f.runner.recordTool({ok:true},'finance_fetch',{sourceId:'partner'},lease),/begun request/);
  f.runner.beginTool(lease,'finance_fetch',{sourceId:'partner'});
  assert.throws(()=>f.runner.beginTool(lease,'finance_fetch',{sourceId:'partner'}),/expired/);
  assert.throws(()=>f.runner.recordTool({ok:true},'finance_fetch',{sourceId:'competitor'},lease),/begun request/);
  f.runner.recordTool({ok:false,code:'FETCH_FAILED',error:'network'},'finance_fetch',{sourceId:'partner'},lease);
  assert.throws(()=>f.runner.recordTool({ok:true},'finance_fetch',{sourceId:'partner'},lease),/begun request/);
  f.runner.endTool(lease);assert.throws(()=>f.runner.endTool(lease),/not in flight/);f.finish();assert.equal(f.runner.runs[0].status,'error');
});
