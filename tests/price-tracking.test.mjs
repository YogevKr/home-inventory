import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checkableUrl, structuredPrice, readPrice } from '../src/price-reader.ts';

const base = process.env.TEST_URL || 'http://127.0.0.1:8787';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error('Tests require a local server.');
const call = async (path, data, method = 'GET') => {
  const response = await fetch(base + path, { method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
  return { status: response.status, body: await response.json() };
};
const url = 'https://www.iherb.com/pr/example/123?variant=blue';
const offer = { '@type': 'Offer', price: '99.95', priceCurrency: 'USD', url, availability: 'https://schema.org/InStock' };
const product = { '@type': 'Product', name: 'Example', offers: offer };
const html = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

test('reads an exact product offer and preserves cents', () => {
  assert.deepEqual(structuredPrice(html(product), url, 'USD'), { priceMinor: 9995, currency: 'USD' });
  assert.equal(structuredPrice(html({ '@graph': [{ '@type': 'ProductGroup', hasVariant: [product] }] }), url, 'USD').priceMinor, 9995);
  assert.equal(structuredPrice(html({ ...product, offers: { ...offer, price: 19.99 } }), url, 'USD').priceMinor, 1999);
  assert.equal(structuredPrice(html({ ...product, url, offers: { ...offer, url: undefined } }), url, 'USD').priceMinor, 9995);
});

test('rejects ambiguous, unrelated, expired, unavailable, and mismatched offers', () => {
  for (const value of [
    { ...product, offers: [offer, { ...offer, price: 70 }] },
    { ...product, offers: { ...offer, '@type': 'AggregateOffer', lowPrice: 60, highPrice: 100 } },
    { ...product, offers: { ...offer, url: url.replace('blue', 'red') } },
    { ...product, url: 'https://www.iherb.com/pr/another/456' },
    { ...product, offers: { ...offer, url: undefined } },
    { ...product, offers: { ...offer, priceCurrency: 'EUR' } },
    { ...product, offers: { ...offer, availability: 'https://schema.org/OutOfStock' } },
    { ...product, offers: { ...offer, itemCondition: 'https://schema.org/UsedCondition' } },
    { ...product, offers: { ...offer, priceValidUntil: '2020-01-01' } },
    { ...product, offers: { ...offer, priceValidUntil: 'unknown' } },
    { ...product, offers: { ...offer, validFrom: '2999-01-01' } },
    { ...product, offers: { ...offer, price: '1,234.50' } },
    { ...product, offers: { ...offer, price: '0' } },
    { ...product, offers: { ...offer, price: 1.234 } },
    { ...product, offers: { ...offer, price: -10 } },
    { '@type': 'ItemList', itemListElement: [product] },
  ]) assert.throws(() => structuredPrice(html(value), url, 'USD'));
  assert.throws(() => structuredPrice('<html>Login required. $9.99</html>', url, 'USD'));
  assert.throws(() => structuredPrice('<script type="application/ld+json">broken</script>', url, 'USD'));
});

test('direct requests cannot use private addresses or arbitrary redirects', async () => {
  for (const target of ['http://www.iherb.com/pr/1', 'https://127.0.0.1', 'https://[::1]', 'https://2130706433', 'https://localhost', 'https://metadata.google.internal', 'https://www.iherb.com.evil.example/pr/1', 'https://user:pass@www.iherb.com/pr/1', 'https://www.iherb.com:8443/pr/1', 'https://www.iherb.com/pr/1#x']) {
    assert.throws(() => checkableUrl(target), target);
  }
  assert.equal(checkableUrl('https://store.example.com/p', 'store.example.com').hostname, 'store.example.com');
  const requested = [];
  const redirect = async value => { requested.push(String(value)); return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } }); };
  await assert.rejects(readPrice(url, 'USD', '', redirect));
  assert.deepEqual(requested, [url]);
  await assert.rejects(readPrice(url, 'USD', '', async () => new Response(null, { status: 302, headers: { location: '/login' } })), /another page/);
});

test('fetch failures cannot create a false price', async () => {
  const page = body => new Response(body, { headers: { 'Content-Type': 'text/html' } });
  assert.equal((await readPrice(url, 'USD', '', async () => page(html(product)))).priceMinor, 9995);
  await assert.rejects(readPrice(url, 'USD', '', async () => new Response('Blocked', { status: 403 })), /blocked/);
  await assert.rejects(readPrice(url, 'USD', '', async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })), /product page/);
  await assert.rejects(readPrice(url, 'USD', '', async () => { throw new Error('Network unavailable'); }), /did not respond/);
  await assert.rejects(readPrice(url, 'USD', '', async () => page('x'.repeat(2_000_001))), /too large/);
});

test('price history supports retries, source isolation, export, purchase, and deletion', async () => {
  const created = await call('/api/items', { data: { name: 'Price tracker ' + randomUUID(), status: 'wishlist', priceMinor: 12000, currency: 'USD', productUrl: 'https://store.example.com/lamp' } }, 'POST');
  assert.equal(created.status, 201);
  let item = created.body;
  const path = `/api/items/${item.id}`;
  const first = { id: randomUUID(), revision: item.revision, priceMinor: 10000, currency: 'USD', productUrl: item.data.productUrl };
  const baseline = (await call('/api/bootstrap')).body.values;
  let result = await call(path + '/prices', first, 'POST');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.count, 1);
  assert.equal(result.body.lowest, 10000);
  assert.equal(result.body.supported, false);
  assert.equal(result.body.observations[0].method, 'recorded');
  assert.equal((await call(path + '/prices', first, 'POST')).body.count, 1);
  assert.equal((await call(path + '/prices', { ...first, priceMinor: 9000 }, 'POST')).status, 409);
  assert.equal((await call(path + '/prices', { ...first, id: randomUUID(), revision: item.revision + 1 }, 'POST')).status, 409);
  assert.equal((await call(path + '/prices', { ...first, id: randomUUID(), currency: 'EUR' }, 'POST')).status, 409);
  assert.equal((await call(path + '/prices', { ...first, id: randomUUID(), productUrl: 'https://store.example.com/other' }, 'POST')).status, 409);
  assert.equal((await call(path + '/prices', { ...first, id: randomUUID(), priceMinor: 0 }, 'POST')).status, 400);
  assert.equal((await call(path + '/prices/check', { revision: item.revision }, 'POST')).status, 422);
  assert.equal((await call(path + '/prices')).body.count, 1);
  result = await call(path + '/prices', { ...first, id: randomUUID(), priceMinor: 8500 }, 'POST');
  assert.equal(result.body.count, 2);
  assert.equal(result.body.lowest, 8500);
  assert.equal(result.body.observations[0].price_minor, 8500);
  assert.equal(result.body.observations[1].price_minor, 10000);
  const unchanged = (await call(path)).body;
  assert.equal(unchanged.revision, item.revision);
  assert.equal(unchanged.data.priceMinor, 12000);
  assert.deepEqual((await call('/api/bootstrap')).body.values, baseline);
  item = (await call(path, { revision: item.revision, data: { ...item.data, productUrl: 'https://store.example.com/second-lamp' } }, 'PUT')).body;
  assert.equal(item.priceTracking.count, 0, 'another product link starts its own series');
  item = (await call(path, { revision: item.revision, data: { ...item.data, productUrl: first.productUrl, currency: 'EUR' } }, 'PUT')).body;
  assert.equal(item.priceTracking.count, 0, 'another currency starts its own series');
  item = (await call(path, { revision: item.revision, data: { ...item.data, currency: 'USD', status: 'active', priceMinor: 8000 } }, 'PUT')).body;
  assert.equal(item.priceTracking.count, 2);
  assert.equal(item.data.priceMinor, 8000);
  assert.equal((await call(path + '/prices', { ...first, id: randomUUID(), revision: item.revision }, 'POST')).status, 409);
  assert.equal((await call(path + '/prices/check', { revision: item.revision }, 'POST')).status, 409);
  const exported = (await call('/api/export')).body;
  assert.equal(exported.priceObservations.filter(row => row.item_id === item.id).length, 2);
  assert.equal((await call(path, { revision: item.revision - 1 }, 'DELETE')).status, 409);
  assert.equal((await call(path + '/prices')).body.count, 2);
  assert.equal((await call(path, { revision: item.revision }, 'DELETE')).status, 200);
  assert.equal((await call(path + '/prices')).status, 404);
  assert.equal((await call('/api/export')).body.priceObservations.filter(row => row.item_id === item.id).length, 0);
});
