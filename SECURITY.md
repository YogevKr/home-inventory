# Security

This application stores private data. Deploy it behind Cloudflare Access and keep the R2 bucket private.
Every permitted user and agent has full access to the collection, including permanent deletion.
The application does not separate tenants or provide read-only roles.

The Worker verifies Access signatures, issuer, audience, and expiry.
Local authentication applies only to HTTP requests addressed to localhost in development mode.
Do not expose the development server to other machines or deploy a development build.

Keep credentials, exports, and personal records outside the public repository.
Report vulnerabilities through GitHub's private vulnerability reporting feature on this repository.
Do not post credentials or private inventory in public issues.

No independent security audit has been completed. Review changes before deploying them to your own account.

Public sharing is optional. Its Access exception must cover only `/share/*` on the inventory hostname.
The Worker serves only share pages, their selected photos, and their stylesheet without authentication.
The remaining collection, API, static assets, and original files still require a verified Access token.
Never add a Bypass policy to the main inventory application.

Share pages contain allowlisted snapshots and metadata-free photo copies. Owners can revoke links or set expiry dates.
Deletion invalidates all links for that purchase. Public responses disable caching and scripts and request search exclusion.
Links use 256 random bits. Anyone with a link can save or forward its content.
Revocation stops future access but cannot withdraw external copies. Treat share URLs as access credentials.
