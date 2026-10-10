// Fixed model-only transport. No command, URL or host is accepted from stdin.
import {request} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export async function readRemoteInput(input,maxBytes=2*1024*1024){
  const chunks=[];let bytes=0;
  for await(const chunk of input){const buffer=Buffer.from(chunk);bytes+=buffer.length;if(bytes>maxBytes)throw new Error('Request budget exceeded');chunks.push(buffer);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function relayRemoteRequest(input,{requestImpl=request,output=process.stdout,timeoutMs=240000}={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['method','path','body'].includes(key)))throw new Error('Model endpoint not allowed');
  const get=['/health','/v1/models'].includes(input.path)&&input.method==='GET'&&(input.body==null);
  const post=input.path==='/v1/chat/completions'&&input.method==='POST'&&input.body&&typeof input.body==='object'&&!Array.isArray(input.body);
  if(!get&&!post)throw new Error('Model endpoint not allowed');
  const body=post?JSON.stringify(input.body):null;
  await new Promise((done,reject)=>{
    let settled=false,response;
    const settle=error=>{
      if(settled)return;settled=true;output.off('error',onOutputError);output.off('close',onOutputClose);output.off('drain',onDrain);
      if(error){req.destroy();response?.destroy();reject(error);}else done();
    };
    const onOutputError=error=>settle(error),onOutputClose=()=>settle(new Error('Model transport output closed'));
    const onDrain=()=>response?.resume();
    const req=requestImpl({host:'127.0.0.1',port:8096,path:input.path,method:input.method,headers:body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{}},res=>{
      response=res;
      output.write(JSON.stringify({status:res.statusCode,contentType:res.headers['content-type']||'application/json'})+'\n');
      res.on('data',chunk=>{if(!settled&&!output.write(chunk))res.pause();});
      res.on('end',()=>settle());res.on('error',settle);res.on('aborted',()=>settle(new Error('Remote model response aborted')));
    });
    output.on('error',onOutputError);output.on('close',onOutputClose);output.on('drain',onDrain);
    req.setTimeout(timeoutMs,()=>req.destroy(new Error('Remote model response timeout')));req.on('error',settle);req.end(body);
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await relayRemoteRequest(await readRemoteInput(process.stdin));
