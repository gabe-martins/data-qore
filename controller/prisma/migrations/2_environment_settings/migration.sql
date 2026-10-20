BEGIN;
SET LOCAL ROLE dataqore_app_owner;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.environment_settings (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    comparison_target_percentage numeric(7,4) NOT NULL DEFAULT 95
        CHECK (comparison_target_percentage >= 0 AND comparison_target_percentage <= 100),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app.environment_settings(id) VALUES (true);
REVOKE ALL ON app.environment_settings FROM srv_dataqore_app;
GRANT SELECT, UPDATE ON app.environment_settings TO srv_dataqore_app;
COMMIT;
