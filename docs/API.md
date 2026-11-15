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
| PUT | `/api/items/:id` | Replace editable fields using the current revision |
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
| `status` | `active`, `inbox`, `lent`, or `archived`; default `active` |
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
| `status` | Exact status; default excludes archived items |
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
