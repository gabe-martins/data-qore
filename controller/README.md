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
Only one administrator is supported; there is no public registration or default
password. Resetting the password revokes existing sessions.

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
