# Phase 6 — Shipping / DI Integration Design

Date: 2026-08-29

Status: DESIGN APPROVED — awaiting written spec review before implementation planning

## 1. Purpose and governing principle

Phase 6 connects the Phase 5F PO model to the real Export execution workflow.

The approved operating flow is:

```text
PO
→ DI
→ Booking / Shipment
→ Container
→ Invoice
→ All Ship Docs
→ Payment
→ Completed
```

The Export team owns the workflow from the time a Customer sends a DI by email until the Shipment is completed.

The governing principle is **simple operational truth first**. Store only the data WCAT needs to execute and close a Shipment. Prefer defaults, suggestions, calculated values, and Google Drive links over duplicate manual entry or large new subsystems.

## 2. Core architecture and record relationships

The authoritative Phase 6 relationship begins with the Phase 5F PO model and is part of the existing Cloudflare Worker + D1 application architecture:

```text
PO Header
→ PO Revision
→ PO Revision Line(s)
→ DI
→ Shipment
```

Normal case:

```text
1 DI
→ 1 PO Revision Line
→ 1 Booking
→ 1 Shipment
```

Special combined or trial case:

```text
1 DI
→ multiple PO Revision Lines
→ 1 Booking
→ 1 Shipment
```

The combined case exists because WCAT may occasionally ship multiple trial products together in one Container or Shipment.

Rules:

- One DI belongs to one Customer.
- One DI equals one Booking and one Shipment.
- One Shipment may contain multiple Containers.
- One Shipment may contain multiple Products or PO Lines.
- One Shipment may contain multiple Commercial Invoices.
- One Commercial Invoice may contain multiple Invoice Lines.

## 3. Export team ownership and audit fields

The Export team jointly manages all DI and Shipment records. Do not assign a single Export Owner to a DI or Shipment.

All authorized `EXPORT` users may:

- create and edit DI;
- confirm DI;
- manage Booking;
- manage Shipment;
- manage Containers;
- manage Service Partners;
- manage document delivery;
- update Payment Status; and
- manage Customer Credit.

Keep `created_by`, `created_at`, `updated_by`, and `updated_at` where appropriate.

## 4. DI source and Google Drive

Customers normally send a DI by email. The operational flow is:

```text
Customer Email
→ Export receives DI
→ Export saves original DI file in Google Drive
→ Export records DI in the system
```

The system stores only the Google Drive link in `di_drive_url`. Phase 6 does not include a Google Drive API or a file-upload engine.

## 5. DI number

If the Customer provides a DI Number, use that Customer DI Number.

If the Customer does not provide one, the system creates an internal reference derived from the PO. The suffix increments within the PO, for example:

```text
PO-2026-015_001
PO-2026-015_002
PO-2026-015_003
```

## 6. DI data

Minimum DI data:

- DI No.
- Customer.
- PO.
- PO Revision Line(s).
- Planned Qty per DI Line.
- Packing.
- Container Plan.
- Shipping Month.
- Shipping Period.
- Surveyor.
- Forwarder, optional initially.
- DI Google Drive Link.
- DI Note.

An example Container Plan is `2 × 40'HC`. Container No. and Seal No. are not required when a DI is created.

## 7. Customer shipping plan

Use broad planning periods only. The fields are `shipping_month` and `shipping_period`.

Shipping-period values:

- `FIRST_HALF`: day 1–15.
- `SECOND_HALF`: day 16–end of month.

For example: September 2026 / `FIRST_HALF`.

ETD must not be used to judge whether a Shipment followed the Customer plan. Actual Loading Date is the comparison reference.

## 8. Loading dates and schedule result

Keep these three concepts separate:

1. **Customer Shipping Plan**, for example Sep 2026 / `FIRST_HALF`.
2. **Planned Loading Date**, set after Booking is available. It may change as circumstances change. The UI shows only the latest value; older values remain in Audit.
3. **Actual Loading Date**, recorded after actual loading.

The fields are `planned_loading_date`, `actual_loading_date`, `schedule_result`, and `schedule_note`.

Schedule Result:

```text
Actual Loading Date inside Customer Shipping Period
→ ON_PLAN

Actual Loading Date outside Customer Shipping Period
→ OUT_OF_PLAN
```

Allowed values are `ON_PLAN` and `OUT_OF_PLAN`. Phase 6 includes no KPI scoring or delay-responsibility scoring.

## 9. DI quantity control

Use the Phase 5F PO Line Max Allowed Qty.

Available Qty for a new DI is:

```text
PO Line Max Allowed Qty
- Actual Qty already completed/shipped
- Planned Qty of non-cancelled active DI
```

Cancelled DI does not consume quantity. For tolerance POs, DI planning may use up to Max Allowed Qty. Actual Qty must never exceed Max Allowed Qty. For fixed Jumbo Bag Shipments, Planned Qty may equal expected Actual Qty.

## 10. DI status and lifecycle

Statuses:

```text
DRAFT
→ CONFIRMED
→ IN_PROGRESS
→ COMPLETED

or:
CANCELLED
```

Meanings:

- `DRAFT`: being entered or checked; editable; may be hard deleted only if never confirmed.
- `CONFIRMED`: Export has checked and accepted the DI; all `EXPORT` users may confirm.
- `IN_PROGRESS`: Booking No. has been recorded.
- `COMPLETED`: follows Shipment `COMPLETED` automatically.
- `CANCELLED`: a business cancellation; do not hard delete after confirmation; release Planned Qty back to PO Line availability; require `cancel_note`.

## 11. Shipment and Booking

One DI equals one Booking equals one Shipment.

Booking fields:

- Booking No.
- Forwarder.
- Shipping Line.
- Vessel.
- ETD.
- ETA.

ETD and ETA are operational information only. They do not determine `ON_PLAN` or `OUT_OF_PLAN`.

## 12. Service Partners master and selection

Create one simple master named **Service Partners**.

Initial Partner Types:

- `FORWARDER`
- `SHIPPING_LINE`
- `TRUCKING`
- `SURVEYOR`

Minimum fields:

- Company Name.
- Partner Type.
- `ACTIVE` or `INACTIVE`.

`EXPORT` users may create, edit, activate, and deactivate Service Partners. Do not add rate management, contracts, vendor scoring, or a large contact directory.

Partner-selection rules:

- **Surveyor:** may be selected when DI is created. For a returning Customer, suggest the previously used Surveyor. Export may change it.
- **Forwarder:** for a returning Customer, suggest the previously used Forwarder. Export may change it. For a new Customer, it may remain blank until known.
- **Shipping Line:** select when Booking is available.
- **Trucking:** do not require when DI is created; select after Booking because Export must check availability.

Suggestions are convenience only. Do not create rigid Customer-to-Partner assignments.

## 13. Shipment status and lifecycle

Statuses:

```text
PLANNING
→ BOOKED
→ LOADED
→ DOCS_SENT
→ COMPLETED

or:
CANCELLED
```

Meanings:

- `PLANNING`: DI exists and Shipment is being prepared.
- `BOOKED`: Booking No. exists.
- `LOADED`: Actual Loading Date and actual Container data are recorded.
- `DOCS_SENT`: required Customer documents have been sent.
- `COMPLETED`: automatic when Shipment is `DOCS_SENT` and Payment Status is `PAID`.
- `CANCELLED`: Shipment execution cancelled.

Phase 6 intentionally does not track `DEPARTED`, `IN_TRANSIT`, or `ARRIVED`.

## 14. Containers and actual quantity

One Shipment may have multiple Containers. Container fields are:

- Container No.
- Seal No.

Each Container may have multiple Container Lines. A Container Line contains:

- PO Revision Line or Product.
- Number of Bags.
- Net Weight.

Mixed-product Containers are supported. For example:

```text
Container EGSU2548896

Product A
10 bags
9.50 MT net

Product B
10 bags
9.50 MT net
```

Shipment Actual Qty is the sum of Container Line Net Weight. Do not track Gross Weight, VGM, Tare Weight, or Pallet Weight.

## 15. Commercial Invoice model

One Shipment may have multiple Commercial Invoices. One Commercial Invoice may have multiple Invoice Lines.

```text
Shipment
→ Invoice(s)
→ Invoice Line(s)
→ PO Revision Line
```

This supports one Shipment with multiple Products, one Invoice with multiple Products, and multiple Invoice Numbers in one Shipment.

Invoice No. examples:

```text
WCAT001/2026
WCAT001A/2026
WCAT001B/2026
```

Invoice Number is manually entered because Accounting determines it. The system does not generate WCAT Invoice Numbers.

## 16. Invoice data and amount calculation

Minimum Invoice fields:

- Invoice No.
- Invoice Date.
- Invoice Version or Status.
- Invoice Lines.
- Invoice Total.

An Invoice Line contains:

- PO Revision Line.
- Qty.
- Unit Price Snapshot.
- Currency.
- Amount.

Unit Price comes from the referenced PO Revision Line; commercial price must not be independently re-entered.

```text
Line Amount = Invoice Qty × PO Unit Price
Invoice Total = sum of Invoice Line Amounts
```

## 17. Preliminary and Final Invoice

A fixed-weight Shipment may go directly to `FINAL`.

For a tolerance or ±% Shipment:

- `PRELIMINARY` uses permitted Max Qty.
- `FINAL` uses Actual Qty after loading.

The same Invoice No. is reused. For example:

```text
Invoice: WCAT001/2026
PRELIMINARY: Qty = Max Allowed Qty
FINAL: Qty = Actual Qty
```

Hard validation:

```text
FINAL Actual Qty <= PO Line Max Allowed Qty
```

If Actual Qty exceeds Max Allowed Qty, do not finalize the Invoice. The Final Invoice Amount is authoritative for Payment. Preliminary and Final PDFs may both remain in the Shipment Google Drive folder. The application does not manage individual PDF versions in Phase 6.

## 18. All Ship Docs and document delivery

One Shipment has one Google Drive Folder. The system stores only:

- `all_ship_docs_drive_url`
- `digital_docs_sent_date`
- `original_docs_required`
- `dhl_sent_date`
- `dhl_tracking_no`
- `docs_note`

Do not create individual document records for Invoice, Packing List, BL, COA, Phyto, or Certificates. These files remain in the Google Drive folder.

Digital or Email delivery is required for every Shipment. Original or DHL delivery depends on the Customer requirement.

For a digital-only Customer:

```text
Digital Email sent
→ DOCS_SENT
```

For an original-required Customer:

```text
Digital Email sent
AND
DHL Original sent
→ DOCS_SENT
```

For a DHL-required Shipment, DHL Sent Date and DHL Tracking No. are required. Customer Master may later provide a default for `original_docs_required`; Export may override the value for a Shipment.

## 19. Payment

Payment is manually maintained by Export. Statuses are `UNPAID`, `PARTIAL`, and `PAID`.

Minimum fields:

- Cash Received Amount.
- Payment Status.
- Payment Note.

Phase 6 does not include bank reconciliation, accounting integration, or a payment transaction ledger.

## 20. Customer Credit

Customer Credit is lightweight and belongs to exactly one Customer. Credit cannot transfer across Customers.

Minimum fields:

- Customer.
- Credit Amount.
- Reason.
- Remaining Balance.
- Created By.
- Created At.

`EXPORT` users may create Customer Credit. One Credit may be used across multiple Shipments or Invoices for the same Customer. Credit Usage cannot exceed Remaining Balance, reduces Remaining Balance, and must be audited.

Do not build a full Credit Note or Accounting module.

## 21. Payment calculation

The Final Invoice is the basis for collection. Where Credit is used:

```text
Amount Due = Final Invoice Amount - Credit Used
```

Payment is considered `PAID` when the obligation is satisfied by Cash plus Credit:

```text
Cash Received + Credit Used = Final Invoice Amount
→ PAID
```

For multiple Invoices in one Shipment, aggregate the Shipment-level commercial obligation. If it is partially covered, the Payment Status is `PARTIAL`; if nothing is covered, it is `UNPAID`.

## 22. Automatic Shipment completion

Shipment completion is automatic:

```text
Document requirement satisfied
AND
Payment Status = PAID
→ Shipment = COMPLETED
→ DI = COMPLETED
```

There is no manual second completion click.

## 23. Cancellation

A DI in `DRAFT` may be hard deleted only before confirmation.

Confirmed DI and Shipment records must not be hard deleted. Use `CANCELLED` plus a note. A cancelled DI releases Planned Qty back into PO availability. Historical records and Drive links remain visible.

## 24. Audit

Keep a simple event audit. Events may include:

- `DI_CREATED`
- `DI_CONFIRMED`
- `DI_UPDATED`
- `DI_CANCELLED`
- `BOOKING_RECORDED`
- `PLANNED_LOADING_DATE_UPDATED`
- `ACTUAL_LOADING_DATE_RECORDED`
- `CONTAINER_ADDED`
- `CONTAINER_UPDATED`
- `INVOICE_RECORDED`
- `INVOICE_FINALIZED`
- `DOCS_EMAIL_SENT`
- `DOCS_DHL_SENT`
- `PAYMENT_UPDATED`
- `CUSTOMER_CREDIT_CREATED`
- `CUSTOMER_CREDIT_USED`
- `SHIPMENT_COMPLETED`

Store at minimum the actor, timestamp, entity, event type, and relevant metadata or old/new values when useful. Do not create a PO-style Revision model for DI.

## 25. Phase 5F PO integration

Phase 6 references the rich Phase 5F PO model directly. DI Lines reference the exact:

```text
po_id
po_revision_id
po_revision_line_id
```

Do not use the legacy Phase 5E single-product `pos` as the authoritative DI source. Historical DI and Shipment records remain linked to the exact PO Revision Line used at creation. Do not silently move an old DI to a later PO Revision.

## 26. PO balance read model

For each PO Revision Line, show:

- Contract Qty.
- Max Allowed Qty.
- Active DI Planned Qty.
- Actual Shipped Qty.
- Available Qty for New DI.

Suggested calculation:

```text
Available Qty
= Max Allowed Qty
- Actual Qty from actual Shipment execution
- Planned Qty from non-cancelled DI not yet represented by Actual Qty
```

Implementation must avoid double counting Planned and Actual Qty for the same DI or Shipment. Keep the logic simple and state-aware.

## 27. Frontend workflow

Do not create many new menus. The recommended main list is **DI / Shipment List**.

Show:

- DI No.
- Customer.
- PO.
- Product summary.
- Planned Qty.
- Container Plan.
- Shipping Plan.
- Planned Loading Date.
- Actual Loading Date.
- Schedule Result.
- Booking No.
- Shipment Status.
- Payment Status.

Detail sections or tabs:

- DI.
- Booking.
- Containers.
- Invoice.
- Documents.
- Payment.
- History.

Avoid wizard complexity. Export can enter information progressively as it becomes available.

## 28. Search and filters

Basic search supports:

- DI No.
- Internal PO No.
- Customer PO No.
- Customer.
- Booking No.
- Invoice No.
- Container No.

Simple filters support:

- DI Status.
- Shipment Status.
- Shipping Month.
- `ON_PLAN` or `OUT_OF_PLAN`.
- Payment Status.

There is no analytics dashboard or KPI scoring in Phase 6.

## 29. RBAC

`EXPORT` is the primary working role and may manage all Phase 6 operational records.

`ADMIN` and `MANAGER` may view and manage records for support and oversight.

`SALES_SUPPORT` may view operational progress but does not run Export execution.

`EXTERNAL_SALES` may have a limited read-only view for its own Customers if implemented, with no unnecessary internal or audit details.

`PRODUCTION_WAREHOUSE` may have a limited loading-relevant view of Product, Qty, Packing, Container Plan, Planned Loading Date, and Actual Loading Date.

Server-side projections must continue protecting commercial and internal data. Exact route permissions will be finalized in the implementation plan after inspecting current project patterns.

## 30. Explicitly out of scope

Phase 6 does not include:

- automatic vessel or carrier tracking;
- `ARRIVED` tracking;
- KPI scoring;
- delay-responsibility scoring;
- Gross Weight;
- VGM;
- Tare Weight;
- full accounting integration;
- bank reconciliation;
- payment transaction ledger;
- automatic Invoice Number generation;
- PDF Invoice generation;
- Google Drive API upload or file management;
- a per-document All Ship Doc engine;
- a full Credit Note module;
- Service Partner pricing or rate management;
- vendor performance scoring;
- automatic email sending; or
- DHL API integration.

## 31. Legacy compatibility

Phase 6 creates the authoritative rich DI and Shipment workflow linked to Phase 5F PO Revision Lines.

Do not destructively rewrite legacy Phase 5E Shipment data initially. Implementation planning must preserve historical legacy Shipment data, avoid breaking existing foreign keys and read paths, route new Phase 6 records to the new rich model, and backfill old data only where mapping is deterministic.

Do not invent PO Line relationships for legacy records when source data does not support them.

## 32. Success criteria

Phase 6 v1 succeeds when Export can:

```text
Receive Customer DI
→ save DI to Google Drive
→ create/confirm DI against exact PO Line(s)
→ see available PO Qty
→ set Customer Shipping Plan
→ select Surveyor / suggested Forwarder
→ record Booking
→ select Shipping Line / Trucking
→ maintain Planned Loading Date
→ record Actual Loading Date
→ see ON_PLAN / OUT_OF_PLAN
→ record Container / Seal / Product Net Weight
→ record Preliminary / Final Invoice info
→ link All Ship Docs Drive folder
→ record Email / DHL delivery
→ maintain Customer Credit if needed
→ record Payment
→ Shipment completes automatically
```

## 33. Design principle

Simple operational truth first.

Do not expand this design while writing the spec. Do not add features not explicitly approved above.
