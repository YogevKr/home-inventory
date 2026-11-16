import { z } from 'zod';
import { itemId, itemRow, itemColumns, attachmentId } from './domain.ts';
import { collectionPage, publicHeaders, sharedData } from './share-page.ts';
import { ShareError, type ShareEnv, shareInput, snapshot, sharePhoto, storedFileKey, readJson, json, unavailable } from './shares.ts';

const collectionInput = z.object({
  title: z.string().trim().min(1).max(140), description: z.string().trim().max(2000).default(''),
  fields: shareInput.shape.fields, expiresAt: shareInput.shape.expiresAt,
  items: z.array(z.object({ id: itemId, revision: shareInput.shape.revision, photoId: shareInput.shape.photoId }).strict()).min(1),
}).strict().refine(input => new Set(input.items.map(item => item.id)).size === input.items.length, 'Select each item once.');
const collectionRow = z.object({ id: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), title: z.string(), description: z.string(), created_at: z.string(), expires_at: z.string().nullable(), revoked_at: z.string().nullable() });
const entryRow = z.object({ position: z.number().int(), item_id: itemId, snapshot: z.string().transform(value => sharedData.parse(JSON.parse(value))), photo_key: storedFileKey.nullable(), source_photo_id: attachmentId.nullable(), has_photo: z.number().nullable() });
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const summary = (row: z.infer<typeof collectionRow>, origin: string) => ({ id: row.id, url: `${origin}/share/collection/${row.token}`, data: { name: row.title }, createdAt: row.created_at, expiresAt: row.expires_at, expired: Boolean(row.expires_at && row.expires_at <= new Date().toISOString()) });
const entriesSql = "SELECT s.*,EXISTS(SELECT 1 FROM attachments a WHERE a.id=s.source_photo_id AND a.item_id=s.item_id AND a.kind='photo' AND a.removed_at IS NULL) AS has_photo FROM collection_share_items s JOIN items i ON i.id=s.item_id WHERE collection_id=?";
const selectedRow = itemRow.extend({ has_photo: z.number().int() });
const collectionJsonLimit = 1_000_000;

export async function publicCollection(request: Request, env: ShareEnv): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return unavailable(request.method, 405);
  const match = /^\/share\/collection\/([A-Za-z0-9_-]{43})(?:\/photo\/(\d+))?$/.exec(new URL(request.url).pathname);
  if (!match) return unavailable(request.method);
  const raw = await env.DB.prepare('SELECT * FROM collection_shares WHERE token=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)').bind(match[1], new Date().toISOString()).first();
  if (!raw) return unavailable(request.method);
  const collection = collectionRow.parse(raw);
  if (match[2] !== undefined) {
    const position = Number(match[2]);
    if (!Number.isSafeInteger(position)) return unavailable(request.method);
    const row = await env.DB.prepare(`${entriesSql} AND position=?`).bind(collection.id, position).first();
    const entry = row ? entryRow.parse(row) : null;
    if (!entry?.has_photo || !entry.photo_key) return unavailable(request.method);
    const file = await env.FILES.get(entry.photo_key);
    if (!file) return unavailable(request.method);
    const format = entry.photo_key.endsWith('.jpg') ? 'jpg' : 'webp';
    return new Response(request.method === 'HEAD' ? null : file.body, { headers: { ...publicHeaders, 'Content-Type': format === 'jpg' ? 'image/jpeg' : 'image/webp', 'Content-Length': String(file.size), 'Content-Disposition': `inline; filename="shared-photo.${format}"` } });
  }
  const entries = (await env.DB.prepare(`${entriesSql} ORDER BY position`).bind(collection.id).all()).results.map(row => entryRow.parse(row));
  if (!entries.length) return unavailable(request.method);
  const pageUrl = `${new URL(request.url).origin}/share/collection/${collection.token}`;
  return new Response(request.method === 'HEAD' ? null : collectionPage(collection.title, collection.description, entries.map(entry => ({ data: entry.snapshot, photoUrl: entry.has_photo && entry.photo_key ? `/share/collection/${collection.token}/photo/${entry.position}` : null })), pageUrl), { headers: { ...publicHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function manageCollection(request: Request, env: ShareEnv, id: string | null, preview: boolean): Promise<Response> {
  const origin = new URL(request.url).origin;
  if (id) {
    const raw = await env.DB.prepare('SELECT * FROM collection_shares WHERE id=?').bind(z.uuid().parse(id)).first();
    if (!raw) throw new ShareError(404, 'Collection link not found.');
    const saved = collectionRow.parse(raw);
    if (request.method === 'GET') return json({ share: saved.revoked_at ? null : summary(saved, origin) });
    if (request.method !== 'DELETE') throw new ShareError(405, 'Method not allowed.');
    await env.DB.prepare('UPDATE collection_shares SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(new Date().toISOString(), id).run();
    const files = await env.DB.prepare('SELECT photo_key FROM collection_share_items WHERE collection_id=? AND photo_key IS NOT NULL').bind(id).all();
    try { for (const row of files.results) await env.FILES.delete(storedFileKey.parse(row.photo_key)); }
    catch { throw new ShareError(503, 'Link revoked. Retry to finish photo cleanup.'); }
    await env.DB.prepare('UPDATE collection_share_items SET photo_key=NULL WHERE collection_id=?').bind(id).run();
    return json({ revoked: true });
  }
  if (request.method === 'GET' && !preview) {
    const rows = await env.DB.prepare('SELECT * FROM collection_shares WHERE revoked_at IS NULL ORDER BY created_at DESC,id').all();
    return json({ shares: rows.results.map(row => summary(collectionRow.parse(row), origin)) });
  }
  if (request.method !== 'POST') throw new ShareError(405, 'Method not allowed.');
  let raw: unknown;
  let form: FormData | null = null;
  if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 30_100_000) throw new ShareError(413, 'Collection upload is too large.');
    form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('content-type') ?? '' } }).formData();
    const data = form.get('data');
    if (typeof data !== 'string') throw new ShareError(400, 'Supply collection data as JSON.');
    if (data.length > collectionJsonLimit) throw new ShareError(413, 'Share data is too large.');
    try { raw = JSON.parse(data); } catch { throw new ShareError(400, 'Invalid JSON.'); }
  } else raw = await readJson(request, collectionJsonLimit);
  const input = collectionInput.parse(raw);
  if (input.expiresAt && input.expiresAt <= new Date().toISOString()) throw new ShareError(400, 'Choose a future expiry date.');
  const selectedItems = JSON.stringify(input.items);
  const rows = await env.DB.prepare(`SELECT ${itemColumns},
    EXISTS(SELECT 1 FROM attachments a WHERE a.id=json_extract(selected.value,'$.photoId') AND a.item_id=i.id AND a.kind='photo' AND a.removed_at IS NULL) AS has_photo
    FROM json_each(?) selected JOIN items i ON i.id=json_extract(selected.value,'$.id')`).bind(selectedItems).all();
  const items = new Map(rows.results.map(row => { const item = selectedRow.parse(row); return [item.id, item]; }));
  const entries = [];
  for (const [position, selected] of input.items.entries()) {
    const item = items.get(selected.id);
    if (!item) throw new ShareError(404, 'A selected item no longer exists.');
    if (item.revision !== selected.revision) throw new ShareError(409, 'A selected item changed. Select it again before sharing.');
    if (selected.photoId && !item.has_photo) throw new ShareError(400, 'Select a current photo from this item.');
    const photo = form?.get(`photo-${position}`) ?? null;
    if (!preview && (Boolean(photo) !== Boolean(selected.photoId) || (photo !== null && !(photo instanceof File)))) throw new ShareError(400, 'Send each selected photo as a WebP or JPEG file.');
    entries.push({ ...selected, position, data: snapshot(item.data, { ...input, ...selected, description: '' }), image: !preview && photo instanceof File ? await sharePhoto(photo) : null });
  }
  if (preview) return json({ html: collectionPage(input.title, input.description, entries.map(entry => ({ data: entry.data, photoUrl: entry.photoId ? `/api/files/${entry.photoId}` : null }))) });
  const collectionId = crypto.randomUUID(), token = newToken();
  const files = entries.map(entry => ({ ...entry, key: entry.image ? `shares/${newToken()}.${entry.image.format}` : null }));
  try {
    for (const file of files) if (file.key && file.image) await env.FILES.put(file.key, file.image.bytes, { httpMetadata: { contentType: file.image.format === 'jpg' ? 'image/jpeg' : 'image/webp' } });
    const inserts = [];
    for (let start = 0; start < files.length; start += 50) {
      const records = files.slice(start, start + 50).map(file => ({ position: file.position, id: file.id, snapshot: file.data, photoKey: file.key, photoId: file.photoId }));
      inserts.push(env.DB.prepare(`INSERT INTO collection_share_items(collection_id,position,item_id,snapshot,photo_key,source_photo_id)
        SELECT c.id,json_extract(entry.value,'$.position'),json_extract(entry.value,'$.id'),json_extract(entry.value,'$.snapshot'),json_extract(entry.value,'$.photoKey'),json_extract(entry.value,'$.photoId')
        FROM collection_shares c,json_each(?) entry WHERE c.id=?`).bind(JSON.stringify(records), collectionId));
    }
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO collection_shares(id,token,title,description,expires_at) SELECT ?,?,?,?,? WHERE NOT EXISTS(
        SELECT 1 FROM json_each(?) selected LEFT JOIN items i ON i.id=json_extract(selected.value,'$.id')
        WHERE i.id IS NULL OR i.revision<>json_extract(selected.value,'$.revision'))`).bind(collectionId, token, input.title, input.description, input.expiresAt, selectedItems),
      ...inserts,
    ]);
    if (!results[0]?.meta.changes) throw new ShareError(409, 'A selected item changed. Select it again before sharing.');
  } catch (error) { for (const file of files) if (file.key) await env.FILES.delete(file.key); throw error; }
  return json({ share: { id: collectionId, url: `${origin}/share/collection/${token}`, data: { name: input.title }, expiresAt: input.expiresAt, expired: false } }, 201);
}
