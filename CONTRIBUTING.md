# Contributing

Use Node 24.10 or later and `npm ci`. Keep the npm lockfile current when dependencies change.
Create a branch for each change. Use synthetic records in tests, screenshots, and issue reports.

Run these checks before opening a pull request:

```sh
npm run check
npm test
npm run build:local
git diff --check
```

Inspect interface changes in a local browser at desktop and narrow widths.
Add behavior tests when changing data writes, authentication, or deployment settings.
Document public API changes in `docs/API.md`.
Add a numbered SQL migration for database changes. Preserve earlier migrations.

Do not commit deployment files, credentials, backups, order records, receipts, or personal screenshots.
Do not connect tests to a live inventory.
Use Conventional Commit titles, such as `feat: add a place filter`.

Contributions use the repository's MIT license.
