# WCAT Sales Support App — Phase 5D Design Specification
## Product / Spec D1 Migration

**Date:** 2026-08-26  
**Status:** APPROVED DESIGN (Pending Implementation)  
**Target File:** `docs/superpowers/specs/2026-08-26-product-spec-d1-design.md`  

---

## 1. Executive Summary & Goal

The goal of Phase 5D is to migrate **Product** and **Specification** master data from the frontend mock state to Cloudflare D1. 

Historically, quality parameters (such as Starch, Moisture, Sand & Silica) were stored directly on the Product mock entity. In the real trade flow, quality specifications are highly versioned, application-specific (e.g., Feed Grade vs. Pet Grade), and frequently customized for specific customers or contracts.

This phase establishes a robust database-backed schema, versioning controls, and API endpoints for Products, Categories, Forms, Applications, and Specifications. It serves as the master-data foundation for upcoming phases including Pricing, PO Management, Shipping, and COA.

---

## 2. Scope Definition

### In Scope
* **Product Category Master:** Normalized table for raw-material families.
* **Product Form Master:** Normalized table for physical forms.
* **Product Master:** Holds product identity only (does NOT store quality parameters).
* **Product Applications:** Linked application types (e.g., `PET_GRADE`, `FEED_GRADE`).
* **Spec Parameter Master:** Reusable quality parameters (e.g., `STARCH`, `MOISTURE`, `PROTEIN`).
* **Versioned Standard Specs:** Product-specific standard specifications supporting integer revision numbers (e.g., `Rev.0`, `Rev.1`).
* **Flexible Standard Spec Items:** Linked spec parameters with operators (`MIN`, `MAX`, `RANGE`, `EXACT`, `TEXT`).
* **Versioned Customer Specs:** Customer-specific specifications referencing a base standard specification revision.
* **Customer Spec Overrides:** Specific quality parameter overrides for a customer spec.
* **D1-Backed Product/Spec API:** Full CRUD and resolution endpoints enforcing RBAC.
* **Frontend Migration:** Rework of the Product / Spec UI pages to consume D1 APIs.

### Out of Scope (For Future Phases)
* **Sample Trials** (under discussion for a future CRM phase).
* **Actual COA / Lab Results:** Quality results will live at the Shipment level (to be implemented later).
* **Shipment Quality Results** or matching logic.
* **Pricing & Special Prices** (Phase 5E/Future).
* **Purchase Orders (POs)** (Future).
* **Shipping / Delivery Instructions (DIs)** (Future).
* **Packaging, Containers, Bulk Vessel logic** (will remain prototype only/out of scope for Phase 5D).

---

## 3. Domain Model & ERD

The diagram below details the relationship between the Product Identity, Standard Specifications, and Customer Specifications.

```mermaid
erd
    product_categories ||--o{ products : "groups"
    product_forms ||--o{ products : "defines physical shape"
    products ||--|{ product_applications : "supports"
    products ||--o{ standard_specs : "has standard specs"
    standard_specs ||--|{ standard_spec_items : "defines parameters"
    spec_parameters ||--o{ standard_spec_items : "is typed"
    
    customers ||--o{ customer_specs : "owns custom specs"
    products ||--o{ customer_specs : "has customer specs"
    standard_specs ||--o{ customer_specs : "acts as base for"
    customer_specs ||--|{ customer_spec_overrides : "overrides parameters"
    spec_parameters ||--o{ customer_spec_overrides : "is typed"
```

---

## 4. Database Schema DDL (SQLite / Cloudflare D1)

The following tables must be added to the D1 schema via a new migration script:

```sql
-- 1. Product Categories Table
CREATE TABLE IF NOT EXISTS product_categories (
  category_id TEXT PRIMARY KEY,
  category_code TEXT NOT NULL UNIQUE,
  category_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')) DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Product Forms Table
CREATE TABLE IF NOT EXISTS product_forms (
  form_id TEXT PRIMARY KEY,
  form_code TEXT NOT NULL UNIQUE,
  form_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')) DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Product Master Table (Identity Only)
CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY,
  product_code TEXT NOT NULL UNIQUE,
  product_name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  category_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  hs_code TEXT NOT NULL DEFAULT '',
  default_unit TEXT NOT NULL DEFAULT 'MT',
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')) DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES product_categories(category_id),
  FOREIGN KEY (form_id) REFERENCES product_forms(form_id)
);

-- 4. Product Applications Table (Associative)
CREATE TABLE IF NOT EXISTS product_applications (
  product_id TEXT NOT NULL,
  application TEXT NOT NULL CHECK (application IN ('PET_GRADE', 'FEED_GRADE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, application),
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

-- 5. Spec Parameter Master Table
CREATE TABLE IF NOT EXISTS spec_parameters (
  parameter_id TEXT PRIMARY KEY,
  parameter_code TEXT NOT NULL UNIQUE,
  parameter_name TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK (data_type IN ('NUMBER', 'TEXT')),
  default_unit TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')) DEFAULT 'ACTIVE',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. Versioned Standard Specs Table
CREATE TABLE IF NOT EXISTS standard_specs (
  standard_spec_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  application TEXT NOT NULL CHECK (application IN ('PET_GRADE', 'FEED_GRADE')),
  revision_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')) DEFAULT 'DRAFT',
  effective_date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(product_id),
  FOREIGN KEY (product_id, application) REFERENCES product_applications(product_id, application),
  UNIQUE (product_id, application, revision_no)
);

-- Index to enforce ONLY ONE ACTIVE Standard Spec per Product/Application combo
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_standard_spec
  ON standard_specs (product_id, application)
  WHERE status = 'ACTIVE';

-- 7. Standard Spec Items Table (Specifications Parameters configuration)
CREATE TABLE IF NOT EXISTS standard_spec_items (
  standard_spec_item_id TEXT PRIMARY KEY,
  standard_spec_id TEXT NOT NULL,
  parameter_id TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('MIN', 'MAX', 'RANGE', 'EXACT', 'TEXT')),
  numeric_value REAL,
  numeric_value_to REAL,
  text_value TEXT,
  unit TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (standard_spec_id) REFERENCES standard_specs(standard_spec_id) ON DELETE CASCADE,
  FOREIGN KEY (parameter_id) REFERENCES spec_parameters(parameter_id),
  UNIQUE (standard_spec_id, parameter_id)
);

-- 8. Versioned Customer / Contract Specs Table
CREATE TABLE IF NOT EXISTS customer_specs (
  customer_spec_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  application TEXT NOT NULL CHECK (application IN ('PET_GRADE', 'FEED_GRADE')),
  base_standard_spec_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')) DEFAULT 'DRAFT',
  effective_date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id),
  FOREIGN KEY (product_id) REFERENCES products(product_id),
  FOREIGN KEY (base_standard_spec_id) REFERENCES standard_specs(standard_spec_id),
  UNIQUE (customer_id, product_id, application, revision_no)
);

-- Index to enforce ONLY ONE ACTIVE Customer Spec per Customer/Product/Application combo
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_customer_spec
  ON customer_specs (customer_id, product_id, application)
  WHERE status = 'ACTIVE';

-- 9. Customer Spec Overrides Table
CREATE TABLE IF NOT EXISTS customer_spec_overrides (
  customer_spec_override_id TEXT PRIMARY KEY,
  customer_spec_id TEXT NOT NULL,
  parameter_id TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('MIN', 'MAX', 'RANGE', 'EXACT', 'TEXT')),
  numeric_value REAL,
  numeric_value_to REAL,
  text_value TEXT,
  unit TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (customer_spec_id) REFERENCES customer_specs(customer_spec_id) ON DELETE CASCADE,
  FOREIGN KEY (parameter_id) REFERENCES spec_parameters(parameter_id),
  UNIQUE (customer_spec_id, parameter_id)
);
```

---

## 5. Specification & Parameter Logic

### Operators and Representation
Different quality parameters have different validation and logical representations:

| Operator | Type | DB Column Used | Example |
| :--- | :--- | :--- | :--- |
| **MIN** | Numeric | `numeric_value` | Starch $\ge 65\%$ |
| **MAX** | Numeric | `numeric_value` | Moisture $\le 14\%$ |
| **EXACT** | Numeric | `numeric_value` | Mesh Size $= 80$ |
| **RANGE** | Numeric | `numeric_value` (From), `numeric_value_to` (To) | Pellet Size $6$ mm $\to 10$ mm |
| **TEXT** | Textual | `text_value` | Color: "Light Cream", Odor: "Characteristic" |

* **Default Units:** Sourced from the `spec_parameters` master table.
* **Unit Overrides:** Can be overridden on a per-item basis inside `standard_spec_items` or `customer_spec_overrides` if required.

---

## 6. Versioning & Activation Lifecycle Rules

Specifications are treated as legally binding templates and follow a strict lifecycle flow:

```text
       ┌───────────┐
       │   DRAFT   │
       └─────┬─────┘
             │ (Activate)
             ▼
       ┌───────────┐
       │  ACTIVE   │
       └─────┬─────┘
             │ (New ACTIVE spec approved / Deactivated)
             ▼
       ┌───────────┐
       │ ARCHIVED  │
       └───────────┘
```

### Business Rules
1. **Revision Increments:** Revisions start at `0` (`Rev.0`). New draft revisions increment the integer of the previous highest revision for that configuration.
2. **Single Active Rule:** 
   * Maximum of **one** `ACTIVE` Standard Spec revision per `(product_id, application)`.
   * Maximum of **one** `ACTIVE` Customer Spec revision per `(customer_id, product_id, application)`.
   * Activating a new draft automatically transitions the existing `ACTIVE` revision to `ARCHIVED` in a single transaction.
3. **Immutability of History:** `ARCHIVED` and `ACTIVE` specifications are legally locked and cannot be edited. Any changes require creating a new `DRAFT` revision.
4. **Base Standard Reference preservation:** When a Customer Spec is created, it references a specific `base_standard_spec_id` version (e.g. `Rev.2` of standard THP65 Feed Grade). The Customer Spec does *not* auto-update or follow standard spec changes; it is pinned to its base version forever.

### Future PO Compatibility
When a Purchase Order is created:
1. The system checks if there is an `ACTIVE` Customer Spec for the customer, product, and application.
2. If it exists, that specific `customer_spec_id` is linked to the PO.
3. If no Customer Spec exists, the system links the current `ACTIVE` `standard_spec_id` for that product and application.
4. The PO preserves the exact specification revision ID. Changes to standard/customer specs must never retroactively modify completed or existing PO spec rules.

---

## 7. Role-Based Access Control (RBAC)

The endpoints and actions are secured according to roles:

| Action / Entity | ADMIN | MANAGER | SALES_SUPPORT | Others (EXPORT, etc.) |
| :--- | :---: | :---: | :---: | :---: |
| Read Product / Category / Form | Yes | Yes | Yes | Yes (if authorized) |
| Write Product / Category / Form | Yes | Yes | No | No |
| Create Draft Standard/Cust Spec | Yes | Yes | Yes | No |
| Edit Draft Standard/Cust Spec | Yes | Yes | Yes | No |
| Activate Draft Spec | **Yes** | **Yes** | **No** | No |
| Archive Active Spec | **Yes** | **Yes** | **No** | No |

---

## 8. Backend Validation Requirements

* **Product Code:** Must be unique and trimmed.
* **HS Code:** Enforce current business rule: *1 Product = 1 HS Code*. If multiple applications are enabled, they must share the same HS Code (validated on Product Master).
* **Linked Application Validation:** Specifications can only be created for applications that are active on the target Product (via `product_applications`).
* **Operator Consistency:** Prevent numeric operators (`MIN`, `MAX`, `RANGE`, `EXACT`) from being used on textual parameters (and vice versa).
* **Range Validation:** Ensure `numeric_value_to > numeric_value` for `RANGE` operators.
* **No Duplicate Parameters:** Prevent the same parameter from appearing multiple times within the same specification revision.
* **Self-Lockout Check:** Standard checks apply to user role actions.

---

## 9. API Specifications

### Product Management
* `GET /api/products` — List all products with their categories, forms, and applications.
* `GET /api/products/:id` — Detail of a product.
* `POST /api/products` — Create a product identity and enable applications. (Admin/Manager only).
* `PUT /api/products/:id` — Update product identity (excludes spec parameter rules). (Admin/Manager only).

### Standard Specs
* `GET /api/products/:id/standard-specs` — List all standard spec revisions for a product.
* `GET /api/standard-specs/:specId` — Fetch detail of a spec revision, resolving all parameters and values.
* `POST /api/standard-specs` — Create a new `DRAFT` revision for a `(product_id, application)`. If an active standard spec exists, parameters are copied to initialize the new draft.
* `PUT /api/standard-specs/:specId` — Edit parameters of a `DRAFT` specification.
* `POST /api/standard-specs/:specId/activate` — Promote draft to `ACTIVE`, archiving any previous active spec. (Admin/Manager only).
* `POST /api/standard-specs/:specId/archive` — Archive an active spec. (Admin/Manager only).

### Customer Specs
* `GET /api/customers/:customerId/specs` — List all custom specs.
* `GET /api/customer-specs/:specId` — Fetch a customer spec, resolving the effective parameters (Base Standard parameters + Customer overrides applied).
* `POST /api/customer-specs` — Create a `DRAFT` customer spec, specifying `customer_id`, `product_id`, `application`, and `base_standard_spec_id`.
* `PUT /api/customer-specs/:specId` — Edit overrides on a `DRAFT` customer spec.
* `POST /api/customer-specs/:specId/activate` — Activate customer spec. (Admin/Manager only).

---

## 10. Frontend Flows

### UI Organization
1. **Product / Spec Hub:**
   * Replaces mock products list.
   * Clicking a product opens the product dashboard.
2. **Product Dashboard:**
   * Shows Identity card (HS Code, Category, Form, Status).
   * Tabbed sections for **Applications** enabled.
   * Under each Application, list **Standard Spec Revisions** (`Rev.0`, `Rev.1`) with color-coded status badges.
3. **Spec Detail / Edit Form:**
   * Shows the parameter list.
   * Drafts show "Edit" buttons and inputs. Active/Archived specs show read-only tables.
4. **Customer Spec Matrix:**
   * Shows the base standard spec.
   * Highlighting overrides (e.g., standard moisture max 14%, overridden to 13%).
   * Renders the final combined "Effective Specification".

---

## 11. Testing Specification (TDD Framework)

Every behavior must be guarded by test cases in `test/product-spec.test.js`:

* **Product Master Tests:**
  * Validate uniqueness of product code, category code, and form code.
  * Enforce that a product cannot be saved with an invalid category or form reference.
* **Product Applications Tests:**
  * Enable multiple applications on one product, and block spec creation for applications that are not enabled.
* **Standard Spec Lifecycle Tests:**
  * Prevent edits to `ACTIVE` and `ARCHIVED` specs.
  * Test that activating a draft auto-archives the existing active spec.
  * Verify the SQLite partial index rules prevent two active specs.
* **Customer Spec Resolution Tests:**
  * Create standard spec: Starch 65% Min, Moisture 14% Max.
  * Create customer spec with override: Moisture 13% Max.
  * Query final effective spec: Verify Starch is inherited (65% Min) and Moisture is overridden (13% Max).
* **RBAC Tests:**
  * Validate that `SALES_SUPPORT` gets a 403 on activation endpoints.
  * Validate that unauthenticated requests receive a 401.
* **Regression Tests:**
  * Run full test suite to guarantee zero impacts on Auth, Customers, and Users.

---

## 12. Success Criteria

Phase 5D is considered complete when:
1. Production D1 database contains the 9 new tables listed in Section 4.
2. All quality parameters have been purged from the `products` table and successfully isolated in `standard_spec_items` and `customer_spec_overrides`.
3. Standard and Customer specifications support revision numbers and enforce the single active specification rule in both code and D1 index levels.
4. Frontend displays, registers, edits, and resolves specification parameters exclusively through the new D1 endpoints.
5. Deployed code passes 100% of test cases, and existing migrated modules operate with zero regression.
