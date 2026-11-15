import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.TEST_URL || 'http://127.0.0.1:8787';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error('Tests require a local server.');
const request = async (path, body, method = 'GET') => {
  const response = await fetch(base + path, {
    method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};
const create = async (data = {}) => {
  const result = await request('/api/items', { data: { name: `Inbox ${randomUUID()}`, status: 'inbox', ...data } }, 'POST');
  assert.equal(result.status, 201);
  return result.body;
};
const revisions = items => items.map(({ id, revision }) => ({ id, revision }));
const review = body => request('/api/inbox/review', body, 'POST');
const read = async item => (await request(`/api/items/${item.id}`)).body;

test('inbox decisions keep grouped purchases, preserve details, and undo without removing records', async () => {
  const name = `Review group ${randomUUID().slice(0, 8)}`;
  const first = await create({ name, purchaseFor: { kind: 'other', recipient: 'Family' }, priceMinor: 1200, tags: [name] });
  const second = await create({ name, priceMinor: 1500, tags: [name] });
  const outside = await create({ name, status: 'active', tags: [name] });
  await request(`/api/items/${first.id}/comments`, { body: 'Keep this note.' }, 'POST');
  const form = new FormData();
  form.set('kind', 'receipt');
  form.set('file', new File(['purchase evidence'], 'receipt.txt', { type: 'text/plain' }));
  assert.equal((await fetch(`${base}/api/items/${first.id}/attachments`, { method: 'POST', body: form })).status, 201);
  const before = await read(first);
  const group = (await request(`/api/items?status=inbox&group=product&tag=${encodeURIComponent(name)}`)).body.items[0];
  assert.equal(group.purchaseCount, 2);
  assert.deepEqual(revisions(group.purchases).sort((a, b) => a.id.localeCompare(b.id)), revisions([first, second]).sort((a, b) => a.id.localeCompare(b.id)));
  const kept = await review({ action: 'keep', items: revisions(group.purchases) });
  assert.equal(kept.status, 200);
  assert.equal(kept.body.status, 'active');
  assert.equal(kept.body.items.length, 2);
  for (const item of [first, second]) {
    const saved = await read(item);
    assert.deepEqual(saved.data, { ...item.data, status: 'active' });
    assert.equal(saved.revision, item.revision + 1);
  }
  assert.deepEqual(await read(outside), outside);
  assert.equal((await request(`/api/items?status=inbox&tag=${encodeURIComponent(name)}`)).body.total, 0);
  const undo = await review({ action: 'undo', from: 'active', items: kept.body.items });
  assert.equal(undo.status, 200);
  const restored = await read(first);
  assert.deepEqual(restored.data, before.data);
  assert.deepEqual(restored.attachments, before.attachments);
  assert.deepEqual(restored.comments, before.comments);
  assert.equal(restored.activity[0].action, 'Undid inbox review');
  assert.equal((await read(second)).data.status, 'inbox');
});

test('inbox review rejects stale groups atomically and protects newer edits during undo', async () => {
  const first = await create();
  const second = await create();
  const newer = (await request(`/api/items/${second.id}`, {
    revision: second.revision, data: { ...second.data, description: 'A newer edit' },
  }, 'PUT')).body;
  const failed = await review({ action: 'archive', items: revisions([first, second]) });
  assert.equal(failed.status, 409);
  assert.deepEqual(await read(first), first);
  assert.deepEqual(await read(second), newer);
  const archived = await review({ action: 'archive', items: revisions([first, newer]) });
  assert.equal(archived.status, 200);
  const current = await read(second);
  const changed = (await request(`/api/items/${second.id}`, {
    revision: current.revision, data: { ...current.data, description: 'Edited after archive' },
  }, 'PUT')).body;
  const firstArchived = await read(first);
  assert.equal((await review({ action: 'undo', from: 'archived', items: archived.body.items })).status, 409);
  assert.deepEqual(await read(first), firstArchived);
  assert.deepEqual(await read(second), changed);
  const undone = await review({ action: 'undo', from: 'archived', items: revisions([firstArchived, changed]) });
  assert.equal(undone.status, 200);
  assert.equal((await read(second)).data.description, 'Edited after archive');
});

test('inbox review rejects invalid, missing, duplicate, and non-inbox targets without partial changes', async () => {
  const inbox = await create();
  const active = await create({ status: 'active' });
  const lent = await create({ status: 'lent' });
  for (const items of [revisions([inbox, active]), revisions([inbox, lent]), [...revisions([inbox]), { id: randomUUID(), revision: 1 }]]) {
    assert.equal((await review({ action: 'keep', items })).status, 409);
  }
  for (const body of [
    { action: 'keep', items: [] },
    { action: 'keep', items: revisions([inbox, inbox]) },
    { action: 'delete', items: revisions([inbox]) },
    { action: 'undo', from: 'lent', items: revisions([lent]) },
    { action: 'undo', items: revisions([inbox]) },
    { action: 'archive', items: [{ id: inbox.id, revision: 0 }] },
  ]) assert.equal((await review(body)).status, 400);
  assert.deepEqual(await read(inbox), inbox);
  assert.deepEqual(await read(active), active);
  assert.deepEqual(await read(lent), lent);
});
