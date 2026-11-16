import { publicCollection, manageCollection } from './collection-shares.ts';
import { z } from 'zod';
import { authenticate, type AuthEnv } from './auth.ts';
import { itemId, attachmentId, itemData, itemCreate, itemUpdate, itemRow, itemColumns, locationId, locationInput, type ItemId } from './domain.ts';
import { groupPurchases, productKey, purchaseSummary } from './purchases.ts';
import { inboxReview, reviewInbox } from './inbox.ts';
import { priceInUsd, priceOrderSql, priceReference } from './prices.ts';
import { publicShare, manageShare, ShareError, storedFileKey } from './shares.ts';

interface Env extends AuthEnv { DB: D1Database; FILES: R2Bucket; ASSETS: Fetcher }
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const jsonBody = async (request: Request) => {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Send JSON data.');
  const raw = await request.text();
  if (raw.length > 32000) throw new HttpError(413, 'This record is too large.');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON.'); }
};
async function exists(env: Env, id: ItemId) {
  const row = await env.DB.prepare(`SELECT ${itemColumns} FROM items i WHERE id=?`).bind(id).first();
  if (!row) throw new HttpError(404, 'Item not found.');
  return itemRow.parse(row);
}
async function validateLocation(env: Env, id: string | null) {
  if (id && !await env.DB.prepare('SELECT id FROM locations WHERE id=?').bind(id).first()) throw new HttpError(400, 'Location not found.');
}
async function detail(env: Env, id: ItemId) {
  const item = await exists(env,id);
  const [comments, attachments, removedAttachments, activity] = await Promise.all([
    env.DB.prepare('SELECT * FROM comments WHERE item_id=? ORDER BY created_at,id').bind(id).all(),
    env.DB.prepare('SELECT * FROM attachments WHERE item_id=? AND removed_at IS NULL ORDER BY created_at,id').bind(id).all(),
    env.DB.prepare('SELECT * FROM attachments WHERE item_id=? AND removed_at IS NOT NULL ORDER BY removed_at DESC,id').bind(id).all(),
    env.DB.prepare('SELECT * FROM activity WHERE item_id=? ORDER BY id DESC LIMIT 50').bind(id).all(),
  ]);
  return { ...item, comments: comments.results, attachments: attachments.results, removedAttachments: removedAttachments.results, activity: activity.results };
}
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path.startsWith('/share/collection/')) return await publicCollection(request,env);
      if (path === '/share' || path.startsWith('/share/')) return await publicShare(request,env);
      const actor = await authenticate(request,env);
      if (!actor) return json({ error: 'Sign in through Cloudflare Access.' },401);
      if (!['GET','HEAD'].includes(request.method)) {
        const origin = request.headers.get('origin');
        if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403,'This request came from another site.');
      }
      if (!path.startsWith('/api/')) {
        const response = await env.ASSETS.fetch(request);
        const secured = new Response(response.body,response);
        secured.headers.set('Content-Security-Policy',csp);
        secured.headers.set('X-Content-Type-Options','nosniff');
        secured.headers.set('Referrer-Policy','no-referrer');
        secured.headers.set('Cache-Control','private, no-cache');
        return secured;
      }
      if (path === '/api/bootstrap' && request.method === 'GET') {
        const [locations, counts, values, tags] = await Promise.all([
          env.DB.prepare('SELECT id,name,parent_id FROM locations ORDER BY name COLLATE NOCASE').all(),
          env.DB.prepare("SELECT status,COUNT(*) AS count FROM items GROUP BY status").all(),
          env.DB.prepare("SELECT json_extract(data,'$.currency') AS currency,SUM(json_extract(data,'$.priceMinor')*json_extract(data,'$.quantity')) AS total FROM items WHERE status!='archived' GROUP BY currency").all(),
          env.DB.prepare("SELECT DISTINCT j.value AS name FROM items i,json_each(i.data,'$.tags') j WHERE i.status!='archived' ORDER BY name").all(),
        ]);
        return json({ actor, locations: locations.results, counts: counts.results, values: values.results, tags: tags.results, priceReference });
      }
      if (path === '/api/inbox/review' && request.method === 'POST') {
        const input = inboxReview.parse(await jsonBody(request));
        const result = await reviewInbox(env.DB,input,actor);
        if (!result.items.length) throw new HttpError(409,'These purchases changed. Reload the inbox before trying again.');
        return json(result);
      }
      if (path === '/api/items' && request.method === 'GET') {
        const pagination = z.object({
          limit: z.coerce.number().int().min(1).max(200),
          offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        }).parse({ limit: url.searchParams.get('limit') ?? 120, offset: url.searchParams.get('offset') ?? 0 });
        const { limit, offset } = pagination;
        const grouping = z.enum(['none','product']).parse(url.searchParams.get('group') ?? 'none');
        const photo = z.enum(['all','missing']).parse(url.searchParams.get('photo') ?? 'all');
        const sort = z.enum(['recent','name','purchaseDate','price']).parse(url.searchParams.get('sort') ?? 'purchaseDate');
        const direction = z.enum(['asc','desc']).parse(url.searchParams.get('direction') ?? (sort === 'recent' || sort === 'purchaseDate' ? 'desc' : 'asc'));
        const conditions: string[] = []; const params: (string | number)[] = [];
        const status = url.searchParams.get('status');
        if (status) { conditions.push('i.status=?'); params.push(z.enum(['active','inbox','lent','archived']).parse(status)); }
        else conditions.push("i.status!='archived'");
        const q = url.searchParams.get('q')?.trim();
        if (q) { conditions.push("(i.name LIKE ? ESCAPE '\\' OR i.data LIKE ? ESCAPE '\\')"); const term=`%${q.slice(0,120).replace(/[\\%_]/g,'\\$&')}%`; params.push(term,term); }
        const tag = url.searchParams.get('tag');
        if (tag) { conditions.push("EXISTS(SELECT 1 FROM json_each(i.data,'$.tags') WHERE value=?)");params.push(tag); }
        const purchaseFor = url.searchParams.get('purchaseFor');
        if (purchaseFor) { conditions.push("COALESCE(json_extract(i.data,'$.purchaseFor.kind'),'self')=?");params.push(z.enum(['self','other']).parse(purchaseFor)); }
        const location = url.searchParams.get('location');
        if (location) { locationId.parse(location); conditions.push('i.location_id IN (WITH RECURSIVE descendants(id) AS (SELECT id FROM locations WHERE id=? UNION ALL SELECT l.id FROM locations l JOIN descendants d ON l.parent_id=d.id) SELECT id FROM descendants)'); params.push(location); }
        const order = {
          recent: `i.updated_at ${direction},i.id`,
          name: `i.name COLLATE NOCASE ${direction},i.id`,
          purchaseDate: `NULLIF(json_extract(i.data,'$.purchaseDate'),'') IS NULL, json_extract(i.data,'$.purchaseDate') ${direction},i.id`,
          price: priceOrderSql(direction),
        }[sort];
        if (photo === 'missing' && grouping === 'none') conditions.push("NOT EXISTS(SELECT 1 FROM attachments a WHERE a.item_id=i.id AND a.kind='photo' AND a.removed_at IS NULL)");
        const where = conditions.join(' AND ');
        if (grouping === 'product') {
          const rows = await env.DB.prepare(`SELECT ${itemColumns},(SELECT id FROM attachments a WHERE a.item_id=i.id AND kind='photo' AND removed_at IS NULL ORDER BY created_at,id LIMIT 1) AS photo_id FROM items i WHERE ${where} ORDER BY ${order}`).bind(...params).all();
          const groups = groupPurchases(rows.results.map(row => itemRow.parse(row))).filter(group => photo !== 'missing' || !group.photo_id);
          return json({ items: groups.slice(offset, offset + limit).map(item => ({ ...item, sortPriceMinor: priceInUsd(item.data) })), total: groups.length, recordTotal: groups.reduce((sum, group) => sum + group.purchaseCount, 0), offset, limit, priceReference });
        }
        const [rows,total] = await Promise.all([
          env.DB.prepare(`SELECT ${itemColumns},(SELECT id FROM attachments a WHERE a.item_id=i.id AND kind='photo' AND removed_at IS NULL ORDER BY created_at,id LIMIT 1) AS photo_id FROM items i WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...params,limit,offset).all(),
          env.DB.prepare(`SELECT COUNT(*) AS count FROM items i WHERE ${where}`).bind(...params).first<{count:number}>(),
        ]);
        return json({ items:rows.results.map(row=>{const item=itemRow.parse(row);return {...item,sortPriceMinor:priceInUsd(item.data)};}),total:total?.count ?? 0,offset,limit,priceReference });
      }
      if (path === '/api/items' && request.method === 'POST') {
        const input = itemCreate.parse(await jsonBody(request));
        const id = input.id ?? itemId.parse(crypto.randomUUID());
        await validateLocation(env,input.data.locationId);
        const created = await env.DB.prepare('INSERT INTO items(id,data,updated_by,action) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM deleted_items WHERE id=?) ON CONFLICT(id) DO NOTHING').bind(id,JSON.stringify(input.data),actor,'Added item',id).run();
        if (!created.meta.changes && await env.DB.prepare('SELECT id FROM deleted_items WHERE id=?').bind(id).first()) throw new HttpError(409,'This item ID was permanently deleted. Use a new ID.');
        const saved = await detail(env,id);
        if (!created.meta.changes && JSON.stringify(saved.data) !== JSON.stringify(input.data)) throw new HttpError(409,'This item ID already exists.');
        return json(saved,created.meta.changes ? 201 : 200);
      }
      if (path === '/api/locations' && request.method === 'POST') {
        const data = locationInput.parse(await jsonBody(request));
        await validateLocation(env,data.parentId);
        const id = locationId.parse(crypto.randomUUID());
        await env.DB.prepare('INSERT INTO locations(id,name,parent_id) VALUES(?,?,?)').bind(id,data.name,data.parentId).run();
        return json({id,name:data.name,parent_id:data.parentId},201);
      }
      if (path === '/api/activity' && request.method === 'GET') {
        const results=await env.DB.prepare('SELECT a.id,a.item_id,a.action,a.actor,a.created_at,i.name FROM activity a JOIN items i ON i.id=a.item_id ORDER BY a.id DESC LIMIT 100').all();
        return json(results.results);
      }
      if (path === '/api/export' && request.method === 'GET') {
        const [items,locations,comments,attachments,activity] = await env.DB.batch(['items','locations','comments','attachments','activity'].map(table=>env.DB.prepare(`SELECT * FROM ${table}`)));
        return json({format:'home-inventory-v1',exportedAt:new Date().toISOString(),items:items?.results,locations:locations?.results,comments:comments?.results,attachments:attachments?.results,activity:activity?.results});
      }
      const fileMatch=path.match(/^\/api\/files\/([^/]+)$/);
      if (fileMatch && ['GET','HEAD'].includes(request.method)) {
        const id=attachmentId.parse(fileMatch[1]);
        const meta=await env.DB.prepare('SELECT filename,content_type,kind FROM attachments WHERE id=?').bind(id).first<{filename:string;content_type:string;kind:string}>();
        if (!meta) throw new HttpError(404,'File not found.');
        const file=await env.FILES.get(id);
        if (!file) throw new HttpError(404,'File not found.');
        const headers=new Headers({'Content-Type':meta.content_type,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':`${meta.kind==='photo'?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.filename)}`});
        headers.set('Content-Length',String(file.size));
        return new Response(request.method==='HEAD'?null:file.body,{headers});
      }
      const attachmentMatch=path.match(/^\/api\/items\/([^/]+)\/attachments\/([^/]+)(\/restore)?$/);
      if (attachmentMatch) {
        const id=itemId.parse(attachmentMatch[1]);
        const fileId=attachmentId.parse(attachmentMatch[2]);
        const restore=Boolean(attachmentMatch[3]);
        if (request.method!==(restore?'POST':'DELETE')) throw new HttpError(405,'Method not allowed.');
        const file=await env.DB.prepare('SELECT id FROM attachments WHERE id=? AND item_id=?').bind(fileId,id).first();
        if (!file) throw new HttpError(404,'File not found on this item.');
        await env.DB.prepare(restore
          ? 'UPDATE attachments SET removed_at=NULL,updated_by=? WHERE id=? AND item_id=? AND removed_at IS NOT NULL'
          : "UPDATE attachments SET removed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_by=? WHERE id=? AND item_id=? AND removed_at IS NULL"
        ).bind(actor,fileId,id).run();
        return json(await detail(env,id));
      }
      const collectionSharing = /^\/api\/collection-shares(?:\/(preview|[^/]+))?$/.exec(path);
      if (collectionSharing) return await manageCollection(request,env,collectionSharing[1] && collectionSharing[1] !== 'preview' ? collectionSharing[1] : null,collectionSharing[1] === 'preview');
      const sharing = /^\/api\/items\/([^/]+)\/share(\/preview)?$/.exec(path);
      if (sharing) return await manageShare(request,env,itemId.parse(sharing[1]),Boolean(sharing[2]));
      const match=path.match(/^\/api\/items\/([^/]+)(?:\/(comments|attachments|restore|purchases))?$/);
      if (!match) throw new HttpError(404,'Page not found.');
      const id=itemId.parse(match[1]);
      const action=match[2];
      if (action==='purchases' && request.method==='GET') {
        const item = await exists(env,id);
        const key = productKey(item);
        const rows = await env.DB.prepare(`SELECT ${itemColumns} FROM items i ORDER BY json_extract(data,'$.purchaseDate') DESC,i.created_at DESC,i.id`).all();
        return json(rows.results.map(row => itemRow.parse(row)).filter(row => productKey(row) === key).map(purchaseSummary));
      }
      if (!action && request.method==='GET') return json(await detail(env,id));
      if (!action && request.method==='DELETE') {
        const { revision } = z.object({ revision:z.number().int().positive() }).strict().parse(await jsonBody(request));
        await env.DB.batch([
          env.DB.prepare('INSERT INTO deleted_items(id,file_ids) SELECT id,(SELECT json_group_array(file_key) FROM (SELECT id AS file_key,item_id FROM attachments UNION ALL SELECT photo_key AS file_key,item_id FROM item_shares WHERE photo_key IS NOT NULL UNION ALL SELECT photo_key AS file_key,item_id FROM collection_share_items WHERE photo_key IS NOT NULL) WHERE item_id=items.id) FROM items WHERE id=? AND revision=? ON CONFLICT(id) DO NOTHING').bind(id,revision),
          ...['activity','comments','collection_share_items','item_shares','attachments','items'].map(table => env.DB.prepare(`DELETE FROM ${table} WHERE ${table === 'items' ? 'id' : 'item_id'}=? AND EXISTS(SELECT 1 FROM deleted_items WHERE id=?)`).bind(id,id)),
        ]);
        const deleted = await env.DB.prepare('SELECT file_ids FROM deleted_items WHERE id=?').bind(id).first<{file_ids:string}>();
        if (!deleted) { await exists(env,id); throw new HttpError(409,'This item changed. Reload it before deleting.'); }
        const files = z.array(storedFileKey).parse(JSON.parse(deleted.file_ids));
        try {
          for (let offset=0;offset<files.length;offset+=1000) await env.FILES.delete(files.slice(offset,offset+1000));
        } catch {
          throw new HttpError(503,'The item was deleted. File cleanup failed. Retry deletion to finish.');
        }
        await env.DB.prepare("UPDATE deleted_items SET file_ids='[]' WHERE id=?").bind(id).run();
        return json({id,deleted:true});
      }
      if (!action && request.method==='PUT') {
        const input=itemUpdate.parse(await jsonBody(request));
        await exists(env,id);await validateLocation(env,input.data.locationId);
        const result=await env.DB.prepare("UPDATE items SET data=?,revision=revision+1,updated_by=?,action='Updated item',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revision=?").bind(JSON.stringify(input.data),actor,id,input.revision).run();
        if (!result.meta.changes) throw new HttpError(409,'This item changed. Reload it before saving.');
        return json(await detail(env,id));
      }
      if (action==='comments' && request.method==='POST') {
        await exists(env,id);
        const {body}=z.object({body:z.string().trim().min(1).max(4000)}).strict().parse(await jsonBody(request));
        await env.DB.batch([
          env.DB.prepare('INSERT INTO comments(id,item_id,body,author) VALUES(?,?,?,?)').bind(crypto.randomUUID(),id,body,actor),
          env.DB.prepare("INSERT INTO activity(item_id,actor,action) VALUES(?,?,'Added comment')").bind(id,actor),
        ]);
        return json(await detail(env,id),201);
      }
      if (action==='attachments' && request.method==='POST') {
        await exists(env,id);
        const sizeLimit=12*1024*1024;
        if (Number(request.headers.get('content-length'))>sizeLimit) throw new HttpError(413,'Choose a file smaller than 12 MB.');
        const form=await request.formData();
        const file=form.get('file');
        const kind=z.enum(['photo','receipt','manual','document']).parse(form.get('kind')??'photo');
        if (!(file instanceof File) || file.size===0 || file.size>sizeLimit) throw new HttpError(400,'Choose a file smaller than 12 MB.');
        const allowed=kind==='photo'?['image/jpeg','image/png','image/webp','image/avif']:['image/jpeg','image/png','image/webp','application/pdf','text/plain'];
        if (!allowed.includes(file.type)) throw new HttpError(415,'Use a JPG, PNG, WebP, AVIF, PDF, or text file.');
        const fileId=attachmentId.parse(crypto.randomUUID());
        await env.FILES.put(fileId,file.stream(),{httpMetadata:{contentType:file.type}});
        try {
          await env.DB.batch([
            env.DB.prepare('INSERT INTO attachments(id,item_id,filename,content_type,size,kind,updated_by) VALUES(?,?,?,?,?,?,?)').bind(fileId,id,file.name.slice(0,180),file.type,file.size,kind,actor),
            env.DB.prepare("INSERT INTO activity(item_id,actor,action,attachment_id) VALUES(?,?,'Attached file',?)").bind(id,actor,fileId),
          ]);
        } catch(error) {await env.FILES.delete(fileId);throw error;}
        return json(await detail(env,id),201);
      }
      if (action==='restore' && request.method==='POST') {
        const input=z.object({revision:z.number().int().positive(),eventId:z.number().int().positive()}).strict().parse(await jsonBody(request));
        const event=await env.DB.prepare('SELECT before_data FROM activity WHERE id=? AND item_id=?').bind(input.eventId,id).first<{before_data:string|null}>();
        if (!event?.before_data) throw new HttpError(400,'This event has no earlier version.');
        const data=itemData.parse(JSON.parse(event.before_data));
        await validateLocation(env,data.locationId);
        const result=await env.DB.prepare("UPDATE items SET data=?,revision=revision+1,updated_by=?,action='Restored version',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revision=?").bind(JSON.stringify(data),actor,id,input.revision).run();
        if(!result.meta.changes) throw new HttpError(409,'This item changed. Reload it before restoring.');
        return json(await detail(env,id));
      }
      throw new HttpError(405,'Method not allowed.');
    } catch(error) {
      if (error instanceof HttpError || error instanceof ShareError) return json({error:error.message},error.status);
      if (error instanceof z.ZodError) return json({error:error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; ')},400);
      console.error(JSON.stringify({event:'request_failed',message:error instanceof Error?error.message:'Unknown error'}));
      return json({error:'The request failed. Please try again.'},500);
    }
  },
} satisfies ExportedHandler<Env>;
