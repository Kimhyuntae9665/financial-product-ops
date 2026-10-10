import {createReadStream,existsSync,mkdirSync,openSync,closeSync,writeFileSync,readFileSync,renameSync,unlinkSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {freemem,hostname} from 'node:os';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';

const validPort=port=>{if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid bounded port');};
const validGpuLayers=gpuLayers=>{if(!Number.isInteger(gpuLayers)||gpuLayers<0||gpuLayers>99)throw new Error('Invalid bounded GPU layer count (0..99)');};
export function assertModelMemory(ctxSize=8192,freeBytes=freemem()){
  if(![4096,8192].includes(ctxSize))throw new Error('Context size must be 4096 or 8192');
  const minFreeRamGiB=ctxSize===4096?4.5:5;
  if(!Number.isFinite(freeBytes)||freeBytes<minFreeRamGiB*1024**3)throw new Error(`Need at least ${minFreeRamGiB} GiB free RAM for context ${ctxSize}`);
  return {ctxSize,minFreeRamGiB,freeRamGiB:freeBytes/1024**3};
}
const pidAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const delay=ms=>new Promise(done=>setTimeout(done,ms));
function canonicalPids(job){
  const pids=[];
  try{const value=readFileSync(resolve(job,'model.pid'),'utf8').trim();if(/^[1-9]\d*$/.test(value))pids.push(Number(value));}catch{}
  try{pids.push(JSON.parse(readFileSync(resolve(job,'execution.json'),'utf8')).pid);}catch{}
  return [...new Set(pids.filter(pid=>Number.isSafeInteger(pid)&&pid>0))];
}
export async function assertModelStartAllowed({job,port,isPidAlive=pidAlive}){
  validPort(port);
  for(const pid of canonicalPids(job))if(isPidAlive(pid))throw new Error(`Existing job model PID ${pid} is still running; canonical records preserved`);
  const probe=createServer();
  await new Promise((done,reject)=>{
    probe.once('error',error=>reject(new Error(`Loopback port ${port} is unavailable (${error.code}); canonical records preserved`)));
    probe.listen({host:'127.0.0.1',port,exclusive:true},()=>probe.close(done));
  });
}
export function loopbackOwnerPid(port,{execFileSyncImpl=execFileSync}={}){
  validPort(port);
  const command=`$ErrorActionPreference='Stop'; $listener=Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($listener) { $listener | Select-Object -ExpandProperty OwningProcess }; exit 0`;
  const raw=execFileSyncImpl('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,encoding:'utf8',timeout:5000,maxBuffer:10000}).trim();
  if(!raw)return null;
  const values=[...new Set(raw.split(/\r?\n/).map(line=>line.trim()))];
  if(values.length!==1||! /^[1-9]\d*$/.test(values[0])||!Number.isSafeInteger(Number(values[0])))throw new Error('Cannot prove unique loopback listener ownership');
  return Number(values[0]);
}
export async function waitForOwnedModel(child,{port,fetchImpl=fetch,ownerPidImpl=loopbackOwnerPid,timeoutMs=180000,pollMs=500}={}){
  validPort(port);let spawnError;const onError=error=>{spawnError=error;};child.on('error',onError);
  const deadline=Date.now()+timeoutMs;
  try{
    while(Date.now()<deadline){
      if(spawnError)throw spawnError;
      if(child.exitCode!=null||child.signalCode)throw new Error('Model exited before readiness');
      if(!Number.isSafeInteger(child.pid)||child.pid<1){await delay(pollMs);continue;}
      const owner=ownerPidImpl(port);
      if(owner!=null&&owner!==child.pid)throw new Error(`Loopback port ${port} belongs to another PID ${owner}`);
      if(owner===child.pid){
        let healthy=false;try{healthy=(await fetchImpl(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(3000)})).ok;}catch{}
        if(spawnError)throw spawnError;
        if(healthy&&child.exitCode==null&&!child.signalCode&&ownerPidImpl(port)===child.pid)return;
      }
      await delay(Math.min(pollMs,Math.max(1,deadline-Date.now())));
    }
    throw new Error('Model did not become healthy with proven loopback ownership');
  }finally{child.off('error',onError);}
}
export function publishModelRecord(job,record,{renameImpl=renameSync}={}){
  const targets=[resolve(job,'execution.json'),resolve(job,'model.pid')];
  const previous=targets.map(path=>existsSync(path)?readFileSync(path):null);
  const temporary=targets.map(path=>`${path}.${record.attemptId}.tmp`);
  let moved=0;
  try{
    writeFileSync(temporary[0],JSON.stringify(record,null,2));writeFileSync(temporary[1],String(record.pid));
    for(let index=0;index<targets.length;index++){renameImpl(temporary[index],targets[index]);moved++;}
  }catch(error){
    // Restore only files replaced by this publication; readiness failures never reach here.
    for(let index=0;index<moved;index++){if(previous[index]===null)unlinkSync(targets[index]);else writeFileSync(targets[index],previous[index]);}
    throw error;
  }finally{for(const path of temporary)if(existsSync(path))unlinkSync(path);}
}
export async function launchOwnedModel({job,port,threads,gpuLayers=0,ctxSize=8192,model,modelHash,exe,args,spawnImpl=spawn,fetchImpl=fetch,ownerPidImpl=loopbackOwnerPid,isPidAlive=pidAlive,freeMemImpl=freemem,timeoutMs=180000,pollMs=500}){
  validGpuLayers(gpuLayers);
  const memory=assertModelMemory(ctxSize,freeMemImpl());
  await assertModelStartAllowed({job,port,isPidAlive});
  const attemptId=randomUUID(),attemptPath=resolve(job,`model-attempt-${attemptId}.json`);
  const record={attemptId,host:hostname(),job,model,modelHash,backend:gpuLayers>0?'Vulkan':'CPU',gpuLayers,threads,port,bind:'127.0.0.1',startedAt:new Date().toISOString(),...memory,args};
  const out=openSync(resolve(job,'model.stdout.log'),'a'),err=openSync(resolve(job,'model.stderr.log'),'a');
  let child,published=false,closed=false;
  try{
    child=spawnImpl(exe,args,{windowsHide:true,stdio:['ignore',out,err]});record.pid=child.pid;
    // Keep an error listener for the entire child lifetime, including after readiness.
    child.on('error',error=>{record.processError=error.message;});
    const exited=new Promise(done=>child.once('close',code=>{
      closed=true;closeSync(out);closeSync(err);const exitCode=code??1;
      writeFileSync(resolve(job,`model-attempt-${attemptId}.exit-code.txt`),String(exitCode));
      if(published&&canonicalPids(job).includes(child.pid))writeFileSync(resolve(job,'model.exit-code.txt'),String(exitCode));
      done(exitCode);
    }));
    await waitForOwnedModel(child,{port,fetchImpl,ownerPidImpl,timeoutMs,pollMs});
    record.readyAt=new Date().toISOString();record.status='ready';
    writeFileSync(attemptPath,JSON.stringify(record,null,2));
    publishModelRecord(job,record);published=true;
    return {child,record,exited};
  }catch(error){
    if(child&&!closed&&child.exitCode==null)child.kill();
    if(!child){closeSync(out);closeSync(err);}
    writeFileSync(attemptPath,JSON.stringify({...record,status:'failed',failedAt:new Date().toISOString(),error:error.message},null,2));throw error;
  }
}
async function sha256(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export function modelArguments({model,port,threads,gpuLayers=0,ctxSize=8192}){
  validPort(port);validGpuLayers(gpuLayers);if(!Number.isInteger(threads)||threads<1||threads>6)throw new Error('Invalid bounded thread count');
  if(![4096,8192].includes(ctxSize))throw new Error('Context size must be 4096 or 8192');
  return ['--model',model,'--host','127.0.0.1','--port',String(port),'--alias','finance-qwen','--ctx-size',String(ctxSize),'--parallel','1','--n-gpu-layers',String(gpuLayers),'--threads',String(threads),'--jinja','--chat-template-kwargs',JSON.stringify({enable_thinking:false}),'--cache-type-k','q8_0','--cache-type-v','q8_0','--flash-attn','on'];
}
export async function runRemoteModel({job,port=8096,threads=4,gpuLayers=0,ctxSize=8192}={}){
  job=resolve(job||'C:/CodexResourceShare/jobs/finance-agent-20261010');
  validPort(port);validGpuLayers(gpuLayers);if(!Number.isInteger(threads)||threads<1||threads>6)throw new Error('Invalid bounded thread count');
  assertModelMemory(ctxSize);
  await assertModelStartAllowed({job,port});
  const model=resolve(job,'Qwen3-4B-Q4_K_M.gguf'),archive=resolve(job,'llama-b11429-bin-win-vulkan-x64.zip');
  const modelHash=await sha256(model);
  if(modelHash!=='7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5')throw new Error('Model SHA256 mismatch');
  if(await sha256(archive)!=='1bfe78ad9168b79fa02bf67f6af9f5e17a966d824d77238517f7bef12ac73b36')throw new Error('Runtime SHA256 mismatch');
  const bin=resolve(job,'llama-b11429'),exe=resolve(bin,'llama-server.exe');
  const psLiteral=value=>`'${value.replaceAll("'","''")}'`;
  if(!existsSync(exe)){mkdirSync(bin,{recursive:true});execFileSync('powershell.exe',['-NoProfile','-Command',`Expand-Archive -LiteralPath ${psLiteral(archive)} -DestinationPath ${psLiteral(bin)}`],{windowsHide:true});}
  assertModelMemory(ctxSize);
  const args=modelArguments({model,port,threads,gpuLayers,ctxSize});
  const started=await launchOwnedModel({job,port,threads,gpuLayers,ctxSize,model,modelHash,exe,args});
  console.log(`Verified Qwen3-4B ${started.record.backend} model on ${hostname()}, PID ${started.child.pid}, loopback port ${port}`);
  return await started.exited;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runRemoteModel({job:process.argv[2],port:Number(process.argv[3]||8096),threads:Number(process.argv[4]||4),gpuLayers:Number(process.argv[5]||0),ctxSize:Number(process.argv[6]||8192)});
