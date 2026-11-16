import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { brightDataTarget, brightDataPrice, readBrightDataPrice } from '../src/bright-data.ts';
import { priceSourceLabel } from '../public/price-tracking.js';
import worker from '../src/index.ts';

const amazon = JSON.parse(await readFile(new URL('./fixtures/bright-data-amazon.json', import.meta.url)));
const iherb = JSON.parse(await readFile(new URL('./fixtures/bright-data-iherb.json', import.meta.url)));
const url = 'https://www.amazon.com/dp/B0CWLHSKYC';
const settings = { BRIGHT_DATA_API_KEY: 'test-key' };
const target = brightDataTarget(url, 'USD', settings);
const iherbTarget = brightDataTarget(iherb.url, 'USD', settings);

test('uses the verified regular Amazon offer instead of the Prime member price', () => {
  const price = brightDataPrice([amazon], target);
  assert.equal(price.priceMinor, 15999);
  assert.equal(price.currency, 'USD');
  assert.deepEqual(price.source, { provider: 'brightdata', market: 'US', postalCode: '10001', offer: 'regular', seller: 'AqaraDirect' });
  assert.equal(priceSourceLabel({ source: price.source }), 'Bright Data · US 10001 · Regular price · AqaraDirect');
  assert.equal(brightDataPrice([{ ...amazon, buying_option_type: 'NEW', final_price: 119.99 }], target).priceMinor, 11999);
  for (const change of [
    { asin: 'B000000000' }, { url: 'https://www.amazon.com/dp/B000000000' },
    { url: 'https://www.amazon.com.evil.example/dp/B0CWLHSKYC' },
    { currency: 'EUR' }, { zipcode: '90210' }, { is_available: false },
    { all_inactive_buy_box: [] }, { all_inactive_buy_box: [...amazon.all_inactive_buy_box, ...amazon.all_inactive_buy_box] },
    { buying_option_type: 'USED', all_inactive_buy_box: [] },
    { buying_option_type: 'SUBSCRIBE_AND_SAVE', all_inactive_buy_box: [] },
    ...[0, -1, 1.234, '1,23', '$1e3', '€129.99'].map(final_price => ({ buying_option_type: 'NEW', final_price })),
  ]) assert.throws(() => brightDataPrice([{ ...amazon, ...change }], target), JSON.stringify(change));
  assert.throws(() => brightDataPrice([amazon, amazon], target));
  assert.throws(() => brightDataPrice([{ error: 'Blocked' }], target));
});

test('requires the exact in-stock iHerb variant and a US dollar context', () => {
  assert.throws(() => brightDataPrice([iherb], iherbTarget), error => error.code === 'offer_unavailable');
  const available = { ...iherb, availability: 'in_stock' };
  const price = brightDataPrice([available], iherbTarget);
  assert.equal(price.priceMinor, 1009);
  assert.equal(price.source.postalCode, null);
  assert.equal(brightDataPrice([{ ...available, sale_price: '$5.00' }], iherbTarget).priceMinor, 1009);
  for (const change of [{ variant_id: '99' }, { item_id: '99' }, { store_country: 'CA' }, { currency: 'CAD' }, { price: '€10.09' }, { price: 10.09 }, { availability: 'unknown' }]) {
    assert.throws(() => brightDataPrice([{ ...available, ...change }], iherbTarget));
  }
});

test('only routes supported USD product links through the provider', () => {
  assert.equal(brightDataTarget(url, 'USD', {}), null);
  assert.equal(brightDataTarget(url, 'EUR', settings), null);
  assert.equal(brightDataTarget('https://www.amazon.co.uk/dp/B0CWLHSKYC', 'GBP', settings), null);
  assert.equal(brightDataTarget('https://www.aliexpress.com/item/100500.html', 'USD', settings), null);
  assert.equal(brightDataTarget('https://il.iherb.com/pr/example/123', 'USD', settings), null);
  assert.deepEqual(brightDataTarget(url + '?tag=tracking&th=1', 'USD', settings), target);
  assert.equal(brightDataTarget('https://amazon.com/gp/product/B0CWLHSKYC', 'USD', settings).asin, target.asin);
  for (const link of ['http://www.amazon.com/dp/B0CWLHSKYC', 'https://user:password@amazon.com/dp/B0CWLHSKYC', url + '?smid=another-seller', url + '?variant=red', url + '?currency=EUR', 'https://amazon.com/s?k=hub']) {
    assert.throws(() => brightDataTarget(link, 'USD', settings));
  }
  assert.throws(() => brightDataTarget(url, 'USD', { ...settings, BRIGHT_DATA_AMAZON_ZIPCODE: 'invalid' }));
});

test('keeps the key on the provider endpoint and bounds failure responses', async () => {
  let requests = 0;
  const fetchProvider = async (address, options) => {
    requests++;
    assert.equal(new URL(address).origin, 'https://api.brightdata.com');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(options.body), { input: [{ url, asin: 'B0CWLHSKYC', zipcode: '10001', language: '' }], limit_per_input: 1 });
    return Response.json([amazon]);
  };
  assert.equal((await readBrightDataPrice(target, 'test-key', fetchProvider)).priceMinor, 15999);
  assert.equal(requests, 1);
  for (const [status, code] of [[401, 'provider_auth'], [403, 'provider_auth'], [402, 'provider_limit'], [429, 'provider_limit'], [202, 'provider_pending'], [302, 'provider_unavailable'], [500, 'provider_unavailable']]) {
    await assert.rejects(readBrightDataPrice(target, 'test-key', async () => new Response('test-key sensitive upstream error', { status })), error => error.code === code && !error.message.includes('test-key'));
  }
  await assert.rejects(readBrightDataPrice(target, 'test-key', async () => new Response('x'.repeat(1_000_001))), error => error.code === 'provider_unavailable');
  await assert.rejects(readBrightDataPrice(target, 'test-key', async () => { throw new Error('test-key'); }), error => !error.message.includes('test-key'));
});

test('API saves provider metadata, preserves history on failure, and enforces request limits atomically', async t => {
  const mf = new Miniflare({ workers: [{ config: {
    name: 'price-provider-test', compatibilityDate: '2026-11-15', env: { DB: { type: 'd1', id: 'provider-test' } },
    manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("OK"); } }' } } },
  } }] });
  try {
    const DB = await mf.getD1Database('DB');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(file, migrations), 'utf8');
      await DB.batch(unstable_splitSqlQuery(sql).map(statement => DB.prepare(statement)));
    }
    const env = { DB, ...settings, BRIGHT_DATA_DAILY_LIMIT: '2', DEV_AUTH: 'true', AUTH_ISSUER: '', AUTH_AUDIENCE: '' };
    const call = async (path, data, method = 'GET') => {
      const response = await worker.fetch(new Request('http://localhost' + path, { method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) }), env);
      return { status: response.status, body: await response.json() };
    };
    let calls = 0;
    let providerStatus = 200;
    let duringFetch = async () => {};
    t.mock.method(globalThis, 'fetch', async () => { calls++; await duringFetch(); return Response.json(providerStatus === 200 ? [amazon] : { error: 'test-key' }, { status: providerStatus }); });
    const item = (await call('/api/items', { data: { name: 'Provider fixture', status: 'wishlist', currency: 'USD', priceMinor: 12999, productUrl: url } }, 'POST')).body;
    const path = `/api/items/${item.id}`;
    const body = { revision: item.revision };
    const recorded = await call(path + '/prices', { ...body, priceMinor: 12999, currency: 'USD', productUrl: url }, 'POST');
    assert.equal(recorded.status, 200);
    const results = await Promise.all([call(path + '/prices/check', body, 'POST'), call(path + '/prices/check', body, 'POST')]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 429]);
    assert.equal(calls, 1);
    let history = (await call(path + '/prices')).body;
    assert.equal(history.provider, 'brightdata');
    assert.equal(history.market, 'US · ZIP 10001');
    assert.equal(history.count, 2);
    assert.equal(history.observations[0].price_minor, 15999);
    assert.equal(history.observations[0].source.provider, 'brightdata');
    assert.equal(history.observations[1].source, null);
    assert.equal(history.lastCheck.error, null);
    assert.equal((await call(path)).body.data.priceMinor, 12999);
    assert.equal((await call(path)).body.revision, item.revision);
    const exported = (await call('/api/export')).body;
    assert.equal(JSON.parse(exported.priceObservations.find(row => row.source).source).offer, 'regular');
    await DB.prepare("UPDATE price_checks SET checked_at='2000-01-01'").run();
    providerStatus = 401;
    const failed = await call(path + '/prices/check', body, 'POST');
    assert.equal(failed.status, 503);
    assert.equal(failed.body.code, 'provider_auth');
    history = (await call(path + '/prices')).body;
    assert.equal(history.count, 2);
    assert.match(history.lastCheck.error, /API key/);
    assert.equal(JSON.stringify(history).includes('test-key'), false);
    await DB.prepare("UPDATE price_checks SET checked_at='2000-01-01'").run();
    assert.equal((await call(path + '/prices/check', body, 'POST')).body.code, 'provider_budget');
    assert.equal(calls, 2);
    const another = (await call('/api/items', { data: { name: randomUUID(), status: 'wishlist', currency: 'USD', productUrl: url } }, 'POST')).body;
    assert.equal((await call(`/api/items/${another.id}/prices/check`, { revision: another.revision }, 'POST')).body.code, 'provider_budget');
    assert.equal(calls, 2, 'budget covers all items');
    env.BRIGHT_DATA_DAILY_LIMIT = '3';
    providerStatus = 200;
    await DB.prepare("UPDATE price_checks SET checked_at='2000-01-01'").run();
    duringFetch = () => DB.prepare("UPDATE items SET data=json_set(data,'$.status','active'),revision=revision+1 WHERE id=?").bind(another.id).run();
    assert.equal((await call(`/api/items/${another.id}/prices/check`, { revision: another.revision }, 'POST')).status, 409);
    assert.equal((await call(`/api/items/${another.id}/prices`)).body.count, 0, 'buying an item during a check cannot save a stale price');
    assert.equal(calls, 3);
    assert.equal((await call(path, body, 'DELETE')).status, 200);
    assert.equal((await call('/api/export')).body.priceObservations.length, 0);
  } finally { await mf.dispose(); }
});
