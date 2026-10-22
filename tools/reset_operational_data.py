"""Explicit internal reset for the v6 release. No source connection is ever opened."""

import argparse
from contextlib import ExitStack
from pathlib import Path
import sys
import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.migration_config import load_url, postgres_url
from tools.migrations import check_connection

TABLES = {
    "app": ("schedule_dispatches", "schedules", "audit_log", "auth_sessions"),
    "engine": (
        "metrics",
        "column_profiles",
        "run_results",
        "runs",
        "comparison_definitions",
        "datasets",
        "connections",
    ),
}


def inspect(connection, service):
    check_connection(connection, service)
    result = {}
    for table in TABLES[service]:
        if connection.execute(
            "SELECT to_regclass(%s)", (f"{service}.{table}",)
        ).fetchone()[0]:
            result[table] = connection.execute(
                sql.SQL("SELECT count(*) FROM {}.{}").format(
                    sql.Identifier(service), sql.Identifier(table)
                )
            ).fetchone()[0]
    return result


def reset_service(connection, service):
    """One transactional, idempotent stage; users and migration histories are excluded."""
    before = inspect(connection, service)
    with connection.transaction():
        connection.execute("SET LOCAL lock_timeout = '5s'")
        connection.execute("SET LOCAL statement_timeout = '60s'")
        # Runtime services must be stopped before deleting either database.
        active = connection.execute(
            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename=%s AND pid<>pg_backend_pid()",
            (f"srv_dataqore_{service}",),
        ).fetchone()[0]
        if active:
            raise ValueError("Stop controller, scheduler, API and worker before reset.")
        for table in before:
            connection.execute(
                sql.SQL("DELETE FROM {}.{}").format(
                    sql.Identifier(service), sql.Identifier(table)
                )
            )
        if any(inspect(connection, service).values()):
            raise ValueError("Reset verification failed")
    return before


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Delete operational data, including encrypted connections; preserve administrator.",
    )
    args = parser.parse_args()
    try:
        with ExitStack() as stack:
            connections = {
                service: stack.enter_context(
                    psycopg.connect(
                        postgres_url(load_url(service)),
                        autocommit=True,
                        connect_timeout=10,
                    )
                )
                for service in TABLES
            }
            # Validate both destinations before the first mutation.
            for service, connection in connections.items():
                counts = inspect(connection, service)
                active = connection.execute(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename=%s",
                    (f"srv_dataqore_{service}",),
                ).fetchone()[0]
                if args.apply and active:
                    raise ValueError(
                        "Stop controller, scheduler, API and worker before reset."
                    )
                print(service, counts)
            if args.apply:
                for service, connection in connections.items():
                    reset_service(connection, service)
                    print(service + ": operational reset complete")
            else:
                print(
                    "Read-only inspection. Use --apply to perform the authorized reset."
                )
        return 0
    except Exception as error:
        # Driver exceptions may include credentials; only our own validation is public.
        print(
            (
                str(error)
                if isinstance(error, ValueError)
                else "Internal database reset failed; services must remain stopped. No source was modified."
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
