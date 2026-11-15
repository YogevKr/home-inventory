import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

const exec = promisify(execFile);
const cli = (origin, command = 'help') => exec(process.execPath, ['scripts/inventory.mjs', command], {
  env: { ...process.env, INVENTORY_URL: origin, CF_ACCESS_CLIENT_ID: 'test-client', CF_ACCESS_CLIENT_SECRET: 'test-secret' },
});

test('CLI accepts an owner HTTPS origin and explicit localhost', async () => {
  for (const origin of ['https://inventory.example.org', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    assert.match((await cli(origin)).stdout, /Usage:/);
  }
});

test('CLI rejects missing origins, remote HTTP, and URLs with embedded data', async () => {
  for (const origin of ['', 'http://inventory.example.org', 'https://user:pass@inventory.example.org',
    'https://inventory.example.org/api', 'https://inventory.example.org/?token=sample', 'https://inventory.example.org/#fragment']) {
    await assert.rejects(cli(origin), error => {
      assert.match(error.stderr, /INVENTORY_URL/);
      return true;
    });
  }
});

test('CLI stops at a redirect instead of forwarding service credentials', async t => {
  let redirected = false;
  const server = createServer((request, response) => {
    if (request.url === '/api/items?q=&limit=200') {
      assert.equal(request.headers['cf-access-client-id'], 'test-client');
      response.writeHead(302, { Location: '/redirect-target' }).end();
    } else {
      redirected = true;
      response.writeHead(200).end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(cli(`http://127.0.0.1:${server.address().port}`, 'list'), /HTTP 302/);
  assert.equal(redirected, false);
});
