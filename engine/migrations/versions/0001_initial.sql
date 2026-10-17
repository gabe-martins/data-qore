SET LOCAL ROLE dataqore_engine_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SET LOCAL ROLE dataqore_engine_owner;
CREATE SCHEMA IF NOT EXISTS engine AUTHORIZATION dataqore_engine_owner;

CREATE TABLE engine.connections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
    connector text NOT NULL CHECK (connector IN ('postgresql', 'mysql', 'mssql', 'oracle', 'sqlite')),
    credentials_ciphertext text NOT NULL CHECK (credentials_ciphertext <> ''),
    encryption_key_version text NOT NULL DEFAULT 'v1' CHECK (encryption_key_version <> ''),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN engine.connections.credentials_ciphertext IS
    'Payload de conexão cifrado pela aplicação com Fernet. Chave fora do database.';

CREATE TABLE engine.datasets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id uuid NOT NULL REFERENCES engine.connections(id) ON DELETE RESTRICT,
    schema_name text NOT NULL DEFAULT '',
    table_name text NOT NULL CHECK (table_name <> ''),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    discovered_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, schema_name, table_name)
);

CREATE TABLE engine.comparison_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
    left_dataset_id uuid NOT NULL REFERENCES engine.datasets(id) ON DELETE RESTRICT,
    right_dataset_id uuid NOT NULL REFERENCES engine.datasets(id) ON DELETE RESTRICT,
    mode text NOT NULL DEFAULT 'auto'
        CHECK (mode IN ('auto', 'matched_keys', 'independent_random')),
    sampling_options jsonb NOT NULL DEFAULT
        '{"pilot_rows":64,"min_rows":64,"max_rows":1000,"max_cells":100000,"max_sample_bytes":16777216,"proportion_margin":0.05}'::jsonb
        CHECK (jsonb_typeof(sampling_options) = 'object'),
    sample_size integer CHECK (sample_size BETWEEN 1 AND 10000),
    absolute_tolerance numeric NOT NULL DEFAULT 0
        CHECK (absolute_tolerance >= 0 AND absolute_tolerance < 'Infinity'::numeric),
    relative_tolerance numeric NOT NULL DEFAULT 0
        CHECK (relative_tolerance >= 0 AND relative_tolerance < 'Infinity'::numeric),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (left_dataset_id <> right_dataset_id)
);
CREATE INDEX comparisons_left_dataset_idx ON engine.comparison_definitions (left_dataset_id);
CREATE INDEX comparisons_right_dataset_idx ON engine.comparison_definitions (right_dataset_id);

CREATE TABLE engine.runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('comparison', 'profile')),
    comparison_id uuid REFERENCES engine.comparison_definitions(id) ON DELETE RESTRICT,
    dataset_id uuid REFERENCES engine.datasets(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    -- Snapshot da definição/opções; não incluir credenciais nem registros.
    parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
    idempotency_key text UNIQUE CHECK (idempotency_key IS NULL OR idempotency_key <> ''),
    requested_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    heartbeat_at timestamptz,
    error_code text,
    error_message text,
    CHECK ((kind = 'comparison' AND comparison_id IS NOT NULL AND dataset_id IS NULL)
        OR (kind = 'profile' AND dataset_id IS NOT NULL AND comparison_id IS NULL)),
    CHECK ((status = 'queued' AND started_at IS NULL AND finished_at IS NULL)
        OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL)
        OR (status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL)
        OR (status = 'failed' AND finished_at IS NOT NULL)),
    CHECK (started_at IS NULL OR started_at >= requested_at),
    CHECK (finished_at IS NULL OR finished_at >= requested_at),
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX runs_queue_idx ON engine.runs (requested_at, id) WHERE status = 'queued';
CREATE INDEX runs_comparison_idx ON engine.runs (comparison_id, requested_at DESC);
CREATE INDEX runs_dataset_idx ON engine.runs (dataset_id, requested_at DESC);
CREATE INDEX runs_active_idx ON engine.runs (heartbeat_at) WHERE status = 'running';

CREATE TABLE engine.run_results (
    run_id uuid PRIMARY KEY REFERENCES engine.runs(id) ON DELETE RESTRICT,
    format_version integer NOT NULL CHECK (format_version > 0),
    conclusion text NOT NULL CHECK (conclusion IN
        ('compatible_in_sample', 'difference_observed', 'profile_only', 'inconclusive')),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN engine.run_results.result IS
    'Resultado agregado versionado; sem linhas, chaves amostradas ou credenciais. Preservar Decimal na serialização.';

CREATE TABLE engine.column_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id uuid NOT NULL REFERENCES engine.runs(id) ON DELETE RESTRICT,
    dataset_id uuid NOT NULL REFERENCES engine.datasets(id) ON DELETE RESTRICT,
    column_name text NOT NULL CHECK (column_name <> ''),
    profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, dataset_id, column_name)
);
CREATE INDEX column_profiles_dataset_idx ON engine.column_profiles (dataset_id, created_at DESC);

-- Uma linha por métrica numérica observada. Ausência de avaliação é NULL, não zero.
CREATE TABLE engine.metrics (
    measured_at timestamptz NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    run_id uuid NOT NULL REFERENCES engine.runs(id) ON DELETE RESTRICT,
    dataset_id uuid NOT NULL REFERENCES engine.datasets(id) ON DELETE RESTRICT,
    column_name text,
    metric_name text NOT NULL CHECK (btrim(metric_name) <> ''),
    value numeric CHECK (value > '-Infinity'::numeric AND value < 'Infinity'::numeric),
    evaluated_count bigint CHECK (evaluated_count >= 0),
    applicable_count bigint CHECK (applicable_count >= 0),
    PRIMARY KEY (measured_at, id),
    CHECK (evaluated_count IS NULL OR applicable_count IS NULL OR evaluated_count <= applicable_count)
) PARTITION BY RANGE (measured_at);
CREATE INDEX metrics_series_idx ON engine.metrics
    (dataset_id, column_name, metric_name, measured_at DESC);
CREATE INDEX metrics_run_idx ON engine.metrics (run_id);

GRANT USAGE ON SCHEMA engine TO srv_dataqore_engine;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA engine TO srv_dataqore_engine;
ALTER DEFAULT PRIVILEGES FOR ROLE dataqore_engine_owner IN SCHEMA engine
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO srv_dataqore_engine;
ALTER DEFAULT PRIVILEGES FOR ROLE dataqore_engine_owner IN SCHEMA engine
    GRANT USAGE, SELECT ON SEQUENCES TO srv_dataqore_engine;
ALTER DEFAULT PRIVILEGES FOR ROLE dataqore_engine_owner
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

SET LOCAL ROLE dataqore_engine_owner;

-- SECURITY INVOKER: o serviço não recebe EXECUTE nem poderes de DDL.
CREATE OR REPLACE FUNCTION engine.ensure_metrics_partitions(first_month date, month_count integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
    month_start date;
    month_end date;
    partition_name text;
    offset_month integer;
BEGIN
    IF first_month IS NULL OR month_count IS NULL OR month_count NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'Informe first_month e month_count entre 1 e 120';
    END IF;
    -- Serializa chamadas concorrentes desta rotina de manutenção.
    PERFORM pg_advisory_xact_lock(80417, 1);
    FOR offset_month IN 0..month_count - 1 LOOP
        month_start := (date_trunc('month', first_month::timestamp)
            + make_interval(months => offset_month))::date;
        month_end := (month_start + interval '1 month')::date;
        partition_name := 'metrics_' || to_char(month_start, 'YYYY_MM');
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS engine.%I PARTITION OF engine.metrics FOR VALUES FROM (%L) TO (%L)',
            partition_name, month_start::text || ' 00:00:00+00', month_end::text || ' 00:00:00+00'
        );
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION engine.ensure_metrics_partitions(date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine.ensure_metrics_partitions(date, integer) FROM srv_dataqore_engine;

-- Mês anterior, atual e três seguintes, sempre com fronteiras UTC.
SELECT engine.ensure_metrics_partitions(
    (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date, 5
);
