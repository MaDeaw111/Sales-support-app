# Task 15 review-fix report

## Scope

- Restored the legacy Phase 5E shipping and warehouse views as the default selectable workspace.
- Added a selectable Phase 6 DI workspace without changing legacy shipment cost or document-link behavior.
- Added a server-filtered Phase 6 workspace read model for list columns and a scoped DI-number detail lookup for restricted-role reads.
- Added Draft DI edit, confirmation, and cancellation actions. Draft selection no longer requests a Shipment.
- Added deliberate error terminal state and explicit refresh, preventing automatic retry loops.
- Added Payment Status filtering and API-backed customer-credit allocation for approved operational roles.

## Verification

- Focused frontend, DI-route, RBAC, and shipment-route tests: 32 passed.
- Full test suite: 274 passed.
- `git diff --check` completed without whitespace errors.

## Boundary

The read-model and credit-usage route additions are additive Phase 6 APIs only. No migration, legacy table, Phase 5E endpoint, or deployment action was changed.

## Re-review correction round

- Replaced the Draft note-only prompt with a full approved-DI editor, including identity, shipping plan, partners, Drive URL, note, and planned lines. Draft removal now calls the existing hard-delete endpoint; confirmed-DI cancellation remains separate.
- Moved shared detail rendering helpers before the warehouse branch and covered a real restricted warehouse render with loading, product, and container data.
- Restricted workspace requests now ignore hidden commercial search and payment predicates before querying. Warehouse also ignores the unavailable schedule predicate. Restricted list projections receive a stable, caller-scoped opaque `detail_ref` instead of an internal DI ID.
- Detail reads for restricted users resolve only their opaque reference after ownership filtering; the repository no longer performs a global DI-number lookup. The duplicate-DI-number regression proves the selected customer/shipment remains unambiguous.
- Replaced Phase 6 list action interpolation with escaped data attributes and DOM event listeners. The UI hides inaccessible columns and filters for restricted roles; an apostrophe/markup label regression verifies action data remains encoded.

### Re-review verification

- Focused frontend and RBAC tests: 18 passed.
- Full suite: 281 passed; `git diff --check` completed without whitespace errors.
