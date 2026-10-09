const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fieldNames={rate:'표시 금리',limit:'대출 한도',reviewId:'심의필',active:'판매 상태'};
const number=value=>Number.isFinite(Number(value))?Number(value).toLocaleString('ko-KR',{maximumFractionDigits:2}):'—';
const valueText=(field,value)=>value==null?'—':field==='rate'?number(value)+'%':field==='limit'?number(value/10000)+'만원':field==='active'?(value?'판매 중':'판매 중지'):String(value);
const renderedMaps=new WeakMap();
const icon=(name)=>{
 const paths={
  sparkle:'<path d="m20 3 4 12 12 4-12 4-4 12-4-12-12-4 12-4Z"/><path d="m36 31 2 6 6 2-6 2-2 6-2-6-6-2Z"/>',
  shield:'<path d="M24 4 41 11v13c0 11-17 20-17 20S7 35 7 24V11Z"/><path d="m16 24 6 6 11-13"/>',
  human:'<circle cx="24" cy="14" r="8"/><path d="M8 42v-7a16 16 0 0 1 32 0v7M17 35l5 5 10-11"/>',
  tray:'<path d="M7 17h34l4 22H3Zm0 0 5-10h24l5 10M4 29h12l4 6h8l4-6h12"/>',
  db:'<ellipse cx="24" cy="10" rx="17" ry="6"/><path d="M7 10v26c0 8 34 8 34 0V10M7 23c0 8 34 8 34 0"/>',
 };
 return '<svg class="om-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths[name]+'</svg>';
};
function station(stage,number,title,body,note,state=''){
 return '<button type="button" class="om-station om-'+stage+' '+state+'" data-map-stage="'+stage+'" aria-label="'+esc(title)+' 상세 보기"><span class="om-stage-label"><span>'+number+'</span>'+esc(title)+'</span><span class="om-object">'+body+'</span><span class="om-stage-note">'+note+'</span><span class="om-inspect">상세 보기 ↗</span></button>';
}

// No side effects beyond #ops-map. The caller owns selection and panel navigation.
export function renderOpsMap({caseItem=null,product=null,busy=false,modelStatus=null,draftSource='',analysisError=null,onSelectStage}={}){
 const root=document.getElementById('ops-map');if(!root)return;
 const signature=JSON.stringify([caseItem,product,busy,modelStatus,draftSource,analysisError]);
 const record=renderedMaps.get(root)||{};record.onSelectStage=onSelectStage;
 if(record.signature===signature)return;
 record.signature=signature;renderedMaps.set(root,record);
 const c=caseItem,a=busy?null:c?.aiInterpretation;
 const legacy=!busy&&!!c&&c.sourceChannel!=='llm';
 const invalidated=!busy&&!!c&&!legacy&&!c.aiInterpretation;
 const stale=!busy&&c?.status==='pending'&&!!product&&c.expectedProductVersion!==product.version;
 const status=busy?'busy':stale?'stale':c?.status||'empty';
 const checks=a?.checks||[],passed=checks.filter(x=>x.status==='passed').length,failed=checks.filter(x=>x.status==='failed').length;
 const heldByReviewer=c?.steps?.some(step=>step.name==='review'&&step.status==='held');
 const diverted=!busy&&['held','conflict','scheduled','research','stale'].includes(status);
 const applied=status==='applied';
 const changes=a?.changes||(legacy&&!busy?Object.entries(c.candidate?.changes||{}).map(([field,value])=>({field,value,quote:c.candidate?.evidence?.find(e=>e.field===field)?.quote})):[]);
 const change=changes.find(x=>x.field==='rate')||changes[0];
 const quote=change?.quote||'';
 const candidate=change?valueText(change.field,change.value):busy?'응답 대기':invalidated?'재분석 필요':'변경값 대기';
 const newerDB=applied&&!!product&&(c.after?.version!=null?c.after.version!==product.version:Object.entries(c.candidate?.changes||{}).some(([field,value])=>product[field]!==value));
 const headline={empty:'공지부터 읽어보세요',busy:'AI가 원문을 읽는 중',pending:'검증을 통과했어요. 이제 담당자의 판단',applied:newerDB?'이 건은 승인 완료 · 현재 DB는 별도 조회':'승인한 변경이 고객 화면까지 도착했어요',held:invalidated?'원문이 바뀌어 다시 읽어야 해요':heldByReviewer?'담당자가 반영을 보류했어요':'확인이 필요한 공지는 별도 경로로',conflict:'다른 변경과 충돌해 다시 확인해요',stale:'DB가 바뀌어 재검토가 필요해요',scheduled:'적용일 전까지 상품 DB를 유지해요',research:'경쟁상품은 조사 자료로 남겨요'}[status]||'이 공지의 처리 상태를 확인하세요';
 const badge={empty:'접수 전',busy:'응답 대기',pending:'담당자 대기',applied:'반영 완료',held:'반영 보류',conflict:'충돌 확인',stale:'DB 변경 · 재검토',scheduled:'적용 예정 기록',research:'조사 기록'}[status]||'상태 확인';
 const sourceLines=String((busy?draftSource:c?.sourceText)||'금융사의 상품 변경 공지\n변경값 · 적용일 · 대상 고객\n합성 공지를 선택해 시작하세요').split('\n').filter(Boolean).slice(0,4);
 const paper='<span class="om-paper"><span class="om-paper-bank">'+esc(busy?'분석 요청 원문':product?.bank||'금융사 공지')+'</span><span class="om-paper-title">상품 변경 안내</span><span class="om-paper-lines">'+sourceLines.map(line=>'<span>'+esc(line)+'</span>').join('')+'</span><span class="om-paper-stamp">'+(busy?'지금 요청한 입력 원문':c?'접수 원문 · r'+esc(c.sourceRevision):'입력할 한국어 공지')+'</span></span>';
 const aiTitle=legacy?'규칙 추출':busy?'읽고 있습니다':invalidated?'이전 해석 폐기':a?'실제 모델 응답':'한국어 → 변경 후보';
 const ai='<span class="om-ai-machine"><span class="om-ai-machine-head">'+icon('sparkle')+'<span>'+(legacy?'RULE EXTRACTOR':'NOTICE READER')+'</span><span class="om-machine-light '+(busy?'is-busy':'')+'"></span></span><span class="om-machine-title">'+aiTitle+'</span><span class="om-fact-row"><span>'+esc(change?fieldNames[change.field]||change.field:'변경 후보')+'</span><strong>'+esc(candidate)+'</strong></span><span class="om-quote-label">'+(quote?'원문에서 인용한 근거':'값과 근거를 함께 확인')+'</span><span class="om-quote">'+(quote?'“'+esc(quote)+'”':busy?'새 응답이 올 때까지 이전 후보를 표시하지 않습니다.':invalidated?'원문 수정 후 이전 AI 응답은 무효입니다.':legacy?'형식 규칙으로 추출한 기록입니다.':modelStatus?.connected?'실제 로컬 모델이 읽은 결과를 표시합니다.':'로컬 모델을 연결하고 공지를 읽어보세요.')+'</span><span class="om-model">'+(a?esc(a.model)+(Number.isFinite(a.elapsedMs)?' · '+number(a.elapsedMs/1000)+'초':''):legacy?'기존 규칙 기반 기록':busy?'진행률은 추정하지 않습니다.':'변경값 · 인용문 · 적용 조건')+'</span></span>';
 const verificationTitle=busy?'응답 후 검증':invalidated?'다시 분석 필요':stale?'분석 당시 검증':a?(failed?'확인 필요':'검증 통과'):legacy?(c.status==='held'?'규칙 확인 필요':'규칙 검사 완료'):'검증 대기';
 const shield='<span class="om-verification '+(failed||invalidated||stale?'has-failure':'')+'">'+icon('shield')+'<strong>'+verificationTitle+'</strong><span>'+(a?'<b>'+passed+'</b> 통과 <i>·</i> <b>'+failed+'</b> 확인':legacy?'원문 형식 규칙 검사':'원문 · 수치 · 날짜 대조')+'</span></span><span class="om-check-tags"><span>원문 근거</span><span>고객 범위</span><span>'+(stale?'DB 변경됨':'DB 버전')+'</span></span>';
 const reviewerLabel=busy||!c?'판단 대기':status==='pending'?'승인 · 보류 선택':applied?'승인 완료':heldByReviewer?'보류 선택':diverted?'승인 경로 중지':'판단 대기';
 const reviewer='<span class="om-reviewer"><span class="om-person">'+icon('human')+'</span><span class="om-person-desk"></span><strong>'+reviewerLabel+'</strong><span class="om-reviewer-caption">'+(applied?'반영 직전 버전 재확인':status==='pending'?'원문 근거를 보고 결정':'검증 통과 후 담당자 판단')+'</span></span>';
 const output='<span class="om-output-scene"><span class="om-database">'+icon('db')+'<span>상품 DB</span><b>'+(product?'v'+esc(product.version):'조회 전')+'</b></span><span class="om-output-link" aria-hidden="true">→</span><span class="om-mini-phone"><span class="om-phone-bar"></span><span class="om-phone-brand">고객 상품 화면</span><span class="om-phone-product">'+esc(product?.name||'현재 상품')+'</span><strong>'+esc(product?valueText('rate',product.rate):'—')+'</strong><span class="om-phone-caption">현재 DB 조회 · 금리</span><span class="om-phone-row">'+esc(product?valueText('active',product.active):'상품 조회 대기')+'</span></span></span>';
 const branchTitle=invalidated?'원문 수정 → 새 분석 필요':stale?'DB 변경 → 재검토 필요':status==='conflict'?'충돌 → 다시 확인':status==='scheduled'?'미래 적용일 → 예정 기록':status==='research'?'경쟁상품 → 조사 기록':heldByReviewer?'담당자 보류 → 확인 업무함':failed?'검증 확인 필요 → 확인 업무함':'보류 → 확인 업무함';
 const branchNote=stale?'분석 기준 v'+esc(c.expectedProductVersion)+' → 현재 DB v'+esc(product.version)+' · 이전 검토로 승인할 수 없습니다.':status==='scheduled'?'적용일 '+esc(c?.candidate?.effectiveDate||'확인 필요')+' · 자동 반영하지 않습니다.':status==='research'?'조사 기록만 저장합니다. 자사 상품을 변경하지 않습니다.':invalidated?'새 원문을 다시 읽고 검증해야 합니다.':esc(c?.reason||'검토할 내용은 업무함에서 확인합니다.');
 const activeTo=!c||busy||invalidated?0:diverted?(heldByReviewer?3:2):applied?4:3;
 const line=(x1,x2,edge)=>'<path class="om-route '+(activeTo>=edge?'is-travelled':'')+'" d="M'+x1+' 146H'+x2+'" marker-end="url(#om-arrow-'+(activeTo>=edge?'on':'off')+')"/>';
 const branchX=heldByReviewer?853:invalidated?370:646;
 const outputNote=newerDB?'이 건 승인값: '+esc(change?valueText(change.field,change.value):'승인 기록 확인')+' · 오른쪽은 현재 DB':applied?'승인한 DB 값을 고객 화면에서 조회':'기존 DB 유지 · 후보는 표시 안 함';
 const requestError=!busy&&analysisError?'<div class="om-request-error" role="alert">최근 AI 분석 요청 실패: '+esc(analysisError)+'<span>기존 선택 기록을 유지했습니다. 새 응답이 생성되지 않았습니다.</span></div>':'';
 root.innerHTML='<div class="om-scene '+(diverted?'has-diversion':'')+' '+(busy?'is-thinking':'')+'"><div class="om-heading"><div><span class="om-eyebrow">공지 → 후보 → 판단 → 반영</span><h2>'+headline+'</h2></div><span class="om-state '+(diverted?'is-held':applied?'is-applied':'')+'" role="status">'+badge+'</span></div>'+requestError+'<p class="om-lead">공지를 읽은 결과가 바로 상품을 바꾸지는 않습니다. 근거를 검증하고 담당자가 승인한 값만 반영합니다.</p><div class="om-process"><svg class="om-routes" viewBox="0 0 1200 325" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="om-arrow-on" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 8 5 1 9" fill="none" stroke="#087e61" stroke-width="1.5"/></marker><marker id="om-arrow-off" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 8 5 1 9" fill="none" stroke="#b7c7d0" stroke-width="1.5"/></marker></defs>'+line(145,218,1)+line(460,555,2)+line(720,795,3)+line(928,992,4)+(diverted?'<path class="om-exception-route" d="M'+branchX+' 188V279Q'+branchX+' 298 '+(branchX-19)+' 298H412"/><circle class="om-exception-dot" cx="'+branchX+'" cy="188" r="4"/>':'')+'</svg><div class="om-stations">'+station('source','01','금융사 공지',paper,busy?'지금 분석을 요청한 원문':c?'접수한 원문을 그대로 보존':'원문을 입력해 흐름을 시작',c?'is-reached':'')+station('ai','02',legacy?'규칙이 추출한 내용':'AI가 읽은 내용',ai,legacy?'기존 형식 규칙 기반 · AI 아님':'문장을 값 + 근거로 바꾸기',a||legacy?'is-reached':busy?'is-current':'')+station('validation','03','검증',shield,'모델 응답을 코드로 대조',failed||invalidated||stale?'is-blocked':a||legacy?'is-reached':'')+station('review','04','담당자',reviewer,'사람이 최종 반영 여부 판단',applied?'is-reached':status==='pending'?'is-current':'')+station('output','05','상품 DB · 고객 화면',output,outputNote,applied?'is-reached':'')+'</div><div class="om-branch-row">'+(diverted?'<button type="button" class="om-branch" data-map-stage="exceptions">'+icon('tray')+'<span><strong>'+branchTitle+'</strong><span>'+branchNote+'</span></span><b>확인 ↗</b></button>':'<div class="om-path-note"><span class="om-path-key"></span>'+(applied?(newerDB?'이 건 승인 완료 · 오른쪽은 이후 변경도 반영한 현재 DB 조회':'초록 경로: 담당자 승인 후 실제 상품 DB에 반영'):status==='pending'?'현재 멈춘 지점: 담당자 판단 · 승인 전 DB 유지':busy?'새 모델 응답 대기 · 이후 검증 결과를 확인합니다.':'예외가 생기면 아래 확인 경로로 분기합니다.')+'</div>')+'</div></div><div class="om-observation"><span><b>읽는 순서</b> 01 공지부터 05 고객 화면까지</span><span><b>비교할 값</b> 파란 후보값과 오른쪽 현재 DB 값</span><span><b>직접 확인</b> 각 장면을 누르면 근거와 상세 내용</span></div></div>';
 root.querySelectorAll('[data-map-stage]').forEach(button=>button.addEventListener('click',()=>{if(typeof record.onSelectStage==='function')record.onSelectStage(button.dataset.mapStage);}));
}

