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

function itemContent(data: z.infer<typeof sharedData>, photoUrl: string | null, heading: 'h1' | 'h2'): string {
  const price = data.price ? new Intl.NumberFormat('en-US', { style: 'currency', currency: data.price.currency }).format(data.price.minor / 100) : '';
  const specs = [['Brand', data.brand], ['Model', data.model], ['Bought from', data.seller], ['Purchased', data.purchaseDate]].filter(([, value]) => value);
  return `<div class="product-image ${photoUrl ? '' : 'without-photo'}">${photoUrl ? `<img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(data.name)}">` : '<span class="placeholder-symbol" aria-hidden="true">◇</span><span>No photo shared</span>'}</div><section class="product-story"><p class="eyebrow">A CLOSER LOOK</p><${heading}>${escapeHtml(data.name)}</${heading}>${data.brand || data.model ? `<p class="product-subtitle">${escapeHtml([data.brand, data.model].filter(Boolean).join(' · '))}</p>` : ''}${price ? `<div class="shared-price"><span>Price paid</span><strong>${escapeHtml(price)}</strong></div>` : ''}${data.description ? `<p class="product-description">${escapeHtml(data.description)}</p>` : ''}${specs.length ? `<dl class="product-specs">${specs.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value ?? '')}</dd></div>`).join('')}</dl>` : ''}${data.tags.length ? `<div class="product-tags">${data.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}${data.productUrl ? `<a class="product-link" href="${escapeHtml(data.productUrl)}" target="_blank" rel="noopener noreferrer nofollow">View product <span aria-hidden="true">↗</span></a>` : ''}</section>`;
}

export function collectionPage(title: string, description: string, items: { data: z.infer<typeof sharedData>; photoUrl: string | null }[], pageUrl?: string): string {
  const cards = items.map(({ data, photoUrl }) => {
    return `<article class="collection-entry">${itemContent(data, photoUrl, 'h2')}</article>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive,nosnippet"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · Shared collection</title>${socialMetadata(title, description, items.find(item => item.photoUrl)?.photoUrl ?? null, pageUrl)}<link rel="stylesheet" href="/share/assets/page.css"></head><body><header class="share-header"><span class="wordmark"><span class="mark">h.</span> home inventory</span><span class="shared-label">Shared collection</span></header><main class="collection-page"><header class="collection-heading"><p class="eyebrow">${items.length} ITEM${items.length === 1 ? '' : 'S'}</p><h1>${escapeHtml(title)}</h1>${description ? `<p class="product-description">${escapeHtml(description)}</p>` : ''}</header><div class="shared-collection-grid">${cards}</div></main></body></html>`;
}

function socialMetadata(title: string, description: string, photoUrl: string | null, pageUrl?: string): string {
  const image = photoUrl && pageUrl ? new URL(photoUrl, pageUrl).href : null;
  return `<meta property="og:title" content="${escapeHtml(title)}"><meta property="og:type" content="website">${description ? `<meta property="og:description" content="${escapeHtml(description)}">` : ''}${pageUrl ? `<meta property="og:url" content="${escapeHtml(pageUrl)}">` : ''}${image ? `<meta property="og:image" content="${escapeHtml(image)}"><meta property="og:image:alt" content="${escapeHtml(title)}"><meta name="twitter:card" content="summary_large_image">` : ''}`;
}

export function sharePage(data: z.infer<typeof sharedData>, photoUrl: string | null, pageUrl?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive,nosnippet"><meta name="referrer" content="no-referrer"><title>${escapeHtml(data.name)} · Shared item</title>${socialMetadata(data.name, data.description, photoUrl, pageUrl)}<link rel="stylesheet" href="/share/assets/page.css"></head><body><header class="share-header"><span class="wordmark"><span class="mark">h.</span> home inventory</span><span class="shared-label">Shared item</span></header><main class="share-page">${itemContent(data, photoUrl, 'h1')}</main><footer class="share-footer"><span>One item, shared with you.</span></footer></body></html>`;
}
