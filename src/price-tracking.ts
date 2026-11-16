import { z } from 'zod';
import { itemRow, itemData, type ItemId } from './domain.ts';
import { checkableUrl, PriceError, readPrice } from './price-reader.ts';

export interface PriceEnv { DB: D1Database; PRICE_CHECK_HOSTS?: string }
const checkInput = z.object({ revision: z.number().int().positive() }).strict();
const recordInput = checkInput.extend({
  id: z.uuid().optional(),
  priceMinor: z.number().int().positive().max(1_000_000_000_000),
  currency: itemData.shape.currency.removeDefault(),
  productUrl: z.url().max(4000).refine(value => /^https?:\/\//i.test(value)),
}).strict();
const observation = z.object({
  id: z.uuid(), item_id: z.string(), product_url: z.string(), price_minor: z.number(), currency: z.string(),
  method: z.enum(['page', 'recorded']), actor: z.string(), observed_at: z.string(),
});
const lastCheck = z.object({ checked_at: z.string(), error: z.string().nullable() });
const stats = z.object({ count: z.number(), lowest: z.number().nullable() });

export async function priceTracking(env: PriceEnv, item: z.infer<typeof itemRow>) {
  const { productUrl, currency } = item.data;
  const [history, totals, checked] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM price_observations WHERE item_id=? AND product_url=? AND currency=? ORDER BY sequence DESC LIMIT 100').bind(item.id, productUrl, currency),
    env.DB.prepare('SELECT COUNT(*) AS count,MIN(price_minor) AS lowest FROM price_observations WHERE item_id=? AND product_url=? AND currency=?').bind(item.id, productUrl, currency),
    env.DB.prepare('SELECT checked_at,error FROM price_checks WHERE item_id=? AND product_url=? AND currency=?').bind(item.id, productUrl, currency),
  ]);
  let reason: string | null = null;
  try { checkableUrl(productUrl, env.PRICE_CHECK_HOSTS); } catch (error) { if (error instanceof PriceError) reason = error.message; else throw error; }
  return {
    supported: reason === null, reason,
    observations: z.array(observation).parse(history?.results),
    ...stats.parse(totals?.results[0]),
    lastCheck: checked?.results[0] ? lastCheck.parse(checked.results[0]) : null,
  };
}

async function wishlistItem(env: PriceEnv, id: ItemId, revision: number) {
  const row = await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(id).first();
  if (!row) throw new PriceError(404, 'Item not found.');
  const item = itemRow.parse(row);
  if (item.revision !== revision) throw new PriceError(409, 'This item changed. Reload it before recording a price.');
  if (item.data.status !== 'wishlist') throw new PriceError(409, 'Record prices only for wishlist items.');
  if (!item.data.productUrl) throw new PriceError(400, 'Add a product link before recording its price.');
  return item;
}

async function savePrice(env: PriceEnv, item: z.infer<typeof itemRow>, value: { id: string; priceMinor: number; currency: string }, method: 'page' | 'recorded', actor: string) {
  const result = await env.DB.prepare(`INSERT INTO price_observations(id,item_id,product_url,price_minor,currency,method,actor)
    SELECT ?,id,?,?,?, ?,? FROM items WHERE id=? AND revision=? AND status='wishlist'
    ON CONFLICT(id) DO NOTHING`).bind(value.id, item.data.productUrl, value.priceMinor, value.currency, method, actor, item.id, item.revision).run();
  if (!result.meta.changes) {
    const existing = await env.DB.prepare('SELECT * FROM price_observations WHERE id=?').bind(value.id).first();
    if (!existing) throw new PriceError(409, 'This item changed during the check. Reload it before trying again.');
    const saved = observation.parse(existing);
    if (saved.item_id !== item.id || saved.product_url !== item.data.productUrl || saved.currency !== value.currency || saved.price_minor !== value.priceMinor || saved.method !== method) {
      throw new PriceError(409, 'This price observation ID already contains another value.');
    }
  }
}

export async function recordPrice(env: PriceEnv, id: ItemId, body: unknown, actor: string) {
  const input = recordInput.parse(body);
  const item = await wishlistItem(env, id, input.revision);
  if (input.currency !== item.data.currency || input.productUrl !== item.data.productUrl) {
    throw new PriceError(409, 'Use the item’s current product link and currency.');
  }
  await savePrice(env, item, { ...input, id: input.id ?? crypto.randomUUID() }, 'recorded', actor);
  return priceTracking(env, item);
}

export async function checkPrice(env: PriceEnv, id: ItemId, body: unknown, actor: string) {
  const { revision } = checkInput.parse(body);
  const item = await wishlistItem(env, id, revision);
  checkableUrl(item.data.productUrl, env.PRICE_CHECK_HOSTS);
  const checkId = crypto.randomUUID();
  const claimed = await env.DB.prepare(`INSERT INTO price_checks(item_id,check_id,product_url,currency,checked_at,error)
    SELECT id,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'The price check did not finish. Try again.'
    FROM items WHERE id=? AND revision=? AND status='wishlist'
    ON CONFLICT(item_id) DO UPDATE SET check_id=excluded.check_id,product_url=excluded.product_url,currency=excluded.currency,checked_at=excluded.checked_at,error=excluded.error
    WHERE price_checks.checked_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')`).bind(checkId, item.data.productUrl, item.data.currency, id, revision).run();
  if (!claimed.meta.changes) {
    await wishlistItem(env, id, revision);
    throw new PriceError(429, 'Wait one minute before checking this item again.', 'check_cooldown');
  }
  try {
    const value = await readPrice(item.data.productUrl, item.data.currency, env.PRICE_CHECK_HOSTS);
    await savePrice(env, item, { ...value, id: checkId }, 'page', actor);
    await env.DB.prepare('UPDATE price_checks SET error=NULL WHERE item_id=? AND check_id=?').bind(id, checkId).run();
  } catch (error) {
    const message = error instanceof PriceError ? error.message : 'The price check failed. Try again.';
    await env.DB.prepare('UPDATE price_checks SET error=? WHERE item_id=? AND check_id=?').bind(message, id, checkId).run();
    throw error;
  }
  return priceTracking(env, item);
}
