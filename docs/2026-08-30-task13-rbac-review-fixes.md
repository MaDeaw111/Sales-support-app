# Task 13 RBAC Review Fixes

Date: 2026-08-30

## Corrected read-model boundary

The Phase 6 repository now provides separate detailed read models for a
Shipment ID and a Delivery Instruction ID. `GET /api/shipments-v2/:id` uses
only the Shipment-ID lookup, while `GET /api/delivery-instructions/:id/shipment`
uses the DI-specific lookup. A DI identifier therefore cannot resolve through
the Shipment-ID route.

The route contracts are explicit: `getPhase6ShipmentByShipmentId` serves the
Shipment namespace and `getPhase6ShipmentByDeliveryInstructionId` serves the
DI namespace. Route handlers do not fall back to the generic lookup.

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

## Persisted DI container plan

The un-applied `0007_shipping_di_integration.sql` schema defines the additive
`delivery_instructions.container_plan` field without a default: it is non-null
and rejects blank values. DI create and merged DRAFT update payloads require a
non-empty `containerPlan` value and confirmation validates the persisted value
again before any Shipment can be materialized. The Warehouse read model returns
this planned value directly, before any actual containers exist. Actual
container records remain a separate loading fact and never derive or replace
the DI plan.

## Verification

`test/phase6-rbac.test.js` now uses a real migrated D1 fixture and asserts the
complete response shapes for both restricted roles, Customer ownership changes,
persisted DI container-plan behavior, and strict Shipment-ID lookup behavior.
