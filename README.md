<p align="center">
  <img src="web/public/branding/dataqore-logo.svg" alt="DataQore" width="360">
</p>

# DataQore

**Trust your data.**

DataQore is a web platform for understanding data quality, comparing datasets,
and reviewing results in one place. Its Advanced Data Quality (ADQ) workspace
helps you explore your data and follow up on differences with clear reports.

## What you can do

- Connect your data sources and browse their tables.
- Organize datasets in a shared catalog.
- Run data profiles and review quality indicators.
- Compare datasets and review reported differences.
- Track runs and revisit previous results.

PostgreSQL and SQLite are included by default. MySQL, Oracle, and SQL Server
require the optional drivers described in the [engine setup guide](engine/README.md#optional-connectors).

## Get started

### 1. Check the requirements

Use Linux with Python 3.12 or later (including `venv` and pip), Node.js 24 or
later, npm, and an accessible PostgreSQL 15 or later server. The local launcher
also requires `flock` from util-linux. Internet access is needed to install
packages the first time.

Run the following commands from the `data-qore` project directory.

### 2. Prepare the databases

Follow the [database setup guide](database/README.md#first-time-setup) to create
the application's databases and service accounts. If you already have a working
installation, keep its databases and configuration.

The launcher does **not** create databases or apply migrations.

### 3. Configure your local environment

For a new installation, copy the examples without overwriting existing files:

```bash
cp -n engine.env.example engine.env
cp -n controller.env.example controller.env
```

Set `DATABASE_URL` in each file to the corresponding database address and service
account from the database guide. Replace the host, port, and password placeholders.
If you use SQLite sources, set `SQLITE_ALLOWED_ROOT` to their absolute directory.
Keep both files private and out of version control.

The launcher prepares missing internal secrets and preserves valid existing
settings. Keep the original encryption key when reusing an existing installation.

### 4. Start DataQore

```bash
./dataqore.sh
```

The launcher installs project dependencies, builds the app, checks database
access, and starts the local services. On the first run, use an interactive
terminal and follow the prompts to create your administrator: name, email, and
a password of 12–128 characters. There is no default account or password.

Open [DataQore](http://127.0.0.1:5173/) and sign in with that account.
Use this exact address for the local setup.

### 5. Explore your data

Add a source in **Connections**, register a table in **Catalog**, and open the
dataset to run a profile. Use **Comparisons** to compare datasets and **Runs**
to follow progress and review results.

## Everyday commands

```bash
./dataqore.sh status   # Check the local services
./dataqore.sh logs     # View recent logs
./dataqore.sh stop     # Stop the local services
./dataqore.sh restart  # Reload after code or configuration changes
```

DataQore currently runs locally. See the [launcher guide](scripts/README.md)
for setup details and troubleshooting.

## Project guides

| Guide | What it covers |
| --- | --- |
| [Web app](web/README.md) | Frontend development and builds |
| [Controller](controller/README.md) | Application configuration and account management |
| [Engine](engine/README.md) | Service setup and optional connectors |
| [Database](database/README.md) | Initial provisioning and database maintenance |
| [Launcher](scripts/README.md) | Starting, stopping, and troubleshooting local services |

## Schedules

Schedule comparisons from **Schedules**, using a traditional cron expression or the guided form.
The scheduler runs inside the controller. See the [scheduling guide](docs/SCHEDULES.md) for migration and operation instructions.

<p align="center">
  <img src="web/public/branding/dataqore-symbol.svg" alt="DataQore symbol" width="64">
</p>
