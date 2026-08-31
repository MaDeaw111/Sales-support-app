# Phase 6 Final Fix Ledger

Date: 2026-08-30
Baseline: `9d9a64a`

## P1 — DOCS_SENT tolerance invoice sequence

- Reproduction: a tolerance Shipment was moved to `DOCS_SENT` before invoice creation, then a `PRELIMINARY` invoice was created for the permitted maximum quantity and finalized against actual cargo.
- Red evidence: the focused repository test failed with `SHIPMENT_NOT_BOOKED` at the invoice lifecycle gate.
- Root cause: `createShipmentInvoice` admitted `DOCS_SENT` only when the incoming invoice version was already `FINAL`, so the required `PRELIMINARY` step never reached existing tolerance and quantity validation.
- Ruling: admit `DOCS_SENT` to the existing invoice-creation lifecycle gate for both supported invoice versions. Keep the existing status model, preliminary maximum-quantity validation, final PO maximum validation, and remaining-actual validation unchanged.

## P2 — Restricted server projections

- Reproduction: explicit forbidden-field assertions inspected the workspace rows returned to `EXTERNAL_SALES` and `PRODUCTION_WAREHOUSE`, while a full `EXPORT` response asserted its commercial/internal fields remained available.
- Red evidence: the focused RBAC test first failed because `shipping_month` remained present in the External Sales projection. Follow-up inference tests failed because hidden shipping/status query parameters still changed restricted result counts.
- Root cause: the restricted workspace allowlists and their accepted filters had drifted from the approved read contracts. External Sales still received shipping-plan fields, Warehouse still received DI/status fields, and hidden-field predicates remained queryable.
- Ruling: remove only the unapproved fields from the two restricted workspace allowlists and ignore predicates for fields hidden from each role. Preserve opaque detail references and return the repository row unchanged for authorized full operational roles.

## P2 — Returning-Customer partner suggestions

- Reproduction: a route test requested suggestions for Customer `C1`; frontend tests requested the same read model and applied it to blank editable selects while preserving a user-selected Forwarder.
- Red evidence: the route returned `404`, the customer-aware loader did not exist, and the create form had no Customer-change suggestion binding.
- Root cause: `suggestPartnersForCustomer` existed only in the repository. The frontend function with the suggestion name actually loaded the full service-partner catalog, so no Phase 6 API or form flow consumed the historical suggestion read model.
- Ruling: expose the existing repository method through a read-only operational endpoint. Populate only blank Surveyor/Forwarder selects after Customer selection; never persist, require, or overwrite a user choice.

## P2 — Booked DI cancellation pair

- Reproduction: a confirmed DI was booked, given an actual container record without an Actual Loading Date, and then cancelled with a required business note. Separate cases attempted the same operation from `LOADED`, `DOCS_SENT`, and `COMPLETED` Shipment states.
- Red evidence: the booked case failed with `DI_NOT_CONFIRMED` before either terminal transition; the repository admitted only a `CONFIRMED` DI even though Booking had already moved it to `IN_PROGRESS`.
- Root cause: `cancelDeliveryInstruction` hard-coded the DI guard to `CONFIRMED` and the Shipment update to `PLANNING`, rather than validating the two approved paired states.
- Ruling: admit exactly `CONFIRMED`/`PLANNING` and `IN_PROGRESS`/`BOOKED`. Atomically mark both records `CANCELLED`, retain operational notes, Booking data, actual container rows, and prior audit events, append DI and Shipment cancellation audits, and release the cancelled plan from availability. Continue denying `LOADED`, `DOCS_SENT`, and `COMPLETED`.

## P2 — Completed DI plans in PO availability

- Reproduction: one completed combined DI retained plans on two PO lines, carried partial actual quantity on one line, and left the other line unshipped; active and cancelled plans were seeded beside it. A new combined DI then attempted to reserve the exact remaining maximum on both lines.
- Red evidence: the unshipped completed line reported 35 MT available instead of 75 MT because its historical 40 MT plan was added to the active 25 MT reservation.
- Root cause: PO balance, availability reservation, and container-capacity queries classified every non-cancelled DI plan as active. They did not remove `COMPLETED` DI plans from the planned component after completion made actual container quantities authoritative.
- Ruling: planned reservations come only from `DRAFT`, `CONFIRMED`, and `IN_PROGRESS` DIs. Keep completed plan rows as history, count their non-cancelled actual container quantities, ignore cancelled plans and actuals, retain active reservations, and continue enforcing each PO line maximum atomically.

## Scope boundary

- Migrations remain exactly `0001` through `0007`.
- No deployment, remote D1 command, external write, status-model change, or PO maximum/tolerance validation change is authorized by this fix wave.

## Pre-commit review rulings

- Restricted UI controls and columns now mirror the server allowlists, so absent fields are neither shown as false zero/blank values nor offered as no-op filters.
- Customer-aware suggestion requests use a generation and current-Customer guard. Previously auto-applied defaults may refresh for a new Customer, while a genuine user choice is preserved.
- Phase 6 workspace bootstrap loads the service-partner catalog; historical Customer suggestions are fetched only after an actual Customer selection.
