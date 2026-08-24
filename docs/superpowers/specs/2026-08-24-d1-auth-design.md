# WCAT D1 Authentication Design

## Scope

Phase 3-4 migrates only authentication from Google Apps Script to Cloudflare Workers + D1. Customer, Product, Pricing, PO, DI, Payment, Commission, and other business-data APIs remain out of scope.

## Architecture

The browser submits authentication requests to same-origin Worker routes. The Worker stores users and sessions in D1 via the `DB` binding. Successful login creates a cryptographically random session token, stores only its SHA-256 hash in D1, and returns the raw token only in an `HttpOnly; Secure; SameSite=Lax` cookie named `wcat_session`.

## Data Model

### `users`

Stores user identity, RBAC role, account status, password verifier fields, and the forced-password-change flag. Passwords use PBKDF2-SHA-256 with a per-user random salt and 210,000 iterations.

Required roles remain: `ADMIN`, `MANAGER`, `SALES_SUPPORT`, `EXTERNAL_SALES`, `EXPORT`, `PRODUCTION_WAREHOUSE`.

### `sessions`

Stores `session_id`, `user_id`, SHA-256 token hash, expiry, creation/last-seen timestamps, user agent, and optional connecting IP. Session lifetime is 12 hours.

## HTTP API

- `POST /api/auth/login` accepts `{email,password}` and returns `{status:'SUCCESS',data:{user}}` plus `Set-Cookie`.
- `GET /api/auth/me` validates the cookie and returns `{status:'SUCCESS',data:{valid:true,user}}`; invalid/expired sessions return 401.
- `POST /api/auth/logout` deletes the active session and clears the cookie; it is idempotent.
- `POST /api/auth/change-password` requires an active session and `{current_password,new_password}`. It verifies the current password, requires at least 8 characters for the new password, updates the password verifier, clears `must_change_password`, and revokes all other sessions for the user.

## Frontend

`submitLogin`, `bootstrapAuth`, `submitPasswordChange`, and `signOut` stop using `google.script.run` and use the same-origin Auth API. Authentication no longer stores a session token in `localStorage`.

The existing Cloudflare `/api/gateway` remains deliberately unimplemented. After successful auth, `startAuthenticatedApp()` renders the current prototype state and does not surface a blocking alert merely because Phase 5 master-data migration has not happened yet.

## Provisioning

No real user credentials are committed to the public repository. The migration creates schema only. A separate local helper script generates a one-user SQL INSERT with PBKDF2 verifier fields for manual execution in the Cloudflare D1 Console.

## Security Constraints

- No plaintext passwords in D1 or Git.
- No raw session tokens in D1.
- Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
- Backend role/status checks remain authoritative; frontend RBAC is presentation only.
- Disabled users cannot log in or continue sessions.
