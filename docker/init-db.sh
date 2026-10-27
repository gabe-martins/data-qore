#!/bin/sh
# Executed by the PostgreSQL entrypoint only for a new PGDATA directory.
set -eu
if [ -d /config ]; then
    APP_DB_PASSWORD=$(cat /config/APP_DB_PASSWORD)
    ENGINE_DB_PASSWORD=$(cat /config/ENGINE_DB_PASSWORD)
    APP_MIGRATION_PASSWORD=$(cat /config/APP_MIGRATION_PASSWORD)
    ENGINE_MIGRATION_PASSWORD=$(cat /config/ENGINE_MIGRATION_PASSWORD)
    export APP_DB_PASSWORD ENGINE_DB_PASSWORD APP_MIGRATION_PASSWORD ENGINE_MIGRATION_PASSWORD
fi
psql -X --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 \
    --file /dataqore/database/00_databases_and_roles.sql
psql -X --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 \
    --file /dataqore/database/05_migration_roles.sql
psql -X --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password APP_DB_PASSWORD
\getenv engine_password ENGINE_DB_PASSWORD
\getenv app_migrator_password APP_MIGRATION_PASSWORD
\getenv engine_migrator_password ENGINE_MIGRATION_PASSWORD
ALTER ROLE srv_dataqore_app PASSWORD :'app_password';
ALTER ROLE srv_dataqore_engine PASSWORD :'engine_password';
ALTER ROLE srv_dataqore_app_migrator PASSWORD :'app_migrator_password';
ALTER ROLE srv_dataqore_engine_migrator PASSWORD :'engine_migrator_password';
SQL
