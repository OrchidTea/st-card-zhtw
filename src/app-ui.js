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
    $('convert').textContent = '轉換為台灣繁中';
    setMascot('idle');
    if (check.errors.length) setStatus('無法轉換：' + check.errors.join('；'), 'bad');
    else setStatus(`已載入「${info.name}」（${info.detail}），按下轉換開始。`, 'good');
  } catch (error) { setStatus('讀取失敗：' + error.message, 'bad'); }
}
function hideWork() {
  for (const id of ['summary', 'reviewStep', 'searchStep', 'compareStep', 'checkStep', 'downloadBar']) $(id).hidden = true;
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
  for (const id of ['summary', 'reviewStep', 'searchStep', 'compareStep', 'checkStep', 'downloadBar']) $(id).hidden = false;
  $('reviewStep').hidden = S.result.type !== 'card' && S.result.type !== 'preset';
  setStatus(`轉換完成（${Math.round(performance.now() - started)} 毫秒）。`, 'good');
  $('convert').textContent = '重新轉換（會清除目前的修改）';
  refresh();
  renderNames();
  $('summary').scrollIntoView({behavior: 'smooth', block: 'start'});
}

// ---------- state helpers ----------
function pushHistory() {
  S.history.push({draft: T.U(S.draft), base: T.U(S.base), edits: [...S.edits], kept: new Set(S.kept), resolved: new Map(S.resolved)});
  if (S.history.length > 40) S.history.shift();
}
function undo() {
  const last = S.history.pop(); if (!last) return;
  Object.assign(S, {draft: last.draft, base: last.base, edits: last.edits, kept: last.kept, resolved: last.resolved});
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
  renderSummary(); renderReview(); renderAuto(); renderAiScan(); renderSearch(); renderCompare(); renderChecks(); renderDownload();
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

// ---------- auto fixes ----------
function renderAuto() {
  const fixes = (S.result.autoFixes || []).filter(a => !T.mirrorField(a.path, S.input));
  const kinds = {auto: '詞庫修正', taiwan: '台灣用語', tai: '台／臺'};
  const counts = {auto: 0, taiwan: 0, tai: 0}; fixes.forEach(f => counts[f.kind]++);
  $('autoSummary').textContent = `已自動修正 ${fixes.length} 處（詞庫修正 ${counts.auto}、台灣用語 ${counts.taiwan}、台／臺 ${counts.tai}）`;
  const list = $('autoList'); list.replaceChildren();
  const groups = new Map();
  for (const f of fixes) { const k = `${f.kind}|${f.from}|${f.to}`; if (!groups.has(k)) groups.set(k, {...f, n: 0}); groups.get(k).n++; }
  for (const g of [...groups.values()].sort((a, b) => b.n - a.n)) {
    const row = el('div', 'auto-item');
    row.append(el('span', null, `${g.from} → ${g.to}${g.note ? '（' + g.note + '）' : ''}`), el('span', 'muted', `${kinds[g.kind]} · ${g.n} 處`));
    list.append(row);
  }
}

// ---------- AI scan ----------
function renderAiScan() {
  const box = $('aiScan'); box.replaceChildren();
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
      $('searchSummary').textContent = `「${q}」只出現在轉換前的原文（${before.length} 個欄位），下面列出轉換後的對應內容。`;
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
  const errors = S.check.errors.length, pending = pendingCount();
  const status = $('downloadStatus');
  if (errors) { status.textContent = `技術檢核有 ${errors} 項問題，已暫停下載`; status.className = 'status bubble bad'; }
  else if (pending) { status.textContent = `可以下載；還有 ${pending} 處待確認，未處理的維持目前寫法`; status.className = 'status bubble'; }
  else { status.textContent = '檢核通過，可以下載'; status.className = 'status bubble good'; }
  $('downloadJson').disabled = !!errors;
  $('downloadPng').disabled = !!errors || !S.png || S.result.type !== 'card';
  $('undo').disabled = !S.history.length;
  if (pending) S.hadPending = true;
  let mood = errors || pending ? 'review' : S.hadPending ? 'celebrate' : 'ready';
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
for (const id of ['useTai', 'protectedNames', 'nameCorrections']) $(id).addEventListener('input', () => { if (S.result) setStatus('設定已變更，按「重新轉換」才會生效。'); });
for (const id of ['findText', 'replaceText']) $(id).addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 200); });
$('applyReplace').addEventListener('click', applyReplace);
$('compareFilter').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.fieldLimit = 30; renderCompare(); }, 200); });
for (const id of ['onlyChanged', 'showUnchanged']) $(id).addEventListener('change', () => { S.fieldLimit = 30; renderCompare(); });
$('moreFields').addEventListener('click', () => { S.fieldLimit += 30; renderCompare(); });
$('undo').addEventListener('click', undo);
$('copySuggest').addEventListener('click', copySuggestions);
$('clearSuggest').addEventListener('click', () => { S.suggestions = []; renderSuggestions(); });
$('downloadJson').addEventListener('click', () => save(JSON.stringify(S.draft, null, 2), outName('.json'), 'application/json;charset=utf-8'));
$('downloadPng').addEventListener('click', () => save(T.writePng(S.png, S.draft), outName('.png'), 'image/png'));
setAiPill();
setMascot('idle');
loadDictionary();
globalThis.__translatorState = S; // for automated browser tests
})();
