import { z } from 'zod';
import { checkableUrl, PriceError } from './price-reader.ts';

export interface BrightDataEnv {
  BRIGHT_DATA_API_KEY?: string;
  BRIGHT_DATA_AMAZON_ZIPCODE?: string;
  BRIGHT_DATA_DAILY_LIMIT?: string;
}

export const priceSource = z.object({
  provider: z.literal('brightdata'),
  market: z.literal('US'),
  postalCode: z.string().regex(/^\d{5}$/).nullable(),
  offer: z.literal('regular'),
  seller: z.string().max(500).nullable(),
});

type Target = { store: 'amazon'; url: string; asin: string; postalCode: string }
  | { store: 'iherb'; url: string; itemId: string };

export function brightDataTarget(productUrl: string, currency: string, env: BrightDataEnv): Target | null {
  if (!env.BRIGHT_DATA_API_KEY || currency !== 'USD') return null;
  return providerProduct(productUrl, env.BRIGHT_DATA_AMAZON_ZIPCODE ?? '10001');
}

function providerProduct(productUrl: string, postalCode: string): Target | null {
  const url = new URL(productUrl);
  if (!['amazon.com', 'www.amazon.com', 'iherb.com', 'www.iherb.com'].includes(url.hostname)) return null;
  checkableUrl(productUrl);
  for (const [key, value] of url.searchParams) {
    if (/^utm_/i.test(key) || ['tag', 'ref', 'ref_', 'linkCode'].includes(key)) continue;
    if ((key === 'th' || key === 'psc') && value === '1') continue;
    if (key === 'currency' && value === 'USD') continue;
    if (key === 'language' && value === 'en_US') continue;
    throw new PriceError(422, 'Use a product link without seller or option filters before checking its price.', 'offer_ambiguous');
  }
  if (url.hostname.endsWith('amazon.com')) {
    const asin = url.pathname.match(/^\/(?:[^/]+\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/ref=[^/]+)?\/?$/i)?.[1]?.toUpperCase();
    if (!asin) throw new PriceError(422, 'Use an Amazon product link containing its ASIN.', 'offer_invalid');
    if (!/^\d{5}$/.test(postalCode)) throw new PriceError(503, 'The Amazon delivery ZIP setting is invalid.', 'provider_config');
    return { store: 'amazon', url: `https://www.amazon.com/dp/${asin}`, asin, postalCode };
  }
  const itemId = url.pathname.match(/^\/pr\/[^/]+\/(\d+)\/?$/)?.[1];
  if (!itemId) throw new PriceError(422, 'Use an iHerb product link containing its product ID.', 'offer_invalid');
  return { store: 'iherb', url: `https://www.iherb.com${url.pathname.replace(/\/$/, '')}`, itemId };
}

const amount = z.union([z.number(), z.string()]);
const alternateOffer = z.object({
  title: z.string(), price: amount, buying_option_type: z.string(), sold_by: z.string().max(500).nullish(),
});
const amazonResult = z.object({
  asin: z.string(), url: z.url(), currency: z.string(), zipcode: z.string(),
  is_available: z.boolean(), final_price: amount.nullish(), buying_option_type: z.string().nullish(),
  seller_name: z.string().max(500).nullish(), all_inactive_buy_box: z.array(alternateOffer).nullish(),
});
const iherbResult = z.object({
  url: z.url(), item_id: z.string(), variant_id: z.string(), store_country: z.string(),
  price: amount.nullish(), availability: z.string(), currency: z.string().nullish(),
});

function priceMinor(value: unknown) {
  if (typeof value === 'string') {
    if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value)) {
      throw new PriceError(422, 'The provider returned an invalid USD price.', 'offer_invalid');
    }
    value = Number(value.replace(/[$,]/g, ''));
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10_000_000_000
      || Math.abs(value * 100 - Math.round(value * 100)) > 0.0001) {
    throw new PriceError(422, 'The provider returned an invalid USD price.', 'offer_invalid');
  }
  return Math.round(value * 100);
}

export function brightDataPrice(data: unknown, target: Target) {
  const rows = z.array(z.unknown()).length(1).safeParse(data);
  if (!rows.success) throw new PriceError(422, 'The provider did not return one product.', 'offer_ambiguous');
  let value: number, seller: string | null = null;
  if (target.store === 'amazon') {
    const parsed = amazonResult.safeParse(rows.data[0]);
    if (!parsed.success) throw new PriceError(422, 'The provider returned incomplete Amazon product data.', 'offer_invalid');
    const row = parsed.data;
    const returned = providerProduct(row.url, target.postalCode);
    if (row.asin !== target.asin || returned?.store !== 'amazon' || returned.asin !== target.asin) {
      throw new PriceError(422, 'The provider returned another product. No price was saved.', 'offer_invalid');
    }
    if (row.currency !== 'USD') throw new PriceError(422, 'The provider returned another currency. No price was saved.', 'currency_mismatch');
    if (row.zipcode !== target.postalCode) throw new PriceError(422, 'The provider returned another delivery ZIP. No price was saved.', 'offer_invalid');
    if (!row.is_available) throw new PriceError(422, 'This offer is not in stock. The last price stays saved.', 'offer_unavailable');
    if (row.buying_option_type === 'NEW') {
      value = priceMinor(row.final_price);
      seller = row.seller_name ?? null;
    } else {
      const regular = (row.all_inactive_buy_box ?? []).filter(offer => offer.buying_option_type === 'NEW' && offer.title === 'Regular Price');
      if (regular.length !== 1 || !regular[0]) {
        throw new PriceError(422, 'No single regular price is available. Prime, subscription, and used offers are excluded.', 'offer_condition');
      }
      value = priceMinor(regular[0].price);
      seller = regular[0].sold_by ?? null;
    }
  } else {
    const parsed = iherbResult.safeParse(rows.data[0]);
    if (!parsed.success) throw new PriceError(422, 'The provider returned incomplete iHerb product data.', 'offer_invalid');
    const row = parsed.data;
    const returned = providerProduct(row.url, '10001');
    if (row.item_id !== target.itemId || row.variant_id !== target.itemId || returned?.store !== 'iherb' || returned.itemId !== target.itemId) {
      throw new PriceError(422, 'The provider returned another product. No price was saved.', 'offer_invalid');
    }
    if (row.store_country !== 'US' || (row.currency != null && row.currency !== 'USD')
        || (row.currency == null && (typeof row.price !== 'string' || !row.price.startsWith('$')))) {
      throw new PriceError(422, 'The provider did not confirm a US dollar price. No price was saved.', 'currency_mismatch');
    }
    if (row.availability !== 'in_stock') throw new PriceError(422, 'This offer is not in stock. The last price stays saved.', 'offer_unavailable');
    value = priceMinor(row.price);
    seller = 'iHerb';
  }
  return {
    priceMinor: value, currency: 'USD',
    source: priceSource.parse({ provider: 'brightdata', market: 'US', postalCode: target.store === 'amazon' ? target.postalCode : null, offer: 'regular', seller }),
  };
}

export async function readBrightDataPrice(target: Target, apiKey: string, fetchProvider: typeof fetch = fetch) {
  const dataset = target.store === 'amazon' ? 'gd_l7q7dkf244hwjntr0' : 'gd_ml6bdip01m1w2mqh87';
  const input = target.store === 'amazon'
    ? { url: target.url, asin: target.asin, zipcode: target.postalCode, language: '' }
    : { url: target.url };
  try {
    const response = await fetchProvider(`https://api.brightdata.com/datasets/v3/scrape?dataset_id=${dataset}&format=json&include_errors=true`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ input: [input], limit_per_input: 1 }),
    });
    if (!response.ok || response.status === 202) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new PriceError(503, 'Bright Data rejected its API key. Ask the site owner to check the key.', 'provider_auth');
      if (response.status === 402 || response.status === 429) throw new PriceError(503, 'Bright Data has reached an account limit. Check its credits before another request.', 'provider_limit');
      if (response.status === 202) throw new PriceError(503, 'Bright Data is still processing this check. No price was saved. Do not retry this run.', 'provider_pending');
      throw new PriceError(503, 'Bright Data could not complete this check. The last price stays saved.', 'provider_unavailable');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new PriceError(503, 'Bright Data returned an empty response.', 'provider_unavailable');
    const decoder = new TextDecoder();
    let text = '', bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1_000_000) throw new PriceError(503, 'Bright Data returned too much data. No price was saved.', 'provider_unavailable');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    return brightDataPrice(JSON.parse(text), target);
  } catch (error) {
    if (error instanceof PriceError) throw error;
    throw new PriceError(503, 'Bright Data did not return a readable result. The last price stays saved.', 'provider_unavailable');
  }
}
