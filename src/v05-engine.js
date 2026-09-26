// v0.5 engine: whole-card Taiwan localisation on top of the v0.3.2 glyph/sync core.
// Rule: everything that references something inside the card is converted together;
// only identifiers (JS/CSS/MVU/object keys), URLs and media paths stay exact.

let activeDictionary = null;
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compileDictionary(raw) {
  const rule = (r, extra = {}) => ({
    re: new RegExp(r.regex ? r.find : escapeRe(r.find), 'gu'),
    source: r.find, to: r.to, note: r.note || '', ...extra
  });
  const dict = {
    version: raw.version || '',
    autoFix: (raw.autoFix || []).filter(r => r && r.find && typeof r.to === 'string').map(r => rule(r)),
    taiwan: (raw.taiwan || []).filter(p => Array.isArray(p) && p[0]).sort((a, b) => b[0].length - a[0].length)
      .map(([from, to]) => rule({find: from, to})),
    review: (raw.review || []).filter(r => r && r.term).map(r => ({
      term: r.term, suggest: [].concat(r.suggest || []), note: r.note || '',
      re: new RegExp(r.regex ? r.find : escapeRe(r.find || r.term), 'gu')
    })),
    aiScanChars: new Set([...(raw.aiScanChars || '')]),
    knownGood: [...new Set(raw.knownGood || [])].sort((a, b) => b.length - a.length)
  };
  return dict;
}
function setDictionary(raw) { activeDictionary = compileDictionary(raw); return activeDictionary; }
function getDictionary() { return activeDictionary; }

// Identifiers that must never be rewritten by localisation or review decisions.
function frozenTokens(doc, names = []) {
  // CSS class/id names are protected by position (attributes, selectors, DOM calls)
  // instead of everywhere, so the same word in visible text can still be localised.
  const tokens = new Set([...names, ...Ue(doc), ...objectKeys(doc).map(k => k.key)]);
  return [...tokens].filter(t => typeof t === 'string' && t.length > 0);
}

const lockedPatterns = [
  /https?:\/\/[^\s"'<>`)]+/gu,
  /\b(?:src|href)\s*=\s*(?:"[^"]*"|'[^']*')/giu,
  /\{\{\s*[A-Za-z_][\w.]*\s*\}\}/gu,
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu,
  /\b(?:id|class|for|name|data-[\w-]+)\s*=\s*(?:"[^"]*"|'[^']*')/giu,
  /(?<![\p{L}\p{N}])[.#][\p{Script=Han}_-][\p{L}\p{N}_-]*/gu,
  /classList\.(?:add|remove|toggle|contains|replace)\([^)]*\)/gu,
  // String identifiers handed to DOM/event APIs behave like names, not prose.
  /\b(?:eventEmit|eventOn|eventOnce|eventMakeFirst|eventMakeLast|eventRemoveListener|addEventListener|removeEventListener|dispatchEvent|CustomEvent|getElementById|getElementsByClassName|querySelector(?:All)?|closest|matches)\(\s*(["'`])[^"'`]*\1/gu
];
function protectedRanges(text, tokens) {
  const ranges = [];
  for (const pattern of lockedPatterns) for (const m of text.matchAll(pattern)) ranges.push([m.index, m.index + m[0].length]);
  for (const token of tokens) {
    if (!token || !text.includes(token)) continue;
    let at = text.indexOf(token);
    while (at !== -1) { ranges.push([at, at + token.length]); at = text.indexOf(token, at + token.length); }
  }
  return ranges;
}
const overlaps = (ranges, start, end) => ranges.some(([a, b]) => start < b && end > a);

// Replace every match of one rule outside protected ranges.
function applyRule(text, rule, tokens, onHit) {
  if (!rule.re.test(text)) { rule.re.lastIndex = 0; return text; }
  rule.re.lastIndex = 0;
  const ranges = protectedRanges(text, tokens);
  return text.replace(rule.re, (...args) => {
    const match = args[0], offset = args.findLast(a => typeof a === 'number');
    if (overlaps(ranges, offset, offset + match.length) || match === rule.to) return match;
    if (onHit) onHit(match, offset, text);
    return rule.to;
  });
}

const codeLike = text => /<script\b|<style\b|```|registerMvuSchema|\bfunction\s|=>/u.test(text);
const snippet = (text, index, length, pad = 16) => ({
  before: text.slice(Math.max(0, index - pad), index), match: text.slice(index, index + length),
  after: text.slice(index + length, index + length + pad)
});

function localizeField(text, path, tokens, options, record) {
  const dict = activeDictionary;
  let value = text;
  for (const rule of dict.autoFix) value = applyRule(value, rule, tokens, (m, i, t) => record('auto', rule, m, i, t, path));
  for (const rule of dict.taiwan) value = applyRule(value, rule, tokens, (m, i, t) => record('taiwan', rule, m, i, t, path));
  if (!codeLike(value)) value = value.split('\n').map(line =>
    (!/合唱|教會|教堂|詩班|詩歌|帶領|帶大家/u.test(line) && /Rapper|男團|女團|偶像|樂團|組合.*(?:成員|主)|團體.*成員/iu.test(line))
      ? applyRule(line, {re: /領唱/gu, to: '主唱'}, tokens, (m, i, t) => record('taiwan', {to: '主唱', note: '團體職位'}, m, i, t, path)) : line
  ).join('\n');
  if (options.useTai !== false) value = applyRule(value, {re: /臺/gu, to: '台'}, tokens, (m, i, t) => record('tai', {to: '台', note: '台灣常用字'}, m, i, t, path));
  return value;
}

function codeBlocks(text) {
  return [...text.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/giu)].map(m => ({kind: m[1].toLowerCase(), body: m[2]}));
}
const resourceList = text => [...text.matchAll(/https?:\/\/[^\s"'<>`)]+|\b(?:src|href)\s*=\s*(?:"[^"]*"|'[^']*')/giu)].map(m => m[0]);
const asciiCodeNames = text => [...text.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)|(?:addEventListener|dispatchEvent|eventOn|eventEmit|getElementById|querySelector(?:All)?)\(\s*["']([^"']+)["'])/gu)]
  .map(m => m[1] || m[2]).filter(t => /^[\x20-\x7e]+$/u.test(t));
const compileFind = value => { const m = value.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/u); return m ? new RegExp(m[1], m[2]) : new RegExp(value); };

// Compares the simplified original with any later draft. Only syntax, URLs and
// ASCII identifiers are compared; Chinese text is expected to change.
function technicalIntegrity(original, draft) {
  const errors = [], warnings = [];
  for (const field of textFields(original)) {
    const next = fieldAt(draft, field.path);
    if (typeof next !== 'string' || next === field.value) continue;
    const label = fieldLabel(draft, field.path);
    if (JSON.stringify(resourceList(field.value)) !== JSON.stringify(resourceList(next))) errors.push(`${label}：網址或媒體路徑被改動`);
    const a = codeBlocks(field.value), b = codeBlocks(next);
    const syntax = s => s.replace(/[\p{Script=Han}　-〿＀-￯]/gu, '');
    if (a.length !== b.length || a.some((block, i) => syntax(block.body) !== syntax(b[i].body))) errors.push(`${label}：<script>／<style> 的程式符號有變動`);
    for (const name of new Set(asciiCodeNames(field.value))) {
      if (next.split(name).length < field.value.split(name).length) errors.push(`${label}：程式名稱「${name}」被改動`);
    }
    if (/\/findRegex$/u.test(field.path)) {
      let ok = true;
      try { compileFind(field.value); } catch { ok = false; warnings.push(`${label}：原卡的正則本來就無法解析，請在酒館測試`); }
      if (ok) try { compileFind(next); } catch (error) { errors.push(`${label}：正則修改後無效（${error.message}）`); }
    }
  }
  return {errors: [...new Set(errors)], warnings: [...new Set(warnings)]};
}

function fieldLabel(doc, path) {
  const d = E(doc) || {};
  const book = path.match(/\/character_book\/entries\/(\d+)\/(\w+)/u);
  if (book) {
    const entry = d.character_book?.entries?.[Number(book[1])];
    const title = (entry?.comment || entry?.name || `條目 ${Number(book[1]) + 1}`).replace(/\s+/gu, ' ');
    return `世界書 · ${title}` + (book[2] === 'keys' || book[2] === 'keysecondary' ? '（觸發詞）' : book[2] === 'comment' ? '（標題）' : '');
  }
  const regex = path.match(/\/regex_scripts\/(\d+)\/(\w+)/u);
  if (regex) {
    const name = d.extensions?.regex_scripts?.[Number(regex[1])]?.scriptName || `正則 ${Number(regex[1]) + 1}`;
    return `正則 · ${name}` + ({findRegex: '（觸發條件）', scriptName: '（名稱）', replaceString: '（畫面／程式）'}[regex[2]] || '');
  }
  const script = path.match(/\/(?:tavern_helper\/scripts|TavernHelper_scripts)\/(\d+)\/(\w+)/u);
  if (script) return `酒館助手腳本 ${Number(script[1]) + 1}（${script[2]}）`;
  const greet = path.match(/\/alternate_greetings\/(\d+)$/u);
  if (greet) return `開場白 ${Number(greet[1]) + 2}`;
  const map = {name: '角色名稱', description: '角色設定', personality: '個性', scenario: '情境', first_mes: '開場白 1',
    mes_example: '對話範例', creator_notes: '作者備註', system_prompt: '系統提示', post_history_instructions: '歷史後指令',
    world: '連結的世界書名稱', creator: '作者', character_version: '版本'};
  const last = path.split('/').pop();
  if (path === '$/data/extensions/world') return '連結的世界書名稱';
  if (path === '$/data/character_book/name') return '內嵌世界書名稱';
  if (path.startsWith('$/data/') && map[last] && path.split('/').length === 3) return map[last];
  if (/^\$\/prompts\/\d+\/(\w+)$/u.test(path)) { const i = Number(path.split('/')[2]); return `Prompt · ${doc.prompts?.[i]?.name || i + 1}`; }
  if (/^\$\/(?:name|description|first_mes|personality|scenario|mes_example)$/u.test(path)) return (map[last] || last) + '（相容欄位）';
  return path.replace(/^\$\//u, '').replace(/\//gu, ' › ');
}
// Top-level V2 mirror fields duplicate data/*; the UI hides them but they are converted identically.
const mirrorField = (path, doc) => !(doc && !(doc.data && typeof doc.data === 'object')) && /^\$\/(?:name|description|personality|scenario|first_mes|mes_example|creatorcomment|tags\/\d+|talkativeness|fav|create_date|avatar|chat)$/u.test(path);

function reviewScan(doc, tokens, kept = new Set()) {
  const groups = new Map();
  for (const field of textFields(doc)) {
    if (!editableField(doc, field.path) || !/[\p{Script=Han}]/u.test(field.value)) continue;
    const ranges = protectedRanges(field.value, tokens);
    for (const rule of activeDictionary.review) {
      rule.re.lastIndex = 0;
      for (const m of field.value.matchAll(rule.re)) {
        if (overlaps(ranges, m.index, m.index + m[0].length)) continue;
        const ctx = snippet(field.value, m.index, m[0].length);
        const key = `${field.path}|${ctx.before}|${m[0]}|${ctx.after}`;
        if (kept.has(key) || kept.has('term:' + rule.term)) continue;
        if (!groups.has(rule.term)) groups.set(rule.term, {term: rule.term, suggest: rule.suggest, note: rule.note, rule, items: []});
        groups.get(rule.term).items.push({term: rule.term, path: field.path, index: m.index, text: m[0], ...ctx, key, mirror: mirrorField(field.path, doc)});
      }
    }
  }
  return [...groups.values()];
}

function replaceAt(doc, path, index, expected, replacement) {
  const value = fieldAt(doc, path);
  if (typeof value !== 'string' || value.slice(index, index + expected.length) !== expected) throw new Error('內容已變動，請重新整理清單');
  setField(doc, path, value.slice(0, index) + replacement + value.slice(index + expected.length));
}
// Apply a review decision to every unprotected occurrence of one rule.
function replaceAllReview(doc, rule, replacement, tokens, onlyPaths = null) {
  let count = 0;
  for (const field of textFields(doc)) {
    if (!editableField(doc, field.path) || (onlyPaths && !onlyPaths.has(field.path))) continue;
    const next = applyRule(field.value, {re: new RegExp(rule.re.source, 'gu'), to: replacement}, tokens, () => count++);
    if (next !== field.value) setField(doc, field.path, next);
  }
  return count;
}

// Characters OpenCC often gets wrong, minus well-known correct words. Used for AI scans.
function aiCandidates(doc, tokens, reviewGroups = [], limit = 200) {
  const dict = activeDictionary, seen = new Set(), items = [];
  const reviewed = new Set(reviewGroups.flatMap(g => g.items.flatMap(i => [...i.text].map((_, k) => i.path + '#' + (i.index + k)))));
  for (const field of textFields(doc)) {
    if (!editableField(doc, field.path) || mirrorField(field.path, doc) || !/[\p{Script=Han}]/u.test(field.value)) continue;
    const text = field.value, ranges = protectedRanges(text, tokens);
    const good = [];
    for (const word of dict.knownGood) { let at = text.indexOf(word); while (at !== -1) { good.push([at, at + word.length]); at = text.indexOf(word, at + 1); } }
    for (let i = 0; i < text.length; i++) {
      if (!dict.aiScanChars.has(text[i]) || reviewed.has(field.path + '#' + i) || overlaps(ranges, i, i + 1) || overlaps(good, i, i + 1)) continue;
      const window = text.slice(Math.max(0, i - 3), i + 4);
      if (seen.has(window)) continue;
      seen.add(window);
      items.push({id: 'c' + items.length, path: field.path, index: i, text: text[i], ...snippet(text, i, 1, 24)});
      if (items.length >= limit) return items;
    }
  }
  return items;
}

const regionalAudio = /https?:\/\/(?:[\w-]+\.)*(?:music\.163\.com|music\.126\.net|y\.qq\.com|qqmusic\.qq\.com|kuwo\.cn|kugou\.com|ximalaya\.com)[^\s"'<>]*/giu;
function audioNotes(card) {
  const notes = new Map();
  for (const field of textFields(card)) for (const m of field.value.matchAll(regionalAudio)) if (!notes.has(m[0])) notes.set(m[0], fieldLabel(card, field.path));
  return [...notes].map(([url, where]) => ({url, where}));
}

function convertV05(card, options = {}) {
  if (!activeDictionary) throw new Error('詞庫尚未載入');
  const base = Ee(card, {localize: false, protectedNames: options.protectedNames || [], nameCorrections: options.nameCorrections || {}});
  if (base.type !== 'card' && base.type !== 'preset') return {...base, autoFixes: [], review: [], frozen: [], audio: []};
  const output = base.output, tokens = frozenTokens(output, base.protectedNames || []);
  const autoFixes = [];
  const record = (kind, rule, match, index, text, path) => autoFixes.push({kind, path, from: match, to: rule.to, note: rule.note || '', ...snippet(text, index, match.length, 10)});
  for (const field of textFields(output)) {
    if (!editableField(output, field.path) || !/[\p{Script=Han}]/u.test(field.value)) continue;
    if (base.type === 'preset' && !Fe(field.path)) continue;
    const next = localizeField(field.value, field.path, tokens, options, record);
    if (next !== field.value) setField(output, field.path, next);
  }
  const integrity = technicalIntegrity(card, output);
  const errors = [...new Set([...base.errors, ...integrity.errors, ...B(card, output), ...Re(card, output)])];
  return {...base, output, autoFixes, frozen: tokens, validationFrozen: [...new Set([...tokens, ...styleSymbols(output)])], errors, integrityWarnings: integrity.warnings,
    review: reviewScan(output, tokens), audio: audioNotes(card), dictionaryVersion: activeDictionary.version};
}
