# Task 5 Report: DI lifecycle and audit

## Scope delivered

- Corrected the un-applied local `0007_shipping_di_integration.sql` prerequisite: DI statuses are now exactly `DRAFT`, `CONFIRMED`, `IN_PROGRESS`, `COMPLETED`, and `CANCELLED`; no new migration was added.
- Evolved the approved simple `shipment_audit_events` table to generic `entity_type`/`entity_id` audit records, retaining Shipment/Credit-ready event types and adding the four DI events. It is indexed by entity and timestamp.
- Added DRAFT-only DI editing, confirmation, cancellation with a required note, hard deletion only for DRAFT records, and DI audit history retrieval. There is no DI revision model.
- Added `PATCH /api/delivery-instructions/:id`, `POST /api/delivery-instructions/:id/confirm`, `POST /api/delivery-instructions/:id/cancel`, and `DELETE /api/delivery-instructions/:id`. All allowed DI writers, including every `EXPORT` user, can confirm.
- Creation, update, confirmation, and cancellation record `DI_CREATED`, `DI_UPDATED`, `DI_CONFIRMED`, and `DI_CANCELLED` events with actor, entity, timestamp, and useful state metadata. Cancellation changes DI status to `CANCELLED`, releasing planned availability through the existing state-aware balance rule.

## RED / GREEN evidence

### RED 1: lifecycle methods and routes absent

`node --test test/delivery-instructions.repository.test.js test/delivery-instructions.routes.test.js` failed as expected:

```text
TypeError: repo.updateDraftDeliveryInstruction is not a function
TypeError: repo.cancelDeliveryInstruction is not a function
404 !== 200
```

### RED 2: schema did not support the approved lifecycle/audit model

`node --test test/phase6-migration.test.js` failed because `CONFIRMED` violated the old DI status constraint and the entity audit index was absent.

### RED 3: DRAFT edit reservation race

The new real `Promise.allSettled()` concurrent-edit regression failed with both 75 MT updates succeeding against two existing 25 MT allocations on one 100 MT PO line:

```text
AssertionError: 2 !== 1
```

### GREEN

- The lifecycle and route suite passed after adding repository transitions, audit batches, validation, and focused endpoints.
- The migration suite passed after correcting the local, un-applied 0007 schema.
- DRAFT edit line replacement now uses the same guarded reservation pattern inside the D1 batch. The race regression proves one edit rejects with `DI_QTY_EXCEEDS_MAX_ALLOWED` and persisted planned quantity remains 100 MT.
- An audit metadata test first exposed omitted `null` partner/Drive fields; the snapshot serializer was corrected and the test passed.

## Verification

- `node --test test/delivery-instructions.repository.test.js test/delivery-instructions.routes.test.js test/phase6-migration.test.js` — 22 passed, 0 failed.
- `npm test` — 197 passed, 0 failed, 0 skipped.
- `git diff --check` — no whitespace errors.

## Commit

Committed as `feat: add Phase 6 DI lifecycle`.

## Concerns

- No booking behavior was added. A later task is responsible for moving a confirmed DI to `IN_PROGRESS`.
- No remote D1, production system, deployment, or legacy shipment module was accessed or changed.

## Fix round 1: lifecycle mutation guards

### Root cause

The initial lifecycle methods checked the DI status before their write, then issued unconditional mutations. A concurrent caller could pass the same stale `DRAFT` read, so PATCH/confirm or DELETE/confirm could both report success. Cancellation also treated every non-cancelled state as cancellable.

### RED evidence

- Cancelling a DRAFT DI with a valid note succeeded when the expected result was `DI_NOT_CONFIRMED`.
- Real `Promise.allSettled()` PATCH-vs-confirm and DELETE-vs-confirm regressions both failed with two fulfilled operations (`2 !== 1`).

### Fix

- Cancellation now accepts only `CONFIRMED`; DRAFT, IN_PROGRESS, and COMPLETED reject with `DI_NOT_CONFIRMED`.
- PATCH, confirm, cancel, and delete use their expected status in the SQL `WHERE` clause. A zero-row mutation returns the appropriate lifecycle error instead of treating a stale precheck as authorization.
- Audit inserts use SQLite `changes() = 1` immediately after their guarded mutation, so a losing state transition cannot append an event. DRAFT line deletion/insertion is likewise status-gated, preserving the Task 4 atomic quantity reservation guard.

### Fix-round verification

- `node --test test/delivery-instructions.repository.test.js test/delivery-instructions.routes.test.js test/phase6-migration.test.js` — 24 passed, 0 failed.
- `npm test` — 199 passed, 0 failed, 0 skipped.
- `git diff --check` — no whitespace errors.
