// A PNG may carry both compatibility (chara) and current (ccv3) metadata.
// Update both instead of leaving a stale copy for a different importer.
Pe = function writeSynchronizedPng(png, card) {
  const result=[png.original.slice(0,8)], written=new Set();
  for(const chunk of png.chunks) {
    if(chunk.type==='tEXt') {
      const zero=chunk.data.indexOf(0);
      const keyword=new TextDecoder().decode(chunk.data.subarray(0,zero));
      if(keyword==='chara'||keyword==='ccv3') {
        if(!written.has(keyword)) {
          let output=card;
          if(keyword==='chara') {
            try {
              const old=JSON.parse(et(new TextDecoder().decode(chunk.data.subarray(zero+1))));
              if(old.spec==='chara_card_v2') output={...card,spec:'chara_card_v2',spec_version:old.spec_version||'2.0'};
            } catch { /* Replace malformed compatibility metadata with the validated card. */ }
          }
          result.push(Ze('tEXt',oe.encode(`${keyword}\0${tt(JSON.stringify(output))}`)));
          written.add(keyword);
        }
        continue;
      }
    }
    result.push(chunk.raw);
  }
  if(!written.size) throw new Error('找不到可更新的角色卡 metadata');
  return re(...result);
};
