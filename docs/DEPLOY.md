# Deploy to Cloudflare

Deploy a separate instance in your own account. All permitted identities share one collection with full edit access.
The public repository contains no hosted inventory service or shared credentials.

## 1. Prepare your account

You need Node 24.10 or later, npm, a Cloudflare account, and a domain managed by Cloudflare.
Enable R2 and Cloudflare Zero Trust. Review the account's billing requirements before enabling services.

Install dependencies and sign in with the Cloudflare CLI:

```sh
npm ci
npx cf auth login
```

OAuth opens a browser. You can also use a Cloudflare API token from your secret manager.
Authorize Worker deployment, D1, R2, and the target domain. Restrict the token to the required account and zone.
Use `--profile PROFILE` on authenticated commands if you use a named `cf` profile.

Copy your account ID from the Cloudflare dashboard. Account IDs are not secret credentials.

## 2. Create storage

Choose resource names that do not conflict with existing resources.
Replace `YOUR_ACCOUNT_ID` in these commands:

```sh
CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID npx cf d1 create --name home-inventory --mode development
CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID npx cf r2 buckets create --name home-inventory-files --mode development
```

These commands create remote resources. `--mode development` permits initial setup before your deployment file exists.
Only commands with `--local` use local storage.

Record the D1 database UUID. Keep the R2 bucket private.
Do not enable its `r2.dev` address or add a public bucket domain.
This setup uses the default R2 jurisdiction. Jurisdiction-specific buckets need matching binding changes.

## 3. Protect the hostname

In Zero Trust, create a self-hosted Access application for your complete inventory hostname.
For example, use `inventory.example.com` with no path restriction.
Protect every path, including `/api/*` and file requests.

Create an **Allow** policy that includes only the owner's email addresses.
Enable the email one-time PIN provider. Avoid an Everyone rule or Bypass policy.
Copy the application's audience tag, called AUD, and your Access team URL.
The team URL has the form `https://YOUR_TEAM.cloudflareaccess.com`.

### Optional Google login

Create a dedicated Google Cloud project or use one you control.
Configure its OAuth consent screen and create a Web application OAuth client.
Use these addresses, with your own team name:

| Setting | Value |
| --- | --- |
| Authorized origin | `https://YOUR_TEAM.cloudflareaccess.com` |
| Redirect URI | `https://YOUR_TEAM.cloudflareaccess.com/cdn-cgi/access/callback` |

Add the client ID and client secret to a Google identity provider in Cloudflare Zero Trust.
Enable that provider for the Access application. Keep the owner email policy in place.
If Google keeps the app in Testing mode, add each permitted owner as a test user.
This login uses basic identity scopes. It does not grant Gmail or Drive access.
Keep OAuth secrets in Cloudflare and your secret manager, outside this repository.

## 4. Configure the deployment

```sh
cp deployment.example.json deployment.local.json
```

Replace every example value:

| Field | Source |
| --- | --- |
| `accountId` | Cloudflare account ID |
| `workerName` | Your chosen Worker name |
| `databaseName` | D1 database name from step 2 |
| `databaseId` | D1 UUID from step 2 |
| `bucketName` | Private R2 bucket name from step 2 |
| `hostname` | Complete Access-protected hostname from step 3 |
| `accessIssuer` | Access team URL, with no trailing slash |
| `accessAudience` | Access application's AUD tag |

Git ignores `deployment.local.json`. Keep a private copy for deployment and recovery.
No value in this file should contain a password, API token, or OAuth secret.
You can change the display name in `public/index.html` and the icon in `public/favicon.svg`.

## 5. Migrate and deploy

Verify that the account, database, bucket, and hostname belong to your intended instance.
Replace `YOUR_D1_DATABASE_ID` with the UUID in your deployment file:

```sh
npm run check
npm test
npx cf d1 migrations apply YOUR_D1_DATABASE_ID --dir migrations
npm run build
npx cf deploy --prebuilt
```

Keep the Access application active before deploying the hostname.
The production configuration sets `DEV_AUTH=false` and disables `workers.dev` and preview URLs.
Never deploy a development build. Run `npm run build` immediately before `cf deploy --prebuilt`.
The CLI binds the Worker to your D1 database and R2 bucket and configures the custom hostname.

## 6. Verify access

Open the hostname in a signed-out browser. It must show the Access login screen.
Sign in with an allowed owner account. Create an item, upload a photo, and export the collection.
Check that a signed-out request to `/api/bootstrap` also requires login.
Confirm that the R2 bucket still has no public domain.

If login succeeds but the app returns HTTP 401, check the issuer and AUD values.
If storage fails, check resource IDs and applied migrations.
An unexpected login redirect in the agent CLI usually means its Access policy or service token is incorrect.

## 7. Add agent access

Create an Access service token dedicated to this inventory.
Add a **Service Auth** policy that includes only that token, scoped to the same application.
Keep the browser **Allow** policy. Do not use Bypass for agents.

Store the client ID and client secret in your secret manager.
Inject these values only into the command that needs them:

| Environment variable | Value |
| --- | --- |
| `INVENTORY_URL` | Your full HTTPS origin |
| `CF_ACCESS_CLIENT_ID` | Service token client ID |
| `CF_ACCESS_CLIENT_SECRET` | Service token secret |

Run `node scripts/inventory.mjs places` to test access.
The token grants full collection access, including deletion. Set an expiry and rotate it when needed.
The CLI refuses remote HTTP and does not follow redirects with credential headers.

## Updates and backups

Export records and files before applying changes or database migrations.
Keep backup directories outside version control. Exports contain private inventory and attachments.
The project has no scheduled backup or automatic backup restore command.
D1 Time Travel does not back up R2 files. Plan recovery for both resources.

Keep your deployment repository private if it includes owner notes or instance-specific settings.
Use the public repository as the source of application updates.
Review updates in a branch, run checks, apply new migrations, build, and deploy with your existing identifiers.
Never replace your existing database or bucket just to update the application.
