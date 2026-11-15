import { sampleItems, sampleLocations } from './sample.js';
import { exportArchive } from './export.bundle.js';
import { escapeHtml as esc, linkify } from './text.js';
import { InboxReview } from './inbox.js';
import { ItemSharing } from './sharing.js';

const $=selector=>document.querySelector(selector);
const paths={grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',box:'m3 7 9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5 M12 12v10 M7.5 4.5l9 5',pin:'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0',home:'m3 10 9-7 9 7v11H3z M9 21v-8h6v8',inbox:'M3 4h18v16H3z M3 13h5l2 3h4l2-3h5',clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2',search:'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 15l6 6',list:'M8 5h13 M8 12h13 M8 19h13 M3 5h.01 M3 12h.01 M3 19h.01',wallet:'M3 6h17v15H3z M3 6V3h15v3 M15 11h6v5h-6z',camera:'M3 7h4l2-3h6l2 3h4v13H3z M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',close:'m6 6 12 12 M6 18 18 6',edit:'m4 16-1 5 5-1L20 8l-4-4z M13 7l4 4',file:'M5 2h9l5 5v15H5z M14 2v6h5 M8 13h8 M8 17h6',arrow:'M4 12h16 M14 6l6 6-6 6',check:'m5 12 4 4L19 6',archive:'M3 3h18v5H3z M5 8v13h14V8 M9 12h6',tag:'M3 3h8l10 10-8 8L3 11z M7 7h.01'};
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.box}"/></svg>`;
const state={sample:new URLSearchParams(location.search).get('sample')==='1',view:'items',location:null,tag:'',query:'',purchaseFor:'',sort:'purchaseDate',direction:'desc',noPhoto:false,layout:'grid',items:[],total:0,recordTotal:0,purchases:[],bootstrap:null,selected:null,tab:'overview',editing:null,requestId:0,itemsLoading:false,itemsQuery:null,itemsPriceReference:null,priceReference:null};
let debounce,toastTimeout;
const money=(minor,currency='ILS')=>minor===null?'—':new Intl.NumberFormat('en-IL',{style:'currency',currency,maximumFractionDigits:minor%100===0?0:2}).format(minor/100);
const date=value=>value?new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric'}).format(new Date(value)):'—';
const locations=()=>state.sample?sampleLocations:state.bootstrap?.locations??[];
function locationPath(id){const list=locations();const parts=[];let current=list.find(p=>p.id===id);const visited=new Set();while(current&&!visited.has(current.id)){visited.add(current.id);parts.unshift(current.name);current=list.find(p=>p.id===current.parent_id);}return parts.join(' / ')||'No place yet';}
const placeName=id=>locations().find(p=>p.id===id)?.name||'No place yet';
function toast(message){clearTimeout(toastTimeout);$('#toast').textContent=message;$('#toast').hidden=false;toastTimeout=setTimeout(()=>$('#toast').hidden=true,4500);}
async function api(path,options={}){const response=await fetch(path,options);let data;try{data=await response.json();}catch{throw new Error('Your session expired. Reload this page to sign in.');}if(!response.ok)throw Object.assign(new Error(data.error||'The request failed.'),{status:response.status});return data;}
const send=(path,body,method='POST')=>api(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const tags=()=>state.sample?[...new Set(sampleItems.flatMap(item=>item.data.tags))]:state.bootstrap?.tags.map(tag=>tag.name)??[];
const countStatus=status=>state.sample?(status==='active'?sampleItems.length:0):state.bootstrap?.counts.find(row=>row.status===status)?.count??0;
const collectionCount=()=>['active','lent','inbox'].reduce((sum,status)=>sum+countStatus(status),0);
function renderChrome(){
  document.body.dataset.view=state.view;
  $('#main-nav').innerHTML=[['items','grid','Collection',collectionCount()],['places','home','Places',locations().length],['inbox','inbox','Inbox',countStatus('inbox')],['activity','clock','History',''],['archived','archive','Archive',countStatus('archived')]].map(([view,symbol,label,count])=>`<button class="nav-item ${state.view===view?'active':''}" data-view="${view}" ${state.view===view?'aria-current="page"':''}><span>${label}</span>${view==='inbox'&&count?`<span class="nav-count">${count}</span>`:''}</button>`).join('');
  const headings={items:['Your collection','Find what you own. Know where it belongs.'],places:['A place for everything','From rooms to shelves. Make every item easy to find.'],inbox:['Your inbox','Review your purchases, one product at a time.'],activity:['Collection history','A record of the changes you and your agents make.'],archived:['Archived items','Keep the record when an item leaves your home.']};
  const [title,subtitle]=headings[state.view];
  $('#title').innerHTML=`${esc(state.location?placeName(state.location):title)}.${state.view==='items'&&!state.location?` <span class="count-inline">${collectionCount()}</span>`:''}`;
  $('#subtitle').textContent=state.location?locationPath(state.location):subtitle;
  $('#sample-banner').hidden=!state.sample;
  const values=state.sample?[{currency:'ILS',total:sampleItems.reduce((sum,item)=>sum+item.data.priceMinor,0)}]:state.bootstrap?.values.filter(value=>value.total!==null)??[];
  const amount=values.length?values.map(value=>esc(money(value.total,value.currency))).join(' · '):'—';
  $('#summary').innerHTML=`<div class="stat"><div class="stat-icon">${icon('box')}</div><div><div class="stat-number">${collectionCount()}</div><div class="stat-label">Items recorded</div></div><div class="stat-note">All in one place</div></div><div class="stat"><div class="stat-icon">${icon('home')}</div><div><div class="stat-number">${locations().length}</div><div class="stat-label">Places to find them</div></div></div><div class="stat"><div class="stat-icon">${icon('wallet')}</div><div><div class="stat-number ${values.length>1?'currency-list':''}">${amount}</div><div class="stat-label">Recorded purchase value</div></div></div>`;
}
const sortOptions=[['recent','desc','Updated: newest'],['recent','asc','Updated: oldest'],['name','asc','Name: A to Z'],['name','desc','Name: Z to A'],['purchaseDate','desc','Purchased: newest'],['purchaseDate','asc','Purchased: oldest'],['price','asc','Price: low to high'],['price','desc','Price: high to low']];
const sortPrice=item=>item.data.priceMinor===null?null:item.sortPriceMinor??Math.round(item.data.priceMinor/state.priceReference.rates[item.data.currency]);
function sampleOrder(a,b){
  const direction=state.direction==='asc'?1:-1;
  let compared=0;
  if(state.sort==='price'){
    compared=Number(a.data.priceMinor===null)-Number(b.data.priceMinor===null);
    if(!compared)compared=(sortPrice(a)-sortPrice(b))*direction;
  }else if(state.sort==='purchaseDate'){
    compared=Number(!a.data.purchaseDate)-Number(!b.data.purchaseDate);
    if(!compared)compared=a.data.purchaseDate.localeCompare(b.data.purchaseDate)*direction;
  }else compared=(state.sort==='name'?a.data.name.localeCompare(b.data.name):a.updated_at.localeCompare(b.updated_at))*direction;
  return compared||a.id.localeCompare(b.id);
}
function renderToolbar(){return `<div class="toolbar"><label class="search">${icon('search')}<input id="search" type="search" placeholder="Search your things…" value="${esc(state.query)}" aria-label="Search items"><kbd>/</kbd></label><div class="filter-row" role="group" aria-label="Filter by tag"><button class="chip ${!state.tag?'active':''}" data-tag="" aria-pressed="${!state.tag}">All items</button>${tags().map(tag=>`<button class="chip ${state.tag===tag?'active':''}" data-tag="${esc(tag)}" aria-pressed="${state.tag===tag}">${esc(tag)}</button>`).join('')}</div><div class="toolbar-right"><select id="sort" class="sort-select" aria-label="Sort items">${sortOptions.map(([sort,direction,label])=>`<option value="${sort}:${direction}" ${state.sort===sort&&state.direction===direction?'selected':''}>${label}</option>`).join('')}</select><div class="view-toggle" role="group" aria-label="Collection view"><button data-layout="grid" class="${state.layout==='grid'?'selected':''}" aria-label="Grid view" aria-pressed="${state.layout==='grid'}">${icon('grid')}</button><button data-layout="list" class="${state.layout==='list'?'selected':''}" aria-label="List view" aria-pressed="${state.layout==='list'}">${icon('list')}</button></div></div></div><div class="collection-meta"><div class="filter-controls"><button class="chip ${state.noPhoto?'active':''}" data-action="no-photo" aria-pressed="${state.noPhoto}">${icon('camera')} No photo</button><div class="purchase-filter" role="group" aria-label="Who purchases are for">${[['','Everyone'],['self','For me'],['other','For others']].map(([value,label])=>`<button class="chip ${state.purchaseFor===value?'active':''}" data-purchase-for="${value}" aria-pressed="${state.purchaseFor===value}">${label}</button>`).join('')}</div></div><span class="result-count" role="status">${state.itemsLoading?'Loading items…':`${state.total} product${state.total===1?'':'s'} · ${state.recordTotal} purchase${state.recordTotal===1?'':'s'}`}</span>${state.location?'<button class="text-button" data-action="clear-location">Clear place ×</button>':''}</div>${state.sort==='price'?`<p class="sort-hint">Prices compare in USD. Reference rates: ${date(state.priceReference.date)}. Original prices appear below. Unknown prices appear last.</p>`:state.sort==='purchaseDate'?'<p class="sort-hint">Unknown dates appear last.</p>':''}`;}
function groupPrice(item){
  if(state.sort==='price')return item.data.priceMinor===null?'Price not set':(item.data.currency===state.priceReference.currency?'':'≈ ')+money(sortPrice(item),state.priceReference.currency);
  if(!item.purchases||item.purchases.length<2)return item.data.priceMinor===null?'Price not set':money(item.data.priceMinor,item.data.currency);
  const prices=item.purchases.filter(p=>p.priceMinor!==null);
  if(!prices.length)return 'Price not set';
  if(prices.length!==item.purchases.length||new Set(prices.map(p=>p.currency)).size>1)return 'Prices vary';
  const low=Math.min(...prices.map(p=>p.priceMinor)),high=Math.max(...prices.map(p=>p.priceMinor));
  return low===high?money(low,prices[0].currency):'From '+money(low,prices[0].currency);
}
function card(item,index){const d=item.data;const place=new Set(item.purchases?.map(p=>p.locationId)).size>1?'Multiple places':locationPath(d.locationId).split(' / ').slice(-2).join(' · ');return `<button class="item-card" data-item="${esc(item.id)}" aria-label="Open ${esc(d.name)}"><div class="card-photo">${item.art?`<img src="/art/${item.art}.svg" alt="Sample ${item.art}" loading="lazy">`:item.photo_id?`<img src="/api/files/${esc(item.photo_id)}" alt="${esc(d.name)}" loading="lazy">`:`<div class="placeholder-art">${icon('camera')}<span>No photo</span></div>`}<div class="card-topline"><span class="item-number">${String(index+1).padStart(2,'0')}</span>${d.status==='inbox'?'<span class="tag-label">Needs details</span>':''}</div><span class="card-arrow">${icon('arrow')}</span></div><div class="card-body"><div class="card-title-row"><h2 class="card-name">${esc(d.name)}</h2><span class="price ${d.priceMinor===null?'price-unset':''}">${esc(groupPrice(item))}</span></div>${item.purchaseCount>1?`<span class="purchase-badge">${item.purchaseCount} purchases · ${item.totalQuantity} units recorded</span>`:''}<p class="card-brand">${esc(d.brand||d.model||'')}</p>${state.sort==='purchaseDate'?`<p class="card-sort-value">Purchased: ${date(d.purchaseDate)}</p>`:state.sort==='price'&&d.priceMinor!==null?`<p class="card-sort-value">Paid ${esc(money(d.priceMinor,d.currency))}</p>`:''}${new Set(item.purchases?.map(p=>JSON.stringify(p.purchaseFor))).size>1?'<span class="recipient-badge">Recipients vary</span>':d.purchaseFor?.kind==='other'?`<span class="recipient-badge">${esc(d.purchaseFor.recipient?`For ${d.purchaseFor.recipient}`:'For someone else')}</span>`:''}<div class="card-location">${icon('pin')}<span>${esc(place)}</span></div></div></button>`;}
function welcome(){return `<div class="welcome"><div class="welcome-copy"><div class="eyebrow">WELCOME HOME</div><h2>Everything,<br>in its place.</h2><p>Start with one thing. Add a photo, remember the details, and give it a place.</p><div class="welcome-actions"><button class="button primary" data-action="add">+ Add your first item</button><button class="text-button" data-action="sample">Explore a sample <span>↗</span></button></div></div><img src="/art/room.svg" alt="Illustration of an organized home shelf"></div><div class="first-steps"><div class="step"><span>01 / CAPTURE</span><h3>A photo is a start.</h3><p>Add the things you use, keep, and care about.</p></div><div class="step"><span>02 / REMEMBER</span><h3>Keep the details.</h3><p>Store receipts, prices, links, and your own notes.</p></div><div class="step"><span>03 / FIND</span><h3>Give it a place.</h3><p>Find the right room, drawer, or box in seconds.</p></div></div>`;}
function empty(title,message){return `<div class="empty">${icon('box')}<h2>${title}</h2><p>${message}</p><button class="button secondary" data-action="add">+ Add item</button></div>`;}
function renderItems(){
  const sortSelect=$('#sort');const sortFocus=document.activeElement===sortSelect;
  const searchFocus=document.activeElement?.id==='search';const selection=searchFocus?[$('#search').selectionStart,$('#search').selectionEnd,$('#search').selectionDirection]:null;
  if(!collectionCount()&&!state.sample&&state.view==='items'&&!state.query&&!state.location){$('#view-content').innerHTML=welcome();return;}
  $('#view-content').innerHTML=renderToolbar()+`<div class="${state.layout==='list'?'item-list':'item-grid'}" id="items" aria-busy="${state.itemsLoading}">${state.itemsLoading&&!state.items.length?'<div class="loading"><span class="spinner"></span>Loading items…</div>':state.items.map(card).join('')}</div>`+(!state.itemsLoading&&state.total===0?empty((state.query||state.tag||state.purchaseFor||state.noPhoto)?'No matches yet':state.view==='inbox'?'Everything is sorted':state.view==='archived'?'No archived items':'This place is ready',(state.query||state.tag||state.purchaseFor||state.noPhoto)?'Try another search or filter.':'Add an item when you are ready.'):'')+(state.items.length<state.total?`<div class="load-more"><button class="button secondary" data-action="more" ${state.itemsLoading?'disabled':''}>${state.itemsLoading?'Loading…':'Load more items'}</button></div>`:'');
  if(sortSelect){$('#sort').replaceWith(sortSelect);sortSelect.value=`${state.sort}:${state.direction}`;if(sortFocus)sortSelect.focus();}
  if(searchFocus){$('#search').focus();if(selection)$('#search').setSelectionRange(...selection);}
}
function descendants(id){const ids=new Set([id]);let changed=true;while(changed){changed=false;for(const place of locations())if(ids.has(place.parent_id)&&!ids.has(place.id)){ids.add(place.id);changed=true;}}return ids;}
async function loadItems(append=false){
  if(!['items','archived'].includes(state.view))return;
  if(state.sample){const valid=state.location?descendants(state.location):null;let items=sampleItems.filter(item=>(!['inbox','archived'].includes(state.view))&&(!valid||valid.has(item.data.locationId))&&(!state.purchaseFor||(item.data.purchaseFor?.kind||'self')===state.purchaseFor)&&(!state.tag||item.data.tags.includes(state.tag))&&(!state.query||JSON.stringify(item.data).toLowerCase().includes(state.query.toLowerCase())));items=items.filter(item=>!state.noPhoto||(!item.art&&!item.photo_id)).toSorted(sampleOrder);state.items=items;state.total=items.length;state.recordTotal=items.length;renderItems();return;}
  const query=new URLSearchParams({limit:'120',sort:state.sort,direction:state.direction,photo:state.noPhoto?'missing':'all',group:'product'});
  for(const [key,value]of Object.entries({q:state.query,location:state.location,tag:state.tag,purchaseFor:state.purchaseFor,status:state.view==='archived'?'archived':''}))if(value)query.set(key,value);
  const queryKey=query.toString();
  if(append&&(state.itemsLoading||state.itemsQuery!==queryKey))return;
  const requestId=++state.requestId;
  query.set('offset',String(append?state.items.length:0));
  state.itemsLoading=true;
  if(!append){state.items=[];state.total=0;state.recordTotal=0;state.itemsQuery=null;}
  renderItems();
  try{
    const response=await api(`/api/items?${query}`);
    if(requestId!==state.requestId)return;
    const reference=JSON.stringify(response.priceReference);
    if(append&&state.sort==='price'&&state.itemsPriceReference!==reference){
      toast('Reference rates changed. The list restarted.');
      await loadItems();return;
    }
    state.items=append?[...state.items,...response.items]:response.items;
    state.total=response.total;state.recordTotal=response.recordTotal;
    state.itemsQuery=queryKey;state.itemsPriceReference=reference;state.priceReference=response.priceReference;
  }finally{
    if(requestId===state.requestId){state.itemsLoading=false;renderItems();}
  }
}
async function refresh(){state.bootstrap=await api('/api/bootstrap');state.priceReference=state.bootstrap.priceReference;renderChrome();await renderView();}
const sharing=new ItemSharing({read:api,toast,resize:resizedPhoto});
const inbox=new InboxReview({
  root:$('#view-content'),read:api,send,money,date,place:locationPath,
  open:async(id,edit)=>{await openItem(id);if(edit){$('#detail').close();openEditor(state.selected);}},
  changed:async()=>{state.bootstrap=await api('/api/bootstrap');renderChrome();},
  active:()=>state.view==='inbox',samples:()=>state.sample?sampleItems:null,
});
async function renderView(){
  clearTimeout(debounce);state.requestId++;state.itemsLoading=false;
  renderChrome();
  if(state.view==='inbox'){state.requestId++;await inbox.start();return;}
  if(['items','archived'].includes(state.view)){await loadItems();return;}
  state.requestId++;
  if(state.view==='places'){$('#view-content').innerHTML=`<div class="places-toolbar"><p class="lead">Open a place to see what belongs there.</p><button class="button secondary" data-action="new-location">+ Add a place</button></div><div class="places-grid">${locations().map(place=>`<button class="place-card" data-location="${esc(place.id)}">${icon('home')}<h3>${esc(place.name)}</h3><p>${esc(locationPath(place.id))}</p></button>`).join('')}</div>`;return;}
  const events=state.sample?sampleItems.map((item,index)=>({id:index,item_id:item.id,name:item.data.name,action:'Added item',actor:'Sample owner',created_at:item.updated_at})):await api('/api/activity');
  if(state.view!=='activity')return;
  $('#view-content').innerHTML=events.length?`<div class="timeline">${events.map(event=>`<div class="timeline-row"><div class="timeline-icon">${icon('clock')}</div><div><button data-item="${esc(event.item_id)}"><h3>${esc(event.name)}</h3></button><p>${esc(event.action)} · ${esc(event.actor)}</p></div><time>${date(event.created_at)}</time></div>`).join('')}</div>`:empty('Your story starts here','Your changes will appear here.');
}
async function openItem(id){if(state.sample){state.selected=sampleItems.find(item=>item.id===id);state.purchases=[];}else [state.selected,state.purchases]=await Promise.all([api(`/api/items/${encodeURIComponent(id)}`),api(`/api/items/${encodeURIComponent(id)}/purchases`)]);state.tab='overview';renderDetail();if(!$('#detail').open)$('#detail').showModal();}
function renderDetail(){
  const item=state.selected;if(!item)return;const d=item.data;const photos=item.attachments.filter(file=>file.kind==='photo');state.purchases=state.purchases.map(p=>p.id===item.id?{...p,...d}:p);
  $('#detail').innerHTML=`<div class="drawer-top"><span>${state.sample?'SAMPLE ITEM':'YOUR COLLECTION'}</span><button class="icon-btn" data-action="close-detail" aria-label="Close details">${icon('close')}</button></div><div class="detail-photo">${item.art?`<img id="detail-image" src="/art/${item.art}.svg" alt="Sample ${item.art}">`:photos[0]?`<img id="detail-image" src="/api/files/${esc(photos[0].id)}" alt="${esc(d.name)}">`:`<div class="placeholder-art">${icon('camera')}</div>`}</div><div class="detail-main"><div class="detail-tags">${d.tags.map(tag=>`<span>${esc(tag)}</span>`).join('')}${d.status!=='active'?`<span>${esc(d.status)}</span>`:''}</div><div class="detail-title-row"><div><h2>${esc(d.name)}</h2><p class="detail-brand">${esc([d.brand,d.model].filter(Boolean).join(' · '))}</p></div>${state.sample?'':'<button class="button secondary share-item-button" data-action="share-item">Share ↗</button>'}<button class="icon-btn" data-action="edit" aria-label="Edit item">${icon('edit')}</button></div>${photos.length?`<div class="photo-strip">${photos.map(file=>`<div class="photo-entry"><button data-photo="${esc(file.id)}" aria-label="Show ${esc(file.filename)}"><img src="/api/files/${esc(file.id)}" alt="${esc(file.filename)}"></button>${state.sample?'':`<button class="remove-file" data-remove-file="${esc(file.id)}" aria-label="Remove photo ${esc(file.filename)}">Remove</button>`}</div>`).join('')}</div>`:''}${purchaseList(item.id)}<div class="detail-tabs" role="tablist">${[['overview','Details'],['notes',`Comments${item.comments.length?` (${item.comments.length})`:''}`],['history','History']].map(([tab,label])=>`<button role="tab" aria-selected="${state.tab===tab}" class="${state.tab===tab?'active':''}" data-tab="${tab}">${label}</button>`).join('')}</div><div id="detail-content"></div></div>`;
  const details=[['Bought for',esc(d.purchaseFor?.kind==='other'?(d.purchaseFor.recipient||'Someone else'):'Me')],['Place',esc(locationPath(d.locationId))],['Price',esc(money(d.priceMinor,d.currency))],['Bought from',esc(d.seller||'—')],['Purchase date',date(d.purchaseDate)],['Quantity',d.quantity],['Serial number',esc(d.serialNumber||'—')],['Warranty until',date(d.warrantyDate)],...(d.borrower?[['Borrowed by',esc(d.borrower)]]:[]),...(d.productUrl?[['Product link',`<a href="${esc(d.productUrl)}" target="_blank" rel="noopener noreferrer">Open product ↗</a>`]]:[]),...(d.sourceUrl?[['Source',`<a href="${esc(d.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`]]:[])];
  let content='';
  if(state.tab==='overview')content=`<dl class="details-table">${details.map(([key,value])=>`<dt>${key}</dt><dd>${value}</dd>`).join('')}</dl>${d.description?`<div class="section-title">Notes about this item</div><p class="description">${linkify(d.description)}</p>`:''}<div class="section-title">Files & receipts</div>${item.attachments.filter(file=>file.kind!=='photo').map(file=>`<div class="attachment-row"><a class="attachment" href="/api/files/${esc(file.id)}" target="_blank" rel="noopener">${icon('file')} ${esc(file.filename)}</a>${state.sample?'':`<button class="remove-file" data-remove-file="${esc(file.id)}" aria-label="Remove ${esc(file.filename)}">Remove</button>`}</div>`).join('')||'<p class="description">Keep receipts and manuals with this item.</p>'}${item.removedAttachments?.length?`<details class="removed-files"><summary>Removed files (${item.removedAttachments.length})</summary><p class="form-hint">These files remain saved. Restore a file to show it on this item.</p>${item.removedAttachments.map(file=>`<div class="attachment-row"><a class="attachment" href="/api/files/${esc(file.id)}" target="_blank" rel="noopener">${icon('file')} ${esc(file.filename)}</a><button class="text-button" data-restore-file="${esc(file.id)}" aria-label="Restore ${esc(file.filename)}">Restore</button></div>`).join('')}</details>`:''}${state.sample?'<div class="sample-note">Sample item. Your real collection starts with Add item.</div>':`<form id="attachment-form" class="upload-small"><input type="file" name="file" aria-label="Attach a file" required accept="image/jpeg,image/png,image/webp,image/avif,application/pdf,text/plain"><select name="kind" aria-label="File type"><option value="photo">Photo</option><option value="receipt">Receipt</option><option value="manual">Manual</option><option value="document">Document</option></select><button class="button secondary">Attach</button></form><div class="item-actions"><button class="archive-button" data-action="archive">${d.status==='archived'?'Restore to collection':'Archive this item'}</button><button class="button danger-outline" data-action="delete-item">Delete item</button></div>`}`;
  if(state.tab==='notes')content=`${item.comments.length?item.comments.map(comment=>`<article class="comment"><p>${linkify(comment.body)}</p><footer>${esc(comment.author)} · ${date(comment.created_at)}</footer></article>`).join(''):'<p class="description section-title">A place for your own comments.</p>'}${state.sample?'<div class="sample-note">Comments on real items stay separate from agent edits.</div>':'<form class="comment-form" id="comment-form"><textarea name="body" aria-label="Your comment" placeholder="Something worth remembering…" maxlength="4000" required></textarea><button class="button primary">Add comment</button></form>'}`;
  if(state.tab==='history')content=item.activity.length?item.activity.map(event=>`<div class="timeline-row"><div class="timeline-icon">${icon('clock')}</div><div><h3>${esc(event.action)}</h3><p>${esc(event.actor)} · ${date(event.created_at)}</p></div>${event.before_data?`<button class="activity-restore" data-restore="${event.id}">Restore earlier details</button>`:''}</div>`).join(''):'<p class="sample-note">Changes to this item will appear here.</p>';
  $('#detail-content').innerHTML=content;
}
function purchaseList(selected){if(state.purchases.length<2)return '';return `<details class="purchase-history" open><summary>${state.purchases.length} purchases · ${state.purchases.reduce((n,p)=>n+p.quantity,0)} units recorded</summary><p class="form-hint">Select a purchase to view or edit its details.</p><div class="purchase-rows">${state.purchases.map(p=>`<button data-purchase="${esc(p.id)}" class="purchase-row ${p.id===selected?'selected':''}" aria-pressed="${p.id===selected}"><span><strong>${date(p.purchaseDate)}</strong><small>${esc(p.seller||'Seller not set')} · ${p.quantity} unit${p.quantity===1?'':'s'} · ${esc(p.status)}</small><small>${esc(p.purchaseFor?.kind==='other'?'For '+(p.purchaseFor.recipient||'someone else'):'For me')}</small></span><span>${p.priceMinor===null?'Price not set':esc(money(p.priceMinor,p.currency))+' each'}</span></button>`).join('')}</div></details>`;}
function placeOptions(selected){return `<option value="">Choose a place later</option>${locations().map(place=>`<option value="${esc(place.id)}" ${selected===place.id?'selected':''}>${esc(locationPath(place.id))}</option>`).join('')}`;}
function field(label,name,value='',type='text',extra=''){return `<label class="form-field ${extra.includes('full')?'full':''}">${label}<input name="${name}" autocomplete="off" data-1p-ignore type="${type}" value="${esc(value)}" ${extra.replace('full','')}></label>`;}
function openEditor(item=null){
  if(state.sample&&item){toast('This is a sample. Add your own item to make changes.');return;}
  if(state.sample){state.sample=false;state.location=null;state.query='';state.tag='';history.replaceState(null,'',location.pathname);renderView().catch(error=>toast(error.message));}
  state.editing=item;const d=item?.data??{name:'',tags:[],quantity:1,currency:'ILS',locationId:state.location,status:state.view==='inbox'?'inbox':'active'};
  $('#editor').innerHTML=`<div class="dialog-heading"><h2 id="editor-title">${item?'Edit item':'A new addition'}</h2><button class="icon-btn" data-action="close-editor" aria-label="Close editor">${icon('close')}</button></div><form id="item-form" class="editor-body" autocomplete="off" data-1p-ignore><label class="upload-box">${icon('camera')}<span><strong>${item?'Add another photo':'Start with a photo'}</strong><small>Choose a photo. We resize it before upload.</small><input type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/avif" aria-label="Item photo"></span></label><div class="form-grid">${field('Item name *','name',d.name,'text','required maxlength="140" full')}<label class="form-field">Place<select name="locationId">${placeOptions(d.locationId)}</select></label><label class="form-field">Status<select name="status">${['active','inbox','lent','archived'].map(status=>`<option value="${status}" ${d.status===status?'selected':''}>${{active:'In collection',inbox:'Needs details',lent:'Lent out',archived:'Archived'}[status]}</option>`).join('')}</select></label>${field('Tags','tags',d.tags.join(', '),'text','placeholder="Electronics, Travel" full')}<label class="form-field full">Description<textarea name="description" maxlength="6000" placeholder="Useful details about this item">${esc(d.description||'')}</textarea></label></div><details class="form-section" open><summary>Purchase details</summary><div class="form-grid"><label class="form-field">Bought for<select name="purchaseForKind"><option value="self" ${d.purchaseFor?.kind!=='other'?'selected':''}>Me</option><option value="other" ${d.purchaseFor?.kind==='other'?'selected':''}>Someone else</option></select></label><label class="form-field" id="recipient-field" ${d.purchaseFor?.kind==='other'?'':'hidden'}>Recipient (optional)<input name="recipient" autocomplete="off" data-1p-ignore maxlength="200" value="${esc(d.purchaseFor?.kind==='other'?d.purchaseFor.recipient:'')}" placeholder="Name"></label>${field('Bought from','seller',d.seller)}${field('Purchase date','purchaseDate',d.purchaseDate,'date')}${field('Price paid per item','price',d.priceMinor==null?'':(d.priceMinor/100).toFixed(2),'number','min="0" step="0.01" max="10000000000"')}<label class="form-field">Currency<select name="currency">${['ILS','USD','EUR','GBP'].map(currency=>`<option ${d.currency===currency?'selected':''}>${currency}</option>`).join('')}</select></label>${field('Product link','productUrl',d.productUrl,'url','full placeholder="https://"')}${field('Source link','sourceUrl',d.sourceUrl,'url','full placeholder="Receipt, order, or product source"')}</div></details><details class="form-section" ${item?'open':''}><summary>More details</summary><div class="form-grid">${field('Brand','brand',d.brand)}${field('Model','model',d.model)}${field('Serial number','serialNumber',d.serialNumber)}${field('Quantity','quantity',d.quantity,'number','min="1" max="100000"')}${field('Warranty until','warrantyDate',d.warrantyDate,'date')}${field('Borrowed by','borrower',d.borrower)}</div></details><div class="error-message" id="form-error" role="alert" hidden></div><div class="form-actions"><button type="button" class="button secondary" data-action="close-editor">Cancel</button><button class="button primary" type="submit">${item?'Save changes':'Add to collection'}</button></div></form>`;
  $('#item-form').dataset.newId=crypto.randomUUID();
  $('#editor').showModal();setTimeout(()=>$('#item-form [name=name]').focus(),50);
}
async function resizedPhoto(file){
  if(!file?.size)return null;
  let bitmap;try{bitmap=await createImageBitmap(file);}catch{throw new Error('Use a JPG, PNG, WebP, or AVIF photo.');}
  const scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.82));
  if(!blob)throw new Error('Could not prepare this photo.');return new File([blob],`${file.name.replace(/\.[^.]+$/,'')}.webp`,{type:'image/webp'});
}
async function upload(id,file,kind){const form=new FormData();form.set('file',file);form.set('kind',kind);return api(`/api/items/${id}/attachments`,{method:'POST',body:form});}
async function saveItem(form){
  const submit=form.querySelector('[type=submit]');submit.disabled=true;$('#form-error').hidden=true;
  try{
    const input=new FormData(form);const data=Object.fromEntries([...input].filter(([key])=>!['photo','price'].includes(key)));
    data.purchaseFor=data.purchaseForKind==='other'?{kind:'other',recipient:data.recipient}:{kind:'self'};delete data.purchaseForKind;delete data.recipient;
    data.tags=data.tags.split(',').map(tag=>tag.trim()).filter(Boolean);data.quantity=Number(data.quantity);data.priceMinor=input.get('price')===''?null:Math.round(Number(input.get('price'))*100);data.locationId=data.locationId||null;
    const photo=await resizedPhoto(input.get('photo'));
    let saved=state.editing?await send(`/api/items/${state.editing.id}`,{revision:state.editing.revision,data},'PUT'):await send('/api/items',{id:form.dataset.newId,data});
    state.editing=saved;
    if(photo){try{saved=await upload(saved.id,photo,'photo');}catch(error){await refresh();throw new Error(`Item saved. Photo upload failed: ${error.message} Submit again to retry the photo.`);}}
    $('#editor').close();state.selected=saved;if($('#detail').open)renderDetail();await refresh();toast('Saved to your collection.');
  }catch(error){$('#form-error').textContent=error.message;$('#form-error').hidden=false;}finally{submit.disabled=false;}
}
function openDeleteDialog(){
  const item=state.selected;
  if(!item||state.sample)return;
  $('#delete-dialog').innerHTML=`<div class="dialog-heading"><h2 id="delete-title">Delete this ${state.purchases.length>1?'purchase':'item'}?</h2></div><form id="delete-form" class="editor-body" data-item-id="${esc(item.id)}" data-revision="${item.revision}"><p class="delete-name">${esc(item.data.name)}</p><p class="description">${date(item.data.purchaseDate)} · ${esc(money(item.data.priceMinor,item.data.currency))}</p><p class="delete-warning">This permanently deletes this purchase, its photos, files, comments, and history. You cannot undo this.</p>${state.purchases.length>1?'<p class="description">Other purchases of this product will remain.</p>':''}<div id="delete-error" class="error-message" role="alert" hidden></div><div class="form-actions"><button type="button" class="button secondary" data-action="cancel-delete" autofocus>Cancel</button><button type="submit" class="button danger">Delete permanently</button></div></form>`;
  $('#delete-dialog').showModal();
}
function openPlaceEditor(){if(state.sample){toast('Start your collection before adding a place.');return;}$('#place-editor').innerHTML=`<div class="dialog-heading"><h2 id="place-title">Give it a place</h2><button class="icon-btn" data-action="close-place" aria-label="Close place form">${icon('close')}</button></div><form id="place-form" class="editor-body"><p class="form-hint">Add a room, cabinet, shelf, drawer, or box.</p><div class="form-grid">${field('Place name *','name','','text','full required maxlength="80" placeholder="Office, top drawer, cable box…"')}<label class="form-field full">Inside<select name="parentId">${placeOptions(state.location||locations()[0]?.id)}</select></label></div><div id="place-error" class="error-message" hidden></div><div class="form-actions"><button type="button" class="button secondary" data-action="close-place">Cancel</button><button class="button primary">Add place</button></div></form>`;$('#place-editor').showModal();}
async function exportCollection(){if(state.sample){toast('The sample is separate from your real inventory.');return;}await exportArchive({read:api,onProgress:toast});toast('Collection and files exported.');}
document.addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;
  try{
    if(button.dataset.view){state.view=button.dataset.view;state.location=null;state.query='';state.tag='';await renderView();}
    else if(button.dataset.location){state.location=button.dataset.location;state.view='items';state.query='';state.tag='';await renderView();}
    else if(button.dataset.item)await openItem(button.dataset.item);
    else if(button.dataset.purchase){await openItem(button.dataset.purchase);}
    else if(button.dataset.tab){state.tab=button.dataset.tab;renderDetail();}
    else if(button.dataset.photo)$('#detail-image').src=`/api/files/${button.dataset.photo}`;
    else if(button.dataset.removeFile||button.dataset.restoreFile){const id=state.selected.id;const restore=Boolean(button.dataset.restoreFile);const fileId=button.dataset.restoreFile||button.dataset.removeFile;button.disabled=true;try{const updated=await api(`/api/items/${id}/attachments/${fileId}${restore?'/restore':''}`,{method:restore?'POST':'DELETE'});if(state.selected?.id===id){state.selected=updated;renderDetail();}await refresh();toast(restore?'File restored.':'File removed. Restore it under Removed files.');}finally{button.disabled=false;}}
    else if(button.dataset.layout){state.layout=button.dataset.layout;renderItems();}
    else if('purchaseFor'in button.dataset){state.purchaseFor=button.dataset.purchaseFor;await loadItems();}
    else if('tag'in button.dataset){state.tag=button.dataset.tag;await loadItems();}
    else if(button.dataset.restore){button.disabled=true;state.selected=await send(`/api/items/${state.selected.id}/restore`,{revision:state.selected.revision,eventId:Number(button.dataset.restore)});renderDetail();await refresh();toast('Earlier details restored. Comments and files stayed unchanged.');}
    else switch(button.dataset.action){
      case'add':openEditor();break;
      case'edit':openEditor(state.selected);break;
      case'close-detail':$('#detail').close();break;
      case'close-editor':$('#editor').close();break;
      case'close-place':$('#place-editor').close();break;
      case'share-item':await sharing.open(state.selected);break;
      case'delete-item':openDeleteDialog();break;
      case'cancel-delete':$('#delete-dialog').close();break;
      case'no-photo':state.noPhoto=!state.noPhoto;await loadItems();break;
      case'new-location':openPlaceEditor();break;
      case'clear-location':state.location=null;await renderView();break;
      case'sample':state.sample=true;state.view='items';state.location=null;await renderView();break;
      case'leave-sample':state.sample=false;state.location=null;state.view='items';state.query='';state.tag='';history.replaceState(null,'',location.pathname);await renderView();break;
      case'more':button.disabled=true;await loadItems(true);break;
      case'export':await exportCollection();break;
      case'retry':await refresh();break;
      case'archive':{button.disabled=true;const data={...state.selected.data,status:state.selected.data.status==='archived'?'active':'archived'};state.selected=await send(`/api/items/${state.selected.id}`,{revision:state.selected.revision,data},'PUT');renderDetail();await refresh();toast(data.status==='archived'?'Item archived. Its record stays available.':'Item returned to your collection.');break;}
    }
  }catch(error){button.disabled=false;toast(error.message);}
});
document.addEventListener('input',event=>{if(event.target.id==='search'){state.query=event.target.value;clearTimeout(debounce);state.requestId++;state.itemsLoading=false;debounce=setTimeout(()=>loadItems().catch(error=>toast(error.message)),220);}});
document.addEventListener('change',event=>{if(event.target.id==='sort'){[state.sort,state.direction]=event.target.value.split(':');loadItems().catch(error=>toast(error.message));}});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!['item-form','comment-form','attachment-form','place-form','delete-form'].includes(form.id))return;event.preventDefault();
  if(form.id==='item-form'){await saveItem(form);return;}
  if(form.id==='delete-form'){
    const button=form.querySelector('[type=submit]');button.disabled=true;$('#delete-error').hidden=true;
    try{
      await send(`/api/items/${form.dataset.itemId}`,{revision:Number(form.dataset.revision)},'DELETE');
      $('#delete-dialog').close();$('#detail').close();state.selected=null;state.purchases=[];await refresh();toast('Item permanently deleted.');
    }catch(error){$('#delete-error').textContent=error.message;$('#delete-error').hidden=false;}finally{button.disabled=false;}
    return;
  }
  const button=form.querySelector('button[type=submit],button:not([type])');if(button)button.disabled=true;
  try{const data=new FormData(form);
    if(form.id==='comment-form'){state.selected=await send(`/api/items/${state.selected.id}/comments`,{body:data.get('body')});renderDetail();toast('Comment added.');}
    if(form.id==='attachment-form'){let file=data.get('file');if(data.get('kind')==='photo')file=await resizedPhoto(file);state.selected=await upload(state.selected.id,file,data.get('kind'));renderDetail();await refresh();toast('File attached.');}
    if(form.id==='place-form'){await send('/api/locations',{name:data.get('name'),parentId:data.get('parentId')||null});$('#place-editor').close();await refresh();toast('Place added.');}
  }catch(error){if(form.id==='place-form'){$('#place-error').textContent=error.message;$('#place-error').hidden=false;}else toast(error.message);}finally{if(button)button.disabled=false;}
});
document.addEventListener('keydown',event=>{if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)&&$('#search')){event.preventDefault();$('#search').focus();}});
for(const dialog of document.querySelectorAll('dialog:not(.share-dialog)'))dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
refresh().catch(error=>{$('#view-content').innerHTML=`<div class="error-screen">${icon('home')}<h2>Let’s get you home.</h2><p>${esc(error.message)}</p><button class="button primary" data-action="retry">Try again</button></div>`;});

document.addEventListener('change',event=>{if(event.target.name==='purchaseForKind')$('#recipient-field').hidden=event.target.value!=='other';});
