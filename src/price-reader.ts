import { z } from 'zod';
import { itemData } from './domain.ts';

type PriceErrorCode = 'price_error' | 'unsupported_store' | 'offer_missing' | 'offer_ambiguous' | 'offer_invalid'
  | 'currency_mismatch' | 'offer_unavailable' | 'offer_condition' | 'offer_expired' | 'redirect_rejected'
  | 'store_blocked' | 'page_invalid' | 'page_too_large' | 'product_data_too_large' | 'store_unreachable' | 'check_cooldown'
  | 'provider_config' | 'provider_auth' | 'provider_limit' | 'provider_pending' | 'provider_unavailable' | 'provider_budget';

export class PriceError extends Error {
  status: number;
  code: PriceErrorCode;
  constructor(status: number, message: string, code: PriceErrorCode = 'price_error') { super(message); this.status = status; this.code = code; }
}

const defaultHosts = [
  'amazon.com', 'www.amazon.com', 'amazon.co.uk', 'www.amazon.co.uk', 'amazon.de', 'www.amazon.de',
  'amazon.fr', 'www.amazon.fr', 'amazon.it', 'www.amazon.it', 'amazon.es', 'www.amazon.es',
  'iherb.com', 'www.iherb.com', 'il.iherb.com',
  'aliexpress.com', 'www.aliexpress.com', 'he.aliexpress.com', 'shop.com', 'www.shop.com', 'shop.app',
];
export function checkableUrl(value: string, extraHosts = ''): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new PriceError(400, 'Add a product link before checking its price.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new PriceError(400, 'Use an HTTPS product link without credentials, a port, or a fragment.');
  }
  const allowed = [...defaultHosts, ...extraHosts.split(',').map(host => host.trim().toLowerCase()).filter(Boolean)];
  if (!allowed.includes(url.hostname) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(url.hostname)) {
    throw new PriceError(422, 'This store does not support direct checks. Open the product link and record its price.', 'unsupported_store');
  }
  return url;
}

function productAddress(value: string, base: string): string {
  const url = new URL(value, base);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['tag', 'ref', 'linkCode'].includes(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  return url.href;
}
const typeName = z.union([z.string(), z.array(z.string())]).optional();
const offerSchema = z.object({
  '@type': typeName,
  url: z.string().optional(),
  price: z.union([z.number(), z.string().regex(/^\d+(?:\.\d{1,2})?$/)]),
  priceCurrency: itemData.shape.currency.removeDefault(),
  availability: z.string().optional(),
  priceValidUntil: z.string().optional(),
  validFrom: z.string().optional(),
  itemCondition: z.string().optional(),
});
const offerAddress = z.object({ url: z.string().optional() });
const productSchema = z.object({ '@type': typeName, url: z.string().optional(), offers: z.unknown() });
const nodeSchema = z.object({ '@graph': z.array(z.unknown()).optional(), hasVariant: z.array(z.unknown()).optional() });
const hasType = (value: z.infer<typeof typeName>, type: string) => (Array.isArray(value) ? value : [value]).includes(type);

export function structuredPrice(blocks: string[], productUrl: string, currency: string, now = new Date()) {
  const products: z.infer<typeof productSchema>[] = [];
  function visit(value: unknown, depth = 0) {
    if (depth > 12) return;
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    const product = productSchema.safeParse(value);
    if (product.success && hasType(product.data['@type'], 'Product')) products.push(product.data);
    const node = nodeSchema.safeParse(value);
    if (node.success) for (const child of [...(node.data['@graph'] ?? []), ...(node.data.hasVariant ?? [])]) visit(child, depth + 1);
  }
  for (const block of blocks) {
    try { visit(JSON.parse(block)); } catch { /* A malformed block cannot supply a price. */ }
  }
  const target = productAddress(productUrl, productUrl);
  const matches = (value: string) => { try { return productAddress(value, productUrl) === target; } catch { return false; } };
  const offers = products.flatMap(product => {
    if (product.url && !matches(product.url)) return [];
    const values = Array.isArray(product.offers) ? product.offers : [product.offers];
    return values.filter(value => {
      const address = offerAddress.safeParse(value);
      if (!address.success) return Boolean(product.url);
      return address.data.url ? matches(address.data.url) : Boolean(product.url);
    });
  });
  if (!offers.length) throw new PriceError(422, 'The store did not publish a readable price for this product. Open the product link and record its price.', 'offer_missing');
  if (offers.length !== 1) throw new PriceError(422, 'The page has multiple offers for this product. Open the product link and record its price.', 'offer_ambiguous');
  const parsed = offerSchema.safeParse(offers[0]);
  if (!parsed.success || !hasType(parsed.data['@type'], 'Offer')) throw new PriceError(422, 'The page has no valid product offer.', 'offer_invalid');
  const offer = parsed.data;
  if (offer.priceCurrency !== currency) throw new PriceError(422, `The store returned ${offer.priceCurrency}. The item uses ${currency}.`, 'currency_mismatch');
  if (offer.availability && !/^(?:https?:\/\/schema.org\/)?InStock$/.test(offer.availability)) {
    throw new PriceError(422, 'This offer is not in stock. The last price stays saved.', 'offer_unavailable');
  }
  if (offer.itemCondition && !/^(?:https?:\/\/schema.org\/)?NewCondition$/.test(offer.itemCondition)) {
    throw new PriceError(422, 'This offer is not for a new item. Record the verified price.', 'offer_condition');
  }
  if ((offer.priceValidUntil && (!Number.isFinite(Date.parse(offer.priceValidUntil)) || offer.priceValidUntil.slice(0, 10) < now.toISOString().slice(0, 10))) ||
      (offer.validFrom && (!Number.isFinite(Date.parse(offer.validFrom)) || Date.parse(offer.validFrom) > now.getTime()))) {
    throw new PriceError(422, 'This offer is outside its valid dates.', 'offer_expired');
  }
  const amount = Number(offer.price) * 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000_000 || Math.abs(amount - Math.round(amount)) > 0.0001) {
    throw new PriceError(422, 'The page has an invalid product price.', 'offer_invalid');
  }
  return { priceMinor: Math.round(amount), currency: offer.priceCurrency };
}

export async function readPrice(productUrl: string, currency: string, extraHosts = '', fetchPage: typeof fetch = fetch) {
  let url = checkableUrl(productUrl, extraHosts);
  const signal = AbortSignal.timeout(12_000);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchPage(url, { redirect: 'manual', signal, headers: { Accept: 'text/html', 'User-Agent': 'HomeInventory-PriceCheck/1.0' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new PriceError(422, 'The store returned an invalid redirect.', 'redirect_rejected');
        const next = checkableUrl(new URL(location, url).href, extraHosts);
        if (productAddress(next.href, url.href) !== productAddress(productUrl, productUrl)) {
          throw new PriceError(422, 'The store redirected to another page. Update the product link or record its price.', 'redirect_rejected');
        }
        url = next;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new PriceError(422, 'The store blocked this check or returned an error. Record the verified price.', 'store_blocked'); }
      if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
        await response.body?.cancel(); throw new PriceError(422, 'The store did not return a product page.', 'page_invalid');
      }
      if (!response.body) throw new PriceError(422, 'The store returned an empty page.', 'page_invalid');
      let bytes = 0, dataBytes = 0, collecting = false, block = '';
      let limitError: PriceError | undefined;
      const blocks: string[] = [];
      const encoder = new TextEncoder();
      const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 8_000_000) {
            limitError = new PriceError(422, 'This page exceeds the 8 MB check limit. Open the product link and record its price.', 'page_too_large');
            throw limitError;
          }
          controller.enqueue(chunk);
        },
      }));
      const parsed = new HTMLRewriter().on('script', {
        element(element) {
          collecting = element.getAttribute('type')?.trim().toLowerCase() === 'application/ld+json';
          block = '';
          element.onEndTag(() => { if (collecting) blocks.push(block); collecting = false; block = ''; });
        },
        text(chunk) {
          if (!collecting) return;
          dataBytes += encoder.encode(chunk.text).byteLength;
          if (dataBytes > 512_000) {
            limitError = new PriceError(422, 'The page has too much structured price data. Open the product link and record its price.', 'product_data_too_large');
            throw limitError;
          }
          block += chunk.text;
        },
      }).transform(new Response(limited, { headers: response.headers }));
      const reader = parsed.body?.getReader();
      if (!reader) throw new PriceError(422, 'The store returned an empty page.', 'page_invalid');
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
        }
      } catch (error) { throw limitError ?? error; }
      finally { await reader.cancel().catch(() => {}); }
      return structuredPrice(blocks, productUrl, currency);
    }
    throw new PriceError(422, 'The store returned too many redirects.', 'redirect_rejected');
  } catch (error) {
    if (error instanceof PriceError) throw error;
    throw new PriceError(422, 'The store did not respond. Try again or record the verified price.', 'store_unreachable');
  }
}
