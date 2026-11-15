export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function linkify(value){
  const text=String(value??'');
  let html='',offset=0;
  for(const match of text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)){
    let url=match[0];
    while(/[.,!?;:)\]}]$/.test(url)){
      const close=url.at(-1),open={')':'(',']':'[','}':'{'}[close];
      if(open&&url.split(open).length>=url.split(close).length)break;
      url=url.slice(0,-1);
    }
    html+=escapeHtml(text.slice(offset,match.index));
    if(URL.canParse(url))html+=`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`+escapeHtml(match[0].slice(url.length));
    else html+=escapeHtml(match[0]);
    offset=match.index+match[0].length;
  }
  return html+escapeHtml(text.slice(offset));
}
