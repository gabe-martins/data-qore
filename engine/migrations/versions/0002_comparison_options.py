"""Recortes equivalentes e mapeamento explícito, preservando definições antigas."""
from alembic import op

revision = "0002_comparison_options"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '30s'")
    op.execute("ALTER TABLE engine.comparison_definitions ADD COLUMN comparison_options jsonb NOT NULL DEFAULT '{}'::jsonb")
    op.execute("ALTER TABLE engine.comparison_definitions ADD CONSTRAINT comparison_definitions_options_check CHECK (jsonb_typeof(comparison_options) = 'object'::text)")


def downgrade():
    raise RuntimeError("Downgrade destrutivo indisponível; preserve as configurações e use uma nova revisão.")
