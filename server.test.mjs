import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {makeServer} from './server.mjs';

async function withServer(run,options={}){
  const server=makeServer({storePath:':memory:',env:{},...options});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{await run(base);}finally{await new Promise(resolve=>server.close(resolve));}
}
test('serves the real app and ESM module, excludes private/intermediate files',()=>withServer(async base=>{
  assert.equal((await fetch(base)).status,200);assert.match(await(await fetch(`${base}/app.mjs`)).text(),/createSimulation/);
  for(const path of ['/CONTRACT.md','/start.cmd','/core.test.mjs','/%2e%2e%2fimplementation-plan.md','/api/unknown'])assert.equal((await fetch(base+path)).status,404);
}));
test('rejects requests from another origin and non-local Host',()=>withServer(async base=>{
  assert.equal((await fetch(`${base}/api/models`,{headers:{Origin:'https://example.com'}})).status,403);
  const status=await new Promise((resolve,reject)=>{const req=http.get(base,{headers:{Host:'not-local.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(status,403);
}));
test('unavailable local model is explicit, no sample substitute',()=>withServer(async base=>{
  const response=await fetch(`${base}/api/models`);assert.equal(response.status,503);assert.match((await response.json()).error,/Ollama/);
},{fetchImpl:async()=>{throw new Error('offline');}}));
test('model output is JSON parsed and reports elapsed time; no data written',()=>withServer(async base=>{
  const response=await fetch(`${base}/api/extract`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'test-model',sourceText:'[합성 자료]\nproductId=P1\nversion=2\neffectiveAt=0\nrate=4'})});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.candidate.productId,'P1');assert.ok(result.elapsedMs>=0);
},{fetchImpl:async(_url,options)=>{const request=JSON.parse(options.body);assert.equal(request.stream,false);assert.equal(request.format.type,'object');assert.ok(!request.prompt.includes('expected'));return {ok:true,json:async()=>({response:'{"productId":"P1","version":2,"effectiveAt":0,"changes":{"rate":4},"evidence":[]}'})};}}));
test('invalid model JSON and invalid input remain failed',()=>withServer(async base=>{
  const post=data=>fetch(`${base}/api/extract`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await post({model:'demo',sourceText:'private text'})).status,400);
  assert.equal((await post({model:'demo',sourceText:'합성 자료'})).status,502);
  assert.equal((await fetch(`${base}/api/extract`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
},{fetchImpl:async()=>({ok:true,json:async()=>({response:'not json'})})}));
