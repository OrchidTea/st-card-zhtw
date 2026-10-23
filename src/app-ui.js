// v0.5 interface. Card text is only ever inserted with textContent; nothing from a
// card is parsed as HTML or executed on this page.
(() => {
const T = globalThis.CardTranslator, AI = TranslatorAI;
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (text, cls, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };
const S = {fileName: '', png: null, input: null, result: null, base: null, draft: null, edits: [], kept: new Set(), resolved: new Map(),
  history: [], review: [], activeTerm: null, aiTerm: new Map(), aiScan: null, suggestions: [], fieldLimit: 30, openPaths: new Set(), check: null, busy: false};

function toast(text) {
  const t = el('div', 'toast', text); document.body.append(t); setTimeout(() => t.remove(), 2600);
}
// ---------- mascot ----------
// State pictures in assets/mascot/. Missing files simply stay hidden.
const mascotStates = ['idle', 'working', 'review', 'ready', 'celebrate'];
const mascotFiles = {working: 'working.webp', review: 'review.webp', ready: 'done.webp', celebrate: 'done.webp'};
let mascotState = null, mascotHold = 0, mascotPending = null;
for (const id of ['mascotBar']) {
  const img = $(id);
  img.addEventListener('load', () => { img.hidden = false; });
  img.addEventListener('error', () => { img.hidden = true; });
}
function setMascot(state) {
  if (!mascotStates.includes(state)) return;
  const wait = mascotHold - Date.now();
  if (wait > 0 && state !== 'working') { clearTimeout(mascotPending); mascotPending = setTimeout(() => setMascot(state), wait); return; }
  if (state === mascotState) return;
  mascotState = state;
  const bar = $('mascotBar'), file = mascotFiles[state];
  if (file && !bar.src.endsWith(file)) bar.src = `assets/mascot/${file}`;
  bar.dataset.state = state; $('mascotTop').dataset.state = state;
  // restart the entrance animation when the same picture is reused
  bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = '';
  const labels = {idle: '等待中', working: '轉換中', review: '請手動確認', ready: '轉換完成', celebrate: '全部確認完成'};
  bar.alt = labels[state];
  const dl = $('downloadBar');
  dl.classList.toggle('ready', state === 'ready'); dl.classList.toggle('celebrate', state === 'celebrate');
}
function setStatus(text, kind = '') { $('status').textContent = text; $('status').className = 'status ' + kind; }

// ---------- dictionary ----------
async function loadDictionary() {
  try {
    const res = await fetch('dictionary.json', {cache: 'no-store'});
    if (res.ok) T.setDictionary(await res.json());
  } catch (error) {
    if (error instanceof SyntaxError) toast('dictionary.json 格式有誤，暫時使用內建詞庫');
  }
  $('dictVersion').textContent = T.getDictionary().version || '內建';
}

// ---------- loading ----------
async function loadFile(file) {
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    let card; S.png = null;
    if (/\.png$/iu.test(file.name)) { S.png = T.readPng(buffer); card = S.png.card; }
    else card = JSON.parse(new TextDecoder().decode(buffer));
    const check = T.inspect(card), info = T.describe(card);
    S.input = card; S.fileName = file.name; S.result = null;
    hideWork();
    $('convert').disabled = check.errors.length > 0;
    updateConvertButton();
    setMascot('idle');
    if (check.errors.length) setStatus('無法轉換：' + check.errors.join('；'), 'bad');
    else setStatus(`已載入「${info.name}」（${info.detail}），按下轉換開始。`, 'good');
  } catch (error) { setStatus('讀取失敗：' + error.message, 'bad'); }
}
function hideWork() {
  for (const id of ['summary', 'aiStep', 'reviewStep', 'searchStep', 'namesStep', 'compareStep', 'checkStep', 'downloadBar']) $(id).hidden = true;
}
function readOptions() {
  const nameCorrections = {};
  for (const line of $('nameCorrections').value.split(/\r?\n/u)) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(i + 1).trim()) nameCorrections[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {useTai: $('useTai').checked, nameCorrections,
    protectedNames: $('protectedNames').value.split(/\r?\n/u).map(s => s.trim()).filter(Boolean)};
}
function convert() {
  if (!S.input) return;
  setMascot('working'); mascotHold = Date.now() + 1200;
  setStatus('轉換中…');
  $('downloadBar').hidden = false; $('downloadStatus').textContent = '轉換中，請稍候…'; $('downloadStatus').className = 'status bubble';
  for (const id of ['downloadJson', 'downloadPng', 'undo']) $(id).disabled = true;
  // Let the browser paint the "working" state before the synchronous conversion.
  setTimeout(runConvert, 40);
}
function runConvert() {
  const started = performance.now();
  try {
    S.result = T.convert(S.input, readOptions());
  } catch (error) { setStatus('轉換失敗：' + error.message, 'bad'); return; }
  S.base = T.U(S.result.output); S.draft = T.U(S.result.output);
  S.edits = []; S.kept = new Set(); S.resolved = new Map(); S.history = []; S.aiTerm = new Map(); S.aiScan = null;
  S.activeTerm = null; S.openPaths = new Set(); S.fieldLimit = 30; S.hadPending = false; S.celebrated = false;
  S.ai = null;
  S.names = {selected: [...new Set(T.existingNameButtons(S.draft))], aiFound: []};
  for (const id of ['summary', 'aiStep', 'reviewStep', 'searchStep', 'namesStep', 'compareStep', 'checkStep', 'downloadBar']) $(id).hidden = false;
  $('namesStep').hidden = S.result.type !== 'card';
  $('reviewStep').hidden = S.result.type !== 'card' && S.result.type !== 'preset';
  setStatus(`轉換完成（${Math.round(performance.now() - started)} 毫秒）。`, 'good');
  updateConvertButton();
  refresh();
  renderNames();
  $('summary').scrollIntoView({behavior: 'smooth', block: 'start'});
  if (AI.ready() && $('useAi').checked) runAiPass();
}
function updateConvertButton() {
  const can = AI.ready(), on = can && $('useAi').checked;
  $('useAiWrap').hidden = !can;
  $('convert').textContent = S.result
    ? (on ? '重新轉換＋AI 校正（會清除目前的修改）' : '重新轉換（會清除目前的修改）')
    : (on ? '一鍵轉成台灣繁中（含 AI 校正）' : '轉換為台灣繁中');
}

// ---------- state helpers ----------
function pushHistory() {
  S.history.push({draft: T.U(S.draft), base: T.U(S.base), edits: [...S.edits], kept: new Set(S.kept), resolved: new Map(S.resolved),
    aiStates: S.ai ? S.ai.proposals.map(p => ({state: p.state, to: p.to})) : null});
  if (S.history.length > 40) S.history.shift();
}
function undo() {
  const last = S.history.pop(); if (!last) return;
  Object.assign(S, {draft: last.draft, base: last.base, edits: last.edits, kept: last.kept, resolved: last.resolved});
  if (S.ai && last.aiStates && last.aiStates.length === S.ai.proposals.length) S.ai.proposals.forEach((p, i) => { p.state = last.aiStates[i].state; p.to = last.aiStates[i].to; p.editing = false; });
  S.aiScan = null; refresh(); toast('已復原上一步');
}
const mirrorOf = path => { const m = path.match(/^\$\/data\/(name|description|personality|scenario|first_mes|mes_example)$/u); return m ? '$/' + m[1] : null; };
const visibleItems = group => group.items.filter(i => !i.mirror);
const pendingCount = () => S.review.reduce((n, g) => n + visibleItems(g).length, 0);

function validate() {
  const r = S.result;
  const ti = T.technicalIntegrity(S.input, S.draft);
  const vm = T.validateManual(S.base, S.draft, S.edits, r.protectedNames || []);
  const codeNotes = vm.warnings.filter(w => w.includes('含程式'));
  return {
    vmErrors: vm.errors.length,
    errors: [...new Set([...r.errors, ...ti.errors, ...vm.errors, ...(r.outputWarnings || []).map(w => 'MVU 引用：' + w)])],
    warnings: [...new Set([...(r.integrityWarnings || []), ...ti.warnings, ...vm.warnings.filter(w => !w.includes('含程式')), ...(r.sourceWarnings || []).map(w => '原卡本來就有：' + w)])],
    codeNotes
  };
}
function refresh() {
  if (!S.result) return;
  S.review = T.reviewScan(S.draft, S.result.frozen || [], S.kept).filter(g => visibleItems(g).length);
  if (S.activeTerm && !S.review.some(g => g.term === S.activeTerm) && !S.resolved.has(S.activeTerm)) S.activeTerm = null;
  S.check = validate();
  // Review decisions only touch unprotected text, so every consistent state becomes the
  // new baseline; name/identifier renames are then checked against the last good state.
  if (!S.check.vmErrors) { S.base = T.U(S.draft); S.edits = []; }
  renderSummary(); renderAi(); renderReview(); renderAuto(); renderAiScan(); renderSearch(); renderNameButtons(); renderCompare(); renderChecks(); renderDownload();
}

// ---------- summary ----------
function renderSummary() {
  const r = S.result, box = $('summary'); box.replaceChildren();
  const changedFields = T.textFields(S.input).filter(f => !T.mirrorField(f.path, S.input) && T.fieldAt(S.draft, f.path) !== f.value).length;
  const autoCount = (r.autoFixes || []).filter(a => !T.mirrorField(a.path, S.input)).length;
  const pending = pendingCount();
  const add = (label, value, cls = '') => { const d = el('div', cls); d.append(el('span', null, label), el('strong', null, value)); box.append(d); };
  add('檔案', S.fileName);
  add('轉換的欄位', `${changedFields} 個`);
  add('自動修正', `${autoCount} 處`);
  if (S.ai && S.ai.status === 'done') { const n = aiPendingCount(); add('AI 建議', n ? `${n} 條待決定` : `${S.ai.proposals.filter(p => p.state === 'accepted').length} 條已套用`, n ? 'warn' : 'good'); }
  add('待確認', pending ? `${pending} 處` : '沒有', pending ? 'warn' : 'good');
  add('技術檢核', S.check.errors.length ? `${S.check.errors.length} 項問題` : '通過', S.check.errors.length ? 'bad' : 'good');
}

// ---------- review ----------
function renderReview() {
  const chips = $('chips'); chips.replaceChildren();
  const pending = pendingCount();
  $('reviewIntro').textContent = pending
    ? '這些詞可能對、也可能錯，要看前後文。點一個詞，決定全部改、全部保留或逐處決定；沒處理的會維持目前寫法，不影響下載。'
    : '目前沒有需要確認的詞。';
  for (const group of S.review) {
    const c = btn(group.term, 'chip' + (S.activeTerm === group.term ? ' active' : ''), () => { S.activeTerm = S.activeTerm === group.term ? null : group.term; renderReview(); renderCompare(); });
    c.append(el('span', 'count', String(visibleItems(group).length)));
    chips.append(c);
  }
  for (const [term, text] of S.resolved) if (!S.review.some(g => g.term === term)) {
    const c = btn(`${term}：${text}`, 'chip done', () => { S.activeTerm = term; renderReview(); });
    chips.append(c);
  }
  renderDecision();
}
function occurrenceView(item, group, actions = true) {
  const row = el('div', 'occ'), body = el('div');
  body.append(el('div', 'where', T.fieldLabel(S.draft, item.path)));
  const ctx = el('div', 'ctx');
  ctx.append(document.createTextNode('…' + item.before), el('mark', null, item.text), document.createTextNode(item.after + '…'));
  body.append(ctx);
  const verdict = S.aiTerm.get(item.key);
  if (verdict) body.append(el('div', 'ai-note', verdict.ok ? `AI：維持「${item.text}」${verdict.reason ? '－' + verdict.reason : ''}` : `AI：建議改成「${verdict.fix}」${verdict.reason ? '－' + verdict.reason : ''}`));
  row.append(body);
  if (actions) {
    const box = el('div', 'occ-actions');
    const options = [...new Set([...(verdict && !verdict.ok && verdict.fix ? [verdict.fix] : []), ...group.suggest])];
    for (const s of options) box.append(btn(`改成「${s}」`, 'small primary', () => changeOne(item, s)));
    box.append(btn('保留', 'small', () => keepOne(item)), btn('看對照', 'small', () => showInCompare(item.path, item.index)));
    row.append(box);
  }
  return row;
}
function renderDecision() {
  const box = $('decision'); box.replaceChildren();
  const term = S.activeTerm;
  if (!term) { box.hidden = true; return; }
  box.hidden = false;
  const group = S.review.find(g => g.term === term);
  if (!group) {
    box.append(el('h3', null, `「${term}」${S.resolved.get(term) || '已處理完畢'}`));
    const row = el('div', 'row');
    row.append(btn('復原上一步', 'small', undo), btn('收起', 'small', () => { S.activeTerm = null; renderReview(); renderCompare(); }));
    box.append(row); return;
  }
  const items = visibleItems(group);
  box.append(el('h3', null, `「${term}」共 ${items.length} 處`));
  if (group.note) box.append(el('p', 'muted', group.note));
  const row = el('div', 'row');
  for (const s of group.suggest) row.append(btn(`全部改成「${s}」`, 'primary', () => changeAll(group, s)));
  row.append(btn('全部保留', null, () => keepAll(group)));
  if (AI.ready()) row.append(btn('請 AI 判斷這些位置', null, () => aiJudgeTerm(group)));
  else row.append(btn('設定 AI 後可自動判斷', 'link', openAiPanel));
  if (items.some(i => { const v = S.aiTerm.get(i.key); return v && !v.ok && v.fix; })) row.append(btn('套用 AI 的建議', 'primary', () => applyAiTerm(group)));
  box.append(row);
  const list = el('div', 'occ-list');
  items.forEach(item => list.append(occurrenceView(item, group)));
  box.append(list);
}
function applyChanges(list) {
  // list: [{path,index,text,to}] — apply from the end of each field so indexes stay valid.
  const sorted = [...list].sort((a, b) => a.path === b.path ? b.index - a.index : a.path < b.path ? -1 : 1);
  let skipped = 0;
  for (const c of sorted) {
    const mirror = mirrorOf(c.path), oldValue = T.fieldAt(S.draft, c.path);
    try {
      T.replaceAt(S.draft, c.path, c.index, c.text, c.to);
      if (mirror && T.fieldAt(S.draft, mirror) === oldValue) T.replaceAt(S.draft, mirror, c.index, c.text, c.to);
    } catch { skipped++; }
  }
  return skipped;
}
function changeOne(item, to) {
  pushHistory(); applyChanges([{...item, to}]);
  const group = S.review.find(g => g.term === item.term);
  if (group && visibleItems(group).length === 1) S.resolved.set(item.term, '已逐處處理');
  refresh();
}
function keepOne(item) {
  pushHistory(); S.kept.add(item.key);
  const group = S.review.find(g => g.term === item.term);
  if (group && visibleItems(group).length === 1) S.resolved.set(item.term, '已逐處處理');
  refresh();
}
function changeAll(group, to) {
  pushHistory();
  const literal = group.items.every(i => i.text === group.term) && ![...S.kept].some(k => k.includes('|' + group.term + '|'));
  let count;
  if (literal) count = T.replaceAllReview(S.draft, group.rule, to, S.result.frozen || []);
  else { const items = group.items; count = items.length; applyChanges(items.map(i => ({...i, to}))); }
  S.resolved.set(group.term, `已全部改為「${to}」`);
  addSuggestion({find: group.term, to, note: '從「需要確認的詞」全部改寫'}, false);
  refresh(); toast(`已把 ${count} 處「${group.term}」改成「${to}」`);
}
function keepAll(group) {
  pushHistory(); S.kept.add('term:' + group.term); S.resolved.set(group.term, '已全部保留'); refresh();
}
async function aiJudgeTerm(group) {
  if (S.busy) return;
  const items = visibleItems(group);
  S.busy = true; toast(`AI 判斷中（${items.length} 處）…`);
  try {
    const verdicts = await AI.judge(items.map((i, n) => ({id: 'o' + n, before: i.before, match: i.text, after: i.after, options: group.suggest})));
    items.forEach((i, n) => { const v = verdicts.get('o' + n); if (v) S.aiTerm.set(i.key, v); });
    renderDecision();
  } catch (error) { toast('AI 失敗：' + error.message); setAiPill('error'); }
  finally { S.busy = false; }
}
function applyAiTerm(group) {
  const list = visibleItems(group).map(i => ({i, v: S.aiTerm.get(i.key)})).filter(x => x.v && !x.v.ok && x.v.fix).map(x => ({...x.i, to: x.v.fix}));
  pushHistory(); const skipped = applyChanges(list); refresh();
  toast(`已套用 ${list.length - skipped} 處 AI 建議`);
}

// ---------- one-click AI localisation ----------
// The AI only proposes; nothing changes until a proposal is accepted, and every accepted
// proposal can be restored. Changes are applied by the page, inside protected-text rules.
const aiPendingCount = () => S.ai && S.ai.status === 'done' ? S.ai.proposals.filter(p => p.state === 'pending').length : 0;
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A correction must be Chinese text of about the same length as what it replaces.
const plausibleFix = (fix, match) => !!fix && /[\p{Script=Han}]/u.test(fix) && !/[A-Za-z0-9]/u.test(fix) && [...fix].length <= [...match].length + 2;
const occOf = src => ({path: src.path, index: src.index, text: src.text, before: String(src.before || '').slice(-8), after: String(src.after || '').slice(0, 8), key: src.key});

async function runAiPass() {
  if (S.busy || !S.result) return;
  if (!AI.ready()) { openAiPanel(); return; }
  S.busy = true;
  S.ai = {status: 'running', progress: '準備中…', proposals: [], okCount: 0, error: '', unreadable: 0};
  const progress = text => { S.ai.progress = text; renderAi(); };
  AI.onWait = seconds => progress(`服務商說請求太頻繁，等 ${seconds} 秒後自動重試…`);
  refresh();
  $('aiStep').scrollIntoView({behavior: 'smooth', block: 'start'});
  const tokens = S.result.frozen || [], proposals = [];
  try {
    // 1. Characters OpenCC often gets wrong, and words whose meaning depends on context.
    const review = S.review.flatMap(g => visibleItems(g).map(i => ({src: i, options: g.suggest, note: g.note})));
    const candidates = T.aiCandidates(S.draft, tokens, S.review, 400);
    const items = [...review.map((x, n) => ({id: 'r' + n, src: x.src, before: x.src.before, match: x.src.text, after: x.src.after, options: x.options, note: x.note})),
      ...candidates.map(c => ({id: c.id, src: c, before: c.before, match: c.text, after: c.after}))];
    if (items.length) {
      const verdicts = await AI.judge(items, (done, total) => progress(`檢查容易轉錯的字（${done}／${total} 處）`));
      const groups = new Map();
      for (const it of items) {
        const v = verdicts.get(it.id);
        if (!v) continue;
        let fix = (v.fix || '').trim(), reason = v.reason;
        if (!v.ok && !plausibleFix(fix, it.match)) {
          reason = `AI 的回覆格式有誤，改用詞庫建議${it.note ? '：' + it.note : ''}`;
          // A garbled answer (a letter, a number, a whole sentence): fall back to the only
          // dictionary suggestion, otherwise leave the word in step 2 for a person.
          if ((it.options || []).length === 1) fix = it.options[0]; else continue;
        }
        // Handled here either way, so it no longer waits in step 2.
        if (it.src.key) S.kept.add(it.src.key);
        if (v.ok || !fix || fix === it.match) { S.ai.okCount++; continue; }
        const k = it.match + '\u0000' + fix;
        if (!groups.has(k)) groups.set(k, {kind: 'typo', from: it.match, to: fix, reason, occ: []});
        groups.get(k).occ.push(occOf(it.src));
      }
      proposals.push(...groups.values());
    }
    // 2. Mainland wording, found by the AI and applied by the page to every matching place.
    const chunks = T.proseChunks(S.draft);
    if (chunks.length) {
      const {found, unreadable} = await AI.wording(chunks, (done, total) => progress(`找出大陸用語（${done}／${total} 段）`));
      S.ai.unreadable = unreadable;
      // Never rename characters or world-book trigger words, even if the AI suggests it.
      const triggers = T.textFields(S.draft).filter(f => /\/(?:keys|secondary_keys|keysecondary)\/\d+$/u.test(f.path)).map(f => f.value.trim());
      const names = [...tokens, ...triggers, ...(S.result.nameMapping || []).map(n => n.after), T.fieldAt(S.draft, '$/data/name') || '']
        .filter(t => typeof t === 'string' && /[\p{Script=Han}]/u.test(t) && t.length > 1);
      const byFrom = new Map();
      for (const g of found) {
        if (!g.from || !g.to || g.from === g.to || !/[\p{Script=Han}]/u.test(g.to) || byFrom.has(g.from) || g.from.length > 12 || g.to.length > 24 || !/[\p{Script=Han}]/u.test(g.from)) continue;
        if (names.some(n => n.includes(g.from) || g.from.includes(n))) continue;
        byFrom.set(g.from, g);
      }
      const taken = proposals.flatMap(p => p.occ.map(o => [o.path, o.index, o.index + o.text.length]));
      const clash = o => taken.some(([path, a, b]) => path === o.path && o.index < b && o.index + o.text.length > a);
      for (const g of [...byFrom.values()].sort((a, b) => b.from.length - a.from.length)) {
        const occ = T.locateAll(S.draft, new RegExp(escapeRe(g.from), 'gu'), tokens).filter(o => !clash(o)).map(occOf);
        if (!occ.length) continue;
        occ.forEach(o => taken.push([o.path, o.index, o.index + o.text.length]));
        proposals.push({kind: 'taiwan', from: g.from, to: g.to, reason: g.reason, occ});
      }
    }
  } catch (error) { S.ai.error = error.message; setAiPill('error'); }
  S.ai.proposals = proposals.sort((a, b) => b.occ.length - a.occ.length).map((p, i) => ({...p, id: 'p' + i, state: 'pending'}));
  AI.onWait = null;
  S.ai.status = 'done'; S.busy = false;
  refresh();
  if (!S.ai.error) toast(S.ai.proposals.length ? `AI 找到 ${S.ai.proposals.length} 條建議` : 'AI 沒有找到需要修改的地方');
}
// Apply (forward) or undo (backward) one proposal at all of its recorded places.
function swapProposal(p, forward) {
  const [from, to] = forward ? [p.from, p.to] : [p.to, p.from];
  let missed = 0;
  for (const o of p.occ) {
    const mirror = mirrorOf(o.path), old = T.fieldAt(S.draft, o.path), mirrorOld = mirror ? T.fieldAt(S.draft, mirror) : null;
    if (!T.swapInContext(S.draft, o, from, to)) { missed++; continue; }
    if (mirror && mirrorOld === old) T.setField(S.draft, mirror, T.fieldAt(S.draft, o.path));
  }
  return missed;
}
function setProposals(list, state) {
  if (!list.length) return;
  pushHistory();
  let missed = 0;
  for (const p of list) {
    if (state === 'accepted' && p.state !== 'accepted') {
      missed += swapProposal(p, true);
      addSuggestion(p.kind === 'taiwan' ? {find: p.from, to: p.to, note: 'AI：台灣用語'}
        : {find: p.occ[0].before.slice(-1) + p.from + p.occ[0].after.slice(0, 1), to: p.occ[0].before.slice(-1) + p.to + p.occ[0].after.slice(0, 1), note: 'AI：錯字'}, false);
    } else if (state !== 'accepted' && p.state === 'accepted') missed += swapProposal(p, false);
    p.state = state;
  }
  refresh();
  const verb = {accepted: '已套用', pending: '已恢復原狀', rejected: '已略過'}[state];
  toast(list.length === 1 ? `${verb}「${list[0].from}」${missed ? `（${missed} 處內容已變動而略過）` : ''}` : `${verb} ${list.length} 條${missed ? `（${missed} 處內容已變動而略過）` : ''}`);
}
// The user types the wording they want; it replaces the AI's suggestion and is applied.
function editProposal(p, to) {
  if (!to || to === p.from) { toast('請輸入要改成的文字'); return; }
  pushHistory();
  let missed = 0;
  if (p.state === 'accepted') missed += swapProposal(p, false);
  p.to = to; p.editing = false; p.edited = true;
  missed += swapProposal(p, true);
  p.state = 'accepted';
  addSuggestion({find: p.from, to, note: '手動指定'}, false);
  refresh();
  toast(`已把「${p.from}」改成「${to}」${missed ? `（${missed} 處內容已變動而略過）` : ''}`);
}
function contextLine(o, shown, field = false) {
  const ctx = el('div', 'ctx');
  if (field) ctx.append(el('span', 'where', T.fieldLabel(S.draft, o.path) + '：'));
  ctx.append(document.createTextNode('…' + o.before), el('mark', null, shown), document.createTextNode(o.after + '…'));
  return ctx;
}
function proposalView(p) {
  const row = el('div', 'prop ' + p.state), body = el('div', 'prop-body');
  const head = el('div', 'prop-head');
  head.append(el('span', 'badge kind-' + p.kind, p.kind === 'taiwan' ? '台灣用語' : '錯字'),
    el('span', 'prop-from', p.from), el('span', 'arrow', '→'), el('span', 'prop-to', p.to), el('span', 'muted', `${p.occ.length} 處`));
  body.append(head);
  if (p.reason) body.append(el('div', 'prop-reason', p.edited ? `你指定的寫法（AI 原本的理由：${p.reason}）` : p.reason));
  const shown = p.state === 'accepted' ? p.to : p.from;
  body.append(contextLine(p.occ[0], shown));
  if (p.occ.length > 1) {
    const more = el('details', 'prop-more'); more.append(el('summary', null, `看全部 ${p.occ.length} 處`));
    more.addEventListener('toggle', () => {
      if (!more.open || more.querySelector('.ctx')) return;
      for (const o of p.occ) { const line = contextLine(o, shown, true); line.append(btn('看對照', 'small link', () => showInCompare(o.path, o.index))); more.append(line); }
    });
    body.append(more);
  }
  const actions = el('div', 'occ-actions');
  if (p.editing) {
    const input = el('input'); input.type = 'text'; input.value = p.to; input.className = 'prop-edit'; input.setAttribute('aria-label', `「${p.from}」要改成`);
    const done = () => editProposal(p, input.value.trim());
    input.addEventListener('keydown', e => { if (e.key === 'Enter') done(); if (e.key === 'Escape') { p.editing = false; renderAi(); } });
    actions.append(input, btn('改好並套用', 'small primary', done), btn('取消', 'small', () => { p.editing = false; renderAi(); }));
    setTimeout(() => { input.focus(); input.select(); }, 0);
  } else if (p.state === 'pending') actions.append(btn('接受', 'small primary', () => setProposals([p], 'accepted')), btn('不要', 'small', () => setProposals([p], 'rejected')));
  else if (p.state === 'accepted') actions.append(el('span', 'state-tag good', '✓ 已套用'), btn('恢復原狀', 'small', () => setProposals([p], 'pending')));
  else actions.append(el('span', 'state-tag', '已略過'), btn('改成接受', 'small', () => setProposals([p], 'accepted')));
  if (!p.editing) actions.append(btn('自己改', 'small', () => { p.editing = true; renderAi(); }));
  row.append(body, actions);
  return row;
}
function renderAi() {
  const box = $('aiResult'); box.replaceChildren();
  const a = S.ai;
  if (!a) {
    const call = el('div', 'ai-call');
    if (AI.ready()) {
      call.append(el('p', null, '讓 AI 幫你修 OpenCC 轉錯的字，並把大陸用語換成台灣說法。AI 只列出建議，按「接受」才會改。'),
        btn('請 AI 校正這張卡', 'primary', runAiPass));
    } else {
      call.append(el('p', null, '設定 AI 之後，按一下就能讓 AI 修錯字、把大陸用語換成台灣說法，你只要看結果按接受。'),
        btn('設定 AI', 'primary', openAiPanel));
    }
    box.append(call); return;
  }
  if (a.status === 'running') {
    const p = el('div', 'ai-running'); p.append(el('span', 'spinner'), el('span', null, 'AI 校正中：' + a.progress));
    box.append(p); return;
  }
  const typo = a.proposals.filter(p => p.kind === 'typo').length, tw = a.proposals.length - typo;
  const accepted = a.proposals.filter(p => p.state === 'accepted'), pending = a.proposals.filter(p => p.state === 'pending');
  const autoCount = autoFixes().length;
  const intro = el('p', 'ai-intro');
  intro.append(document.createTextNode(a.proposals.length
    ? `AI 找到 ${a.proposals.length} 條建議（錯字 ${typo} 條、台灣用語 ${tw} 條）。按「接受」才會套用，套用後也可以恢復原狀。`
    : a.error ? 'AI 這次沒有完成校正。' : 'AI 看完了，沒有找到需要修改的地方。'));
  box.append(intro);
  const facts = [];
  if (autoCount) facts.push(`詞庫已先自動修正 ${autoCount} 處`);
  if (a.okCount) facts.push(`${a.okCount} 處容易轉錯的字，AI 判斷原本就正確`);
  if (facts.length) {
    const more = el('details', 'sub'); more.append(el('summary', null, facts.join('；')));
    more.append(autoListView());
    box.append(more);
  }
  if (a.error) { const e = el('p', 'check-bad', `AI 中途停止：${a.error}。已完成的部分列在下面。`); e.append(btn('重試', 'small', runAiPass)); box.append(e); }
  if (a.unreadable) box.append(el('p', 'check-warn', `有 ${a.unreadable} 段 AI 回覆看不懂，已略過；可以按「重新請 AI 校正」再試一次。`));
  const bar = el('div', 'row ai-bar');
  if (pending.length) bar.append(btn(`全部接受（${pending.length} 條）`, 'primary', () => setProposals(pending, 'accepted')));
  if (accepted.length) bar.append(btn(`全部恢復原狀（${accepted.length} 條）`, null, () => setProposals(accepted, 'pending')));
  bar.append(btn('重新請 AI 校正', 'link', runAiPass));
  box.append(bar);
  const list = el('div', 'prop-list');
  for (const p of a.proposals) list.append(proposalView(p));
  box.append(list);
}

// ---------- auto fixes ----------
const autoFixes = () => (S.result.autoFixes || []).filter(a => !T.mirrorField(a.path, S.input));
function autoListView() {
  const kinds = {auto: '詞庫修正', taiwan: '台灣用語', tai: '台／臺'};
  const list = el('div', 'auto-list');
  const groups = new Map();
  for (const f of autoFixes()) { const k = `${f.kind}|${f.from}|${f.to}`; if (!groups.has(k)) groups.set(k, {...f, n: 0}); groups.get(k).n++; }
  for (const g of [...groups.values()].sort((a, b) => b.n - a.n)) {
    const row = el('div', 'auto-item');
    row.append(el('span', null, `${g.from} → ${g.to}${g.note ? '（' + g.note + '）' : ''}`), el('span', 'muted', `${kinds[g.kind]} · ${g.n} 處`));
    list.append(row);
  }
  return list;
}
function renderAuto() {
  const fixes = autoFixes();
  const counts = {auto: 0, taiwan: 0, tai: 0}; fixes.forEach(f => counts[f.kind]++);
  $('autoSummary').textContent = `已自動修正 ${fixes.length} 處（詞庫修正 ${counts.auto}、台灣用語 ${counts.taiwan}、台／臺 ${counts.tai}）`;
  $('autoList').replaceChildren(...autoListView().children);
}

// ---------- AI scan ----------
function renderAiScan() {
  const box = $('aiScan'); box.replaceChildren();
  if (S.ai) return; // the one-click pass already covers these characters
  const candidates = T.aiCandidates(S.draft, S.result.frozen || [], S.review);
  if (!S.aiScan) {
    if (!candidates.length) return;
    const row = el('div', 'row');
    if (AI.ready()) row.append(btn(`請 AI 檢查其他可能誤轉的字（${candidates.length} 處）`, null, () => runAiScan(candidates)));
    else { row.append(el('span', 'muted', `另有 ${candidates.length} 處容易誤轉的字（例如頭髮／發現、乾／幹），詞庫無法判斷。`)); row.append(btn('設定 AI 來檢查', 'link', openAiPanel)); }
    box.append(row); return;
  }
  const flagged = S.aiScan.items.filter(x => x.v && !x.v.ok && x.v.fix);
  box.append(el('h3', null, `AI 檢查結果：${flagged.length} 處建議修改，其餘 ${S.aiScan.items.length - flagged.length} 處判斷為正確`));
  const list = el('div', 'occ-list');
  for (const x of flagged) {
    const row = el('div', 'occ'), body = el('div');
    const label = el('label', 'check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = x.checked !== false;
    cb.addEventListener('change', () => { x.checked = cb.checked; });
    label.append(cb, el('span', 'where', T.fieldLabel(S.draft, x.path)));
    const ctx = el('div', 'ctx'); ctx.append(document.createTextNode('…' + x.before), el('mark', null, x.text), document.createTextNode(x.after + '…'));
    body.append(label, ctx, el('div', 'ai-note', `建議改成「${x.v.fix}」${x.v.reason ? '－' + x.v.reason : ''}`));
    const actions = el('div', 'occ-actions'); actions.append(btn('看對照', 'small', () => showInCompare(x.path, x.index)));
    row.append(body, actions); list.append(row);
  }
  box.append(list);
  const row = el('div', 'row');
  if (flagged.length) {
    row.append(btn('套用勾選的修正', 'primary', () => {
      const chosen = flagged.filter(x => x.checked !== false);
      pushHistory(); const skipped = applyChanges(chosen.map(x => ({path: x.path, index: x.index, text: x.text, to: x.v.fix})));
      for (const x of chosen) addSuggestion({find: x.before.slice(-1) + x.text + x.after.slice(0, 1), to: x.before.slice(-1) + x.v.fix + x.after.slice(0, 1), note: 'AI 建議'}, false);
      S.aiScan = null; refresh(); toast(`已套用 ${chosen.length - skipped} 處${skipped ? `，${skipped} 處內容已變動而略過` : ''}`);
    }));
  }
  row.append(btn('重新檢查', null, () => { S.aiScan = null; renderAiScan(); }));
  box.append(row);
}
async function runAiScan(candidates) {
  if (S.busy) return;
  S.busy = true;
  const box = $('aiScan'); box.replaceChildren(el('p', 'muted', `AI 檢查中（0／${candidates.length}）…`));
  try {
    const verdicts = await AI.judge(candidates.map(c => ({id: c.id, before: c.before, match: c.text, after: c.after})),
      (done, total) => { box.firstChild.textContent = `AI 檢查中（${done}／${total}）…`; });
    S.aiScan = {items: candidates.map(c => ({...c, v: verdicts.get(c.id)}))};
  } catch (error) { toast('AI 失敗：' + error.message); setAiPill('error'); S.aiScan = null; }
  finally { S.busy = false; renderAiScan(); }
}

// ---------- dictionary suggestions ----------
function addSuggestion(entry, announce = true) {
  if (!entry.find || entry.find === entry.to) return;
  if (!S.suggestions.some(s => s.find === entry.find && s.to === entry.to)) S.suggestions.push(entry);
  renderSuggestions();
  if (announce) toast('已加入詞庫建議（在第 2 步最下方）');
}
function renderSuggestions() {
  $('suggestBox').hidden = !S.suggestions.length;
  $('suggestCount').textContent = S.suggestions.length;
  $('suggestText').value = S.suggestions.map(s => '    ' + JSON.stringify(s)).join(',\n');
}
async function copySuggestions() {
  const text = $('suggestText').value;
  try { await navigator.clipboard.writeText(text); toast('已複製'); }
  catch { $('suggestText').select(); document.execCommand('copy'); toast('已複製'); }
}

// ---------- search ----------
let searchTimer;
function renderSearch() {
  const box = $('searchResults'); box.replaceChildren();
  const q = $('findText').value, r = $('replaceText').value;
  $('applyReplace').disabled = true;
  if (!q || !S.draft) { $('searchSummary').textContent = ''; return; }
  const fields = T.textFields(S.draft).filter(f => !T.mirrorField(f.path, S.input) && f.value.includes(q));
  let total = 0;
  for (const f of fields.slice(0, 60)) {
    const count = f.value.split(q).length - 1; total += count;
    const editable = T.editableField(S.draft, f.path);
    const card = el('details', 'field'); card.open = true;
    const sum = el('summary'); sum.append(el('span', 'title', T.fieldLabel(S.draft, f.path)), el('span', 'badge', `${count} 處`));
    if (!editable) sum.append(el('span', 'badge', '固定設定，不會修改'));
    card.append(sum);
    const orig = T.fieldAt(S.input, f.path);
    card.append(pairTable(typeof orig === 'string' ? orig : '', f.value, {path: f.path, onlyLinesWith: q, mark: q}));
    const acts = el('div', 'field-actions'); acts.append(btn('在對照中看完整內容', 'small', () => showInCompare(f.path, f.value.indexOf(q))));
    card.append(acts); box.append(card);
  }
  for (const f of fields.slice(60)) total += f.value.split(q).length - 1;
  if (!fields.length) {
    const before = T.textFields(S.input).filter(f => !T.mirrorField(f.path, S.input) && f.value.includes(q));
    if (before.length) {
      // The user typed the simplified spelling: offer the converted spelling, which is what can be replaced.
      const named = (S.result.nameMapping || []).find(n => n.before === q)?.after;
      const converted = [named, T.toTraditional(q)].find(x => x && x !== q && JSON.stringify(S.draft).includes(x));
      const summary = $('searchSummary'); summary.replaceChildren();
      if (converted) {
        summary.append(document.createTextNode(`「${q}」是轉換前的寫法，轉換後已變成「${converted}」。要修改請搜尋轉換後的寫法：`),
          btn(`改找「${converted}」`, 'small primary', () => { $('findText').value = converted; if (!$('replaceText').value) $('replaceText').value = q; renderSearch(); }));
      } else summary.textContent = `「${q}」只出現在轉換前的原文（${before.length} 個欄位），下面列出轉換後的對應內容。`;
      for (const f of before.slice(0, 30)) {
        const card = el('details', 'field'); card.open = true;
        const sum = el('summary'); sum.append(el('span', 'title', T.fieldLabel(S.draft, f.path))); card.append(sum);
        card.append(pairTable(f.value, String(T.fieldAt(S.draft, f.path) ?? ''), {path: f.path, onlyLinesWithLeft: q, markLeft: q}));
        box.append(card);
      }
    } else $('searchSummary').textContent = '找不到這段文字。';
    return;
  }
  $('searchSummary').textContent = `找到 ${fields.length} 個欄位，共 ${total} 處。` + (fields.length > 60 ? '（只顯示前 60 個欄位）' : '');
  $('applyReplace').disabled = !(r && r !== q && fields.some(f => T.editableField(S.draft, f.path)));
}
function applyReplace() {
  const q = $('findText').value, r = $('replaceText').value;
  if (!q || !r || q === r) return;
  pushHistory();
  const preview = T.previewReplacement(S.draft, q, r);
  S.draft = preview.output; S.edits.push(preview.edit);
  const n = preview.impacts.filter(i => i.selected && !T.mirrorField(i.path, S.input)).reduce((a, i) => a + i.count, 0);
  if (S.names) S.names.selected = S.names.selected.map(n => n === q ? r : n);
  $('findText').value = r; $('replaceText').value = '';
  refresh();
  const t = el('div', 'toast'); t.append(document.createTextNode(`已把 ${n} 處「${q}」改成「${r}」 `), btn('加入詞庫建議', 'link', () => { addSuggestion({find: q, to: r, note: '手動更正'}); t.remove(); }));
  document.body.append(t); setTimeout(() => t.remove(), 6000);
}
function renderNames() {
  const list = $('nameList'); list.replaceChildren();
  const names = S.result.nameMapping || [];
  if (!names.length) { list.append(el('p', 'muted', '沒有辨識到姓名。')); return; }
  for (const item of names) {
    const row = el('div', 'name-row');
    row.append(el('span', null, item.before === item.after ? item.after : `${item.before} → ${item.after}`), btn('查找', 'small', () => { $('findText').value = item.after; $('replaceText').value = ''; renderSearch(); $('findText').scrollIntoView({block: 'center'}); }));
    list.append(row);
  }
}

// ---------- character-name quick buttons ----------
// Added only to the downloaded copy, so the conversion checks above stay about the conversion.
function finalCard() {
  return S.result.type === 'card' && S.names && S.names.selected.length
    ? T.withNameButtons(S.draft, S.names.selected, () => (crypto.randomUUID ? crypto.randomUUID() : 'name-buttons-' + Date.now().toString(36)))
    : S.draft;
}
function nameChoices() {
  const found = T.nameCandidates(S.draft), known = new Set(found.map(c => c.name));
  for (const n of S.names.aiFound) if (!known.has(n)) { known.add(n); found.push({name: n, source: 'AI', count: JSON.stringify(S.draft).split(n).length - 1}); }
  return found;
}
function renderNameButtons() {
  if (!S.names || S.result.type !== 'card') return;
  const chips = $('nameChips'); chips.replaceChildren();
  const choices = nameChoices(), sel = S.names.selected;
  for (const c of choices) {
    const on = sel.includes(c.name);
    const chip = btn(c.name, 'chip name-chip' + (on ? ' active' : ''), () => toggleName(c.name));
    chip.title = `${c.source}・卡片裡出現 ${c.count} 次`;
    chip.append(el('span', 'count', on ? '✓' : String(c.count)));
    chips.append(chip);
  }
  for (const n of sel) if (!choices.some(c => c.name === n)) { const chip = btn(n, 'chip name-chip active', () => toggleName(n)); chip.append(el('span', 'count', '✓')); chips.append(chip); }
  if (!chips.children.length) chips.append(el('p', 'muted', '沒有自動找到角色名，可以在下面手動新增' + (AI.ready() ? '，或請 AI 找。' : '。')));
  $('nameAi').hidden = !AI.ready();
  const plan = $('namePlan'); plan.replaceChildren();
  if (sel.length) {
    const p = el('p', 'good-text', `下載時會加入 ${sel.length} 個按鈕（依點選順序）：`);
    plan.append(p);
    const preview = el('div', 'name-preview');
    sel.forEach((n, i) => {
      const b = el('span', 'name-btn-preview', n);
      if (i > 0) { const left = btn('◀', 'small link', () => { sel.splice(i - 1, 0, sel.splice(i, 1)[0]); renderNameButtons(); }); left.title = '往前移'; b.prepend(left); }
      preview.append(b);
    });
    const clear = btn('全部取消', 'small link', () => { S.names.selected = []; renderNameButtons(); });
    plan.append(preview, clear);
  } else plan.append(el('p', 'muted', '還沒有選名字，下載的卡片不會加按鈕' + (T.existingNameButtons(S.draft).length ? '（卡片原本的按鈕會保留）。' : '。')));
}
function toggleName(n) {
  const sel = S.names.selected, i = sel.indexOf(n);
  if (i === -1) sel.push(n); else sel.splice(i, 1);
  renderNameButtons();
}
function addTypedNames() {
  const names = $('nameAdd').value.split(/[,，、\s]+/u).map(s => s.trim()).filter(s => s && s.length <= 20);
  for (const n of names) if (!S.names.selected.includes(n)) S.names.selected.push(n);
  $('nameAdd').value = ''; renderNameButtons();
}
async function findNamesWithAi() {
  if (S.busy) return;
  S.busy = true; $('nameAi').disabled = true; $('nameAi').textContent = 'AI 找名字中…';
  try {
    const names = await AI.characterNames(T.proseChunks(S.draft, 6000)[0] || '');
    const text = JSON.stringify(S.draft);
    S.names.aiFound = names.filter(n => text.includes(n));
    toast(S.names.aiFound.length ? `AI 找到 ${S.names.aiFound.length} 個名字，點一下就能加入` : 'AI 沒有找到角色名');
  } catch (error) { toast('AI 失敗：' + error.message); setAiPill('error'); }
  finally { S.busy = false; $('nameAi').disabled = false; $('nameAi').textContent = '請 AI 找出角色名'; renderNameButtons(); }
}

// ---------- side-by-side comparison ----------
function charFlags(a, b) {
  const flags = new Uint8Array(b.length);
  if (a === b) return flags;
  if (a.length === b.length) { for (let i = 0; i < b.length; i++) flags[i] = a[i] !== b[i] ? 1 : 0; return flags; }
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s), bm = b.slice(p, b.length - s);
  if (!am.length || am.length * bm.length > 250000) { for (let i = p; i < b.length - s; i++) flags[i] = 1; return flags; }
  const m = am.length, n = bm.length, dp = Array.from({length: m + 1}, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  for (let j = 0; j < n; j++) flags[p + j] = 1;
  let i = 0, j = 0;
  while (i < m && j < n) { if (am[i] === bm[j]) { flags[p + j] = 0; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return flags;
}
function markRanges(text, needle) {
  const ranges = []; if (!needle) return ranges;
  let at = text.indexOf(needle); while (at !== -1) { ranges.push([at, at + needle.length]); at = text.indexOf(needle, at + needle.length); }
  return ranges;
}
// Renders one line as spans: 1 = changed, 2 = pending review (clickable), 3 = search mark.
function lineSpans(text, flags, pend, marks, offset) {
  const frag = document.createDocumentFragment();
  let i = 0;
  const kindAt = k => {
    const abs = offset + k;
    if (pend && pend.has(abs)) return 'rev:' + pend.get(abs);
    if (marks && marks.some(([a, b]) => abs >= a && abs < b)) return 'mark';
    return flags && flags[k] ? 'chg' : '';
  };
  while (i < text.length) {
    const kind = kindAt(i); let j = i + 1;
    while (j < text.length && kindAt(j) === kind) j++;
    const piece = text.slice(i, j);
    if (!kind) frag.append(document.createTextNode(piece));
    else if (kind === 'mark') frag.append(el('mark', null, piece));
    else if (kind === 'chg') frag.append(el('span', 'chg', piece));
    else {
      const term = kind.slice(4), span = el('span', 'rev', piece);
      span.title = `需要確認：${term}（點一下處理）`;
      span.addEventListener('click', () => { S.activeTerm = term; renderReview(); $('reviewStep').scrollIntoView({behavior: 'smooth', block: 'start'}); });
      frag.append(span);
    }
    i = j;
  }
  if (!text.length) frag.append(document.createTextNode(' '));
  return frag;
}
function pairTable(original, current, opts = {}) {
  const wrap = el('div', 'pair-scroll');
  const head = el('div', 'pair head'); head.append(el('div', 'ln', '#'), el('div', 'left', '簡體原文'), el('div', null, '台灣繁中'));
  wrap.append(head);
  const a = original.split('\n'), b = current.split('\n');
  const pend = new Map();
  if (opts.path) for (const g of S.review) for (const it of g.items) if (it.path === opts.path) for (let k = 0; k < it.text.length; k++) pend.set(it.index + k, g.term);
  const marksAll = opts.mark ? markRanges(current, opts.mark) : null;
  const marksLeft = opts.markLeft ? markRanges(original, opts.markLeft) : null;
  let offset = 0, leftOffset = 0, skipped = 0;
  const rows = Math.max(a.length, b.length);
  const flushGap = () => { if (skipped) { const g = el('div', 'pair gap'); g.append(el('div'), el('div', null, `…省略 ${skipped} 行…`), el('div')); wrap.append(g); skipped = 0; } };
  for (let i = 0; i < rows; i++) {
    const left = a[i] ?? '', right = b[i] ?? '';
    const changed = left !== right;
    let hasPend = false; for (let k = 0; k < right.length && !hasPend; k++) if (pend.has(offset + k)) hasPend = true;
    let show = true;
    if (opts.onlyLinesWith) show = right.includes(opts.onlyLinesWith);
    else if (opts.onlyLinesWithLeft) show = left.includes(opts.onlyLinesWithLeft);
    else if (opts.onlyChanged) show = changed || hasPend;
    if (show) {
      flushGap();
      const row = el('div', 'pair' + (changed ? ' changed' : '')); row.dataset.start = offset; row.dataset.end = offset + right.length;
      const l = el('div', 'left'); l.append(lineSpans(left, null, null, marksLeft, leftOffset));
      const r = el('div'); r.append(lineSpans(right, changed ? charFlags(left, right) : null, pend, marksAll, offset));
      row.append(el('div', 'ln', String(i + 1)), l, r); wrap.append(row);
    } else if (right.trim() || left.trim()) skipped++;
    offset += right.length + 1; leftOffset += left.length + 1;
  }
  flushGap();
  return wrap;
}
function compareFields() {
  const filter = $('compareFilter').value.trim(), showAll = $('showUnchanged').checked;
  const termPaths = S.activeTerm ? new Set((S.review.find(g => g.term === S.activeTerm)?.items || []).map(i => i.path)) : null;
  return T.textFields(S.draft).filter(f => {
    if (T.mirrorField(f.path, S.input)) return false;
    const orig = T.fieldAt(S.input, f.path);
    const original = typeof orig === 'string' ? orig : '';
    if (!/[\p{Script=Han}]/u.test(f.value + original)) return false;
    if (termPaths) return termPaths.has(f.path);
    if (!showAll && original === f.value) return false;
    if (filter) return T.fieldLabel(S.draft, f.path).includes(filter) || f.value.includes(filter) || original.includes(filter);
    return true;
  });
}
function renderCompare() {
  if (!S.draft) return;
  const box = $('fields'); box.replaceChildren();
  const tf = $('termFilter');
  if (S.activeTerm && S.review.some(g => g.term === S.activeTerm)) {
    tf.hidden = false; tf.replaceChildren(el('span', null, `只顯示含「${S.activeTerm}」的欄位`), btn('顯示全部', 'small', () => { S.activeTerm = null; renderReview(); renderCompare(); }));
  } else tf.hidden = true;
  const fields = compareFields();
  const shown = fields.slice(0, S.fieldLimit);
  for (const f of shown) {
    const orig = T.fieldAt(S.input, f.path), original = typeof orig === 'string' ? orig : '';
    const card = el('details', 'field'); card.dataset.path = f.path;
    const sum = el('summary'); sum.append(el('span', 'title', T.fieldLabel(S.draft, f.path)));
    const changedLines = original.split('\n').filter((line, i) => line !== f.value.split('\n')[i]).length;
    if (original !== f.value) sum.append(el('span', 'badge', `${changedLines} 行有變動`)); else sum.append(el('span', 'badge', '沒有變動'));
    const pend = S.review.reduce((n, g) => n + g.items.filter(i => i.path === f.path).length, 0);
    if (pend) sum.append(el('span', 'badge rev-badge', `待確認 ${pend}`));
    card.append(sum);
    const render = () => { if (!card.querySelector('.pair-scroll')) card.append(pairTable(original, f.value, {path: f.path, onlyChanged: $('onlyChanged').checked})); };
    card.addEventListener('toggle', () => { if (card.open) { S.openPaths.add(f.path); render(); } else S.openPaths.delete(f.path); });
    if (S.openPaths.has(f.path) || (S.activeTerm && shown.length <= 3)) { card.open = true; render(); }
    box.append(card);
  }
  if (!fields.length) box.append(el('p', 'muted', '沒有符合的欄位。'));
  $('moreFields').hidden = fields.length <= S.fieldLimit;
  $('moreFields').textContent = `顯示更多欄位（還有 ${fields.length - S.fieldLimit} 個）`;
}
function showInCompare(path, index) {
  S.openPaths.add(path);
  const fields = compareFields();
  const at = fields.findIndex(f => f.path === path);
  if (at === -1) { $('showUnchanged').checked = true; $('compareFilter').value = ''; S.activeTerm = null; renderReview(); }
  const pos = compareFields().findIndex(f => f.path === path);
  if (pos >= S.fieldLimit) S.fieldLimit = pos + 1;
  renderCompare();
  const card = [...document.querySelectorAll('#fields .field')].find(c => c.dataset.path === path);
  if (!card) return;
  const row = [...card.querySelectorAll('.pair:not(.head)')].find(r => index >= Number(r.dataset.start) && index <= Number(r.dataset.end));
  (row || card).scrollIntoView({behavior: 'smooth', block: 'center'});
  if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
}

// ---------- checks & download ----------
function renderChecks() {
  const box = $('checks'); box.replaceChildren();
  const {errors, warnings, codeNotes} = S.check, r = S.result;
  if (errors.length) {
    box.append(el('p', 'check-bad', '以下問題可能讓卡片無法正常運作，已暫停下載。可以按「復原上一步」撤回造成問題的修改：'));
    const ul = el('ul', 'check-list'); errors.forEach(e => ul.append(el('li', 'check-bad', e))); box.append(ul);
  } else {
    const links = (r.linkChecks || []).length;
    box.append(el('p', 'check-ok', `✓ 結構、網址與媒體路徑、程式名稱、正則語法檢核通過${links ? `；${links} 組姓名／識別字已同步對應` : ''}。`));
  }
  if (r.audio?.length) {
    box.append(el('p', 'check-warn', '外鏈音源提醒：以下音樂來自中國音樂平台，在台灣常因版權或會員限制無法播放。沒有聲音時，先把網址貼到瀏覽器測試；打不開就需要換成可公開存取的音源（這不是轉換造成的）。'));
    const ul = el('ul', 'check-list'); r.audio.forEach(a => ul.append(el('li', null, `${a.where}：${a.url}`))); box.append(ul);
  }
  if (warnings.length) { const ul = el('ul', 'check-list'); warnings.forEach(w => ul.append(el('li', 'check-warn', w))); box.append(ul); }
  if (codeNotes.length) box.append(el('p', 'muted', `${codeNotes.length} 個欄位含有程式碼：靜態檢查通過，但仍建議匯入酒館實際點一下畫面和按鈕確認。`));
}
function renderDownload() {
  const errors = S.check.errors.length, aiPending = aiPendingCount(), pending = pendingCount() + aiPending;
  const status = $('downloadStatus');
  if (errors) { status.textContent = `技術檢核有 ${errors} 項問題，已暫停下載`; status.className = 'status bubble bad'; }
  else if (S.ai && S.ai.status === 'running') { status.textContent = 'AI 校正中，可以先看下方結果'; status.className = 'status bubble'; }
  else if (aiPending) { status.textContent = `可以下載；還有 ${aiPending} 條 AI 建議沒決定，沒按接受的不會套用`; status.className = 'status bubble'; }
  else if (pending) { status.textContent = `可以下載；還有 ${pending} 處待確認，未處理的維持目前寫法`; status.className = 'status bubble'; }
  else { status.textContent = '檢核通過，可以下載'; status.className = 'status bubble good'; }
  $('downloadJson').disabled = !!errors;
  $('downloadPng').disabled = !!errors || !S.png || S.result.type !== 'card';
  $('undo').disabled = !S.history.length;
  if (pending) S.hadPending = true;
  let mood = S.ai && S.ai.status === 'running' ? 'working' : errors || pending ? 'review' : S.hadPending ? 'celebrate' : 'ready';
  if (mood === 'celebrate' && !S.celebrated) { S.celebrated = true; status.textContent = '恭喜！全部確認完成，可以下載了'; toast('🎉 全部確認完成！'); }
  else if (mood === 'celebrate') status.textContent = '全部確認完成，可以下載';
  setMascot(mood);
}
function save(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], {type}));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const outName = ext => S.fileName.replace(/\.(?:json|png)$/iu, '') + (S.result.type === 'preset' ? '_Preset台灣繁中' : '_台灣繁中') + ext;

// ---------- AI settings ----------
function setAiPill(state) {
  const pill = $('aiToggle'), s = AI.get();
  pill.classList.toggle('ready', state === 'ready' || (state == null && AI.ready()));
  pill.classList.toggle('error', state === 'error');
  const names = {anthropic: 'Claude', openai: 'OpenAI 相容', gemini: 'Gemini'};
  $('aiPillText').textContent = AI.ready() ? `AI 協助：${names[s.provider]}` + (state === 'error' ? '（連線有問題）' : '') : 'AI 協助：未設定';
  updateConvertButton();
  if (S.result && !S.busy) renderAi();
}
const aiHints = {
  gemini: {text: '到 Google AI Studio（aistudio.google.com）按「Get API key」取得金鑰，建議在沒有綁定帳單的專案另建一把專用金鑰，使用免費額度。連線網址已內建（generativelanguage.googleapis.com），不用填。', models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash']},
  anthropic: {text: '到 console.anthropic.com 建立金鑰；此為付費服務，請在後台設定用量上限。', models: ['claude-haiku-4-5-20251001']},
  openai: {text: '填入服務商提供的 API 網址（需以 https:// 開頭）與模型名稱；付費服務請在後台設定用量上限。', models: []}
};
function showAiHint(provider) {
  $('aiHint').textContent = aiHints[provider].text;
  $('aiModelList').replaceChildren(...aiHints[provider].models.map(m => { const o = document.createElement('option'); o.value = m; return o; }));
}
function fillAiForm() {
  const s = AI.get();
  $('aiProvider').value = s.provider; $('aiModel').value = s.model || ''; $('aiBase').value = s.base || '';
  $('aiRemember').checked = !!s.remember; $('aiKey').value = '';
  $('aiKey').placeholder = s.key ? `已設定（結尾 ${s.key.slice(-4)}），留空表示沿用` : '貼上金鑰';
  $('aiBaseWrap').hidden = s.provider !== 'openai';
  showAiHint(s.provider);
  $('aiModel').placeholder = s.provider === 'openai' ? '例如 gpt-4.1-mini、deepseek-chat' : AI.defaults[s.provider].model;
}
function openAiPanel() { $('aiPanel').hidden = false; $('aiToggle').setAttribute('aria-expanded', 'true'); fillAiForm(); $('aiPanel').scrollIntoView({block: 'nearest'}); }
$('aiToggle').addEventListener('click', () => { if ($('aiPanel').hidden) openAiPanel(); else { $('aiPanel').hidden = true; $('aiToggle').setAttribute('aria-expanded', 'false'); } });
$('aiProvider').addEventListener('change', () => {
  const p = $('aiProvider').value, d = AI.defaults[p];
  const saved = AI.get();
  $('aiModel').value = saved.provider === p && saved.model ? saved.model : d.model;
  if (p === 'openai' && !$('aiBase').value) $('aiBase').value = d.base;
  $('aiBaseWrap').hidden = p !== 'openai';
  showAiHint(p);
  $('aiModel').placeholder = p === 'openai' ? '例如 gpt-4.1-mini、deepseek-chat' : d.model;
});
$('aiForm').addEventListener('submit', async event => {
  event.preventDefault();
  const current = AI.get();
  const next = {provider: $('aiProvider').value, model: $('aiModel').value.trim(), base: $('aiBase').value.trim(),
    key: $('aiKey').value.trim() || current.key, remember: $('aiRemember').checked};
  if (next.provider === 'openai' && next.base && !/^https:\/\//iu.test(next.base)) { $('aiStatus').textContent = 'API 網址必須以 https:// 開頭'; return; }
  AI.save(next); fillAiForm();
  if (!AI.ready()) { $('aiStatus').textContent = '請填寫模型名稱與金鑰' + (next.provider === 'openai' ? '、API 網址' : ''); setAiPill(); return; }
  $('aiStatus').textContent = '測試連線中…';
  try {
    const r = await AI.test();
    $('aiStatus').textContent = r ? `連線成功${next.remember ? '，金鑰已記在這台電腦' : '（這次關閉網頁後需重新輸入）'}` : '連線成功，但回覆格式不如預期，可換一個模型試試';
    setAiPill('ready');
  } catch (error) { $('aiStatus').textContent = error.message; setAiPill('error'); }
  if (S.result) { renderDecision(); renderAiScan(); }
});
$('aiClear').addEventListener('click', () => { AI.clear(); fillAiForm(); $('aiStatus').textContent = '已清除金鑰'; setAiPill(); if (S.result) { renderDecision(); renderAiScan(); } });

// ---------- wiring ----------
$('file').addEventListener('change', e => loadFile(e.target.files[0]));
$('drop').addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('drag'); });
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('drag'));
$('drop').addEventListener('drop', e => { e.preventDefault(); $('drop').classList.remove('drag'); loadFile(e.dataTransfer.files[0]); });
$('loadJsonText').addEventListener('click', () => { const text = $('jsonInput').value; loadFile({name: '貼上的角色卡.json', arrayBuffer: async () => new TextEncoder().encode(text).buffer}); });
$('convert').addEventListener('click', convert);
$('useAi').addEventListener('change', updateConvertButton);
for (const id of ['useTai', 'protectedNames', 'nameCorrections']) $(id).addEventListener('input', () => { if (S.result) setStatus('設定已變更，按「重新轉換」才會生效。'); });
for (const id of ['findText', 'replaceText']) $(id).addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 200); });
$('applyReplace').addEventListener('click', applyReplace);
$('compareFilter').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.fieldLimit = 30; renderCompare(); }, 200); });
for (const id of ['onlyChanged', 'showUnchanged']) $(id).addEventListener('change', () => { S.fieldLimit = 30; renderCompare(); });
$('moreFields').addEventListener('click', () => { S.fieldLimit += 30; renderCompare(); });
$('undo').addEventListener('click', undo);
$('copySuggest').addEventListener('click', copySuggestions);
$('clearSuggest').addEventListener('click', () => { S.suggestions = []; renderSuggestions(); });
$('downloadJson').addEventListener('click', () => save(JSON.stringify(finalCard(), null, 2), outName('.json'), 'application/json;charset=utf-8'));
$('downloadPng').addEventListener('click', () => save(T.writePng(S.png, finalCard()), outName('.png'), 'image/png'));
$('nameAddBtn').addEventListener('click', addTypedNames);
$('nameAdd').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTypedNames(); } });
$('nameAll').addEventListener('click', () => { for (const c of nameChoices()) if (!S.names.selected.includes(c.name)) S.names.selected.push(c.name); renderNameButtons(); });
$('nameAi').addEventListener('click', findNamesWithAi);
setAiPill();
setMascot('idle');
loadDictionary();
globalThis.__translatorState = S; // for automated browser tests
})();
