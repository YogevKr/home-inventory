import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.TEST_URL || 'http://127.0.0.1:8787';
async function call(path, body) {
  const response = await fetch(base + path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {});
  assert.equal(response.ok, true, `HTTP ${response.status}`);
  return response.json();
}

test('price sorting compares USD values across currencies before grouping and pagination', async () => {
  const tag = `price-${randomUUID().slice(0, 8)}`;
  const entries = [
    { name: 'Dollar purchase', priceMinor: 10000, currency: 'USD' },
    { name: 'Shekel purchase', priceMinor: 5000, currency: 'ILS' },
    { name: 'Euro purchase', priceMinor: 1000, currency: 'EUR' },
    { name: 'Pound purchase', priceMinor: 2000, currency: 'GBP' },
    { name: 'Free purchase', priceMinor: 0, currency: 'USD' },
    { name: 'Unknown price', priceMinor: null, currency: 'EUR' },
    { name: 'Repeated purchase', priceMinor: 6000, currency: 'ILS', productUrl: 'https://amazon.com/dp/B444444444' },
    { name: 'Repeated purchase', priceMinor: 1000, currency: 'USD', productUrl: 'https://amazon.com/dp/B444444444' },
  ];
  const records = [];
  for (const data of entries) records.push(await call('/api/items', { data: { ...data, tags: [tag] } }));
  for (const group of ['none', 'product']) {
    const ascending = group === 'product' ? [4, 7, 2, 1, 3, 0, 5] : [4, 7, 2, 1, 6, 3, 0, 5];
    const descending = group === 'product' ? [0, 3, 6, 1, 2, 4, 5] : [0, 3, 6, 1, 2, 7, 4, 5];
    for (const [direction, indices] of [['asc', ascending], ['desc', descending]]) {
      const actual = [];
      for (let offset = 0; offset < indices.length; offset += 2) {
        const query = new URLSearchParams({ tag, sort: 'price', direction, group, limit: '2', offset: String(offset) });
        const page = await call(`/api/items?${query}`);
        assert.equal(page.total, indices.length);
        assert.equal(page.priceReference.currency, 'USD');
        assert.match(page.priceReference.date, /^\d{4}-\d{2}-\d{2}$/);
        for (const item of page.items) assert.equal(item.sortPriceMinor, item.data.priceMinor === null ? null : Math.round(item.data.priceMinor / page.priceReference.rates[item.data.currency]));
        actual.push(...page.items);
      }
      assert.deepEqual(actual.map(item => item.id), indices.map(index => records[index].id), `${group} ${direction}`);
      assert.equal(new Set(actual.map(item => item.id)).size, actual.length);
    }
  }
  for (const record of records) {
    const unchanged = await call(`/api/items/${record.id}`);
    assert.deepEqual(unchanged.data, record.data);
    assert.equal(unchanged.revision, record.revision);
  }
});
