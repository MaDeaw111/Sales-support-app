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

---

## Shipment & PO Infrastructure Warning
* **Discovery:** Inspection of the codebase reveals that Purchase Order (PO) and Shipment data entities do not exist in D1 yet; they are currently mock-only front-end arrays inside `public/index.html`.
* **Strategy:** To build a robust, testable, D1-backed commercial/shipment costing workflow without a full PO/Shipment redesign, we will define minimal `pos` and `shipments` tables in D1. This serves as the relational anchor for shipment costs and document links, ensuring foreign keys are correctly enforced.

---

## Implementation Tasks

### [ ] Task 1 — D1 Migration & Database Setup
* **Files:** Create `migrations/0004_commercial_shipment_control.sql`, Create `test/commercial-migration.test.js`
* **Details:**
  * Define schema for the following tables:
    1. `pos` (po_id TEXT PRIMARY KEY, customer_id TEXT, product_id TEXT, incoterm TEXT, destination_port TEXT, po_date TEXT, status TEXT)
    2. `shipments` (shipment_id TEXT PRIMARY KEY, po_id TEXT, freight_quote_id TEXT, status TEXT)
    3. `expense_categories` (category_id TEXT PRIMARY KEY, category_code TEXT UNIQUE, category_name TEXT, category_group TEXT, status TEXT, sort_order INTEGER)
    4. `manager_price_notes` (note_id TEXT PRIMARY KEY, sales_user_id TEXT, customer_id TEXT, product_id TEXT, incoterm TEXT, destination_port TEXT, offer_price_usd_per_mt REAL, note TEXT, created_by_manager_id TEXT, created_at TEXT)
    5. `freight_quotes` (quote_id TEXT PRIMARY KEY, origin_port TEXT, destination_port TEXT, container_size TEXT, shipping_line_or_forwarder TEXT, quoted_freight_usd_per_container REAL, valid_until TEXT, remark TEXT, created_by TEXT, created_at TEXT)
    6. `shipment_document_links` (link_id TEXT PRIMARY KEY, shipment_id TEXT, document_type TEXT, title TEXT, drive_url TEXT, reference_no TEXT, remark TEXT, created_by TEXT, created_at TEXT, updated_at TEXT)
    7. `shipment_expenses` (expense_id TEXT PRIMARY KEY, shipment_id TEXT, expense_category_id TEXT, amount REAL, currency TEXT, fx_used REAL, amount_thb REAL, reference_no TEXT, shipment_document_link_id TEXT, remark TEXT, created_by TEXT, created_at TEXT, updated_by TEXT, updated_at TEXT)
  * Verify constraints in `test/commercial-migration.test.js`.
* **TDD Run:**
  * Run `node --test test/commercial-migration.test.js` and see it FAIL before sql run, then PASS.
* **Commit:** `git commit -m "feat: Task 1 - implement commercial and shipment database migration"`

### [ ] Task 2 — Expense Category Master Setup
* **Files:** Modify `migrations/0004_commercial_shipment_control.sql` (Add seed INSERTs), Create `test/expense-categories.test.js`
* **Details:**
  * Seed the required categories: Ocean Freight, BL Fee, THC, Seal Fee, Other Shipping / Local Charge, Truck / Inland Transport, Documentation, Fumigation, Inspection, Insurance, Bank Charge, Other.
  * Categories must map to groups: `OCEAN_FREIGHT`, `SHIPPING_LOCAL`, `TRANSPORT`, `DOCUMENT`, `INSURANCE`, `OTHER`.
  * Status defaults to `ACTIVE`.
  * Implement Repository functions `listExpenseCategories()` and `createExpenseCategory()` in `src/shipments/repository.js`.
* **TDD Run:**
  * Run `node --test test/expense-categories.test.js` to verify CRUD.
* **Commit:** `git commit -m "feat: Task 2 - seed expense categories and create repository module"`

### [ ] Task 3 — Manager Price Note Backend
* **Files:** Create `src/price-notes/repository.js`, Create `src/price-notes/routes.js`, Create `test/manager-price-notes.repository.test.js`, Create `test/manager-price-notes.routes.test.js`
* **Details:**
  * Implement `createPriceNote(dto, creatorId)` and `listPriceNotes(filters)`.
  * Validate `offerPriceUsdPerMt > 0`.
  * Enforce that CFR and CIF incoterms require a destination port; FOB does not.
  * Implement HTTP routes:
    * `POST /api/manager-price-notes`
    * `GET /api/manager-price-notes`
  * Apply RBAC: Write requests are allowed only for `ADMIN` and `MANAGER` roles. Read requests are allowed for authenticated users.
* **TDD Run:**
  * Run `node --test test/manager-price-notes.repository.test.js test/manager-price-notes.routes.test.js`.
* **Commit:** `git commit -m "feat: Task 3 - implement Manager Price Note repository and REST routes"`

### [ ] Task 4 — Freight Quote Backend
* **Files:** Modify `src/price-notes/repository.js`, Modify `src/price-notes/routes.js`, Create `test/freight-quotes.repository.test.js`, Create `test/freight-quotes.routes.test.js`
* **Details:**
  * Implement `createFreightQuote(dto, creatorId)` and `listFreightQuotes()`.
  * Validate `quotedFreightUsdPerContainer > 0`. Currency is USD-only.
  * Freight quotes exist independently from shipments or POs.
  * Implement HTTP routes:
    * `POST /api/freight-quotes`
    * `GET /api/freight-quotes`
  * Apply RBAC: Write requests are allowed for `ADMIN`, `MANAGER`, and `EXPORT`/`SALES_SUPPORT` role equivalents.
* **TDD Run:**
  * Run `node --test test/freight-quotes.repository.test.js test/freight-quotes.routes.test.js`.
* **Commit:** `git commit -m "feat: Task 4 - implement Freight Quote repository and API routes"`

### [ ] Task 5 — Shipment Foundation & Documents Backend
* **Files:** Create `src/shipments/repository.js`, Create `src/shipments/routes.js`, Create `test/shipment-documents.repository.test.js`, Create `test/shipment-documents.routes.test.js`
* **Details:**
  * Implement minimal D1 PO and Shipment creation helper methods (to replace front-end mocks in tests).
  * Implement Document Links methods: `addShipmentDocumentLink(dto, creatorId)` and `listShipmentDocumentLinks(shipmentId)`.
  * Enforce URL verification: `driveUrl` must start with `http://` or `https://`.
  * Document types allowed: `PO`, `DI`, `BOOKING`, `STUFFING_REPORT`, `ALL_SHIP_DOC`, `IR`, `LC`.
  * Allow multiple links per type.
  * Implement HTTP routes:
    * `POST /api/shipments/:id/documents`
    * `GET /api/shipments/:id/documents`
* **TDD Run:**
  * Run `node --test test/shipment-documents.repository.test.js test/shipment-documents.routes.test.js`.
* **Commit:** `git commit -m "feat: Task 5 - implement Shipment documents storage and link APIs"`

### [ ] Task 6 — Shipment Expenses Backend
* **Files:** Modify `src/shipments/repository.js`, Modify `src/shipments/routes.js`, Create `test/shipment-expenses.repository.test.js`, Create `test/shipment-expenses.routes.test.js`
* **Details:**
  * Implement `addShipmentExpense(dto, creatorId)` and `listShipmentExpenses(shipmentId)`.
  * Business rules for conversion:
    * If currency is `THB`: `amount_thb` is equal to `amount` and `fx_used` is set to `null`.
    * If currency is `USD`: `fx_used` must be present and greater than `0`. Calculate `amount_thb = amount * fx_used`.
  * Calculate total shipment actual export cost as sum of `amount_thb`.
  * Implement HTTP routes:
    * `POST /api/shipments/:id/expenses`
    * `GET /api/shipments/:id/expenses`
* **TDD Run:**
  * Run `node --test test/shipment-expenses.repository.test.js test/shipment-expenses.routes.test.js`.
* **Commit:** `git commit -m "feat: Task 6 - implement Shipment expenses conversion and sum API"`

### [ ] Task 7 — Ocean Freight Variance Logic
* **Files:** Modify `src/shipments/repository.js`, Create `test/freight-variance.test.js`
* **Details:**
  * Implement Ocean Freight comparison check. If a Shipment references a `Freight Quote` and contains expense entries belonging to the `OCEAN_FREIGHT` category group:
    * Aggregate all ocean-freight expense amounts (USD).
    * Compute `Freight Variance = Quoted Freight - Actual Freight`.
    * Return variance value (positive is favorable/saving, negative is unfavorable/loss).
  * Exclude foreign exchange (FX) from variance calculation; comparison is USD-to-USD.
* **TDD Run:**
  * Run `node --test test/freight-variance.test.js`.
* **Commit:** `git commit -m "feat: Task 7 - implement Ocean Freight variance calculation logic"`

### [ ] Task 8 — API Route Wiring
* **Files:** Modify `src/index.js`
* **Details:**
  * Import handlers `createPriceNoteHandlerFromEnv` and `createShipmentHandlerFromEnv`.
  * Register route prefixes in the API gateway routing block:
    * `/api/manager-price-notes`
    * `/api/freight-quotes`
    * `/api/expense-categories`
    * `/api/shipments`
    * `/api/customer-specs` (already exists, but ensure routing matches).
* **TDD Run:**
  * Run `npm test` to verify no existing tests break and all API paths are routed correctly.
* **Commit:** `git commit -m "feat: Task 8 - composition and route wiring in composition entry"`

### [ ] Task 9 — Frontend Manager Price Note UI
* **Files:** Modify `public/index.html`
* **Details:**
  * Remove mock Pricing state and wire Price Note creation and list loading directly to `/api/manager-price-notes`.
  * Implement customer dropdown filtering based on selected salesperson.
  * Set conditional visibility/validation on destination port depending on Incoterm selection (FOB vs CFR/CIF).
  * Render recent price notes history newest-first.
* **Commit:** `git commit -m "feat: Task 9 - build frontend Manager Price Note offering interface"`

### [ ] Task 10 — Frontend Freight Quote UI
* **Files:** Modify `public/index.html`
* **Details:**
  * Wire Freight Quotes UI panel to load and save to `/api/freight-quotes`.
  * Restrict creation controls based on user role.
* **Commit:** `git commit -m "feat: Task 10 - build frontend Freight Quote reference panel"`

### [ ] Task 11 — Frontend Shipment Detail UI
* **Files:** Modify `public/index.html`
* **Details:**
  * Upgrade Shipment Detail view to include three tabs: Overview, Costs, and Documents.
  * Overview: Display identity, Ocean Freight summary (Quoted USD, Actual USD, Variance USD), Total THB expenses, and document presence indicators.
  * Costs: Form to record expenses (validating currency and exchange rate input) and aggregate list.
  * Documents: Groups for PO, DI, Booking, Stuffing Report, All Ship Doc, IR, LC allowing adding multiple links.
* **Commit:** `git commit -m "feat: Task 11 - upgrade Shipment Detail panel with costs and Drive links"`

### [ ] Task 12 — End-to-End Regression & Verification
* **Files:** Run verification scripts and test suites.
* **Details:**
  * Verify all 115 original tests + new test files pass cleanly.
  * Verify no syntax errors on changed JS files.
* **Commit:** `git commit -m "test: Task 12 - execute full regression and verify green status"`

### [ ] Task 13 — Project Status Update
* **Files:** Modify `docs/PROJECT_STATUS.md`
* **Details:**
  * Update Phase 5E status to `COMPLETE / MERGED / DEPLOYMENT PENDING`.
  * Update the current stopped checkpoint.
* **Commit:** `git commit -m "docs: Task 13 - update project status to completed"`

### [ ] Task 14 — Deploy and Production Verify
* **Files:** None (Deployment-only task)
* **Details:**
  * Deploy database migrations to remote D1.
  * Deploy Worker code to remote.
  * Perform functional smoke tests using TEST data.
  * Cleanup test data.
  * Update status to `COMPLETE / MERGED / DEPLOYED / PRODUCTION VERIFIED`.
* **Commit:** `git commit -m "docs: close Phase 5E production verification"`
