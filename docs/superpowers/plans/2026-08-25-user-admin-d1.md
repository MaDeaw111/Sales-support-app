# Phase 5C — User Administration & Password Reset D1 Implementation Plan

## Tasks and TDD Checkpoints

### Task 1: API Route & Business Logic Tests (TDD)
* Create `test/user-admin-routes.test.js`.
* Add failing tests representing the backend goals:
  * `GET /api/users` access control (ADMIN/MANAGER pass, others 403, unauthenticated 401).
  * `GET /api/users` response field safety (no hash/salt returned).
  * `POST /api/users` validations (role, status, email unique check, generate ID/pwd, TDD hash verify, `must_change_password=1`).
  * `PUT /api/users/:id` checks (valid updates, self-lockout protections, block demoting last admin).
  * `PUT /api/users/:id` block external sales role change if customers assigned.
  * `POST /api/users/:id/reset-password` checks (generate pwd, hash verify, must_change_password=1, delete sessions).
  * Password recovery regression test (reproduce Sira recovery case: verify generated pwd/hash/salt works).
* **Checkpoint:** Run tests and verify they fail (RED stage).

### Task 2: Backend Implementation
* Create `src/users/repository.js` to manage D1 operations for users.
  * Implement `listUsers()`, `findUserById()`, `createUser()`, `updateUser()`, `resetPassword()`.
  * Add self-lockout verification during update.
  * Add external sales assignment check.
* Create `src/users/routes.js` implementing handlers for the endpoints.
* Wire the routes up in `src/index.js`.
* **Checkpoint:** Run `npm test` and verify that all backend user-admin tests pass (GREEN stage).

### Task 3: Frontend state & Users / Roles Page Integration
* Create frontend tests or integrate the Users state:
  * Add `state.adminUsers` and `loadUsersFromApi()`.
  * Modify public/index.html or the frontend code to load users from the API.
  * Update Add, Edit, Reset Password dialogs to connect to the new D1 endpoints.
* **Checkpoint:** Run frontend integration tests and verify success.
