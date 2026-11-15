import { z } from 'zod';
import { attachmentId, itemData, itemId, itemRow, itemColumns } from './domain.ts';
import { publicHeaders, sharedData, sharePage } from './share-page.ts';

type ShareEnv = { DB: D1Database; FILES: R2Bucket; ASSETS: Fetcher };
export class ShareError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const tokenFormat = /^[A-Za-z0-9_-]{43}$/;
const photoKey = z.string().regex(/^shares\/[A-Za-z0-9_-]{43}\.webp$/);
export const storedFileKey = z.union([attachmentId, photoKey]);
const shareInput = z.object({
  revision: z.number().int().positive(), description: z.string().trim().max(2000).default(''),
  fields: z.array(z.enum(['brand', 'model', 'price', 'seller', 'purchaseDate', 'productUrl', 'tags'])).max(7).default(['brand', 'model']),
  photoId: attachmentId.nullable().default(null), expiresAt: z.iso.datetime().nullable().transform(value => value === null ? null : new Date(value).toISOString()).default(() => new Date(Date.now() + 30 * 86400000).toISOString()),
}).strict();
const shareRow = z.object({
  id: z.uuid(), item_id: itemId, token: z.string().regex(tokenFormat),
  snapshot: z.string().transform(value => sharedData.parse(JSON.parse(value))),
  photo_key: photoKey.nullable(), source_photo_id: attachmentId.nullable(),
  created_at: z.string(), expires_at: z.string().nullable(), revoked_at: z.string().nullable(),
});
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const unavailable = (method: string, status = 404) => new Response(method === 'HEAD' ? null : 'This shared page is unavailable.', { status, headers: { ...publicHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });

export async function publicShare(request: Request, env: ShareEnv): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return unavailable(request.method, 405);
  const path = new URL(request.url).pathname;
  if (path === '/share/assets/page.css') {
    const asset = await env.ASSETS.fetch(new Request(new URL('/share-page.css', request.url), { method: request.method }));
    return new Response(asset.body, { status: asset.status, headers: { ...publicHeaders, 'Content-Type': 'text/css; charset=utf-8' } });
  }
  const match = /^\/share\/([A-Za-z0-9_-]{43})(\/photo)?$/.exec(path);
  if (!match) return unavailable(request.method);
  const row = await env.DB.prepare("SELECT s.* FROM item_shares s JOIN items i ON i.id=s.item_id WHERE s.token=? AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?)").bind(match[1], new Date().toISOString()).first();
  if (!row) return unavailable(request.method);
  const share = shareRow.parse(row);
  const hasPhoto = share.photo_key && await env.DB.prepare("SELECT id FROM attachments WHERE id=? AND item_id=? AND kind='photo' AND removed_at IS NULL").bind(share.source_photo_id, share.item_id).first();
  if (match[2]) {
    if (!hasPhoto || !share.photo_key) return unavailable(request.method);
    const file = await env.FILES.get(share.photo_key);
    if (!file) return unavailable(request.method);
    return new Response(request.method === 'HEAD' ? null : file.body, { headers: { ...publicHeaders, 'Content-Type': 'image/webp', 'Content-Length': String(file.size), 'Content-Disposition': 'inline; filename="shared-photo.webp"' } });
  }
  return new Response(request.method === 'HEAD' ? null : sharePage(share.snapshot, hasPhoto ? `/share/${share.token}/photo` : null), { headers: { ...publicHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
}

function snapshot(data: z.infer<typeof itemData>, input: z.infer<typeof shareInput>) {
  const fields = new Set(input.fields);
  return sharedData.parse({
    name: data.name, description: input.description,
    brand: fields.has('brand') ? data.brand : '', model: fields.has('model') ? data.model : '',
    price: fields.has('price') && data.priceMinor !== null ? { minor: data.priceMinor, currency: data.currency } : null,
    seller: fields.has('seller') ? data.seller : '', purchaseDate: fields.has('purchaseDate') ? data.purchaseDate : '',
    productUrl: fields.has('productUrl') ? data.productUrl : '', tags: fields.has('tags') ? data.tags : [],
  });
}

async function webpPhoto(file: File): Promise<ArrayBuffer> {
  if (file.type !== 'image/webp' || file.size > 1_500_000) throw new ShareError(400, 'Use a WebP photo smaller than 1.5 MB.');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength < 20) throw new ShareError(400, 'Invalid WebP photo.');
  const view = new DataView(bytes);
  const word = (offset: number) => String.fromCharCode(...new Uint8Array(bytes, offset, 4));
  if (word(0) !== 'RIFF' || word(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.byteLength) throw new ShareError(400, 'Invalid WebP photo.');
  let offset = 12, images = 0;
  while (offset + 8 <= bytes.byteLength) {
    const type = word(offset), size = view.getUint32(offset + 4, true);
    if (!['VP8 ', 'VP8L', 'VP8X', 'ALPH'].includes(type)) throw new ShareError(400, 'Remove photo metadata and animation before sharing.');
    if (size === 0 || offset + 8 + size + (size % 2) > bytes.byteLength) throw new ShareError(400, 'Invalid WebP photo.');
    if (type === 'VP8 ' || type === 'VP8L') images++;
    if (type === 'VP8X' && (size !== 10 || (view.getUint8(offset + 8) & ~0x10) !== 0)) throw new ShareError(400, 'Remove photo metadata and animation before sharing.');
    offset += 8 + size + (size % 2);
  }
  if (offset !== bytes.byteLength || images !== 1) throw new ShareError(400, 'Invalid WebP photo.');
  return bytes;
}

export async function manageShare(request: Request, env: ShareEnv, id: z.infer<typeof itemId>, preview: boolean): Promise<Response> {
  const row = await env.DB.prepare(`SELECT ${itemColumns} FROM items i WHERE id=?`).bind(id).first();
  if (!row) throw new ShareError(404, 'Item not found.');
  const item = itemRow.parse(row);
  const origin = new URL(request.url).origin;
  if (request.method === 'GET' && !preview) {
    const saved = await env.DB.prepare('SELECT * FROM item_shares WHERE item_id=? AND revoked_at IS NULL').bind(id).first();
    if (!saved) return json({ share: null });
    const share = shareRow.parse(saved);
    return json({ share: { id: share.id, url: `${origin}/share/${share.token}`, createdAt: share.created_at, expiresAt: share.expires_at, expired: Boolean(share.expires_at && share.expires_at <= new Date().toISOString()), data: share.snapshot } });
  }
  if (request.method === 'DELETE' && !preview) {
    const body = z.object({ id: z.uuid() }).strict().parse(await readJson(request));
    await env.DB.prepare("UPDATE item_shares SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND item_id=?").bind(new Date().toISOString(), body.id, id).run();
    const row = await env.DB.prepare('SELECT * FROM item_shares WHERE id=? AND item_id=?').bind(body.id, id).first();
    if (!row) throw new ShareError(404, 'Share not found.');
    const share = shareRow.parse(row);
    if (share.photo_key) {
      try { await env.FILES.delete(share.photo_key); }
      catch { throw new ShareError(503, 'Link revoked. Retry to finish photo cleanup.'); }
      await env.DB.prepare('UPDATE item_shares SET photo_key=NULL WHERE id=?').bind(share.id).run();
    }
    return json({ revoked: true });
  }
  if (request.method !== 'POST') throw new ShareError(405, 'Method not allowed.');
  let raw: unknown, photo: File | null = null;
  if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 1_550_000) throw new ShareError(413, 'Share upload is too large.');
    const form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('content-type') ?? '' } }).formData();
    const data = form.get('data');
    if (typeof data !== 'string' || data.length > 10000) throw new ShareError(400, 'Supply share data as JSON.');
    try { raw = JSON.parse(data); } catch { throw new ShareError(400, 'Invalid JSON.'); }
    const candidate = form.get('photo');
    if (candidate !== null && !(candidate instanceof File)) throw new ShareError(400, 'Supply a photo file.');
    photo = candidate;
  } else raw = await readJson(request);
  const input = shareInput.parse(raw);
  if (input.revision !== item.revision) throw new ShareError(409, 'This item changed. Reload it before sharing.');
  if (input.photoId) {
    const selected = await env.DB.prepare("SELECT id FROM attachments WHERE id=? AND item_id=? AND kind='photo' AND removed_at IS NULL").bind(input.photoId, id).first();
    if (!selected) throw new ShareError(400, 'Select a current photo from this item.');
  }
  if (input.expiresAt && input.expiresAt <= new Date().toISOString()) throw new ShareError(400, 'Choose a future expiry date.');
  const data = snapshot(item.data, input);
  if (preview) return json({ html: sharePage(data, input.photoId ? `/api/files/${input.photoId}` : null) });
  if (Boolean(input.photoId) !== Boolean(photo)) throw new ShareError(400, 'Send the selected photo as a metadata-free WebP file.');
  if (await env.DB.prepare('SELECT id FROM item_shares WHERE item_id=? AND revoked_at IS NULL').bind(id).first()) throw new ShareError(409, 'Revoke the existing link before creating another.');
  const bytes = photo ? await webpPhoto(photo) : null;
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const key = bytes ? `shares/${token}.webp` : null;
  const shareId = crypto.randomUUID();
  const expiresAt = input.expiresAt;
  if (key && bytes) await env.FILES.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } });
  try {
    const result = await env.DB.prepare('INSERT INTO item_shares(id,item_id,token,snapshot,photo_key,source_photo_id,expires_at) SELECT ?,id,?,?,?,?,? FROM items WHERE id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM item_shares WHERE item_id=? AND revoked_at IS NULL)').bind(shareId, token, JSON.stringify(data), key, input.photoId, expiresAt, id, input.revision, id).run();
    if (!result.meta.changes) throw new ShareError(409, 'The item or share changed. Reload before sharing.');
  } catch (error) { if (key) await env.FILES.delete(key); throw error; }
  return json({ id: shareId, url: `${origin}/share/${token}`, expiresAt }, 201);
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ShareError(415, 'Send JSON data.');
  const raw = await request.text();
  if (raw.length > 10000) throw new ShareError(413, 'Share data is too large.');
  try { return JSON.parse(raw); } catch { throw new ShareError(400, 'Invalid JSON.'); }
}
