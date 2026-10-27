# Docker Compose deployment

Run DataQore on a personal Linux Intel/AMD 64-bit server with Docker Engine and
Docker Compose **2.24 or later**. Run commands from the project directory on that
server. Internet access is needed for the initial builds and image downloads.

## Start the application

In `compose.yaml`, configure:

```yaml
x-timezone: &timezone America/Sao_Paulo
services:
  controller:
    environment:
      WEB_ORIGIN: http://192.168.15.9:8080
```

Replace the IP with the server's LAN address. The checked-in example uses
`192.168.15.9:8080`. The web service publishes `0.0.0.0:8080:8080`, so other
computers on your network can reach it. Allow this port in your host firewall.
If you change the published port, change `WEB_ORIGIN` to match. The optional
`DATAQORE_WEB_ORIGIN`, `DATAQORE_PORT`, and `DATAQORE_BIND_ADDRESS` environment
variables override these values; no environment file is required.

Start with a single command:

```bash
docker compose up -d --build
```

Open `http://192.168.15.9:8080`. On a fresh database, the first visitor chooses
their name, email, and password in the setup form and becomes the platform
administrator. The password must have 12–128 characters. Setup closes once any
user exists; two simultaneous submissions cannot create two initial admins.
The winning visitor is signed in automatically. Existing installations show
normal sign-in and preserve all users and groups.

This workflow follows the [Langflow Compose deployment approach](https://github.com/langflow-ai/langflow/blob/main/docker_example/docker-compose.yml):
configuration in Compose, persistent volumes, a database service, and one startup
command. DataQore builds its own application images from this checkout and uses
public Node, Python, Nginx, and PostgreSQL base images. It requires no Minimus
account, registry token, host Python, `setup` command, or pre-created secret file.

## Automatic initialization and persistence

Compose starts these services in dependency order:

1. `bootstrap` creates random database passwords, internal API/JWT secrets,
   identity encryption and Fernet keys in the `bootstrap-data` volume. It validates
   `TZ` before starting the database and never prints the secrets.
2. It exports only the configuration needed by each component into separate
   private volumes. PostgreSQL exports belong to UID 999; application exports
   belong to UID 1000. Files have mode `0600`; directories have mode `0700`.
3. `postgres` provisions `dataqore_app`, `dataqore_engine`, owners, runtime accounts
   and migrators on a new data volume, using administrative scripts `00` and `05`.
4. `migrate` applies and verifies Prisma/Alembic migrations with the dedicated
   migrator accounts. API and worker startup is blocked on failure.
5. `engine`, `worker`, `controller`, and `web` start. Nginx serves the built SPA
   and proxies `/api/` to the controller without publishing internal APIs.

Only bootstrap mounts the master keys. Application containers receive read-only
configuration volumes with runtime credentials; they do not receive database
administrator or migrator passwords. The worker and engine share the same image.
The controller also runs the scheduler; keep one controller and one worker per
installation.

`TZ` is applied to **every** container, with `America/Sao_Paulo` as the default.
It controls the container clock presentation and local timezone behavior.
Database timestamps and metrics partitions remain UTC. Existing comparison
interpretations and each schedule's explicitly selected IANA timezone are
preserved; changing `TZ` does not reinterpret source timestamps.

Volumes survive `docker compose down` and container recreation. Never use
`docker compose down --volumes` for an installation you want to preserve. If
PostgreSQL already contains data but the master keys are missing, bootstrap
refuses to generate replacements. Restore the original keys before restarting.

## Existing installations and sources

If `.env.docker` from the old setup exists, bootstrap imports its original
secrets on first startup. A complete set of keys is required. Later startups
reuse the persisted keys; conflicting imported values stop startup rather than
silently rotating encryption keys or database passwords. Keep the original
Compose project name so existing volume names remain associated with it.
Back up an existing installation before changing its container base images;
for a database created with Minimus, restore into a fresh official PostgreSQL
volume with the original keys rather than switching OS libraries in place.

No external source, dataset, rule, or comparison is created automatically. Add
sources in the application after sign-in. The engine image includes PostgreSQL,
SQLite, MySQL, Oracle, SQL Server, and Databricks clients; their servers remain
external. Use the actual source server's IP/hostname, since `localhost` inside
a container identifies that container.

For SQLite sources, optionally add a Compose override mounting the same existing
directory in both engine and worker, read-only:

```yaml
# compose.sources.yaml
services:
  engine:
    volumes:
      - /srv/dataqore-sources:/sources:ro
  worker:
    volumes:
      - /srv/dataqore-sources:/sources:ro
```

Use `docker compose -f compose.yaml -f compose.sources.yaml` for all operations
when using that override. Files must be readable by UID 1000. Register the
container path, such as `/sources/records.sqlite`, in the application.

## Operations and updates

```bash
docker compose ps -a
docker compose logs --tail 100
docker compose logs --tail 100 worker
docker compose down
docker compose up -d --build
```

Bootstrap and migrate should exit with code zero; database and application
services should stay running. The source build needs no pre-published DataQore
image. For updates, back up first, stop `web controller worker engine`, obtain
the new source version and run the startup command again. The worker has 20
seconds to handle SIGTERM and stop supervised jobs. The optional `docker.sh`
wrapper remains available for status, logs and verification.

To check drivers, readiness, SPA routes and the API proxy without querying
registered sources:

```bash
docker compose exec -T web nginx -t
docker compose run --rm --no-deps engine /app/docker/verify.py
```

To recover an administrator password using the existing interactive CLI:

```bash
docker compose run --rm --no-deps controller dist/src/admin.js reset-password
```

If bootstrap fails, inspect its logs. Common causes are an invalid `TZ`, missing
original keys, an incomplete legacy `.env.docker`, or volume permissions. If a
migration fails, inspect `migrate` logs and repair it without resetting databases.
A browser `origin_rejected` response means `WEB_ORIGIN` must match the exact URL,
including scheme and port, used in the browser.

## Backup and recovery

Back up the master configuration **together with both databases**. Stop the
application writers to obtain a consistent pair of dumps, leaving PostgreSQL
running. Execute commands individually and check their exit codes:

```bash
umask 077
backup_dir="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
docker compose stop web controller worker engine
docker compose exec -T postgres pg_dump -U postgres -Fc dataqore_app > "$backup_dir/app.dump"
docker compose exec -T postgres pg_dump -U postgres -Fc dataqore_engine > "$backup_dir/engine.dump"
docker compose run --rm --no-deps -T --entrypoint cat bootstrap /state/secrets.json > "$backup_dir/secrets.json"
docker compose exec -T postgres pg_restore --list < "$backup_dir/app.dump" > /dev/null
docker compose exec -T postgres pg_restore --list < "$backup_dir/engine.dump" > /dev/null
docker compose up -d
```

A successful archive listing validates its format, not a complete recovery.
Test recovery in a separate installation with empty volumes and the same source
version. Restore `secrets.json` into `/state/secrets.json` in `bootstrap-data`
before starting PostgreSQL. This example refuses to overwrite existing keys:

```bash
docker compose build bootstrap
docker compose run --rm --no-deps -T --entrypoint python bootstrap -c 'import os,sys; os.umask(0o077); f=open("/state/secrets.json","xb"); f.write(sys.stdin.buffer.read()); f.close()' < /PATH/TO/BACKUP/secrets.json
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U postgres --exit-on-error --clean --if-exists -d dataqore_app < /PATH/TO/BACKUP/app.dump
docker compose exec -T postgres pg_restore -U postgres --exit-on-error --clean --if-exists -d dataqore_engine < /PATH/TO/BACKUP/engine.dump
docker compose up -d --build
```

Restore replaces the destination database objects; run it only against your
chosen recovery installation with application writers stopped. The same roles
are recreated by provisioning. Bootstrap reconstructs the per-service exports
from the restored master keys. Source databases and SQLite files have their own
backup requirements. Confirm sign-in, encrypted source credentials and saved
results after recovery.

## Validation

`docker compose config --quiet` checks the Compose file without starting services.
Configuration and bootstrap tests use only temporary files and optional
disposable PostgreSQL clusters:

```bash
PYTHONPATH=engine:tests engine/.venv/bin/python -m unittest discover -s tests -p 'test_compose_bootstrap.py' -v
# Optional standalone Compose parser and PostgreSQL integration:
DATAQORE_COMPOSE_BIN=/PATH/docker-compose DATAQORE_PG_BIN=/PATH/postgresql/16/bin \
  PYTHONPATH=engine:tests engine/.venv/bin/python -m unittest discover -s tests -p 'test_compose_bootstrap.py' -v
```

Complete runtime acceptance requires a Docker host: build/start all containers,
create the first administrator through the browser, verify sign-in after reload,
run a comparison against a disposable test source, and confirm persistence after
down/up. Only the web port should be published. Local builds and isolated tests
do not substitute for the complete Docker acceptance run.
