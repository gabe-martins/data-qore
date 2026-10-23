# Users, groups and access control

Each user belongs to one group. A group has a name, description and one fixed profile. Groups organize teams; data is shared across the application. There are no per-user permission overrides or group-specific datasets.

| Capability | Results Viewer | Quality Manager | Data Developer | Platform Administrator |
| --- | --- | --- | --- | --- |
| Dashboard, run history, results and result downloads | Yes | Yes | Yes | Yes |
| Registered datasets and comparison definitions | No | Yes | Yes | Yes |
| Create, edit, delete and execute comparisons | No | Yes | Yes | Yes |
| Manage schedules | No | Yes | Yes | Yes |
| Explore sources and manage registered datasets | No | No | Yes | Yes |
| Manage and test connections | No | No | Yes | Yes |
| Manage users, groups, passwords and sessions | No | No | No | Yes |
| Read security audit | No | No | No | Yes |

Existing dependency checks still apply to deletions. Results may contain business data and source/query metadata; assign viewer access accordingly. Credentials and the internal engine key are never returned to the browser.

## Administration

Open **Groups** to create a team and select its profile. Open **Users** to create a user, assign its group and provide a temporary password of 12–128 characters. Deliver the password through your organization's approved external channel. A new user must replace it before accessing application features. There is no email delivery or public signup.

Users can be activated or deactivated, moved between groups, given a temporary replacement password, or signed out through **Revoke sessions**. Users are not permanently deleted. Groups can be deleted only when no users, including inactive users, belong to them. The final active platform administrator cannot be deactivated or demoted, including by changing its group's profile. These checks serialize concurrent administrative changes.

A group reassignment, group profile change, deactivation or password reset revokes affected sessions. A password change revokes all the user's sessions. Renaming a group does not change its permissions. Existing schedules belong to the application and continue after their creator is deactivated; a Quality Manager or higher can pause them.

The initial administrator is created using `npm run admin:create --prefix controller`. Local recovery uses `npm run admin:reset-password --prefix controller`, restricted to platform administrators. Recovery also requires a password change at next login.

## Upgrade an existing installation

The forward migration `4_access_control` preserves users, password hashes and saved operational data. It assigns existing users to **Platform Administrators**, removes the legacy `role` column and requires explicit group assignment for every new user. Existing users are not forced to reset their passwords by the migration.

Use the usual database backup process before updating. With application traffic paused, apply and verify the app migration using its dedicated migrator configuration:

```bash
engine/.venv/bin/python tools/migrations.py app status
engine/.venv/bin/python tools/migrations.py app apply
engine/.venv/bin/python tools/migrations.py app verify
npm run prisma:generate --prefix controller
npm run build --prefix controller
npm run build --prefix web
./dataqore.sh restart
```

Follow [MIGRATIONS.md](../database/MIGRATIONS.md) if the installation has not adopted migration tracking. Never rerun the historical initial SQL against an existing database. The engine database needs no new migration for this feature. Deploy controller and web together: the old `role` response field has been replaced by `group`, `profile`, `permissions` and `must_change_password` in login, refresh and `/api/v1/auth/me`.

## API and security boundary

The controller enforces a fixed permission for each HTTP method and route template before accessing protected resources or forwarding to the engine. Unmapped operations are denied. Unauthenticated requests receive `401`; authenticated requests without permission receive `403`. A temporary-password session receives `403` with `password_change_required` except for account lookup, password change and logout. Refresh remains available to maintain the session.

Administrative endpoints are under `/api/v1/users` and `/api/v1/groups`. Password reset and session revocation use `POST /users/{id}/reset-password` and `POST /users/{id}/revoke-sessions`. Only empty groups support `DELETE`. `/api/v1/audit-log` exposes a paginated security history to platform administrators. Lists accept `limit`, `offset` and `search`; OpenAPI describes the payloads and required permissions.

Successful access mutations and their audit entry commit together. Denied requests also generate audit events. Passwords, password hashes and session tokens are excluded from administrative responses and audit records. The controller rechecks user/session/group state in PostgreSQL; permission claims in a browser or token are not accepted as authority. The engine remains a private service authenticated by its internal key and must not be published as a user-facing API.

## Verification

`controller/tests/access.test.ts` exercises the four-profile matrix across all engine routes, checks that denied operations never reach a fake upstream, tests unmapped routes, temporary passwords, revocation and concurrent last-administrator protection against disposable PostgreSQL. `web/tests/access-control.spec.ts` covers navigation, direct-route denial, required password changes and administration forms at desktop and mobile sizes. Migration tests verify the preservation of pre-existing administrators and explicit membership for new accounts.

Run the isolated integration fixture with PostgreSQL binaries available in `DATAQORE_PG_BIN`:

```bash
PYTHONPATH=engine:tests engine/.venv/bin/python -m unittest test_migrations test_access_control test_full_stack -v
```

These tests provision their own disposable cluster and do not use personal database URLs.
