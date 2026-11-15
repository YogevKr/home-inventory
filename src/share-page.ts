import { z } from 'zod';

const publicLink = z.union([z.literal(''), z.url().refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}, 'Use a public HTTP or HTTPS product link without credentials.')]);
export const sharedData = z.object({
  name: z.string().max(140), description: z.string().max(2000),
  brand: z.string(), model: z.string(), productUrl: publicLink,
  price: z.object({ minor: z.number().int().min(0), currency: z.enum(['ILS', 'USD', 'EUR', 'GBP']) }).nullable(),
  seller: z.string(), purchaseDate: z.string(), tags: z.array(z.string()),
}).strict();
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
export const sharedCsp = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
export const publicHeaders = {
  'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': sharedCsp, 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function sharePage(data: z.infer<typeof sharedData>, photoUrl: string | null): string {
  const price = data.price ? new Intl.NumberFormat('en-US', { style: 'currency', currency: data.price.currency }).format(data.price.minor / 100) : '';
  const specs = [['Brand', data.brand], ['Model', data.model], ['Bought from', data.seller], ['Purchased', data.purchaseDate]].filter(([, value]) => value);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive,nosnippet"><meta name="referrer" content="no-referrer"><title>${escapeHtml(data.name)} · Shared item</title><meta property="og:title" content="${escapeHtml(data.name)}"><meta property="og:type" content="article"><link rel="stylesheet" href="/share/assets/page.css"></head><body><header class="share-header"><span class="wordmark"><span class="mark">h.</span> home inventory</span><span class="shared-label">Shared item</span></header><main class="share-page"><div class="product-image ${photoUrl ? '' : 'without-photo'}">${photoUrl ? `<img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(data.name)}">` : '<span class="placeholder-symbol" aria-hidden="true">◇</span><span>No photo shared</span>'}</div><section class="product-story"><p class="eyebrow">A CLOSER LOOK</p><h1>${escapeHtml(data.name)}</h1>${data.brand || data.model ? `<p class="product-subtitle">${escapeHtml([data.brand, data.model].filter(Boolean).join(' · '))}</p>` : ''}${price ? `<div class="shared-price"><span>Price paid</span><strong>${escapeHtml(price)}</strong></div>` : ''}${data.description ? `<p class="product-description">${escapeHtml(data.description)}</p>` : ''}${specs.length ? `<dl class="product-specs">${specs.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value ?? '')}</dd></div>`).join('')}</dl>` : ''}${data.tags.length ? `<div class="product-tags">${data.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}${data.productUrl ? `<a class="product-link" href="${escapeHtml(data.productUrl)}" target="_blank" rel="noopener noreferrer nofollow">View product <span aria-hidden="true">↗</span></a>` : ''}</section></main><footer class="share-footer"><span>One item, shared with you.</span><span>Details selected by the owner.</span></footer></body></html>`;
}
