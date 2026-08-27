# SDD ledger — plan: docs/superpowers/plans/2026-08-27-phase5f-po-management-implementation-plan.md

## Pre-Flight Review & Rulings

### 1. Plan-to-Spec Consistency Verification
* **Constraints Verification:** All schema setups, revisions logic, lines snapshotting, validation rules, events/diff auditing, and RBAC views from the design spec are mapped into 13 tasks.
* **Shared Files:**
  * Backend repository: `src/pos/repository.js` (shared across tasks 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)
  * Backend router: `src/pos/routes.js` (shared across tasks 9, 10, 11, 13)
  * Core entrypoint: `src/index.js` (shared in task 13 for routes wiring)
  * Frontend interface: `public/index.html` (shared in task 13)
* **Function & DTO Naming Conventions:**
  * Headers: `createDraftPO()`, `cancelPO()`, `deleteDraftPO()`
  * Revisions: `createNextRevision()`, `activateRevision()`
  * Lines: `createLine()`, `updateLine()`, `deleteLine()`
  * Documents: `createDocument()`, `updateDocument()`, `deleteDocument()`
* **RBAC Alignment:** API endpoints enforce permissions via role projection checks:
  * `ADMIN` / `MANAGER`: full business workflow access (activate, cancel, edit, delete).
  * `SALES_SUPPORT`: create PO, edit Draft, prepare revisions, manage documents, edit operational notes (cannot activate/cancel).
  * `EXTERNAL_SALES`: read-only access restricted to own assigned sales customers. Cannot see drafts or house accounts.
  * `EXPORT`: operational view excluding price, commission, override reasons.
  * `PRODUCTION_WAREHOUSE`: production view excluding price, shipping, commission details.

### 2. Pre-Flight Rulings
* **Ruling 01 - Legacy PO compatibility:** To prevent breaking shipments and DI, when a PO Revision is activated, the legacy `pos` anchor table will be updated atomically with the first line's product and destination port details.
* **Ruling 02 - SQLite partial unique index for Customer POs:** A partial unique index will be added to ensure customer PO numbers are historically unique for a given customer:
  ```sql
  CREATE UNIQUE INDEX idx_po_customer_po_no ON po_revisions (customer_po_no, po_id);
  ```
  Wait, the spec states: "Customer PO No. must be unique within one Customer across all history. The same number may exist for different Customers."
  Since `po_id` references a header which belongs to a customer, if we check that `customer_po_no` is unique for a given `customer_id` across the headers, a composite unique index on `po_revisions` is not enough because multiple headers for the same customer could try to use the same `customer_po_no`.
  Thus, we can enforce this check dynamically in code, or by maintaining a unique index or trigger. The application code in Task 4 will explicitly validate historical customer PO number uniqueness.

---

## SDD Progress Ledger

- [x] **Task 1 — D1 Migration & Database Setup**
- [x] **Task 2 — PO Header & ID Sequence Generation**
- [ ] **Task 3 — PO Revision Snapshotting & Cloning**
- [ ] **Task 4 — Customer PO Number Uniqueness and History**
- [ ] **Task 5 — Customer CRM Ownership & House Account Rules**
- [ ] **Task 6 — PO Line Commercial Model and Tolerance Calculations**
- [ ] **Task 7 — Spec Resolution Logic**
- [ ] **Task 8 — Manager Price Note Matching**
- [ ] **Task 9 — PO Documents Links Management**
- [ ] **Task 10 — Revision Activation & Atomic Swapping**
- [ ] **Task 11 — PO Cancellation & Hard Delete Controls**
- [ ] **Task 12 — Audit Event Logging and Field Diff Generation**
- [ ] **Task 13 — API Endpoints & RBAC Views Integration**
