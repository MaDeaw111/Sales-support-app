# Task 13 RBAC Review Fixes

Date: 2026-08-30

## Corrected read-model boundary

The Phase 6 repository now provides separate detailed read models for a
Shipment ID and a Delivery Instruction ID. `GET /api/shipments-v2/:id` uses
only the Shipment-ID lookup, while `GET /api/delivery-instructions/:id/shipment`
uses the DI-specific lookup. A DI identifier therefore cannot resolve through
the Shipment-ID route.

## Approved role projections

`EXTERNAL_SALES` receives only the owned-Customer operational-progress fields:
DI number, status, Booking/Vessel details, planned/actual loading dates, and
schedule result. The response omits internal IDs, Customer/PO references,
shipping-plan fields, payment, invoice, credit, document, and audit data.

`PRODUCTION_WAREHOUSE` receives only planned/actual loading dates, product
code/name, planned quantity, packing snapshot, container plan, and actual
container/seal/bag/quantity details. It receives no status, internal IDs,
Customer/PO references, commercial, payment, invoice, credit, document, or
audit data.

## Container-plan derivation

Phase 6 stores no independent planned-container field. The read model derives
`container_plan` solely from non-cancelled `shipment_containers.container_type`:
one `{ container_type, container_count }` item per actual container type. It
does not infer a count from quantities or create a new persisted field. When no
actual container type is recorded, the plan is an empty array.

## Verification

`test/phase6-rbac.test.js` now uses a real migrated D1 fixture and asserts the
complete response shapes for both restricted roles, Customer ownership changes,
and strict Shipment-ID lookup behavior.
