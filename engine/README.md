# DataQore Engine

The engine provides the internal services for connections, the dataset catalog,
data profiles, and comparison runs. The web app accesses it through the
controller. A separate worker handles background jobs.

For a first installation, follow the [project quick start](../README.md#get-started).
This guide covers installation and operation. Run commands from the project root.

## Install

Use Python 3.12 or later with an already provisioned engine database:

```bash
python3 -m venv engine/.venv
engine/.venv/bin/python -m pip install -r engine/requirements.lock
```

The local launcher performs this installation automatically when needed.

## Optional connectors

PostgreSQL and SQLite drivers are included in the base installation. To enable
MySQL, Oracle, and SQL Server drivers:

```bash
engine/.venv/bin/python -m pip install -r engine/requirements-connectors.txt
```

Additional system requirements vary by driver and operating system. An optional
driver is only needed for its corresponding source. Test each connection in the
web app before saving it.

## Configuration

Use `engine.env` in the project root, based on [the example](../engine.env.example).

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | Runtime connection to `dataqore_engine` as `srv_dataqore_engine` |
| `ENGINE_API_KEY` | Internal secret of at least 16 characters, shared with the controller |
| `CONNECTIONS_ENCRYPTION_KEY` | Fernet key protecting saved connection credentials |
| `CONNECTIONS_ENCRYPTION_KEY_VERSION` | Encryption key version; initially `v1` |
| `SQLITE_ALLOWED_ROOT` | Absolute directory containing allowed SQLite source files |
| `WORKER_HEARTBEAT_SECONDS` | Worker heartbeat interval; default `5` |
| `WORKER_JOB_TIMEOUT_SECONDS` | Job timeout; default `600` |
| `WORKER_POLL_SECONDS` | Queue polling interval; default `1` |

For a fresh database, the launcher prepares missing internal secrets. For manual
setup, generate a Fernet key locally:

```bash
engine/.venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Store it privately in `CONNECTIONS_ENCRYPTION_KEY`. Preserve the original key
when reusing saved connections; replacing it makes their credentials unreadable.
The encryption key is independent of the PostgreSQL password and engine API key.

Manual commands load `engine.env` from the project root. Exported variables take
precedence; `DATAQORE_ENV_FILE` selects another file. API and worker processes do
not use `MIGRATION_DATABASE_URL` or apply migrations.

## Run locally

Use `./dataqore.sh` for the complete app, or start these processes in separate
terminals for development:

```bash
PYTHONPATH=engine engine/.venv/bin/python -m dataqore_engine api
```

```bash
PYTHONPATH=engine engine/.venv/bin/python -m dataqore_engine worker
```

The API listens on `127.0.0.1:8000`. `/health/live` checks the process and
`/health/ready` checks database access. Internal `/v1` endpoints require the
`X-API-Key` header. Keep the key on the server side.

SQLite source files must already exist under `SQLITE_ALLOWED_ROOT`; there is
no upload flow. Use read-only source credentials for other database systems.

## Operations

For equivalent time/batch scopes, explicit column pairs and composite business
keys, see [the comparison guide](../docs/SCOPED_COMPARISONS.md). This update needs
engine migration `0002_comparison_options`; existing definitions default to `{}`.
The preview endpoint checks current metadata without scanning key uniqueness.

Review execution progress and results in the web app's **Runs** page. After
restarting a worker, review interrupted runs before submitting a new request.
Maintain database partitions using the [database guide](../database/README.md#monthly-partitions).

## Validation

```bash
PYTHONPATH=engine engine/.venv/bin/python -m unittest discover -s tests -v
```

Integration checks require local PostgreSQL binaries and use temporary clusters:

```bash
PYTHONPATH=engine:tests DATAQORE_PG_BIN=/PATH/TO/POSTGRESQL/bin \
  engine/.venv/bin/python -m unittest discover -s tests -v
```

The suite does not use real environment files or an existing database server.
External connectors also need validation against their respective database
systems before use in a new environment.
