import { z } from 'zod';

export const itemId = z.uuid().brand<'ItemId'>();
export const locationId = z.uuid().brand<'LocationId'>();
export const attachmentId = z.uuid().brand<'AttachmentId'>();
const link = z.union([z.literal(''), z.url().refine(value => /^https?:\/\//i.test(value), 'Use an HTTP or HTTPS link.')]);
const shortText = z.string().trim().max(200);
const purchaseFor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }).strict(),
  z.object({ kind: z.literal('other'), recipient: shortText.default('') }).strict(),
]);
export const itemData = z.object({
  name: z.string().trim().min(1).max(140),
  description: z.string().trim().max(6000).default(''),
  brand: shortText.default(''),
  model: shortText.default(''),
  serialNumber: shortText.default(''),
  seller: shortText.default(''),
  purchaseDate: z.union([z.literal(''), z.iso.date()]).default(''),
  priceMinor: z.number().int().min(0).max(1_000_000_000_000).nullable().default(null),
  currency: z.enum(['ILS', 'USD', 'EUR', 'GBP']).default('ILS'),
  productUrl: link.default(''),
  sourceUrl: link.default(''),
  locationId: locationId.nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).transform(values => [...new Set(values)]).default([]),
  quantity: z.number().int().min(1).max(100000).default(1),
  status: z.enum(['active', 'inbox', 'lent', 'archived']).default('active'),
  borrower: shortText.default(''),
  warrantyDate: z.union([z.literal(''), z.iso.date()]).default(''),
  purchaseFor: purchaseFor.default({ kind: 'self' }),
}).strict();
export type ItemData = z.infer<typeof itemData>;
export type ItemId = z.infer<typeof itemId>;
export type LocationId = z.infer<typeof locationId>;
export const itemCreate = z.object({ id: itemId.optional(), data: itemData }).strict();
export const itemUpdate = z.object({ revision: z.number().int().positive(), data: itemData }).strict();
export const locationInput = z.object({ name: z.string().trim().min(1).max(80), parentId: locationId.nullable() }).strict();
export const itemRow = z.object({
  id: itemId, data: z.string().transform(value => itemData.parse(JSON.parse(value))),
  revision: z.number(), created_at: z.string(), updated_at: z.string(), updated_by: z.string(),
  photo_id: z.string().nullable().optional(),
});
export const itemColumns = 'i.id,i.data,i.revision,i.created_at,i.updated_at,i.updated_by';
