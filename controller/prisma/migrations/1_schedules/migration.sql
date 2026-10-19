BEGIN;
SET LOCAL ROLE dataqore_app_owner;

CREATE TABLE app.schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (btrim(name) <> ''),
    comparison_id uuid NOT NULL,
    cron_expression text NOT NULL CHECK (btrim(cron_expression) <> ''),
    timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
    is_active boolean NOT NULL DEFAULT true,
    next_run_at timestamptz NOT NULL,
    created_by uuid REFERENCES app.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_due_idx ON app.schedules (is_active, next_run_at);
CREATE INDEX schedules_comparison_idx ON app.schedules (comparison_id);

-- Outbox local: a chave imutável do disparo também identifica o pedido no motor.
CREATE TABLE app.schedule_dispatches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id uuid NOT NULL REFERENCES app.schedules(id) ON DELETE CASCADE,
    comparison_id uuid NOT NULL,
    scheduled_for timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched','skipped','failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    enqueue_started boolean NOT NULL DEFAULT false,
    run_id uuid,
    error_code text,
    retry_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    claim_token uuid,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (schedule_id, scheduled_for),
    CHECK ((status = 'dispatched') = (run_id IS NOT NULL))
);
CREATE INDEX schedule_dispatches_pending_idx ON app.schedule_dispatches (status, retry_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON app.schedules, app.schedule_dispatches TO srv_dataqore_app;
COMMIT;
