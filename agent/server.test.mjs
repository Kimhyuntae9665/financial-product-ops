import test from 'node:test';
import assert from 'node:assert/strict';
import {makeAgentServer} from './server.mjs';
import {FinanceDomain} from './domain.mjs';
import {request as httpRequest} from 'node:http';
import {createRunner} from './runner.mjs';
async function fixture(t,options={}){
  const domain=options.domain||new FinanceDomain();
  const runner=options.runner||{runs:[],busy:false,permitTool(header){if(header!=='Bearer test-run')throw new Error('Tool authorization required');},run(task){this.runs.push({task});this.busy=true;return {task,status:'running'};}};
  const {server}=makeAgentServer({domain,runner});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(()=>{domain.close();r();})));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,body,headers={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(base+path,{method:body===undefined?'GET':'POST',headers:{Host:'127.0.0.1:4330','Content-Type':'application/json','X-Finance-Client':'local-demo',...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});
    req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  return {domain,runner,request};
}
test('HTTP exposes the console and current synthetic DB, excludes runtime and secret files',async t=>{
  const {request}=await fixture(t);
  const page=await request('/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const state=await(await request('/api/state')).json();assert.equal(state.domain.products[0].rate,4.5);assert.equal(JSON.stringify(state).includes('test-run'),false);
  for(const path of ['/plugin/index.mjs','/.runtime.json','/server.mjs','/finance-agent.sqlite'])assert.equal((await request(path)).status,404);
});

test('selected public research cannot dispatch a DB apply or partner fetch',async t=>{
  let env,finish;
  const runner=createRunner(null,{execFileImpl(_exe,_args,options,callback){env=options.env;finish=callback;},persistRun(){}});
  const {domain,request}=await fixture(t,{runner});
  await request('/api/run',{task:'public'});
  const auth={Authorization:`Bearer ${env.FINANCE_TOOL_TOKEN}`};
  assert.equal((await request('/api/tool',{name:'finance_apply',args:{proposalId:'approved-id'}},auth)).status,403);
  assert.equal((await request('/api/tool',{name:'finance_fetch',args:{sourceId:'partner'}},auth)).status,403);
  assert.equal(domain.state().events.length,0);
  assert.equal(domain.state().products[0].rate,4.5);
  finish(null,JSON.stringify({payloads:[{text:'No work'}]}),'');
  assert.equal(runner.runs[0].status,'error');
});

test('partner run cannot propose from a competitor archive even with matching authority',async t=>{
  let env,finish;
  const runner=createRunner(null,{execFileImpl(_exe,_args,options,callback){env=options.env;finish=callback;},persistRun(){}});
  const domain=new FinanceDomain({fetchImpl:async()=>new Response(domain.demoNotice('competitor'))});
  const fetched=await domain.execute('finance_fetch',{sourceId:'competitor'});
  const {request}=await fixture(t,{domain,runner});
  await request('/api/run',{task:'partner'});
  const response=await request('/api/tool',{name:'finance_propose',args:{archiveId:fetched.archiveId}},{Authorization:`Bearer ${env.FINANCE_TOOL_TOKEN}`});
  assert.equal(response.status,403);assert.match((await response.json()).error,/selected task source/);
  assert.equal(domain.state().proposals.length,0);assert.equal(domain.state().research.length,0);
  finish(null,JSON.stringify({payloads:[{text:'Stopped'}]}),'');
});
test('HTTP host, origin and local-client guards reject cross-origin mutations',async t=>{
  const {domain,request}=await fixture(t);
  assert.equal((await request('/api/reset',{}, {Host:'attacker.test'})).status,403);
  assert.equal((await request('/api/reset',{}, {Origin:'https://attacker.test'})).status,403);
  assert.equal((await request('/api/reset',{}, {'X-Finance-Client':''})).status,403);
  assert.equal((await request('/api/reset',{}, {'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal(domain.state().epoch,1);
});
test('Agent tool route needs run authority and cannot expose human approval',async t=>{
  const {domain,request}=await fixture(t);
  assert.equal((await request('/api/tool',{name:'finance_sources',args:{}})).status,403);
  const result=await(await request('/api/tool',{name:'human_decide',args:{approved:true}},{Authorization:'Bearer test-run'})).json();
  assert.equal(result.ok,false);assert.equal(result.code,'UNKNOWN_TOOL');assert.equal(domain.state().approvals.length,0);
});
test('Running Agent locks source editing, reset and human decisions',async t=>{
  const {domain,request}=await fixture(t);
  assert.equal((await request('/api/run',{task:'partner'})).status,202);
  for(const [path,body] of [['/api/reset',{}],['/api/notice',{text:'new'}],['/api/decision',{proposalId:'x',decision:'approve'}]])assert.equal((await request(path,body)).status,409);
  assert.equal(domain.state().epoch,1);
});
test('HTTP rejects wrong content type and oversized notice input',async t=>{
  const {request}=await fixture(t);
  assert.equal((await request('/api/reset',{}, {'Content-Type':'text/plain'})).status,415);
  assert.equal((await request('/api/notice',{text:'x'.repeat(17000)})).status,413);
});
