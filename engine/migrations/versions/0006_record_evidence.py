"""Bounded encrypted record evidence; preserves all existing history."""
from alembic import op

revision = "0006_record_evidence"
down_revision = "0005_critical_metrics"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("""CREATE TABLE engine.run_record_evidence (
        run_id uuid NOT NULL REFERENCES engine.runs(id) ON DELETE RESTRICT,
        ordinal integer NOT NULL CHECK (ordinal >= 0),
        state text NOT NULL CHECK (state IN ('equal','different','only_source','only_target','unknown')),
        affected_columns jsonb NOT NULL CHECK (jsonb_typeof(affected_columns)='array'),
        key_digest text NOT NULL,
        payload_ciphertext text NOT NULL,
        expires_at timestamptz NOT NULL,
        PRIMARY KEY (run_id, ordinal)
    )""")
    op.execute("CREATE INDEX evidence_state_idx ON engine.run_record_evidence(run_id,state,ordinal)")
    op.execute("CREATE INDEX evidence_key_idx ON engine.run_record_evidence(run_id,key_digest)")
    op.execute("CREATE INDEX evidence_expiry_idx ON engine.run_record_evidence(expires_at)")
    op.execute("CREATE INDEX evidence_columns_idx ON engine.run_record_evidence USING gin(affected_columns)")
    op.execute("GRANT SELECT, INSERT, DELETE ON engine.run_record_evidence TO srv_dataqore_engine")


def downgrade():
    raise RuntimeError("Forward-only migration")
