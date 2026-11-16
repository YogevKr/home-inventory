import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import worker from '../src/index.ts';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_URL || 'http://127.0.0.1:8787';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error('Tests require a local server.');
const call = (path, body, method = 'GET', headers = {}) => fetch(base + path, {
  method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const privateData = {
  name: 'Camera <script>alert("x")</script>', brand: 'Public brand', model: 'Model 1',
  description: 'PRIVATE_DESCRIPTION', serialNumber: 'PRIVATE_SERIAL', sourceUrl: 'https://example.com/PRIVATE_RECEIPT',
  locationId: '00000000-0000-4000-8000-000000000001', borrower: 'PRIVATE_BORROWER',
  purchaseFor: { kind: 'other', recipient: 'PRIVATE_RECIPIENT' }, tags: ['PRIVATE_TAG'],
  priceMinor: 12990, currency: 'USD', seller: 'PRIVATE_SELLER', purchaseDate: '2026-01-01',
  productUrl: 'https://example.com/product?size=small&color=black',
};
const create = async () => {
  const response = await call('/api/items', { data: { ...privateData, name: privateData.name + randomUUID() } }, 'POST');
  assert.equal(response.status, 201);
  return response.json();
};
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
async function attach(item, kind = 'photo') {
  const form = new FormData(); form.set('kind', kind); form.set('file', new File([webp], 'PRIVATE_FILENAME.webp', { type: 'image/webp' }));
  const response = await fetch(`${base}/api/items/${item.id}/attachments`, { method: 'POST', body: form });
  assert.equal(response.status, 201);
  return (await response.json()).attachments.at(-1).id;
}
async function publish(item, input = {}, bytes = null, type = 'image/webp') {
  const data = { revision: item.revision, ...input };
  if (!bytes) return call(`/api/items/${item.id}/share`, data, 'POST');
  const form = new FormData(); form.set('data', JSON.stringify(data));
  form.set('photo', new File([bytes], 'photo', { type }));
  return fetch(`${base}/api/items/${item.id}/share`, { method: 'POST', body: form });
}

test('shared pages disclose only selected snapshot fields and escape content', async () => {
  const item = await create();
  const route = `/api/items/${item.id}/share`;
  const preview = await call(route + '/preview', { revision: 1, description: 'A public note <img src=x onerror=alert(1)>' }, 'POST');
  assert.equal(preview.status, 200);
  const previewHtml = (await preview.json()).html;
  assert.match(previewHtml, /A public note &lt;img/);
  assert.deepEqual(await (await call(route)).json(), { share: null });
  const result = await publish(item, { description: 'A public note <img src=x onerror=alert(1)>' });
  assert.equal(result.status, 201);
  const share = await result.json();
  assert.match(new URL(share.url).pathname, /^\/share\/[A-Za-z0-9_-]{43}$/);
  assert.ok(!share.url.includes(item.id));
  const page = await fetch(share.url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /Public brand/); assert.match(html, /Model 1/); assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script')); assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('PRIVATE_')); assert.ok(!html.includes(item.id)); assert.ok(!html.includes('129.90'));
  assert.ok(!html.includes('example.com/product'));
  assert.equal(await (await fetch(share.url, { method: 'HEAD' })).text(), '');
  assert.equal((await fetch(share.url, { method: 'POST' })).status, 405);
  assert.equal((await publish(item)).status, 409);
  await call(`/api/items/${item.id}`, { revision: 1, data: { ...item.data, name: 'NEW_PRIVATE_NAME' } }, 'PUT');
  assert.ok(!(await (await fetch(share.url)).text()).includes('NEW_PRIVATE_NAME'));
  const saved = (await (await call(route)).json()).share;
  assert.equal(saved.url, share.url);
  const other = await create();
  assert.equal((await call(`/api/items/${other.id}/share`, { id: share.id }, 'DELETE')).status, 404);
  assert.equal((await call(route, { id: share.id }, 'DELETE', { Origin: 'https://other.example' })).status, 403);
  assert.equal((await fetch(share.url)).status, 200);
  assert.equal((await call(route, { id: share.id }, 'DELETE')).status, 200);
  assert.equal((await fetch(share.url)).status, 404);
  assert.equal((await call(route, { id: share.id }, 'DELETE')).status, 200);
  const current = await (await call(`/api/items/${item.id}`)).json();
  const replacement = await (await publish(current)).json();
  assert.notEqual(replacement.url, share.url);
  assert.equal((await fetch(share.url)).status, 404);
});

test('share fields, revision checks, expiry, and concurrent creation follow the API contract', async () => {
  const item = await create();
  assert.equal((await publish(item, { revision: 999 })).status, 409);
  assert.equal((await publish(item, { fields: ['serialNumber'] })).status, 400);
  assert.equal((await publish(item, { description: 'x'.repeat(2001) })).status, 400);
  assert.equal((await publish(item, { expiresAt: '2000-01-01T00:00:00.000Z' })).status, 400);
  const responses = await Promise.all([publish(item, { fields: ['price', 'productUrl'], expiresAt: null }), publish(item)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const saved = (await (await call(`/api/items/${item.id}/share`)).json()).share;
  assert.equal((await fetch(saved.url)).status, 200);
  const expiring = await create();
  const response = await publish(expiring, { expiresAt: new Date(Date.now() + 1500).toISOString(), fields: ['price', 'productUrl'] });
  assert.equal(response.status, 201);
  const share = await response.json();
  const html = await (await fetch(share.url)).text();
  assert.match(html, /\$129\.90/); assert.match(html, /rel="noopener noreferrer nofollow"/); assert.match(html, /size=small&amp;color=black/);
  await setTimeout(1600);
  assert.equal((await fetch(share.url)).status, 404);
  assert.equal((await (await call(`/api/items/${expiring.id}/share`)).json()).share.expired, true);
});

test('shared photos exclude receipts, other items, metadata, private names, and removed photos', async () => {
  const item = await create(); const other = await create();
  const photoId = await attach(item); const receiptId = await attach(item, 'receipt'); const otherPhoto = await attach(other);
  for (const id of [receiptId, otherPhoto, randomUUID()]) assert.equal((await publish(item, { photoId: id }, webp)).status, 400);
  assert.equal((await publish(item, { photoId })).status, 400);
  const metadata = Buffer.concat([webp, Buffer.from('EXIF\x04\x00\x00\x00GPS!')]); metadata.writeUInt32LE(metadata.length - 8, 4);
  assert.equal((await publish(item, { photoId }, metadata)).status, 400);
  const result = await publish(item, { photoId }, webp); assert.equal(result.status, 201);
  const share = await result.json();
  const photo = await fetch(share.url + '/photo'); assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/webp');
  assert.equal(photo.headers.get('cache-control'), 'no-store');
  assert.ok(!photo.headers.get('content-disposition').includes('PRIVATE_FILENAME'));
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), webp);
  const page = await (await fetch(share.url)).text(); assert.ok(!page.includes(photoId)); assert.ok(!page.includes('PRIVATE_'));
  await call(`/api/items/${item.id}/attachments/${photoId}`, null, 'DELETE');
  assert.equal((await fetch(share.url + '/photo')).status, 404);
  assert.ok(!(await (await fetch(share.url)).text()).includes('<img'));
  await call(`/api/items/${item.id}/attachments/${photoId}/restore`, null, 'POST');
  assert.equal((await fetch(share.url + '/photo')).status, 200);
  await call(`/api/items/${item.id}`, { revision: 1 }, 'DELETE');
  assert.equal((await fetch(share.url)).status, 404);
  assert.equal((await fetch(share.url + '/photo')).status, 404);
});

test('Safari JPEG shares remove metadata and support revocation and item deletion', async () => {
  const item = await create(), photoId = await attach(item);
  const jpeg = await readFile(new URL('./fixtures/safari-canvas.jpg', import.meta.url));
  assert.ok(jpeg.includes(Buffer.from('Exif')));
  assert.ok(jpeg.includes(Buffer.from('Photoshop')));
  const privateMetadata = Buffer.from('PRIVATE_GPS_LOCATION');
  const segment = Buffer.alloc(4); segment[0] = 0xff; segment[1] = 0xe1; segment.writeUInt16BE(privateMetadata.length + 2, 2);
  const withMetadata = Buffer.concat([jpeg.subarray(0, 2), segment, privateMetadata, jpeg.subarray(2)]);
  assert.equal((await publish(item, { photoId }, jpeg)).status, 400);
  for (const invalid of [jpeg.subarray(0, -2), Buffer.concat([jpeg, privateMetadata]), Buffer.from([0xff, 0xd8, 0xff, 0xff])]) {
    assert.equal((await publish(item, { photoId }, invalid, 'image/jpeg')).status, 400);
  }
  const created = await publish(item, { photoId }, withMetadata, 'image/jpeg');
  assert.equal(created.status, 201);
  const share = await created.json(), response = await fetch(share.url + '/photo');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('content-disposition'), 'inline; filename="shared-photo.jpg"');
  const published = Buffer.from(await response.arrayBuffer());
  for (const marker of ['Exif', 'Photoshop', 'PRIVATE_GPS_LOCATION']) assert.ok(!published.includes(Buffer.from(marker)));
  assert.equal(published.readUInt16BE(0), 0xffd8);
  assert.equal(published.readUInt16BE(published.length - 2), 0xffd9);
  assert.equal((await call(`/api/items/${item.id}/share`, { id: share.id }, 'DELETE')).status, 200);
  assert.equal((await fetch(share.url + '/photo')).status, 404);
  const replacement = await (await publish(item, { photoId }, jpeg, 'image/jpeg')).json();
  assert.equal((await call(`/api/items/${item.id}`, { revision: item.revision }, 'DELETE')).status, 200);
  assert.equal((await fetch(replacement.url + '/photo')).status, 404);
});

test('public routing cannot bypass authentication for the collection or API', async () => {
  const env = { DEV_AUTH: 'false', AUTH_ISSUER: '', AUTH_AUDIENCE: '' };
  for (const path of ['/', '/api/bootstrap', '/api/items', `/api/items/${randomUUID()}/share`, '/app.js', '/share-page.css', '/api/files/' + randomUUID()]) {
    assert.equal((await worker.fetch(new Request('https://inventory.example.com' + path), env)).status, 401, path);
  }
  for (const path of ['/share', '/share/', '/share/not-a-token', '/share/assets/app.js', '/share/%2e%2e%2fapi%2fitems', '/share/' + randomUUID()]) {
    assert.equal((await worker.fetch(new Request('https://inventory.example.com' + path), env)).status, 404, path);
  }
  const token = 'a'.repeat(43);
  assert.equal((await worker.fetch(new Request(`https://inventory.example.com/share/${token}`, { method: 'DELETE' }), env)).status, 405);
  const css = await fetch(base + '/share/assets/page.css'); assert.equal(css.status, 200); assert.match(css.headers.get('content-type'), /^text\/css/);
});

test('agents can create, retrieve, and revoke share links through the CLI', async () => {
  const item = await create();
  const cli = (command, data, extra = []) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/inventory.mjs', command, item.id, ...extra], {
      env: { ...process.env, INVENTORY_URL: base }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { errors += value; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
    child.stdin.end(data ? JSON.stringify(data) : '');
  });
  const created = await cli('share', { revision: item.revision });
  const saved = await cli('share-status');
  assert.equal(saved.share.url, created.url);
  assert.equal((await fetch(created.url)).status, 200);
  assert.deepEqual(await cli('revoke-share', { id: created.id }), { revoked: true });
  assert.equal((await fetch(created.url)).status, 404);
  const photoId = await attach(item);
  const jpegShare = await cli('share', { revision: item.revision, photoId }, ['tests/fixtures/safari-canvas.jpg']);
  assert.equal((await fetch(jpegShare.url + '/photo')).headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(await cli('revoke-share', { id: jpegShare.id }), { revoked: true });
});
