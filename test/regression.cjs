// Regression tests. Card files are not distributed; put them in test/cards/ to run the real-card suite.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const context = {TextEncoder, TextDecoder, atob, btoa, console};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../build/core.js'), 'utf8'), context);
const api = context.CardTranslator;
let passed = 0, skipped = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }
const card = (description, extra = {}) => ({spec: 'chara_card_v3', data: {name: '范道允', description, character_book: {entries: []}, ...extra}});
const all = r => JSON.stringify(r.output);

test('OpenCC 常見誤轉自動修正', () => {
  const r = api.convert(card('粉丝发现了。明天签售会。组合回归期。我不签。两份待签文件。他不是只有这样。一直发消息。回归分析模型。'));
  const d = r.output.data.description;
  for (const good of ['粉絲發現', '簽售會', '組合回歸期', '我不簽', '待簽文件', '不是只有', '一直發消息', '迴歸分析']) assert.ok(d.includes(good), good + ' in ' + d);
  assert.equal(r.errors.length, 0);
});
test('正確用字不被誤傷', () => {
  const d = api.convert(card('头发、短发、泡面、面包、标签、书签、中签、干活、干净、一只手、准备、规范、令人发指')).output.data.description;
  assert.equal(d, '頭髮、短髮、泡麵、麵包、標籤、書籤、中籤、幹活、乾淨、一隻手、準備、規範、令人髮指');
});
test('姓名：范不變範、其他字正常繁體化', () => {
  const r = api.convert(card('Chinese name: 范道允\nNickname: 范狗\n陆彦楷、姜瑞镇、苏叶琛在规范范围内。'));
  assert.equal(r.output.data.name, '范道允');
  assert.match(r.output.data.description, /范狗\n陸彥楷、姜瑞鎮、蘇葉琛在規範範圍內/u);
});
test('台灣用語與台／臺選項', () => {
  const on = api.convert(card('舞台上看视频，屏幕默认点赞，台湾网络。')).output.data.description;
  assert.equal(on, '舞台上看影片，螢幕預設按讚，台灣網路。');
  const off = api.convert(card('舞台上'), {useTai: false}).output.data.description;
  assert.equal(off, '舞臺上');
});
test('待確認詞只提醒不改', () => {
  const r = api.convert(card('他是冷面狼主，住酒店，不准走，不准确，声音有点干，干活。基本信息。'));
  const d = r.output.data.description;
  assert.ok(d.includes('冷麵狼主') && d.includes('酒店') && d.includes('不準走'));
  const terms = Object.fromEntries(r.review.map(g => [g.term, g.items.length]));
  assert.equal(terms['冷麵'], 1); assert.equal(terms['酒店'], 1); assert.equal(terms['不準'], 1); assert.equal(terms['幹'], 1); assert.equal(terms['信息'], 1);
});
test('網址、id/class、JS 名稱、巨集不動；畫面文字轉換', () => {
  const html = '<div id="播放器" class="屏幕 主页">屏幕默认</div><audio src="https://music.163.com/视频.mp3"></audio><script>function togglePlay(){document.getElementById("播放器");eventEmit("PLAY_视频")}</script>{{user}}';
  const c = card('x', {extensions: {regex_scripts: [{id: 'a', scriptName: '主页', findRegex: '【角色主页】', replaceString: html, placement: [2]}]}, first_mes: '【角色主页】'});
  const r = api.convert(c);
  const out = r.output.data.extensions.regex_scripts[0];
  assert.equal(r.errors.length, 0, r.errors.join('\n'));
  assert.ok(out.replaceString.includes('https://music.163.com/视频.mp3'));
  assert.ok(out.replaceString.includes('togglePlay') && out.replaceString.includes('"PLAY_視頻"'));
  assert.ok(out.replaceString.includes('>螢幕預設</div>'));
  assert.equal(out.findRegex, '【角色主頁】'); assert.equal(r.output.data.first_mes, '【角色主頁】');
  assert.equal(r.audio.length, 1);
});
test('技術檢核：改到網址或程式名稱會被擋', () => {
  const c = card('<script>function goHome(){}</script> https://a.test/x');
  const r = api.convert(c), draft = api.U(r.output);
  draft.data.description = draft.data.description.replace('goHome', 'goHom2');
  assert.ok(api.technicalIntegrity(c, draft).errors.length > 0);
});
test('全部改寫時保護識別字，並通過手動檢核', () => {
  const c = card('冷面狼主和冷面殺手', {extensions: {regex_scripts: [{id: 'a', scriptName: 'x', findRegex: '/a/', replaceString: '<div class="冷面">冷面狼主</div>', placement: [2]}]}});
  const r = api.convert(c), draft = api.U(r.output);
  const g = r.review.find(x => x.term === '冷麵');
  const n = api.replaceAllReview(draft, g.rule, '冷面', r.frozen);
  assert.equal(n, 3);
  assert.ok(draft.data.extensions.regex_scripts[0].replaceString.startsWith('<div class="冷麵">冷面狼主'));
  assert.equal(api.technicalIntegrity(c, draft).errors.length, 0);
});
test('MVU 變數名稱保持同一字形', () => {
  const c = card('网络和模块');
  c.data.extensions = {tavern_helper: {scripts: [{id: 'fixed', content: 'const Schema = z.object({\n网络: z.string(),\n模块: z.string()\n});\nstat_data.网络;', export_with: {name: '不转换'}}]}};
  const r = api.convert(c);
  assert.equal(r.errors.length, 0, r.errors.join('\n'));
  assert.ok(r.output.data.extensions.tavern_helper.scripts[0].content.includes('網絡: z.string()'));
  assert.ok(r.output.data.description.includes('網絡'));
});
test('手動改名同步檢核（v0.3.2 行為）', () => {
  const c = card('Chinese name: 范道允\n范道允很帥。', {character_book: {entries: [{keys: ['范道允'], content: '范道允的設定', comment: 'a'}]}});
  const r = api.convert(c), p = api.previewReplacement(r.output, '范道允', '范小允');
  assert.equal(api.validateManual(r.output, p.output, [p.edit], r.protectedNames).errors.length, 0);
  const half = api.U(r.output); half.data.description = half.data.description.replace('范道允很帥', '范小允很帥');
  assert.ok(api.validateManual(r.output, half, [{before: '范道允', after: '范小允'}], r.protectedNames).errors.length > 0);
});
test('重複轉換結果穩定', () => {
  const r = api.convert(card('粉丝发现签售会回归，屏幕默认。'));
  assert.equal(all(api.convert(r.output)), all(r));
});
test('AI 校正：只在可改的欄位找詞，接受與恢復都能還原', () => {
  const r = api.convert(card('这个产品的质量很好。质量第一，<span class="质量">质量</span>', {
    character_book: {entries: [{keys: ['质量'], content: '质量检查。https://x.cn/质量', comment: '质量'}]}}));
  const doc = api.U(r.output), before = JSON.stringify(doc);
  const occ = api.locateAll(doc, /質量/gu, r.frozen);
  // class 名稱與網址裡的不算；描述 3 處、觸發詞 1、內容 1、標題 1
  assert.equal(occ.length, 6, JSON.stringify(occ.map(o => o.path)));
  for (const o of occ) assert.ok(api.swapInContext(doc, o, '質量', '品質'));
  const after = JSON.stringify(doc);
  assert.ok(after.includes('class=\\"質量\\"') && after.includes('https://x.cn/质量') && !doc.data.description.replace('class="質量"', '').includes('質量'));
  for (const o of occ) assert.ok(api.swapInContext(doc, o, '品質', '質量'));
  assert.equal(JSON.stringify(doc), before);
});
test('AI 校正：送出的文字不含網址與程式碼', () => {
  const r = api.convert(card('正文质量。', {extensions: {regex_scripts: [{findRegex: '质量', replaceString: '<div class="a">显示质量</div><script>const x = 1;</script>'}]}}));
  const text = api.proseChunks(r.output).join('\n');
  assert.ok(text.includes('正文質量') && text.includes('顯示質量'));
  assert.equal(/<script|const x|class=/u.test(text), false);
});
test('角色名按鈕：新增輸入助手腳本、更新時保留其他按鈕', () => {
  const r = api.convert(card('', {character_book: {entries: [{keys: ['林小雨'], comment: '主角林小雨', content: '林小雨'}]}}));
  assert.equal(JSON.stringify(api.nameCandidates(r.output).map(c => c.name)), JSON.stringify(['林小雨']));
  const once = api.withNameButtons(r.output, ['林小雨', '王大明'], () => 'id-1');
  const s = once.data.extensions.tavern_helper.scripts;
  assert.equal(s.length, 1);
  assert.ok(s[0].content.includes('/酒馆助手/输入助手/index.js'));
  assert.equal(JSON.stringify(s[0].button.buttons.map(b => b.name)), JSON.stringify(['林小雨', '王大明']));
  assert.equal(s[0].data.buttons[1].cursor_position, 3);
  assert.equal(r.output.data.extensions?.tavern_helper, undefined, '原稿不應被改動');
  s[0].data.buttons.unshift({name: '「」', enable: true, description: '引號', content: '「」', cursor_position: 1, insert_position: 'as_is'});
  const twice = api.withNameButtons(once, ['王大明'], () => 'id-2').data.extensions.tavern_helper.scripts;
  assert.equal(twice.length, 1); assert.equal(twice[0].id, 'id-1');
  assert.equal(JSON.stringify(twice[0].data.buttons.map(b => b.name)), JSON.stringify(['「」', '王大明']));
});

// ---------- real cards ----------
const cardDir = path.join(__dirname, 'cards');
function load(file) {
  const b = fs.readFileSync(path.join(cardDir, file));
  return api.readPng(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
function realCard(name, file, fn) {
  if (!fs.existsSync(path.join(cardDir, file))) { skipped++; console.log('SKIP', name, '（缺少', file, '）'); return; }
  test(name, () => fn(load(file)));
}
function commonCardChecks(png, r) {
  assert.equal(r.errors.length, 0, r.errors.join('\n'));
  assert.equal(r.outputWarnings.length, 0);
  assert.equal(api.validateManual(r.output, r.output, [], r.protectedNames).errors.length, 0);
  // regex triggers must still match the text they trigger on
  const data = r.output.data, text = JSON.stringify(data);
  for (const s of data.extensions.regex_scripts) {
    const m = s.findRegex.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/u);
    const re = m ? new RegExp(m[1], m[2].replace('g', '')) : new RegExp(s.findRegex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const literal = (s.findRegex.match(/[\p{Script=Han}【】]+/gu) || []);
    for (const piece of literal) assert.ok(text.split(piece).length > 2, `正則「${s.scriptName}」的觸發字「${piece}」在卡片其他地方找不到`);
  }
  // PNG round trip keeps image chunks and both metadata copies
  const out = api.writePng(png, r.output), back = api.readPng(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
  assert.equal(JSON.stringify(back.card), JSON.stringify(r.output));
  const isMeta = c => c.type === 'tEXt' && /^(chara|ccv3)\0/u.test(new TextDecoder().decode(c.data.subarray(0, 6)));
  assert.deepEqual(png.chunks.filter(c => !isMeta(c)).map(c => Buffer.from(c.raw).toString('base64')), back.chunks.filter(c => !isMeta(c)).map(c => Buffer.from(c.raw).toString('base64')));
  assert.equal(back.chunks.filter(isMeta).length, png.chunks.filter(isMeta).length);
  return text;
}
realCard('范道允：錯字歸零、正則與音源不變', 'fan-original.png', png => {
  const r = api.convert(png.card), text = commonCardChecks(png, r);
  for (const bad of ['範道允', '範狗', '範成浩', '迴歸', '籤售', '籤錯', '髮現', '髮消息', '隻有', '屏幕', '默認', '點贊']) assert.equal(text.includes(bad), false, '仍有「' + bad + '」');
  assert.ok(text.includes('主Rapper、主唱'));
  assert.ok(text.includes('https://music.163.com/song/media/outer/url?id=477331651.mp3'));
  assert.ok(text.includes('【角色主頁】'));
  const terms = Object.fromEntries(r.review.map(g => [g.term, g.items.filter(i => !i.mirror).length]));
  assert.equal(terms['冷麵'], 2); assert.equal(terms['不準'], 5);
  assert.equal(r.audio.length, 1);
  const orig = png.card.data.extensions.regex_scripts[1].replaceString, conv = r.output.data.extensions.regex_scripts[1].replaceString;
  const code = s => (s.match(/<script[\s\S]*?<\/script>/u) || [''])[0].replace(/[\p{Script=Han}　-〿＀-￯]/gu, '');
  assert.equal(code(conv), code(orig));
});
realCard('江知弈：錯字歸零、播放器與觸發字對應', 'jiang-original.png', png => {
  const r = api.convert(png.card), text = commonCardChecks(png, r);
  for (const bad of ['不籤', '要籤', '待籤', '江總髮了', '隻是客氣']) assert.equal(text.includes(bad), false, '仍有「' + bad + '」');
  assert.ok(text.includes('<song>若不遲</song>'));
  const terms = Object.fromEntries(r.review.map(g => [g.term, g.items.filter(i => !i.mirror).length]));
  assert.equal(terms['幹'], 2);
  assert.equal(r.audio.length, 0);
  for (const url of JSON.stringify(png.card).match(/https:\/\/files\.catbox\.moe\/\w+\.mp3/gu)) assert.ok(text.includes(url));
});
console.log(`\n${passed} 項通過${skipped ? `，${skipped} 項因缺少實卡略過` : ''}`);
