import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Readable} from 'node:stream';
import {request as httpRequest} from 'node:http';
import {makeRemoteProxy,remoteSshArgs} from './remote-proxy.mjs';
import {readRemoteInput,relayRemoteRequest} from './remote-request.mjs';

const config={host:'192.0.2.10',user:'테스트계정',key:'C:/test/key',knownHosts:'C:/test/known-hosts',job:'C:/test/financial_demo'};
const metadata=(status=200,contentType='application/json')=>Buffer.from(JSON.stringify({status,contentType})+'\n');
function childFixture(action){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kills=0;
  child.killed=new Promise(resolve=>{child.kill=()=>{child.kills++;child.exitCode=1;resolve();queueMicrotask(()=>child.emit('close',1));return true;};});
  const input=[];child.stdin.on('data',chunk=>input.push(chunk));
  child.stdin.on('finish',()=>{child.input=JSON.parse(Buffer.concat(input).toString('utf8'));action?.(child);});
  child.complete=code=>{child.exitCode=code;child.emit('close',code);};return child;
}
async function proxyFixture(t,action,options={}){
  const children=[],spawns=[];let ready;
  const childReady=new Promise(resolve=>{ready=resolve;});
  const server=makeRemoteProxy({...config,...options,spawnImpl:(file,args,opts)=>{spawns.push({file,args,opts});const child=childFixture(action);children.push(child);ready(child);return child;}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,body,headers={},method=body===undefined?'GET':'POST')=>new Promise((resolve,reject)=>{
    const req=httpRequest(base+path,{method,headers:{Host:'127.0.0.1:8090','Content-Type':'application/json',Authorization:'Bearer local-only',...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });req.on('error',reject);req.end(body===undefined?undefined:typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));
  });
  return {server,base,children,spawns,childReady,request};
}
function fakeRequest(action){
  const state={};
  state.requestImpl=(options,callback)=>{
    state.options=options;const req=new EventEmitter();state.req=req;req.destroyed=false;
    req.setTimeout=(ms,fn)=>{state.timeoutMs=ms;state.timeout=fn;};
    req.destroy=error=>{req.destroyed=true;if(error)queueMicrotask(()=>req.emit('error',error));};
    req.end=body=>{state.body=body;queueMicrotask(()=>action({req,callback,state}));};return req;
  };return state;
}
const outputFixture=()=>{const output=new PassThrough(),chunks=[];output.on('data',chunk=>chunks.push(chunk));return {output,bytes:()=>Buffer.concat(chunks)};};

test('fixed SSH invocation preserves strict host checking and rejects command-bearing paths',()=>{
  const args=remoteSshArgs(config);assert.equal(args.at(-1),'node C:/test/financial_demo/remote-request.mjs');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.some(value=>value.startsWith('UserKnownHostsFile=')));
  for(const job of ['C:/test;whoami','C:/test&whoami','C:/test/../outside','C:/test/$(whoami)','C:/test`whoami','C:/test/remote.mjs','C:/with space/job','C:\\test\\job','/tmp/job'])assert.throws(()=>remoteSshArgs({...config,job}),/Invalid host or fixed remote job path/);
  for(const host of ['-V','192.0.2.10;whoami','host\nwhoami'])assert.throws(()=>remoteSshArgs({...config,host}),/Invalid host/);
});

test('proxy rejects invalid host, route, verb and Bearer before spawning SSH',async t=>{
  const f=await proxyFixture(t);
  for(const [path,body,headers,method] of [
    ['/health',undefined,{Host:'attacker.test'},'GET'],['/admin',undefined,{},'GET'],['/health',{}, {},'POST'],
    ['/v1/chat/completions',{}, {Authorization:'bearer local-only'},'POST'],['/v1/chat/completions',{}, {Authorization:''},'POST'],['/v1/chat/completions',{}, {Authorization:'Bearer local-onlyx'},'POST'],
  ])assert.equal((await f.request(path,body,headers,method)).status,403);
  assert.equal(f.spawns.length,0);
});

test('proxy rejects invalid JSON, array/null bodies and excessive input without SSH',async t=>{
  const f=await proxyFixture(t,undefined,{maxRequestBytes:128});
  for(const body of ['not JSON','[]','null'])assert.equal((await f.request('/v1/chat/completions',body)).status,400);
  assert.equal((await f.request('/v1/chat/completions',{messages:['x'.repeat(200)]})).status,413);assert.equal(f.spawns.length,0);
});

test('proxy preserves SSE status, content type and split metadata/body bytes',async t=>{
  const body=Buffer.from('data: {"text":"합성 금융"}\n\ndata: [DONE]\n\n');
  const f=await proxyFixture(t,child=>{
    const header=metadata(200,'text/event-stream; charset=utf-8');child.stdout.write(header.subarray(0,7));child.stdout.write(Buffer.concat([header.subarray(7),body.subarray(0,20)]));child.stdout.write(body.subarray(20));child.complete(0);
  });
  const result=await f.request('/v1/chat/completions',{stream:true,messages:[]});
  assert.equal(result.status,200);assert.equal(result.headers['content-type'],'text/event-stream; charset=utf-8');assert.equal(result.headers['cache-control'],'no-store');assert.deepEqual(result.body,body);
  assert.equal(f.children[0].input.path,'/v1/chat/completions');assert.equal(f.children[0].input.body.stream,true);assert.equal(f.spawns[0].file,'ssh.exe');assert.equal(f.spawns[0].opts.windowsHide,true);
});

test('proxy forwards upstream non-200 model statuses and GET request envelope',async t=>{
  const f=await proxyFixture(t,child=>{child.stdout.write(Buffer.concat([metadata(429),Buffer.from('model busy')]));child.complete(0);});
  const result=await f.request('/v1/models');assert.equal(result.status,429);assert.equal(result.body.toString(),'model busy');assert.deepEqual(f.children[0].input,{method:'GET',path:'/v1/models',body:null});
});

test('proxy keeps Korean JSON intact when an HTTP chunk divides a UTF-8 character',async t=>{
  const f=await proxyFixture(t,child=>{child.stdout.write(Buffer.concat([metadata(),Buffer.from('{}')]));child.complete(0);});
  const raw=Buffer.from(JSON.stringify({messages:[{role:'user',content:'합성 금리'}]})),split=raw.indexOf(Buffer.from('합'))+1;
  await new Promise((resolve,reject)=>{
    const req=httpRequest(f.base+'/v1/chat/completions',{method:'POST',headers:{Host:'127.0.0.1:8090',Authorization:'Bearer local-only'}},res=>{res.resume();res.on('end',resolve);res.on('error',reject);});
    req.on('error',reject);req.write(raw.subarray(0,split));setImmediate(()=>req.end(raw.subarray(split)));
  });assert.equal(f.children[0].input.body.messages[0].content,'합성 금리');
});

test('SSH error followed by close returns one 502 response and cleans up',async t=>{
  const f=await proxyFixture(t,child=>{child.emit('error',new Error('spawn failed'));child.complete(1);});
  const result=await f.request('/health');assert.equal(result.status,502);assert.match(result.body.toString(),/SSH model transport unavailable/);assert.equal(f.children[0].kills,1);
});

test('proxy rejects invalid and overlong metadata including a same-chunk newline',async t=>{
  for(const raw of [Buffer.from('not JSON\n'),metadata(999),metadata(200,'application/json\r\nX-Injected: yes'),Buffer.from(' '.repeat(100)+'\n{}'),Buffer.from(' '.repeat(100))]){
    const f=await proxyFixture(t,child=>child.stdout.write(raw),{maxMetadataBytes:96});
    const result=await f.request('/health');assert.equal(result.status,502);assert.equal(f.children[0].kills,1);
  }
});

test('client abort terminates the SSH process; relay timeout returns 504',async t=>{
  const f=await proxyFixture(t,child=>child.stdout.write(Buffer.concat([metadata(200,'text/event-stream'),Buffer.from('data: started\n\n')])));
  const clientDone=new Promise((resolve,reject)=>{
    const req=httpRequest(f.base+'/health',{headers:{Host:'127.0.0.1:8090'}},res=>{res.once('data',()=>res.destroy());res.on('close',resolve);res.on('error',()=>{});});req.on('error',reject);req.end();
  });const child=await f.childReady;await clientDone;await child.killed;assert.equal(child.kills,1);
  const timed=await proxyFixture(t,()=>{}, {timeoutMs:10});const result=await timed.request('/health');assert.equal(result.status,504);assert.equal(timed.children[0].kills,1);
});

test('remote stdin parsing preserves UTF-8 and enforces input budget',async()=>{
  const body=Buffer.from(JSON.stringify({method:'POST',path:'/v1/chat/completions',body:{messages:['합성']}})),split=body.indexOf(Buffer.from('합'))+1;
  const input=await readRemoteInput(Readable.from([body.subarray(0,split),body.subarray(split)]));assert.equal(input.body.messages[0],'합성');
  await assert.rejects(readRemoteInput(Readable.from([body]),10),/budget exceeded/);
});

test('remote worker rejects dynamic endpoint/command fields and invalid body types before requesting',async()=>{
  let calls=0;const requestImpl=()=>{calls++;throw new Error('must not execute');};
  for(const input of [null,[],{method:'GET',path:'http://attacker.test/health'},{method:'GET',path:'/health',host:'attacker.test'},{method:'GET',path:'/health',command:'whoami'},{method:'GET',path:'/health',body:{}},{method:'POST',path:'/v1/chat/completions',body:[]}])await assert.rejects(relayRemoteRequest(input,{requestImpl}),/Model endpoint not allowed/);
  assert.equal(calls,0);
});

test('remote worker sends only fixed loopback request and forwards metadata plus raw SSE',async()=>{
  const body=Buffer.from('data: {"text":"합성"}\n\ndata: [DONE]\n\n'),out=outputFixture();
  const fake=fakeRequest(({callback})=>{const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'text/event-stream'};callback(res);res.write(body.subarray(0,12));res.end(body.subarray(12));});
  await relayRemoteRequest({method:'POST',path:'/v1/chat/completions',body:{messages:['합성'],stream:true}},{requestImpl:fake.requestImpl,output:out.output});
  assert.equal(fake.options.host,'127.0.0.1');assert.equal(fake.options.port,8096);assert.equal(fake.options.path,'/v1/chat/completions');assert.equal(fake.options.headers['Content-Length'],Buffer.byteLength(fake.body));
  const raw=out.bytes(),newline=raw.indexOf(10);assert.deepEqual(JSON.parse(raw.subarray(0,newline)),{status:200,contentType:'text/event-stream'});assert.deepEqual(raw.subarray(newline+1),body);assert.equal(fake.timeoutMs,240000);
});

test('remote request failure and output closure settle once and destroy ongoing request',async()=>{
  const failed=fakeRequest(({req})=>req.emit('error',new Error('model unavailable'))),out=outputFixture();
  await assert.rejects(relayRemoteRequest({method:'GET',path:'/health',body:null},{requestImpl:failed.requestImpl,output:out.output}),/model unavailable/);assert.equal(failed.req.destroyed,true);
  const disconnected=fakeRequest(({callback})=>{const res=new PassThrough();res.statusCode=200;res.headers={};callback(res);out.output.destroy();});
  await assert.rejects(relayRemoteRequest({method:'GET',path:'/health',body:null},{requestImpl:disconnected.requestImpl,output:out.output}),/output closed/);assert.equal(disconnected.req.destroyed,true);
});
