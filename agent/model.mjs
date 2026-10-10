import {spawn} from 'node:child_process';
import {openSync,writeFileSync,existsSync,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtime} from './paths.mjs';
const root=resolve(runtime,'..');
const server=resolve(root,'llama-runtime/b11429/llama-server.exe');
const model=resolve(root,'llm-models/Qwen3-1.7B-Q4_K_M.gguf');
const pidFile=resolve(runtime,'model.pid');
async function verify(path,expected){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);if(hash.digest('hex')!==expected)throw new Error(`SHA256 mismatch or incomplete download: ${path}`);}
export function localModelArguments({model,env={}}){
  const backend=String(env.FINANCE_MODEL_BACKEND||'CPU').toLowerCase(),context=Number(env.FINANCE_MODEL_CONTEXT||8192);
  if(!['cpu','vulkan'].includes(backend))throw new Error('FINANCE_MODEL_BACKEND must be CPU or Vulkan');
  if(![4096,8192].includes(context))throw new Error('FINANCE_MODEL_CONTEXT must be 4096 or 8192');
  return ['-m',model,'--host','127.0.0.1','--port','8090','--alias','finance-qwen','-c',String(context),'-np','1','-ngl',backend==='vulkan'?'99':'0','-t','6','--jinja','--chat-template-kwargs',JSON.stringify({enable_thinking:false}),'-ctk','q8_0','-ctv','q8_0','-fa','on'];
}
export async function startLocalModel({env=process.env}={}){
  const args=localModelArguments({model,env});
  if(await fetch('http://127.0.0.1:8090/v1/models',{signal:AbortSignal.timeout(1000)}).then(async r=>r.ok&&(await r.json()).data.some(m=>m.id==='finance-qwen')).catch(()=>false)){
    console.log('finance-qwen already listening at 8090');return;
  }
  if(!existsSync(server)||!existsSync(model))throw new Error('Install verified llama.cpp b11429 and Qwen3-1.7B GGUF first. See README.');
  await verify(model,'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897');
  await verify(resolve(root,'llama-runtime/llama-b11429-bin-win-vulkan-x64.zip'),'1bfe78ad9168b79fa02bf67f6af9f5e17a966d824d77238517f7bef12ac73b36');
  const child=spawn(server,args,{
    cwd:resolve(root,'llama-runtime/b11429'),windowsHide:true,detached:true,stdio:['ignore',openSync(resolve(runtime,'model.out.log'),'a'),openSync(resolve(runtime,'model.err.log'),'a')],
  });
  writeFileSync(pidFile,String(child.pid));child.unref();console.log(`Started local Qwen3-1.7B model PID ${child.pid}; startup may take 30s.`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await startLocalModel();
