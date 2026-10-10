import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FinanceDomain} from './domain.mjs';
import {createRunner,runtime} from './runner.mjs';
const here=dirname(fileURLToPath(import.meta.url));
export function makeAgentServer({dbPath=resolve(runtime,'finance-agent.sqlite'),domain=new FinanceDomain({dbPath}),runner,token=randomBytes(32).toString('hex')}={}){
  runner ||= createRunner(token);
  const origin='http://127.0.0.1:4330';
  let modelHealth={at:0,connected:false},healthPending=null;
  async function checkModel(){
    if(Date.now()-modelHealth.at<5000)return modelHealth.connected;
    healthPending ||= fetch('http://127.0.0.1:8090/health',{signal:AbortSignal.timeout(5000)}).then(r=>r.ok).catch(()=>false).then(connected=>{modelHealth={at:Date.now(),connected};healthPending=null;return connected;});
    return healthPending;
  }
  const server=createServer(async(req,res)=>{
    const json=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    try{
      if(req.headers.host!=='127.0.0.1:4330')return json({error:'Invalid host'},403);
      const url=new URL(req.url,origin);
      if(req.method==='GET'&&url.pathname.startsWith('/source/')){
        const id=url.pathname.slice(8);if(!['partner','competitor'].includes(id))return json({error:'Unknown source'},404);
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});return res.end(domain.demoNotice(id));
      }
      if(req.method==='GET'&&url.pathname==='/api/state'){
        const connected=await checkModel();
        return json({domain:{...domain.state(),demoNotices:{partner:domain.demoNotice('partner'),competitor:domain.demoNotice('competitor')}},runs:runner.runs,busy:runner.busy,model:{name:process.env.FINANCE_MODEL_NAME||'Qwen3-1.7B Q4_K_M',endpoint:'127.0.0.1:8090',connected,compute:process.env.FINANCE_MODEL_COMPUTE||'this-pc',backend:process.env.FINANCE_MODEL_BACKEND||'CPU'}});
      }
      if(req.method==='POST'){
        if(!req.headers['content-type']?.startsWith('application/json'))return json({error:'JSON required'},415);
        const tool=url.pathname==='/api/tool';
        let lease;
        if(tool){try{lease=runner.permitTool(req.headers.authorization);}catch(error){return json({error:error.message},403);}}
        else if(req.headers['x-finance-client']!=='local-demo'||(req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site')return json({error:'Local same-origin client required'},403);
        let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16000)return json({error:'Request too large'},413);}
        const body=JSON.parse(raw);
        if(tool){
          try{runner.verifyTool?.(lease,body.name,body.args);}catch(error){return json({error:error.message},403);}
          if(body.name==='finance_propose'&&lease?.task){
            const archive=domain.state().archives.find(item=>item.id===body.args?.archiveId);
            const expectedSource=lease.task==='partner'?'partner':lease.task==='competitor'?'competitor':null;
            if(!archive||archive.sourceId!==expectedSource)return json({error:'Proposal archive must belong to the selected task source'},403);
          }
          runner.beginTool?.(lease,body.name,body.args);
          try{const result=await domain.execute(body.name,body.args);runner.recordTool?.(result,body.name,body.args,lease);return json(result);}
          finally{runner.endTool?.(lease);}
        }
        if(url.pathname==='/api/run')return json(runner.run(body.task,body.proposalId),202);
        if(runner.busy)return json({error:'Agent 실행이 끝난 후 수정하세요.'},409);
        if(url.pathname==='/api/decision')return json(domain.decide(body.proposalId,body.decision));
        if(url.pathname==='/api/notice')return json(domain.setDemoNotice(body.text,{sourceId:body.sourceId||'partner'}));
        if(url.pathname==='/api/reset')return json(domain.reset());
        return json({error:'Unknown route'},404);
      }
      const files={'/':'index.html','/console.css':'console.css','/console.mjs':'console.mjs'};
      if(req.method!=='GET'||!files[url.pathname])return json({error:'Not found'},404);
      const name=files[url.pathname];res.writeHead(200,{'Content-Type':name.endsWith('.css')?'text/css':name.endsWith('.mjs')?'text/javascript':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"});res.end(readFileSync(resolve(here,name)));
    }catch(error){json({error:error.message},error.status||400);}
  });
  return {server,domain,runner};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {server}=makeAgentServer();server.listen(4330,'127.0.0.1',()=>console.log('Finance Agent console http://127.0.0.1:4330/'));
}
