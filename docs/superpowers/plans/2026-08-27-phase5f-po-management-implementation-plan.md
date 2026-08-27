# Phase 5F — PO Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Phase 5F PO Management system using D1/SQLite persistence, supporting stable sequential PO IDs, revision cloning/snapshotting, customer PO uniqueness, spec resolutions, price note matching, drive document links, atomic activation rollback, events/diff auditing, and RBAC views.

**Architecture:** Header + Revision + Lines model with full snapshots. A PO Header holds stable identity; a Revision represents a complete commercial snapshot; every revision stores a full copy of all lines.

**Tech Stack:** Cloudflare Workers, D1/SQLite, vanilla HTML/JavaScript frontend, Node.js test runner.

**Spec:** docs/superpowers/specs/2026-08-27-phase5f-po-management-design.md

---

## Global Constraints

- Follow TDD. Implement tests before code for each task.
- Keep the existing automated regression baseline passing (151 tests).
- Work on `feature/phase5f-po-management` branch in a fresh isolated worktree.
- Do NOT deploy to production or apply remote migrations.
- Do not build credit limit validations, P&L calculations, or auto-completion.
- Documents are URL links only. Do not use Cloudflare R2 or file uploads.
- Commission rate defaults to 0 and is per-line.
- Follow existing RBAC conventions. Restricted fields must be omitted server-side.

---

## Compatibility Strategy

- Phase 5E created a minimal `pos` table. To maintain foreign key integrity with shipments, the `pos` table will be updated atomically when a Phase 5F PO is activated.
- The first line's product and the header's incoterm/destination will be mirrored into the legacy `pos` table.
- Never drop or modify historical `pos` or `shipments` data.

---

## File Structure / Responsibility Map

- `migrations/0005_po_management.sql`: Database schema definitions and migrations.
- `src/pos/repository.js`: CRUD operations for headers, revisions, lines, documents, and audit logs.
- `src/pos/routes.js`: HTTP endpoints for PO creation, revision editing, documents, activation, history, and cancellation.
- `src/index.js`: Composition and routing. Maps `/api/pos/*` to the new routes.
- `public/index.html`: UI views for PO creation, line configuration, revision tracking, review, and history logs.

---

## Implementation Tasks

### [ ] Task 1 — D1 Migration & Database Setup
* **Files:**
  * Create `migrations/0005_po_management.sql`
  * Create `test/po-migration.test.js`
* **Interfaces:**
  * Database schema setup and `manager_price_notes` alteration.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write failing tests in `test/po-migration.test.js` checking that the tables (`po_headers`, `po_revisions`, `po_revision_lines`, `po_revision_documents`, `po_audit_events`, `po_field_diffs`) reject invalid checks (e.g. duplicate lines, negative quantities, invalid document type) and that `manager_price_notes` allows NULL for `sales_user_id`.
  * [ ] **Step 2:** Run `node --test test/po-migration.test.js` and verify failure.
  * [ ] **Step 3:** Implement the DDL file `migrations/0005_po_management.sql`. Recreate `manager_price_notes` table to drop `NOT NULL` on `sales_user_id`.
  * [ ] **Step 4:** Run targeted tests and confirm success.
  * [ ] **Step 5:** Run overall regression tests.
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 1 - implement PO management D1 migration and schema"`

### [ ] Task 2 — PO Header & ID Sequence Generation
* **Files:**
  * Create `src/pos/repository.js` (header methods)
  * Create `test/po-header.test.js`
* **Interfaces:**
  * `createDraftPO(customerId, creatorId) => Promise<POHeader>`
  * Sequential ID generator: `PO-2026-001`, `PO-2026-002` (annual increment using a sequential counter table or query).
* **TDD Process Steps:**
  * [ ] **Step 1:** Write tests checking sequence generation (e.g. `PO-2026-001`, `PO-2026-002`) and ensuring Draft PO creation seeds Rev.0 in `DRAFT` status.
  * [ ] **Step 2:** Run tests and verify failure.
  * [ ] **Step 3:** Implement header creation and stable sequence generation logic in repository.
  * [ ] **Step 4:** Run targeted tests and verify success.
  * [ ] **Step 5:** Commit: `git commit -m "feat: Task 2 - sequential PO ID generation and draft creation"`

### [ ] Task 3 — PO Revision Snapshotting & Cloning
* **Files:**
  * Modify `src/pos/repository.js` (cloning methods)
  * Create `test/po-cloning.test.js`
* **Interfaces:**
  * `createNextRevision(poId, creatorId) => Promise<PORevision>`
* **TDD Process Steps:**
  * [ ] **Step 1:** Write tests asserting that cloning an Active revision duplicates all overview details, terms, and lines (with `previous_line_id` and correct `revision_no`), but resets approval details (`approved_by`, `approved_at`, `approval_summary_json` = NULL).
  * [ ] **Step 2:** Run tests and verify failure.
  * [ ] **Step 3:** Implement revision cloning logic in repository.
  * [ ] **Step 4:** Run targeted tests and confirm success.
  * [ ] **Step 5:** Commit: `git commit -m "feat: Task 3 - implement revision cloning and line snapshotting"`

### [ ] Task 4 — Customer PO Number Uniqueness and History
* **Files:**
  * Modify `src/pos/repository.js`
  * Create `test/po-customer-po-no.test.js`
* **Interfaces:**
  * Validation checks for `customer_po_no` uniqueness per customer.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write tests asserting that saving a duplicate `customer_po_no` for the same Customer throws `PO_CUSTOMER_PO_DUPLICATE`, while different customers may use the same number.
  * [ ] **Step 2:** Run tests and confirm failure.
  * [ ] **Step 3:** Implement the check during revision creation/update.
  * [ ] **Step 4:** Run tests and verify success.
  * [ ] **Step 5:** Commit: `git commit -m "feat: Task 4 - enforce customer PO number uniqueness rules"`

### [ ] Task 5 — Customer CRM Ownership & House Account Rules
* **Files:**
  * Modify `src/pos/repository.js`
  * Create `test/po-ownership.test.js`
* **Interfaces:**
  * CRM checks for assigned sales vs house accounts.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write tests verifying that PO creation for an ASSIGNED_SALES customer without a CRM sales owner fails with `PO_CUSTOMER_OWNER_REQUIRED`, whereas a HOUSE_ACCOUNT customer successfully allows a NULL sales owner.
  * [ ] **Step 2:** Run tests and verify failure.
  * [ ] **Step 3:** Implement CRM ownership validation.
  * [ ] **Step 4:** Run targeted tests and confirm success.
  * [ ] **Step 5:** Commit: `git commit -m "feat: Task 5 - implement sales assigned and house account checks"`

### [ ] Task 6 — PO Line Commercial Model and Tolerance Calculations
* **Files:**
  * Modify `src/pos/repository.js` (line methods)
  * Create `test/po-lines.test.js`
* **Interfaces:**
  * `createLine(dto) => Promise<POLine>`
  * `updateLine(lineId, dto) => Promise<POLine>`
  * Tolerance calculation (`min_qty_mt`, `max_qty_mt`).
  * Unit price validation (`/MT` rule) and totals calculation.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write tests verifying that tolerance percentage correctly updates min/max limits, that unit prices calculate line amounts, and that replacing a product on an existing line lineage is rejected.
  * [ ] **Step 2:** Run tests and confirm failure.
  * [ ] **Step 3:** Implement line updates, checks, and calculations in repository.
  * [ ] **Step 4:** Run targeted tests and verify success.
  * [ ] **Step 5:** Commit: `git commit -m "feat: Task 6 - implement PO line editing and tolerance calculations"`

### [ ] Task 7 — Spec Resolution Logic
* **Files:**
  * Modify `src/pos/repository.js`
  * Create `test/po-spec-resolution.test.js`
* **Interfaces:**
  * Resolution chain: Active Customer Spec -> Active Standard Spec -> block.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write tests checking that resolution fetches active specs, that draft specs are blocked, and that a warning/audit is generated when keeping an older spec revision.
  * [ ] **Step 2:** Run tests and verify failure.
  * [ ] **Step 3:** Implement specification resolution and validation logic.
  * [ ] **Step 4:** Run targeted tests and confirm success.
  * [ ] **Step 5:** Commit: `git commit -m "feat: Task 7 - implement spec resolution and block rules"`

### [ ] Task 8 — Manager Price Note Matching
* **Files:**
  * Modify `src/pos/repository.js`
  * Create `test/po-price-note-matching.test.js`
* **Interfaces:**
  * Automatic matching of manager price notes (with NULL sales owner for house accounts).
  * Price override validation.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write tests verifying that pricing matches price notes correctly, and that setting a price different from the suggested price requires a `price_override_reason` (failing with `PO_PRICE_OVERRIDE_REASON_REQUIRED` if missing).
  * [ ] **Step 2:** Run tests and confirm failure.
  * [ ] **Step 3:** Implement price note matching and override validation rules.
  * [ ] **Step 4:** Run targeted tests and confirm success.
  * [ ] **Step 5:** Commit: `git commit -m "feat: Task 8 - match manager price notes and validate overrides"`

### [ ] Task 9 — PO Documents Links Management
* **Files:**
  * Modify `src/pos/repository.js` (documents methods)
  * Create `test/po-documents.test.js`
* **Interfaces:**
  * CRUD for revision documents supporting types `CUSTOMER_PO`, `AMENDMENT`, `EMAIL_CONFIRMATION`, `OTHER`.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write tests asserting that document links require valid URL formatting, that at least one `CUSTOMER_PO` or `EMAIL_CONFIRMATION` is present before activation, and that active documents can be edited without creating a new revision.
  * [ ] **Step 2:** Run tests and confirm failure.
  * [ ] **Step 3:** Implement document management, URL checks, and active-revision document bypasses.
  * [ ] **Step 4:** Run targeted tests and verify success.
  * [ ] **Step 5:** Commit: `git commit -m "feat: Task 9 - implement documents link management"`

### [ ] Task 10 — Revision Activation & Atomic Swapping
* **Files:**
  * Modify `src/pos/repository.js` (activation methods)
  * Create `test/po-activation.test.js`
* **Interfaces:**
  * `activateRevision(revisionId, approverId, note) => Promise<void>`
* **TDD Process Steps:**
  * [ ] **Step 1:** Write tests checking all pre-activation validations (valid specs, valid until date, non-empty lines, unique line numbers, document present) and verifying that status transition (old Active -> SUPERSEDED, Draft -> ACTIVE) runs atomically.
  * [ ] **Step 2:** Run tests and verify failure.
  * [ ] **Step 3:** Implement atomic activation transaction, validation checks, and legacy `pos` anchor update.
  * [ ] **Step 4:** Run targeted tests and verify success.
  * [ ] **Step 5:** Commit: `git commit -m "feat: Task 10 - implement atomic activation and legacy pos mirroring"`

### [ ] Task 11 — PO Cancellation & Hard Delete Controls
* **Files:**
  * Modify `src/pos/repository.js` (delete/cancel methods)
  * Create `test/po-termination.test.js`
* **Interfaces:**
  * `cancelPO(poId, cancellerId, reason) => Promise<void>`
  * `deleteDraftPO(poId) => Promise<void>`
* **TDD Process Steps:**
  * [ ] **Step 1:** Write tests checking that draft POs with no active revisions can be hard deleted, that active POs block deletion, and that cancellation requires a reason, is restricted to MANAGER/ADMIN, and is terminal.
  * [ ] **Step 2:** Run tests and confirm failure.
  * [ ] **Step 3:** Implement hard delete and cancellation logic.
  * [ ] **Step 4:** Run targeted tests and confirm success.
  * [ ] **Step 5:** Commit: `git commit -m "feat: Task 11 - implement cancellation and delete constraints"`

### [ ] Task 12 — Audit Event Logging and Field Diff Generation
* **Files:**
  * Modify `src/pos/repository.js` (audit methods)
  * Create `test/po-audit.test.js`
* **Interfaces:**
  * `logEvent(poId, revisionId, eventType, actorId, metadata) => Promise<void>`
  * Automatic field-level diff generator for revision changes.
* **TDD Process Steps:**
  * [ ] **Step 1:** Write tests checking that audits are written for creation, edits, documents, and activation, and that field diffs correctly list changes between revisions.
  * [ ] **Step 2:** Run tests and verify failure.
  * [ ] **Step 3:** Implement event logging and field diff calculation logic.
  * [ ] **Step 4:** Run targeted tests and confirm success.
  * [ ] **Step 5:** Commit: `git commit -m "feat: Task 12 - implement event audit and field diff logging"`

### [ ] Task 13 — API Endpoints & RBAC Views Integration
* **Files:**
  * Create `src/pos/routes.js`
  * Modify `src/index.js`
  * Create `test/po-routes.test.js`
* **Interfaces:**
  * Endpoints mapping all spec boundaries (`/api/pos`, `/api/pos/:poId/revisions`, `/api/pos/:poId/activate`, etc.).
  * RBAC read projections (Commercial, Operational, External Sales, Production).
* **TDD Process Steps:**
  * [ ] **Step 1:** Write integration tests verifying that EXTERNAL_SALES users are forbidden from seeing draft revisions or house accounts, and that EXPORT/PRODUCTION views exclude price and commission metrics from the payload.
  * [ ] **Step 2:** Run tests and confirm failure.
  * [ ] **Step 3:** Implement the route controller and composition in `src/index.js` with correct projections.
  * [ ] **Step 4:** Run targeted tests and verify success.
  * [ ] **Step 5:** Run the entire regression suite (`npm test`).
  * [ ] **Step 6:** Commit: `git commit -m "feat: Task 13 - implement PO management HTTP routes and RBAC projections"`

---

## Verification Plan

### Automated Regression Testing
- Execute `npm test` after each task to ensure 100% of regression tests (including Phase 5E and CRM/Auth tests) remain green.

### Local Integration Smoke Test
- Verify flow:
  1. Create a Draft PO for ASSIGNED_SALES customer (check validation).
  2. Add multiple lines with spec resolutions, custom tolerances, and price note matches (check price notes and override triggers).
  3. Attach custom PO documents (check URL validator).
  4. Activate the PO using a MANAGER account (check atomic status swaps and audit trail).
  5. Check role projections by querying the endpoints under EXTERNAL_SALES and EXPORT roles (confirm restricted fields are omitted from response).
