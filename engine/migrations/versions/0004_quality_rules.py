"""Versioned dataset business rules; historical runs keep their frozen definitions."""
from alembic import op
revision = "0004_quality_rules"
down_revision = "0003_databricks"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '30s'")
    op.execute("""ALTER TABLE engine.datasets ADD COLUMN quality_rules jsonb NOT NULL
        DEFAULT '{"revision": 0, "rules": []}'::jsonb
        CONSTRAINT datasets_quality_rules_check CHECK (quality_rules ?& ARRAY['revision','rules'] AND jsonb_typeof(quality_rules) = 'object'
            AND jsonb_typeof(quality_rules->'rules') = 'array'
            AND jsonb_typeof(quality_rules->'revision') = 'number')""")


def downgrade():
    raise RuntimeError("Forward-only revision; preserve rules and historical evidence.")
