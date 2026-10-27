# DataQore Controller

The controller serves the web app's API and manages local sign-in and accounts.
It uses NestJS, Fastify, and Prisma, with its own application database.

For a first installation, follow the [project quick start](../README.md#get-started).
Run the commands below from the project root.

## Prepare the controller

Use Node.js 24 or later and a provisioned application database:

```bash
npm ci --prefix controller
npm run prisma:generate --prefix controller
npm run build --prefix controller
```

Configure `controller.env` using [the example](../controller.env.example):

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | Runtime connection to `dataqore_app` as `srv_dataqore_app` |
| `ENGINE_API_URL` | Internal engine address; locally `http://127.0.0.1:8000` |
| `ENGINE_API_KEY` | Internal secret shared with the engine |
| `JWT_SECRET` | Random signing secret of at least 32 characters |
| `WEB_ORIGIN` | Exact browser origin; locally `http://127.0.0.1:5173` |
| `CONTROLLER_HOST` | Exported listen address; default `127.0.0.1`, set to `0.0.0.0` inside Docker |
| `ACCESS_TOKEN_SECONDS` | Access token lifetime; default `900` |
| `REFRESH_TOKEN_SECONDS` | Session renewal lifetime; default `604800` |

The launcher prepares missing internal secrets. For manual execution, exported
variables take precedence and `DATAQORE_ENV_FILE` selects an alternative file.
`MIGRATION_DATABASE_URL` is reserved for migration tools; the running service
does not apply migrations.

## Verify database access

```bash
npm run db:runtime-check --prefix controller
```

The check reads database identity and administrator count without changing data
or printing credentials. For `database_network_unreachable`, check the network
route. For `database_connection_refused`, check the server and port. For
`database_starting_up`, wait until PostgreSQL accepts new connections.

## Manage the administrator

The launcher prompts for the initial administrator when no account exists.
For manual setup or password recovery:

```bash
npm run admin:create --prefix controller
npm run admin:reset-password --prefix controller
```

These interactive commands prompt for email and password without echoing the
password. Creation also asks for a name. Use a password of 12–128 characters.
The initial administrator can create users and groups in the web interface. There is no public registration or default password. Resetting a password revokes existing sessions and requires the user to choose a different password on next access. The local recovery command accepts platform administrator accounts only.

See [access control](../docs/ACCESS_CONTROL.md) for profiles, permissions and upgrades.

## Run locally

```bash
npm run dev --prefix controller
# After building:
npm start --prefix controller
```

The controller listens on `127.0.0.1:3000`. Open the web app through
`http://127.0.0.1:5173/` so requests use the configured origin.

- `/health/live` checks the process.
- `/health/ready` checks application database access.
- `/api/openapi.json` exposes the public API contract.

The controller authenticates requests and connects the web app to internal
services. Local HTTP settings are intended for the local launcher workflow.

## API types and tests

After changing API contracts, regenerate the corresponding files:

```bash
npm run openapi:export --prefix controller
npm run types:generate --prefix controller
npm run types:generate --prefix web
```

Use the [web app test instructions](../web/README.md#browser-checks) for the
isolated integration suite. Integration tests require the disposable fixture;
they skip execution without its internal test flag.

## Agendamentos

O processo do controller também executa o agendador de comparações, com cron
tradicional de cinco campos, fuso IANA e outbox persistida no app. Aplique a
nova migration `1_schedules` antes de iniciar esta versão. O comando de
execução continua o mesmo; não há processo extra. Veja [operação e políticas](../docs/SCHEDULES.md).


## User identity encryption

Names/emails use versioned AES-256-GCM bound to the user UUID. Login and
uniqueness use a separate HMAC-SHA-256 blind index. Set
`IDENTITY_ENCRYPTION_KEY` to 32 random bytes encoded as unpadded base64url,
independent of JWT/API secrets. Preserve it in a restricted secret store outside
database backups. Local setup generates it only for an empty user database and
never replaces a configured key. Substring search decrypts batches in memory
before filtering/pagination and costs O(number of users).

Before rollout, stop controller access, verify a restorable backup, and provide
the key to both controller and migrator. From the root, use the wrapper:

```bash
engine/.venv/bin/python tools/migrations.py app apply
engine/.venv/bin/python tools/migrations.py app verify
```

It applies `6_identity_encryption`, transactionally encrypts existing identities
and validates the database constraint. Failed backfills roll back identity
updates and return failure; retry with the original key before starting the
controller. Successful SQL schema changes remain recorded: do not downgrade or
reset data. Running Prisma deploy directly omits this required backfill.

For rotation with services stopped, supply the new key as
`IDENTITY_ENCRYPTION_KEY` and the original as
`IDENTITY_PREVIOUS_ENCRYPTION_KEY` to the same wrapper. After success, start the
controller with the new key and remove the previous key from its environment.
Password hashes, UUIDs, groups and sessions are preserved.
