import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {validateNoticeInterpretation} from './notice-ai.mjs';

const FIELDS=new Set(['productId','version','effectiveDate','rate','limit','reviewId','active','capturedAt','sourceHash']);
const CHANGE_FIELDS=['rate','limit','reviewId','active','capturedAt','sourceHash'];
const clone=value=>JSON.parse(JSON.stringify(value));
const digest=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export class OpsError extends Error {constructor(status,message,details={}){super(message);this.status=status;this.details=details;}}
const fail=(message,status=400,details)=>{throw new OpsError(status,message,details);};
const exact=(body,keys)=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!keys.includes(key)))fail('허용되지 않은 요청 필드입니다.');};
const bounded=(value,max=200)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f]/.test(value);
const numeric=raw=>/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)?Number(raw):NaN;

// This parser reads only the supplied source. It does not consult scenario truth,
// model output, or core.mjs; duplicate lines remain a validation failure.
export function parseSource(sourceText){
  const candidate={productId:null,version:null,effectiveDate:null,changes:{},evidence:[]};
  const errors=[],seen=new Set();
  if(typeof sourceText!=='string'||sourceText.length>8000||!sourceText.includes('합성 자료'))return {candidate,errors:['합성 자료 표기가 있는 8,000자 이하 원문이 필요합니다.']};
  for(const quote of sourceText.split(/\r?\n/)){
    if(!quote.includes('='))continue;
    const match=/^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(quote);
    if(!match){errors.push('key=value 원문 형식이 잘못되었습니다.');continue;}
    const [,field,raw]=match;
    if(!FIELDS.has(field)){errors.push(`${field}: 알 수 없는 필드입니다.`);continue;}
    if(seen.has(field)){errors.push(`${field}: 중복 또는 충돌하는 원문입니다.`);continue;}
    seen.add(field);
    const value=['version','rate','limit','capturedAt'].includes(field)?numeric(raw):field==='active'?raw==='true'?true:raw==='false'?false:null:raw;
    if(['productId','version','effectiveDate'].includes(field))candidate[field]=value;else candidate.changes[field]=value;
    candidate.evidence.push({field,quote});
  }
  if(!bounded(candidate.productId,60)||!/^P\d+$|^C\d+$/.test(candidate.productId))errors.push('상품 식별자를 확인하세요.');
  if(!Number.isSafeInteger(candidate.version)||candidate.version<1)errors.push('버전은 양의 정수여야 합니다.');
  const date=candidate.effectiveDate;
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)errors.push('적용일이 누락되었거나 YYYY-MM-DD 날짜가 잘못되었습니다.');
  const v=candidate.changes;
  if(!Object.keys(v).length)errors.push('변경 필드가 없습니다.');
  if('rate'in v&&(!Number.isFinite(v.rate)||v.rate<0||v.rate>30))errors.push('금리는 0~30 범위여야 합니다.');
  if('limit'in v&&(!Number.isSafeInteger(v.limit)||v.limit<0||v.limit>1000000000))errors.push('한도는 0~10억 원 정수여야 합니다.');
  if('reviewId'in v&&(typeof v.reviewId!=='string'||!/^DEMO-[A-Z0-9-]{3,60}$/.test(v.reviewId)))errors.push('합성 심의필 번호 형식이 잘못되었습니다.');
  if('active'in v&&typeof v.active!=='boolean')errors.push('판매 상태는 true/false여야 합니다.');
  if('capturedAt'in v&&(!Number.isFinite(v.capturedAt)||v.capturedAt<0))errors.push('수집 시각이 잘못되었습니다.');
  if('sourceHash'in v&&(typeof v.sourceHash!=='string'||!/^[-a-zA-Z0-9]{3,80}$/.test(v.sourceHash)))errors.push('출처 해시 형식이 잘못되었습니다.');
  // Require canonical exact evidence for every parsed value.
  for(const [field,value] of Object.entries({productId:candidate.productId,version:candidate.version,effectiveDate:candidate.effectiveDate,...v})){
    if(candidate.evidence.find(e=>e.field===field)?.quote!==`${field}=${value}`)errors.push(`${field}: 값과 원문 근거가 일치하지 않습니다.`);
  }
  return {candidate,errors};
}

export class OpsStore {
  constructor({path=':memory:',now=()=>new Date()}={}){
    this.now=now;if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY,notice_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,payload TEXT NOT NULL,result TEXT NOT NULL); CREATE TABLE IF NOT EXISTS automation(key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS integrations(id TEXT PRIMARY KEY,data TEXT NOT NULL);');
    if(!this.getMeta('epoch'))this.transaction(()=>this.seed());
  }
  close(){this.db.close();}
  at(){return this.now().toISOString();}
  today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(this.now());}
  id(prefix){return `${prefix}-${this.getMeta('epoch')}-${randomUUID()}`;}
  getMeta(key){const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);return row?JSON.parse(row.value):null;}
  setMeta(key,value){this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  rows(table){return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row=>JSON.parse(row.data));}
  get(table,id){const row=this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(row.data):null;}
  put(table,item){this.db.prepare(`INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(item.id,JSON.stringify(item));}
  putCase(item){this.db.prepare('INSERT INTO cases(id,notice_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(item.id,item.noticeId,JSON.stringify(item));}
  transaction(action){this.db.exec('BEGIN IMMEDIATE');try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  seed(){this.setMeta('epoch',randomUUID());this.setMeta('duplicateReceipts',0);for(let i=1;i<=3;i++)this.put('products',{id:`P${i}`,name:`합성 생활대출 ${i}`,bank:['가상한결은행','가상새봄은행','가상푸른은행'][i-1],rate:4.5+(i-1)*0.1,limit:50000000,reviewId:`DEMO-2026-${i}`,active:true,version:1,updatedAt:this.at()});}
  event(caseId,type,message){const item={id:this.id('event'),caseId,type,message,at:this.at()};this.put('events',item);return item;}
  ticket(item,reason){const existing=this.rows('tickets').find(t=>t.caseId===item.id&&t.status==='open');if(existing){existing.reason=reason;this.put('tickets',existing);return existing;}const ticket={id:this.id('ticket'),caseId:item.id,title:`${item.noticeId}: 확인 필요`,status:'open',owner:'demo-reviewer',dueAt:new Date(this.now().getTime()+86400000).toISOString(),reason,mode:'local',deliveryStatus:'local'};this.put('tickets',ticket);return ticket;}
  integration(id,status){const previous=this.get('integrations',id)||{};this.put('integrations',{...previous,id,...status});}
  requiredCase(id){const item=this.get('cases',id);if(!item)fail('사건을 찾을 수 없습니다.',404);return item;}
  validate(item){
    if(item.sourceChannel==='llm')return this.validateAI(item);
    const {candidate,errors}=parseSource(item.sourceText),product=this.get('products',candidate.productId);
    item.candidate=candidate;
    if(item.productId&&item.productId!==candidate.productId)errors.push('기존 사건의 상품 식별자는 바꿀 수 없습니다.');
    if(!item.productId&&candidate.productId)item.productId=candidate.productId;
    item.expectedProductVersion=product?.version??null;
    if(item.sourceType!=='competitor'){
      if(!product)errors.push('자사 합성 상품 DB에서 상품을 찾을 수 없습니다.');
      else if(candidate.version!==product.version+1)errors.push('현재 DB 다음 버전만 검토할 수 있습니다.');
    }
    item.status=errors.length?'held':item.sourceType==='competitor'?'research':candidate.effectiveDate>this.today()?'scheduled':'pending';
    item.reason=errors.length?errors.join(' '):item.status==='research'?'경쟁상품 조사 기록: 자사 DB 변경 대상이 아닙니다.':item.status==='scheduled'?'미래 적용일: 예약 기록만 만들고 DB 반영을 막았습니다.':'원문 근거·형식·범위를 검증했습니다. 담당자 승인이 필요합니다.';
    item.before=product?clone(product):null;item.after=null;
    item.updatedAt=this.at();item.completedAt=item.status==='pending'?null:this.at();
    item.steps=[{name:'source',status:'completed',at:item.receivedAt},{name:'extract',status:'completed',at:this.at()},{name:'validate',status:errors.length?'failed':'completed',at:this.at()},{name:'review',status:item.status==='pending'?'waiting':'skipped',at:this.at()}];
    return item;
  }
  validateAI(item){
    const snapshot=item.aiSnapshot,product=this.get('products',item.productId);
    if(!snapshot){item.status='held';item.reason='원문이 변경되어 이전 AI 해석이 무효입니다. 로컬 모델로 다시 분석하세요.';item.candidate=null;item.after=null;item.updatedAt=this.at();item.completedAt=this.at();return item;}
    const result=validateNoticeInterpretation(item.sourceText,snapshot.analysis,{productId:item.productId,nextVersion:snapshot.expectedProductVersion+1,today:this.today()});
    const bound=snapshot.sourceHash===digest(item.sourceText)&&snapshot.sourceRevision===item.sourceRevision&&snapshot.epoch===this.getMeta('epoch')&&snapshot.productId===item.productId&&snapshot.noticeId===item.noticeId&&snapshot.sourceType===item.sourceType&&snapshot.expectedProductVersion===product?.version&&same(snapshot.productSnapshot,product);
    result.checks.push({id:'snapshot',label:'원문·DB 스냅샷',status:bound?'passed':'failed',detail:bound?'서버가 저장한 원문 해시·리비전·현재 상품 DB가 일치합니다.':'원문 또는 상품 DB가 분석 시점과 달라 재분석해야 합니다.'});
    if(!bound)result.errors.push('원문 또는 상품 DB가 분석 시점과 달라 재분석해야 합니다.');
    item.candidate=result.candidate;item.expectedProductVersion=snapshot.expectedProductVersion;
    item.aiInterpretation={...clone(snapshot.analysis),model:snapshot.model,provider:snapshot.provider,elapsedMs:snapshot.elapsedMs,createdAt:snapshot.createdAt,checks:result.checks};
    item.status=result.errors.length?'held':item.sourceType==='competitor'?'research':result.future?'scheduled':'pending';
    item.reason=result.errors.length?result.errors.join(' '):item.status==='research'?'경쟁상품 조사 기록: 자사 DB 변경 대상이 아닙니다.':item.status==='scheduled'?'미래 적용일: 예약 기록만 만들고 DB 반영을 막았습니다.':'실제 로컬 LLM 해석과 제한된 원문 검증을 통과했습니다. 담당자 승인이 필요합니다.';
    item.before=product?clone(product):null;item.after=null;item.updatedAt=this.at();item.completedAt=item.status==='pending'?null:this.at();
    item.steps=[{name:'source',status:'completed',at:item.receivedAt},{name:'extract',status:'completed',at:snapshot.createdAt},{name:'validate',status:result.errors.length?'failed':'completed',at:this.at()},{name:'review',status:item.status==='pending'?'waiting':'skipped',at:this.at()}];
    return item;
  }
  prepareAnalysis(body){
    exact(body,['noticeId','productId','sourceText','sourceType']);
    if(!bounded(body.noticeId)||!bounded(body.productId,60)||typeof body.sourceText!=='string'||!body.sourceText.length||body.sourceText.length>8000||!body.sourceText.includes('합성 자료')||!['official-synthetic','competitor'].includes(body.sourceType))fail('합성 자연어 원문·공지 식별자·상품을 확인하세요.');
    const product=this.get('products',body.productId);if(!product)fail('합성 상품 DB에서 상품을 찾을 수 없습니다.');
    const existing=this.rows('cases').find(item=>item.noticeId===body.noticeId);
    if(existing){
      if(existing.sourceText!==body.sourceText||existing.sourceType!==body.sourceType||existing.productId!==body.productId)fail('같은 공지 ID의 다른 원문 또는 상품입니다. 기존 사건에서 수정 후 재분석하세요.',409,{case:existing});
      return this.transaction(()=>{this.setMeta('duplicateReceipts',this.getMeta('duplicateReceipts')+1);this.event(existing.id,'duplicate-receipt','동일 공지 재분석 요청: 기존 사건을 반환하고 모델을 다시 호출하지 않았습니다.');return {duplicate:true,case:existing};});
    }
    const sameSource=this.rows('cases').find(item=>item.sourceText===body.sourceText&&item.sourceType===body.sourceType&&item.productId===body.productId);
    if(sameSource)return this.transaction(()=>{this.setMeta('duplicateReceipts',this.getMeta('duplicateReceipts')+1);this.event(sameSource.id,'duplicate-receipt','동일 원문: 새 사건과 추가 모델 호출을 만들지 않았습니다.');return {duplicate:true,case:sameSource};});
    return {epoch:this.getMeta('epoch'),body:clone(body),productId:body.productId,productSnapshot:clone(product),expectedProductVersion:product.version,sourceRevision:1,sourceHash:digest(body.sourceText),receivedAt:this.at()};
  }
  prepareReanalysis(id,body){
    exact(body,['sourceRevision']);if(!Number.isInteger(body.sourceRevision))fail('원문 리비전을 확인하세요.');
    const item=this.requiredCase(id);if(item.sourceChannel!=='llm'||!['held','pending'].includes(item.status)||item.sourceRevision!==body.sourceRevision)fail('현재 AI 검토 사건의 원문 리비전만 다시 분석할 수 있습니다.',409);
    const product=this.get('products',item.productId);if(!product)fail('상품 DB를 찾을 수 없습니다.',409);
    return {epoch:this.getMeta('epoch'),caseId:id,body:{noticeId:item.noticeId,productId:item.productId,sourceText:item.sourceText,sourceType:item.sourceType},productId:item.productId,productSnapshot:clone(product),expectedProductVersion:product.version,sourceRevision:item.sourceRevision,sourceHash:item.sourceHash,receivedAt:item.receivedAt};
  }
  finishAnalysis(context,result){
    return this.transaction(()=>{
      const product=this.get('products',context.productId);
      if(context.epoch!==this.getMeta('epoch')||!same(context.productSnapshot,product)||context.sourceHash!==digest(context.body.sourceText))fail('분석 중 초기화 또는 상품 DB 변경이 발생했습니다. 새 상태에서 다시 분석하세요.',409);
      let item;
      if(context.caseId){item=this.get('cases',context.caseId);if(!item||item.sourceRevision!==context.sourceRevision||item.sourceHash!==context.sourceHash||item.sourceText!==context.body.sourceText||item.productId!==context.productId||!['held','pending'].includes(item.status))fail('분석 중 원문 또는 사건 상태가 변경되었습니다. 다시 분석하세요.',409);}
      else {if(this.rows('cases').some(c=>c.noticeId===context.body.noticeId||c.sourceText===context.body.sourceText&&c.productId===context.productId&&c.sourceType===context.body.sourceType))fail('분석 중 같은 공지의 사건이 먼저 생성되었습니다. 새 상태를 확인하세요.',409);item={id:this.id('case'),...context.body,sourceChannel:'llm',executionId:null,productId:context.productId,sourceRevision:context.sourceRevision,sourceHash:context.sourceHash,receivedAt:context.receivedAt};}
      item.aiSnapshot={epoch:context.epoch,productId:context.productId,noticeId:context.body.noticeId,sourceType:context.body.sourceType,sourceHash:context.sourceHash,sourceRevision:context.sourceRevision,expectedProductVersion:context.expectedProductVersion,productSnapshot:clone(context.productSnapshot),analysis:clone(result.analysis),modelResponse:result.modelResponse,model:result.model,provider:result.provider,elapsedMs:result.elapsedMs,createdAt:this.at()};
      this.validateAI(item);this.putCase(item);this.event(item.id,context.caseId?'ai-reanalyzed':'received',context.caseId?'현재 원문을 실제 로컬 LLM으로 다시 분석했습니다.':'실제 로컬 LLM으로 합성 자연어 공지를 분석했습니다.');this.event(item.id,item.status,item.reason);if(item.status==='held')this.ticket(item,item.reason);return {case:item,duplicate:false};
    });
  }
  receive(body){
    exact(body,['noticeId','sourceText','sourceType','sourceChannel','executionId']);
    if(!bounded(body.noticeId)||typeof body.sourceText!=='string'||body.sourceText.length>8000||!body.sourceText.includes('합성 자료')||!['official-synthetic','competitor'].includes(body.sourceType)||!['manual','n8n','gmail'].includes(body.sourceChannel)||(body.executionId!==undefined&&!bounded(body.executionId)))fail('합성 원문·공지 식별자·출처 채널을 확인하세요.');
    return this.transaction(()=>{
      const existingRow=this.db.prepare('SELECT data FROM cases WHERE notice_id=?').get(body.noticeId);
      if(existingRow){const item=JSON.parse(existingRow.data);if(item.sourceText===body.sourceText&&item.sourceType===body.sourceType){this.setMeta('duplicateReceipts',this.getMeta('duplicateReceipts')+1);this.event(item.id,'duplicate-receipt','동일 공지와 원문 재수신: 추가 반영하지 않았습니다.');return {case:item,duplicate:true};}this.event(item.id,'notice-conflict','같은 공지 ID의 다른 원문: 명시적 수정과 재검토가 필요합니다.');this.ticket(item,'같은 공지 ID로 다른 원문을 수신했습니다.');return {conflict:true,case:item,duplicate:false,error:'같은 공지 ID의 다른 원문입니다. 수정 API로 다시 검토하세요.'};}
      const item=this.validate({id:this.id('case'),noticeId:body.noticeId,sourceText:body.sourceText,sourceType:body.sourceType,sourceChannel:body.sourceChannel,executionId:body.executionId??null,productId:null,sourceRevision:1,sourceHash:digest(body.sourceText),receivedAt:this.at()});
      this.putCase(item);this.event(item.id,'received',`${body.sourceChannel} 채널에서 합성 공지를 수신했습니다.`);this.event(item.id,item.status,item.reason);if(item.status==='held')this.ticket(item,item.reason);return {case:item,duplicate:false};
    });
  }
  decision(id,body){
    exact(body,['decision','sourceRevision','expectedProductVersion','decisionId','actor']);
    if(!['approve','hold'].includes(body.decision)||body.actor!=='demo-reviewer'||!bounded(body.decisionId)||!Number.isInteger(body.sourceRevision)||!Number.isInteger(body.expectedProductVersion))fail('결정·검토 스냅샷·결정 ID를 확인하세요.');
    const payload={caseId:id,decision:body.decision,sourceRevision:body.sourceRevision,expectedProductVersion:body.expectedProductVersion,decisionId:body.decisionId,actor:body.actor};
    return this.transaction(()=>{
      const receipt=this.db.prepare('SELECT payload,result FROM decisions WHERE id=?').get(body.decisionId);
      if(receipt){if(receipt.payload!==JSON.stringify(payload))fail('결정 ID를 다른 요청에 재사용할 수 없습니다.',409);return {...JSON.parse(receipt.result),duplicate:true};}
      const item=this.requiredCase(id),product=this.get('products',item.productId);
      if(item.status!=='pending'||item.sourceRevision!==body.sourceRevision||item.expectedProductVersion!==body.expectedProductVersion||product?.version!==body.expectedProductVersion)fail('오래된 검토이거나 현재 승인 대기 사건이 아닙니다. 새 상태를 확인하세요.',409,{case:item});
      if(item.sourceHash!==digest(item.sourceText))fail('원문 해시 검증에 실패했습니다.',409);
      const check=this.validate(clone(item));
      if(check.status!=='pending'||!same(check.candidate,item.candidate))fail('반영 직전 원문 검증에 실패했습니다.',409);
      item.updatedAt=this.at();item.completedAt=this.at();item.steps.push({name:'review',status:body.decision==='approve'?'approved':'held',at:this.at()});
      if(body.decision==='hold'){item.status='held';item.reason='담당자가 변경 반영을 보류했습니다.';this.ticket(item,item.reason);}
      else {item.before=clone(product);Object.assign(product,item.candidate.changes,{version:item.candidate.version,updatedAt:this.at()});this.put('products',product);item.after=clone(product);item.status='applied';item.reason='담당자 승인 후 SQLite 트랜잭션으로 반영했습니다.';item.steps.push({name:'apply',status:'completed',at:this.at()});for(const ticket of this.rows('tickets').filter(t=>t.caseId===id)){ticket.status='resolved';this.put('tickets',ticket);}}
      this.putCase(item);this.event(id,'decision',`${body.actor}: ${body.decision} (결정 ID ${body.decisionId})`);this.event(id,item.status,item.reason);
      const result={case:item,duplicate:false,...(body.decision==='approve'?{product}: {})};this.db.prepare('INSERT INTO decisions VALUES (?,?,?)').run(body.decisionId,JSON.stringify(payload),JSON.stringify(result));return result;
    });
  }
  revise(id,body){exact(body,['sourceText']);if(typeof body.sourceText!=='string'||body.sourceText.length>8000||!body.sourceText.includes('합성 자료'))fail('합성 원문을 확인하세요.');return this.transaction(()=>{const item=this.requiredCase(id);if(!['pending','conflict','held'].includes(item.status))fail('검토 대기·충돌·보류 사건만 수정할 수 있습니다.',409);item.sourceText=body.sourceText;item.sourceHash=digest(body.sourceText);item.sourceRevision++;if(item.sourceChannel==='llm'){item.aiSnapshot=null;item.aiInterpretation=null;}this.validate(item);this.putCase(item);this.event(id,'source-revised',`원문 수정: 검토 리비전 ${item.sourceRevision}, 이전 승인은 무효입니다.`);this.ticket(item,'원문 변경으로 재검토가 필요합니다.');return {case:item};});}
  automationEvent(body){exact(body,['caseId','type','executionId','message']);if(!bounded(body.caseId,200)||!['workflow-started','workflow-finished','workflow-failed'].includes(body.type)||!bounded(body.executionId)||!bounded(body.message,1000))fail('실행 식별자가 있는 자동화 이벤트를 확인하세요.');return this.transaction(()=>{const item=this.requiredCase(body.caseId),key=JSON.stringify([body.caseId,body.type,body.executionId]);const old=this.db.prepare('SELECT key FROM automation WHERE key=?').get(key);if(old)return {ok:true,duplicate:true};this.db.prepare('INSERT INTO automation VALUES (?)').run(key);const event=this.event(item.id,body.type,body.message);event.executionId=body.executionId;this.put('events',event);this.integration('n8n',{name:'n8n',mode:body.type==='workflow-failed'?'failed':'connected',detail:`실제 수신 실행: ${body.executionId}`,...(body.type!=='workflow-failed'?{lastSuccessAt:this.at()}:{})});if(body.type==='workflow-failed')this.ticket(item,`n8n 실행 실패: ${body.message}`);return {ok:true,duplicate:false};});}
  reset(body){exact(body,['scope']);if(body.scope!=='synthetic-demo')fail('synthetic-demo 초기화 범위만 허용합니다.');this.transaction(()=>{for(const table of ['products','cases','tickets','events','decisions','automation','integrations','meta'])this.db.exec(`DELETE FROM ${table}`);this.seed();});return this.state();}
  samples(){const product=this.get('products','P1'),day=this.today(),source=changes=>`[가상한결은행 · 합성 자료]\nproductId=P1\nversion=${product.version+1}\neffectiveDate=${day}\n${changes}`;return {normal:{noticeId:`demo-${this.getMeta('epoch')}-P1-v${product.version+1}`,sourceText:source('rate=3.76'),sourceType:'official-synthetic',sourceChannel:'manual'},conflict:{noticeId:`conflict-${randomUUID()}`,sourceText:source('rate=3.76\nrate=8.99'),sourceType:'official-synthetic',sourceChannel:'manual'},missingDate:{noticeId:`missing-${randomUUID()}`,sourceText:source('limit=70000000').replace(`effectiveDate=${day}\n`,''),sourceType:'official-synthetic',sourceChannel:'manual'},competitor:{noticeId:`competitor-${randomUUID()}`,sourceText:source('rate=3.25').replace('productId=P1','productId=C1'),sourceType:'competitor',sourceChannel:'manual'},future:{noticeId:`future-${randomUUID()}`,sourceText:source('active=false').replace(day,new Date(this.now().getTime()+30*86400000).toISOString().slice(0,10)),sourceType:'official-synthetic',sourceChannel:'manual'}};}
  aiSamples(){
    const targetRate=this.get('products','P1').rate===3.76?3.91:3.76;
    const day=this.today(),source=(content,date=day)=>`[가상한결은행 · 합성 자료]\n생활대출 P1 상품 변경 안내\n${date?`${date}부터 적용합니다.\n`:''}${content}\n이 안내는 모든 고객에게 동일하게 적용됩니다.`,envelope=(key,sourceText,sourceType='official-synthetic')=>({noticeId:`ai-${key}-${this.getMeta('epoch')}-${this.get('products','P1').version}`,productId:'P1',sourceText,sourceType,sourceChannel:'llm'});
    return {normal:envelope('normal',source(`대출 금리를 ${targetRate}%로 변경합니다.`)),conditional:envelope('conditional',source('신규 가입 고객에게만 대출 금리 3.76%를 적용합니다.')),missingDate:envelope('missing-date',source('대출 금리를 3.76%로 변경합니다.',null)),conflict:envelope('conflict',source('대출 금리를 3.76%로 변경합니다. 대출 금리는 8.99%입니다.')),future:envelope('future',source('대출 금리를 3.76%로 변경합니다.',new Date(this.now().getTime()+30*86400000).toISOString().slice(0,10))),competitor:envelope('competitor',source('대출 금리를 3.25%로 변경합니다.').replace('가상한결은행','가상경쟁은행'),'competitor')};
  }
  state(integrations=[]){const cases=this.rows('cases'),events=this.rows('events');const completed=cases.filter(c=>c.completedAt);return {epoch:this.getMeta('epoch'),products:this.rows('products'),cases,tickets:this.rows('tickets').map(({deliveryStatus,lastError,...t})=>t),events,integrations,metrics:{received:cases.length,pending:cases.filter(c=>c.status==='pending').length,applied:cases.filter(c=>c.status==='applied').length,exceptions:cases.filter(c=>['held','conflict'].includes(c.status)).length,scheduled:cases.filter(c=>c.status==='scheduled').length,research:cases.filter(c=>c.status==='research').length,duplicateReceipts:this.getMeta('duplicateReceipts'),completedCount:completed.length,elapsedMsAverage:completed.length?Math.round(completed.reduce((sum,c)=>sum+Math.max(0,Date.parse(c.completedAt)-Date.parse(c.receivedAt)),0)/completed.length):null,automationEvents:events.filter(e=>e.type.startsWith('workflow-')).length}};}
}
