# WCAT Sales Support - Cloudflare Phase 1-2

This project wraps the existing WCAT Sales Support frontend in Cloudflare Workers Static Assets and adds the first Worker API endpoint.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL printed by Wrangler. Verify the Worker API at `/api/health`.

## Test

```bash
npm test
```

## Deploy

```bash
npx wrangler login
npm run deploy
```

## Phase 1-2 limitation

The UI is preserved, but authentication and most backend actions still belong to the Google Apps Script implementation. There is intentionally no login bypass. `/api/gateway` returns HTTP 501 until those actions are migrated in later phases.
