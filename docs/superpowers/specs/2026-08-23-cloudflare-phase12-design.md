# WCAT Cloudflare Phase 1-2 Design

## Goal
Run the existing WCAT Sales Support frontend as Cloudflare Worker Static Assets and add a minimal Worker API surface without migrating business data or authentication yet.

## Scope
- Preserve the existing `Index(1).html` UI and frontend business logic.
- Serve the frontend from Cloudflare Workers Static Assets.
- Add `GET /api/health` returning JSON so frontend-to-Worker connectivity can be verified.
- Add an asset fallback through `env.ASSETS.fetch(request)` for non-API requests handled by the Worker.
- Prepare a browser `callBackend()` adapter to use `fetch('/api/gateway')`, but do not switch existing direct `google.script.run` authentication/user-management calls in this phase.
- Do not create D1 tables or migrate Google Sheets data in Phase 1-2.

## Architecture
Browser requests static files from the Worker static-assets binding. Requests under `/api/*` run through `src/index.js` first. `/api/health` is implemented now. `/api/gateway` returns a clear `501 NOT_IMPLEMENTED` response until the backend actions are migrated in later phases.

## Safety / Compatibility
- No mock login bypass.
- Existing Apps Script-specific login remains visibly unavailable when hosted outside Apps Script until the Auth migration phase.
- Preserve the current `status` / `data` / `message` response convention so later migration can minimize frontend rewrites.

## Verification
- Automated tests verify health JSON, gateway 501 behavior, and asset fallback.
- `npm test` must pass.
- Wrangler configuration must point to `./public` with an `ASSETS` binding and run Worker first for `/api/*`.
