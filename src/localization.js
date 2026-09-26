// Explicit, reviewable phrase rules. Ambiguous words are deliberately excluded.
const taiwanPhrases = new Map([
  ['視頻通話', '視訊通話'], ['視頻會議', '視訊會議'],
  ['網絡', '網路'], ['視頻', '影片'], ['文件夾', '資料夾'],
  ['賬號', '帳號'], ['帳號', '帳號'], ['模塊', '模組'],
  ['屏幕', '螢幕'], ['默認', '預設'], ['點贊', '按讚'], ['點讚', '按讚'],
  ['現實里', '現實裡']
]);
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrasePattern = new RegExp([...taiwanPhrases.keys()].sort((a,b) => b.length-a.length).map(escapePattern).join('|'), 'gu');
let conversionContext = { names: [], technical: [], corrections: new Map(), localize: true };

// Use a prefix absent from the input; restoration never interprets original PUA text.
function protectText(text, tokens = [], markup = true) {
  let prefix = '\uE000';
  while (text.includes(prefix)) prefix += '\uE000';
  const stored = [];
  const save = value => `${prefix}${stored.push(value)-1}\uE001`;
  let masked = text;
  const patterns = [/https?:\/\/[^\s"'<>]+/gu, /\{\{\s*[A-Za-z_][\w]*\s*\}\}/gu, /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu];
  // Asset addresses are external identifiers. Markup, comments and Chinese
  // placeholder instructions are converted instead of freezing entire tags.
  if (markup) patterns.push(/\b(?:src|href)\s*=\s*(?:"[^"]*"|'[^']*')/giu);
  for (const pattern of patterns) masked = masked.replace(pattern, save);
  const words = [...new Set(tokens)].filter(Boolean).sort((a,b) => b.length-a.length);
  if (words.length) masked = masked.replace(new RegExp(words.map(escapePattern).join('|'), 'gu'), save);
  return { masked, restore: value => {
    const pattern = new RegExp(escapePattern(prefix)+'(\\d+)\uE001', 'gu');
    for (let i=0; i<=stored.length; i++) {
      const next = value.replace(pattern, (match,index) => stored[Number(index)] ?? match);
      if (next === value) break;
      value = next;
    }
    return value;
  }};
}

function collectNames(card, extra = []) {
  const names = new Set(extra);
  const add = value => {
    if (typeof value !== 'string') return;
    const clean = value.trim();
    if (clean && clean.length <= 100) names.add(clean);
    // Parenthetical Korean/English spelling is not part of the Chinese name.
    const head = clean.split(/[（(]/u)[0].trim();
    if (head && head.length <= 40) names.add(head);
  };
  if (ne(card) === 'card') { add(card.name); add(E(card)?.name); }
  for (const {value} of V(card)) {
    for (const match of value.matchAll(/(?:Chinese name|中文名|姓名|Nickname|暱稱|昵称)\s*[:：]\s*([^\r\n]+)/giu)) {
      match[1].split(/[，,、；;]/u).forEach(add);
    }
    for (const match of value.matchAll(/<(?:character\b[^>]*?\bname|[\w]+\b[^>]*?\bcharacter)\s*=\s*["']([^"']+)["']/gu)) add(match[1]);
  }
  return [...names].sort((a,b) => b.length-a.length);
}

function correctNames(text) {
  const entries = [...conversionContext.corrections].filter(([from]) => from);
  if (!entries.length) return text;
  const pattern = new RegExp(entries.map(([from]) => from).sort((a,b)=>b.length-a.length).map(escapePattern).join('|'), 'gu');
  // Only explicitly entered corrections may alter an existing name.
  return text.replace(pattern, name => conversionContext.corrections.get(name));
}

function nameSafeGlyph(text) {
  const protectedText = protectText(correctNames(text), conversionContext.names, false);
  return protectedText.restore(be(protectedText.masked));
}

function traditionalName(name) {
  // These surname forms are already valid; other characters still convert.
  return /^[范朴后于余干谷郁]/u.test(name) ? name[0]+be(name.slice(1)) : be(name);
}

function styleSymbols(card) {
  const symbols=new Set();
  for(const {value} of V(card)) {
    for(const m of value.matchAll(/\b(?:class|id)\s*=\s*["']([^"']+)["']/gu)) for(const token of m[1].split(/\s+/u)) if(te(token)) symbols.add(token);
    for(const m of value.matchAll(/[.#]([\p{L}_-][\p{L}\p{N}_-]*)|(--[\p{L}_-][\p{L}\p{N}_-]*)/gu)) if(te(m[1]||m[2])) symbols.add(m[1]||m[2]);
  }
  return [...symbols];
}

function localizeProse(text) {
  return text.replace(phrasePattern, word => taiwanPhrases.get(word)).split('\n').map(line => {
    // An idol/group role, not a choir leader or an instruction to lead singing.
    if (!/合唱|教會|教堂|詩班|詩歌|帶領|帶大家/u.test(line) && /Rapper|男團|女團|偶像|樂團|組合.*(?:成員|主)|團體.*成員/iu.test(line)) {
      return line.replace(/領唱/gu, '主唱');
    }
    return line;
  }).join('\n');
}

function prosePath(path, text) {
  if (/\/(?:extensions|findRegex|replaceString|scriptName|keys|keysecondary)(?:\/|$)/u.test(path)) return false;
  // Embedded executable/templates and MVU rules retain the legacy glyph-only path.
  if (/```|<script\b|<style\b|registerMvuSchema|stat_data|JSONPatch|\[initvar\]|\[mvu_update\]/iu.test(text)) return false;
  return /\/(?:description|personality|scenario|first_mes|mes_example|creator_notes|content|alternate_greetings\/\d+|group_only_greetings\/\d+)$/u.test(path);
}

function convertText(text, technicalTokens, path = '') {
  const addresses = protectText(text);
  const corrected = correctNames(addresses.masked);
  const tokens = [...technicalTokens, ...conversionContext.names, ...(conversionContext.symbolTargets||[])];
  const protectedText = protectText(corrected, tokens);
  let converted = be(protectedText.masked).replace(/傢夥/gu, '傢伙');
  if (conversionContext.localize && prosePath(path, text)) {
    // MVU identifiers keep their glyph mapping even when they resemble ordinary words.
    const identifiers = protectText(converted, conversionContext.technical.map(nameSafeGlyph), false);
    converted = identifiers.restore(localizeProse(identifiers.masked));
  }
  return {value: addresses.restore(protectedText.restore(converted)), kept: tokens.filter(token => token && corrected.includes(token))};
}

const legacyConvert = Ee;
Ee = function convertCard(card, options = {}) {
  const previous = conversionContext;
  const detected=collectNames(card);
  const fixed=new Set(options.protectedNames||[]);
  const corrections = new Map(detected.filter(name=>!fixed.has(name)).map(name=>[name,traditionalName(name)]));
  for(const [from,to] of Object.entries(options.nameCorrections||{})) corrections.set(from,to);
  const symbols=styleSymbols(card);
  const symbolMapping=symbols.map(before=>({before,after:be(before)}));
  for(const {before,after} of symbolMapping) if(!corrections.has(before)&&!fixed.has(before)) corrections.set(before,after);
  conversionContext = {
    names: [...fixed,...detected.map(name=>corrections.get(name)||name),...Object.values(options.nameCorrections||{})],
    technical: ne(card) === 'card' ? Ue(card) : [],
    corrections, symbolTargets:symbolMapping.map(x=>x.after), localize: options.localize !== false
  };
  try {
    const result = legacyConvert(card);
    result.protectedNames = conversionContext.names;
    result.nameMapping=detected.filter(name=>!/[（(]/u.test(name)).map(before=>({before,after:corrections.get(before)||before}));
    result.codeChecks=[];
    for(const field of V(card)) {
      const output=Be(result.output,field.path);
      if(typeof output!=='string')continue;
      for(const kind of ['style','script']) {
        const pattern=new RegExp('<'+kind+'\\b[^>]*>([\\s\\S]*?)<\\/'+kind+'>','giu');
        const sourceBlocks=[...field.value.matchAll(pattern)].map(m=>m[1]);
        const outputBlocks=[...output.matchAll(pattern)].map(m=>m[1]);
        if(!sourceBlocks.length)continue;
        const syntax=text=>text.replace(/[\p{Script=Han}]/gu,'');
        const ok=sourceBlocks.length===outputBlocks.length && sourceBlocks.every((block,i)=>syntax(block)===syntax(outputBlocks[i]));
        result.codeChecks.push({path:field.path,kind,blocks:sourceBlocks.length,ok});
        if(!ok)result.errors.push(`${field.path} 的 ${kind} 非中文字元／語法符號有變動，請檢查`);
      }
    }
    const checks=Je(card,result.output,symbolMapping.filter(x=>x.before!==x.after));
    result.linkChecks.push(...checks);
    for(const check of checks) if(!check.ok) result.errors.push(`樣式／腳本引用「${check.before}」未同步：${check.failures.join('、')}`);
    const targets=new Map();
    for(const item of [...result.nameMapping,...symbolMapping]) {
      if(targets.has(item.after)&&targets.get(item.after)!==item.before) result.errors.push(`名稱碰撞：「${targets.get(item.after)}」與「${item.before}」→「${item.after}」`);
      targets.set(item.after,item.before);
    }
    return result;
  } finally { conversionContext = previous; }
};
q = convertText;
