# Phase 5E — Simple Commercial & Shipment Control Design

Date: 2026-08-26
Status: DESIGN APPROVED — awaiting written spec review before implementation planning

## 1. Purpose

Phase 5E adds a lightweight commercial and shipment-control layer without building a full Pricing Engine.

The system should answer four operational questions quickly:

1. What price did a Manager instruct a salesperson to offer today?
2. What Ocean Freight was quoted, and what did it actually cost?
3. What were the actual export expenses for a Shipment?
4. Where are the Shipment's supporting documents stored?

Important workflow principles:

- Actual sold-price history remains owned by PO records.
- Manager Price Note is not a quotation or confirmed sale.
- Shipment actual expenses are owned by Shipment.
- Existing team documents remain stored in Google Drive.
- Phase 5E stores Drive links only.
- Do not introduce R2/file storage in this phase.
- Keep the workflow simple for Managers and Export/Sales Support users.

---

## 2. Scope

Phase 5E contains four main functional areas:

1. Manager Price Note
2. Freight Quote vs Actual Freight
3. Shipment Actual Cost
4. Shipment Document Links

Overall workflow:

Manager Price Note
→ Freight Quote when required
→ PO
→ Shipment
   → Actual Cost
   │   └── Ocean Freight / Shipping Charges
   └── Document Links

This is a Hybrid Simple design.

Do not build a full Pricing Engine.

---

## 3. Manager Price Note

### Goal

Allow a Manager to quickly record a price instruction such as:

"Today, give Sira 355 USD/MT CFR Rotterdam for THP65 to offer to Meelunie."

This is sales guidance/history only.

It is NOT:
- a quotation document
- a PO
- a confirmed-sale record
- a price approval workflow

Actual sales history will be viewed from PO records.

### Fields

Suggested data:

- id
- sales_user_id
- customer_id
- product_id
- incoterm
- destination_port
- offer_price_usd_per_mt
- note
- created_by_manager_id
- created_at

Incoterm values for this phase:

- FOB
- CFR
- CIF

### UI

Keep the form short:

Sales
[ Select Salesperson ]

Customer
[ Select Customer ]
→ filter Customer list according to selected Sales owner

Product
[ Select Product ]

Incoterm
[ FOB / CFR / CIF ]

Destination Port
[ Select / input ]
→ show/require for CFR and CIF
→ optional/hidden for FOB

Offer Price
[ 355.00 ] USD/MT

Note
[ free text ]

[ Save ]

Only one Salesperson per Price Note.

### History

Below the form, show recent Price Notes newest first.

Suggested filters:

- Sales
- Customer
- Product
- Date range

Do not add:
- Quantity
- FX
- Margin
- Active/Inactive
- Revision workflow
- Confirmed status
- Approval workflow

All previous notes remain as history.

The newest note for Customer + Product can be displayed as the latest Manager price guidance.

---

## 4. Freight Quote

### Goal

Let Export/Sales Support record Ocean Freight quotes before a CFR/CIF offer or before Shipment exists.

Freight Quote exists independently from Shipment because it can be checked before PO or Shipment creation.

### Fields

Suggested data:

- id
- origin_port
- destination_port
- container_size
- shipping_line_or_forwarder
- quoted_freight_usd_per_container
- valid_until
- remark
- created_by
- created_at

### Rules

- Freight Quote uses USD only.
- Unit is USD / Container.
- No FX is stored at quotation stage.
- No automatic Selling Price calculation.
- No freight API integration.
- No freight approval workflow.

Manager uses freight information only as reference when deciding the selling price.

For FOB, WCAT should not be assumed to bear Ocean Freight.

For CFR/CIF, Ocean Freight may be relevant to the commercial offer.

---

## 5. Ocean Freight vs Shipping / Local Charges

Ocean Freight must be kept separate from Shipping / Local Charges.

### Ocean Freight

Relevant mainly for CFR/CIF where WCAT bears Ocean Freight.

Examples:

Quoted Freight:
1,450 USD / Container

Actual Freight:
1,520 USD / Container

Freight variance must be visible in USD.

Do not mix Ocean Freight with BL / THC / Seal.

### Shipping / Local Charges

These may occur on FOB, CFR, and CIF Shipments.

Examples:

- BL Fee
- THC
- Seal Fee
- Documentation Fee
- Container-related charges
- Other shipping line/local charges

Therefore:

Ocean Freight != BL + THC + Seal + Local Charges

They must be separate expense categories/groups.

---

## 6. Shipment Actual Cost

### Goal

Allow the team to record actual export costs for each Shipment line-by-line and calculate total Actual Export Cost in THB.

Every expense is linked directly to one Shipment.

### Expense Fields

Suggested data:

- id
- shipment_id
- expense_category_id
- amount
- currency
- fx_used
- amount_thb
- reference_no
- shipment_document_link_id
- remark
- created_by
- created_at
- updated_by
- updated_at

### Supported Currencies

Only:

- THB
- USD

### THB Expense

If Currency = THB:

amount_thb = amount
fx_used = NULL

### USD Expense

If Currency = USD:

FX Used is required.

amount_thb = amount × fx_used

Example:

Freight Invoice:
1,520 USD

FX Used from Shipping Line billing:
34.82 THB/USD

Amount THB:
1,520 × 34.82
= 52,926.40 THB

Important:

FX Used is NOT from an FX Master.

It is the actual exchange rate shown on the invoice / billing document for that Shipment.

Sales Price and Freight Quote remain USD-only.

FX only appears during Actual Shipment Cost recording.

---

## 7. Expense Category Master

Expense categories should be configurable rather than hard-coded.

Suggested fields:

- id
- name
- category_group
- status
- sort_order

Suggested status:

- ACTIVE
- INACTIVE

Suggested Category Groups:

- OCEAN_FREIGHT
- SHIPPING_LOCAL
- TRANSPORT
- DOCUMENT
- INSURANCE
- OTHER

Suggested initial categories:

OCEAN_FREIGHT
- Ocean Freight

SHIPPING_LOCAL
- BL Fee
- THC
- Seal Fee
- Other Shipping / Local Charge

TRANSPORT
- Truck / Inland Transport

DOCUMENT
- Documentation
- Fumigation
- Inspection

INSURANCE
- Insurance

OTHER
- Bank Charge
- Other

Category Group is mainly structural.

Users should see business-friendly category names.

ADMIN/MANAGER should be able to manage Expense Categories following existing RBAC conventions.

---

## 8. Freight Actual Special Logic

Actual Ocean Freight must still be stored as a normal Shipment Expense.

Do NOT create a completely separate duplicate Actual Freight table if unnecessary.

If Expense Category Group = OCEAN_FREIGHT:

the system can compare the Shipment's actual Ocean Freight against the Freight Quote referenced by that Shipment.

Display:

Quoted Freight USD
Actual Freight USD
Freight Variance USD

Actual Freight's converted THB amount remains part of Shipment Actual Export Cost.

Freight variance comparison remains USD-to-USD.

FX does not participate in quoted freight comparison.

---

## 9. Shipment Document Links

### Goal

Create a central index of Shipment documents while leaving the physical files in the team's existing Google Drive.

Do not upload files into the application.

Do not introduce Cloudflare R2.

Only store metadata and Drive links.

### Document Types

Each Shipment supports:

- PO
- DI
- Booking
- Stuffing Report
- All Ship Doc
- IR
- LC

IR and LC must remain separate document types.

Each type may contain multiple links.

Example:

All Ship Doc
- Invoice/Packing List link
- BL link
- Phyto link

LC
- Original LC
- Amendment 1
- Amendment 2

### Fields

Suggested data:

- id
- shipment_id
- document_type
- title
- drive_url
- reference_no
- remark
- created_by
- created_at
- updated_at

### Rules

- Multiple links per Document Type are allowed.
- Drive URL must be valid HTTP/HTTPS.
- No Google Drive API integration in Phase 5E.
- No permission management in Phase 5E.
- Do not copy/move/upload the source file.
- Expense may optionally reference a Shipment Document Link.

---

## 10. Shipment UI

Keep Shipment Detail simple with three main tabs:

Shipment Detail
├── Overview
├── Costs
└── Documents

### Overview

Show useful Manager-level summary:

- Shipment ID
- Customer
- Product
- Incoterm

Ocean Freight:
- Quoted USD
- Actual USD
- Variance USD

Actual Export Cost:
- Total THB

Documents:
- PO
- DI
- Booking
- Stuffing Report
- All Ship Doc
- IR
- LC

Show document check/indicator when at least one link exists.

Example:

PO               ✓
DI               ✓
Booking          ✓
Stuffing Report  ✓
All Ship Doc     ✓
IR               ✓
LC               -

These indicators represent presence of a link only.

They are NOT approval/compliance status.

### Costs Tab

Show:

- Add Expense
- Expense table
- Category
- Original Amount
- Currency
- FX Used
- Amount THB
- Reference No.
- linked Shipment Document
- Remark
- Total Actual Export Cost THB

### Documents Tab

Show document groups:

- PO
- DI
- Booking
- Stuffing Report
- All Ship Doc
- IR
- LC

Each group:

[ + Add Link ]

Allow multiple entries.

---

## 11. Data Flow

### Before Sale

Manager Price Note
↓
Freight Quote if CFR/CIF freight information is needed
↓
Manager decides price manually
↓
Sales offers Customer

No automatic pricing calculation.

### Actual Sale

When Customer confirms and PO exists:

Actual sales history is owned by PO.

Do not duplicate confirmed sale price into Manager Price Note unless a future requirement explicitly requires it.

### Shipment

Shipment is created through existing workflow.

Then:

Shipment
├── actual expenses
├── actual Ocean Freight
└── document links

If applicable, Shipment references the Freight Quote used when pricing.

Ocean Freight Actual:
Expense Category Group = OCEAN_FREIGHT

Then calculate Freight Variance in USD.

Actual Shipment Expenses:
normalize to THB.

Documents:
store Drive links only.

---

## 12. Validation and Error Handling

Required validations:

Manager Price Note:
- Offer Price > 0
- CFR/CIF requires Destination Port
- FOB Destination Port optional
- Sales, Customer, Product references must be valid
- Customer visibility/ownership rules must follow existing CRM logic

Freight Quote:
- quoted freight > 0
- USD only
- route/container fields required as appropriate

Shipment Expense:
- amount > 0
- Currency only THB or USD
- if USD, fx_used > 0 required
- if THB, fx_used should be null/not required
- amount_thb must be calculated consistently

Shipment Documents:
- valid Shipment required
- valid HTTP/HTTPS Drive URL
- multiple links per type allowed

Security:
- all write operations require authenticated user
- follow existing RBAC conventions
- avoid orphan records
- validate foreign keys/visibility server-side
- use existing standard error response conventions

---

## 13. RBAC Direction

Use existing project RBAC patterns.

Design intent:

ADMIN:
- full access

MANAGER:
- create/manage Manager Price Notes
- manage Freight Quote
- manage Shipment Costs
- manage Shipment Document Links
- manage Expense Category Master

SALES_SUPPORT / Sales-related users:
- read Price Notes allowed by visibility
- Freight Quote create/edit may be allowed according to existing Export/Sales Support responsibilities
- Shipment Costs and Documents create/edit may be allowed according to existing Shipment permissions
- no Manager-only price authority

Do not invent a new RBAC framework.

Reuse the current auth/role architecture.

Final permission mapping should be verified against current repository patterns during implementation planning.

---

## 14. Testing Requirements

Implementation plan must include automated testing for at least:

Manager Price Note:
- create
- list
- filters
- Sales → Customer filtering
- FOB destination optional
- CFR/CIF destination required
- latest-note ordering
- RBAC

Freight Quote:
- CRUD
- USD-only
- route/container validation
- permissions

Expense:
- THB expense calculation
- USD expense + FX calculation
- missing FX rejection
- invalid FX rejection
- total Shipment Actual Cost
- Category Group handling
- Ocean Freight detection
- Freight variance calculation

Documents:
- multiple links per document type
- PO / DI / Booking / Stuffing Report / All Ship Doc / IR / LC
- IR and LC separate
- URL validation
- RBAC

Regression:
All existing Auth, Customer CRM, External Sales, User Admin, and Product/Spec tests must continue passing.

Do not weaken existing tests.

---

## 15. Explicitly Out of Scope

Do NOT implement these in Phase 5E:

- Full Pricing Engine
- Cost-based pricing
- Target-price pricing engine
- Target Margin
- Margin %
- FX Master
- automatic Selling Price calculation
- automatic CFR/CIF calculation
- Price Approval Workflow
- formal Quotation PDF
- Cloudflare R2
- file upload/storage
- Google Drive API integration
- automatic Drive permission handling
- external Freight API
- Product-cost accounting
- full Shipment P&L
- total commercial margin
- automatic confirmed-sale Price History
- complex document approval/versioning

YAGNI: do not add these unless explicitly requested later.

---

## 16. Design Principles

1. Simple for Managers.
2. Fast data entry.
3. Reuse existing Customer, Product, User/Sales, Auth, PO, and Shipment data.
4. Do not duplicate information already owned by PO.
5. Price Note represents Manager guidance, not actual sale.
6. Ocean Freight must stay separate from BL/THC/Seal/local charges.
7. Actual Shipment Cost is normalized to THB.
8. Preserve original USD amounts and invoice FX for auditability.
9. Keep documents in Drive; store links only.
10. Prefer clear history over revision/approval complexity.
11. Follow current Cloudflare Worker + D1 architecture and existing code patterns.
12. Avoid unrelated refactoring.
