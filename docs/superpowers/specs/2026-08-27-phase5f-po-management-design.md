# Phase 5F — PO Management Design

Date: 2026-08-27
Status: DESIGN APPROVED — awaiting written spec review before implementation planning

## 1. Purpose

Phase 5F migrates PO Management from frontend/mock-centric behavior into a real Cloudflare Worker + D1 workflow.

The objective is to make PO the authoritative commercial source of truth before full DI and Shipment migration.

Phase 5F must support:

1. Stable internal PO identity.
2. Full PO revision history.
3. Multiple products per PO.
4. Exact Product Spec references per PO line.
5. Manager approval before a revision becomes active.
6. Role-based views of commercial vs operational data.
7. Audit-safe change history.
8. Future DI/Shipment linkage through exact PO revision and line references.

Phase 5F intentionally does NOT migrate the full DI or Shipment workflow. Those remain future phases.

---

## 2. Architecture Choice

Approved architecture: **Header + Revision + Lines using full snapshots**.

```text
PO Header
└── PO Revision
    └── PO Revision Lines
```

A PO Header is the permanent identity of the contract.
A PO Revision is a complete commercial snapshot at a point in time.
Every revision stores a full copy of all current PO lines, even when a line is unchanged from the previous revision.

Do NOT use delta-only revisions or event sourcing as the primary PO state model.

---

## 3. PO Header

Suggested table: `po_headers`

Core fields:
- id
- customer_id
- header_status
- current_active_revision_id
- current_draft_revision_id
- created_by
- created_at
- cancelled_by
- cancelled_at
- cancellation_reason

### Internal PO ID

Server-generated company-wide annual sequence:

```text
PO-2026-001
PO-2026-002
PO-2026-003
```

Rules:
- generated server-side
- stable identity for the life of the PO
- Customer PO No. is stored separately

### Header Status

- OPEN
- PARTIALLY_SHIPPED
- COMPLETED
- CANCELLED

Phase 5F does not calculate Shipment quantities yet.
COMPLETED ultimately requires MANAGER/ADMIN confirmation.
CANCELLED is terminal and cannot be reopened.

---

## 4. PO Revision

Suggested table: `po_revisions`

Core fields:
- id
- po_id
- revision_no
- status
- customer_po_no
- po_date
- buyer_reference
- ownership_type_snapshot
- sales_owner_user_id_snapshot
- customer_contact_id
- customer_contact_snapshot_json
- currency
- incoterm
- destination
- delivery_start
- delivery_end
- valid_until
- payment_term_snapshot
- commercial_terms
- operational_note
- revision_note
- approved_by
- approved_at
- approval_note
- approval_summary_json
- created_by
- created_at

Revision statuses:
- DRAFT
- ACTIVE
- SUPERSEDED

Lifecycle:

```text
Create PO
→ Rev.0 DRAFT
→ Review
→ MANAGER / ADMIN Activate
→ Rev.0 ACTIVE

Material change
→ Create New Revision
→ clone Active revision + all lines
→ new revision DRAFT
→ edit
→ review diff
→ MANAGER / ADMIN Activate
→ old ACTIVE becomes SUPERSEDED
→ new DRAFT becomes ACTIVE
```

Rules:
- max one ACTIVE revision per PO
- max one DRAFT revision per PO
- Active commercial data is immutable
- approval fields are never cloned into the next Draft

---

## 5. Customer PO No. and References

Each revision stores:
- Customer PO No.
- PO Date / Order Date
- optional Buyer Reference / Contract No.

Customer PO No. must be unique within one Customer across all history.
The same number may exist for different Customers.
A used number remains reserved even if the PO is cancelled or a later revision changes the Customer PO No.

Changing Customer PO No. is material and requires a new revision plus MANAGER/ADMIN activation.

---

## 6. Customer Ownership Model

Approved ownership types:
- ASSIGNED_SALES
- HOUSE_ACCOUNT

### ASSIGNED_SALES
- Customer must have Sales Owner in CRM
- if missing, PO creation is blocked
- External Sales visibility follows ownership
- Manager Price Note matching uses Sales + Customer + Product + Incoterm

### HOUSE_ACCOUNT
- sales owner may be NULL
- SALES_SUPPORT jointly manages the account
- no separate Internal Account Owner
- External Sales cannot see House Account POs
- commission defaults to zero
- Manager Price Note may use `sales_user_id = NULL`
- price note matching uses Customer + Product + Incoterm

Each revision stores ownership and sales-owner snapshots for audit.
Current Customer owner may still be displayed separately from CRM.

---

## 7. Customer Contact and Payment Term

PO Revision may reference a Customer Contact from CRM and stores a snapshot of name/email/phone.

Payment Term:
- default from Customer CRM
- stored as revision snapshot
- can be overridden for a PO
- material change after activation

---

## 8. Currency and Header Commercial Rules

One PO Revision uses one Currency across all lines.
Phase 5F UI supports USD / THB / EUR.
Schema may be extensible to other ISO codes later.

One Revision also uses one Incoterm and one Destination / Place of Delivery.
Phase 5F follows existing commercial conventions such as FOB / CFR / CIF.

Delivery Period is one range for the whole Revision.
Validation: `delivery_start <= delivery_end`.

`Valid Until` is separate from Delivery Period.
If expired:
- cannot activate the revision
- future DI/Shipment creation from it must be blocked
- historical references remain readable

---

## 9. PO Revision Lines

Suggested table: `po_revision_lines`

Core fields:
- id
- po_revision_id
- line_no
- previous_line_id
- product_id
- spec_source
- spec_revision_id
- spec_override_json
- contract_qty_mt
- tolerance_pct
- min_qty_mt
- max_qty_mt
- unit_price
- price_unit
- source_price_note_id
- suggested_price
- price_override_reason
- packaging
- container_type
- loading_pattern
- commission_recipient_user_id
- commission_rate_usd_mt
- commercial_line_term
- operational_line_note
- created_at

One PO may contain multiple products.

### Line numbering
Use stable numbers such as 10, 20, 30.
- system suggests next number
- user may edit before activation
- unique within one Revision
- existing lineage keeps same line_no across revisions
- new Product means new line identity and new line_no

### Line lineage
Every cloned line stores `previous_line_id`.
Keep both line_no and previous_line_id.

### Removing a line
If omitted in a new Revision:
- it remains in older revisions
- create an audit event showing removal
- do not mutate the old line with a retroactive removal flag

---

## 10. Quantity and Tolerance

Tolerance is per PO Line.

```text
min_qty_mt = contract_qty_mt × (1 - tolerance_pct / 100)
max_qty_mt = contract_qty_mt × (1 + tolerance_pct / 100)
```

Future DI/Shipment phases should expose:
- Planned Balance from DI
- Actual Balance from actual Shipment quantity

These balances are out of scope for Phase 5F.

---

## 11. Price and Amount

Unit Price is per line.
One Revision uses one Currency across all lines.

Schema keeps `price_unit` extensible, but Phase 5F UI uses `/MT` only.

```text
Contract Amount = Contract Qty × Unit Price
Maximum Amount = Max Qty × Unit Price

PO Contract Amount = sum(Line Contract Amount)
PO Maximum Amount = sum(Line Maximum Amount)
```

Credit Limit validation is out of scope.

---

## 12. Manager Price Note Integration

Manager Price Note is a suggested price source, not a mandatory price.

ASSIGNED_SALES match:
- Sales
- Customer
- Product
- Incoterm

HOUSE_ACCOUNT match:
- Customer
- Product
- Incoterm
- sales_user_id = NULL

If a matching note exists, Line Editor shows suggested price, source note, issued by, and issued at.

If Actual PO Price differs from Suggested Price:
- user may still save
- `Price Override Reason` is required
- store `source_price_note_id` when applicable

No second price approval workflow is added.

---

## 13. Product Spec Resolution

Every PO Line must have an exact approved Spec reference before activation.

```text
ACTIVE Customer Spec
→ otherwise ACTIVE Standard Spec
→ otherwise BLOCK ACTIVATE
```

Draft Specs must never be used.
Store spec_source and exact spec_revision_id.

Historical POs keep the exact referenced revision even if it is later archived.
Do not silently switch old POs to the latest Spec.

If Draft references a Spec revision that is no longer the current Active revision:
- show warning
- MANAGER/ADMIN may keep exact old revision or update to latest before activation
- keeping the old revision creates an audit event

PO-specific Spec Override:
- allowed only through a PO Revision
- material change
- requires MANAGER/ADMIN activation
- stored as line snapshot
- does not modify Customer or Standard Spec

---

## 14. Packaging, Container, Loading

Per PO Line:
- packaging
- container_type
- loading_pattern

Different products may use different arrangements.
These are material changes and require a new Revision after activation.

---

## 15. Commission

Commission is per PO Line.

Fields:
- commission_recipient_user_id
- commission_rate_usd_mt

HOUSE_ACCOUNT defaults:
- recipient = NULL
- rate = 0

Commission may differ by line.
Changing commission after activation is material.
Commission payment/settlement is out of scope.

---

## 16. Commercial Terms vs Operational Notes

Revision level:
- Commercial/Special Terms = material, new Revision required
- Operational Note = non-material, editable on Active with audit

Line level:
- Commercial Line Term = material, new Revision required
- Operational Line Note = non-material, editable on Active with audit

---

## 17. PO Documents

Suggested table: `po_revision_documents`

Fields:
- id
- po_revision_id
- document_type
- label
- url
- created_by
- created_at
- updated_by
- updated_at

Document types:
- CUSTOMER_PO
- AMENDMENT
- EMAIL_CONFIRMATION
- OTHER

Multiple links per Revision are allowed.
Files remain in Google Drive/existing storage; Phase 5F stores links only.

Before activation, at least one CUSTOMER_PO or EMAIL_CONFIRMATION is required.
AMENDMENT alone is insufficient.

Documents are non-material and may be added/edited on Active with audit.

---

## 18. Approval and Review

Draft edit permission:
- SALES_SUPPORT
- MANAGER
- ADMIN

Activation permission:
- MANAGER
- ADMIN

Before activation show Review Summary containing key Overview, ownership/contact snapshots, all Lines, Spec references/overrides, Qty/tolerance, packaging, suggested vs actual price, override reason, commission, terms, documents, and revision note.

Revision Note:
- Rev.0 optional
- Rev.1+ required

For Rev.1+, show material diff against current Active revision.

---

## 19. Approval Audit Snapshot

At activation store:
- approved_by
- approved_at
- optional approval_note
- searchable key approval fields where useful
- full Review Summary JSON snapshot

This preserves what the approver actually reviewed.

---

## 20. Activation Transaction

Activation is a dedicated atomic business action.

Rev.0:
```text
Rev.0 DRAFT → ACTIVE
header.current_active_revision_id → Rev.0
header.current_draft_revision_id → NULL
```

Rev.1+:
```text
old ACTIVE → SUPERSEDED
new DRAFT → ACTIVE
header.current_active_revision_id → new revision
header.current_draft_revision_id → NULL
```

All changes and required audits must succeed together or rollback.

---

## 21. Activation Validation

Server-side checks include:
- required Overview fields exist in D1
- at least one line
- every line valid
- unique line numbers
- every line has approved exact Spec reference
- required evidence document exists
- Valid Until not expired
- Customer ownership valid
- Customer PO historical uniqueness valid
- Price Override Reason present when needed
- Rev.1+ Revision Note present
- no conflicting Draft/Active state

Frontend validation is convenience only; backend is authoritative.

UI must also block Review/Activate while there are unsaved changes.

---

## 22. Hard Delete Rules

Hard delete only if:
- PO has never had an Active Revision
- it is still only an unapproved Draft

Once any Revision has ever been Active:
- no hard delete
- keep history permanently
- use CANCELLED for business cancellation

---

## 23. Cancellation

Only MANAGER/ADMIN may cancel.
Required:
- cancellation_reason
- cancelled_by
- cancelled_at

CANCELLED is terminal.
No new DI/Shipment may be created from it.
Historical references remain readable.

---

## 24. Audit Model

Use two layers.

### Event audit
Suggested table: `po_audit_events`

Examples:
- PO_CREATED
- REVISION_CREATED
- REVISION_ACTIVATED
- REVISION_SUPERSEDED
- PO_LINE_ADDED
- PO_LINE_REMOVED
- DOCUMENT_ADDED
- DOCUMENT_UPDATED
- OPERATIONAL_NOTE_UPDATED
- PO_CANCELLED
- SPEC_OLD_REVISION_CONFIRMED
- PRICE_OVERRIDE_USED

### Field diff audit
Suggested table: `po_field_diffs`

Fields include:
- po_revision_id
- entity_type
- entity_id
- field_name
- old_value
- new_value

Audit visibility:
- SALES_SUPPORT
- MANAGER
- ADMIN

---

## 25. RBAC

Reuse existing auth/role architecture.

### ADMIN
Full PO workflow access.

### MANAGER
Full Phase 5F business workflow access, including activate/cancel.

### SALES_SUPPORT
- view all POs
- create PO
- edit Draft
- create next Revision
- manage documents
- edit operational notes
- view commercial data needed for PO preparation
- view audit
- cannot activate
- cannot cancel

### EXTERNAL_SALES
- only ASSIGNED_SALES Customers owned by that user
- never HOUSE_ACCOUNT
- only Active Revision
- read-only
- may see necessary summary and own commission
- cannot see other commission, Draft, internal audit, approval snapshot, or internal notes

If a Draft exists alongside Active, External Sales continues seeing Active until the Draft is approved.

### EXPORT
Read-only operational view.
May see Product, Qty, Packaging, Container, Loading, Delivery Period, Incoterm, Destination, Spec, relevant documents, PO status.
Must not receive Unit Price, Contract/Maximum Amount, Commission, Price Override Reason, internal commercial audit.

### PRODUCTION_WAREHOUSE
Read-only production view.
May see Product, Qty, Spec, Packaging, Delivery Period, and production-relevant Commercial Line Terms.
Must not receive pricing or unrelated commercial/shipping details.

Security rule: restricted fields must be omitted server-side, not only hidden in the UI.

---

## 26. API Boundaries

Suggested routes:

```text
GET    /api/pos
POST   /api/pos
GET    /api/pos/:poId
DELETE /api/pos/:poId

GET    /api/pos/:poId/revisions
GET    /api/pos/:poId/revisions/:revisionId
PATCH  /api/pos/:poId/revisions/:revisionId

POST   /api/pos/:poId/revisions/:revisionId/lines
PATCH  /api/pos/:poId/revisions/:revisionId/lines/:lineId
DELETE /api/pos/:poId/revisions/:revisionId/lines/:lineId

POST   /api/pos/:poId/revisions/:revisionId/documents
PATCH  /api/pos/:poId/revisions/:revisionId/documents/:documentId

POST   /api/pos/:poId/revisions/:revisionId/create-next
GET    /api/pos/:poId/revisions/:revisionId/review
POST   /api/pos/:poId/revisions/:revisionId/activate

GET    /api/pos/:poId/history
POST   /api/pos/:poId/cancel
```

Exact paths may be adjusted during planning to fit current conventions.
Activation and cancellation must not be generic status PATCHes.

---

## 27. Role-Specific Read Models

Conceptual read models:
- POCommercialView
- POOperationalView
- POExternalSalesView
- POProductionView

Exact class names are optional; response boundaries are required.

---

## 28. PO List UI

One row per PO Header.
Default view emphasizes active working POs.
Filters support historical COMPLETED/CANCELLED.
Search supports Internal PO ID, Customer PO No., Customer, Product.

Show revision badges such as:
```text
Active Rev.2
Draft Rev.3
```

---

## 29. PO Detail UI

Tabs:
- Overview
- Lines
- Documents
- History

Default:
- if authorized user has Draft, open Draft
- otherwise open current Active Revision

Provide revision switcher/history.
Stable summary includes Internal PO ID, Customer, Customer PO No., Header status, Active Revision, Draft Revision, and current owner/HOUSE_ACCOUNT indicator.

---

## 30. Overview Editing

Draft Overview is editable using explicit `Save Overview`.
Do not autosave.

Active material fields are read-only.
To change them, create a new Revision.
Operational Note remains separately editable with audit.

---

## 31. Line Editing UI

Hybrid UI:
- compact table for key fields
- expandable row for secondary details
- side panel/modal for edit
- explicit `Save Line`
- no autosave

Backend rejects Product replacement on existing line lineage; user removes old line and adds new line instead.

---

## 32. Documents UI

Group by type:
- CUSTOMER_PO
- AMENDMENT
- EMAIL_CONFIRMATION
- OTHER

Show Type, Label, URL, and useful audit metadata.
Documents may be edited on Active without new Revision, with audit.

---

## 33. History UI

Visible to SALES_SUPPORT / MANAGER / ADMIN.
Show revision timeline, approval/supersede events, material diffs, line add/remove, document changes, operational note changes, and cancellation.

---

## 34. Unsaved Change Protection

- track dirty state
- disable Review/Activate while dirty
- warn on navigation with unsaved changes
- activation reviews persisted D1 data only
- never auto-save during activation

---

## 35. Business Error Codes

Suggested stable codes:
- PO_CUSTOMER_OWNER_REQUIRED
- PO_CUSTOMER_PO_DUPLICATE
- PO_DRAFT_ALREADY_EXISTS
- PO_SPEC_REQUIRED
- PO_SPEC_OUTDATED
- PO_DOCUMENT_REQUIRED
- PO_VALIDITY_EXPIRED
- PO_PRICE_OVERRIDE_REASON_REQUIRED
- PO_REVISION_NOTE_REQUIRED
- PO_LINE_NUMBER_DUPLICATE
- PO_ACTIVE_IMMUTABLE
- PO_ALREADY_CANCELLED
- PO_HOUSE_ACCOUNT_EXTERNAL_SALES_FORBIDDEN

Frontend maps these to friendly messages.

---

## 36. Existing Phase 5E Anchor Compatibility

Phase 5E introduced minimal `pos` and `shipments` anchors.
Phase 5F implementation must inspect the actual migration/schema first and migrate safely.

Requirements:
- preserve Phase 5E data and FK integrity
- avoid breaking Shipment Cost/Document functionality
- decide whether existing `pos` is evolved, migrated, or bridged to richer PO Header model
- implementation plan must include explicit migration/backfill strategy
- never drop production tables/data without a verified path

This is a critical planning concern.

---

## 37. Future DI / Shipment Integration Contract

Future phases must be able to reference:

```text
po_id
po_revision_id
po_revision_line_id
```

Historical DI/Shipment references are immutable.
Activating a newer Revision never rewrites old DI/Shipment references.

Future balances:
- Planned Qty / Planned Balance from DI
- Actual Shipped Qty / Actual Balance from Shipment

Out of scope for Phase 5F.

---

## 38. Testing Requirements

Implementation plan must include automated tests for:

### PO Header
- server-side Internal PO ID generation
- annual running sequence
- create Draft PO
- Customer PO No. historical uniqueness per Customer
- HOUSE_ACCOUNT creation without Sales Owner
- ASSIGNED_SALES rejection without Sales Owner
- cancellation terminal behavior
- hard-delete Draft-never-active only

### Revision Lifecycle
- Rev.0 starts DRAFT
- SALES_SUPPORT may edit Draft
- SALES_SUPPORT cannot Activate
- MANAGER/ADMIN may Activate
- only one Active revision
- only one Draft revision
- clone creates next Revision
- cloned lines preserve line_no
- cloned lines set previous_line_id
- approval fields not cloned
- old Active becomes SUPERSEDED atomically
- Active material fields immutable

### Lines
- multiple products per PO
- unique line_no per Revision
- Product replacement on existing lineage rejected
- remove old line/add new line workflow
- tolerance math
- Contract and Maximum Amount
- `/MT` UI rule
- packaging/container/loading persistence

### Price Note
- ASSIGNED_SALES matching
- HOUSE_ACCOUNT matching with sales_user_id NULL
- differing Actual Price requires override reason

### Specs
- Active Customer Spec preferred
- fallback to Active Standard Spec
- Draft Spec rejected
- no Spec blocks activation
- historical archived Spec readable
- outdated Spec warning/confirmation audit
- PO-specific override snapshot

### Documents
- multiple documents per Revision
- all 4 document types
- activation evidence rule
- active document edit without new Revision
- audit created

### Approval
- Rev.1+ requires Revision Note
- expired Valid Until rejects activation
- approval summary snapshot stored
- material diff generated
- activation rollback on failure

### RBAC
- ADMIN full
- MANAGER full business workflow
- SALES_SUPPORT create/edit Draft, no activate/cancel
- EXTERNAL_SALES owner scope only
- EXTERNAL_SALES cannot see Draft
- EXTERNAL_SALES cannot see HOUSE_ACCOUNT
- EXPORT operational view excludes price/commission
- PRODUCTION_WAREHOUSE production view excludes price/commercial totals
- restricted fields absent from backend responses

### Audit
- event audit
- field-level material diffs

### Regression
All existing Auth, Customer CRM, Customer Owner Directory, External Sales, User Admin, Product/Spec, and Phase 5E tests must keep passing.
Do not weaken existing tests.

---

## 39. Explicitly Out of Scope

Do NOT implement in Phase 5F:
- full DI workflow migration
- full Shipment planning migration
- planned/actual balance calculation
- automatic PARTIALLY_SHIPPED
- automatic PO completion
- credit control
- Invoice workflow
- commission payment workflow
- quotation generation/PDF
- Cloudflare R2
- file uploads
- Google Drive API integration
- automatic Drive permissions
- full commercial margin/P&L
- new pricing engine
- new FX master
- unrelated Customer CRM redesign
- separate Internal Account Owner for HOUSE_ACCOUNT

---

## 40. Design Principles

1. PO Header is stable identity.
2. Every Revision is a complete snapshot.
3. Active commercial snapshots are immutable.
4. Material change requires new Revision.
5. Non-material operational changes may update Active with audit.
6. Only approved Specs may be used.
7. Historical PO meaning must not change when master data changes later.
8. HOUSE_ACCOUNT stays simple and is jointly managed by SALES_SUPPORT.
9. Role security belongs in backend responses, not only UI hiding.
10. Activation is atomic.
11. Documents remain links, not uploaded files.
12. Preserve Phase 5E production compatibility.
13. Future DI/Shipment references exact PO Revision and Line snapshots.
14. Avoid unrelated refactoring.
15. Prefer explicit audit history over destructive edits.
