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

`/api/gateway` is intentionally still not migrated. Product, Pricing, PO, DI/Shipping, Payment, Commission, and user-management write actions are handled in later phases. The dashboard continues using prototype state except for Customers, which is backed by D1.

## Phase 5A — Customer CRM D1 Migration and Deployment Runbook

### 1. Remote D1 Migration
To apply the database schema changes to the remote production D1 instance:

```bash
npx wrangler d1 migrations apply wcat-sales-db --remote
```

### 2. Expected Migrations Applied
- `0002_customers.sql` (Creates `customers` and `customer_contacts` tables, indexes, and initial data).

### 3. Verification SQL
After migration, verify the schema and tables in the Cloudflare D1 console with:

```sql
SELECT name
FROM sqlite_master
WHERE type = 'table'
  AND name IN ('customers', 'customer_contacts');

SELECT COUNT(*) AS customer_count FROM customers;
```

### 4. Production Smoke Test Checklist
- **Login as ADMIN** and confirm successful authentication.
- **Open Customer / CRM** menu item from the sidebar.
- **Add one test customer** using the "เพิ่มลูกค้าใหม่" button.
- **Refresh the browser** and confirm the added customer is still displayed.
- **Edit country/contact** details for the customer.
- **Refresh the browser again** and confirm that changes persist.
- **Confirm Dashboard customer count** updates dynamically based on the active D1-backed customers count.
- **Login as EXTERNAL_SALES** and verify they can see their owned customers only.
- **Verify EXTERNAL_SALES** cannot see or invoke usable Customer Add/Edit controls in the UI.

### 5. Rollback Instructions
- Redeploy the previous Worker deployment from the Cloudflare panel (or git deployment history).
- **Do NOT drop** the additive customer tables (`customers`, `customer_contacts`) to preserve any live customer details entered during post-deployment.
