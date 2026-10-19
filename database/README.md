# DataQore Database Setup

DataQore requires PostgreSQL 15 or later. It uses two separate databases:

| Database | Schema | Runtime account |
| --- | --- | --- |
| `dataqore_app` | `app` | `srv_dataqore_app` |
| `dataqore_engine` | `engine` | `srv_dataqore_engine` |

The runtime accounts are restricted to their own application data. Database
provisioning and migrations use separate administrative accounts. Source database
credentials are separate and should provide read-only access to those sources.

Run shell commands below from the project root. The local launcher does not
perform any of these provisioning steps.

## First-time setup

These steps provision **new databases** using the supplied SQL scripts. For an
existing installation, preserve its databases and follow [Existing installations](#existing-installations).

### 1. Create databases and tables

With `psql` installed, set the connection details for a PostgreSQL administrator:

```bash
export PGHOST='YOUR_DATABASE_HOST'
export PGPORT='5432'
export PGUSER='postgres'

psql -X -W -v ON_ERROR_STOP=1 -d postgres -f database/00_databases_and_roles.sql
psql -X -W -v ON_ERROR_STOP=1 -d dataqore_app -f database/01_app.sql
psql -X -W -v ON_ERROR_STOP=1 -d dataqore_engine -f database/02_engine.sql
psql -X -W -v ON_ERROR_STOP=1 -d dataqore_engine -f database/03_metrics_partitions.sql
```

Use the actual host, published port, and administrator account for your server.
`-W` prompts for the administrator password. You can also run the SQL scripts
through an existing container's `psql` or a database client, selecting the database
shown for each file.

Scripts `00`, `01`, and `02` are for initial provisioning and must only run once
against new databases. Run `00` with autocommit; do not use `--single-transaction`
because it creates databases. If a script fails partway through, inspect the
existing objects before continuing; do not delete databases to retry.

### 2. Set runtime account passwords

Open an administrative session:

```bash
psql -X -W -d postgres
```

Inside `psql`, set distinct passwords interactively:

```text
\password srv_dataqore_app
\password srv_dataqore_engine
\q
```

These accounts have no password until you set one. The server must allow
password authentication and be reachable from the machine running DataQore.

### 3. Verify access

```bash
psql -X -W -v ON_ERROR_STOP=1 -d postgres -f database/04_verify_access.psql
psql -X -W -U srv_dataqore_app -d dataqore_app -c 'SELECT current_user, current_database();'
psql -X -W -U srv_dataqore_engine -d dataqore_engine -c 'SELECT current_user, current_database();'
```

All `passed` values from the verification script must be `true`. The two runtime
connections must succeed. The verification script uses `psql` commands and should
be run with `psql` rather than pasted wholesale into a graphical SQL editor.

### 4. Configure DataQore

Copy the environment examples without overwriting existing configuration:

```bash
cp -n controller.env.example controller.env
cp -n engine.env.example engine.env
```

Set `DATABASE_URL` in each local file with its corresponding runtime account:

| File | URL format |
| --- | --- |
| `controller.env` | `postgresql://srv_dataqore_app:URL_ENCODED_PASSWORD@HOST:5432/dataqore_app?schema=app&sslmode=prefer` |
| `engine.env` | `postgresql+psycopg://srv_dataqore_engine:URL_ENCODED_PASSWORD@HOST:5432/dataqore_engine?sslmode=prefer` |

Replace the host, port, and password. Percent-encode special characters in URL
passwords. Match TLS options to your PostgreSQL server; `sslmode=prefer` allows
the local setup without requiring TLS.

The launcher prepares missing internal secrets for a fresh installation. If you
use SQLite sources, replace `SQLITE_ALLOWED_ROOT` with their absolute directory.
Keep the real environment files private and out of version control.

Return to the [quick start](../README.md#4-start-dataqore) to start the app and
create its administrator. Database accounts are not web login accounts.

## Existing installations

Do not rerun initial provisioning scripts on existing databases. Preserve runtime
URLs, encryption keys, and saved data. Use the existing
[migration reference](MIGRATIONS.md) when adopting migration tracking or applying
schema changes. It describes dedicated migrator accounts and the baseline process
for databases originally created with SQL scripts.

For a new installation managed by migrations instead of the SQL table scripts,
follow that reference's new-environment procedure. Do not combine both table
creation paths. `MIGRATION_DATABASE_URL` belongs only to migration tools; it must
not replace a runtime `DATABASE_URL`.

## Monthly partitions

Initial setup creates metric partitions for the previous month, the current
month, and the next three months. Maintain them regularly with an administrator
connected to `dataqore_engine`:

```sql
BEGIN;
SET LOCAL ROLE dataqore_engine_owner;
SELECT engine.ensure_metrics_partitions(
    date_trunc('month', now() AT TIME ZONE 'UTC')::date, 4
);
COMMIT;
```

This maintenance can be repeated. Runtime accounts cannot create partitions.
Missing partitions prevent new metrics from being saved for the affected month.
There is no automatic deletion of historical metrics.

## Configuration changes

Restart DataQore after changing local connection settings. Editing a password in
an environment file does not change that account's password in PostgreSQL.
Changing a database URL does not move existing data to the new database.
Preserve the original encryption key and version when reusing saved connections.
