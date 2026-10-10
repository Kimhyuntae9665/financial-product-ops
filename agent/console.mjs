const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const list = (value) => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
const statusNames = { pending: '검토 대기', 'pending-review': '검토 대기', approved: '승인 · 반영 대기', applied: '반영 완료', held: '보류', hold: '보류', stale: '원문 변경 · 재조사 필요', scheduled: '적용일 대기', running: '실행 중', completed: '완료', done: '완료', success: '성공', failed: '실패', error: '오류', queued: '대기' };
const taskNames = { partner: '제휴 공지 조사', competitor: '경쟁상품 조사', public: '공개 페이지 읽기', apply: '승인 건 반영' };
let state = null, selectedId = null, requestBusy = false, polling = false, initializedNotice = false, noticeDirty = false;
const displayStatus = (status) => statusNames[status] || status || '상태 미제공';
const pretty = (value) => value === undefined ? '반환값 미제공' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const rateText = (value) => value === undefined || value === null || value === '' ? '—' : String(value).replace(/%$/, '');
const when = (value) => { if (!value) return '시각 미제공'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); };
function feedback(message, error = false) { $('feedback').textContent = message; $('feedback').classList.toggle('error', error); $('feedback').hidden = !message; }
async function api(path, body) {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Finance-Client': 'local-demo' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || result.error || result.message || `요청 실패 (${response.status})`);
  return result;
}
function proposalView(proposal) {
  if (!proposal) return null;
  const view = { ...proposal, ...proposal.candidate, previousRate: proposal.previousRate ?? proposal.snapshot?.rate, status: ({ 'pending-review': 'pending', hold: 'held' })[proposal.status] || proposal.status };
  const source = list(state?.domain?.sources).find((item) => item.id === proposal.sourceId);
  const product = list(state?.domain?.products).find((item) => item.id === view.productId);
  if (view.status !== 'applied' && ((source && proposal.sourceRevision !== undefined && source.revision !== proposal.sourceRevision) || (product && proposal.dbVersion !== undefined && product.version !== proposal.dbVersion))) view.status = 'stale';
  return view;
}
function currentProposal() { return proposalView(list(state?.domain?.proposals).find((p) => String(p.id) === String(selectedId))); }
function validationOf(proposal) {
  if (!proposal) return { errors: [], checks: [], provided: false };
  const validation = proposal.validation || proposal.validationResult || proposal.checks;
  const errors = list(proposal.validationErrors || proposal.errors || validation?.errors || validation?.reasons).slice();
  const checks = list(validation?.checks || (Array.isArray(validation) ? validation : []));
  const event = list(state?.domain?.events).findLast((item) => (item.toolName || item.name) === 'finance_propose' && (item.result?.proposal?.id === proposal.id || item.result?.proposalId === proposal.id));
  if (proposal.status === 'stale') errors.push('출처 또는 DB 버전이 제안 생성 당시와 다릅니다. 새 원문을 조사해 주세요.');
  return { errors, checks, provided: Boolean(validation || proposal.validationErrors || proposal.errors || event), valid: proposal.valid ?? validation?.valid ?? validation?.ok ?? validation?.passed ?? event?.result?.ok };
}
function renderButtons() {
  const busy = requestBusy || Boolean(state?.busy), proposal = currentProposal(), validation = validationOf(proposal);
  document.querySelectorAll('[data-task]').forEach((button) => { button.disabled = busy || !state; });
  $('reset-button').disabled = busy || !state;
  $('notice-button').disabled = busy || !state || !$('notice-text').value.trim();
  $('approve-button').disabled = busy || !proposal || proposal.status !== 'pending' || validation.errors.length > 0 || validation.valid === false;
  $('hold-button').disabled = busy || !proposal || !['pending', 'approved', 'scheduled'].includes(proposal.status);
  $('apply-button').disabled = busy || !proposal || proposal.status !== 'approved';
  $('notice-text').disabled = busy;
}
function renderProposal() {
  const proposals = list(state?.domain?.proposals).map(proposalView);
  if (!proposals.some((p) => String(p.id) === String(selectedId))) selectedId = proposals.at(-1)?.id ?? null;
  $('proposal-count').textContent = `제안 ${proposals.length}건`;
  $('proposal-tabs').innerHTML = proposals.slice().reverse().map((p) => `<button class="proposal-tab ${String(p.id) === String(selectedId) ? 'active' : ''}" data-proposal="${escape(p.id)}" aria-pressed="${String(p.id) === String(selectedId)}">${escape(p.id)} · ${escape(displayStatus(p.status))}</button>`).join('');
  const proposal = currentProposal(), archives = list(state?.domain?.archives);
  const archive = archives.find((a) => a.id === (proposal?.archiveId || proposal?.sourceArchiveId)) || archives.find((a) => a.hash === (proposal?.sourceHash || proposal?.archiveHash)) || archives.filter((a) => a.sourceId === (proposal?.sourceId || 'partner')).at(-1);
  $('source-original').textContent = archive?.rawText || archive?.text || proposal?.rawText || '공지를 조사하면 수집한 원문이 여기에 표시됩니다.';
  const archiveHash = archive?.hash || archive?.contentHash;
  $('archive-info').textContent = archive ? `출처 ${archive.sourceId || archive.id || '—'}${archiveHash ? ` · 해시 ${String(archiveHash).slice(0, 14)}…` : ''}` : '';
  $('proposal-status').textContent = proposal ? displayStatus(proposal.status) : '조사 전';
  if (!proposal) {
    $('proposal-detail').innerHTML = '<p class="empty-copy">아직 변경 제안이 없습니다.<br>‘공지 조사 시키기’를 눌러 실제 Agent를 실행하세요.</p>';
    $('decision-help').textContent = '제안이 도착하면 결정할 수 있습니다.';
  } else {
    const product = list(state?.domain?.products).find((p) => p.id === (proposal.productId || 'partner-loan'));
    const oldRate = proposal.previousRate ?? proposal.oldRate ?? proposal.before?.rate ?? product?.rate;
    const quote = proposal.quote || proposal.evidenceQuote || proposal.evidence?.quote;
    const dateQuote = proposal.dateQuote || proposal.effectiveDateQuote;
    $('proposal-detail').innerHTML = `<div class="rate-change"><span class="old">${escape(rateText(oldRate))}<small>%</small></span><span class="arrow">→</span><span class="new">${escape(rateText(proposal.rate))}<small>%</small></span></div><p class="detail-row"><b>적용일</b>${escape(proposal.effectiveDate || '미확인')}</p><p class="detail-row"><b>출처</b>${escape(proposal.sourceId || archive?.sourceId || '미확인')}</p>${proposal.conditions ? `<p class="detail-row"><b>조건</b>${escape(pretty(proposal.conditions))}</p>` : ''}<p class="quote-label">금리 근거 · 원문 인용</p><blockquote class="exact-quote">${escape(quote || '인용 근거 미제공')}</blockquote>${dateQuote ? `<p class="quote-label">적용일 근거 · 원문 인용</p><blockquote class="exact-quote">${escape(dateQuote)}</blockquote>` : ''}`;
    $('decision-help').textContent = proposal.status === 'approved' ? '승인을 저장했습니다. ‘승인 건 반영 시키기’를 누르면 Agent가 반영 도구를 호출합니다.' : proposal.status === 'applied' ? '반영 작업이 완료되었습니다. 오른쪽 고객 화면과 아래 실행 기록을 확인하세요.' : proposal.status === 'stale' ? '원문이 바뀌었습니다. 새 공지를 다시 조사한 뒤 검토하세요.' : proposal.status === 'held' ? '담당자가 보류했습니다. 현재 상품 값은 유지됩니다.' : '원문 인용과 검증 결과를 확인하세요. 승인과 반영은 각각 기록됩니다.';
  }
  const validation = validationOf(proposal);
  const latestProposalEvent = list(state?.domain?.events).findLast((item) => (item.toolName || item.name) === 'finance_propose');
  if (latestProposalEvent?.result?.ok === false && (!proposal || latestProposalEvent.args?.archiveId === proposal.archiveId || !proposals.some((item) => item.archiveId === latestProposalEvent.args?.archiveId))) validation.errors.push(latestProposalEvent.result.error || latestProposalEvent.result.code || '변경 제안 생성이 거부되었습니다.');
  $('validation-badge').textContent = validation.errors.length || validation.valid === false ? '오류 · 반영 차단' : !proposal ? '제안 대기' : validation.valid === true ? '검증 통과' : '검증 결과 확인';
  const rows = validation.errors.map((error) => `<p class="validation-item error"><span class="check">!</span><span>${escape(typeof error === 'string' ? error : error.message || error.reason || pretty(error))}</span></p>`);
  rows.push(...validation.checks.map((check) => `<p class="validation-item ${check.ok === false || check.passed === false ? 'error' : ''}"><span class="check">${check.ok === false || check.passed === false ? '!' : '✓'}</span><span>${escape(typeof check === 'string' ? check : check.message || check.name || check.label || pretty(check))}</span></p>`));
  $('validation-detail').innerHTML = rows.join('') || `<p class="empty-copy">${!proposal ? '원문 근거·날짜·출처·DB 버전의 실제 검증 결과를 표시합니다.' : proposal.status==='applied' ? '반영 도구가 승인·최신 원문·DB 버전을 재확인하고 변경을 저장했습니다.' : validation.valid === true ? '서버의 검증을 통과했습니다. 담당자의 승인 후 반영 작업을 요청할 수 있습니다.' : validation.provided ? '서버가 제공한 검증 상세를 실행 기록에서 확인하세요.' : '별도 검증 상세가 아직 제공되지 않았습니다. 도구의 실제 반환값을 확인하세요.'}</p>`;
}
function renderEvents() {
  const events = list(state?.domain?.events), opened = new Set([...document.querySelectorAll('.event[open]')].map((node) => node.dataset.event));
  $('event-count').textContent = `${events.length}건`;
  $('event-list').innerHTML = events.length ? events.slice().reverse().map((event, index) => {
    const key = String(event.id || `${event.at}-${event.toolName || event.name}-${events.length - index}`), failed = event.ok === false || event.success === false || ['failed', 'error', 'rejected'].includes(event.status), title = event.toolName || event.name || event.type || '실행 이벤트';
    const elapsed = event.elapsedMs ?? (event.completedAt && event.startedAt ? new Date(event.completedAt) - new Date(event.startedAt) : undefined);
    return `<details class="event" data-event="${escape(key)}" ${opened.has(key) ? 'open' : ''}><summary><span class="event-icon ${failed ? 'failed' : ''}">${failed ? '!' : '↗'}</span><time class="event-time">${escape(when(event.at || event.timestamp || event.startedAt))}</time><span class="event-title">${escape(title)}<span class="event-kind">${escape(event.actor || event.kind || (title.startsWith('finance_') ? '도구 호출' : '업무 기록'))} · 입력 / 반환값 펼치기</span></span><span class="event-result ${failed ? 'failed' : ''}">${escape(failed ? '실패' : event.ok === true || event.success === true ? '성공' : displayStatus(event.status || '기록'))}</span><span class="event-duration">${elapsed === undefined ? '—' : `${escape(elapsed)}ms`}</span></summary><div class="event-body"><div><b>입력 · ARGUMENTS</b><pre>${escape(pretty(event.args ?? event.input))}</pre></div><div><b>반환값 · RESULT</b><pre>${escape(pretty(event.result ?? event.output ?? event.error))}</pre></div></div></details>`;
  }).join('') : '<p class="empty-copy">아직 실행된 도구가 없습니다. 위에서 조사 작업을 요청하세요.</p>';
  $('run-list').innerHTML = list(state?.runs).slice(-5).reverse().map((run) => `<div class="run-card"><b>${escape(taskNames[run.task] || run.task)} · ${escape(displayStatus(run.status))}</b><small>${escape(run.id)} · ${escape(when(run.startedAt))}${run.endedAt ? ` → ${escape(when(run.endedAt))}` : ''}${Number.isFinite(run.elapsedMs)?` · 전체 ${(run.elapsedMs/1000).toFixed(1)}초`:''}</small><small>모델 실행 ${run.cliStatus==='completed'?'정상 종료':run.cliStatus==='error'?'오류':'진행 중'} · 도구 결과 ${run.outcomeStatus==='succeeded'?'성공':run.outcomeStatus==='failed'?'차단 / 미완료':'확인 중'}</small>${run.error ? `<div class="run-error">${escape(typeof run.error === 'string' ? run.error : pretty(run.error))}</div>` : ''}</div>`).join('');
}
function renderResearch() {
  const items = [...list(state?.domain?.research), ...list(state?.domain?.reports), ...list(state?.domain?.archives).filter((archive) => archive.synthetic === false || archive.kind === 'public-research').map((archive) => ({ title: '실제 공개 페이지 · 수집 원문', sourceUrl: archive.sourceUrl, sourceId: archive.sourceId, capturedAt: archive.capturedAt, bytes: archive.bytes, contentHash: archive.contentHash, rawText: String(archive.rawText || archive.text || '').slice(0, 3000), note: '본문 앞부분 최대 3,000자 · 전체 도구 반환값은 실행 기록에서 확인' }))];
  $('research-list').innerHTML = items.length ? items.slice().reverse().map((item) => {
    const href = item.url || item.sourceUrl;
    const safeHref = typeof href === 'string' && /^https?:\/\//i.test(href) ? href : null;
    return `<article class="research-result"><h3>${escape(item.title || item.name || item.task || item.id || '조사 결과')}</h3>${safeHref ? `<a href="${escape(safeHref)}" target="_blank" rel="noreferrer">${escape(safeHref)} ↗</a>` : ''}<pre>${escape(pretty(item))}</pre></article>`;
  }).join('') : '<p class="empty-copy">경쟁상품 조사 또는 공개 페이지 읽기 결과가 여기에 표시됩니다.</p>';
  const run = list(state?.runs).findLast((item) => item.output);
  if (run) {
    let output = run.output;
    try { const parsed = JSON.parse(output); const payloads = parsed.payloads || parsed.result?.payloads; if (Array.isArray(payloads)) output = payloads.map((item) => item.text || '').filter(Boolean).join('\n\n') || output; } catch {}
    $('research-list').insertAdjacentHTML('beforeend', `<details class="research-result"><summary>미검증 모델 답변 원문 · ${escape(taskNames[run.task] || run.task)}</summary><p class="empty-copy">모델 설명에는 표현 오류가 있을 수 있습니다. 변경값·승인·반영 여부는 위의 검증된 도구 결과와 현재 DB에서 확인하세요.</p><pre>${escape(output)}</pre></details>`);
  }
}
function render() {
  const model = state?.model || {}, connected = model.connected === true;
  $('connection-dot').className = `connection-dot ${connected ? 'connected' : 'failed'}`;
  $('connection-label').textContent = connected ? (model.compute && model.compute !== 'this-pc' ? '원격 PC 모델 연결됨' : '로컬 모델 연결됨') : '모델 연결 확인 필요';
  $('model-status').textContent = `${model.name || 'Qwen'}${model.compute && model.compute !== 'this-pc' ? ` · Tailscale / 원격 ${model.backend||'CPU'} 추론` : model.endpoint ? ` · ${model.endpoint}` : ''}`;
  const active = list(state?.runs).findLast((run) => ['running', 'queued'].includes(run.status));
  $('run-status').textContent = state?.busy ? `${taskNames[active?.task] || active?.task || 'Agent'} 실행 중 · 실제 응답 대기` : '작업 요청 가능 · 2초마다 상태 확인';
  const product = list(state?.domain?.products).find((p) => p.id === 'partner-loan') || list(state?.domain?.products)[0];
  $('customer-name').textContent = product?.name || product?.title || '제휴 대출상품';
  $('customer-rate').innerHTML = `${escape(rateText(product?.rate))}<small>%</small>`;
  $('customer-version').textContent = product?.version ?? '—';
  $('customer-applied').textContent = product ? product.updatedAt ? when(product.updatedAt) : '현재 저장값' : '상품 데이터 대기';
  const notice = state?.demoNotices?.partner ?? state?.domain?.demoNotices?.partner;
  if (notice !== undefined && document.activeElement !== $('notice-text') && (!noticeDirty || !initializedNotice)) {
    $('notice-text').value = typeof notice === 'string' ? notice : notice.rawText || notice.text || '';
    initializedNotice = true;
  }
  renderProposal(); renderEvents(); renderResearch(); renderButtons();
}
async function refresh() {
  if (polling) return;
  polling = true;
  try { state = await api('/api/state'); render(); }
  catch (error) { $('connection-dot').className = 'connection-dot failed'; $('connection-label').textContent = '서버 연결 실패'; $('run-status').textContent = String(error.message); document.querySelectorAll('button').forEach((button) => { button.disabled = true; }); }
  finally { polling = false; }
}
async function perform(path, body, message) {
  if (requestBusy || state?.busy) return;
  requestBusy = true; renderButtons(); feedback('요청을 보내는 중입니다.');
  try { await api(path, body); feedback(message); await refresh(); }
  catch (error) { feedback(error.message || String(error), true); }
  finally { requestBusy = false; renderButtons(); }
}
document.querySelectorAll('[data-task]').forEach((button) => button.addEventListener('click', () => perform('/api/run', { task: button.dataset.task }, `${taskNames[button.dataset.task]}를 요청했습니다. 실제 도구 실행 기록을 확인하세요.`)));
$('proposal-tabs').addEventListener('click', (event) => { const button = event.target.closest('[data-proposal]'); if (!button) return; selectedId = button.dataset.proposal; renderProposal(); renderButtons(); });
$('approve-button').addEventListener('click', () => perform('/api/decision', { proposalId: selectedId, decision: 'approve' }, '담당자 승인을 저장했습니다. 반영 작업을 별도로 요청하세요.'));
$('hold-button').addEventListener('click', () => perform('/api/decision', { proposalId: selectedId, decision: 'hold' }, '담당자 보류를 저장했습니다.'));
$('apply-button').addEventListener('click', () => perform('/api/run', { task: 'apply', proposalId: selectedId }, '승인 건 반영을 Agent에게 요청했습니다. DB 반영 도구의 결과를 확인하세요.'));
$('notice-text').addEventListener('input', () => { noticeDirty = true; renderButtons(); });
$('notice-button').addEventListener('click', async () => { await perform('/api/notice', { text: $('notice-text').value, sourceId: 'partner' }, '합성 공지를 수정했습니다. ‘공지 조사 시키기’로 새 원문을 다시 조사하세요.'); });
$('reset-button').addEventListener('click', async () => { await perform('/api/reset', {}, '데모 상태를 초기화했습니다.'); noticeDirty = false; initializedNotice = false; selectedId = null; await refresh(); });
await refresh();
setInterval(refresh, 2000);
