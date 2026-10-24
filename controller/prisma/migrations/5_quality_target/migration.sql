BEGIN;
SET LOCAL ROLE dataqore_app_owner;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE app.quality_settings (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    row_match_target_percentage numeric(7,4) DEFAULT 95
        CHECK (row_match_target_percentage >= 0 AND row_match_target_percentage <= 100),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app.quality_settings(id) VALUES (true);
REVOKE ALL ON app.quality_settings FROM srv_dataqore_app;
GRANT SELECT, UPDATE ON app.quality_settings TO srv_dataqore_app;
COMMIT;
