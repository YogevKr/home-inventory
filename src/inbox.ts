import { z } from 'zod';
import { itemId } from './domain.ts';

const purchases = z.array(z.object({ id: itemId, revision: z.number().int().positive() }).strict())
  .min(1).max(200).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Send each purchase once.');

export const inboxReview = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep'), items: purchases }).strict(),
  z.object({ action: z.literal('archive'), items: purchases }).strict(),
  z.object({ action: z.literal('undo'), from: z.enum(['active', 'archived']), items: purchases }).strict(),
]);

export async function reviewInbox(db: D1Database, input: z.infer<typeof inboxReview>, actor: string) {
  const from = input.action === 'undo' ? input.from : 'inbox';
  const status = input.action === 'undo' ? 'inbox' : input.action === 'keep' ? 'active' : 'archived';
  const action = { keep: 'Kept inbox item', archive: 'Archived inbox item', undo: 'Undid inbox review' }[input.action];
  const result = await db.prepare(`
    WITH requested AS MATERIALIZED (
      SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.revision') AS revision FROM json_each(?)
    ), eligible AS MATERIALIZED (
      SELECT i.id FROM items i JOIN requested r ON i.id=r.id AND i.revision=r.revision WHERE i.status=?
    )
    UPDATE items SET data=json_set(data,'$.status',?), revision=revision+1, updated_by=?, action=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id IN (SELECT id FROM eligible) AND (SELECT COUNT(*) FROM eligible)=?
    RETURNING id,revision
  `).bind(JSON.stringify(input.items), from, status, actor, action, input.items.length).all<{ id: string; revision: number }>();
  return { status, items: result.results };
}
