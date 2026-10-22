"""Only the five critical comparison metrics; requires an explicit operational reset."""

from alembic import op

revision = "0005_critical_metrics"
down_revision = "0004_quality_rules"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '30s'")
    op.execute(
        """DO $$ BEGIN
        IF EXISTS(SELECT FROM engine.connections) OR EXISTS(SELECT FROM engine.datasets)
           OR EXISTS(SELECT FROM engine.runs) OR EXISTS(SELECT FROM engine.comparison_definitions)
        THEN RAISE EXCEPTION 'Run the authorized operational reset before migrating'; END IF;
    END $$"""
    )
    op.execute("DROP TABLE engine.metrics")
    op.execute("DROP TABLE engine.column_profiles")
    op.execute("DROP FUNCTION engine.ensure_metrics_partitions(date, integer)")
    op.execute("ALTER TABLE engine.datasets DROP COLUMN quality_rules")
    op.execute(
        "ALTER TABLE engine.comparison_definitions DROP COLUMN mode, DROP COLUMN sample_size"
    )
    op.execute(
        """ALTER TABLE engine.comparison_definitions ALTER COLUMN sampling_options
        SET DEFAULT '{"method": "rows", "rows": 1000, "max_cells": 100000, "max_sample_bytes": 16777216}'::jsonb"""
    )
    op.execute(
        "ALTER TABLE engine.runs DROP CONSTRAINT runs_check, DROP CONSTRAINT runs_kind_check, DROP COLUMN dataset_id"
    )
    op.execute(
        "ALTER TABLE engine.runs ADD CONSTRAINT runs_check CHECK(kind='comparison' AND comparison_id IS NOT NULL), ADD CONSTRAINT runs_kind_check CHECK(kind='comparison')"
    )
    op.execute(
        "ALTER TABLE engine.run_results DROP CONSTRAINT run_results_conclusion_check"
    )
    op.execute(
        "ALTER TABLE engine.run_results ADD CONSTRAINT run_results_conclusion_check CHECK(conclusion IN ('compatible_in_sample','difference_observed','inconclusive'))"
    )


def downgrade():
    raise RuntimeError("Forward-only reset release")
