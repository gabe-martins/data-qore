BEGIN;
SET LOCAL ROLE dataqore_app_owner;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE app.access_groups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 255),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
    profile text NOT NULL CHECK (profile IN ('viewer','quality_manager','developer','platform_admin')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX access_groups_name_unique ON app.access_groups (lower(name));
INSERT INTO app.access_groups (name, description, profile)
VALUES ('Platform Administrators', 'Full platform and access administration', 'platform_admin');
ALTER TABLE app.users ADD COLUMN group_id uuid;
UPDATE app.users SET group_id = (SELECT id FROM app.access_groups WHERE profile = 'platform_admin');
ALTER TABLE app.users ALTER COLUMN group_id SET NOT NULL;
ALTER TABLE app.users ADD CONSTRAINT users_group_id_fkey FOREIGN KEY (group_id) REFERENCES app.access_groups(id) ON DELETE RESTRICT;
CREATE INDEX users_group_idx ON app.users(group_id);
ALTER TABLE app.users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE app.users DROP COLUMN role;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.access_groups TO srv_dataqore_app;
COMMIT;
