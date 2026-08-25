# Phase 5C — User Administration & Password Reset D1 Design Spec

## 1. Non-Goals
* No individual permission overrides (RBAC is strictly role-based).
* No Multi-Factor Authentication (MFA).
* No email delivery of passwords.
* No password history tracking.
* No audit-log subsystem.
* No commission settings or management.
* No custom/arbitrary roles.

## 2. API Contract
All endpoints require authentication and proper RBAC.

### `GET /api/users`
* **Access:** ADMIN, MANAGER
* **Response (Success):**
```json
{
  "status": "SUCCESS",
  "data": {
    "users": [
      {
        "id": "USR-0001",
        "name": "Chiradet Chermchabok",
        "email": "chiradet_c@wcat-thai.com",
        "role": "ADMIN",
        "status": "ACTIVE",
        "customerScope": "ALL",
        "mustChangePassword": false
      }
    ]
  }
}
```

### `GET /api/users/:id`
* **Access:** ADMIN, MANAGER
* **Response (Success):**
```json
{
  "status": "SUCCESS",
  "data": {
    "user": {
      "id": "USR-0001",
      "name": "Chiradet Chermchabok",
      "email": "chiradet_c@wcat-thai.com",
      "role": "ADMIN",
      "status": "ACTIVE",
      "customerScope": "ALL",
      "mustChangePassword": false
    }
  }
}
```

### `POST /api/users`
* **Access:** ADMIN only
* **Request:**
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "role": "SALES_SUPPORT",
  "status": "ACTIVE",
  "customerScope": "NONE"
}
```
* **Response (Success):**
```json
{
  "status": "SUCCESS",
  "data": {
    "user": {
      "id": "USR-0003",
      "name": "Jane Doe",
      "email": "jane@example.com",
      "role": "SALES_SUPPORT",
      "status": "ACTIVE",
      "customerScope": "NONE",
      "mustChangePassword": true
    },
    "temporaryPassword": "..."
  }
}
```

### `PUT /api/users/:id`
* **Access:** ADMIN only
* **Request:**
```json
{
  "name": "Jane Smith",
  "email": "janesmith@example.com",
  "role": "SALES_SUPPORT",
  "status": "ACTIVE",
  "customerScope": "NONE"
}
```
* **Response (Success):**
```json
{
  "status": "SUCCESS",
  "data": {
    "user": {
      "id": "USR-0003",
      "name": "Jane Smith",
      "email": "janesmith@example.com",
      "role": "SALES_SUPPORT",
      "status": "ACTIVE",
      "customerScope": "NONE",
      "mustChangePassword": true
    }
  }
}
```

### `POST /api/users/:id/reset-password`
* **Access:** ADMIN only
* **Request:** None
* **Response (Success):**
```json
{
  "status": "SUCCESS",
  "data": {
    "user": {
      "id": "USR-0003",
      "name": "Jane Smith",
      "email": "janesmith@example.com",
      "role": "SALES_SUPPORT",
      "status": "ACTIVE",
      "customerScope": "NONE",
      "mustChangePassword": true
    },
    "temporaryPassword": "..."
  }
}
```

## 3. RBAC Permissions
* **ADMIN:** Full Access (List, View, Create, Edit, Reset Password, Role/Status mutation).
* **MANAGER:** Read-only Access (List and View profiles only).
* **Other Roles:** Access Denied (403 Forbidden).

## 4. Reset-Password Security Model
1. Generate cryptographically secure 16-character temporary password using `crypto.getRandomValues`.
2. Hash temporary password using standard PBKDF2 (`src/auth/crypto.js`) with 100000 iterations.
3. Update `password_hash`, `password_salt`, `password_iterations` and set `must_change_password = 1`.
4. Delete all existing sessions for the target user from the `sessions` table (force immediate logout).
5. Return the temporary password exactly once in the response. Do not log the password.

## 5. Self-Lockout Protection
To prevent accidental lockouts:
* **Cannot disable/suspend the last active ADMIN:** If the target user is the only user with role `ADMIN` and status `ACTIVE`, updating their status to `INACTIVE` or `SUSPENDED` is blocked.
* **Cannot demote the last active ADMIN:** If the target user is the only active `ADMIN`, changing their role is blocked.
* **Self-deactivation / Self-demotion restriction:** The current active administrator cannot deactivate, suspend, or demote themselves if they are the last active `ADMIN`.

## 6. External Sales Compatibility
* Users with role `EXTERNAL_SALES` are in the same D1 `users` table.
* Changing a user's role from `EXTERNAL_SALES` to any other role is blocked if they still own customers in the `customers` table.
* They must have their customers reassigned before role demotion.
