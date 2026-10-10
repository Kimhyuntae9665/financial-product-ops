import test from 'node:test';
import assert from 'node:assert/strict';
import {renderOpsMap} from './ops-map.mjs';

const product = {id:'demo', name:'합성 대출', bank:'가상 금융사', rate:4.5, version:1, active:true};
const item = {id:'case-1', noticeId:'notice-1', sourceChannel:'llm', sourceText:'표시 금리를 3.76%로 변경합니다.', sourceRevision:1, expectedProductVersion:1, status:'pending', candidate:{changes:{rate:3.76}}, aiInterpretation:{changes:[{field:'rate',value:3.76,quote:'표시 금리를 3.76%로 변경합니다.'}], effectiveDate:'2026-10-09', checks:[{status:'passed',label:'원문 근거 일치'}]}};
function fixture() {
  const root = {writes:0, points:[], get innerHTML(){return this.html;}, set innerHTML(value){this.writes++;this.html=value;this.points=[...value.matchAll(/data-map-stage="([^"]+)"/g)].map(match=>({dataset:{mapStage:match[1]}, listeners:{}, addEventListener(type,listener){this.listeners[type]=listener;}}));}, querySelectorAll(){return this.points;}};
  globalThis.document = {getElementById:id => id === 'ops-map' ? root : null};
  return root;
}

test('candidate and actual DB stay separate; stationary token follows pending and applied state',()=>{
  const root=fixture();renderOpsMap({caseItem:item,product});
  assert.match(root.html,/om-candidate-value[^>]*>3\.76%/);
  assert.match(root.html,/om-current-value[^>]*>4\.50%/);
  assert.match(root.html,/om-token-halo" cx="712" cy="239"/);
  assert.match(root.html,/AI는 여기까지/);
  renderOpsMap({caseItem:{...item,status:'applied',after:{version:2}},product:{...product,rate:3.76,version:2}});
  assert.match(root.html,/om-token-halo" cx="941" cy="239"/);
  assert.match(root.html,/om-current-value[^>]*>3\.76%/);
  assert.doesNotMatch(root.html,/is-waiting/);
});
test('actual model wait and invalidation suppress previous candidates and quotes',()=>{
  const root=fixture();const old={...item,aiInterpretation:{...item.aiInterpretation,changes:[{field:'rate',value:3.76,quote:'UNIQUE_OLD_QUOTE'}]}};
  renderOpsMap({caseItem:old,product,busy:true,draftSource:'새 입력'});
  assert.doesNotMatch(root.html,/3\.76|UNIQUE_OLD_QUOTE/);
  assert.match(root.html,/om-record-token is-waiting/);
  assert.match(root.html,/om-token-halo" cx="306" cy="239"/);
  renderOpsMap({caseItem:{...old,status:'held',aiInterpretation:null},product});
  assert.doesNotMatch(root.html,/3\.76|UNIQUE_OLD_QUOTE|is-waiting/);
  assert.match(root.html,/이전 해석 폐기/);
  assert.match(root.html,/om-token-halo" cx="616" cy="322"/);
});
test('held, conflict, scheduled, research and stale records use meaningful exception branches',()=>{
  const root=fixture();
  for(const [status,label] of [['held','검증 확인 필요'],['conflict','변경 충돌 확인'],['scheduled','미래 적용일 보관'],['research','경쟁상품 조사']]){
    renderOpsMap({caseItem:{...item,status},product});assert.match(root.html,/om-exception is-active/);assert.ok(root.html.includes(label));
  }
  renderOpsMap({caseItem:item,product:{...product,version:2}});
  assert.match(root.html,/DB 버전 재검토/);assert.match(root.html,/기준 v1 → 현재 v2/);
  renderOpsMap({caseItem:{...item,status:'held',steps:[{name:'review',status:'held'}]},product});
  assert.match(root.html,/담당자 보류/);
});
test('newer DB, legacy record and recent request errors retain their distinct meanings',()=>{
  const root=fixture();renderOpsMap({caseItem:{...item,status:'applied',after:{version:2}},product:{...product,rate:4.1,version:3}});
  assert.match(root.html,/이 건 승인값 3\.76% · 현재 상품 DB 4\.10%/);
  renderOpsMap({caseItem:{...item,sourceChannel:'rule',aiInterpretation:null},product});assert.match(root.html,/형식 규칙 추출/);assert.match(root.html,/AI 사용 없음/);
  renderOpsMap({caseItem:item,product,analysisError:'요청 <실패>'});assert.match(root.html,/role="alert"/);assert.match(root.html,/요청 &lt;실패&gt;/);assert.match(root.html,/3\.76%/);
});
test('polling preserves nodes and updates callback; pointer and keyboard select the right stages',()=>{
  const root=fixture();let selected='';renderOpsMap({caseItem:item,product,onSelectStage:stage=>selected='old:'+stage});
  const points=root.points;renderOpsMap({caseItem:structuredClone(item),product:{...product},onSelectStage:stage=>selected='new:'+stage});
  assert.equal(root.writes,1);assert.equal(root.points,points);
  points.find(point=>point.dataset.mapStage==='review').listeners.click();assert.equal(selected,'new:review');
  let prevented=false;points.find(point=>point.dataset.mapStage==='ai').listeners.keydown({key:' ',preventDefault(){prevented=true;}});assert.equal(selected,'new:ai');assert.equal(prevented,true);
  points.find(point=>point.dataset.mapStage==='validation').listeners.keydown({key:'Enter',preventDefault(){}});assert.equal(selected,'new:validation');
  points[0].listeners.keydown({key:'Escape',preventDefault(){throw Error('Unexpected prevention');}});assert.equal(selected,'new:validation');
  assert.deepEqual(points.map(point=>point.dataset.mapStage),['source','ai','validation','review','output','exceptions']);
});
test('untrusted record data is escaped and empty scene is ready for input',()=>{
  const root=fixture();const malicious='<script>bad()</script>';
  renderOpsMap({caseItem:{...item,noticeId:malicious,aiInterpretation:{...item.aiInterpretation,changes:[{field:'reviewId',value:malicious,quote:malicious}]}},product});
  assert.doesNotMatch(root.html,/<script>/);assert.match(root.html,/&lt;script&gt;/);
  renderOpsMap({product});assert.match(root.html,/선택된 공지 없음/);assert.doesNotMatch(root.html,/is-waiting/);
});
test('notice label shows actual revision while original ID remains in title; check caption uses real totals',()=>{
  const root=fixture(),noticeId='ai-normal-550e8400-e29b-41d4-a716-446655440000';
  const checks=Array.from({length:7},(_,index)=>({label:'검사 '+index,status:'passed'}));
  const selected={...item,noticeId,sourceRevision:3,aiInterpretation:{...item.aiInterpretation,checks}};
  renderOpsMap({caseItem:selected,product});
  assert.match(root.html,/<title>ai-normal-550e8400-e29b-41d4-a716-446655440000 · 담당자 판단 대기<\/title>/);
  assert.match(root.html,/class="om-token-label"[^>]*>선택 공지 · r3<\/text>/);
  assert.doesNotMatch(root.html,/class="om-token-label"[^>]*>ai-normal-/);
  assert.match(root.html,/검사 7\/7 통과/);
  renderOpsMap({caseItem:{...selected,aiInterpretation:{...selected.aiInterpretation,checks:[]}},product});
  assert.match(root.html,/검증 대기/);assert.doesNotMatch(root.html,/검사 0\/0 통과/);
  renderOpsMap({caseItem:{...selected,status:'held',aiInterpretation:{...selected.aiInterpretation,checks:checks.map((check,index)=>({...check,status:index<2?'failed':'passed'}))}},product});
  assert.match(root.html,/2개 확인 필요/);assert.doesNotMatch(root.html,/검사 5\/7 통과/);
});
