import {DEFAULT_CONFIG,createScenario,createSimulation,advance,decide,reviseSource,finishSimulation,summarize,validateCandidate} from './core.mjs';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g,ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const TERMINAL = new Set(['done','hold','scheduled','duplicate','research']);
const stageNames = {incoming:'도착 예정',extract:'변경 추출',validate:'규칙 검증',versionWait:'선행 변경 대기',review:'사람 검토',apply:'반영 대기',done:'반영 완료',hold:'보류',scheduled:'적용 예정',duplicate:'중복 제외',research:'조사 기록'};
const fieldNames = {rate:'금리',limit:'대출 한도',reviewId:'심의필',active:'판매 상태',capturedAt:'수집 시각',sourceHash:'출처 해시'};
const kindNames = {...fieldNames,conflict:'출처 충돌','missing-date':'적용일 누락','past-version':'과거 버전',future:'미래 적용일',duplicate:'같은 공지 재도착',competitor:'경쟁상품 조사'};
const modeNames = {manual:'수동 확인 + 사람',rules:'규칙 확인 + 사람',agent:'AI 추출 모의 + 규칙 + 사람'};
const formatTime = minutes => `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
const num = value => value === null || value === undefined ? '—' : Number(value).toLocaleString('ko-KR',{maximumFractionDigits:1});
const fieldValue = (field,value) => value === undefined ? '—' : field === 'rate' ? `${Number(value).toLocaleString('ko-KR',{maximumFractionDigits:2})}%` : field === 'limit' ? `${num(value/10000)}만원` : field === 'active' ? value ? '판매 중' : '판매 중지' : field === 'capturedAt' ? `시작 후 ${value}분` : String(value);
let sim,scenario,selectedId='E1',filter='all',recordTab='db',playing=false,comparison=null,localExperiments=[],toastTimer,runGeneration=0,modelAvailable=false;
let lastDetailSignature='',lastFeedSignature='',lastRecordSignature='';

function readConfig(){return {...DEFAULT_CONFIG,count:Number($('count').value),arrivalInterval:Number($('arrival').value),reviewers:Number($('reviewers').value),reviewMinutes:Number($('review-time').value),automation:Number($('automation').value),mode:$('mode').value,autoReview:$('auto-review').checked};}
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),4200);}
function setPlaying(value){playing=value;$('play').textContent=playing?'Ⅱ 일시정지':'▶ 재생';$('play').setAttribute('aria-label',playing?'시뮬레이션 일시정지':'시뮬레이션 재생');}
function reset({preview=false}={}){
  runGeneration++;localExperiments=[];$('model-output').textContent='선택한 공지의 원문 → 실제 모델 추출 → 코드 검증';$('extract-local').disabled=!modelAvailable;
  setPlaying(false);const config=readConfig();scenario=createScenario(config);sim=createSimulation(config,scenario);
  if(preview)advance(sim,18);
  $('tokens').replaceChildren();
  selectedId=sim.tasks.find(t=>t.stage==='review')?.id || sim.tasks[0]?.id;filter='all';comparison=null;
  lastDetailSignature=lastFeedSignature=lastRecordSignature='';$('dirty-note').textContent='';
  render();renderComparison();
}
function select(id){selectedId=id;lastDetailSignature='';render();}
function step(minutes){if(sim.time>=600){setPlaying(false);toast('600분 관찰을 마쳤어요. 미해결 건은 그대로 남겨 둡니다.');return;}advance(sim,Math.min(minutes,600-sim.time));render();if(sim.tasks.every(t=>TERMINAL.has(t.stage))){setPlaying(false);}}
function updateInputLabels(){ $('count-value').textContent=`${$('count').value}건`;$('arrival-value').textContent=`${$('arrival').value}분`;$('reviewers-value').textContent=`${$('reviewers').value}명`;if(sim&&JSON.stringify(readConfig())!==JSON.stringify(sim.config))$('dirty-note').textContent='조건이 바뀌었어요. 다시 시작하면 적용됩니다.';else $('dirty-note').textContent='';}

function render(){
  const m=summarize(sim),pendingArrived=m.arrived-m.completed;
  $('metric-unresolved').innerHTML=`${pendingArrived}<em>건</em>`;$('metric-arrived').textContent=`도착 ${m.arrived}건 중 · 검토 ${m.reviewQueue}건`;
  $('metric-time').innerHTML=`${num(m.avgLeadTime)}<em>분</em>`;
  $('metric-errors').innerHTML=`${m.writeCount?m.wrongWrites:'—'}<em>건</em>`;$('metric-writes').textContent=m.writeCount?`반영 ${m.writeCount}건과 합성 참값 대조`:'아직 반영한 변경이 없어요';
  $('time-label').textContent=formatTime(sim.time);$('progress-label').textContent=`처리 종료 ${m.completed}/${sim.tasks.length}`;
  $('engine-badge').textContent=sim.config.mode==='agent'?'샘플 추출기 · 모의 AI':sim.config.mode==='rules'?'고정 규칙 시나리오':'수동 작업시간 가정';
  for(const stage of ['incoming','extract','validate','review','done','hold']){
    const count=stage==='hold'?sim.tasks.filter(t=>['hold','scheduled','duplicate'].includes(t.stage)).length:stage==='incoming'?sim.tasks.filter(t=>t.stage==='incoming').length:sim.tasks.filter(t=>t.stage===stage || stage==='validate'&&t.stage==='versionWait').length;
    $(`stage-${stage}`).textContent=count;
  }
  $('floor-insight').textContent=m.reviewQueue?`검토 ${m.reviewQueue}건 · 승인 전에는 반영되지 않아요`:'카드를 눌러 원문과 처리 이유를 확인하세요';
  drawTokens();renderDetail();renderFeed();renderRecords();
}

function drawTokens(){
  const root=$('tokens'),positions={extract:[225,197],validate:[404,197],review:[393,367],apply:[580,279],done:[584,197],hold:[169,360],scheduled:[169,360],duplicate:[169,360],research:[542,350]},slots={};
  for(const t of sim.tasks){
    let token=$(`token-${t.id}`);
    if(t.stage==='incoming'){if(token)token.style.display='none';continue;}
    const bucket=['scheduled','duplicate'].includes(t.stage)?'hold':t.stage==='versionWait'?'validate':t.stage;
    const index=slots[bucket] || 0;slots[bucket]=index+1;
    if(index>=9){if(token)token.style.display='none';continue;}
    if(!token){
      token=document.createElementNS('http://www.w3.org/2000/svg','g');token.id=`token-${t.id}`;token.dataset.id=t.id;token.setAttribute('role','button');token.setAttribute('tabindex','0');token.setAttribute('class','token');
      token.innerHTML='<rect width="44" height="20" rx="4"/><circle cx="7" cy="10" r="2"/><text x="13" y="13"></text><title></title>';
      token.addEventListener('click',()=>select(t.id));token.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(t.id);}});root.append(token);
    }
    const color=t.stage==='review'?'#b97b14':['hold','scheduled','duplicate'].includes(t.stage)?'#b95061':['done','apply'].includes(t.stage)?'#087e61':'#347bd6';
    const fill=t.stage==='review'?'#fff4db':['hold','scheduled','duplicate'].includes(t.stage)?'#fff0f2':['done','apply'].includes(t.stage)?'#edf8f1':'#edf5ff';
    const [x,y]=positions[bucket] || positions.hold;
    token.style.display='';token.style.transform=`translate(${x+(index%3)*48}px,${y+Math.floor(index/3)*24}px)`;
    token.classList.toggle('selected',t.id===selectedId);token.querySelector('rect').setAttribute('fill',fill);token.querySelector('rect').setAttribute('stroke',color);token.querySelector('circle').setAttribute('fill',color);token.querySelector('text').setAttribute('fill',color);token.querySelector('text').textContent=t.id;
    token.setAttribute('aria-label',`${t.id} ${t.productName} ${kindNames[t.kind]} ${stageNames[t.stage]}`);token.querySelector('title').textContent=`${t.id} · ${kindNames[t.kind]} · ${stageNames[t.stage]}`;
  }
}

function renderDetail(){
  const task=sim.tasks.find(t=>t.id===selectedId);
  if(!task){$('case-detail').innerHTML='<div class="empty-detail">공지를 선택하면 변경 전후와 원문이 여기에 나타나요.</div>';return;}
  const product=sim.products.find(p=>p.id===task.productId),write=sim.writes.find(w=>w.taskId===task.id);
  const signature=JSON.stringify([task,product]);if(signature===lastDetailSignature)return;lastDetailSignature=signature;
  const originalBefore=write?.before || product;
  const candidate=task.candidate?.changes || task.changes;
  const sourceParts=task.sourceText.split('\n\n'),humanText=sourceParts.length>1?sourceParts[0]:task.sourceText;
  const rows=Object.entries(candidate).map(([field,value])=>`<tr><td>${escape(fieldNames[field] || field)}</td><td>${escape(fieldValue(field,originalBefore?.[field]))}</td><td>${escape(fieldValue(field,value))}</td></tr>`).join('');
  const canReview=task.stage==='review';
  const statusClass=['review','hold','done','scheduled','research'].includes(task.stage)?task.stage:task.stage==='duplicate'?'hold':'';
  const appliedText=task.effectiveAt===null?'적용일 없음':task.effectiveAt===0?'시나리오 시작부터':`시작 후 ${task.effectiveAt}분`;
  $('case-detail').innerHTML=`
    <div class="bank-heading"><span class="bank-avatar">${escape(task.bank.replace('가상','').slice(0,1))}</span><div><h3>${escape(task.bank)}</h3><p>${escape(task.productName)} · ${escape(task.id)}</p></div></div>
    <div class="status-block"><span class="status-pill ${statusClass}">${stageNames[task.stage]}</span><p class="reason-line">${escape(task.reason)}</p></div>
    <div class="source-box"><div class="mini-label"><span>변경 원문 · 합성 공지</span><span>v${task.version}</span></div><blockquote>${escape(humanText)}</blockquote><div class="source-meta"><span>${escape(task.sourceUrl)}</span><span>적용: ${escape(appliedText)}</span></div><details class="source-fields"><summary>원문 필드와 출처 지문 보기</summary><pre>${escape(task.sourceText)}\n\n${escape(task.sourceFingerprint)}</pre></details></div>
    <div class="change-heading">${write?'반영 전 → 반영한 값':'현재 DB → 변경 후보'}</div><table class="change-table"><thead><tr><th>변경 항목</th><th>이전 값</th><th>${write?'반영한 값':'후보 값'}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="role-list"><div><b>${sim.config.mode==='agent'?'AI 모의':sim.config.mode==='manual'?'수동':'규칙'}</b><span>필드 후보와 원문 근거 확인</span></div><div><b>검증</b><span>날짜·숫자·버전·충돌 확인</span></div><div><b>담당자</b><span>중요 변경의 승인·보류 결정</span></div></div>
    <div class="decision-actions"><button class="primary" id="approve" ${canReview?'':'disabled'}>${write?'반영 완료':'검토 후 승인'}</button><button class="quiet" id="hold" ${canReview?'':'disabled'}>반영 보류</button></div>
    <button class="stale-button" id="revise" ${canReview?'':'disabled'}>원문이 바뀌면? · 승인 무효화 체험</button>`;
  $('approve').addEventListener('click',()=>makeDecision('approve',task.reviewFingerprint));$('hold').addEventListener('click',()=>makeDecision('hold',task.reviewFingerprint));
  $('revise').addEventListener('click',()=>{setPlaying(false);const result=reviseSource(sim,selectedId);lastDetailSignature='';render();toast(result.reason);});
}
function makeDecision(decision,fingerprint){
  setPlaying(false);const result=decide(sim,selectedId,decision,fingerprint);
  if(result.ok&&decision==='approve')advance(sim,2);
  lastDetailSignature='';render();toast(result.ok?(sim.tasks.find(t=>t.id===selectedId)?.reason || result.reason):result.reason);
}

function filteredTasks(){return sim.tasks.filter(t=>filter==='all'||filter==='hold'&&['hold','scheduled','duplicate'].includes(t.stage)||filter==='done'&&t.stage==='done'||filter===t.stage);}
function renderFeed(){
  const tasks=filteredTasks();const signature=JSON.stringify([tasks.map(t=>[t.id,t.stage,t.reason]),selectedId,filter]);if(signature===lastFeedSignature)return;lastFeedSignature=signature;
  $('feed-count').textContent=`${tasks.length}건`;
  document.querySelectorAll('.filter').forEach(button=>button.classList.toggle('active',button.dataset.filter===filter));
  $('case-feed').innerHTML=tasks.length?tasks.map(t=>`<button class="case-card ${selectedId===t.id?'selected':''}" data-id="${t.id}" aria-label="${escape(`${t.id} ${kindNames[t.kind]} ${stageNames[t.stage]}`)}"><span class="status-pill ${['review','hold','done','scheduled','research'].includes(t.stage)?t.stage:''}">${stageNames[t.stage]}</span><span class="case-time">${t.id} · ${t.arrivesAt}m</span><h3>${escape(kindNames[t.kind])}</h3><p>${escape(t.bank)} · ${escape(t.productId)}</p></button>`).join(''):'<div class="blank-filter">이 상태의 공지가 아직 없어요. 시간을 진행하거나 다른 상태를 선택하세요.</div>';
  $('case-feed').querySelectorAll('[data-id]').forEach(button=>button.addEventListener('click',()=>select(button.dataset.id)));
}

function renderRecords(){
  const signature=JSON.stringify([recordTab,sim.products,sim.research,sim.log]);if(signature===lastRecordSignature)return;lastRecordSignature=signature;
  document.querySelectorAll('.record-tab').forEach(button=>button.classList.toggle('active',button.dataset.tab===recordTab));
  if(recordTab==='db'){
    $('record-content').innerHTML=`<table class="data-table"><thead><tr><th>상품</th><th>금리</th><th>한도</th><th>판매</th><th>심의필</th><th>버전</th></tr></thead><tbody>${sim.products.map(p=>`<tr><td>${escape(p.bank)} · ${escape(p.id)}</td><td class="${p.version>1?'modified':''}">${fieldValue('rate',p.rate)}</td><td>${fieldValue('limit',p.limit)}</td><td>${fieldValue('active',p.active)}</td><td>${escape(p.reviewId)}</td><td>v${p.version}</td></tr>`).join('')}</tbody></table>`;
  }else if(recordTab==='research'){
    $('record-content').innerHTML=sim.research.length?`<table class="data-table"><thead><tr><th>사건</th><th>경쟁상품</th><th>조사한 변경</th><th>출처</th><th>처리 시간</th></tr></thead><tbody>${sim.research.map(r=>`<tr><td>${r.eventId}</td><td>${escape(r.productId)}</td><td>${escape(Object.entries(r.changes).map(([k,v])=>`${fieldNames[k]} ${fieldValue(k,v)}`).join(', '))}</td><td>${escape(r.sourceUrl)}</td><td>${r.time}분</td></tr>`).join('')}</tbody></table>`:'<div class="record-empty">경쟁상품 공지가 들어오면 이곳에 따로 기록합니다. 제휴상품 DB를 덮어쓰지 않습니다.</div>';
  }else{
    $('record-content').innerHTML=sim.log.length?sim.log.slice(-120).reverse().map(item=>`<div class="log-row"><time>${formatTime(item.time)}</time><span>${escape(item.taskId)} · ${escape(stageNames[item.type] || ({arrive:'접수',extract:'추출',decision:'결정'}[item.type] || item.type))}</span><span>${escape(item.message)}</span></div>`).join(''):'<div class="record-empty">시간을 진행하면 접수·검토·반영 기록이 쌓입니다.</div>';
  }
}

function compare(){
  const config=readConfig(),events=createScenario(config);comparison={config:{...config,autoReview:true},results:['manual','rules','agent'].map(mode=>({mode,summary:summarize(finishSimulation({...config,mode,autoReview:true},events))}))};renderComparison();toast('같은 원문으로 세 방식의 결과를 계산했어요.');
}
function renderComparison(){
  if(!comparison){$('comparison-results').className='comparison-empty';$('comparison-results').innerHTML='<span class="compare-symbol">≋</span><div><b>같은 조건에서 비교해야 차이가 보여요.</b><p>검토·보류까지 포함한 가상 처리시간과 사람의 작업량을 계산합니다.</p></div>';return;}
  const maxTime=Math.max(...comparison.results.map(r=>r.summary.elapsed)),c=comparison.config;
  $('comparison-results').className='';$('comparison-results').innerHTML=`<div class="comparison-grid">${comparison.results.map(({mode,summary:m})=>`<article class="comparison-card ${mode==='agent'?'featured':''}"><h3>${modeNames[mode]}</h3><p class="sub">${mode==='agent'?'고정 샘플 추출 결과를 사용':'작업시간·처리 경로 가정'}</p><div class="compare-time">${m.elapsed}<small>가상 분 · 관찰 종료</small></div><div class="time-bar"><i style="width:${m.elapsed/maxTime*100}%"></i></div><div class="compare-stat"><span>사람의 작업량</span><b>${m.totalHumanMinutes} 인·분</b></div><div class="compare-stat"><span>평균 처리시간</span><b>${num(m.avgLeadTime)}분</b></div><div class="compare-stat"><span>반영 / 잘못 반영</span><b>${m.applied} / ${m.wrongWrites}건</b></div><div class="compare-stat"><span>보류 / 적용 예정</span><b>${m.held} / ${m.scheduled}건</b></div><div class="compare-stat"><span>중복 제외 / 조사</span><b>${m.duplicates} / ${m.research}건</b></div><div class="compare-stat"><span>미해결 / 최대 검토 큐</span><b>${m.unresolved} / ${m.maxReviewQueue}건</b></div></article>`).join('')}</div><p class="compare-footnote"><b>비교 조건:</b> 공지 ${c.count}건 · ${c.arrivalInterval}분마다 도착 · 검토 ${c.reviewers}명 · 시드 ${c.seed} · 내부 자동 반영 ${c.automation===0?'없음':c.automation===1?'수집 시각':'수집 시각·출처 해시'}. 가상 담당자가 검토합니다. 추출/검증 시간은 수동 6/4분, 규칙 3/3분, 모의 AI 1/2분, 검토 ${c.reviewMinutes}분입니다. 사람의 작업량은 각 가상 담당자의 작업시간을 합산한 값이며 실제 절감 성과가 아닙니다. 보류·예약도 처리 종료에 포함하고, 600분 안에 끝나지 않은 일은 미해결로 표시합니다.</p>`;
}

function exportRun(){
  const report={title:'금융상품 운영실 실행 기록',runId:`run-${runGeneration}`,scope:'합성 데이터·가상 시간·샘플 추출기. 실제 회사 운영 성과나 모델 정확도가 아님.',config:sim.config,time:sim.time,summary:summarize(sim),tasks:sim.tasks,products:sim.products,research:sim.research,writes:sim.writes,log:sim.log,comparison,localExperiments};
  const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='financial-product-ops-run.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('현재 실행 기록을 JSON으로 저장했어요.');
}

async function loadModels(){
  $('models-refresh').disabled=true;$('model-status').textContent='로컬 Ollama 모델을 확인하고 있어요…';
  try{const response=await fetch('/api/models');const result=await response.json();if(!response.ok)throw new Error(result.error || '모델 목록을 확인할 수 없습니다.');
    $('model-select').innerHTML=result.models.map(name=>`<option value="${escape(name)}">${escape(name)}</option>`).join('') || '<option>설치된 모델 없음</option>';
    modelAvailable=Boolean(result.models.length);$('model-status').textContent=result.models.length?`설치된 모델 ${result.models.length}개. 선택한 합성 원문만 내 컴퓨터의 모델로 보냅니다.`:'Ollama는 실행 중이지만 설치된 모델이 없어요.';$('extract-local').disabled=!modelAvailable;
  }catch(error){modelAvailable=false;$('model-status').textContent=error.message;$('model-select').innerHTML='<option>로컬 모델 연결 안 됨</option>';$('extract-local').disabled=true;
  }finally{$('models-refresh').disabled=false;}
}
async function extractLocal(){
  const task=sim.tasks.find(t=>t.id===selectedId);if(!task){toast('먼저 공지를 선택하세요.');return;}
  const requestGeneration=runGeneration,requestConfig=structuredClone(sim.config),event=structuredClone(task),product=structuredClone(sim.products.find(p=>p.id===task.productId) || null),model=$('model-select').value;
  $('extract-local').disabled=true;$('model-output').textContent=`${event.id} · ${event.productName}\n로컬 모델 ${model}이 원문을 읽고 있어요…`;
  try{const response=await fetch('/api/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,sourceText:event.sourceText})});const result=await response.json();if(!response.ok)throw new Error(result.error || '추출에 실패했습니다.');
    if(requestGeneration!==runGeneration)return;
    const validation=validateCandidate(event,result.candidate,product),record={runId:`run-${requestGeneration}`,config:requestConfig,dbSnapshotVersion:product?.version || null,eventId:event.id,sourceFingerprint:event.sourceFingerprint,model,candidate:result.candidate,validation,elapsedMs:result.elapsedMs};localExperiments.push(record);
    $('model-output').textContent=`대상: ${event.id} · ${event.productName}\n실제 모델 응답: ${num(result.elapsedMs/1000)}초\n추출 요청 시점 DB ${product?`v${product.version}`:'미등록'} 기준: ${validation.ok?'검증 통과':'보류'}\n${validation.reason}\n\n${JSON.stringify(result.candidate,null,2)}\n\n이 결과는 시뮬레이션 DB에 반영하지 않았습니다.`;
  }catch(error){if(requestGeneration===runGeneration)$('model-output').textContent=`추출하지 못했어요.\n${error.message}\n\n샘플 결과로 대체하지 않았으며 상품 DB도 바뀌지 않았습니다.`;
  }finally{if(requestGeneration===runGeneration)$('extract-local').disabled=!modelAvailable;}
}

for(const id of ['count','arrival','reviewers','review-time','automation','mode','auto-review'])$(id).addEventListener('input',updateInputLabels);
$('rerun').addEventListener('click',()=>{reset();toast('새 조건으로 00:00부터 시작해요.');});$('reset').addEventListener('click',()=>{reset();toast('시간·승인·DB·비교 결과를 초기화했어요.');});
$('play').addEventListener('click',()=>{if(sim.time>=600){toast('다시 시작해 새 조건을 시험하세요.');return;}setPlaying(!playing);});$('step').addEventListener('click',()=>{setPlaying(false);step(5);});
$('next-review').addEventListener('click',()=>{const tasks=sim.tasks.filter(t=>t.stage==='review');if(!tasks.length){toast('검토 대기 중인 공지가 없어요.');return;}const index=tasks.findIndex(t=>t.id===selectedId);select(tasks[(index+1)%tasks.length].id);});
document.querySelectorAll('.filter').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;renderFeed();}));
document.querySelectorAll('.record-tab').forEach(button=>button.addEventListener('click',()=>{recordTab=button.dataset.tab;renderRecords();}));
document.querySelectorAll('.station').forEach(station=>{const activate=()=>{const stage=station.dataset.stage;const tasks=sim.tasks.filter(t=>stage==='hold'?['hold','scheduled','duplicate'].includes(t.stage):t.stage===stage || stage==='validate'&&t.stage==='versionWait');if(tasks.length){select(tasks[0].id);filter=['review','hold','done'].includes(stage)?stage:'all';renderFeed();}else toast(`${stageNames[stage]} 상태의 공지가 없어요.`);};station.addEventListener('click',activate);station.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();}});});
$('compare').addEventListener('click',compare);$('export').addEventListener('click',exportRun);
$('guide-open').addEventListener('click',()=>{$('guide-dialog').showModal();setPlaying(false);});$('model-open').addEventListener('click',()=>{$('model-dialog').showModal();setPlaying(false);});
document.querySelectorAll('.dialog-close').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
$('models-refresh').addEventListener('click',loadModels);$('extract-local').addEventListener('click',extractLocal);
setInterval(()=>{if(playing)step(Number($('speed').value));},500);
reset({preview:true});updateInputLabels();
