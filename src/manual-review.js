// Manual review uses escaped JSON pointers; arbitrary object keys remain addressable.
const pointerEscape = key => key.replace(/~/g,'~0').replace(/\//g,'~1');
const pointerDecode = key => key.replace(/~1/g,'/').replace(/~0/g,'~');
function textFields(value, path = '$', result = []) {
  if (typeof value === 'string') result.push({path,value});
  else if (value && typeof value === 'object') for (const [key,child] of Object.entries(value)) textFields(child,path+'/'+pointerEscape(key),result);
  return result;
}
function fieldAt(value, path) { return path.split('/').slice(1).reduce((v,key)=>v?.[pointerDecode(key)],value); }
function setField(value, path, text) {
  const parts=path.split('/').slice(1).map(pointerDecode), last=parts.pop();
  const parent=parts.reduce((v,key)=>v[key],value);
  if (typeof parent[last] !== 'string') throw new Error('只能修改文字欄位');
  parent[last]=text;
}
function editableField(document, path) {
  if (ne(document)==='preset') return !!Fe(path);
  return !/\/(?:id|identifier|spec|spec_version|type|role|position|source|destination|placement|model)$/u.test(path)
    && !/\/export_with(?:\/|$)|\/button\/buttons\/\d+\/name$/u.test(path);
}
function previewReplacement(document, before, after, scope = 'all', selectedPath = '') {
  if (!before) throw new Error('請先輸入要尋找的文字');
  const output=U(document), impacts=[];
  for (const field of textFields(document)) if (field.value.includes(before)) {
    const editable=editableField(document,field.path);
    const selected=scope==='all'||field.path===selectedPath;
    const replacement=field.value.split(before).join(after);
    impacts.push({path:field.path,before:field.value,after:replacement,count:field.value.split(before).length-1,editable,selected:selected&&editable});
    if (selected&&editable) setField(output,field.path,replacement);
  }
  return {output,impacts,edit:{before,after,scope,path:selectedPath}};
}
function dependencies(document) {
  const found = new Set([...collectNames(document), ...Ue(document), ...styleSymbols(document)]);
  for (const field of textFields(document)) if (/\/(?:keys|keysecondary)\/\d+$/u.test(field.path)) found.add(field.value);
  return [...found].filter(Boolean);
}
function objectKeys(document, path='$', result=[]) {
  if(document && typeof document==='object') for(const [key,value] of Object.entries(document)) {
    if(!Array.isArray(document) && /[\p{Script=Han}]/u.test(key)) result.push({key,path:path+'/'+pointerEscape(key)});
    objectKeys(value,path+'/'+pointerEscape(key),result);
  }
  return result;
}
function validateManual(base, draft, edits = [], protectedNames = [], frozen = []) {
  const frozenSet=new Set(frozen);
  const errors=[...B(base,draft), ...Re(base,draft)], warnings=[], links=[];
  if (ne(base)==='preset') errors.push(...Xe(base,draft),...ke(draft));
  else errors.push(...Y(draft));
  const keyReferences=objectKeys(base);
  const baseFields=textFields(base), allDependencies=[...new Set([...dependencies(base),...protectedNames,...keyReferences.map(x=>x.key)])], targets=new Map();
  for(const field of baseFields) if(!editableField(base,field.path) && fieldAt(draft,field.path)!==field.value) errors.push(`${field.path} 是不可修改的設定欄位`);
  for (const token of allDependencies) {
    let target=token;
    // Frozen identifiers are masked during review decisions and must stay exact.
    if(!frozenSet.has(token)) for(const edit of edits) if(edit.before) target=target.split(edit.before).join(edit.after);
    if(target!==token && !target.trim()) errors.push(`「${token}」是姓名或引用識別字，不可清空`);
    if(target!==token && ee.includes(token)) errors.push(`「${token}」是固定技術標記，不可改名`);
    if(target!==token) for(const reference of keyReferences.filter(x=>x.key===token)) errors.push(`${reference.path} 的 JSON 鍵名仍為「${token}」；本工具不重命名結構鍵，請保留對應引用`);
    const previous=targets.get(target);
    if(previous && previous!==token) errors.push(`「${previous}」與「${token}」會合併成「${target}」`);
    targets.set(target,token);
    const paths=baseFields.filter(field=>field.value.includes(token));
    const failures=[];
    for (const field of paths) {
      const value=fieldAt(draft,field.path);
      const expected=field.value.split(token).length-1;
      if(typeof value!=='string'||!target||value.split(target).length-1<expected || (target!==token&&!target.includes(token)&&value.includes(token))) failures.push(field.path);
    }
    if(failures.length) errors.push(`「${token}」${target!==token?` → 「${target}」`:''} 未同步或被刪除：${failures.join('、')}`);
    if(target!==token||failures.length) links.push({before:token,after:target,paths:paths.map(f=>f.path),failures,ok:!failures.length});
  }
  for(const field of baseFields) {
    const next=fieldAt(draft,field.path);
    if(next===field.value) continue;
    if(/\/findRegex$/u.test(field.path)) {
      const compile=value=> {const match=value.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/u);return match?new RegExp(match[1],match[2]):new RegExp(value);};
      try {compile(field.value);} catch {warnings.push(`${field.path} 原本的正則無法解析，需在酒館測試`);continue;}
      try {compile(next);} catch(error) {errors.push(`${field.path} 修改後正則無效：${error.message}`);}
    }
    if(/\/(?:content|replaceString)$/u.test(field.path) && /<script\b|\b(?:function|const|let)\s|registerMvuSchema/u.test(next)) warnings.push(`${field.path} 含程式；文字引用檢查通過仍需在酒館測試實際執行`);
  }
  return {errors:[...new Set(errors)],warnings:[...new Set(warnings)],links};
}
