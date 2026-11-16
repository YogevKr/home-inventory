import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const base = process.env.TEST_URL || 'http://127.0.0.1:8787';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error('Tests require a local server.');
const call = (path, body, method = 'GET', headers = {}) => fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
const create = async () => {
  const response = await call('/api/items', { data: { name: `Collection camera ${randomUUID()}`, brand: 'Camera brand', description: 'PRIVATE_NOTES', serialNumber: 'PRIVATE_SERIAL', priceMinor: 2500, currency: 'USD', seller: 'PRIVATE_STORE', tags: ['PRIVATE_TAG'], productUrl: 'https://example.com/product', purchaseFor: { kind: 'other', recipient: 'PRIVATE_PERSON' } } }, 'POST');
  assert.equal(response.status, 201); return response.json();
};
const input = items => ({ title: 'Weekend gear <script>', items: items.map(item => ({ id: item.id, revision: item.revision })) });
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
async function attach(item, kind = 'photo') {
  const form = new FormData(); form.set('kind', kind); form.set('file', new File([webp], 'private-photo.webp', { type: 'image/webp' }));
  const response = await fetch(`${base}/api/items/${item.id}/attachments`, { method: 'POST', body: form });
  assert.equal(response.status, 201); return (await response.json()).attachments.at(-1).id;
}

 test('collection publication, management, deletion, and revocation keep selected snapshots private', async () => {
  const items = await Promise.all([create(), create(), create()]);
  const data = { ...input(items.slice(0, 2)), description: 'Two public items <img src=x>' };
  const preview = await call('/api/collection-shares/preview', data, 'POST');
  assert.equal(preview.status, 200);
  assert.match((await preview.json()).html, /Two public items &lt;img/);
  const result = await call('/api/collection-shares', data, 'POST'); assert.equal(result.status, 201);
  const { share } = await result.json();
  assert.match(share.url, /\/share\/collection\/[A-Za-z0-9_-]{43}$/);
  const response = await fetch(share.url); const html = await response.text();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.ok(html.includes(items[0].data.name)); assert.ok(html.includes(items[1].data.name)); assert.ok(!html.includes(items[2].data.name));
  assert.match(html, /Weekend gear &lt;script&gt;/); assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('PRIVATE_')); assert.ok(!html.includes('25.00')); assert.ok(!html.includes(items[0].id));
  assert.ok(!html.includes('Details selected by the owner.'));
  assert.equal((await fetch(share.url, { method: 'POST' })).status, 405);
  assert.equal(await (await fetch(share.url, { method: 'HEAD' })).text(), '');
  const listed = await (await call('/api/collection-shares')).json(); assert.ok(listed.shares.some(row => row.id === share.id));
  assert.equal((await (await call(`/api/collection-shares/${share.id}`)).json()).share.url, share.url);
  await call(`/api/items/${items[0].id}`, { revision: 1, data: { ...items[0].data, name: 'PRIVATE_NEW_NAME' } }, 'PUT');
  assert.ok(!(await (await fetch(share.url)).text()).includes('PRIVATE_NEW_NAME'));
  await call(`/api/items/${items[1].id}`, { revision: 1 }, 'DELETE');
  const afterDeletion = await (await fetch(share.url)).text(); assert.ok(!afterDeletion.includes(items[1].data.name)); assert.ok(afterDeletion.includes(items[0].data.name));
  assert.equal((await call(`/api/collection-shares/${share.id}`, null, 'DELETE', { Origin: 'https://other.example' })).status, 403);
  assert.equal((await call(`/api/collection-shares/${share.id}`, null, 'DELETE')).status, 200);
  assert.equal((await fetch(share.url)).status, 404);
  assert.equal((await call(`/api/collection-shares/${share.id}`, null, 'DELETE')).status, 200);
  assert.equal((await (await call(`/api/collection-shares/${share.id}`)).json()).share, null);
});

test('collection photos support JPEG, social previews, source removal, and deletion', async () => {
  const first = await create(), second = await create();
  const ids = [await attach(first), await attach(second)];
  const jpeg = await readFile(new URL('./fixtures/safari-canvas.jpg', import.meta.url));
  const data = { ...input([first, second]), fields: ['price', 'productUrl'], items: [first, second].map((item, index) => ({ id: item.id, revision: 1, photoId: ids[index] })) };
  const form = new FormData(); form.set('data', JSON.stringify(data));
  form.set('photo-0', new File([jpeg], 'private.jpg', { type: 'image/jpeg' }));
  form.set('photo-1', new File([webp], 'private.webp', { type: 'image/webp' }));
  const result = await fetch(base + '/api/collection-shares', { method: 'POST', body: form }); assert.equal(result.status, 201);
  const { share } = await result.json();
  const html = await (await fetch(share.url)).text(); assert.match(html, /\$25\.00/);
  assert.ok(html.includes(`<meta property="og:image" content="${share.url}/photo/0">`));
  const image = await fetch(share.url + '/photo/0'); assert.equal(image.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await image.arrayBuffer()); assert.ok(!bytes.includes(Buffer.from('Exif'))); assert.ok(!bytes.includes(Buffer.from('Photoshop')));
  await call(`/api/items/${first.id}/attachments/${ids[0]}`, null, 'DELETE');
  assert.equal((await fetch(share.url + '/photo/0')).status, 404);
  assert.ok((await (await fetch(share.url)).text()).includes(`<meta property="og:image" content="${share.url}/photo/1">`));
  await call(`/api/items/${second.id}`, { revision: 1 }, 'DELETE');
  assert.equal((await fetch(share.url + '/photo/1')).status, 404);
  await call(`/api/items/${first.id}`, { revision: 1 }, 'DELETE'); assert.equal((await fetch(share.url)).status, 404);
  const single = await create(), photoId = await attach(single);
  const singleForm = new FormData(); singleForm.set('data', JSON.stringify({ revision: 1, photoId })); singleForm.set('photo', new File([webp], 'image.webp', { type: 'image/webp' }));
  const singleShare = await (await fetch(`${base}/api/items/${single.id}/share`, { method: 'POST', body: singleForm })).json();
  const singleHtml = await (await fetch(singleShare.url)).text();
  assert.ok(singleHtml.includes(`<meta property="og:image" content="${singleShare.url}/photo">`));
  assert.ok(singleHtml.includes(`<meta property="og:url" content="${singleShare.url}">`));
  assert.ok(!singleHtml.includes('PRIVATE_'));
});

test('large collections retain every item, photo, order, and revision check', async () => {
  const items = [];
  for (let start = 0; start < 301; start += 10) {
    items.push(...await Promise.all(Array.from({ length: Math.min(10, 301 - start) }, create)));
  }
  const data = { ...input(items), items: items.map(item => ({ id: item.id, revision: item.revision, photoId: null })) };
  assert.ok(JSON.stringify(data).length > 20000);
  const preview = await call('/api/collection-shares/preview', data, 'POST');
  assert.equal(preview.status, 200);
  assert.equal(((await preview.json()).html.match(/class="collection-entry"/g) || []).length, items.length);

  const before = (await (await call('/api/collection-shares')).json()).shares.length;
  const stale = { ...data, items: data.items.map((item, index) => index === 300 ? { ...item, revision: 999 } : item) };
  assert.equal((await call('/api/collection-shares', stale, 'POST')).status, 409);
  assert.equal((await (await call('/api/collection-shares')).json()).shares.length, before);

  const plain = await call('/api/collection-shares', data, 'POST');
  assert.equal(plain.status, 201);
  const plainShare = (await plain.json()).share;
  assert.equal(((await (await fetch(plainShare.url)).text()).match(/class="collection-entry"/g) || []).length, items.length);
  assert.equal((await call(`/api/collection-shares/${plainShare.id}`, null, 'DELETE')).status, 200);

  const form = new FormData();
  for (const position of [...Array.from({ length: 21 }, (_, index) => index), 300]) {
    data.items[position].photoId = await attach(items[position]);
    form.set(`photo-${position}`, new File([webp], 'shared.webp', { type: 'image/webp' }));
  }
  form.set('data', JSON.stringify(data));
  const published = await fetch(base + '/api/collection-shares', { method: 'POST', body: form });
  assert.equal(published.status, 201);
  const { share } = await published.json();
  const html = await (await fetch(share.url)).text();
  assert.equal((html.match(/class="collection-entry"/g) || []).length, items.length);
  let position = -1;
  for (const item of items) {
    const next = html.indexOf(item.data.name, position + 1);
    assert.ok(next > position, item.data.name);
    position = next;
  }
  assert.ok(!html.includes('PRIVATE_'));
  for (const position of [20, 300]) {
    const photo = await fetch(`${share.url}/photo/${position}`);
    assert.equal(photo.status, 200);
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), webp);
  }
  assert.equal((await fetch(`${share.url}/photo/301`)).status, 404);
  assert.equal((await fetch(`${share.url}/photo/99999999999999999999`)).status, 404);
  assert.equal((await call(`/api/collection-shares/${share.id}`, null, 'DELETE')).status, 200);
  assert.equal((await fetch(`${share.url}/photo/300`)).status, 404);
});

test('collection validation rejects missing, stale, duplicate, and private fields without partial publication', async () => {
  const item = await create(), other = await create(), photoId = await attach(other);
  const data = input([item]);
  const invalid = [
    { ...data, items: [] },
    { ...data, items: [data.items[0], data.items[0]] }, { ...data, title: ' ' },
    { ...data, fields: ['serialNumber'] }, { ...data, expiresAt: '2000-01-01T00:00:00Z' },
    { ...data, items: [{ ...data.items[0], photoId }] },
  ];
  for (const body of invalid) assert.equal((await call('/api/collection-shares', body, 'POST')).status, 400);
  const count = (await (await call('/api/collection-shares')).json()).shares.length;
  assert.equal((await call('/api/collection-shares', { ...data, items: [{ id: randomUUID(), revision: 1 }] }, 'POST')).status, 404);
  assert.equal((await call('/api/collection-shares', { ...input([item, other]), items: [data.items[0], { id: other.id, revision: 999 }] }, 'POST')).status, 409);
  assert.equal((await (await call('/api/collection-shares')).json()).shares.length, count);
  const result = await call('/api/collection-shares', { ...data, expiresAt: new Date(Date.now() + 1500).toISOString() }, 'POST');
  assert.equal(result.status, 201); const { share } = await result.json(); await setTimeout(1600);
  assert.equal((await fetch(share.url)).status, 404);
  assert.equal((await (await call(`/api/collection-shares/${share.id}`)).json()).share.expired, true);
});
