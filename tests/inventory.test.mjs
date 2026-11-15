import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { authenticate } from '../src/auth.ts';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkify } from '../public/text.js';

test('description links preserve purchase evidence and query parameters',()=>{
  const url='https://www.aliexpress.com/p/order/detail.html?orderId=1000000000000001&source=orders';
  const escaped=url.replace('&','&amp;');
  assert.equal(linkify(`Purchase evidence: ${url}\nKeep this note.`),`Purchase evidence: <a href="${escaped}" target="_blank" rel="noopener noreferrer">${escaped}</a>\nKeep this note.`);
});

test('description links exclude sentence punctuation and retain balanced URL parentheses',()=>{
  assert.equal(linkify('(https://example.com/order).'), '(<a href="https://example.com/order" target="_blank" rel="noopener noreferrer">https://example.com/order</a>).');
  assert.ok(linkify('https://example.com/item_(blue)').includes('href="https://example.com/item_(blue)"'));
  assert.equal((linkify('https://example.com/one, http://example.com/two!').match(/<a /g)||[]).length,2);
});

test('description links keep HTML and unsupported schemes as plain text',()=>{
  assert.equal(linkify('<script>alert(1)</script> javascript:alert(1)'), '&lt;script&gt;alert(1)&lt;/script&gt; javascript:alert(1)');
  assert.equal(linkify('https://'), 'https://');
  assert.equal(linkify(null), '');
  const html=linkify('https://example.com/?q=<img src=x onerror="alert(1)">');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
});

const base=process.env.TEST_URL||'http://127.0.0.1:8787';
if(!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base))throw new Error('Tests require a local server.');
const call=async(path,body,method='GET',headers={})=>{
  const response=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json(),headers:response.headers};
};
const name=`Verification ${randomUUID().slice(0,8)}`;
test('inventory lifecycle, agent updates, history, attachments, and privacy',async t=>{
  let place,child,item;
  await t.test('creates a nested place',async()=>{
    place=await call('/api/locations',{name,parentId:'00000000-0000-4000-8000-000000000001'},'POST');assert.equal(place.status,201);
    child=await call('/api/locations',{name:'Drawer',parentId:place.body.id},'POST');assert.equal(child.status,201);
  });
  await t.test('creates a complete item with integer money',async()=>{
    item=await call('/api/items',{id:randomUUID(),data:{name,brand:'Test brand',seller:'Test seller',priceMinor:12990,currency:'ILS',quantity:2,locationId:child.body.id,tags:['verification','tools'],productUrl:'https://example.com/product'}},'POST');
    assert.equal(item.status,201);assert.equal(item.body.data.priceMinor,12990);assert.equal(item.body.activity.length,1);
    assert.deepEqual(item.body.data.purchaseFor,{kind:'self'});
  });
  await t.test('marks purchases for others and filters without changing ownership status',async()=>{
    const giftName=`Gift ${randomUUID()}`;
    const gift=await call('/api/items',{data:{name:giftName,purchaseFor:{kind:'other',recipient:'Family member'}}},'POST');
    assert.equal(gift.status,201);assert.equal(gift.body.data.status,'active');
    assert.deepEqual(gift.body.data.purchaseFor,{kind:'other',recipient:'Family member'});
    const others=await call(`/api/items?purchaseFor=other&q=${encodeURIComponent(giftName)}`);assert.equal(others.body.total,1);
    const mine=await call(`/api/items?purchaseFor=self&q=${encodeURIComponent(giftName)}`);assert.equal(mine.body.total,0);
    const updated=await call(`/api/items/${gift.body.id}`,{revision:1,data:{...gift.body.data,purchaseFor:{kind:'self'}}},'PUT');assert.equal(updated.status,200);
    const mineNow=await call(`/api/items?purchaseFor=self&q=${encodeURIComponent(giftName)}`);assert.equal(mineNow.body.total,1);
    const unspecified=await call('/api/items',{data:{name:'Recipient not specified',purchaseFor:{kind:'other'}}},'POST');assert.equal(unspecified.status,201);assert.equal(unspecified.body.data.purchaseFor.recipient,'');
    const invalid=await call('/api/items',{data:{name:'Invalid recipient',purchaseFor:{kind:'self',recipient:'Someone'}}},'POST');assert.equal(invalid.status,400);
    assert.equal((await call('/api/items?purchaseFor=unknown')).status,400);
  });
  await t.test('retries item creation without duplicate records',async()=>{
    const repeat=await call('/api/items',{id:item.body.id,data:item.body.data},'POST');assert.equal(repeat.status,200);assert.equal(repeat.body.revision,1);
    const conflict=await call('/api/items',{id:item.body.id,data:{...item.body.data,name:'Different'}},'POST');assert.equal(conflict.status,409);
  });
  await t.test('handles simultaneous retries without duplicate records',async()=>{
    const body={id:randomUUID(),data:{name:'Concurrent retry',status:'archived'}};
    const results=await Promise.all(Array.from({length:4},()=>call('/api/items',body,'POST')));
    assert.deepEqual(results.map(result=>result.status).sort(),[200,200,200,201]);
    assert.ok(results.every(result=>result.body.activity.length===1));
  });
  await t.test('rejects invalid pagination',async()=>{
    for(const query of ['limit=1.5','offset=Infinity','limit=201']) assert.equal((await call('/api/items?'+query)).status,400);
  });
  await t.test('groups repeat purchases before pagination and keeps each purchase intact',async()=>{
    const label=`Repeat ${randomUUID().slice(0,8)}`;
    const first=(await call('/api/items',{data:{name:label,productUrl:'https://www.amazon.com/dp/B000000001?ref=first',purchaseDate:'2025-01-01',priceMinor:1000,currency:'USD',quantity:2,tags:[label]}},'POST')).body;
    const second=(await call('/api/items',{data:{name:label+' new title',productUrl:'https://amazon.com/gp/product/B000000001',purchaseDate:'2026-02-01',priceMinor:1200,currency:'USD',quantity:3,tags:[label],purchaseFor:{kind:'other',recipient:'Family'}}},'POST')).body;
    const variant=(await call('/api/items',{data:{name:label,productUrl:'https://amazon.com/dp/B000000002',tags:[label]}},'POST')).body;
    await call(`/api/items/${first.id}/comments`,{body:'Keep the first purchase note.'},'POST');
    const before=(await call('/api/export')).body;
    const query=`group=product&tag=${encodeURIComponent(label)}&sort=name&limit=1`;
    const pages=await Promise.all([call('/api/items?'+query),call('/api/items?'+query+'&offset=1')]);
    assert.ok(pages.every(page=>page.status===200&&page.body.total===2&&page.body.recordTotal===3&&page.body.items.length===1));
    const groups=pages.flatMap(page=>page.body.items);
    const repeat=groups.find(group=>group.purchaseCount===2);
    assert.equal(repeat.totalQuantity,5);
    assert.deepEqual(repeat.purchases.map(p=>p.id).sort(),[first.id,second.id].sort());
    assert.ok(groups.some(group=>group.id===variant.id&&group.purchaseCount===1));
    assert.equal((await call(`/api/items?tag=${encodeURIComponent(label)}`)).body.total,3);
    const gifts=(await call(`/api/items?${query}&purchaseFor=other`)).body;
    assert.equal(gifts.total,1);assert.equal(gifts.items[0].totalQuantity,3);
    const purchases=(await call(`/api/items/${first.id}/purchases`)).body;
    assert.deepEqual(purchases.map(p=>p.id),[second.id,first.id]);
    assert.equal(purchases[0].priceMinor,1200);assert.equal(purchases[0].purchaseFor.recipient,'Family');
    assert.equal((await call(`/api/items/${first.id}`)).body.comments[0].body,'Keep the first purchase note.');
    const after=(await call('/api/export')).body;
    for(const field of ['items','attachments','comments','activity'])assert.deepEqual(after[field],before[field]);
    assert.equal((await call('/api/items?group=unknown')).status,400);
    assert.equal((await call(`/api/items/${randomUUID()}/purchases`)).status,404);
  });
  await t.test('keeps product variants and combined models separate',async()=>{
    const label=`Variants ${randomUUID().slice(0,8)}`;
    const entries=[
      {name:label,productUrl:'https://shop.com/products/123/widget?variantId=1'},
      {name:label,productUrl:'https://shop.app/products/123/widget?variantId=1&utm_source=shop'},
      {name:label,productUrl:'https://shop.com/products/123/widget?variantId=2'},
      {name:label,model:'Small + Medium',productUrl:'https://www.amazon.com/dp/B000000003'},
      {name:label,model:'Small',productUrl:'https://www.amazon.com/dp/B000000003'},
      {name:label+' red',productUrl:'https://merchant.example/product?variant=red'},
      {name:label+' blue',productUrl:'https://merchant.example/product?variant=blue'},
    ];
    for(const data of entries)assert.equal((await call('/api/items',{data:{...data,tags:[label]}},'POST')).status,201);
    const result=(await call(`/api/items?group=product&tag=${encodeURIComponent(label)}`)).body;
    assert.equal(result.recordTotal,7);assert.equal(result.total,6);
    assert.equal(result.items.filter(item=>item.purchaseCount===2).length,1);
  });
  await t.test('groups AliExpress purchases by product and variant across titles and regional sites',async()=>{
    const label=`AliExpress ${randomUUID().slice(0,8)}`;
    const entries=[
      {name:label+' original',productUrl:'https://www.aliexpress.com/item/1000000000000001.html?sku_id=10000000000000001',quantity:2},
      {name:label+' new title',productUrl:'https://he.aliexpress.com/item/1000000000000001.html?sku_id=10000000000000001&source=order',quantity:1},
      {name:label+' regional title',productUrl:'https://www.aliexpress.us/item/1000000000000001.html?sku_id=10000000000000001',quantity:3},
      {name:label+' other variant',productUrl:'https://www.aliexpress.com/item/1000000000000001.html?sku_id=10000000000000002'},
      {name:label+' unknown variant',productUrl:'https://www.aliexpress.com/item/1000000000000001.html'},
      {name:label+' unrelated host',productUrl:'https://aliexpress.com.example/item/1000000000000001.html?sku_id=10000000000000001'},
    ];
    const ids=[];
    for(const data of entries){const result=await call('/api/items',{data:{...data,tags:[label]}},'POST');assert.equal(result.status,201);ids.push(result.body.id);}
    const result=(await call(`/api/items?group=product&tag=${encodeURIComponent(label)}`)).body;
    assert.equal(result.recordTotal,6);assert.equal(result.total,4);
    const repeated=result.items.find(item=>item.purchaseCount===3);
    assert.equal(repeated.totalQuantity,6);
    assert.deepEqual(repeated.purchases.map(item=>item.id).sort(),ids.slice(0,3).sort());
    assert.deepEqual((await call(`/api/items/${ids[0]}/purchases`)).body.map(item=>item.id).sort(),ids.slice(0,3).sort());
  });
  await t.test('sorts all purchases and product groups in both directions before pagination',async()=>{
    const label=`Sorting ${randomUUID().slice(0,8)}`;
    const entries=[
      {name:'Zulu',purchaseDate:'2025-01-01',priceMinor:0,currency:'USD'},
      {name:'alpha',purchaseDate:'2023-01-01',priceMinor:900,currency:'USD'},
      {name:'Bravo',purchaseDate:'2024-01-01',priceMinor:250,currency:'USD',productUrl:'https://www.amazon.com/dp/B111111111'},
      {name:'Unknown',purchaseDate:'',priceMinor:null,currency:'USD'},
      {name:'Euro',purchaseDate:'2022-01-01',priceMinor:5000,currency:'EUR'},
      {name:'Bravo',purchaseDate:'2026-01-01',priceMinor:500,currency:'USD',productUrl:'https://www.amazon.com/dp/B111111111'},
    ];
    const records=[];
    for(const data of entries)records.push((await call('/api/items',{data:{...data,tags:[label]}},'POST')).body);
    const query=`tag=${encodeURIComponent(label)}`;
    const before=(await call('/api/export')).body;
    for(const sort of ['recent','name','purchaseDate','price'])for(const direction of ['asc','desc']){
      const sign=direction==='asc'?1:-1;
      const expected=records.toSorted((a,b)=>{
        let value=0;
        if(sort==='price')value=Number(a.data.priceMinor===null)-Number(b.data.priceMinor===null)||a.data.currency.localeCompare(b.data.currency)||(a.data.priceMinor-b.data.priceMinor)*sign;
        else if(sort==='purchaseDate')value=Number(!a.data.purchaseDate)-Number(!b.data.purchaseDate)||a.data.purchaseDate.localeCompare(b.data.purchaseDate)*sign;
        else value=(sort==='name'?a.data.name.toLowerCase().localeCompare(b.data.name.toLowerCase()):a.updated_at.localeCompare(b.updated_at))*sign;
        return value||a.id.localeCompare(b.id);
      });
      for(const group of ['none','product']){
        const seen=new Set();const ids=expected.filter(r=>{const key=r.data.productUrl||r.id;if(group==='product'&&seen.has(key))return false;seen.add(key);return true;}).map(r=>r.id);
        const actual=[];
        for(let offset=0;offset<ids.length;offset+=2){
          const page=await call(`/api/items?${query}&sort=${sort}&direction=${direction}&group=${group}&limit=2&offset=${offset}`);
          assert.equal(page.status,200);assert.equal(page.body.total,ids.length);actual.push(...page.body.items.map(r=>r.id));
        }
        assert.deepEqual(actual,ids,`${sort} ${direction} ${group}`);
      }
    }
    assert.deepEqual((await call(`/api/items?${query}`)).body.items.map(item=>item.id),[5,0,2,1,4,3].map(index=>records[index].id));
    assert.deepEqual((await call(`/api/items?${query}&group=product`)).body.items.map(item=>item.id),[5,0,1,4,3].map(index=>records[index].id));
    assert.equal((await call('/api/items')).body.limit,120);
    for(const query of ['sort=unknown','direction=sideways','photo=unknown'])assert.equal((await call('/api/items?'+query)).status,400);
    const after=(await call('/api/export')).body;
    for(const key of ['items','attachments','comments','activity'])assert.deepEqual(after[key],before[key]);
  });
  await t.test('filters missing photos on full product groups before pagination',async()=>{
    const label=`Missing photo ${randomUUID().slice(0,8)}`;
    const create=async(name,productUrl='')=>(await call('/api/items',{data:{name,tags:[label],productUrl}},'POST')).body;
    const pictured=await create('A pictured','https://www.amazon.com/dp/B222222222');
    const repeat=await create('A repeat','https://www.amazon.com/dp/B222222222');
    const receiptOnly=await create('B receipt');const removed=await create('C removed');
    const attach=async(item,kind)=>{
      const form=new FormData();form.set('kind',kind);form.set('file',new File(['test file'],kind==='photo'?'photo.png':'receipt.txt',{type:kind==='photo'?'image/png':'text/plain'}));
      const response=await fetch(`${base}/api/items/${item.id}/attachments`,{method:'POST',body:form});assert.equal(response.status,201);return (await response.json()).attachments[0].id;
    };
    await attach(pictured,'photo');await attach(receiptOnly,'receipt');
    const file=await attach(removed,'photo');await call(`/api/items/${removed.id}/attachments/${file}`,null,'DELETE');
    const query=`tag=${encodeURIComponent(label)}&photo=missing&sort=name`;
    const raw=(await call('/api/items?'+query)).body;assert.deepEqual(raw.items.map(r=>r.id),[repeat.id,receiptOnly.id,removed.id]);
    const first=(await call(`/api/items?${query}&group=product&limit=1`)).body;
    const second=(await call(`/api/items?${query}&group=product&limit=1&offset=1`)).body;
    assert.equal(first.total,2);assert.equal(first.recordTotal,2);assert.equal(first.items[0].id,receiptOnly.id);assert.equal(second.items[0].id,removed.id);
    await call(`/api/items/${removed.id}/attachments/${file}/restore`,null,'POST');
    assert.equal((await call(`/api/items?${query}&group=product`)).body.total,1);
  });
  await t.test('permanently deletes only the selected purchase and prevents stale deletion and ID reuse',async()=>{
    const data={name:`Delete ${randomUUID().slice(0,8)}`,productUrl:'https://www.amazon.com/dp/B333333333',locationId:child.body.id};
    let target=(await call('/api/items',{data},'POST')).body;
    const keep=(await call('/api/items',{data},'POST')).body;
    await call(`/api/items/${target.id}/comments`,{body:'Delete this comment with its purchase.'},'POST');
    const files=[];
    for(const kind of ['photo','receipt']){
      const form=new FormData();form.set('kind',kind);form.set('file',new File(['delete test'],kind==='photo'?'photo.png':'receipt.txt',{type:kind==='photo'?'image/png':'text/plain'}));
      const response=await fetch(`${base}/api/items/${target.id}/attachments`,{method:'POST',body:form});assert.equal(response.status,201);files.push((await response.json()).attachments.find(a=>a.kind===kind).id);
    }
    await call(`/api/items/${target.id}/attachments/${files[0]}`,null,'DELETE');
    target=(await call(`/api/items/${target.id}`,{revision:target.revision,data:{...target.data,description:'Current details'}},'PUT')).body;
    const before=(await call('/api/export')).body;
    assert.equal((await call(`/api/items/${target.id}`,{revision:1},'DELETE')).status,409);
    assert.equal((await call(`/api/items/${target.id}`,{},'DELETE')).status,400);
    assert.equal((await call(`/api/items/${target.id}`,{revision:target.revision},'DELETE',{Origin:'https://other.example'})).status,403);
    for(const id of files)assert.equal((await fetch(`${base}/api/files/${id}`)).status,200);
    assert.equal((await call(`/api/items/${target.id}`,{revision:target.revision},'DELETE')).body.deleted,true);
    assert.equal((await call(`/api/items/${target.id}`)).status,404);
    for(const id of files)assert.equal((await fetch(`${base}/api/files/${id}`)).status,404);
    const after=(await call('/api/export')).body;
    for(const key of ['items','comments','attachments','activity'])assert.deepEqual(after[key],before[key].filter(row=>(key==='items'?row.id:row.item_id)!==target.id));
    assert.deepEqual(after.locations,before.locations);
    assert.equal((await call(`/api/items/${keep.id}/purchases`)).body.length,1);
    assert.equal((await call(`/api/items/${target.id}`,{revision:target.revision},'DELETE')).body.deleted,true);
    assert.equal((await call('/api/items',{id:target.id,data:target.data},'POST')).status,409);
    assert.equal((await call(`/api/items/${randomUUID()}`,{revision:1},'DELETE')).status,404);
  });
  await t.test('finds items in nested locations and by tags',async()=>{
    const result=await call(`/api/items?location=${place.body.id}&tag=tools&q=${encodeURIComponent(name)}`);assert.equal(result.status,200);assert.equal(result.body.items.length,1);assert.equal(result.body.items[0].id,item.body.id);
  });
  await t.test('stores comments independently of editable item fields',async()=>{
    const response=await call(`/api/items/${item.body.id}/comments`,{body:'Keep this comment.'},'POST');assert.equal(response.status,201);assert.equal(response.body.comments[0].body,'Keep this comment.');
    const update=await call(`/api/items/${item.body.id}`,{revision:1,data:{...item.body.data,description:'Agent changed the details.'}},'PUT');assert.equal(update.status,200);assert.equal(update.body.revision,2);assert.equal(update.body.comments[0].body,'Keep this comment.');item=update;
  });
  await t.test('rejects an edit based on an old revision',async()=>{
    const stale=await call(`/api/items/${item.body.id}`,{revision:1,data:{...item.body.data,name:'Stale overwrite'}},'PUT');assert.equal(stale.status,409);
    const current=await call(`/api/items/${item.body.id}`);assert.equal(current.body.data.name,name);
  });
  await t.test('restores earlier details without removing comments',async()=>{
    const event=item.body.activity.find(event=>event.before_data);
    const restored=await call(`/api/items/${item.body.id}/restore`,{revision:2,eventId:event.id},'POST');assert.equal(restored.status,200);assert.equal(restored.body.data.description,'');assert.equal(restored.body.comments.length,1);assert.equal(restored.body.revision,3);item=restored;
  });
  await t.test('uploads and retrieves a private receipt',async()=>{
    const form=new FormData();form.set('kind','receipt');form.set('file',new File(['Receipt for verification'],'receipt.txt',{type:'text/plain'}));
    const response=await fetch(`${base}/api/items/${item.body.id}/attachments`,{method:'POST',body:form});assert.equal(response.status,201);
    const data=await response.json();const file=await fetch(`${base}/api/files/${data.attachments[0].id}`);assert.equal(file.status,200);assert.equal(await file.text(),'Receipt for verification');assert.match(file.headers.get('cache-control'),/private/);assert.match(file.headers.get('content-disposition'),/attachment/);
  });
  await t.test('rejects active file formats',async()=>{
    const form=new FormData();form.set('kind','photo');form.set('file',new File(['<svg/>'],'bad.svg',{type:'image/svg+xml'}));const response=await fetch(`${base}/api/items/${item.body.id}/attachments`,{method:'POST',body:form});assert.equal(response.status,415);
  });
  await t.test('removes and restores photos without changing item details or comments',async()=>{
    const before=(await call(`/api/items/${item.body.id}`)).body;
    const photoIds=[];
    for(const filename of ['first.png','second.png']){
      const form=new FormData();form.set('kind','photo');form.set('file',new File(['test photo bytes'],filename,{type:'image/png'}));
      const response=await fetch(`${base}/api/items/${item.body.id}/attachments`,{method:'POST',body:form});assert.equal(response.status,201);
      photoIds.push((await response.json()).attachments.find(file=>file.filename===filename).id);
    }
    const path=`/api/items/${item.body.id}/attachments/${photoIds[0]}`;
    assert.equal((await call(`/api/items/${randomUUID()}/attachments/${photoIds[0]}`,null,'DELETE')).status,404);
    assert.equal((await call(path,null,'DELETE',{Origin:'https://other.example'})).status,403);
    const removed=await call(path,null,'DELETE');assert.equal(removed.status,200);
    assert.deepEqual(removed.body.data,before.data);assert.equal(removed.body.revision,before.revision);
    assert.deepEqual(removed.body.comments,before.comments);
    assert.ok(before.activity.every(event=>removed.body.activity.some(current=>current.id===event.id)));
    assert.ok(!removed.body.attachments.some(file=>file.id===photoIds[0]));
    assert.equal(removed.body.removedAttachments[0].id,photoIds[0]);
    assert.equal(removed.body.activity.filter(event=>event.attachment_id===photoIds[0]&&event.action.startsWith('Removed')).length,1);
    const list=await call(`/api/items?q=${encodeURIComponent(name)}`);assert.equal(list.body.items[0].photo_id,photoIds[1]);
    const repeat=await call(path,null,'DELETE');assert.equal(repeat.status,200);assert.equal(repeat.body.activity.length,removed.body.activity.length);
    const retained=await fetch(`${base}/api/files/${photoIds[0]}`);assert.equal(retained.status,200);assert.equal(await retained.text(),'test photo bytes');
    const exported=await call('/api/export');assert.ok(exported.body.attachments.find(file=>file.id===photoIds[0]).removed_at);
    const run=promisify(execFile);
    const restored=JSON.parse((await run(process.execPath,['scripts/inventory.mjs','restore-file',item.body.id,photoIds[0]],{env:{...process.env,INVENTORY_URL:base}})).stdout);
    assert.equal(restored.removedAttachments.length,0);assert.ok(restored.attachments.some(file=>file.id===photoIds[0]));
    assert.deepEqual(restored.data,before.data);assert.deepEqual(restored.comments,before.comments);
    const restoredAgain=await call(path+'/restore',null,'POST');assert.equal(restoredAgain.body.activity.length,restored.activity.length);
    await run(process.execPath,['scripts/inventory.mjs','remove-file',item.body.id,photoIds[0]],{env:{...process.env,INVENTORY_URL:base}});
    await call(`/api/items/${item.body.id}/attachments/${photoIds[1]}`,null,'DELETE');
    const withoutPhotos=await call(`/api/items?q=${encodeURIComponent(name)}`);assert.equal(withoutPhotos.body.items[0].photo_id,null);
    assert.equal((await call(`/api/items/${item.body.id}/attachments/not-a-uuid`,null,'DELETE')).status,400);
  });
  await t.test('validates unsafe links, invalid money, and missing locations',async()=>{
    for(const patch of [{productUrl:'javascript:alert(1)'},{priceMinor:1.5},{locationId:randomUUID()},{purchaseDate:'2026-99-99'}]){const response=await call('/api/items',{data:{name,...patch}},'POST');assert.equal(response.status,400);}
  });
  await t.test('rejects cross-origin writes',async()=>{
    const response=await call('/api/items',{data:{name}},'POST',{Origin:'https://other.example'});assert.equal(response.status,403);
  });
  await t.test('does not trust a forged user header on a public host',async()=>{
    const request=new Request('https://inventory.example.com/api/bootstrap',{headers:{'Cf-Access-Authenticated-User-Email':'owner@example.com','Cf-Access-Jwt-Assertion':'not-a-jwt'}});
    assert.equal(await authenticate(request,{AUTH_ISSUER:'',AUTH_AUDIENCE:'',DEV_AUTH:'true'}),null);
    assert.equal(await authenticate(new Request(base+'/api/bootstrap'),{AUTH_ISSUER:'',AUTH_AUDIENCE:'',DEV_AUTH:'false'}),null);
  });
  await t.test('exports item records, comments, and attachment metadata',async()=>{
    const response=await call('/api/export');assert.equal(response.status,200);assert.equal(response.body.format,'kriger-home-v1');assert.ok(response.body.items.some(record=>record.id===item.body.id));assert.ok(response.body.comments.some(record=>record.item_id===item.body.id));assert.ok(response.body.attachments.some(record=>record.item_id===item.body.id));
  });
  await t.test('agent CLI reads items and exports attachment bytes',async()=>{
    const run=promisify(execFile);
    const options={env:{...process.env,INVENTORY_URL:base}};
    const result=await run(process.execPath,['scripts/inventory.mjs','get',item.body.id],options);
    assert.equal(JSON.parse(result.stdout).id,item.body.id);
    const directory=await mkdtemp(join(tmpdir(),'kriger-export-test-'));
    try {
      const destination=join(directory,'backup');
      await run(process.execPath,['scripts/inventory.mjs','export',destination],options);
      const exported=JSON.parse(await readFile(join(destination,'inventory.json'),'utf8'));
      const attachment=exported.attachments.find(file=>file.item_id===item.body.id);
      assert.equal(await readFile(join(destination,'files',attachment.id),'utf8'),'Receipt for verification');
      assert.ok(exported.comments.some(comment=>comment.item_id===item.body.id));
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  await t.test('archives an item without losing its record',async()=>{
    const response=await call(`/api/items/${item.body.id}`,{revision:3,data:{...item.body.data,status:'archived'}},'PUT');assert.equal(response.status,200);
    const visible=await call(`/api/items?q=${encodeURIComponent(name)}`);assert.equal(visible.body.total,0);
    const archived=await call(`/api/items?status=archived&q=${encodeURIComponent(name)}`);assert.equal(archived.body.total,1);
  });
  await t.test('serves the app with a restrictive content policy',async()=>{
    const response=await fetch(base);assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(response.headers.get('cache-control'),/private/);
  });
});

test('production authentication verifies signatures, issuer, audience, and expiry',async t=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const jwk={...await exportJWK(publicKey),kid:'verification-key',alg:'RS256',use:'sig'};
  const env={AUTH_ISSUER:'https://verification.cloudflareaccess.com',AUTH_AUDIENCE:'inventory',DEV_AUTH:'false'};
  const fetchMock=t.mock.method(globalThis,'fetch',async url=>{
    assert.equal(String(url),`${env.AUTH_ISSUER}/cdn-cgi/access/certs`);
    return Response.json({keys:[jwk]});
  });
  const signed=async(payload={},audience='inventory',expiry='5m')=>new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(env.AUTH_ISSUER).setAudience(audience).setSubject('test-subject').setIssuedAt().setExpirationTime(expiry).sign(privateKey);
  const check=token=>authenticate(new Request('https://inventory.example.com/api/bootstrap',{headers:{'Cf-Access-Jwt-Assertion':token}}),env);
  assert.equal(await check(await signed({email:'owner@example.com'})),'owner@example.com');
  assert.equal(await check(await signed({common_name:'inventory-agent'})),'Agent: inventory-agent');
  assert.equal(await check(await signed({email:'owner@example.com'},'another-app')),null);
  assert.equal(await check(await signed({email:'owner@example.com'},'inventory','-1m')),null);
  const token=await signed({email:'owner@example.com'});
  assert.equal(await check(token.slice(0,-10)+'tampered'),null);
  assert.equal(await check(await signed()),null);
  fetchMock.mock.restore();
});
