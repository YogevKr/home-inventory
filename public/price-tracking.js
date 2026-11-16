export function priceSourceLabel(row){
  if(row.source?.provider==='brightdata')return `Bright Data · US${row.source.postalCode?` ${row.source.postalCode}`:''} · Regular price${row.source.seller?` · ${row.source.seller}`:''}`;
  return row.method==='page'?'Store check':'Recorded price';
}

export function renderPricePanel(root,item,{esc,money,date,send,load,onChange}){
  if(!root)return;
  const tracking=item.priceTracking;
  const history=tracking?.observations||[],latest=history[0],previous=history[1];
  const editable=item.data.status==='wishlist',linked=Boolean(item.data.productUrl);
  if(!editable&&!history.length){root.remove();return;}
  const comparable=latest&&previous&&JSON.stringify(latest.source||null)===JSON.stringify(previous.source||null);
  const change=comparable?latest.price_minor-previous.price_minor:null;
  const trend=latest&&previous&&!comparable?'Price sources differ. Compare the offer details.':change===null?'Record another price to compare.':change===0?'No change since the previous price.':`${money(Math.abs(change),latest.currency)} ${change<0?'less':'more'} than the previous price.`;
  const points=history.filter(point=>JSON.stringify(point.source||null)===JSON.stringify(latest.source||null)).slice(0,30).reverse(),values=points.map(point=>point.price_minor),low=Math.min(...values),high=Math.max(...values);
  const graph=points.length>1?`<svg class="price-chart" viewBox="0 0 300 64" role="img" aria-label="Price history. ${esc(trend)}"><path class="price-chart-base" d="M4 58H296"/><polyline points="${points.map((point,index)=>`${4+index/(points.length-1)*292},${high===low?32:54-(point.price_minor-low)/(high-low)*44}`).join(' ')}"/></svg><div class="price-chart-dates"><span>${date(points[0].observed_at)}</span><span>${date(latest.observed_at)}</span></div>`:'';
  root.innerHTML=`<div class="price-tracker-heading"><h3>Price tracker</h3>${editable?`<button class="button secondary" type="button" data-check-price ${tracking?.supported?'':'disabled'}>Check price</button>`:''}</div>${latest?`<div class="tracked-price"><span class="tracked-price-value">${esc(money(latest.price_minor,latest.currency))}</span><span class="tracked-price-date">${esc(priceSourceLabel(latest))} · ${date(latest.observed_at)}</span></div><p class="price-trend ${change<0?'price-drop':''}">${esc(trend)}</p><p class="form-hint">Lowest recorded: ${esc(money(tracking.lowest,latest.currency))} · ${tracking.count} record${tracking.count===1?'':'s'}</p>${graph}`:'<p class="description">Watch the price before you buy.</p><p class="form-hint">Record a price to start its history.</p>'}${editable?`<p class="form-hint">${tracking?.provider==='brightdata'?`Checks use Bright Data · ${esc(tracking.market)} · Regular prices.`:'Checks run when you request them.'}</p>${tracking?.reason?`<p class="form-hint">${esc(tracking.reason)}</p>`:''}`:''}${tracking?.lastCheck?.error?`<p class="price-check-note" role="status">Price check failed · ${date(tracking.lastCheck.checked_at)}<br>${esc(tracking.lastCheck.error)}</p>`:''}<div class="error-message" data-price-error role="alert" hidden></div>${editable&&linked?`<details class="price-record"><summary>Record a price</summary><form data-price-form><p class="form-hint">Check the model, options, and currency on the product page first.</p><div class="price-record-fields"><label class="form-field">Price (${esc(item.data.currency)})<input name="price" type="number" min="0.01" max="10000000000" step="0.01" required inputmode="decimal"></label><button class="button secondary" type="submit">Save price</button></div></form></details>`:''}${linked?`<a class="price-store-link" href="${esc(item.data.productUrl)}" target="_blank" rel="noopener noreferrer">View product ↗</a>`:''}${history.length?`<details class="price-history"><summary>Price history (${tracking.count})</summary>${tracking.count>history.length?'<p class="form-hint">Showing the latest 100 records. The full export contains all records.</p>':''}<ol>${history.map(row=>`<li><span><time datetime="${esc(row.observed_at)}">${new Date(row.observed_at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})}</time><small>${esc(priceSourceLabel(row))}</small></span><strong>${esc(money(row.price_minor,row.currency))}</strong></li>`).join('')}</ol></details>`:''}`;
  async function save(path,body,button){
    const error=root.querySelector('[data-price-error]');error.hidden=true;
    const controls=[...root.querySelectorAll('button,input')],disabled=controls.map(control=>control.disabled);
    controls.forEach(control=>control.disabled=true);
    const label=button.textContent;button.textContent=path.endsWith('/check')?'Checking…':'Saving…';
    try{
      const updated=await send(`/api/items/${item.id}/prices${path}`,body);
      if(root.isConnected){onChange(updated);renderPricePanel(root,{...item,priceTracking:updated},{esc,money,date,send,load,onChange});root.querySelector(path? '[data-check-price]':'.price-record summary')?.focus({preventScroll:true});}
    }catch(failure){
      if(!root.isConnected)return;
      let updated;
      if(path==='/check'){
        try{updated=await load(`/api/items/${item.id}/prices`);}catch{}
        if(!root.isConnected)return;
        if(updated){onChange(updated);renderPricePanel(root,{...item,priceTracking:updated},{esc,money,date,send,load,onChange});}
        if(failure.status===422)root.querySelector('.price-record')?.setAttribute('open','');
        root.querySelector(failure.status===422?'.price-record summary':'[data-check-price]')?.focus({preventScroll:true});
      }
      if(updated?.lastCheck?.error!==failure.message){
        const currentError=root.querySelector('[data-price-error]');
        currentError.textContent=failure.message;currentError.hidden=false;
      }
    }
    finally{controls.forEach((control,index)=>control.disabled=disabled[index]);button.textContent=label;}
  }
  root.querySelector('[data-check-price]')?.addEventListener('click',event=>save('/check',{revision:item.revision},event.currentTarget));
  root.querySelector('[data-price-form]')?.addEventListener('submit',event=>{
    event.preventDefault();
    const form=event.currentTarget;
    form.dataset.observationId||=crypto.randomUUID();
    const priceMinor=Math.round(Number(form.elements.price.value)*100);
    const body={id:form.dataset.observationId,revision:item.revision,priceMinor,currency:item.data.currency,productUrl:item.data.productUrl};
    save('',body,form.querySelector('button'));
  });
  root.querySelector('[name=price]')?.addEventListener('input',event=>delete event.currentTarget.form.dataset.observationId);
}
