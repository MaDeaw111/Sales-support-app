# Task 6 Report: Booking and rich Shipment core

## Outcome

Implemented the separate Phase 6 Shipment core without changing the legacy `/api/shipments` implementation.

- Confirming a Delivery Instruction atomically creates its single `phase6_shipments` row in `PLANNING`.
- `createShipmentForDeliveryInstruction` supports already-confirmed DIs and rejects a second Shipment for the same DI with `SHIPMENT_ALREADY_EXISTS`.
- Booking accepts only Booking No., Forwarder/Shipping Line/Trucking partner IDs, Vessel, ETD, ETA, and Planned Loading Date.
- Recording a Booking changes the Shipment to `BOOKED`, changes its DI to `IN_PROGRESS`, and writes `BOOKING_RECORDED` audit metadata.
- Each selected partner is checked against its required partner type.
- ETD and ETA are stored as informational fields; Booking does not write `schedule_result`.
- Added `GET /api/delivery-instructions/:id/shipment` and `PUT /api/shipments-v2/:id/booking` with existing Phase 6 authentication/RBAC conventions.
- Per the ruling for the unapplied local feature schema, migration `0007` now permits `BOOKING_RECORDED` and rejects obsolete `BOOKING_UPDATED`; no new migration was created.

## RED evidence

Clean starting point at `e786544`:

```text
npm test
201 tests, 201 passed, 0 failed
```

The prior attempt's production edits were removed before running the retained behavior tests.

```text
node --test test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js
8 tests, 0 passed, 8 failed
```

Failures were caused by the missing repository methods, missing routes, and missing worker dispatch: `createShipmentForDeliveryInstruction`/`getPhase6Shipment` were undefined and Phase 6 Shipment requests returned 404.

```text
node --test test/phase6-migration.test.js
4 tests, 3 passed, 1 failed
```

The new behavior test failed because the old `0007` audit constraint rejected `BOOKING_RECORDED`.

Partner-type mutation check:

```text
node --test --test-name-pattern="Booking rejects fields outside its focused contract and mismatched partner types without state changes" test/phase6-shipments.repository.test.js
1 test, 0 passed, 1 failed
```

With Shipping Line and Trucking type checks intentionally absent, the test failed with `Missing expected rejection`, proving those assertions detect missing validation.

## GREEN evidence

Initial focused implementation:

```text
node --test test/phase6-migration.test.js test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js
12 tests, 12 passed, 0 failed
```

Restored partner checks after the mutation RED:

```text
node --test --test-name-pattern="Booking rejects fields outside its focused contract and mismatched partner types without state changes" test/phase6-shipments.repository.test.js
1 test, 1 passed, 0 failed
```

Task 6 focused tests plus the required legacy Shipment route regressions:

```text
node --test test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js test/shipment-ensure-anchor.test.js test/shipment-documents.routes.test.js test/shipment-expenses.routes.test.js
17 tests, 17 passed, 0 failed
```

Relevant Phase 6, DI, and Service Partner tests:

```text
node --test test/phase6-migration.test.js test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js test/delivery-instructions.repository.test.js test/delivery-instructions.routes.test.js test/service-partners.repository.test.js test/service-partners.routes.test.js
40 tests, 40 passed, 0 failed
```

Full repository suite:

```text
npm test
210 tests, 210 passed, 0 failed
```

`git diff --check` reported no whitespace errors. The only emitted messages were the repository's existing Windows LF-to-CRLF conversion warnings.

## Scope confirmation

- No deployment was performed.
- No remote D1 or production resource was accessed.
- No subagents were used.
- No new migration was added.
- The legacy `/api/shipments` dispatch and handlers were not modified.
