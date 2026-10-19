# DataQore Local Launcher

Run the launcher from the project root:

```bash
./dataqore.sh
```

It prepares the Python environment, installs pinned dependencies when needed,
generates the Prisma client, builds the controller and web app, checks database
access, and starts the engine API, worker, controller, and Vite in the background.

## Before the first launch

Use Linux, Python 3.12 or later with `venv` and pip, Node.js 24 or later, npm,
and `flock` from util-linux. Prepare an accessible PostgreSQL 15 or later server
using the [database guide](../database/README.md#first-time-setup).

Copy the environment examples to `engine.env` and `controller.env` without
overwriting existing files, then configure the database URLs. Configure
`SQLITE_ALLOWED_ROOT` if you use SQLite sources. See the
[project quick start](../README.md#get-started) for the complete sequence.

The launcher does not install system programs, create containers, provision
databases, or apply migrations. The first dependency installation needs access
to package registries.

## Environment and accounts

Existing database URLs, valid encryption keys, and administrator credentials are
preserved. Missing internal secrets are prepared locally, and the controller's
engine API key is synchronized with the engine. An encryption key can only be
generated automatically when no encrypted connections have been saved.

If environment files are missing, the launcher creates local examples and stops
so you can enter real database URLs. Run it again after editing those files.
Files are protected with mode `600`. The launcher uses the root environment
files explicitly rather than inheriting database URLs and secrets from the shell.

When no administrator exists, launch from an interactive terminal and follow the
account creation prompts. Existing accounts are not reset.

## Commands

```bash
./dataqore.sh start    # Default: prepare and start
./dataqore.sh setup    # Prepare and check without starting services
./dataqore.sh status   # Show managed processes and health checks
./dataqore.sh logs     # Show recent log output
./dataqore.sh stop     # Stop managed processes
./dataqore.sh restart  # Stop, prepare, and start again
./dataqore.sh --help   # Show command help
```

Open [DataQore](http://127.0.0.1:5173/). The engine uses port `8000` and the
controller uses `3000`; services listen only on the local machine.

Logs are in `.local/logs/` and process records are in `.local/run/`, both outside
version control. Keep process records while services are running.

## Troubleshooting

- **Database access fails:** confirm provisioning, host, port, credentials, and
  network connectivity before relaunching.
- **A port is occupied:** stop the conflicting service from its original terminal.
  The launcher does not stop unrelated processes.
- **An encryption key is missing or invalid:** recover the original key if saved
  connections exist; do not replace it with a new key.
- **Code or configuration changed:** use `restart` to reload services. Review any
  interrupted runs in the web app.
- **A connector is unavailable:** install its optional drivers using the
  [engine guide](../engine/README.md#optional-connectors).

Starting again preserves already managed processes. If startup fails, newly
started services from that attempt are stopped while previously managed ones
are preserved. Subsequent launches reuse dependencies while their manifests
and lockfiles remain unchanged.
