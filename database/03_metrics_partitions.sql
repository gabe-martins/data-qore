-- Execute como administrador no dataqore_engine. Reexecutável.
BEGIN;
DO $$ BEGIN
    IF current_database() <> 'dataqore_engine' THEN
        RAISE EXCEPTION 'Conecte ao database dataqore_engine';
    END IF;
END $$;
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
COMMIT;
