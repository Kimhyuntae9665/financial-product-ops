// All time and effort figures are assumptions in virtual minutes, not observed work.
export const DEFAULT_CONFIG = Object.freeze({seed:42,count:24,arrivalInterval:3,reviewers:1,reviewMinutes:4,automation:2,mode:'agent',autoReview:false});
const TERMINAL = new Set(['done','hold','scheduled','duplicate','research']);
const IMPORTANT = new Set(['rate','limit','reviewId','active']);
const FIELDS = new Set([...IMPORTANT,'capturedAt','sourceHash']);
const TIMES = {manual:{extract:6,validate:4,review:4},rules:{extract:3,validate:3,review:4},agent:{extract:1,validate:2,review:4}};
const copy = value => JSON.parse(JSON.stringify(value));
const fingerprint = text => {
  let hash = 2166136261;
  for (const char of String(text)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `src-${(hash >>> 0).toString(16).padStart(8,'0')}`;
};
function normalize(config) {
  const c = {...DEFAULT_CONFIG,...config};
  for (const key of ['seed','count','arrivalInterval','reviewers','reviewMinutes','automation']) if (!Number.isFinite(c[key])) throw new Error(`${key}: finite number required`);
  c.seed = Math.trunc(c.seed); c.count = Math.max(0,Math.min(120,Math.trunc(c.count)));
  c.arrivalInterval = Math.max(0,Math.min(30,Math.trunc(c.arrivalInterval)));
  c.reviewers = Math.max(0,Math.min(8,Math.trunc(c.reviewers)));
  c.reviewMinutes = Math.max(2,Math.min(12,Math.trunc(c.reviewMinutes)));
  c.automation = Math.max(0,Math.min(2,Math.trunc(c.automation)));
  if (!TIMES[c.mode]) throw new Error('Unknown simulation mode');
  c.autoReview = Boolean(c.autoReview);
  return c;
}
function candidateOf(event) {
  const candidate={productId:null,version:null,effectiveAt:null,changes:{},evidence:[]};
  for (const line of event.sourceText.split('\n')) {
    const match=/^([A-Za-z]+)=(.*)$/.exec(line);
    if (!match) continue;
    const [,field,raw]=match;
    const numeric=['version','effectiveAt','rate','limit','capturedAt'].includes(field);
    const value=numeric && /^-?\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : field==='active' && ['true','false'].includes(raw) ? raw==='true' : raw;
    if (['productId','version','effectiveAt'].includes(field)) candidate[field]=value;
    else candidate.changes[field]=value;
    candidate.evidence.push({field,quote:line});
  }
  return candidate;
}
function sourceOf(event) {
  const entries = {productId:event.productId,version:event.version,...(event.effectiveAt === null ? {} : {effectiveAt:event.effectiveAt}),...event.changes};
  const changes = Object.entries(event.changes).map(([field,value]) => {
    if (field === 'rate') return `금리를 ${value}%로 변경합니다.`;
    if (field === 'limit') return `대출 한도를 ${Number(value).toLocaleString('ko-KR')}원으로 변경합니다.`;
    if (field === 'reviewId') return `심의필 번호를 ${value}로 변경합니다.`;
    if (field === 'active') return value ? '판매를 시작합니다.' : '판매를 중단합니다.';
    if (field === 'capturedAt') return `수집 시각을 가상 ${value}분으로 기록합니다.`;
    return `출처 해시를 ${value}로 기록합니다.`;
  }).join('\n');
  const effective = event.effectiveAt === null ? '적용: 공지에 적용 시점이 누락되어 있습니다.' : event.effectiveAt === 0 ? '적용: 시나리오 시작 시점.' : `적용: 시나리오 시작 후 가상 ${event.effectiveAt}분.`;
  const note = event.kind === 'conflict' ? '\n추가 문장에는 금리 8.99%가 함께 적혀 있어 수치가 충돌합니다.' : event.kind === 'past-version' ? '\n공지 버전이 현재 DB보다 새롭지 않습니다.' : event.sourceType === 'competitor' ? '\n경쟁상품 참고 자료입니다. 자사 상품 DB의 변경 대상이 아닙니다.' : '';
  const introduction = `[${event.bank} 상품 변경 공지 · 합성 자료]\n${event.productName}의 ${changes}\n${effective}${note}`;
  return {text:introduction+'\n\n'+Object.entries(entries).map(([k,v]) => `${k}=${v}`).join('\n'),evidence:Object.entries(entries).map(([field,value]) => ({field,quote:`${field}=${value}`}))};
}
export function createScenario(config={}) {
  const c = normalize(config);
  let seed = c.seed >>> 0;
  const random = () => {seed = (Math.imul(seed,1664525)+1013904223) >>> 0; return seed / 4294967296;};
  const products = Array.from({length:10},(_,i) => ({id:`P${i+1}`,name:`합성 생활대출 ${i+1}`,bank:['가상한결은행','가상새봄은행','가상푸른은행'][i%3],version:1,rate:4.5+i*0.1,limit:50000000,reviewId:`DEMO-2026-${i+1}`,active:true,capturedAt:0,sourceHash:`initial-${i+1}`}));
  const versions = products.map(() => 1), events = [];
  const patterns = [ ['rate',0],['capturedAt',1],['conflict',2],['limit',3],['reviewId',4],['active',5],['competitor',0],['missing-date',6],['past-version',7],['future',8],['duplicate',0],['sourceHash',9] ];
  for (let i=0;i<c.count;i++) {
    const [kind,p] = patterns[i%patterns.length], product = products[p];
    if (kind === 'duplicate' && events.length) {
      const original = events[Math.floor(i/12)*12] || events[0];
      events.push({...copy(original),id:`E${i+1}`,kind,arrivesAt:i*c.arrivalInterval,expected:{route:'duplicate',changes:copy(original.changes)}});
      continue;
    }
    const normal = FIELDS.has(kind);
    const version = kind === 'past-version' ? 1 : normal ? ++versions[p] : versions[p]+1;
    const changes = kind === 'rate' ? {rate:Number((3+random()*3).toFixed(2))} : kind === 'limit' ? {limit:Math.floor(3+random()*7)*10000000} : kind === 'reviewId' ? {reviewId:`DEMO-2026-V${version}-${i+1}`} : kind === 'active' ? {active:false} : kind === 'capturedAt' ? {capturedAt:i*c.arrivalInterval} : kind === 'sourceHash' ? {sourceHash:`capture-${Math.floor(random()*1000000)}`} : {rate:3.25};
    const event = {id:`E${i+1}`,productId:kind === 'competitor' ? 'C1' : product.id,productName:kind === 'competitor' ? '합성 경쟁상품' : product.name,bank:kind === 'competitor' ? '가상경쟁은행' : product.bank,kind,sourceType:kind === 'competitor' ? 'competitor' : 'official-synthetic',version,effectiveAt:kind === 'missing-date' ? null : kind === 'future' ? 900 : 0,arrivesAt:i*c.arrivalInterval,sourceUrl:`synthetic://notice/${i+1}`,changes,expected:{route:kind === 'competitor' ? 'research' : kind === 'future' ? 'scheduled' : normal ? 'apply' : 'hold',changes:copy(changes)}};
    const source = sourceOf(event);
    event.sourceText = source.text + (kind === 'conflict' ? '\nrate=8.99' : '');
    event.evidence = source.evidence;
    event.sourceFingerprint = fingerprint(event.sourceText);
    events.push(event);
  }
  return {products,events};
}
// An adapter must return exact source lines for productId/version/effectiveAt and
// every changed field: {field:'rate',quote:'rate=3.25'}. Evidence is checked
// against both the candidate value and the immutable input source, not just truth.
export function validateCandidate(event,candidate,product) {
  const fail = reason => ({ok:false,reason,route:'hold'});
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return fail('추출 결과가 객체가 아닙니다.');
  if (Object.keys(candidate).some(k => !['productId','version','effectiveAt','changes','evidence'].includes(k))) return fail('알 수 없는 후보 필드입니다.');
  if (event.sourceFingerprint !== fingerprint(event.sourceText)) return fail('원문 지문이 일치하지 않습니다.');
  if (candidate.productId !== event.productId || !Number.isInteger(candidate.version) || candidate.version < 1) return fail('상품 식별자 또는 버전이 잘못되었습니다.');
  if (!Number.isFinite(candidate.effectiveAt) || candidate.effectiveAt < 0) return fail('적용일이 누락되었거나 잘못되었습니다.');
  if (!candidate.changes || typeof candidate.changes !== 'object' || Array.isArray(candidate.changes) || !Object.keys(candidate.changes).length) return fail('변경 필드가 없습니다.');
  if (Object.keys(candidate.changes).some(k => !FIELDS.has(k))) return fail('알 수 없는 변경 필드입니다.');
  const v = candidate.changes;
  if ('rate' in v && (!Number.isFinite(v.rate) || v.rate < 0 || v.rate > 30)) return fail('금리 범위를 확인해야 합니다.');
  if ('limit' in v && (!Number.isSafeInteger(v.limit) || v.limit < 0 || v.limit > 1000000000)) return fail('한도 범위를 확인해야 합니다.');
  if ('reviewId' in v && (typeof v.reviewId !== 'string' || !/^DEMO-[A-Z0-9-]{3,60}$/.test(v.reviewId))) return fail('심의필 형식이 잘못되었습니다.');
  if ('active' in v && typeof v.active !== 'boolean') return fail('판매 상태가 boolean이 아닙니다.');
  if ('capturedAt' in v && (!Number.isFinite(v.capturedAt) || v.capturedAt < 0)) return fail('수집 시각이 잘못되었습니다.');
  if ('sourceHash' in v && (typeof v.sourceHash !== 'string' || !/^[A-Za-z0-9-]{3,80}$/.test(v.sourceHash))) return fail('출처 해시가 잘못되었습니다.');
  const values = {productId:candidate.productId,version:candidate.version,effectiveAt:candidate.effectiveAt,...v};
  if (!Array.isArray(candidate.evidence)) return fail('원문 근거가 없습니다.');
  for (const [field,value] of Object.entries(values)) {
    const lines = event.sourceText.split('\n').filter(line => line.startsWith(`${field}=`));
    if (lines.length !== 1) return fail(`${field}: 원문 누락 또는 충돌입니다.`);
    const evidence = candidate.evidence.filter(item => item && item.field === field);
    if (evidence.length !== 1 || evidence[0].quote !== `${field}=${value}` || evidence[0].quote !== lines[0]) return fail(`${field}: 후보와 원문 근거가 일치하지 않습니다.`);
  }
  if (Object.keys(v).length !== Object.keys(event.changes).length || Object.keys(event.changes).some(k => !(k in v))) return fail('변경 필드가 누락되었습니다.');
  if (event.sourceType === 'competitor') return {ok:true,reason:'경쟁상품은 조사 기록만 갱신합니다.',route:'research'};
  if (!product || product.id !== candidate.productId) return fail('자사 상품 DB에서 상품을 찾을 수 없습니다.');
  if (candidate.version <= product.version) return fail('과거 또는 이미 적용된 버전입니다.');
  if (candidate.version !== product.version+1) return {...fail('선행 버전을 먼저 확인해야 합니다.'),code:'predecessor'};
  return {ok:true,reason:'원문과 필드 검증을 통과했습니다.',route:'apply'};
}
export function createSimulation(config={},scenario) {
  const c = normalize(config), input = copy(scenario || createScenario(c));
  return {config:c,time:0,products:input.products,research:[],tasks:input.events.map(event => ({...event,stage:'incoming',startedAt:null,completedAt:null,reason:'도착 대기',candidate:null,decision:null,reviewFingerprint:null,reviewDbVersion:null,active:false,remaining:0})),log:[],metrics:{totalHumanMinutes:0,maxReviewQueue:0},seen:[],writes:[],nextLogId:1};
}
function log(sim,task,type,message) {sim.log.push({id:sim.nextLogId++,time:sim.time,taskId:task.id,type,message});}
function end(sim,task,stage,reason) {task.stage=stage;task.active=false;task.remaining=0;task.completedAt=sim.time;task.reason=reason;log(sim,task,stage,reason);}
function keyOf(task) {return `${task.productId}|${task.version}|${task.sourceFingerprint}`;}
function needsHuman(sim,task) {
  return Object.keys(task.candidate.changes).some(field => IMPORTANT.has(field) || (field === 'capturedAt' && sim.config.automation < 1) || (field === 'sourceHash' && sim.config.automation < 2));
}
function routeValidated(sim,task) {
  const key = keyOf(task);
  if (sim.seen.includes(key)) return end(sim,task,'duplicate','같은 상품·버전·원문 사건을 이미 처리했습니다.');
  const product = sim.products.find(p => p.id === task.productId), result = validateCandidate(task,task.candidate,product);
  if (!result.ok) {
    if (result.code === 'predecessor') {
      const predecessors=sim.tasks.filter(t => t.id!==task.id && t.productId===task.productId && t.version===task.candidate.version-1);
      if (predecessors.some(t => !TERMINAL.has(t.stage))) {
        if (task.stage!=='versionWait') log(sim,task,'versionWait','앞선 변경의 검토·반영을 기다립니다.');
        task.stage='versionWait';task.active=false;task.remaining=0;task.reason='앞선 변경의 검토·반영을 기다립니다.';
        return;
      }
      return end(sim,task,'hold','앞선 버전의 변경이 반영되지 않았습니다. 선행 보류·예약 또는 누락을 확인해야 합니다.');
    }
    return end(sim,task,'hold',result.reason);
  }
  sim.seen.push(key);
  if (result.route === 'research') {sim.research.push({eventId:task.id,productId:task.productId,changes:copy(task.candidate.changes),sourceUrl:task.sourceUrl,time:sim.time});return end(sim,task,'research',result.reason);}
  task.reviewFingerprint = task.sourceFingerprint; task.reviewDbVersion = product.version;
  task.stage = needsHuman(sim,task) ? 'review' : 'apply';
  task.reason = task.stage === 'review' ? '중요 변경 또는 수동 관리정보: 담당자 검토 대기' : '관리정보 자동 반영 대기';
  log(sim,task,task.stage,task.reason);
}
function safeWrite(sim,task) {
  const product = sim.products.find(p => p.id === task.productId);
  if (!product || task.reviewFingerprint !== task.sourceFingerprint || task.sourceFingerprint !== fingerprint(task.sourceText) || product.version !== task.reviewDbVersion) return end(sim,task,'hold','반영 직전 원문 또는 DB 버전이 바뀌었습니다. 다시 검토해야 합니다.');
  const result = validateCandidate(task,task.candidate,product);
  if (!result.ok) return end(sim,task,'hold',result.reason);
  if (task.candidate.effectiveAt > sim.time) return end(sim,task,'scheduled','미래 적용일: 오늘 DB에 반영하지 않고 예약합니다.');
  const before = copy(product);
  Object.assign(product,task.candidate.changes,{version:task.candidate.version});
  const truth = task.expected;
  const correct = truth?.route === 'apply' && Object.keys(truth.changes || {}).length === Object.keys(task.candidate.changes).length && Object.entries(truth.changes || {}).every(([k,v]) => product[k] === v);
  sim.writes.push({taskId:task.id,time:sim.time,before,after:copy(product),changes:copy(task.candidate.changes),correct,humanReviewed:task.decision === 'approve',sourceFingerprint:task.sourceFingerprint});
  end(sim,task,'done',correct ? '반영 완료 · 합성 참값 대조 통과' : '반영 완료 · 합성 참값 불일치');
}
export function decide(sim,id,decision,expectedFingerprint) {
  const task = sim.tasks.find(t => t.id === id);
  if (!task || task.stage !== 'review') return {ok:false,reason:'현재 검토 대기 중인 사건만 결정할 수 있습니다.'};
  if (!['approve','hold'].includes(decision)) return {ok:false,reason:'결정은 approve 또는 hold여야 합니다.'};
  const product = sim.products.find(p => p.id === task.productId);
  if (expectedFingerprint !== task.reviewFingerprint || expectedFingerprint !== task.sourceFingerprint || task.sourceFingerprint !== fingerprint(task.sourceText) || product?.version !== task.reviewDbVersion) return {ok:false,reason:'오래된 승인입니다. 원문 또는 DB 버전이 바뀌었습니다.'};
  task.decision = decision; task.reviewedAt = sim.time;task.active=false;task.remaining=0;
  sim.metrics.totalHumanMinutes += sim.config.reviewMinutes;
  log(sim,task,'decision',decision === 'approve' ? '담당자 승인' : '담당자 보류');
  if (decision === 'hold') end(sim,task,'hold','담당자가 변경 반영을 보류했습니다.');
  else {task.stage='apply';task.reason='승인 후 반영 대기';log(sim,task,'apply',task.reason);}
  return {ok:true,reason:task.reason};
}
export function reviseSource(sim,id) {
  const task = sim.tasks.find(t => t.id === id);
  if (!task || task.stage !== 'review') return {ok:false,reason:'검토 대기 사건만 원문 변경을 체험할 수 있습니다.'};
  task.sourceText += '\n원문 수정 알림: 추가 확인 필요';task.sourceFingerprint=fingerprint(task.sourceText);
  end(sim,task,'hold','원문 변경으로 기존 검토가 무효화되었습니다. 재수집·재검토가 필요합니다.');
  return {ok:true,reason:task.reason};
}
export function advance(sim,minutes=1) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10000) throw new Error('minutes must be an integer from 0 to 10000');
  for (let tick=0;tick<minutes;tick++) {
    sim.time++;
    for (const task of sim.tasks) {
      if (task.stage === 'incoming' && task.arrivesAt <= sim.time) {task.stage='extract';task.startedAt=sim.time;task.reason='추출 대기';log(sim,task,'arrive','사건 도착');}
      if (!task.active) continue;
      task.remaining--;
      if (task.remaining > 0) continue;
      task.active=false;
      if (task.stage === 'extract') {
        sim.metrics.totalHumanMinutes += sim.config.mode === 'manual' ? TIMES.manual.extract : sim.config.mode === 'rules' ? 1 : 0;
        task.candidate = candidateOf(task);task.stage='validate';task.reason='원문 대조·범위 검증 대기';log(sim,task,'extract','합성 추출 완료');
      } else if (task.stage === 'validate') {
        sim.metrics.totalHumanMinutes += sim.config.mode === 'manual' ? TIMES.manual.validate : sim.config.mode === 'rules' ? 1 : 0;
        routeValidated(sim,task);
      } else if (task.stage === 'review') decide(sim,task.id,'approve',task.reviewFingerprint);
      else if (task.stage === 'apply') safeWrite(sim,task);
    }
    for (const task of sim.tasks) if (task.stage==='versionWait') routeValidated(sim,task);
    sim.metrics.maxReviewQueue=Math.max(sim.metrics.maxReviewQueue,sim.tasks.filter(t => t.stage === 'review').length);
    for (const [stage,capacity] of [['extract',1],['validate',1],['review',sim.config.autoReview ? sim.config.reviewers : 0],['apply',1]]) {
      let available=capacity-sim.tasks.filter(t => t.stage === stage && t.active).length;
      for (const task of sim.tasks) if (available>0 && task.stage===stage && !task.active) {task.active=true;task.remaining=stage === 'apply' ? 1 : stage === 'review' ? sim.config.reviewMinutes : TIMES[sim.config.mode][stage];available--;}
    }
  }
  return sim;
}
export function finishSimulation(config={},scenario) {
  const sim=createSimulation(config,scenario);
  while (sim.time < 600 && sim.tasks.some(t => !TERMINAL.has(t.stage))) {
    advance(sim);
    if (!sim.config.autoReview && sim.tasks.every(t => TERMINAL.has(t.stage) || ['review','versionWait'].includes(t.stage))) break;
  }
  return sim;
}
export function summarize(sim) {
  const arrived=sim.tasks.filter(t => t.startedAt !== null),completed=arrived.filter(t => TERMINAL.has(t.stage));
  const reviewed=sim.tasks.filter(t => t.decision !== null).length, writeCount=sim.writes.length;
  return {arrived:arrived.length,completed:completed.length,applied:sim.tasks.filter(t => t.stage==='done').length,reviewed,held:sim.tasks.filter(t => t.stage==='hold').length,scheduled:sim.tasks.filter(t => t.stage==='scheduled').length,duplicates:sim.tasks.filter(t => t.stage==='duplicate').length,research:sim.research.length,unresolved:sim.tasks.length-completed.length,wrongWrites:sim.writes.filter(w => !w.correct).length,writeCount,avgLeadTime:completed.length ? completed.reduce((sum,t) => sum+t.completedAt-t.arrivesAt,0)/completed.length : null,totalHumanMinutes:sim.metrics.totalHumanMinutes,maxReviewQueue:sim.metrics.maxReviewQueue,automationRate:writeCount ? sim.writes.filter(w => !w.humanReviewed).length/writeCount : null,elapsed:sim.time,reviewQueue:sim.tasks.filter(t => t.stage==='review').length};
}
