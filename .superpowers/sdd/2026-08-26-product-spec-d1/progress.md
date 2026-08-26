# SDD ledger — plan: docs/superpowers/plans/2026-08-26-product-spec-d1.md

## Pre-Flight Review & Rulings

### 1. Plan-to-Spec Consistency Verification
* **Constraints Verification:** Checked all 15 tasks against the design specification. All table schemas, versioning constraints, operators, and validation requirements map 1-to-1 without gaps.
* **Shared Files:**
  * Backend repository: `src/products/repository.js` (shared across tasks 2, 4, 5, 8, 9)
  * Backend router: `src/products/routes.js` (shared across tasks 3, 4, 7, 10)
  * Core entrypoint: `src/index.js` (shared across tasks 3, 7, 10 for route wiring)
  * Spec validation helper: `src/products/validation.js` (shared across tasks 6, 7, 8, 10)
  * Frontend interface: `public/index.html` (shared across tasks 11, 12, 13)
* **Function & DTO Naming Conventions:**
  * Categories: `listCategories()`, `createCategory()`, `updateCategory()`
  * Forms: `listForms()`, `createForm()`, `updateForm()`
  * Products: `listProducts()`, `findProductById()`, `createProduct()`, `updateProduct()`
  * Spec Parameters: `listParameters()`, `createParameter()`, `updateParameter()`
  * Standard Specs: `listStandardSpecs()`, `findStandardSpecById()`, `createStandardSpecDraft()`, `updateStandardSpecDraftItems()`, `activateStandardSpec()`, `archiveStandardSpec()`
  * Customer Specs: `listCustomerSpecs()`, `findCustomerSpecById()`, `createCustomerSpecDraft()`, `updateCustomerSpecDraftOverrides()`, `activateCustomerSpec()`, `archiveCustomerSpec()`, `resolveEffectiveCustomerSpec()`
  * Product DTO Schema: `{ id, code, name, shortName, category: { id, code, name }, form: { id, code, name }, hsCode, defaultUnit, applications: string[], status }`
* **RBAC Alignment:** Routing middleware must resolve authenticated callers using `resolveAuthenticatedUser` and enforce strict access levels:
  * `ADMIN` / `MANAGER`: full read/write, activate, archive.
  * `SALES_SUPPORT`: read-only for products/parameters, read and draft-only edit/create for standard/customer specs.
  * All other roles: read-only or denied (403).

### 2. Pre-Flight Rulings
* **Ruling 01 - DB Migrations:** Migration will be created at `migrations/0003_product_specs.sql` and verified locally in tests using in-memory databases. It will **not** be deployed to production D1 database in this phase.
* **Ruling 02 - SQLite Partial Unique Indexes:** The single active specification rules will be enforced via partial indexes in SQLite:
  ```sql
  CREATE UNIQUE INDEX idx_active_standard_spec ON standard_specs (product_id, application) WHERE status = 'ACTIVE';
  CREATE UNIQUE INDEX idx_active_customer_spec ON customer_specs (customer_id, product_id, application) WHERE status = 'ACTIVE';
  ```
  This is fully supported in SQLite/D1 and guarantees data integrity at the storage layer.

---

## SDD Progress Ledger

- [x] **Task 1 — D1 Schema / Migration**
- [x] **Task 2 — Product Category / Form / Product Repository**
- [x] **Task 3 — Product APIs + RBAC**
- [x] **Task 4 — Spec Parameter Master**
- [x] **Task 5 — Standard Spec Repository**
- [x] **Task 6 — Standard Spec Item Validation**
- [x] **Task 7 — Standard Spec APIs**
- [x] **Task 8 — Customer / Contract Spec Repository**
- [x] **Task 9 — Effective Customer Spec Resolution**
- [x] **Task 10 — Customer Spec APIs + RBAC**
- [x] **Task 11 — Frontend Product Master D1 Migration**
- [x] **Task 12 — Frontend Standard Spec UI**
- [x] **Task 13 — Frontend Customer / Contract Spec UI**
- [x] **Task 14 — Regression & Full Verification**
- [x] **Task 15 — Project Status / PR Preparation**
