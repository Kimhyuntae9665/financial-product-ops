import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from './plugin/index.mjs';

test('actual plugin prompt hook narrows each task and rejects unknown authority',()=>{
  const previous=process.env.FINANCE_AGENT_TASK;
  try{
    let hook;const tools=[];
    plugin.register({on(name,handler){assert.equal(name,'before_prompt_build');hook=handler;},registerTool(tool){tools.push(tool);}});
    assert.equal(tools.length,6);
    process.env.FINANCE_AGENT_TASK='public';
    assert.deepEqual(hook().toolsAllow,['finance_fetch','finance_report']);
    assert.match(hook().systemPrompt,/untrusted evidence/);
    assert.match(hook().systemPrompt,/you cannot approve/);
    process.env.FINANCE_AGENT_TASK='apply';
    assert.deepEqual(hook().toolsAllow,['finance_apply','finance_report']);
    process.env.FINANCE_AGENT_TASK='unknown';
    assert.deepEqual(hook().toolsAllow,[]);
  }finally{if(previous===undefined)delete process.env.FINANCE_AGENT_TASK;else process.env.FINANCE_AGENT_TASK=previous;}
});
