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
