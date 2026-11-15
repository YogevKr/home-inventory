import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeployment, localDatabaseId } from '../config/deployment.ts';

const settings = {
  accountId: '1'.repeat(32), workerName: 'test-inventory', databaseName: 'test-inventory',
  databaseId: '11111111-1111-4111-8111-111111111111', bucketName: 'test-inventory-files',
  hostname: 'inventory.example.org', accessIssuer: 'https://test-team.cloudflareaccess.com', accessAudience: '2'.repeat(64),
};

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('development works without owner settings and ignores a deployment file', async t => {
  const directory = await workspace(t);
  const local = loadDeployment('development', directory);
  assert.equal(local.databaseId, localDatabaseId);
  assert.equal(local.accountId, undefined);
  assert.equal(local.hostname, '');
  await writeFile(join(directory, 'deployment.local.json'), JSON.stringify(settings));
  assert.deepEqual(loadDeployment('development', directory), local);
});

test('production requires owner settings, including default and custom build modes', async t => {
  const directory = await workspace(t);
  for (const mode of [undefined, 'production', 'staging']) {
    assert.throws(() => loadDeployment(mode, directory), /Create deployment.local.json/);
  }
  await writeFile(join(directory, 'deployment.local.json'), JSON.stringify(settings));
  assert.deepEqual(loadDeployment('production', directory), settings);
});

test('production rejects the setup example and the local database ID', async t => {
  const directory = await workspace(t);
  const file = join(directory, 'deployment.local.json');
  await writeFile(file, await readFile(new URL('../deployment.example.json', import.meta.url)));
  assert.throws(() => loadDeployment('production', directory), /Invalid deployment.local.json/);
  await writeFile(file, JSON.stringify({ ...settings, databaseId: localDatabaseId }));
  assert.throws(() => loadDeployment('production', directory), /databaseId/);
});

test('production rejects invalid Access settings without printing their values', async t => {
  const directory = await workspace(t);
  const file = join(directory, 'deployment.local.json');
  for (const invalid of [{ accessIssuer: 'http://team.cloudflareaccess.com' }, { accessAudience: 'private-invalid-value' }]) {
    await writeFile(file, JSON.stringify({ ...settings, ...invalid }));
    assert.throws(() => loadDeployment('production', directory), error => {
      assert.match(error.message, /Invalid deployment.local.json/);
      assert.ok(!error.message.includes(Object.values(invalid)[0]));
      return true;
    });
  }
});
