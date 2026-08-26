# Phase 5E — Simple Commercial & Shipment Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Phase 5E Manager Price Note, Freight Quote, Shipment Actual Cost, Freight Variance, and Shipment Document Link workflows using the existing Cloudflare Worker + D1 architecture.

**Architecture:** Extend the existing modular Worker/D1 architecture with focused Phase 5E repositories/routes while reusing current Auth, Customer, User/Sales, Product, and existing frontend adapter patterns. Keep confirmed sale history owned by PO, actual costs owned by Shipment, and Google Drive files external with URL references only.

**Tech Stack:** Cloudflare Workers, D1/SQLite, JavaScript, existing HTML/JavaScript frontend, Node.js test runner as currently configured.

**Spec:** docs/superpowers/specs/2026-08-26-phase5e-commercial-shipment-control-design.md

---

## Global Constraints

- Do not build a full Pricing Engine.
- Selling Price is USD/MT only.
- Freight Quote is USD/Container only.
- FX is used only for actual Shipment USD expenses.
- Supported actual-expense currencies are THB and USD only.
- Ocean Freight must remain separate from BL/THC/Seal/local charges.
- Confirmed sale price remains owned by PO.
- Shipment documents store Google Drive links only.
- Do not introduce Cloudflare R2.
- IR and LC are separate document types.
- Multiple links per Shipment document type are allowed.
- Do not add Quantity to Manager Price Note.
- Do not add Margin, FX Master, price approvals, or automatic selling-price calculation.
- Follow existing RBAC architecture.
- Preserve existing production behavior.
- Existing regression tests must continue passing.
- Use TDD for implementation tasks.
- Prefer frequent small commits.
- Avoid unrelated refactoring.

---

## Relational Anchor Scope Boundary
* **Discovery:** Purchase Orders (POs) and Shipments currently exist only as frontend mock arrays inside `public/index.html` and have no D1 database backing.
* **Scope Boundary Rules:**
  1. This phase is **NOT** a full migration of PO Management or Shipment Readiness. Do not replace all existing mock PO/Shipment frontend workflows.
  2. Minimal D1 tables `pos` and `shipments` will be created **strictly** as database relational anchors for Phase 5E commercial features (Shipment expenses, document links, Freight Quote references, and Shipment Detail Cost/Doc tabs).
  3. No downstream business workflows (e.g. stuffing status, trucking provider assignments, etc.) are migrated.
  4. For testing and integration, minimal records will be seeded/created dynamically in the `pos` and `shipments` tables.

---

## File Structure / Responsibility Map

We will create and modify the following files:

### New Modules
* `src/price-notes/repository.js`: Manages SQLite operations for `manager_price_notes` and `freight_quotes`.
* `src/price-notes/routes.js`: Maps HTTP routes under `/api/manager-price-notes` and `/api/freight-quotes`.
* `src/shipments/repository.js`: Manages SQLite operations for `pos`, `shipments`, `expense_categories`, `shipment_document_links`, and `shipment_expenses`.
* `src/shipments/routes.js`: Maps HTTP routes under `/api/expense-categories`, `/api/shipments`, `/api/shipment-expenses`, and `/api/shipment-documents`.

### Modified Modules
* `src/index.js`: Composition and routing. Matches prefix paths and delegates to the price-notes and shipments handlers.
* `public/index.html`: UI views for Pricing, Freight Quotes, and Shipment Detail tabs (Overview, Costs, Documents).

### New Regression/Integration Tests
* `test/commercial-migration.test.js`
* `test/manager-price-notes.repository.test.js`
* `test/manager-price-notes.routes.test.js`
* `test/freight-quotes.repository.test.js`
* `test/freight-quotes.routes.test.js`
* `test/expense-categories.test.js`
* `test/shipment-documents.repository.test.js`
* `test/shipment-documents.routes.test.js`
* `test/shipment-expenses.repository.test.js`
* `test/shipment-expenses.routes.test.js`
* `test/freight-variance.test.js`
* `test/frontend-pricing-shipment-adapter.test.js` (frontend adapter regression tests)

---

## Implementation Tasks

### [ ] Task 1 — D1 Migration & Database Setup
* **Files:** 
  * Create `migrations/0004_commercial_shipment_control.sql`
  * Create `test/commercial-migration.test.js`
* **Interfaces:**
  * Consumes: D1 execute / SQLite constraints engine
  * Produces: SQLite tables with foreign keys and checks:
    * `pos`
    * `shipments`
    * `expense_categories`
    * `manager_price_notes`
    * `freight_quotes`
    * `shipment_document_links`
    * `shipment_expenses`
* **Schema Specifications & Database Constraints:**
  * `pos`: `po_id` PRIMARY KEY, `customer_id` NOT NULL REFERENCES `customers(customer_id)`, `product_id` NOT NULL REFERENCES `products(product_id)`, `incoterm` TEXT CHECK(incoterm IN ('FOB', 'CFR', 'CIF')) NOT NULL, `destination_port` TEXT.
  * `shipments`: `shipment_id` PRIMARY KEY, `po_id` NOT NULL REFERENCES `pos(po_id)`, `freight_quote_id` REFERENCES `freight_quotes(quote_id)`, `is_one_container` INTEGER CHECK(is_one_container IN (0, 1)) DEFAULT 1.
  * `expense_categories`: `category_id` PRIMARY KEY, `category_code` TEXT UNIQUE NOT NULL, `category_name` TEXT NOT NULL, `category_group` TEXT CHECK(category_group IN ('OCEAN_FREIGHT', 'SHIPPING_LOCAL', 'TRANSPORT', 'DOCUMENT', 'INSURANCE', 'OTHER')) NOT NULL, `status` TEXT CHECK(status IN ('ACTIVE', 'INACTIVE')) DEFAULT 'ACTIVE'.
  * `manager_price_notes`: `note_id` PRIMARY KEY, `sales_user_id` TEXT NOT NULL REFERENCES `users(user_id)`, `customer_id` TEXT NOT NULL REFERENCES `customers(customer_id)`, `product_id` TEXT NOT NULL REFERENCES `products(product_id)`, `incoterm` TEXT CHECK(incoterm IN ('FOB', 'CFR', 'CIF')) NOT NULL, `destination_port` TEXT, `offer_price_usd_per_mt` REAL CHECK(offer_price_usd_per_mt > 0) NOT NULL, `note` TEXT, `created_by_manager_id` TEXT NOT NULL REFERENCES `users(user_id)`, `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK (incoterm = 'FOB' OR (incoterm IN ('CFR','CIF') AND destination_port IS NOT NULL AND trim(destination_port) <> '')).
  * `freight_quotes`: `quote_id` PRIMARY KEY, `origin_port` TEXT NOT NULL CHECK(trim(origin_port) <> ''), `destination_port` TEXT NOT NULL CHECK(trim(destination_port) <> ''), `container_size` TEXT NOT NULL CHECK(trim(container_size) <> ''), `shipping_line_or_forwarder` TEXT NOT NULL CHECK(trim(shipping_line_or_forwarder) <> ''), `quoted_freight_usd_per_container` REAL CHECK(quoted_freight_usd_per_container > 0) NOT NULL, `valid_until` TEXT, `remark` TEXT, `created_by` TEXT NOT NULL REFERENCES `users(user_id)`, `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP.
  * `shipment_document_links`: `link_id` PRIMARY KEY, `shipment_id` NOT NULL REFERENCES `shipments(shipment_id) ON DELETE CASCADE`, `document_type` TEXT CHECK(document_type IN ('PO', 'DI', 'BOOKING', 'STUFFING_REPORT', 'ALL_SHIP_DOC', 'IR', 'LC')) NOT NULL, `title` TEXT NOT NULL, `drive_url` TEXT CHECK(drive_url LIKE 'http://%' OR drive_url LIKE 'https://%') NOT NULL, `reference_no` TEXT, `remark` TEXT, `created_by` TEXT, `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, `updated_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP.
  * `shipment_expenses`: `expense_id` PRIMARY KEY, `shipment_id` NOT NULL REFERENCES `shipments(shipment_id) ON DELETE CASCADE`, `expense_category_id` NOT NULL REFERENCES `expense_categories(category_id)`, `amount` REAL CHECK(amount > 0) NOT NULL, `currency` TEXT CHECK(currency IN ('THB', 'USD')) NOT NULL, `fx_used` REAL CHECK(fx_used > 0), `amount_thb` REAL CHECK(amount_thb > 0) NOT NULL, `reference_no` TEXT, `shipment_document_link_id` REFERENCES `shipment_document_links(link_id) ON DELETE SET NULL`, `remark` TEXT, `created_by` TEXT, `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, `updated_by` TEXT, `updated_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK ((currency = 'THB' AND fx_used IS NULL) OR (currency = 'USD' AND fx_used IS NOT NULL AND fx_used > 0)).
* **TDD Process Steps:**
  * [ ] **Step 1:** Write a failing test in `test/commercial-migration.test.js` checking that the tables and constraints (e.g. rejecting `quoted_freight_usd_per_container = 0`) behave as defined.
    ```javascript
    test('D1 constraints enforced', async () => {
      const { db } = await setupTestDb();
      // USD expense with NULL FX must fail
      assert.throws(() => {
        db.prepare("INSERT INTO shipment_expenses (expense_id, shipment_id, expense_category_id, amount, currency, fx_used, amount_thb) VALUES ('E1', 'S1', 'C1', 100, 'USD', NULL, 3500)").run();
      }, /constraint failed/);
      // THB expense with FX must fail
      assert.throws(() => {
        db.prepare("INSERT INTO shipment_expenses (expense_id, shipment_id, expense_category_id, amount, currency, fx_used, amount_thb) VALUES ('E2', 'S1', 'C1', 100, 'THB', 35, 100)").run();
      }, /constraint failed/);
      // CFR Price Note without destination port must fail
      assert.throws(() => {
        db.prepare("INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, destination_port, offer_price_usd_per_mt, created_by_manager_id) VALUES ('N1', 'U1', 'C1', 'P1', 'CFR', NULL, 300, 'U2')").run();
      }, /constraint failed/);
      // Price Note missing relationship ids must fail
      assert.throws(() => {
        db.prepare("INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, offer_price_usd_per_mt, created_by_manager_id) VALUES ('N2', NULL, 'C1', 'P1', 'FOB', 300, 'U2')").run();
      }, /NOT NULL constraint failed/);
      // Zero/negative offer price must fail
      assert.throws(() => {
        db.prepare("INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, offer_price_usd_per_mt, created_by_manager_id) VALUES ('N3', 'U1', 'C1', 'P1', 'FOB', 0, 'U2')").run();
      }, /constraint failed/);
    });
    ```
  * [ ] **Step 2:** Run `node --test test/commercial-migration.test.js` and verify it fails (expected table-not-found or check-constraint-not-enforced).
  * [ ] **Step 3:** Implement the DDL file `migrations/0004_commercial_shipment_control.sql` containing the D1 migrations and tables.
  * [ ] **Step 4:** Run targeted test again and verify it passes.
  * [ ] **Step 5:** Run overall regression test group `npm test`.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 1 - implement D1 database migration and constraints verification"`

### [ ] Task 2 — Expense Category Master Setup
* **Files:**
  * Modify `migrations/0004_commercial_shipment_control.sql` (Add INSERT scripts)
  * Create `test/expense-categories.test.js`
  * Create repository helper in `src/shipments/repository.js`
* **Interfaces:**
  * Consumes: D1 DB
  * Produces: array of categories `listExpenseCategories() => Promise<Array>`
  * DTO shape: `{ id, code, name, categoryGroup, status, sortOrder }`
* **TDD Process Steps:**
  * [ ] **Step 1:** Write a failing test in `test/expense-categories.test.js` that checks for category seeding and listing.
  * [ ] **Step 2:** Run `node --test test/expense-categories.test.js` and verify it fails.
  * [ ] **Step 3:** Add INSERT SQL seeds to `migrations/0004_commercial_shipment_control.sql` and write `listExpenseCategories` in repository.
  * [ ] **Step 4:** Run targeted test and confirm it passes.
  * [ ] **Step 5:** Run overall regression tests.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 2 - seed expense categories and create repository reader"`

### [ ] Task 3 — Manager Price Note Backend
* **Files:**
  * Create `src/price-notes/repository.js`
  * Create `src/price-notes/routes.js`
  * Create `test/manager-price-notes.repository.test.js`
  * Create `test/manager-price-notes.routes.test.js`
* **Interfaces:**
  * Repository:
    * `createPriceNote(dto, creatorId) => Promise<PriceNote>`
    * `listPriceNotes(filters) => Promise<Array<PriceNote>>`
  * API endpoints:
    * `POST /api/manager-price-notes`
      * Payload DTO: `{ salesUserId, customerId, productId, incoterm, destinationPort, offerPriceUsdPerMt, note }`
      * Returns: `200 OK` with `{ status: "SUCCESS", data: { priceNote } }` or `400 Bad Request` / `403 Forbidden`
    * `GET /api/manager-price-notes`
      * Query parameters: `salesUserId`, `customerId`, `productId`
      * Returns: `200 OK` with `{ status: "SUCCESS", data: { priceNotes } }`
  * RBAC rule: Write requires role `ADMIN` or `MANAGER`. Read requires authenticated session.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write failing tests in `test/manager-price-notes.routes.test.js` asserting `SALES_SUPPORT` gets `403` on create, destination port is rejected when blank for `CFR` but allowed for `FOB`, and price notes can be saved by `MANAGER`.
  * [ ] **Step 2:** Run `node --test test/manager-price-notes.routes.test.js` and confirm failure.
  * [ ] **Step 3:** Implement repository and routes modules with the required guards and parameter checks.
  * [ ] **Step 4:** Run targeted tests and confirm success.
  * [ ] **Step 5:** Run all route regressions.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 3 - implement Manager Price Notes backend and RBAC guards"`

### [ ] Task 4 — Freight Quote Backend
* **Files:**
  * Modify `src/price-notes/repository.js`
  * Modify `src/price-notes/routes.js`
  * Create `test/freight-quotes.repository.test.js`
  * Create `test/freight-quotes.routes.test.js`
* **Interfaces:**
  * Repository:
    * `createFreightQuote(dto, creatorId) => Promise<FreightQuote>`
    * `listFreightQuotes() => Promise<Array<FreightQuote>>`
  * API endpoints:
    * `POST /api/freight-quotes`
      * Payload: `{ originPort, destinationPort, containerSize, shippingLineOrForwarder, quotedFreightUsdPerContainer, validUntil, remark }`
      * Returns: `200 OK` or error codes.
    * `GET /api/freight-quotes`
      * Returns: `{ status: "SUCCESS", data: { freightQuotes } }`
  * RBAC rule: Write allowed for `ADMIN`, `MANAGER`, and `SALES_SUPPORT`.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write a failing test in `test/freight-quotes.routes.test.js` verifying that `SALES_SUPPORT` can post freight quotes and that `quotedFreightUsdPerContainer <= 0` throws `400`.
  * [ ] **Step 2:** Run `node --test test/freight-quotes.routes.test.js` and confirm failure.
  * [ ] **Step 3:** Implement Freight Quote repository methods and write route controllers.
  * [ ] **Step 4:** Run targeted tests and verify it passes.
  * [ ] **Step 5:** Run full regression tests.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 4 - implement Freight Quotes repository and API endpoints"`

### [ ] Task 5 — Shipment Foundation & Documents Backend
* **Files:**
  * Create `src/shipments/repository.js`
  * Create `src/shipments/routes.js`
  * Create `test/shipment-documents.repository.test.js`
  * Create `test/shipment-documents.routes.test.js`
* **Interfaces:**
  * Repository:
    * `addShipmentDocumentLink(dto, creatorId) => Promise<DocumentLink>`
    * `listShipmentDocumentLinks(shipmentId) => Promise<Array<DocumentLink>>`
    * `createPoAnchor(dto)` / `createShipmentAnchor(dto)` (internal test helpers)
  * API endpoints:
    * `POST /api/shipments/:id/documents`
      * Payload: `{ documentType, title, driveUrl, referenceNo, remark }`
      * Returns: `200 OK` or `400` / `403`
    * `GET /api/shipments/:id/documents`
      * Returns: `{ status: "SUCCESS", data: { documentLinks } }`
  * Rules: Enforce `driveUrl` starts with `http://` or `https://` on the server before database mutation. Validate document type matches enums.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write failing tests in `test/shipment-documents.routes.test.js` verifying multiple links storage and `driveUrl` validation error (e.g. invalid string `ftp://drive.google.com` gets `400`).
  * [ ] **Step 2:** Run `node --test test/shipment-documents.routes.test.js` and confirm failure.
  * [ ] **Step 3:** Implement repository and routes handler with URL check and dynamic SQLite insertions.
  * [ ] **Step 4:** Run targeted tests and verify it passes.
  * [ ] **Step 5:** Run full regression tests.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 5 - implement Shipment Document Links repository and endpoints"`

### [ ] Task 6 — Shipment Expenses Backend
* **Files:**
  * Modify `src/shipments/repository.js`
  * Modify `src/shipments/routes.js`
  * Create `test/shipment-expenses.repository.test.js`
  * Create `test/shipment-expenses.routes.test.js`
* **Interfaces:**
  * Repository:
    * `addShipmentExpense(dto, creatorId) => Promise<ShipmentExpense>`
    * `listShipmentExpenses(shipmentId) => Promise<Array<ShipmentExpense>>`
  * API endpoints:
    * `POST /api/shipments/:id/expenses`
      * Payload DTO: `{ expenseCategoryId, amount, currency, fxUsed, referenceNo, shipmentDocumentLinkId, remark }`
      * Returns: `200 OK` or `400`
    * `GET /api/shipments/:id/expenses`
      * Returns: `{ status: "SUCCESS", data: { expenses } }`
  * Expense validation rules:
    * If `currency === 'THB'`: `amount_thb = amount`, `fx_used = null`.
    * If `currency === 'USD'`: require `fxUsed > 0`, calculate `amount_thb = amount * fxUsed`.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write failing tests in `test/shipment-expenses.repository.test.js` verifying currency calculations (USD conversion, THB straight copy, missing FX error).
  * [ ] **Step 2:** Run `node --test test/shipment-expenses.repository.test.js` and verify it fails.
  * [ ] **Step 3:** Implement amount_thb computation and repository methods.
  * [ ] **Step 4:** Run targeted tests and confirm they pass.
  * [ ] **Step 5:** Run all route regressions.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 6 - implement Shipment Expenses conversion and sum logic"`

### [ ] Task 7 — Ocean Freight Variance Logic
* **Files:**
  * Modify `src/shipments/repository.js`
  * Create `test/freight-variance.test.js`
* **Interfaces:**
  * Repository:
    * `getShipmentFreightVariance(shipmentId) => Promise<{ quotedFreight: number | null, actualFreightSum: number | null, variance: number | null }>`
  * Variance Sign Convention: `Freight Variance = Quoted Freight - Actual Freight`
  * Variance Calculation Rule:
    * Look up the `shipments` table row. Verify `is_one_container === 1`.
    * If `is_one_container === 1`, sum all USD expenses for the shipment where the category group is `OCEAN_FREIGHT` (`Actual Freight`), retrieve the referenced `freight_quotes.quoted_freight_usd_per_container` (`Quoted Freight`), and compute `Freight Variance = Quoted Freight - Actual Freight`.
    * If `is_one_container !== 1` (0 or null), do not calculate. Return `{ quotedFreight: null, actualFreightSum: null, variance: null }` (rendered as unavailable in UI).
* **TDD Process Steps:**
  * [ ] **Step 1:** Write a failing test in `test/freight-variance.test.js` asserting that:
    1. A one-container shipment (`is_one_container = 1`) with $1,500 quote and actuals $700 + $900 returns a variance of `-100`.
    2. A multi-container shipment (`is_one_container = 0`) returns `null` for all three keys (`quotedFreight`, `actualFreightSum`, `variance`).
    ```javascript
    test('Freight variance on one-container vs multi-container', async () => {
      const repo = new ShipmentRepository(db);
      // Case 1: One-container shipment
      const res1 = await repo.getShipmentFreightVariance('SHIP-ONE');
      assert.equal(res1.variance, -100);
      // Case 2: Multi-container shipment
      const res2 = await repo.getShipmentFreightVariance('SHIP-MULTI');
      assert.equal(res2.variance, null);
      assert.equal(res2.quotedFreight, null);
    });
    ```
  * [ ] **Step 3:** Implement aggregation, container-count check, and comparison logic in the repository.
  * [ ] **Step 4:** Run targeted test and confirm success.
  * [ ] **Step 5:** Run all regressions.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 7 - implement one-container Ocean Freight variance comparison"`

### [ ] Task 8 — API Route Wiring
* **Files:**
  * Modify `src/index.js`
* **Interfaces:**
  * Consumes: incoming HTTP Requests
  * Produces: routes incoming requests to appropriate handler
  * Paths wired:
    * `/api/manager-price-notes`
    * `/api/freight-quotes`
    * `/api/expense-categories`
    * `/api/shipments` (covering subpaths `/api/shipments/:id/expenses` and `/api/shipments/:id/documents`)
* **TDD Process Steps:**
  * [ ] **Step 1:** Add a routing test in `test/method-guard-regression.test.js` asserting that requests to the new paths are correctly delegated and not matched by fallback 404s.
  * [ ] **Step 2:** Run `node --test test/method-guard-regression.test.js` and confirm failure.
  * [ ] **Step 3:** Wire imports and routing conditions in `src/index.js`.
  * [ ] **Step 4:** Run targeted test and confirm it passes.
  * [ ] **Step 5:** Run all regressions.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 8 - wire Phase 5E api route paths in composable gateway"`

### [ ] Task 9 — Frontend Manager Price Note UI (TDD)
* **Files:**
  * Modify `public/index.html`
  * Create `test/frontend-pricing-shipment-adapter.test.js`
* **Interfaces:**
  * Frontend functions:
    * `loadPriceNotesFromApi() => Promise<void>` (fetches `/api/manager-price-notes` and saves to `state.priceNotes`)
    * `savePriceNoteToApi(note) => Promise<PriceNote>`
    * `renderPriceNotesForm()`
* **TDD Process Steps:**
  * [ ] **Step 1:** Write a failing frontend adapter test in `test/frontend-pricing-shipment-adapter.test.js` checking that `loadPriceNotesFromApi()` calls the correct endpoint, matches payload structure, and updates `state.priceNotes`.
  * [ ] **Step 2:** Run `node --test test/frontend-pricing-shipment-adapter.test.js` and confirm failure.
  * [ ] **Step 3:** Implement UI input elements, dropdown filter bindings, and loader functions in `public/index.html`.
  * [ ] **Step 4:** Run targeted test and confirm it passes.
  * [ ] **Step 5:** Run frontend adapter regressions.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 9 - implement frontend Manager Price Notes interface with TDD"`

### [ ] Task 10 — Frontend Freight Quote UI (TDD)
* **Files:**
  * Modify `public/index.html`
  * Modify `test/frontend-pricing-shipment-adapter.test.js`
* **Interfaces:**
  * Frontend functions:
    * `loadFreightQuotesFromApi() => Promise<void>` (saves to `state.freightQuotes`)
    * `saveFreightQuoteToApi(quote) => Promise<FreightQuote>`
* **TDD Process Steps:**
  * [ ] **Step 1:** Write a failing frontend adapter test in `test/frontend-pricing-shipment-adapter.test.js` verifying `saveFreightQuoteToApi()` maps inputs to a `POST` request and calls `renderView()`.
  * [ ] **Step 2:** Run the test and verify it fails.
  * [ ] **Step 3:** Implement Freight Quote list and forms in `public/index.html`.
  * [ ] **Step 4:** Run targeted test and confirm success.
  * [ ] **Step 5:** Run frontend regressions.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 10 - implement frontend Freight Quote reference panel with TDD"`

### [ ] Task 11 — Frontend Shipment Detail UI (TDD)
* **Files:**
  * Modify `public/index.html`
  * Modify `test/frontend-pricing-shipment-adapter.test.js`
* **Interfaces:**
  * Frontend functions:
    * `loadShipmentExpensesFromApi(shipmentId) => Promise<void>`
    * `saveShipmentExpenseToApi(shipmentId, expense) => Promise<void>`
    * `loadShipmentDocumentLinksFromApi(shipmentId) => Promise<void>`
    * `saveShipmentDocumentLinkToApi(shipmentId, link) => Promise<void>`
* **TDD Process Steps:**
  * [ ] **Step 1:** Write failing tests in `test/frontend-pricing-shipment-adapter.test.js` checking that expense entry submissions validate currency selections, and document group links support multiple URLs.
  * [ ] **Step 2:** Run the test and verify it fails.
  * [ ] **Step 3:** Implement tabs (Overview, Costs, Documents) inside the Shipment Detail view in `public/index.html` and write the loaders.
  * [ ] **Step 4:** Run targeted test and confirm it passes.
  * [ ] **Step 5:** Run all frontend regressions.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 11 - implement frontend Shipment detail tabs with costs and docs"`

### [ ] Task 12 — End-to-End Regression & Verification
* **Files:** None (Gate Task)
* **Details:**
  * Run the full test suite (`npm test`) containing all 115 original tests plus the 12 new regression test files (~140 tests total).
  * Run syntax checks on changed JS files using `node --check`.
  * Verify `git status` shows no dirty untracked modifications.
  * **STOP immediately on any test or lint failure.**

### [ ] Task 13 — Pull Request, Review, and Merge Gate
* **Files:** None (Gate Task)
* **Details:**
  * Push the feature branch `feature/commercial-shipment-control` to origin.
  * Create Pull Request #7 on GitHub pointing to `main`.
  * PR description must clearly outline the Phase 5E summary, relational database anchors, and TDD verification count.
  * Resolve review findings, verify CI/tests build.
  * Merge PR into `main` using normal merge commit.
  * Pull updated `main` branch to primary workspace and verify HEAD commit.
  * Only after successful merge, update `docs/PROJECT_STATUS.md` status to `COMPLETE / MERGED / DEPLOYMENT PENDING`.
* **Commit:** `git commit -m "docs: Task 13 - update project status to merged"`

---

## Task 14 — Deploy and Production Verify (Separately Gated)

* **Files:** Modify `docs/PROJECT_STATUS.md`
* **Details:**

### Preflight Checks
* Confirm primary workspace main HEAD matches the merged main commit.
* Execute `npm test` pre-deployment and verify ~140 tests pass.
* Verify syntax on all changed files.
* Retrieve D1 row counts of critical tables (`users`, `sessions`, `customers`, `customer_contacts`) to establish a pre-migration backup reference.

### Apply Migration
* Apply database migration:
  ```powershell
  npx wrangler d1 migrations apply wcat-sales-db --remote
  ```
* Verify database table structure contains the 7 new tables: `pos`, `shipments`, `expense_categories`, `manager_price_notes`, `freight_quotes`, `shipment_document_links`, `shipment_expenses`.
* Verify existing critical tables row counts match exactly (no data loss/unintended changes).

### Deploy Worker
* Deploy merged main Worker to Cloudflare:
  ```powershell
  npx wrangler deploy
  ```
* Record the new Worker Version ID and deployment URL.

### Production Smoke Test (UI & API)
* Verify auth login page is accessible and healthy.
* Reuse existing active Product (`PRD-001`) and Customer (`CUST-001`) as references for read-only association. Do not create new product categories, forms, or specifications.
* Create a temporary test Manager Price Note and verify persistence.
* Create a temporary test Freight Quote.
* Create a minimal test PO and one-container Shipment anchor record.
* Create standard shipment expenses (USD converting to THB, THB straight copying) and check totals.
* Add multiple Drive document links.
* Check Ocean Freight variance calculation on the Overview panel.
* Verify existing CRM/External Sales modules are healthy.
* **Cleanup:** Delete the temporary Phase 5E test records created during the smoke test (from `manager_price_notes`, `freight_quotes`, `shipment_expenses`, `shipment_document_links`, `shipments`, and `pos`). Do not delete or archive main master data.

### Close Phase 5E
* Update `docs/PROJECT_STATUS.md` Phase 5E status to: `COMPLETE / MERGED / DEPLOYED / PRODUCTION VERIFIED`
* Record deployment parameters (Merge commit, D1 ID, Version ID).
* Commit status changes:
  ```powershell
  git commit -m "docs: close Phase 5E production verification"
  ```
* Push main.
