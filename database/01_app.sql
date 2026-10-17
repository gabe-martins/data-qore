-- Execute como administrador, conectado exclusivamente ao database dataqore_app.
BEGIN;
DO $$ BEGIN
    IF current_database() <> 'dataqore_app' THEN
        RAISE EXCEPTION 'Conecte ao database dataqore_app';
    END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
SET LOCAL ROLE dataqore_app_owner;
CREATE SCHEMA app AUTHORIZATION dataqore_app_owner;

CREATE TABLE app.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL CHECK (email = btrim(email) AND email <> ''),
    display_name text NOT NULL CHECK (btrim(display_name) <> ''),
    password_hash text NOT NULL CHECK (password_hash <> ''),
    role text NOT NULL DEFAULT 'admin' CHECK (role = 'admin'),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON app.users (lower(email));

-- Apenas hashes dos refresh tokens; nunca JWT/refresh token em texto puro.
CREATE TABLE app.auth_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    refresh_token_hash text NOT NULL UNIQUE CHECK (refresh_token_hash <> ''),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX auth_sessions_user_idx ON app.auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry_idx ON app.auth_sessions (expires_at);

CREATE TABLE app.audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id uuid REFERENCES app.users(id) ON DELETE SET NULL,
    action text NOT NULL CHECK (btrim(action) <> ''),
    resource_type text NOT NULL CHECK (btrim(resource_type) <> ''),
    resource_id text,
    request_id uuid,
    outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
    details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON app.audit_log (created_at DESC);
CREATE INDEX audit_log_actor_idx ON app.audit_log (actor_user_id, created_at DESC);

GRANT USAGE ON SCHEMA app TO srv_dataqore_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO srv_dataqore_app;
REVOKE UPDATE, DELETE ON app.audit_log FROM srv_dataqore_app;

-- Aplicáveis somente a objetos criados por dataqore_app_owner, inclusive migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE dataqore_app_owner IN SCHEMA app
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO srv_dataqore_app;
-- UUIDs dispensam sequences; o grant cobre futuras colunas identity/serial.
ALTER DEFAULT PRIVILEGES FOR ROLE dataqore_app_owner IN SCHEMA app
    GRANT USAGE, SELECT ON SEQUENCES TO srv_dataqore_app;
ALTER DEFAULT PRIVILEGES FOR ROLE dataqore_app_owner
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMIT;
