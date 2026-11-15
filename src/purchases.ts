import { z } from 'zod';
import { itemRow } from './domain.ts';

type Item = z.infer<typeof itemRow>;
const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export function productKey(item: Item): string {
  const { data } = item;
  if (!data.productUrl) return JSON.stringify(['name', normalized(data.name), normalized(data.brand), normalized(data.model)]);
  const url = new URL(data.productUrl);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let identity = data.productUrl;
  const amazon = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i.exec(url.pathname);
  const iherb = /\/pr\/[^/]+\/(\d+)\/?$/.exec(url.pathname);
  const shop = /^\/products\/(\d+)(?:\/|$)/.exec(url.pathname);
  const aliexpress = /^\/item\/(\d+)\.html$/.exec(url.pathname);
  const sku = url.searchParams.get('sku_id');
  if (host === 'amazon.com' && amazon) identity = `amazon:${amazon[1]?.toUpperCase()}`;
  else if ((host === 'iherb.com' || host.endsWith('.iherb.com')) && iherb) identity = `iherb:${iherb[1]}`;
  else if ((host === 'shop.com' || host === 'shop.app') && shop && url.searchParams.has('variantId')) {
    identity = `shop:${shop[1]}:${url.searchParams.get('variantId')}`;
  } else if ((host === 'aliexpress.com' || host.endsWith('.aliexpress.com') || host === 'aliexpress.us' || host.endsWith('.aliexpress.us')) && aliexpress && sku && /^\d+$/.test(sku)) {
    identity = `aliexpress:${aliexpress[1]}:${sku}`;
  } else {
    return JSON.stringify(['link', identity, normalized(data.name), normalized(data.brand), normalized(data.model)]);
  }
  return JSON.stringify(['product', identity, normalized(data.model)]);
}

export function purchaseSummary(item: Item) {
  const { name, quantity, priceMinor, currency, seller, purchaseDate, purchaseFor, status, locationId } = item.data;
  return { id: item.id, revision: item.revision, name, quantity, priceMinor, currency, seller, purchaseDate, purchaseFor, status, locationId };
}

export function groupPurchases(items: Item[]) {
  const groups = new Map<string, { representative: Item; purchases: ReturnType<typeof purchaseSummary>[]; photoId: string | null }>();
  for (const item of items) {
    const key = productKey(item);
    const group = groups.get(key);
    if (group) {
      group.purchases.push(purchaseSummary(item));
      group.photoId ??= item.photo_id ?? null;
    } else groups.set(key, { representative: item, purchases: [purchaseSummary(item)], photoId: item.photo_id ?? null });
  }
  return [...groups.values()].map(({ representative, purchases, photoId }) => ({
    ...representative, photo_id: photoId, purchases,
    purchaseCount: purchases.length,
    totalQuantity: purchases.reduce((sum, purchase) => sum + purchase.quantity, 0),
  }));
}
