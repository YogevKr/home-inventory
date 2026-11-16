import reference from './price-rates.json' with { type: 'json' };
import type { ItemData } from './domain.ts';

export const priceReference = reference;

export function priceInUsd(data: Pick<ItemData, 'priceMinor' | 'currency'>): number | null {
  return data.priceMinor === null ? null : Math.round(data.priceMinor / priceReference.rates[data.currency]);
}

export function priceOrderSql(direction: 'asc' | 'desc'): string {
  const rates = Object.entries(priceReference.rates).map(([currency, rate]) => `WHEN '${currency}' THEN ${Number(rate).toFixed(8)}`).join(' ');
  return `json_extract(i.data,'$.priceMinor') IS NULL,ROUND(json_extract(i.data,'$.priceMinor') / CASE json_extract(i.data,'$.currency') ${rates} END) ${direction},i.id`;
}
