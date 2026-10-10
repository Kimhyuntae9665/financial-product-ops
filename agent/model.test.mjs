import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {localModelArguments} from './model.mjs';

const value=(args,flag)=>args[args.indexOf(flag)+1];
test('default local model arguments match CPU/8192 start settings and retain fixed model endpoint',()=>{
  const args=localModelArguments({model:'C:/verified/model.gguf'});
  assert.equal(value(args,'-ngl'),'0');assert.equal(value(args,'-c'),'8192');assert.equal(value(args,'-m'),'C:/verified/model.gguf');
  assert.equal(value(args,'--host'),'127.0.0.1');assert.equal(value(args,'--port'),'8090');assert.equal(value(args,'--alias'),'finance-qwen');assert.equal(value(args,'-np'),'1');assert.deepEqual(JSON.parse(value(args,'--chat-template-kwargs')),{enable_thinking:false});
});
test('environment Vulkan/context selection changes only requested compute and context arguments',()=>{
  const cpu=localModelArguments({model:'verified-model',env:{FINANCE_MODEL_BACKEND:'CPU',FINANCE_MODEL_CONTEXT:'8192'}});
  const gpu=localModelArguments({model:'verified-model',env:{FINANCE_MODEL_BACKEND:'Vulkan',FINANCE_MODEL_CONTEXT:'4096'}});
  assert.equal(value(gpu,'-ngl'),'99');assert.equal(value(gpu,'-c'),'4096');
  const stable=args=>args.filter((_,index)=>index!==args.indexOf('-ngl')+1&&index!==args.indexOf('-c')+1);
  assert.deepEqual(stable(cpu),stable(gpu));assert.equal(value(localModelArguments({model:'verified-model',env:{FINANCE_MODEL_BACKEND:'cpu',FINANCE_MODEL_CONTEXT:'4096'}}),'-ngl'),'0');
});
test('unsupported backend and context values fail before any execution',()=>{
  for(const FINANCE_MODEL_BACKEND of ['CUDA','automatic','99'])assert.throws(()=>localModelArguments({model:'verified-model',env:{FINANCE_MODEL_BACKEND}}),/CPU or Vulkan/);
  for(const FINANCE_MODEL_CONTEXT of ['2048','4097','16384','NaN'])assert.throws(()=>localModelArguments({model:'verified-model',env:{FINANCE_MODEL_CONTEXT}}),/4096 or 8192/);
});
test('importing local model module performs no model request or process startup',t=>{
  const folder=mkdtempSync(join(tmpdir(),'finance-model-import-test-'));
  t.after(()=>{assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep));rmSync(folder,{recursive:true,force:true});});
  const moduleUrl=new URL('./model.mjs',import.meta.url).href;
  const script=`globalThis.fetch=async()=>{throw new Error('Unexpected import-time model request');}; await import(${JSON.stringify(moduleUrl)}); console.log('import-only');`;
  const result=execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,FINANCE_RUNTIME_DIR:join(folder,'absent-runtime')},windowsHide:true,encoding:'utf8',timeout:3000});
  assert.equal(result.trim(),'import-only');
});
