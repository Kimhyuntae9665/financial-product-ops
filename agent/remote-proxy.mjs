import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function remoteSshArgs({host,user,key,knownHosts,job}){
  if(!host||!user||!key||!knownHosts||!job)throw new Error('Usage: node remote-proxy.mjs HOST USER KEY_PATH KNOWN_HOSTS_PATH REMOTE_JOB_PATH');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host)||!/^[a-zA-Z]:\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(job))throw new Error('Invalid host or fixed remote job path');
  if(typeof user!=='string'||/[\r\n\0]/.test(user))throw new Error('Invalid SSH user');
  return ['-i',resolve(key),'-o','BatchMode=yes','-o','ConnectTimeout=5','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${resolve(knownHosts).replaceAll('\\','/')}`,'-l',user,host,`node ${job}/remote-request.mjs`];
}
export function makeRemoteProxy({host,user,key,knownHosts,job,spawnImpl=spawn,timeoutMs=245000,maxRequestBytes=2*1024*1024,maxMetadataBytes=4096}={}){
  const sshArgs=remoteSshArgs({host,user,key,knownHosts,job});
  return createServer(async(req,res)=>{
    const reject=(status,message)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:message}));}};
    try{
      if(req.headers.host!=='127.0.0.1:8090')return reject(403,'Invalid host');
      const read=req.method==='GET'&&['/health','/v1/models'].includes(req.url);
      const infer=req.method==='POST'&&req.url==='/v1/chat/completions'&&req.headers.authorization==='Bearer local-only';
      if(!read&&!infer)return reject(403,'Model-only route required');
      const chunks=[];let bytes=0;
      for await(const chunk of req.iterator({destroyOnReturn:false})){bytes+=chunk.length;if(bytes>maxRequestBytes){req.resume();return reject(413,'Request too large');}chunks.push(chunk);}
      const body=infer?JSON.parse(Buffer.concat(chunks).toString('utf8')):null;
      if(infer&&(!body||typeof body!=='object'||Array.isArray(body)))return reject(400,'Model request must be a JSON object');
      if(res.destroyed||req.aborted)return;
      let child;try{child=spawnImpl('ssh.exe',sshArgs,{windowsHide:true,stdio:['pipe','pipe','pipe']});}catch{return reject(502,'SSH model transport unavailable');}
      let header=Buffer.alloc(0),ready=false,stderr='',settled=false;
      const kill=()=>{if(child.exitCode==null)child.kill();};
      const finish=(error,status=502)=>{
        if(settled)return;settled=true;clearTimeout(timeout);
        if(error){kill();if(res.headersSent){res.destroy(new Error(error));}else reject(status,error);}
        else if(!res.destroyed&&!res.writableEnded)res.end();
      };
      const timeout=setTimeout(()=>finish('Remote model transport timeout',504),timeoutMs);
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-1000);});
      const write=chunk=>{if(chunk.length&&!res.write(chunk))child.stdout.pause();};
      res.on('drain',()=>child.stdout.resume());
      child.stdout.on('data',chunk=>{
        if(settled)return;
        if(ready){write(chunk);return;}
        header=Buffer.concat([header,chunk]);const newline=header.indexOf(10);
        if(newline<0){if(header.length>maxMetadataBytes)finish('Remote metadata exceeds limit');return;}
        if(newline>maxMetadataBytes){finish('Remote metadata exceeds limit');return;}
        try{
          const meta=JSON.parse(header.subarray(0,newline).toString('utf8'));
          if(!meta||!Number.isInteger(meta.status)||meta.status<200||meta.status>599||typeof meta.contentType!=='string'||!meta.contentType||meta.contentType.length>200||/[^\x20-\x7e]/.test(meta.contentType))throw new Error('Invalid metadata');
          res.writeHead(meta.status,{'Content-Type':meta.contentType,'Cache-Control':'no-store'});ready=true;write(header.subarray(newline+1));header=Buffer.alloc(0);
        }catch{finish('Invalid remote model metadata');}
      });
      child.stdout.on('error',()=>finish('Remote model response stream failed'));
      child.on('error',()=>finish('SSH model transport unavailable'));
      child.on('close',code=>{
        if(settled)return;
        if(!ready||code!==0)finish(`Remote model transport failed (${code})${stderr.trim()?`: ${stderr.trim()}`:''}`);
        else finish();
      });
      const abort=()=>{if(!settled){settled=true;clearTimeout(timeout);kill();}};
      res.on('close',abort);res.on('error',abort);
      child.stdin.on('error',()=>finish('SSH model request stream failed'));
      try{child.stdin.end(JSON.stringify({method:req.method,path:req.url,body}));}catch{finish('SSH model request stream failed');}
    }catch(error){reject(400,error.message);}
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [host,user,key,knownHosts,job]=process.argv.slice(2);
  makeRemoteProxy({host,user,key,knownHosts,job}).listen(8090,'127.0.0.1',()=>console.log('SSH model relay http://127.0.0.1:8090/ -> remote loopback 8096'));
}
