BEGIN;
SET LOCAL ROLE dataqore_app_owner;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TABLE app.environment_settings;
COMMIT;
