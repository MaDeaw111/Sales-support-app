# Phase 5D Product / Spec D1 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Product and Specification master data from frontend mock state to Cloudflare D1 with versioned Standard Specs and Customer / Contract Specs.

**Architecture:** Product identity is stored separately from versioned quality specifications. Flexible parameter master records drive Standard Spec items, while Customer / Contract Specs reference an exact Standard Spec revision and store overrides only.

**Tech Stack:** Cloudflare Workers, Cloudflare D1 / SQLite, JavaScript, existing HTML frontend, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-26-product-spec-d1-design.md`

---

## Global Constraints

* **Product Master Identity Only:** The `products` table stores product identity fields only. Quality parameters (Starch, Moisture, Protein, etc.) do NOT live as columns in `products`.
* **Product Categories & Forms:** Categorization uses normalization. Category describes raw-material family (e.g. Tapioca Product). Product Form describes physical shape (e.g. Pellet).
* **Cardinality Constraints:** 1 Product matches exactly 1 Product Form.
* **Product Applications:** Supported values are `PET_GRADE` and `FEED_GRADE`. A Product may support one or both.
* **HS Code Rule:** 1 Product has exactly 1 HS Code. The same Product uses the same HS Code across both grade applications.
* **Standard Spec Versioning:** Standard Specs are versioned per `(product_id, application)` starting with `Rev.0`.
* **Standard Spec Statuses:** Supported statuses are `DRAFT`, `ACTIVE`, and `ARCHIVED`.
* **Single Active Standard Spec Rule:** Only one Standard Spec revision can be `ACTIVE` at any time per `(product_id, application)`. Activating a draft archives the old active one in a single transaction.
* **Customer Spec Reference:** Customer Specs must reference an exact, fixed `base_standard_spec_id` version. Customer Specs do not auto-rebase.
* **Customer Spec Overrides:** Customer Specs store overrides only. Inherited values are resolved dynamically.
* **Single Active Customer Spec Rule:** Only one Customer Spec revision can be `ACTIVE` at any time per `(customer_id, product_id, application)`.
* **Immutability of History:** Both `ACTIVE` and `ARCHIVED` specifications are locked and cannot be edited. Edits require creating a new `DRAFT` revision.
* **Parameter Master:** Supports `NUMBER` and `TEXT` data types. Free text parameter names are forbidden inside specs.
* **Operators:** Supported operators are `MIN`, `MAX`, `RANGE`, `EXACT`, and `TEXT`.
* **Units:** Default units come from the Parameter Master. Item-level overrides are permitted.
* **RBAC Controls:** 
  * `ADMIN` & `MANAGER` can perform all read/write and lifecycle actions (create, edit, activate, archive).
  * `SALES_SUPPORT` can read, create draft, and edit draft specs, but cannot activate or archive specs.
  * Others (e.g. `EXPORT`, `PRODUCTION_WAREHOUSE`) are read-only or denied access.
* **Out of Scope:** Sample Trial, Actual COA / Lab Result, Shipment quality results, Pricing, PO, Shipping / DI, Package / Container / Bulk Vessel packaging configurations.
* **D1 Persistence:** All Product and Spec persistence must read/write to D1. Mock fallback objects are not permitted.

---

## Recommended Task Decomposition

### Task 1 — D1 Schema / Migration
* **Goal:** Set up database tables, constraints, indexes, and write schema unit tests.
* **Files:**
  * Create: `migrations/0003_product_specs.sql`
  * Create: `test/product-specs-migration.test.js`
* **Interfaces:**
  * Consumes: D1 SQLite environment
  * Produces: 9 database tables (`product_categories`, `product_forms`, `products`, `product_applications`, `spec_parameters`, `standard_specs`, `standard_spec_items`, `customer_specs`, `customer_spec_overrides`)
* **Steps:**
  * [ ] Create `migrations/0003_product_specs.sql` with schema definitions, foreign keys, CHECK constraints, and partial unique indexes for single-active-revision rules (`idx_active_standard_spec` and `idx_active_customer_spec`).
  * [ ] Create `test/product-specs-migration.test.js` and initialize `node:sqlite` DatabaseSync to execute `0001_auth.sql`, `0002_customers.sql`, and `0003_product_specs.sql`.
  * [ ] Add a unit test to verify unique product code constraint fails on duplicate insert.
  * [ ] Add a unit test to verify unique `(product_id, application)` on `product_applications`.
  * [ ] Add a unit test to verify unique standard spec parameter constraint `(standard_spec_id, parameter_id)` on `standard_spec_items`.
  * [ ] Add a unit test to verify partial index `idx_active_standard_spec` fails when trying to insert two standard specs with `status = 'ACTIVE'` for the same `(product_id, application)`.
  * [ ] Add a unit test to verify partial index `idx_active_customer_spec` fails when trying to insert two customer specs with `status = 'ACTIVE'` for the same `(customer_id, product_id, application)`.
  * [ ] Run tests:
    * Command: `node --test test/product-specs-migration.test.js`
    * Expected Result: Pass (7 tests)

---

### Task 2 — Product Category / Form / Product Repository
* **Goal:** Create the core repository methods for categories, forms, and product entities.
* **Files:**
  * Create: `src/products/repository.js`
  * Create: `test/products-repository.test.js`
* **Interfaces:**
  * Consumes: D1 Database instance
  * Produces: Repository functions:
    * `listCategories()`
    * `createCategory({ code, name, status })`
    * `updateCategory(id, { name, status })`
    * `listForms()`
    * `createForm({ code, name, status })`
    * `updateForm(id, { name, status })`
    * `listProducts()`
    * `findProductById(id)`
    * `createProduct({ code, name, shortName, categoryId, formId, hsCode, defaultUnit, applications, status })`
    * `updateProduct(id, { name, shortName, categoryId, formId, hsCode, defaultUnit, applications, status })`
* **Steps:**
  * [ ] Write initial failing tests in `test/products-repository.test.js` verifying CRUD for categories, forms, and products.
    * Command: `node --test test/products-repository.test.js`
    * Expected Result: Fail (compilation/import errors)
  * [ ] Implement `src/products/repository.js` with category and form CRUD. Generate ID strings matching prefix `CAT-` for categories and `FRM-` for forms.
  * [ ] Implement `findProductById(productId)` which returns a detailed Product DTO: `{ id, code, name, shortName, category: { id, code, name }, form: { id, code, name }, hsCode, defaultUnit, applications: string[], status }`.
  * [ ] Implement `createProduct` and `updateProduct` inside a transaction. Persist enabled applications to `product_applications`. Ensure database rolls back if any insertion fails.
  * [ ] Run tests:
    * Command: `node --test test/products-repository.test.js`
    * Expected Result: Pass (All CRUD and relation checks pass)

---

### Task 3 — Product APIs + RBAC
* **Goal:** Create API routes for product, category, and form CRUD, enforcing security policies.
* **Files:**
  * Create: `src/products/routes.js`
  * Modify: `src/index.js`
  * Create: `test/products-routes.test.js`
* **Interfaces:**
  * Consumes: HTTP Request, env
  * Produces: HTTP API endpoints:
    * `GET /api/products`
    * `GET /api/products/:id`
    * `POST /api/products`
    * `PUT /api/products/:id`
* **Steps:**
  * [ ] Create `test/products-routes.test.js` with test requests checking authentication and authorization.
    * Command: `node --test test/products-routes.test.js`
    * Expected Result: Fail (no routes implemented)
  * [ ] Modify `src/index.js` to route all pathnames starting with `/api/products` (or matching categories/forms) to the handler created by `createProductHandlerFromEnv(env)`.
  * [ ] Implement `src/products/routes.js` with `createProductHandlerFromEnv` factory and route handler.
  * [ ] Enforce RBAC: `POST` and `PUT` endpoints return `403 Forbidden` if caller role is not `ADMIN` or `MANAGER`. `GET` returns `200` for all authenticated roles.
  * [ ] Run routes tests:
    * Command: `node --test test/products-routes.test.js`
    * Expected Result: Pass (including 401 unauthenticated, 403 authorization, 200 list/detail, and 201 create validations)

---

### Task 4 — Spec Parameter Master
* **Goal:** Persist and manage quality parameter definitions.
* **Files:**
  * Modify: `src/products/repository.js`
  * Modify: `src/products/routes.js`
  * Create: `test/spec-parameters.test.js`
* **Interfaces:**
  * Consumes: D1 DB, HTTP Request
  * Produces: Repository functions:
    * `listParameters()`
    * `createParameter({ code, name, dataType, defaultUnit, status, sortOrder })`
    * `updateParameter(id, { name, dataType, defaultUnit, status, sortOrder })`
  * Produces: API endpoints:
    * `GET /api/spec-parameters`
    * `POST /api/spec-parameters`
    * `PUT /api/spec-parameters/:id`
* **Steps:**
  * [ ] Create `test/spec-parameters.test.js` checking schema validation on parameter records.
    * Command: `node --test test/spec-parameters.test.js`
    * Expected Result: Fail
  * [ ] Add parameter methods to `src/products/repository.js`. Generate IDs prefixed with `PAR-`. Enforce unique parameter code checks. Check values for `dataType` in `('NUMBER', 'TEXT')` and status in `('ACTIVE', 'INACTIVE', 'ARCHIVED')`.
  * [ ] Wire endpoints `/api/spec-parameters` inside `src/products/routes.js`. Enforce `ADMIN` / `MANAGER` write access.
  * [ ] Run parameters tests:
    * Command: `node --test test/spec-parameters.test.js`
    * Expected Result: Pass

---

### Task 5 — Standard Spec Repository
* **Goal:** Build the backend data operations for standard spec revisions.
* **Files:**
  * Modify: `src/products/repository.js`
  * Create: `test/standard-specs-repository.test.js`
* **Interfaces:**
  * Consumes: D1 DB
  * Produces: Repository functions:
    * `listStandardSpecs(productId, application)`
    * `findStandardSpecById(specId)`
    * `createStandardSpecDraft({ productId, application, effectiveDate, notes, createdBy })`
    * `updateStandardSpecDraftItems(specId, items, updatedBy)`
    * `activateStandardSpec(specId, userId)`
    * `archiveStandardSpec(specId, userId)`
* **Steps:**
  * [ ] Create `test/standard-specs-repository.test.js` containing verification for revisions, copy-on-draft creation, and active revision transitions.
    * Command: `node --test test/standard-specs-repository.test.js`
    * Expected Result: Fail
  * [ ] Implement `createStandardSpecDraft` in repository:
    * Retrieve current highest `revision_no` for `(productId, application)`. If none exist, start at `0`. Otherwise, increment by `1`.
    * If a previous `ACTIVE` spec revision exists, automatically copy its spec items to initialize the new draft.
    * Set new spec `status` to `DRAFT`.
  * [ ] Implement `activateStandardSpec` inside a transaction:
    * Find the target spec. Verify it is `DRAFT`.
    * Find any existing `ACTIVE` spec for that same `(product_id, application)`. Update its status to `ARCHIVED` and set `updated_at`.
    * Update the target spec status to `ACTIVE` and set `updated_at`.
  * [ ] Implement `archiveStandardSpec`:
    * Find the target spec. Verify it is `ACTIVE`.
    * Update status to `ARCHIVED` and set `updated_at`.
  * [ ] Run repository tests:
    * Command: `node --test test/standard-specs-repository.test.js`
    * Expected Result: Pass

---

### Task 6 — Standard Spec Item Validation
* **Goal:** Create a robust validation module for standard spec items.
* **Files:**
  * Create: `src/products/validation.js`
  * Create: `test/spec-validation.test.js`
* **Interfaces:**
  * Consumes: D1 DB instance, parameters payload array
  * Produces: `validateSpecItems(db, itemsArray)` -> returns validated array or throws specific error.
* **Steps:**
  * [ ] Create `test/spec-validation.test.js` with tests asserting various parameter mismatch combinations.
    * Command: `node --test test/spec-validation.test.js`
    * Expected Result: Fail
  * [ ] Implement `validateSpecItems` in `src/products/validation.js`:
    * Query parameter masters from `spec_parameters`.
    * Verify that no duplicate parameters exist in the list.
    * Enforce operator rules: Numeric parameters (`NUMBER` data type) must use `MIN`, `MAX`, `EXACT`, or `RANGE`. Text parameters must use `TEXT`.
    * For `RANGE` operator, verify `numeric_value` (lower bound) and `numeric_value_to` (upper bound) are provided, and `numeric_value_to > numeric_value`.
    * Set default unit from the parameter master if not specified.
  * [ ] Run validation tests:
    * Command: `node --test test/spec-validation.test.js`
    * Expected Result: Pass

---

### Task 7 — Standard Spec APIs
* **Goal:** Implement REST endpoints for Standard Specs with RBAC checks.
* **Files:**
  * Modify: `src/products/routes.js`
  * Modify: `src/index.js`
  * Create: `test/standard-specs-routes.test.js`
* **Interfaces:**
  * Consumes: HTTP request, env
  * Produces: API endpoints:
    * `GET /api/products/:productId/standard-specs`
    * `GET /api/standard-specs/:specId`
    * `POST /api/standard-specs` (Payload: `{ productId, application, effectiveDate, notes }`)
    * `PUT /api/standard-specs/:specId` (Payload: `{ items: [...] }`)
    * `POST /api/standard-specs/:specId/activate`
    * `POST /api/standard-specs/:specId/archive`
* **Steps:**
  * [ ] Create `test/standard-specs-routes.test.js` checking endpoint access.
    * Command: `node --test test/standard-specs-routes.test.js`
    * Expected Result: Fail
  * [ ] Add routes matching the endpoints to `src/products/routes.js`.
  * [ ] Implement path matching in `src/index.js` to route all pathnames starting with `/api/standard-specs` to the products router.
  * [ ] Enforce RBAC: Only `ADMIN` or `MANAGER` can invoke `/activate` and `/archive`. `SALES_SUPPORT` gets a `403 Forbidden` for those, but is allowed to call `POST` (create draft) and `PUT` (edit draft items).
  * [ ] In `PUT /api/standard-specs/:specId`, call `validateSpecItems` before database execution. Verify that edit is blocked if standard spec is already `ACTIVE` or `ARCHIVED` (return `400 Bad Request`).
  * [ ] Run routes tests:
    * Command: `node --test test/standard-specs-routes.test.js`
    * Expected Result: Pass

---

### Task 8 — Customer / Contract Spec Repository
* **Goal:** Create the database repository methods for Customer Specs.
* **Files:**
  * Modify: `src/products/repository.js`
  * Create: `test/customer-specs-repository.test.js`
* **Interfaces:**
  * Consumes: D1 DB
  * Produces: Repository functions:
    * `listCustomerSpecs(customerId, productId, application)`
    * `findCustomerSpecById(specId)`
    * `createCustomerSpecDraft({ customerId, productId, application, baseStandardSpecId, effectiveDate, notes, createdBy })`
    * `updateCustomerSpecDraftOverrides(specId, overrides, updatedBy)`
    * `activateCustomerSpec(specId, userId)`
    * `archiveCustomerSpec(specId, userId)`
* **Steps:**
  * [ ] Create `test/customer-specs-repository.test.js` to verify Customer Spec draft creation, override logic, and transitions.
    * Command: `node --test test/customer-specs-repository.test.js`
    * Expected Result: Fail
  * [ ] Implement `createCustomerSpecDraft` in `src/products/repository.js`:
    * Verify that the selected `baseStandardSpecId` exists, is for the correct `productId` and `application`, and is `ACTIVE`.
    * Auto-increment `revision_no` starting from `0`.
    * Generate ID string prefixed with `CSP-`.
  * [ ] Implement `updateCustomerSpecDraftOverrides`:
    * Verify customer spec status is `DRAFT`.
    * Call spec item validation helper on overrides payload.
    * Clear and replace rows in `customer_spec_overrides` for the target spec.
  * [ ] Implement `activateCustomerSpec` and `archiveCustomerSpec` following the same transaction logic used for Standard Specs (only one active revision per customer, product, and application).
  * [ ] Run tests:
    * Command: `node --test test/customer-specs-repository.test.js`
    * Expected Result: Pass

---

### Task 9 — Effective Customer Spec Resolution
* **Goal:** Implement the business logic to merge base specs with customer overrides.
* **Files:**
  * Modify: `src/products/repository.js`
  * Create: `test/effective-spec-resolution.test.js`
* **Interfaces:**
  * Consumes: D1 DB, specId
  * Produces: `resolveEffectiveCustomerSpec(specId)` -> returns DTO containing merged spec items.
* **Steps:**
  * [ ] Create `test/effective-spec-resolution.test.js` containing assertions for inheriting, overriding, and mapping values.
    * Command: `node --test test/effective-spec-resolution.test.js`
    * Expected Result: Fail
  * [ ] Implement `resolveEffectiveCustomerSpec` in `src/products/repository.js`:
    * Load the Customer Spec record. Let `baseSpecId` be `base_standard_spec_id`.
    * Load all standard spec items from `standard_spec_items` for `baseSpecId`.
    * Load all overrides from `customer_spec_overrides` for the target customer spec.
    * Merge items: For each parameter, if an override exists, use it and mark the item with source `OVERRIDDEN`. Otherwise, use the standard spec item and mark it with source `INHERITED`.
    * Return DTO containing resolved parameters with fields: `parameterId`, `parameterCode`, `parameterName`, `operator`, `numericValue`, `numericValueTo`, `textValue`, `unit`, `source`, `sortOrder`.
  * [ ] Run resolution tests:
    * Command: `node --test test/effective-spec-resolution.test.js`
    * Expected Result: Pass

---

### Task 10 — Customer Spec APIs + RBAC
* **Goal:** Wire endpoints for customer specs and resolved specifications.
* **Files:**
  * Modify: `src/products/routes.js`
  * Modify: `src/index.js`
  * Create: `test/customer-specs-routes.test.js`
* **Interfaces:**
  * Consumes: HTTP request, env
  * Produces: API endpoints:
    * `GET /api/customers/:customerId/specs`
    * `GET /api/customer-specs/:specId`
    * `GET /api/customer-specs/:specId/effective`
    * `POST /api/customer-specs` (Payload: `{ customerId, productId, application, baseStandardSpecId, effectiveDate, notes }`)
    * `PUT /api/customer-specs/:specId` (Payload: `{ overrides: [...] }`)
    * `POST /api/customer-specs/:specId/activate`
    * `POST /api/customer-specs/:specId/archive`
* **Steps:**
  * [ ] Create `test/customer-specs-routes.test.js` checking auth, RBAC, and payload validation errors.
    * Command: `node --test test/customer-specs-routes.test.js`
    * Expected Result: Fail
  * [ ] Register routes `/api/customer-specs` and `/api/customers/:customerId/specs` in `src/products/routes.js` and `src/index.js`.
  * [ ] Connect endpoints to repository functions. Return merged results from `resolveEffectiveCustomerSpec` on the `/effective` endpoint.
  * [ ] Apply RBAC: restrict `/activate` and `/archive` to `ADMIN` / `MANAGER`.
  * [ ] Run routes tests:
    * Command: `node --test test/customer-specs-routes.test.js`
    * Expected Result: Pass

---

### Task 11 — Frontend Product Master D1 Migration
* **Goal:** Refactor the frontend Product page to consume real D1 API data.
* **Files:**
  * Modify: `public/index.html`
* **Interfaces:**
  * Consumes: API endpoints:
    * `GET /api/products`
    * `POST /api/products`
    * `PUT /api/products/:id`
  * Produces: Refactored UI state and Product Identity editor.
* **Steps:**
  * [ ] Replace `state.products` mock initialization in `public/index.html` with an empty array.
  * [ ] Remove obsolete hardcoded quality properties (`starchMin`, `moistureMax`, etc.) from the product list and standard product views in the UI.
  * [ ] Update `loadCustomersFromApi` or equivalent init scripts in `startAuthenticatedApp()` to trigger `loadProductsFromApi()`.
  * [ ] Implement `loadProductsFromApi` using `fetch('/api/products')` and store the result in `state.products`.
  * [ ] Update Product creation and update forms:
    * Provide inputs for identity properties only (Code, Name, Short Name, Category, Form, HS Code, Default Unit, Status).
    * Provide checkboxes to select supported applications (`PET_GRADE`, `FEED_GRADE`).
    * Post/Put payload data to `/api/products` and reload products state.
  * [ ] Verify that saving a product updates D1 correctly.

---

### Task 12 — Frontend Standard Spec UI
* **Goal:** Create views for versioned Standard Specifications.
* **Files:**
  * Modify: `public/index.html`
* **Interfaces:**
  * Consumes: Standard Spec APIs
  * Produces: Standard Spec revision list, details tab, and draft parameter editor.
* **Steps:**
  * [ ] Implement `renderStandardSpecs(productId)` in `public/index.html` to display tabbed specifications for enabled applications.
  * [ ] Fetch and display standard spec revisions (Rev.0, Rev.1) showing status badges (`DRAFT`, `ACTIVE`, `ARCHIVED`).
  * [ ] Clicking a spec revision loads parameters from `/api/standard-specs/:specId` and displays them in a table.
  * [ ] Provide controls to "Create Draft" (if active or draft spec exists).
  * [ ] Provide parameter input forms for `DRAFT` specs, including parameter selection (using `/api/spec-parameters`), operators, values, and unit overrides.
  * [ ] Add an "Activate" button visible to `ADMIN` and `MANAGER` to promote draft specs.
  * [ ] Verify spec creation, modification, and activation from the UI.

---

### Task 13 — Frontend Customer / Contract Spec UI
* **Goal:** Build the UI interface for custom specs and overrides.
* **Files:**
  * Modify: `public/index.html`
* **Interfaces:**
  * Consumes: Customer Spec APIs
  * Produces: Custom specifications list and effective spec override viewer.
* **Steps:**
  * [ ] Add a "Specifications" tab under Customer CRM detail views in `public/index.html`.
  * [ ] Display existing Customer Specs revisions for the customer, product, and application.
  * [ ] Create a modal or sub-view that displays the combined effective specification (consuming `/api/customer-specs/:specId/effective`).
  * [ ] Visually style overridden parameters differently (e.g. bold or highlighted text with label "Override") compared to standard parameters (labeled "Inherited").
  * [ ] Provide overrides draft configuration forms for authorized roles.
  * [ ] Verify saving and rendering customer spec overrides.

---

### Task 14 — Regression & Full Verification
* **Goal:** Run tests across all components to ensure zero regression.
* **Files:**
  * None (Verification only)
* **Steps:**
  * [ ] Run all project tests:
    * Command: `npm test`
    * Expected Result: Pass (90 tests + new Phase 5D tests, 0 failed)
  * [ ] Run syntax checks:
    * Command: `node -c src/index.js; node -c src/products/repository.js; node -c src/products/routes.js; node -c src/products/validation.js`
    * Expected Result: Pass (no stdout, exit code 0)
  * [ ] Verify local working tree remains clean.

---

### Task 15 — Project Status / PR Preparation
* **Goal:** Update status documentation and prepare files for pull request.
* **Files:**
  * Modify: `docs/PROJECT_STATUS.md`
* **Steps:**
  * [ ] Update `docs/PROJECT_STATUS.md`:
    * Change Phase 5D status from pending/not started to `COMPLETE / MERGED / DEPLOYMENT PENDING` or equivalent code status once implemented.
    * Record the new migration script name (`0003_product_specs.sql`) and new test counts.
  * [ ] Verify no production changes or remote database mutations have been made.
  * [ ] Review code differences.

---

## TDD Requirements

Every backend task (Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 10) must strictly apply TDD:
1. Write the test asserting expected failure.
2. Execute the test and verify it fails (turns RED).
3. Write the minimum implementation code to make the test compile and return values.
4. Execute the test and verify it passes (turns GREEN).
5. Run regression tests.
6. Commit the task before starting the next one.
