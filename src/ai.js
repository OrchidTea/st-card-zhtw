// Bring-your-own-key AI helper. The key lives only in this browser (localStorage when
// "remember" is ticked, otherwise memory); requests go straight to the chosen provider.
const TranslatorAI = (() => {
  const storageKey = 'st-tw-translator-ai-v1';
  const defaults = {
    anthropic: {model: 'claude-haiku-4-5-20251001', base: ''},
    openai: {model: '', base: 'https://api.openai.com/v1'},
    gemini: {model: 'gemini-3.5-flash-lite', base: ''}
  };
  let settings = {provider: 'gemini', model: defaults.gemini.model, base: '', key: '', remember: false};
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && typeof saved === 'object' && saved.key) settings = {...settings, ...saved, remember: true};
  } catch { /* storage unavailable: keep in memory only */ }

  function save(next) {
    settings = {...settings, ...next};
    try {
      if (settings.remember && settings.key) localStorage.setItem(storageKey, JSON.stringify({provider: settings.provider, model: settings.model, base: settings.base, key: settings.key}));
      else localStorage.removeItem(storageKey);
    } catch { /* ignore */ }
  }
  function clear() {
    settings = {...settings, key: '', remember: false};
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
  }
  const ready = () => !!(settings.key && settings.model && (settings.provider !== 'openai' || settings.base));

  // Free tiers limit requests per minute; wait and retry a couple of times before giving up.
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function request(system, user) {
    for (let attempt = 0; ; attempt++) {
      try { return await requestOnce(system, user); }
      catch (error) {
        if (!error.retryAfter || attempt >= 2) throw error;
        if (TranslatorAI.onWait) TranslatorAI.onWait(error.retryAfter);
        await sleep(error.retryAfter * 1000);
      }
    }
  }
  async function requestOnce(system, user) {
    const {provider, model, key} = settings;
    let response, data;
    const fail = async res => {
      let detail = '';
      try { const j = await res.json(); detail = j?.error?.message || j?.message || ''; } catch { /* ignore */ }
      const hint = res.status === 401 || res.status === 403 ? '金鑰無效或沒有權限' : res.status === 404 ? '模型名稱或網址錯誤' : res.status === 429 ? '額度用完或請求太頻繁' : '服務商回應錯誤';
      const error = new Error(`${hint}（HTTP ${res.status}）${detail ? '：' + detail.slice(0, 160) : ''}`);
      if (res.status === 429 && !/quota exceeded.*per day|PerDay|limit: 0\b/iu.test(detail)) {
        const header = Number(res.headers.get('retry-after')), hinted = Number((detail.match(/retry in ([\d.]+)s/iu) || [])[1]);
        error.retryAfter = Math.min(60, Math.ceil(header || hinted || 20));
      }
      throw error;
    };
    try {
      if (provider === 'anthropic') {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'},
          body: JSON.stringify({model, max_tokens: 4096, temperature: 0, system, messages: [{role: 'user', content: user}]})
        });
        if (!response.ok) await fail(response);
        data = await response.json();
        return (data.content || []).map(p => p.text || '').join('');
      }
      if (provider === 'gemini') {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: {'content-type': 'application/json', 'x-goog-api-key': key},
          body: JSON.stringify({systemInstruction: {parts: [{text: system}]}, contents: [{role: 'user', parts: [{text: user}]}], generationConfig: {temperature: 0}})
        });
        if (!response.ok) await fail(response);
        data = await response.json();
        return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      }
      response = await fetch(settings.base.replace(/\/+$/u, '') + '/chat/completions', {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: 'Bearer ' + key},
        body: JSON.stringify({model, temperature: 0, messages: [{role: 'system', content: system}, {role: 'user', content: user}]})
      });
      if (!response.ok) await fail(response);
      data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (error) {
      if (error instanceof TypeError) throw new Error('連不上服務商：可能是網路、網址錯誤，或該服務商不允許瀏覽器直接呼叫');
      throw error;
    }
  }

  const system = [
    '你是台灣繁體中文的校對員。使用者給你的是簡體中文角色卡經 OpenCC 自動轉成台灣繁體後的片段。',
    '每筆片段中 ⟦ ⟧ 框起來的字詞是自動轉換時容易出錯的地方。請依前後文判斷 ⟦ ⟧ 內的寫法在這個語境是否正確。',
    '只判斷錯字與誤轉（例如「頭髮／發現」「冷面／冷麵」「不准／不準」「乾／幹」「簽／籤」），不要改寫風格；作者刻意的用語、專有名詞、店名視為正確。',
    '若有提供候選寫法，優先從候選中選。修正只替換 ⟦ ⟧ 內的文字。',
    '只輸出 JSON 陣列，不要其他文字：[{"id":"編號","ok":true或false,"fix":"不正確時的正確寫法，正確時留空字串","reason":"20字內理由"}]'
  ].join('\n');

  function parse(text) {
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    if (start === -1 || end <= start) throw new Error('AI 回覆格式無法解析');
    const list = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(list)) throw new Error('AI 回覆格式無法解析');
    return list.filter(x => x && typeof x.id === 'string').map(x => ({id: x.id, ok: x.ok !== false, fix: typeof x.fix === 'string' ? x.fix : '', reason: typeof x.reason === 'string' ? x.reason.slice(0, 60) : ''}));
  }

  // items: [{id, before, match, after, options?}]
  async function judge(items, onProgress) {
    const results = new Map();
    for (let i = 0; i < items.length; i += 40) {
      const batch = items.slice(i, i + 40);
      // One item per line: newlines and the separator inside card text are flattened.
      const flat = t => String(t).replace(/\s*[\r\n]+\s*/gu, ' ⏎ ').replace(/[｜⟦⟧]/gu, ' ');
      const user = batch.map(x => `${x.id}｜${flat(x.before)}⟦${flat(x.match)}⟧${flat(x.after)}` + (x.options?.length ? `｜候選：${x.options.join('、')}` : '')).join('\n');
      const text = await request(system, user);
      for (const r of parse(text)) results.set(r.id, r);
      if (onProgress) onProgress(Math.min(i + 40, items.length), items.length);
    }
    return results;
  }
  // One-click wording pass: the AI lists Mainland wording found in each chunk with the
  // Taiwan equivalent. The page applies the list itself, so names and code stay protected.
  const wordingSystem = [
    '你是台灣繁體中文的在地化編輯。使用者給你的是簡體中文角色卡用 OpenCC 轉成繁體字之後的文字：字形已經是繁體，但用詞可能還是中國大陸的說法。',
    '請找出台灣讀者會覺得是「大陸用語」的詞，給出台灣常用的說法。例如：質量→品質、信息→訊息、激活→啟用、打印→列印、出租車→計程車、視頻→影片。',
    '規則：',
    '1. from 必須是原文裡逐字出現的詞（2～8 字），to 是台灣說法。',
    '2. 只換詞，不改寫句子、不潤飾文風、不改標點。',
    '3. 角色名、地名、組織名、作者自創的專有名詞、刻意的口語、方言、網路用語，一律不要改。',
    '4. 同一個詞在文中若有不同意思，或台灣也常這樣說，就不要列。',
    '5. 若看到 OpenCC 轉錯的字（例如「頭發」應為「頭髮」、「剋制」應為「克制」），也用同樣格式列出，from 要包含前後字以免誤改。',
    '6. 不確定就不要列。',
    '只輸出 JSON 陣列，不要其他文字：[{"from":"原文詞","to":"台灣說法","reason":"15字內理由"}]；沒有就輸出 []。'
  ].join('\n');
  async function wording(chunks, onProgress) {
    const found = [];
    let unreadable = 0;
    for (let i = 0; i < chunks.length; i++) {
      const text = await request(wordingSystem, chunks[i]);
      // A malformed answer for one chunk should not throw away the others.
      let list = null;
      try { const start = text.indexOf('['), end = text.lastIndexOf(']'); if (start !== -1 && end > start) list = JSON.parse(text.slice(start, end + 1)); } catch { list = null; }
      if (!Array.isArray(list)) unreadable++;
      else for (const x of list) if (x && typeof x.from === 'string' && typeof x.to === 'string')
        found.push({from: x.from.trim(), to: x.to.trim(), reason: typeof x.reason === 'string' ? x.reason.slice(0, 40) : ''});
      if (onProgress) onProgress(i + 1, chunks.length);
    }
    return {found, unreadable};
  }
  async function characterNames(text) {
    const answer = await request('你會閱讀角色卡。請列出這段文字裡會在故事中登場的角色名字（人名或固定稱呼），不要列 {{user}}、種族、地名、組織、物品。只輸出 JSON 字串陣列，例如 ["林小雨","王大明"]；沒有就輸出 []。', text);
    const start = answer.indexOf('['), end = answer.lastIndexOf(']');
    if (start === -1 || end <= start) throw new Error('AI 回覆格式無法解析');
    const list = JSON.parse(answer.slice(start, end + 1));
    return Array.isArray(list) ? [...new Set(list.filter(x => typeof x === 'string').map(x => x.trim()).filter(x => x && x.length <= 20))] : [];
  }
  async function test() {
    const r = await judge([{id: 't1', before: '粉絲', match: '髮現', after: '了他的祕密', options: ['發現']}]);
    return r.get('t1');
  }
  return {get: () => ({...settings}), save, clear, ready, judge, wording, characterNames, test, defaults};
})();
