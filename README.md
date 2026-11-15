# Home Inventory

A private home inventory that you deploy to your own Cloudflare account.
Store photos, purchase details, receipts, places, and notes. Use the API to let agents maintain your collection.

The source code is public. Each deployment requires login and uses its owner's database and file storage.
This repository contains sample records and illustrations, with no personal inventory or deployment credentials.

![Sample collection with photos, prices, and places](docs/preview.png)

## Try it locally

Use Node 24.10 or later and npm. Local development needs no Cloudflare account or secrets.

```sh
git clone https://github.com/YogevKr/home-inventory.git
cd home-inventory
npm ci
npm run db:local
npm run dev -- --port 8787
```

Open `http://127.0.0.1:8787`. Open `http://127.0.0.1:8787/?sample=1` to explore the sample collection.
Sample records stay in browser memory. Local records use a separate D1 database and R2 storage simulation.
Keep the development server on localhost.

## Features

- Photo cards, list view, search, tags, and nested places.
- Purchase dates, prices, currencies, sellers, warranties, receipts, and product links.
- Recipient marks for purchases you bought for someone else.
- Repeat purchases grouped by product, with separate records, quantities, prices, and history.
- Inbox cards with Keep, Later, Edit, Archive, and Undo buttons. Swipes and keyboard controls also work.
- Sorting by name, update date, purchase date, and price. A filter shows items without photos.
- Comments that remain separate from agent edits, revision checks, and change history.
- Recoverable photo removal, item archiving, and confirmed permanent deletion.
- ZIP exports with records and files. The agent CLI streams larger exports.
- Google or email-code login through Cloudflare Access, plus service tokens for agents.

Later skips an inbox card for the current browser session. Keep and Archive change the selected purchases.
Undo rejects newer edits. Each decision processes up to 200 purchases.

## Deploy your own

Follow [the Cloudflare setup guide](docs/DEPLOY.md).
It covers storage, Access, optional Google login, agent access, migrations, and deployment with `cf`.
Use GitHub's **Use this template** button to create a separate private repository for your deployment.

Copy `deployment.example.json` to `deployment.local.json` and enter your resource identifiers.
Git ignores your local deployment file. Production builds stop when required settings are missing or invalid.
Keep credentials in your secret manager. The deployment file contains identifiers, not secrets.

```mermaid
flowchart LR
    Browser[Owner browser] --> Access[Cloudflare Access]
    Agent[Agent API client] --> Access
    Access --> Worker[Worker and static interface]
    Worker --> D1[D1 records and history]
    Worker --> R2[Private R2 files]
```

The Worker checks signed Access tokens before serving pages, API responses, or files.
Production disables local authentication, `workers.dev`, and preview URLs.
An owner deploys one shared collection. The application has no separate roles or collections for different users.
Every permitted user and agent can read, edit, and delete collection data.

## Agents and API

Set `INVENTORY_URL` to your HTTPS origin, such as `https://inventory.example.com`.
Inject `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` through your secret manager.

```sh
node scripts/inventory.mjs list
node scripts/inventory.mjs get ITEM_UUID
node scripts/inventory.mjs create < item.json
node scripts/inventory.mjs export /absolute/path/to/new-backup
```

Read [the API guide](docs/API.md) before editing records.
Read the current revision, preserve unrelated fields, and add evidence links for purchase details.
Leave unknown prices and places empty. Use stable UUIDs when retrying creation.

The project has no built-in email scanning or store login integration.
An external agent can collect purchase details and submit them through the API.

## Cost

No scheduled jobs, containers, or continuously running server are required.
Idle deployments consume storage. Account subscriptions, domain registration, and storage above included allowances can still incur charges.
Traffic adds Worker, D1, and R2 operations. Free allowances depend on your account and plan.
Browser uploads resize photos to 1,600 pixels and encode WebP to reduce storage.

Check current pricing for [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/), and
[Access](https://www.cloudflare.com/plans/zero-trust-services/).

## Development

```sh
npm run check
npm test
npm run build:local
```

Tests use a temporary database and file store. They do not use production credentials or inventory.
Production builds use `npm run build` after you configure your deployment.
The CLI packages are pinned in `package-lock.json`. The `cf` CLI currently uses a beta release.

Use [the contribution guide](CONTRIBUTING.md) for changes and [the security guide](SECURITY.md) for access boundaries.
The original layout samples remain in `design-preview/` and contain synthetic records.
The MIT [license](LICENSE) permits use, modification, and deployment.

Existing exports retain the `kriger-home-v1` format identifier for compatibility.
