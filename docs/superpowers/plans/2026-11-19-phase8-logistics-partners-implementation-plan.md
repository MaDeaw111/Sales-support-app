# Phase 8 — Logistics Partners Implementation Plan

**Goal:** Migrate Logistics Partners from frontend prototype mock arrays to D1 by extending Phase 6's `service_partners` table with full profile management, an additive `service_partner_rates` reference rate table, and live Phase 6 usage history.

**Architecture:** Add `migrations/0008_logistics_partners.sql` (`service_partner_rates` + index) and a focused `src/logistics-partners/` module (`validation.js`, `repository.js`, `routes.js`) wired to `/api/logistics-partners` in `src/index.js`. Keep Phase 6's `/api/service-partners` routes untouched for zero regression. Replace mock Logistics Partners UI functions in `public/index.html` with D1-backed loaders, directory, detail tabs (Profile, Rate History, Usage History), and create/edit modals.

**Tech Stack:** JavaScript ES modules; Cloudflare Workers; Cloudflare D1 (`migrations/0001`–`0008`); HTML + inline JS in `public/index.html`; Node built-in test runner (`node --test`) + `node:sqlite` test database; Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-11-19-phase8-logistics-partners-design.md`

---

## Baseline & Constraints

- Baseline: `main` @ `60088be` (`npm test`: 334 passed, 0 failed).
- Additive migration only: `migrations/0008_logistics_partners.sql` creates `service_partner_rates` and indexes without modifying `0001`–`0007` or altering `service_partners`.
- Do not modify Phase 6 `/api/service-partners` validation/routes or break any existing Phase 6 tests.
- All implementation work occurs on a dedicated feature branch (`feature/phase8-logistics-partners`) via TDD (red → green → full test suite), then PR → preview → merge → remote D1 migration (`npx wrangler d1 migrations apply wcat-sales-db --remote`) → production deploy → smoke test.
- No hard deletes on partners or rates (deactivate via `status = 'INACTIVE'`).

---

## Planned File Structure

```text
migrations/0008_logistics_partners.sql             additive service_partner_rates table + indexes
src/logistics-partners/validation.js               partner profile & rate payload validation helpers
src/logistics-partners/repository.js               D1 persistence (service_partners, service_partner_rates, live Phase 6 usage queries)
src/logistics-partners/routes.js                   /api/logistics-partners REST handlers + strict RBAC enforcement
src/index.js                                       dispatch /api/logistics-partners to createLogisticsPartnersHandlerFromEnv
public/index.html                                  D1-backed Logistics Partners directory, detail tabs, and modals
test/logistics-partners.migration.test.js          0008 migration constraint tests (FK, price > 0, currency, valid_until >= effective_date)
test/logistics-partners.repository.test.js         repository CRUD, SP-XXX ID compatibility with Phase 6, rate CRUD, live Phase 6 usage history
test/logistics-partners.routes.test.js             auth, validation, CRUD routes, and strict RBAC (401/403 across all 6 roles)
test/frontend-adapter.test.js                      regression tests verifying /api/logistics-partners usage and zero mock logisticsProviders reads
```

---

## Task Breakdown

### Task 1 — Additive D1 Migration (`migrations/0008_logistics_partners.sql`)
- [ ] Write failing migration tests in `test/logistics-partners.migration.test.js` covering:
  - Applying `0001`–`0008` in order succeeds cleanly.
  - `service_partner_rates` enforces FK to `service_partners(partner_id)`, `price > 0`, `currency IN ('THB','USD','EUR')`, `container_size` allowlist, `status IN ('ACTIVE','INACTIVE')`, and `valid_until IS NULL OR valid_until >= effective_date`.
  - Existing `service_partners` rows remain intact.
- [ ] Create `migrations/0008_logistics_partners.sql`.
- [ ] Run migration tests and confirm GREEN.

### Task 2 — Validation Helpers (`src/logistics-partners/validation.js`)
- [ ] Write failing validation unit tests in `test/logistics-partners.routes.test.js` covering:
  - Partner create & update payload allowlists (rejects unknown properties, blank `partnerName`, invalid `partnerType`/`status`, malformed `contactEmail`).
  - Rate create & patch payload allowlists (rejects `price <= 0`, >2 decimal places, invalid currency/containerSize/status, invalid ISO dates, `validUntil < effectiveDate`).
- [ ] Implement `src/logistics-partners/validation.js`.
- [ ] Confirm validation tests pass.

### Task 3 — D1 Repository (`src/logistics-partners/repository.js`)
- [ ] Write failing repository tests in `test/logistics-partners.repository.test.js` on a real migrated D1 fixture (`0001`–`0008`) covering:
  - `createPartner`: inserts into `service_partners` with `SP-XXX` ID compatible with Phase 6 `createServicePartner`, persists full profile (`contact_name`, `contact_phone`, `contact_email`, `address`, `tax_id`, `note`).
  - `updatePartner`: updates profile/status, rejects `partnerType` changes (`SERVICE_PARTNER_TYPE_IMMUTABLE`), returns `SERVICE_PARTNER_NOT_FOUND` for unknown ID.
  - `listPartners`: filters by `partnerType`, `status`, and `search`; returns accurate `active_rate_count` and live non-cancelled `usage_count`.
  - `createRate` & `updateRate`: generates `SPR-XXXX` IDs, persists/updates/deactivates rates, validates merged `validUntil >= effectiveDate`, enforces `partner_id` ownership.
  - `getPartnerDetail`: returns `{ partner, rates, usage }` where `usage` accurately queries live Phase 6 `delivery_instructions` (`surveyor_partner_id`, `forwarder_partner_id`) and `phase6_shipments` (`forwarder_partner_id`, `shipping_line_partner_id`, `trucking_partner_id`), excludes `CANCELLED` DIs/shipments, deduplicates when the same partner is forwarder on both DI and Shipment, and includes `actual_container_count`.
- [ ] Implement `createLogisticsPartnersRepository(db)` in `src/logistics-partners/repository.js`.
- [ ] Confirm repository tests pass.

### Task 4 — API Routes & Strict RBAC (`src/logistics-partners/routes.js` & `src/index.js`)
- [ ] Write failing route & RBAC tests in `test/logistics-partners.routes.test.js` covering:
  - `401` for unauthenticated requests on all endpoints.
  - `403` for `EXTERNAL_SALES` and `PRODUCTION_WAREHOUSE` on ALL read and write endpoints.
  - `SALES_SUPPORT`: `200` on `GET /api/logistics-partners` and `GET /api/logistics-partners/:id`; `403` on `POST`/`PUT`/`PATCH` mutations.
  - `ADMIN`, `MANAGER`, `EXPORT`: full read + partner create/update + rate create/update lifecycle (`200`/`400`/`404`).
  - Cross-compatibility test: partner created via `POST /api/logistics-partners` is immediately returned by Phase 6 `GET /api/service-partners`, and partner created via Phase 6 `POST /api/service-partners` is immediately returned by `GET /api/logistics-partners`.
  - Worker dispatch test in `src/index.js` (`503` without `DB` binding).
- [ ] Implement `src/logistics-partners/routes.js` and wire `/api/logistics-partners` in `src/index.js`.
- [ ] Confirm all backend tests pass.

### Task 5 — Frontend Logistics Partners Migration (`public/index.html`)
- [ ] Write failing frontend adapter tests in `test/frontend-adapter.test.js` asserting:
  - `loadLogisticsPartnersFromApi()` fetches `/api/logistics-partners` and populates `state.logisticsPartners`.
  - `saveLogisticsPartnerToApi()` submits `POST /api/logistics-partners` (create) or `PUT /api/logistics-partners/:id` (edit).
  - `saveLogisticsPartnerRateToApi()` submits `POST /api/logistics-partners/:id/rates` (create) or `PATCH /api/logistics-partners/:id/rates/:rateId` (edit/toggle).
  - Logistics Partners directory & detail renderers never read mock `state.logisticsProviders`, `state.providerPrices`, or `state.providerUsageRecords`.
  - Role-aware UI: hides Add/Edit controls for `SALES_SUPPORT`; shows them for `ADMIN`, `MANAGER`, `EXPORT`.
- [ ] Implement the D1-backed Logistics Partners directory, detail view (Profile / Rate History / Usage History tabs), and modals in `public/index.html`, supporting all 4 canonical types (`FORWARDER`, `SHIPPING_LINE`, `TRUCKING`, `SURVEYOR`).
- [ ] Verify inline `<script>` syntax and frontend adapter tests pass.

### Task 6 — Full Verification, Review & Release Runbook
- [ ] Run full test suite (`npm test`) and confirm 0 failures and zero regressions in Phase 5E/5F/6/7 suites.
- [ ] Self-review SQL constraints, RBAC enforcement, HTML escaping, and Phase 6 cross-compatibility.
- [ ] Push `feature/phase8-logistics-partners` and open PR for review.
- [ ] After PR merge, apply remote D1 migration (`npx wrangler d1 migrations apply wcat-sales-db --remote`), verify `service_partner_rates` table in production, run production smoke test across roles, and update `docs/PROJECT_STATUS.md`.
