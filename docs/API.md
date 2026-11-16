# Inventory API

Base URL: your deployment origin, such as `https://inventory.example.com`.
Set `INVENTORY_URL` to that origin before using the CLI.

Cloudflare Access requires `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers for agents.
Inject both values through your secret manager. Never put them in command arguments, logs, or source files.

## Routes

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/bootstrap` | Identity, places, tags, counts, and recorded values |
| GET | `/api/items` | A page of items |
| POST | `/api/items` | Create an item |
| POST | `/api/inbox/review` | Keep, archive, or undo a batch of inbox purchases atomically |
| GET | `/api/items/:id` | Details, attachments, comments, and recent history |
| GET | `/api/items/:id/purchases` | Purchase summaries for the same product, including archived records |
| GET | `/api/items/:id/prices` | Price history for the current product link and currency |
| POST | `/api/items/:id/prices` | Record a verified wishlist price |
| POST | `/api/items/:id/prices/check` | Read a public store offer on demand |
| PUT | `/api/items/:id` | Replace editable fields using the current revision |
| GET | `/api/items/:id/share` | Get the current share link and selected fields |
| POST | `/api/items/:id/share/preview` | Preview selected fields without publishing |
| POST | `/api/items/:id/share` | Publish a share page |
| DELETE | `/api/items/:id/share` | Revoke a share link using its share ID |
| DELETE | `/api/items/:id` | Permanently delete one purchase using the current revision |
| POST | `/api/items/:id/comments` | Append a comment |
| POST | `/api/items/:id/attachments` | Upload a file |
| DELETE | `/api/items/:id/attachments/:fileId` | Remove a file from the item, with recovery |
| POST | `/api/items/:id/attachments/:fileId/restore` | Restore a removed file |
| POST | `/api/items/:id/restore` | Restore details from an earlier history event |
| POST | `/api/locations` | Create a place inside another place |
| GET | `/api/activity` | The latest 100 changes |
| GET | `/api/export` | Records, comments, attachments, places, and history |
| GET, HEAD | `/api/files/:id` | Retrieve a private file |

IDs use UUIDs. Monetary values use integer minor units.
For example, `12990` with currency `ILS` means ₪129.90 per item.

## Item fields

`name` is required. Other fields receive defaults during creation.
The schema rejects unknown fields.

| Field | Format or default |
| --- | --- |
| `name` | Text, 1–140 characters |
| `description` | Text, up to 6,000 characters |
| `brand`, `model`, `serialNumber`, `seller`, `borrower` | Text, up to 200 characters each |
| `purchaseDate`, `warrantyDate` | `YYYY-MM-DD`, or empty text |
| `priceMinor` | Integer from 0 to 1,000,000,000,000, or `null` |
| `currency` | `ILS`, `USD`, `EUR`, or `GBP`; default `ILS` |
| `productUrl`, `sourceUrl` | HTTP or HTTPS link, or empty text |
| `locationId` | Existing place UUID, or `null` |
| `tags` | Up to 30 tags, each up to 40 characters |
| `quantity` | Integer from 1 to 100,000; default 1 |
| `status` | `active`, `inbox`, `wishlist`, `lent`, or `archived`; default `active` |
| `purchaseFor` | `{"kind":"self"}` by default; or `{"kind":"other","recipient":"Name"}` |

Create:

```json
{
  "id": "71d08ff8-ae2c-4cfb-a84b-3469fbd72123",
  "data": {
    "name": "Cordless drill",
    "seller": "Hardware store",
    "priceMinor": 45900,
    "currency": "ILS",
    "tags": ["Tools"],
    "sourceUrl": "https://example.com/order"
  }
}
```

Pipe the JSON into:

```sh
node scripts/inventory.mjs create < item.json
```

Creation returns HTTP 201. An identical retry with the same UUID returns HTTP 200.
A different record with that UUID returns HTTP 409.

Update:

```json
{"revision": 3, "data": {"name": "Cordless drill", "status": "active"}}
```

Updates replace all editable fields. Include every existing field that must remain.
Use the latest record's complete `data` object and its `revision`.
HTTP 409 means another writer changed the item. Read it again and merge the requested changes.
Comments and attachments remain separate from editable fields.

```sh
node scripts/inventory.mjs update ITEM_UUID < update.json
```

Archive by updating `status` to `archived`.
Restore to the collection by updating `status` to `active`.

## Wishlist

Create future purchases with `status: "wishlist"` through `POST /api/items` or the CLI `create` command.
Use `priceMinor` for the expected price. Leave `purchaseDate` empty until purchase.
Photos, links, tags, recipients, comments, history, deletion, and exports work with wishlist items.

```json
{"data":{"name":"Reading lamp","status":"wishlist","priceMinor":8900,"currency":"USD","productUrl":"https://example.com/lamp"}}
```

List wishlist items with `GET /api/items?status=wishlist` or:

```sh
node scripts/inventory.mjs wishlist
node scripts/inventory.mjs wishlist lamp
```

The normal collection query excludes wishlist items. Bootstrap purchase values also exclude their expected prices.
The purchase-group endpoint keeps wishlist entries separate from purchased entries of the same product.
Wishlist queries support the existing filters, sorting, and pagination. Exports include wishlist records and their files.

After purchase, read the latest record. Update its complete `data` object and current `revision` with `PUT /api/items/:id`.
Set `status` to `active`, supply the purchase date, and replace the expected price with the actual price.
Use `null` if the actual price is unknown. Keep the existing ID to preserve photos, comments, and history.
The browser's Mark as bought action opens this form and clears the expected price before confirmation.
No changes occur until the user saves the purchase. A stale revision returns HTTP 409.

To restore an archived wishlist entry through the API, set its status to `wishlist`.
The browser uses available archive history to restore it to Wishlist.
Shared pages use neutral Price and Store labels. Sharing does not publish an item's private status.

### Price tracking

Apply migration `0006_price_tracking.sql` before running this version.
Open a wishlist item to use its price tracker. Checks run only when requested.
There is no scheduled Worker, notification service, browser session, or paid scraping service.

Tracked prices use separate records. They never replace `data.priceMinor` or change purchase totals, sorting, or the item revision.
Each record stores its product link, currency, timestamp, source method, and authenticated actor.
A changed product link or currency starts a separate series. Prior series remain in the full export.
Bought and archived items retain their series. Only wishlist items accept new prices.
Deleting an item also deletes its price records and check results.
Public share pages do not expose price history, check results, or actors.

`GET /api/items/:id/prices` returns `observations`, `count`, `lowest`, `supported`, `reason`, and `lastCheck`.
Item details include the same object under `priceTracking`.
The result contains the latest 100 observations for the current product link and currency, newest first.
`count` and `lowest` cover the full series. Each observation uses integer `price_minor` and a server `observed_at` timestamp.
`method` is `page` for direct checks or `recorded` for manual and agent entries.
`/api/export` includes all series in `priceObservations` and check status in `priceChecks`.

Record a verified price:

```json
{"id":"bd090b65-55f5-4b12-85fb-2a41e55998b5","revision":3,"priceMinor":7995,"currency":"USD","productUrl":"https://example.com/lamp"}
```

```sh
node scripts/inventory.mjs record-price ITEM_UUID < observed-price.json
node scripts/inventory.mjs prices ITEM_UUID
```

Supply the current item revision, exact product link, and currency.
`priceMinor` must be positive. `id` is optional; send a UUID for safe retries.
An identical retry returns the existing observation. A conflicting UUID returns HTTP 409.
Record only the verified price for the exact model and options. Check shipping and discounts separately.

Request a direct check:

```json
{"revision":3}
```

```sh
node scripts/inventory.mjs check-price ITEM_UUID < revision.json
```

Direct checks require HTTPS and an approved store host.
The default hosts cover Amazon US, UK, DE, FR, IT, ES; iHerb; AliExpress; Shop; and Shop.com.
See `src/price-reader.ts` for exact hostnames. Host approval permits requests; it does not guarantee a readable price.
Store blocking, login pages, and missing structured data return HTTP 422 without adding an observation.
The reader requires one matching JSON-LD Product Offer with an explicit price and matching currency.
It rejects ranges, ambiguous variants, unavailable offers, expired offers, and used-item offers.
Shipping, account discounts, checkout prices, and browser-rendered prices may differ.
A direct check can run once per item per minute. HTTP 429 indicates the cooldown.
Each request has a 12-second timeout, a 2 MB page limit, and a three-redirect limit.
Redirects must retain the approved host and product address. No cookies or credentials go to stores.

Self-hosted deployments can add a `PRICE_CHECK_HOSTS` text binding containing comma-separated exact hostnames.
Add only trusted public store hosts. Never add internal services or domains that resolve to private networks.

## Inbox review

Purchase summaries include `revision`. Send the exact IDs and revisions shown in the inbox card:

```json
{"action":"keep","items":[{"id":"71d08ff8-ae2c-4cfb-a84b-3469fbd72123","revision":3}]}
```

`keep` changes `inbox` to `active`. `archive` changes `inbox` to `archived`.
The response contains the resulting `status` and updated `items` with IDs and revisions.
Undo sends those returned revisions and the resulting status:

```json
{"action":"undo","from":"active","items":[{"id":"71d08ff8-ae2c-4cfb-a84b-3469fbd72123","revision":4}]}
```

Undo returns purchases to `inbox`. Each request accepts 1–200 unique IDs.
All IDs must exist with matching revisions and the required current status.
If any target changed, the endpoint returns HTTP 409 and changes nothing.
Only status changes. Other details, comments, files, and purchase grouping remain intact.
Each change adds a history entry. Later is browser session state and has no write endpoint.

## Purchase recipients

Mark a purchase for someone else with `purchaseFor: {"kind":"other","recipient":"Name"}`.
The recipient is optional. Use an empty string when the recipient is unknown.
Keep the current item revision and all other fields when updating this value.
This mark does not change the item's location, status, comments, or history.
Existing records without this field remain unmarked and appear under **For me**.

## Search

`GET /api/items` supports these query parameters:

| Parameter | Meaning |
| --- | --- |
| `q` | Search name and editable record text |
| `location` | Include a place and its descendants |
| `tag` | Exact tag match |
| `status` | Exact status; default includes only `active`, `inbox`, and `lent` |
| `purchaseFor` | `self` or `other`; omit to include both |
| `sort` | `recent`, `name`, `purchaseDate`, or `price`; default `purchaseDate` |
| `direction` | `asc` or `desc`; default `desc` for dates, otherwise `asc` |
| `photo` | `missing` shows items without photos; default `all` |
| `limit` | 1–200; default 120 |
| `offset` | Nonnegative integer; default 0 |
| `group` | `product` groups matching purchases before pagination; default `none` |

Sorting applies before pagination. Equal values use the item UUID for stable ordering.
Unknown dates and prices appear last in both directions.
Price sorting compares estimated unit prices in USD across all currencies, before grouping and pagination.
Original amounts and currencies remain unchanged. Zero prices come before positive prices in ascending order.
Unknown prices remain last in both directions.
Groups use their first purchase in the requested order, such as their earliest date or lowest price.
For price sorting, a group uses its lowest or highest USD estimate, according to the requested direction.

Item-list responses include `sortPriceMinor`, the estimated USD unit price in cents, or `null` for unknown prices.
They also include `priceReference`, with the currency, reference date, source URL, and conversion rates.
Each rate expresses units of that currency per USD. Divide the original minor-unit amount by its rate and round.
The bootstrap response includes the same reference. Rates stay fixed until the owner updates and deploys them.
They are reference estimates, not purchase-date exchange rates or payment-card charges.
The browser restarts pagination if a deployment changes the reference rates during browsing.
The missing-photo filter checks active photos across all matching purchases in a product group.
Receipts and removed photos do not count as photos.
Other filters apply before grouping, so excluded purchases do not supply a group's photo.

The response includes `items`, `total`, `limit`, and `offset`.
The CLI `list [query]` command returns the first 200 matching items.
Use API pagination or export for larger collections.

The interface uses `group=product`. Each product keeps its original purchase records.
Grouped responses include `recordTotal`. Each group includes `purchaseCount`, `totalQuantity`, and `purchases` summaries.
Filters apply to purchase records before grouping. `total`, `limit`, and `offset` then refer to product groups.
The purchase details route returns all matching purchases, including records outside the current filters.
Prices, recipients, comments, files, and history remain attached to their original purchase IDs.

Matching uses Amazon ASINs, iHerb product IDs, and Shop or AliExpress product and variant IDs, with recorded model details.
AliExpress links must include a numeric `sku_id` to group purchases across titles and regional sites.
AliExpress links without a variant ID use the exact link, name, brand, and model.
Other product links require matching names, brands, and models. Records without links use those exact normalized text fields.
Different model details remain separate. Correct the product link or model to change a match.
Grouping runs when requested. It does not modify stored records or add scheduled tasks.

## Permanent item deletion

Send `{"revision":3}` to `DELETE /api/items/ITEM_UUID` using the current revision.
The browser requires confirmation. This action removes only the selected purchase, even within a product group.
It permanently deletes the purchase, comments, history, and all files, including previously removed files.
Locations and other purchases remain unchanged. Export a backup first if recovery could be required.

```sh
node scripts/inventory.mjs delete ITEM_UUID < deletion.json
```

A stale revision returns HTTP 409 before any data or file removal.
Deletion records pending file IDs in the same database transaction that removes the purchase.
File cleanup follows. HTTP 503 means the purchase is gone but file cleanup needs a retry.
Repeat the same DELETE request to finish cleanup. Completed retries return `{"id":"ITEM_UUID","deleted":true}`.
The database keeps the deleted UUID and deletion time to prevent accidental recreation during retries.
It clears pending file IDs after cleanup. Deleted records and files do not appear in exports.
Reusing a deleted UUID for creation returns HTTP 409. Use a new UUID for a new purchase.

## Comments, places, and restores

A comment body is `{"body":"Stored with the spare batteries."}`.
A place body is `{"name":"Top drawer","parentId":"PARENT_UUID"}`.
Use `null` for a place without a parent.

```sh
node scripts/inventory.mjs comment ITEM_UUID < comment.json
node scripts/inventory.mjs place < place.json
```

Restore details with `{"revision":4,"eventId":12}` at `/api/items/:id/restore`.
The event must belong to the item and contain `before_data`.
Restoring an older event replaces the complete editable record with that earlier version.
It keeps comments, attachments, and the full history.

## Attachments

Send multipart form data with `file` and `kind`.
Kinds are `photo`, `receipt`, `manual`, and `document`.
Each file must be smaller than 12 MB, including request overhead.

Photos accept JPEG, PNG, WebP, and AVIF.
Other attachments accept JPEG, PNG, WebP, PDF, and plain text.
SVG uploads are rejected.
The API checks declared MIME types. It does not inspect binary signatures.

```sh
node scripts/inventory.mjs attach ITEM_UUID /absolute/path/photo.webp photo
```

The browser resizes photos. The CLI sends original files, so prepare smaller photos before upload.
File links require Access authentication.

Remove an incorrect photo or file with its exact item UUID and attachment UUID:

```sh
node scripts/inventory.mjs remove-file ITEM_UUID FILE_UUID
node scripts/inventory.mjs restore-file ITEM_UUID FILE_UUID
```

Both commands return the updated item. Repeating the same operation adds no duplicate history event.
An attachment must belong to the specified item. A mismatch returns HTTP 404.
Removal preserves item fields, revisions, comments, and earlier history.
It adds a history event with the attachment ID and acting user.
The item response lists visible files in `attachments` and removed files in `removedAttachments`.
Removed files disappear from collection photos and the normal file list.
They remain in storage, authenticated file links, and full exports for recovery.
Exported attachments include `removed_at`; `null` means the attachment is visible.
The browser shows recovery controls under **Removed files**.

## Exports

`GET /api/export` returns JSON with `format: "home-inventory-v1"` and an `exportedAt` timestamp.
The response includes `items`, `locations`, `comments`, `attachments`, and `activity` arrays.
Attachment records contain metadata. Retrieve file contents through `/api/files/:id`.

The browser downloads `home-inventory-YYYY-MM-DD.zip`, containing `inventory.json` and files under `files/ATTACHMENT_ID/FILENAME`.
The CLI writes the same JSON format to `inventory.json` and stores each file at `files/ATTACHMENT_ID`.
Changing the format identifier does not change the record fields or file contents.
External tools that check the identifier must accept `home-inventory-v1` for new exports.

## Error codes

| Code | Meaning |
| --- | --- |
| 400 | Invalid record, file, location, or pagination |
| 401 | Missing or invalid Worker authentication |
| 403 | Rejected cross-origin write |
| 404 | Record or file does not exist |
| 409 | Conflicting revision or reused UUID |
| 413 | Request exceeds the size limit |
| 415 | Unsupported content type |
| 503 | Item deleted; retry deletion to finish file cleanup |

Cloudflare Access can return a login redirect before requests reach the Worker.
The CLI does not follow redirects carrying credential headers.

## Public item pages

Owners and agents can publish one active share link per purchase.
The share-management routes require normal Access authentication and reject cross-site writes.
Public pages use `/share/TOKEN`. Public photos use `/share/TOKEN/photo`.
Only these routes and `/share/assets/page.css` bypass login after deployment configuration.

Preview with `POST /api/items/ITEM_UUID/share/preview`. Publish with `POST /api/items/ITEM_UUID/share`.
Send the current item revision and selected fields:

```json
{
  "revision": 3,
  "fields": ["brand", "model", "price", "productUrl"],
  "description": "A note written for this page.",
  "photoId": null,
  "expiresAt": null
}
```

`name` always appears. Optional fields are `brand`, `model`, `price`, `seller`, `purchaseDate`, `productUrl`, and `tags`.
`fields` defaults to `brand` and `model`. Public descriptions default to empty and never copy private descriptions automatically.
`expiresAt` accepts a future UTC ISO timestamp or `null` for no expiry. Omission selects 30 days.
The preview returns `{ "html": "..." }` without creating a public link.
Publication returns HTTP 201 with `id`, `url`, and `expiresAt`.
A stale revision or existing active link returns HTTP 409.

For a photo, send multipart form data with `data` containing the JSON above and `photo` containing WebP or JPEG.
Set `photoId` to an active photo attachment from that purchase. Receipts and other purchases' files are rejected.
Re-encode the selected photo before sending it. The browser does this automatically.
The API accepts static WebP or JPEG files smaller than 1.5 MB.
It rejects WebP metadata and animation chunks. It removes JPEG metadata, thumbnails, and comments before storage.
Browsers that cannot encode WebP use JPEG. The browser preserves the actual file format and MIME type.
It stores a separate photo copy without the original filename. It never publishes the original attachment URL.

```sh
node scripts/inventory.mjs share ITEM_UUID < share.json
node scripts/inventory.mjs share ITEM_UUID /path/to/clean-photo.webp < share.json
node scripts/inventory.mjs share ITEM_UUID /path/to/photo.jpg < share.json
node scripts/inventory.mjs share-status ITEM_UUID
node scripts/inventory.mjs revoke-share ITEM_UUID < revoke.json
```

For revocation, `revoke.json` contains the share UUID: `{ "id": "SHARE_UUID" }`.
Repeated revocation is safe. HTTP 503 means access stopped but photo cleanup needs another revocation request.
Revoke the existing link before publishing a replacement. Replacement links use new random tokens.

Each page contains a saved snapshot. Later item edits do not change its fields.
Removing its source photo hides the public photo. Restoring that photo makes it visible again.
Deleting the purchase removes all its shares and public photo copies through the existing deletion cleanup process.
Archiving a purchase preserves its share until revocation or expiry.

Private descriptions, comments, locations, serial numbers, recipients, borrowers, receipts, history, and source links never enter snapshots.
Tokens contain 256 random bits. Pages reject public writes, disable caching, block scripts, and suppress referrer headers.
Search-engine exclusion headers request no indexing. Anyone with the link can view, copy, or save its content.
Revocation cannot remove copies saved elsewhere. The public path provides no listing or search API.
Share tokens remain in the private database so authorized owners can copy existing links.
Collection exports exclude share tokens and public photo copies. Shares are not restored by importing an inventory export.

### Shared collections

Collection sharing creates one public page for 1–20 selected purchases. Each entry uses a fixed snapshot.
Names always appear. Default fields include brand and model. Private item descriptions never carry over.
Deleting a purchase removes it from all shared collections. Removing a source photo hides its public copies.
Empty collections, revoked links, and expired links return `404`.

- `POST /api/collection-shares/preview`: preview a collection without publishing it.
- `POST /api/collection-shares`: publish a collection; returns `{ share }` with `id`, `url`, and `expiresAt`.
- `GET /api/collection-shares`: list unrevoked links, including expired links.
- `GET /api/collection-shares/:id`: get one link, or `{ share: null }` after revocation.
- `DELETE /api/collection-shares/:id`: revoke the link and remove its public photos. Safe to retry.

These routes require authentication. Use this JSON body for preview or publication without photos:

```json
{
  "title": "Weekend gear",
  "description": "A public note for this collection.",
  "fields": ["brand", "model"],
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "items": [{ "id": "ITEM_UUID", "revision": 1, "photoId": null }]
}
```

`fields` accepts the same options as single-item sharing. Each item must appear once, with its current revision.
The default expiry is 30 days. Use `null` for no expiry.
For photos, use multipart form data: JSON in `data`, and converted photos in `photo-0`, `photo-1`, etc.
Each file matches its zero-based item position. Set that entry's `photoId` to its source attachment ID.
Photo validation and metadata removal match single-item sharing. Each photo must be smaller than 1.5 MB.
The total upload limit is 30.1 MB. Invalid or stale inputs create no partial collection.

Public read-only routes are `/share/collection/:token` and `/share/collection/:token/photo/:position`.
They remain under the existing `/share/*` public Access rule. All management routes remain protected.
Public pages include social preview metadata for selected photos. Messaging services may cache those previews after revocation.
