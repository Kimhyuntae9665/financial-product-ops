const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fieldNames={rate:'표시 금리',limit:'대출 한도',reviewId:'심의필',active:'판매 상태'};
const number=value=>Number.isFinite(Number(value))?Number(value).toLocaleString('ko-KR',{maximumFractionDigits:2}):'—';
const valueText=(field,value)=>value==null?'—':field==='rate'?number(value)+'%':field==='limit'?number(value/10000)+'만원':field==='active'?(value?'판매 중':'판매 중지'):String(value);
const renderedMaps=new WeakMap();
const short=(value,length=72)=>String(value??'').length>length?String(value).slice(0,length-1)+'…':String(value??'');
const meta=(label,value)=>'<span class="om-meta-row"><span>'+esc(label)+'</span><b title="'+esc(value)+'">'+esc(value)+'</b></span>';
function station(stage,number,title,actor,body,note,state='',routeReached=false){
 return '<button type="button" class="om-station om-'+stage+' '+state+(routeReached?' route-reached':'')+'" data-map-stage="'+stage+'" aria-label="'+esc(title)+' 상세 보기"><span class="om-stage-label"><span>'+number+'</span>'+esc(title)+'<span class="om-inspect" aria-hidden="true">↗</span></span><span class="om-actor">'+esc(actor)+'</span><span class="om-object">'+body+'</span><span class="om-stage-note">'+note+'</span><span class="om-connector" aria-hidden="true"></span></button>';
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
 const visibleChecks=[...checks.filter(x=>x.status==='failed'),...checks.filter(x=>x.status!=='failed')].slice(0,4);
 const heldByReviewer=c?.steps?.some(step=>step.name==='review'&&step.status==='held');
 const diverted=!busy&&['held','conflict','scheduled','research','stale'].includes(status);
 const applied=status==='applied';
 const changes=a?.changes||(legacy&&!busy?Object.entries(c.candidate?.changes||{}).map(([field,value])=>({field,value,quote:c.candidate?.evidence?.find(e=>e.field===field)?.quote})):[]);
 const change=changes.find(x=>x.field==='rate')||changes[0];
 const quote=change?.quote||'';
 const candidate=change?valueText(change.field,change.value):busy?'응답 대기':invalidated?'재분석 필요':'변경값 대기';
 const newerDB=applied&&!!product&&(c.after?.version!=null?c.after.version!==product.version:Object.entries(c.candidate?.changes||{}).some(([field,value])=>product[field]!==value));
 const headline={empty:'금융상품 변경 처리 흐름',busy:'원문 분석 중 · 모델 응답 대기',pending:'코드 검증 완료 · 담당자 판단 대기',applied:newerDB?'이 건 승인 완료 · 현재 DB는 별도 조회':'담당자 승인 완료 · 상품 DB 반영',held:invalidated?'원문 변경 · 이전 AI 해석 무효':heldByReviewer?'담당자 판단 · 반영 보류':'검증 확인 필요 · 반영 보류',conflict:'변경 충돌 · 재확인 필요',stale:'DB 버전 변경 · 재검토 필요',scheduled:'미래 적용일 · 예정 기록 보관',research:'경쟁상품 공지 · 조사 기록 보관'}[status]||'공지 처리 상태 확인';
 const badge={empty:'접수 전',busy:'분석 중',pending:'담당자 대기',applied:'반영 완료',held:'반영 보류',conflict:'충돌 확인',stale:'DB 변경 · 재검토',scheduled:'적용 예정 기록',research:'조사 기록'}[status]||'상태 확인';
 const sourceText=String((busy?draftSource:c?.sourceText)||'금융사의 상품 변경 공지\n변경값 · 적용일 · 대상 고객\n합성 공지를 선택해 시작하세요');
 const sourceLines=sourceText.split('\n').filter(Boolean).slice(0,4);
 const source='<span class="om-record-label">접수 원문</span><span class="om-source-bank">'+esc(busy?'분석 요청 원문':product?.bank||'금융사 공지')+'</span><span class="om-source-lines" title="'+esc(sourceText)+'">'+sourceLines.map(line=>'<span>'+esc(short(line,44))+'</span>').join('')+'</span>'+meta('원문 버전',busy?'새 분석 요청':c?'r'+c.sourceRevision:'접수 대기');
 const aiTitle=legacy?'형식 규칙 추출':busy?'실제 모델 응답 대기':invalidated?'이전 해석 폐기':a?'실제 모델 추출 결과':'변경 후보 생성';
 const date=a?.effectiveDate||(legacy?c?.candidate?.effectiveDate:null);
 const conditions=a?.conditions||[];
 const scope=a?(conditions.length?conditions.join(' · '):'별도 제한 미추출'):legacy?'기존 규칙 기반 기록':busy?'응답 후 표시':'분석 후 표시';
 const ai='<span class="om-record-label '+(busy?'is-busy':'')+'">'+esc(aiTitle)+'</span><span class="om-candidate"><span>'+esc(change?fieldNames[change.field]||change.field:'변경 후보')+'</span><strong>'+esc(candidate)+'</strong></span><span class="om-quote" title="'+esc(quote)+'">'+(quote?'“'+esc(short(quote,70))+'”':busy?'새 응답 전에는 이전 후보를 표시하지 않습니다.':invalidated?'수정한 원문을 다시 분석해야 합니다.':legacy?'AI가 아닌 형식 규칙의 추출 기록입니다.':modelStatus?.connected?'로컬 모델의 값과 원문 근거를 표시합니다.':'로컬 모델 연결 후 원문을 분석합니다.')+'</span>'+meta('적용일',date||(a?'미추출':invalidated?'재분석 필요':busy?'응답 대기':'추출 대기'))+meta('추출 조건',scope)+'<span class="om-model" title="'+esc(a?.model||'')+'">'+(a?esc(a.model)+(Number.isFinite(a.elapsedMs)?' · '+number(a.elapsedMs/1000)+'초':''):legacy?'AI 사용 없음':busy?'응답 시간 측정 중':'값 · 근거 · 조건을 추출')+'</span>';
 const verificationTitle=busy?'응답 후 검증':invalidated?'새 분석 필요':stale?'분석 당시 결과':a?(failed?'확인 필요':'검증 통과'):legacy?(c.status==='held'?'규칙 확인 필요':'규칙 검사 완료'):'검증 대기';
 const verification='<span class="om-record-label">'+esc(verificationTitle)+'</span><span class="om-check-counts"><span class="om-count-pass"><strong>'+(a?passed:'—')+'</strong>통과</span><span class="om-count-fail '+(failed?'has-failure':'')+'"><strong>'+(a?failed:'—')+'</strong>확인 필요</span></span><span class="om-check-list">'+(a?visibleChecks.map(check=>'<span class="om-check '+esc(check.status)+'"><i aria-hidden="true">'+(check.status==='passed'?'✓':'!')+'</i>'+esc(check.label)+'</span>').join(''):['원문 근거 · 수치','적용일 · 고객 범위','원문 · DB 버전'].map(label=>'<span class="om-check"><i aria-hidden="true">·</i>'+label+'</span>').join(''))+'</span><span class="om-check-foot">'+(stale?'현재 DB 변경 · 승인 전 재검토':a&&checks.length>4?'전체 '+checks.length+'개 검사'+(failed?' · 확인 필요 우선':' · 상세 보기 ↗'):legacy?'기존 형식 규칙 검사 기록':'모델 자기 평가와 별도 수행')+'</span>';
 const reviewerLabel=busy||!c?'판단 대기':status==='pending'?'승인 · 보류 검토':applied?'승인 완료':heldByReviewer?'반영 보류':diverted?'승인 경로 중지':'판단 대기';
 const reviewer='<span class="om-record-label">최종 반영 여부</span><strong class="om-decision '+(applied?'is-approved':heldByReviewer||diverted?'is-held':'')+'">'+reviewerLabel+'</strong><span class="om-review-copy">'+(applied?'담당자가 승인한 변경 기록입니다.':status==='pending'?'원문과 코드 검사 결과를 확인한 후 결정합니다.':heldByReviewer?'담당자가 반영을 보류했습니다.':'코드 검증을 통과한 후보만 승인 검토로 이동합니다.')+'</span>'+meta('원문 기준',c&&!busy?'r'+c.sourceRevision:'대기')+meta('DB 기준',c&&!busy&&c.expectedProductVersion!=null?'v'+c.expectedProductVersion:'대기')+'<span class="om-check-foot">승인 직전 원문 · DB 버전 재확인</span>';
 const output='<span class="om-record-label">현재 DB 조회</span><span class="om-output-product" title="'+esc(product?.name||'')+'">'+esc(product?.name||'현재 상품')+'</span><span class="om-current-rate"><strong>'+esc(product?valueText('rate',product.rate):'—')+'</strong><span>현재 표시 금리</span></span>'+meta('상품 DB',product?'v'+product.version:'조회 전')+meta('판매 상태',product?valueText('active',product.active):'조회 대기')+'<span class="om-output-caption">고객 상품 화면은 현재 DB 값을 조회</span>';
 const branchTitle=invalidated?'원문 수정 → 새 분석 필요':stale?'DB 변경 → 재검토 필요':status==='conflict'?'변경 충돌 → 다시 확인':status==='scheduled'?'미래 적용일 → 예정 기록':status==='research'?'경쟁상품 → 조사 기록':heldByReviewer?'담당자 보류 → 확인 업무함':failed?'검증 확인 필요 → 확인 업무함':'보류 → 확인 업무함';
 const branchNote=stale?'분석 기준 v'+esc(c.expectedProductVersion)+' → 현재 DB v'+esc(product.version)+' · 이전 검토로 승인 불가':status==='scheduled'?'적용일 '+esc(c?.candidate?.effectiveDate||'확인 필요')+' · 자동 반영하지 않음':status==='research'?'조사 기록만 저장 · 자사 상품 DB 유지':invalidated?'이전 AI 응답 무효 · 새 원문 분석과 검증 필요':esc(c?.reason||'업무함에서 검토할 내용 확인');
 const activeTo=!c||busy||invalidated?0:diverted?(heldByReviewer?3:2):applied?4:3;
 const outputNote=newerDB?'승인값 '+esc(change?valueText(change.field,change.value):'기록 확인')+' · 현재 DB 별도 조회':applied?'승인값 반영 · 현재 DB 조회':'승인 전 기존 DB 유지';
 const requestError=!busy&&analysisError?'<div class="om-request-error" role="alert"><b>최근 AI 분석 요청 실패</b> '+esc(analysisError)+'<span>기존 선택 기록 유지 · 새 모델 응답 없음</span></div>':'';
 const pathNote=applied?(newerDB?'승인 이력과 현재 DB를 구분합니다. 이후 변경은 현재 DB 조회에 포함됩니다.':'담당자 승인 후 DB 반영 완료 · 고객 화면은 현재 DB를 조회합니다.'):status==='pending'?'현재 지점: 담당자 판단 · 승인 전에는 기존 상품 DB를 유지합니다.':busy?'새 모델 응답 대기 · 응답 이후 코드 검증을 수행합니다.':'원문 → AI 후보 → 코드 검증 → 담당자 판단 → 상품 DB';
 root.innerHTML='<div class="om-scene '+(diverted?'has-diversion':'')+' '+(busy?'is-thinking':'')+'"><div class="om-heading"><div><span class="om-eyebrow">CHANGE CONTROL / 변경 처리 흐름</span><h2>'+headline+'</h2></div><span class="om-state '+(diverted?'is-held':applied?'is-applied':busy?'is-busy':'')+'" role="status">'+badge+'</span></div>'+requestError+'<p class="om-lead">'+(legacy?'이 기록은 형식 규칙으로 추출했습니다. 담당자가 승인한 변경만 상품 DB에 반영합니다.':'AI가 만든 후보를 코드로 검증하고, 담당자가 승인한 변경만 상품 DB에 반영합니다.')+'</p><div class="om-process"><div class="om-stations">'+station('source','01','금융사 공지','INPUT / 원문 보존',source,busy?'지금 분석을 요청한 입력':c?'접수 원문을 그대로 보존':'한국어 공지로 시작',c?'is-reached':'',activeTo>=1)+station('ai','02',legacy?'규칙 추출':'AI 변경 후보',legacy?'RULE / 기존 형식 추출':'AI / 값과 근거 추출',ai,legacy?'규칙 추출 · AI 사용 없음':'<b>AI는 여기까지</b><span>변경 후보와 근거 생성</span>',a||legacy?'is-reached':busy?'is-current':'',activeTo>=2)+station('validation','03','코드 검증','CODE / 규칙 대조',verification,'코드가 근거 · 조건 · 버전 검증',failed||invalidated||stale?'is-blocked':a||legacy?'is-reached':'',activeTo>=3)+station('review','04','담당자 판단','HUMAN / 최종 결정',reviewer,'사람이 승인 · 보류 결정',applied?'is-reached':status==='pending'?'is-current':'',activeTo>=4)+station('output','05','상품 DB · 고객 화면','OUTPUT / 현재값 조회',output,outputNote,applied?'is-reached':'')+'</div><div class="om-branch-row">'+(diverted?'<button type="button" class="om-branch" data-map-stage="exceptions"><span class="om-branch-mark" aria-hidden="true">!</span><span><strong>'+branchTitle+'</strong><span>'+branchNote+'</span></span><b>기록 확인 ↗</b></button>':'<div class="om-path-note"><span class="om-path-key" aria-hidden="true"></span>'+pathNote+'</div>')+'</div></div><div class="om-observation"><span><b>01 → 05</b> 원문부터 현재 DB까지</span><span><b>파란색</b> '+(legacy?'규칙이 추출한 변경 후보':'AI가 추출한 변경 후보')+'</span><span><b>상세 확인 ↗</b> 각 단계를 눌러 근거와 기록 확인</span></div></div>';
 root.querySelectorAll('[data-map-stage]').forEach(button=>button.addEventListener('click',()=>{if(typeof record.onSelectStage==='function')record.onSelectStage(button.dataset.mapStage);}));
}
