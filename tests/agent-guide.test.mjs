import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import worker from '../src/index.ts';

const base = process.env.TEST_URL || 'http://127.0.0.1:8787';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error('Tests require a local server.');
const paths = ['/llms.txt', '/llm.txt', '/llms-full.txt'];

test('only exact documentation paths bypass Worker authentication', async () => {
  const assets = [];
  const env = {
    DEV_AUTH: 'false', AUTH_ISSUER: '', AUTH_AUDIENCE: '',
    ASSETS: { fetch: async request => {
      const pathname = new URL(request.url).pathname;
      assets.push(pathname);
      assert.ok(['/llms.txt', '/llms-full.txt'].includes(pathname));
      assert.equal(request.headers.has('CF-Access-Client-Secret'), false);
      return new Response(await readFile(new URL('../public' + pathname, import.meta.url)));
    } },
  };
  for (const path of paths) {
    const response = await worker.fetch(new Request('https://inventory.example.com' + path), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await response.text(), /^# /);
    const head = await worker.fetch(new Request('https://inventory.example.com' + path, { method: 'HEAD' }), env);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const denied = await worker.fetch(new Request('https://inventory.example.com' + path, { method }), env);
      assert.equal(denied.status, 405);
      assert.equal(denied.headers.get('allow'), 'GET, HEAD');
    }
  }
  const reads = assets.length;
  for (const path of ['/', '/app.js', '/api/bootstrap', '/api/export', '/api/items', '/api/files/example', '/llms.txt/private', '/llms.txt/', '/llms.txt.bak', '/llms-full.txt/private']) {
    assert.equal((await worker.fetch(new Request('https://inventory.example.com' + path), env)).status, 401, path);
  }
  assert.equal(assets.length, reads);
});

test('served agent documents use plain text and match their source files', async () => {
  for (const path of paths) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    const file = path === '/llms-full.txt' ? '../docs/API.md' : '../public/llms.txt';
    assert.equal(await response.text(), await readFile(new URL(file, import.meta.url), 'utf8'));
    assert.equal(await (await fetch(base + path, { method: 'HEAD' })).text(), '');
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 405);
  }
});

test('quick-start JSON examples create a wishlist item and record its price', async () => {
  const guide = await readFile(new URL('../public/llms.txt', import.meta.url), 'utf8');
  const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  const item = { ...examples[0], id: randomUUID() };
  const send = (path, method, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const created = await send('/api/items', 'POST', item);
  assert.equal(created.status, 201);
  const record = await created.json();
  try {
    assert.equal(record.data.status, 'wishlist');
    assert.equal((await send('/api/items', 'POST', item)).status, 200);
    const price = { ...examples[2], id: randomUUID(), revision: record.revision };
    const response = await send(`/api/items/${record.id}/prices`, 'POST', price);
    assert.equal(response.status, 200);
    const history = await response.json();
    assert.equal(history.observations[0].price_minor, price.priceMinor);
    assert.equal(history.observations[0].method, 'recorded');
    assert.equal(history.count, 1);
    assert.equal((await (await fetch(`${base}/api/items/${record.id}`)).json()).data.priceMinor, item.data.priceMinor);
  } finally {
    assert.equal((await send(`/api/items/${record.id}`, 'DELETE', { revision: record.revision })).status, 200);
  }
});
