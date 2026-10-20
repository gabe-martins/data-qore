"""Unity Catalog dataset identity and optional Databricks connector."""
from alembic import op
revision = '0003_databricks'
down_revision = '0002_comparison_options'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("SET LOCAL statement_timeout = '30s'")
    op.execute("ALTER TABLE engine.connections DROP CONSTRAINT connections_connector_check")
    op.execute("ALTER TABLE engine.connections ADD CONSTRAINT connections_connector_check CHECK (connector IN ('postgresql','mysql','mssql','oracle','sqlite','databricks'))")
    op.execute("ALTER TABLE engine.datasets ADD COLUMN catalog_name text NOT NULL DEFAULT ''")
    op.execute("ALTER TABLE engine.datasets DROP CONSTRAINT datasets_connection_id_schema_name_table_name_key")
    op.execute("ALTER TABLE engine.datasets ADD CONSTRAINT datasets_source_identity_key UNIQUE (connection_id,catalog_name,schema_name,table_name)")


def downgrade():
    raise RuntimeError('Forward-only revision; preserve datasets and credentials.')
