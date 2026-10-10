import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {assertModelStartAllowed,loopbackOwnerPid,waitForOwnedModel,launchOwnedModel,publishModelRecord,modelArguments,assertModelMemory} from './remote-model.mjs';

function jobFixture(t){
  const job=mkdtempSync(join(tmpdir(),'finance-model-start-test-'));
  t.after(()=>{assert.ok(resolve(job).startsWith(resolve(tmpdir())+sep));rmSync(job,{recursive:true,force:true});});
  const execution=JSON.stringify({pid:999999,job,status:'ready',legacy:'preserve byte for byte'}),pid='999999',exit='0';
  writeFileSync(join(job,'execution.json'),execution);writeFileSync(join(job,'model.pid'),pid);writeFileSync(join(job,'model.exit-code.txt'),exit);
  return {job,execution,pid,exit};
}
async function availablePort(){const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;await new Promise(done=>server.close(done));return port;}
function fakeChild(pid=543210){
  const child=new EventEmitter();child.pid=pid;child.exitCode=null;child.signalCode=null;child.kills=0;
  child.kill=()=>{child.kills++;child.exitCode=1;queueMicrotask(()=>child.emit('close',1));return true;};
  child.complete=code=>{child.exitCode=code;child.emit('close',code);};return child;
}
const preserved=f=>{
  assert.equal(readFileSync(join(f.job,'execution.json'),'utf8'),f.execution);
  assert.equal(readFileSync(join(f.job,'model.pid'),'utf8'),f.pid);
  assert.equal(readFileSync(join(f.job,'model.exit-code.txt'),'utf8'),f.exit);
};
const launchOptions=(f,child,port)=>({job:f.job,port,threads:4,model:'synthetic-test-model',modelHash:'verified-test-hash',exe:'never-actually-executed',args:[],spawnImpl:()=>child,isPidAlive:()=>false,freeMemImpl:()=>6*1024**3,fetchImpl:async()=>({ok:true}),ownerPidImpl:()=>child.pid,pollMs:1,timeoutMs:50});

test('occupied loopback port rejects duplicate launch before spawn or metadata/log writes',async t=>{
  const f=jobFixture(t),server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>server.close(done)));
  let spawned=0;const child=fakeChild(),before=readdirSync(f.job).sort();
  await assert.rejects(launchOwnedModel({...launchOptions(f,child,server.address().port),spawnImpl:()=>{spawned++;return child;}}),/port .*unavailable/);
  assert.equal(spawned,0);assert.deepEqual(readdirSync(f.job).sort(),before);preserved(f);
});

test('a live canonical own-job PID rejects restart even while its port is not listening',async t=>{
  const f=jobFixture(t);writeFileSync(join(f.job,'model.pid'),String(process.pid));
  await assert.rejects(assertModelStartAllowed({job:f.job,port:await availablePort()}),/still running/);
  assert.equal(readFileSync(join(f.job,'execution.json'),'utf8'),f.execution);assert.equal(readFileSync(join(f.job,'model.pid'),'utf8'),String(process.pid));
});

test('validated Windows ownership query has a fixed address and safely bounded numeric port',()=>{
  let calls=0;
  const execFileSyncImpl=(file,args,options)=>{calls++;assert.equal(file,'powershell.exe');assert.ok(args.includes('-NoProfile'));assert.match(args.at(-1),/LocalAddress '127\.0\.0\.1' -LocalPort 8096 -State Listen/);assert.equal(options.windowsHide,true);return '30144\r\n';};
  assert.equal(loopbackOwnerPid(8096,{execFileSyncImpl}),30144);
  for(const port of ['8096;whoami',0,65536,8096.1])assert.throws(()=>loopbackOwnerPid(port,{execFileSyncImpl}),/bounded port/);
  assert.equal(calls,1);assert.equal(loopbackOwnerPid(8096,{execFileSyncImpl:()=>''}),null);
  assert.throws(()=>loopbackOwnerPid(8096,{execFileSyncImpl:()=> '30144\n30145'}),/unique loopback/);
});

test('healthy endpoint owned by another PID cannot publish the newly spawned model',async t=>{
  const f=jobFixture(t),child=fakeChild();
  await assert.rejects(launchOwnedModel({...launchOptions(f,child,await availablePort()),ownerPidImpl:()=>777777}),/another PID/);
  preserved(f);assert.equal(child.kills,1);
  const attempts=readdirSync(f.job).filter(name=>/^model-attempt-.*\.json$/.test(name));assert.equal(attempts.length,1);assert.equal(JSON.parse(readFileSync(join(f.job,attempts[0]))).status,'failed');
});

test('failed health check keeps prior canonical metadata and exit code intact',async t=>{
  const f=jobFixture(t),child=fakeChild();
  await assert.rejects(launchOwnedModel({...launchOptions(f,child,await availablePort()),fetchImpl:async()=>({ok:false}),timeoutMs:10}),/did not become healthy/);
  preserved(f);assert.equal(child.kills,1);assert.ok(readdirSync(f.job).some(name=>name.endsWith('.exit-code.txt')&&name.startsWith('model-attempt-')));
});

test('canonical records remain unchanged during readiness and publish only after healthy ownership',async t=>{
  const f=jobFixture(t),child=fakeChild(),port=await availablePort();let healthy;
  const fetchStarted=new Promise(done=>{healthy=done;});let releaseHealth;
  const health=new Promise(done=>{releaseHealth=done;});
  const startedPromise=launchOwnedModel({...launchOptions(f,child,port),fetchImpl:async url=>{assert.equal(url,`http://127.0.0.1:${port}/health`);healthy();return health;}});
  await fetchStarted;preserved(f);releaseHealth({ok:true});const started=await startedPromise;
  assert.equal(readFileSync(join(f.job,'model.pid'),'utf8'),String(child.pid));const record=JSON.parse(readFileSync(join(f.job,'execution.json'),'utf8'));
  assert.equal(record.status,'ready');assert.equal(record.pid,child.pid);assert.equal(record.bind,'127.0.0.1');assert.ok(record.readyAt);assert.equal(child.kills,0);
  assert.equal(record.backend,'CPU');assert.equal(record.gpuLayers,0);
  assert.equal(record.ctxSize,8192);assert.equal(record.minFreeRamGiB,5);
  child.complete(0);assert.equal(await started.exited,0);assert.equal(readFileSync(join(f.job,'model.exit-code.txt'),'utf8'),'0');
});

test('owner must still match after health response; early child exit fails readiness',async()=>{
  const child=fakeChild();let calls=0;
  await assert.rejects(waitForOwnedModel(child,{port:8096,ownerPidImpl:()=>++calls===1?child.pid:777777,fetchImpl:async()=>({ok:true}),timeoutMs:30,pollMs:1}),/another PID/);
  child.exitCode=1;await assert.rejects(waitForOwnedModel(child,{port:8096,ownerPidImpl:()=>child.pid,fetchImpl:async()=>({ok:true}),timeoutMs:30,pollMs:1}),/exited before readiness/);
});

test('synchronous spawn failure never overwrites previous canonical records',async t=>{
  const f=jobFixture(t),child=fakeChild();
  await assert.rejects(launchOwnedModel({...launchOptions(f,child,await availablePort()),spawnImpl:()=>{throw new Error('spawn unavailable');}}),/spawn unavailable/);preserved(f);
});

test('partial canonical publication restores previous records if the second rename fails',t=>{
  const f=jobFixture(t);let moves=0;
  assert.throws(()=>publishModelRecord(f.job,{attemptId:'test-publication',pid:543210,status:'ready'},{renameImpl:(from,to)=>{if(++moves===2)throw new Error('simulated publication failure');renameSync(from,to);}}),/publication failure/);
  preserved(f);assert.equal(readdirSync(f.job).some(name=>name.endsWith('.tmp')),false);
});

test('model arguments default to CPU and accept explicitly bounded Vulkan offload',()=>{
  const options={model:'synthetic-test-model',port:8096,threads:4},cpu=modelArguments(options),gpu=modelArguments({...options,gpuLayers:99});
  assert.equal(cpu[cpu.indexOf('--n-gpu-layers')+1],'0');assert.equal(gpu[gpu.indexOf('--n-gpu-layers')+1],'99');
  assert.equal(cpu[cpu.indexOf('--host')+1],'127.0.0.1');assert.deepEqual(cpu.filter((_,index)=>index!==cpu.indexOf('--n-gpu-layers')+1),gpu.filter((_,index)=>index!==gpu.indexOf('--n-gpu-layers')+1));
  for(const gpuLayers of [-1,100,1.5,'99',NaN])assert.throws(()=>modelArguments({...options,gpuLayers}),/GPU layer count/);
});

test('explicit GPU layers are recorded with Vulkan backend after the same readiness gate',async t=>{
  const f=jobFixture(t),child=fakeChild(),port=await availablePort();let actualArgs;
  const args=modelArguments({model:'synthetic-test-model',port,threads:4,gpuLayers:99});
  const started=await launchOwnedModel({...launchOptions(f,child,port),gpuLayers:99,args,spawnImpl:(_exe,passed)=>{actualArgs=passed;return child;}});
  assert.equal(actualArgs[actualArgs.indexOf('--n-gpu-layers')+1],'99');assert.equal(started.record.backend,'Vulkan');assert.equal(started.record.gpuLayers,99);
  const persisted=JSON.parse(readFileSync(join(f.job,'execution.json'),'utf8'));assert.equal(persisted.backend,'Vulkan');assert.equal(persisted.gpuLayers,99);assert.ok(persisted.readyAt);
  child.complete(0);assert.equal(await started.exited,0);
});

test('context choices enforce exact conservative RAM boundaries and corresponding arguments',()=>{
  const options={model:'synthetic-test-model',port:8096,threads:4};
  assert.equal(assertModelMemory(4096,4.5*1024**3).minFreeRamGiB,4.5);assert.equal(assertModelMemory(8192,5*1024**3).minFreeRamGiB,5);
  assert.throws(()=>assertModelMemory(4096,4.5*1024**3-1),/4.5 GiB/);assert.throws(()=>assertModelMemory(8192,5*1024**3-1),/5 GiB/);
  assert.equal(assertModelMemory(4096,4.8*1024**3).ctxSize,4096);assert.throws(()=>assertModelMemory(8192,4.8*1024**3),/5 GiB/);
  for(const ctxSize of [0,2048,4095,4097,16384,'4096',NaN]){assert.throws(()=>assertModelMemory(ctxSize,6*1024**3),/4096 or 8192/);assert.throws(()=>modelArguments({...options,ctxSize}),/4096 or 8192/);}
  const args=modelArguments({...options,ctxSize:4096,gpuLayers:99});assert.equal(args[args.indexOf('--ctx-size')+1],'4096');assert.equal(args[args.indexOf('--n-gpu-layers')+1],'99');assert.equal(args.includes('--no-mmap'),false);assert.equal(args.includes('--load-mode'),false);
});

test('4096 context can launch at 4.8 GiB and records the chosen memory policy',async t=>{
  const f=jobFixture(t),child=fakeChild(),port=await availablePort();
  const args=modelArguments({model:'synthetic-test-model',port,threads:4,ctxSize:4096});
  const started=await launchOwnedModel({...launchOptions(f,child,port),args,ctxSize:4096,freeMemImpl:()=>4.8*1024**3});
  assert.equal(started.record.ctxSize,4096);assert.equal(started.record.minFreeRamGiB,4.5);assert.equal(started.record.freeRamGiB,4.8);assert.equal(started.record.args[started.record.args.indexOf('--ctx-size')+1],'4096');
  child.complete(0);assert.equal(await started.exited,0);
});

test('memory budget refusal occurs before spawn and leaves canonical records unchanged',async t=>{
  const f=jobFixture(t),child=fakeChild();let spawned=0;const before=readdirSync(f.job).sort();
  for(const [ctxSize,freeRamGiB] of [[8192,4.8],[4096,4.4]])await assert.rejects(launchOwnedModel({...launchOptions(f,child,await availablePort()),ctxSize,freeMemImpl:()=>freeRamGiB*1024**3,spawnImpl:()=>{spawned++;return child;}}),/Need at least/);
  assert.equal(spawned,0);assert.deepEqual(readdirSync(f.job).sort(),before);preserved(f);
});
