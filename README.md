# WCAT Sales Support — Cloudflare Workers

Cloudflare migration of the WCAT Sales Support frontend. Phase 3–4 moves authentication to Cloudflare Workers + D1 while business-data APIs remain on the migration backlog.

## Current architecture

- Static UI: `public/index.html`
- Worker entry: `src/index.js`
- D1 binding: `DB` → `wcat-sales-db`
- Auth tables: `users`, `sessions`
- Session cookie: `wcat_session` (`HttpOnly`, `Secure`, `SameSite=Lax`)
- Auth endpoints:
  - `POST /api/auth/login`
  - `GET /api/auth/me`
  - `POST /api/auth/logout`
  - `POST /api/auth/change-password`

## Test locally

```bash
npm test
```

## Apply D1 migration to production

The D1 database is already bound as `DB` in `wrangler.jsonc`.

```bash
npx wrangler d1 migrations apply wcat-sales-db --remote
```

Verify in the Cloudflare D1 dashboard that `users` and `sessions` exist.

## Create the first user

Do not commit real credentials. Generate a one-time SQL insert locally:

```bash
node scripts/generate-user-sql.mjs \
  --user-id USR-0001 \
  --name "Your Name" \
  --email "your.name@company.com" \
  --role ADMIN \
  --scope ALL \
  --password "A-Temporary-Password"
```

The command prints only the PBKDF2 verifier fields, not the plaintext password. Copy the generated `INSERT INTO users ...` statement into **Cloudflare → D1 → wcat-sales-db → Console** and run it. The account starts with `must_change_password = 1`, so the UI forces a password change after the first login.

## Deploy

Push to `main`. Cloudflare Builds is connected to `MaDeaw111/Sales-support-app` and deploys with:

```bash
npx wrangler deploy
```

## Verify after deploy

Open:

```text
https://wcat-sales-support.deono111.workers.dev/api/health
```

Then open the root URL and sign in with the first-user credentials. Login should set an HttpOnly cookie and, for a new user, immediately open the forced password-change dialog.

## Phase boundary

`/api/gateway` is intentionally still not migrated. Customer, Product, Pricing, PO, DI/Shipping, Payment, Commission, and user-management write actions are handled in later phases. The dashboard continues using prototype state until master-data migration is implemented.
