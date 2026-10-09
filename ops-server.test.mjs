import test from 'node:test';
import assert from 'node:assert/strict';
import {makeServer} from './server.mjs';
async function withServer(run,options={}){const server=makeServer({storePath:':memory:',env:{},now:()=>new Date('2026-10-08T12:00:00Z'),fetchImpl:async()=>{throw new Error('offline');},...options});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{await run(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(resolve=>server.close(resolve));}}
const headers={'Content-Type':'application/json','X-Ops-Client':'local-demo'};
const post=(base,path,data,override={})=>fetch(base+path,{method:'POST',headers:{...headers,...override},body:JSON.stringify(data)});
test('ops endpoint transport guards JSON, custom header, Origin and strict payload',()=>withServer(async base=>{
  const sample=await(await fetch(base+'/api/ops/samples')).json();
  assert.equal((await fetch(base+'/api/ops/notices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sample.normal)})).status,403);
  assert.equal((await post(base,'/api/ops/notices',sample.normal,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post(base,'/api/ops/notices',sample.normal,{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await post(base,'/api/ops/notices',{...sample.normal,candidate:{rate:1}})).status,400);
  assert.equal((await post(base,'/api/ops/reset',{scope:'cloud'})).status,400);
  assert.equal((await fetch(base+'/api/ops/state',{method:'DELETE'})).status,405);
}));
test('n8n proxy forwards synthetic envelope to a fixed loopback URL and returns workflow execution result',()=>{
  let forwarded;const workflowResult={caseId:'case-from-n8n',executionId:'actual-exec-42',status:'pending',duplicate:'false',nextAction:'review locally'};
  return withServer(async base=>{
    const sample=(await(await fetch(base+'/api/ops/samples')).json()).normal;
    const response=await post(base,'/api/ops/intake-via-n8n',sample);assert.equal(response.status,202);assert.deepEqual(await response.json(),{ok:true,via:'n8n',result:workflowResult});assert.deepEqual(JSON.parse(forwarded.body),sample);assert.equal(forwarded.headers['X-Ops-Client'],'local-demo');assert.equal(forwarded.headers['Content-Type'],'application/json');assert.equal(forwarded.redirect,'error');assert.ok(forwarded.signal instanceof AbortSignal);
    const state=await(await fetch(base+'/api/ops/state')).json();assert.equal(state.cases.length,0,'proxy does not create a direct-store fallback');assert.equal(state.products[0].version,1);assert.equal(state.integrations.find(i=>i.id==='n8n').mode,'off','proxy alone does not claim successful automation events');
  },{fetchImpl:async(url,options)=>{assert.equal(url,'http://127.0.0.1:5678/webhook/financial-product-ops-intake');forwarded=options;return {ok:true,status:202,json:async()=>workflowResult};}});
});
test('n8n proxy remote errors expose bounded status without forwarding untrusted error text',()=>withServer(async base=>{
  const sample=(await(await fetch(base+'/api/ops/samples')).json()).normal;
  const response=await post(base,'/api/ops/intake-via-n8n',sample);assert.equal(response.status,502);const result=await response.json();assert.equal(result.code,'N8N_WEBHOOK_ERROR');assert.equal(result.upstreamStatus,404);assert.equal((await(await fetch(base+'/api/ops/state')).json()).cases.length,0);
},{fetchImpl:async()=>({ok:false,status:404,json:async()=>({error:'private upstream error'})})}));
test('n8n unavailable and invalid upstream response fail without direct-store fallback',async()=>{
  for(const [fetchImpl,status,code] of [[async()=>{throw new Error('connection refused');},503,'N8N_UNAVAILABLE'],[async()=>({ok:true,status:202,json:async()=>{throw new SyntaxError('not JSON');}}),502,'N8N_INVALID_RESPONSE'],[async()=>({ok:true,status:200,json:async()=>({message:'workflow started'})}),502,'N8N_INVALID_RESPONSE']])await withServer(async base=>{const sample=(await(await fetch(base+'/api/ops/samples')).json()).normal;const response=await post(base,'/api/ops/intake-via-n8n',sample);assert.equal(response.status,status);assert.equal((await response.json()).code,code);assert.equal((await(await fetch(base+'/api/ops/state')).json()).cases.length,0);},{fetchImpl});
});
test('n8n proxy rejects invalid envelopes, user URLs and transport forgery before forwarding',()=>{
  let requests=0;
  return withServer(async base=>{
    const sample=(await(await fetch(base+'/api/ops/samples')).json()).normal;
    for(const data of [{...sample,url:'https://remote.invalid'},{...sample,sourceText:'real private text'},{...sample,noticeId:'x'.repeat(201)},{...sample,sourceText:'合成資料'.repeat(2700)},{...sample,sourceChannel:'remote'},{...sample,executionId:'x\nforged'}])assert.equal((await post(base,'/api/ops/intake-via-n8n',data)).status,400);
    assert.equal((await post(base,'/api/ops/intake-via-n8n',sample,{Origin:'https://evil.invalid'})).status,403);
    assert.equal((await fetch(base+'/api/ops/intake-via-n8n',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sample)})).status,403);
    assert.equal(requests,0);
  },{fetchImpl:async()=>{requests++;throw new Error('should not be called');}});
});
test('end to end source revise stale approval 409, duplicate decisions and reset isolation',()=>withServer(async base=>{
  const sample=(await(await fetch(base+'/api/ops/samples')).json()).normal;const item=(await(await post(base,'/api/ops/notices',sample)).json()).case;
  const approve={decision:'approve',sourceRevision:item.sourceRevision,expectedProductVersion:item.expectedProductVersion,decisionId:'decision-a',actor:'demo-reviewer'};
  const changed=await post(base,'/api/ops/notices',{...sample,sourceText:sample.sourceText.replace('3.76','4.01')});assert.equal(changed.status,409);assert.equal((await changed.json()).case.status,'pending');
  const revised=(await(await post(base,`/api/ops/cases/${item.id}/revise`,{sourceText:item.sourceText.replace('3.76','3.8')})).json()).case;
  assert.equal((await post(base,`/api/ops/cases/${item.id}/decision`,approve)).status,409);
  const fresh={...approve,sourceRevision:revised.sourceRevision};assert.equal((await post(base,`/api/ops/cases/${item.id}/decision`,fresh)).status,200);assert.equal((await(await post(base,`/api/ops/cases/${item.id}/decision`,fresh)).json()).duplicate,true);
  let state=await(await fetch(base+'/api/ops/state')).json();assert.equal(state.products[0].rate,3.8);assert.equal(state.metrics.applied,1);assert.ok(state.integrations.find(i=>i.id==='storage'));
  assert.equal((await post(base,`/api/ops/cases/${item.id}/retry`,{})).status,409);await post(base,'/api/ops/reset',{scope:'synthetic-demo'});assert.equal((await post(base,`/api/ops/cases/${item.id}/decision`,fresh)).status,404);state=await(await fetch(base+'/api/ops/state')).json();assert.equal(state.products[0].version,1);assert.equal(state.cases.length,0);
}));

test('legacy notice conflict and failed workflow event cannot send an existing AI case to configured SaaS',()=>{
  let externalRequests=0;
  const env={OPS_JIRA_ENABLED:'true',OPS_JIRA_BASE_URL:'https://test.atlassian.net',OPS_JIRA_PROJECT:'OPS',OPS_JIRA_EMAIL:'stub@example.invalid',OPS_JIRA_TOKEN:'stub-secret',OPS_DATADOG_ENABLED:'true',OPS_DATADOG_API_KEY:'stub-datadog'};
  return withServer(async base=>{
    const {sourceChannel,...sample}=(await(await fetch(base+'/api/ops/ai-samples')).json()).normal;
    const response=await post(base,'/api/ops/analyze-notice',sample);assert.equal(response.status,200);const item=(await response.json()).case;
    assert.equal((await post(base,'/api/ops/notices',{noticeId:item.noticeId,sourceType:item.sourceType,sourceChannel:'manual',sourceText:item.sourceText.replace('3.76','3.90')})).status,409);
    assert.equal((await post(base,'/api/ops/automation-events',{caseId:item.id,type:'workflow-failed',executionId:'legacy-workflow',message:'synthetic failure'})).status,200);
    const state=await(await fetch(base+'/api/ops/state')).json();assert.equal(externalRequests,0);assert.ok(state.tickets.every(t=>t.mode==='local'));assert.equal(state.products[0].version,1);
  },{env,fetchImpl:async(url)=>{
    if(url==='http://127.0.0.1:8089/v1/chat/completions')return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({summary:'금리 변경',changes:[{field:'rate',value:3.76,quote:'대출 금리를 3.76%로 변경합니다.'}],effectiveDate:'2026-10-08',dateQuote:'2026-10-08부터 적용합니다.',conditions:[],questions:[]})}}]})};
    externalRequests++;throw new Error('external delivery must not occur');
  }});
});
