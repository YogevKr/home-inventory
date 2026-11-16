import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const base = process.env.TEST_URL || 'http://127.0.0.1:8787';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error('Tests require a local server.');
const call = async (path, data, method = 'GET') => {
  const response = await fetch(base + path, {
    method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
  });
  return { status: response.status, body: await response.json() };
};

test('wishlist records stay separate until bought and preserve their evidence', async () => {
  const name = `Wishlist ${randomUUID().slice(0, 8)}`;
  const owned = await call('/api/items', { data: { name, priceMinor: 2000, currency: 'USD' } }, 'POST');
  assert.equal(owned.status, 201);
  const baseline = (await call('/api/bootstrap')).body;
  const data = { name, status: 'wishlist', priceMinor: 9900, currency: 'USD', seller: 'Example store', tags: [name], purchaseFor: { kind: 'other', recipient: 'Family' } };
  const created = await call('/api/items', { data }, 'POST');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const wish = created.body;
  const query = `q=${encodeURIComponent(name)}`;
  const listed = await promisify(execFile)(process.execPath, ['scripts/inventory.mjs', 'wishlist', name], {
    env: { ...process.env, INVENTORY_URL: base, CF_ACCESS_CLIENT_ID: 'local-test-client', CF_ACCESS_CLIENT_SECRET: 'local-test-secret' },
  });
  assert.deepEqual(JSON.parse(listed.stdout).items.map(item => item.id), [wish.id]);
  const bootstrap = (await call('/api/bootstrap')).body;
  assert.deepEqual(bootstrap.values, baseline.values, 'expected prices must not inflate purchase value');
  assert.equal(bootstrap.counts.find(row => row.status === 'wishlist').count, (baseline.counts.find(row => row.status === 'wishlist')?.count ?? 0) + 1);
  for (const group of ['none', 'product']) {
    const collection = (await call(`/api/items?${query}&group=${group}`)).body;
    assert.deepEqual(collection.items.map(item => item.id), [owned.body.id]);
    const wishlist = (await call(`/api/items?${query}&group=${group}&status=wishlist`)).body;
    assert.deepEqual(wishlist.items.map(item => item.id), [wish.id]);
  }
  assert.deepEqual((await call(`/api/items/${owned.body.id}/purchases`)).body.map(item => item.id), [owned.body.id]);
  assert.deepEqual((await call(`/api/items/${wish.id}/purchases`)).body.map(item => item.id), [wish.id]);
  assert.equal((await call(`/api/items?${query}&status=inbox`)).body.total, 0);
  assert.equal((await call('/api/items?status=invalid')).status, 400);
  assert.equal((await call('/api/inbox/review', { action: 'keep', items: [{ id: wish.id, revision: wish.revision }] }, 'POST')).status, 409);

  await call(`/api/items/${wish.id}/comments`, { body: 'Wait for the blue model.' }, 'POST');
  const file = new FormData();
  file.set('kind', 'photo');
  file.set('file', new File(['local test image'], 'wishlist.webp', { type: 'image/webp' }));
  const attached = await fetch(`${base}/api/items/${wish.id}/attachments`, { method: 'POST', body: file });
  assert.equal(attached.status, 201);
  const photoId = (await attached.json()).attachments[0].id;
  assert.equal((await call(`/api/items?${query}&status=wishlist&photo=missing`)).body.total, 0);
  const exported = (await call('/api/export')).body;
  assert.equal(JSON.parse(exported.items.find(item => item.id === wish.id).data).status, 'wishlist');
  const preview = await call(`/api/items/${wish.id}/share/preview`, { revision: wish.revision, fields: ['price', 'seller'] }, 'POST');
  assert.equal(preview.status, 200);
  assert.match(preview.body.html, />Price</);
  assert.match(preview.body.html, />Store</);
  assert.doesNotMatch(preview.body.html, /Price paid|Bought from|Wait for the blue model|Family/);

  const bought = await call(`/api/items/${wish.id}`, {
    revision: wish.revision, data: { ...wish.data, status: 'active', priceMinor: 8500, purchaseDate: '2026-11-16' },
  }, 'PUT');
  assert.equal(bought.status, 200);
  assert.equal(bought.body.id, wish.id);
  assert.equal(bought.body.comments[0].body, 'Wait for the blue model.');
  assert.equal(bought.body.attachments[0].id, photoId);
  assert.equal(bought.body.activity[0].before_data, JSON.stringify(wish.data));
  assert.equal((await call(`/api/items?${query}&status=wishlist`)).body.total, 0);
  const purchases = (await call(`/api/items/${wish.id}/purchases`)).body;
  assert.deepEqual(new Set(purchases.map(item => item.id)), new Set([wish.id, owned.body.id]));
  assert.equal((await call(`/api/items?${query}&group=product`)).body.items[0].purchaseCount, 2);
  const currentValue = (await call('/api/bootstrap')).body.values.find(row => row.currency === 'USD').total;
  assert.equal(currentValue, baseline.values.find(row => row.currency === 'USD').total + 8500);
  assert.equal((await call(`/api/items/${wish.id}`, { revision: wish.revision, data: wish.data }, 'PUT')).status, 409);

  const restored = await call(`/api/items/${wish.id}/restore`, { revision: bought.body.revision, eventId: bought.body.activity[0].id }, 'POST');
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.status, 'wishlist');
  assert.equal(restored.body.data.priceMinor, 9900);
  assert.equal(restored.body.attachments[0].id, photoId);
  assert.deepEqual((await call('/api/bootstrap')).body.values, baseline.values);
  assert.equal((await call(`/api/items/${wish.id}`, { revision: restored.body.revision }, 'DELETE')).status, 200);
  assert.equal((await fetch(`${base}/api/files/${photoId}`)).status, 404);
  assert.equal((await call(`/api/items/${owned.body.id}`)).status, 200);
});

test('wishlist filters and price pagination use only wishlist entries', async () => {
  const tag = `Wishlist prices ${randomUUID().slice(0, 8)}`;
  for (const data of [
    { name: 'Wishlist A', status: 'wishlist', priceMinor: 5000 },
    { name: 'Wishlist B', status: 'wishlist', priceMinor: 1500 },
    { name: 'Wishlist C', status: 'wishlist', priceMinor: null },
    { name: 'Owned', status: 'active', priceMinor: 1 },
  ]) assert.equal((await call('/api/items', { data: { ...data, currency: 'USD', tags: [tag] } }, 'POST')).status, 201);
  for (const [direction, names] of [['asc', ['Wishlist B', 'Wishlist A', 'Wishlist C']], ['desc', ['Wishlist A', 'Wishlist B', 'Wishlist C']]]) {
    const actual = [];
    for (let offset = 0; offset < 3; offset++) {
      const page = await call(`/api/items?status=wishlist&tag=${encodeURIComponent(tag)}&group=product&sort=price&direction=${direction}&limit=1&offset=${offset}`);
      assert.equal(page.status, 200);
      assert.equal(page.body.total, 3);
      actual.push(page.body.items[0].data.name);
    }
    assert.deepEqual(actual, names);
  }
});
