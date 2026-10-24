"""Evidence contracts without creating or loading source datasets."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import os
import unittest
from cryptography.fernet import Fernet
from dataqore_engine.evidence import EvidenceCapture, cell, decrypt_row, evidence_state, key_digest
from dataqore_engine.storage import DomainError
from dataqore_engine.quality_results import QualityResults
from postgres_fixture import TemporaryPostgres


class RecordEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.secret=Fernet.generate_key().decode()

    def test_values_keep_null_empty_whitespace_absence_and_precision(self):
        info={"type":"text"}
        self.assertEqual(cell(None,info)["kind"],"null")
        self.assertEqual(cell(None,info,False)["kind"],"missing")
        self.assertEqual(cell("",info)["raw"],"")
        self.assertEqual(cell("  ",info)["raw"],"  ")
        self.assertEqual(cell(Decimal("9007199254740993.01"),{"type":"numeric"})["raw"],"9007199254740993.01")

    def test_ciphertext_and_key_lookup_are_bound_to_execution(self):
        capture=EvidenceCapture(self.secret,"run-a")
        info=[{"type":"bigint"}]
        capture.capture([9007199254740993],info,"equal",[])
        row=capture.rows[0]
        self.assertNotIn("9007199254740993",json.dumps(row))
        self.assertEqual(decrypt_row(self.secret,row)["key"][0]["raw"],"9007199254740993")
        self.assertEqual(row["key_digest"],key_digest(self.secret,"run-a",["9007199254740993"],info))
        self.assertNotEqual(row["key_digest"],key_digest(self.secret,"run-b",["9007199254740993"],info))
        with self.assertRaises(DomainError):decrypt_row(self.secret,{**row,"run_id":"run-b"})

    def test_limits_are_explicit_and_expiry_preserves_aggregate_availability(self):
        capture=EvidenceCapture(self.secret,"run",max_bytes=0)
        capture.capture([1],[{"type":"integer"}],"different",[])
        finished=datetime.now(timezone.utc)
        manifest=capture.manifest(1,True,finished.isoformat())
        self.assertEqual(manifest["status"],"partial")
        self.assertEqual(manifest["stored_positions"],0)
        self.assertEqual(datetime.fromisoformat(manifest["expires_at"]),finished+timedelta(days=30))
        self.assertEqual(evidence_state({"evidence":manifest},finished+timedelta(days=31))["status"],"expired")
        self.assertEqual(evidence_state({})["status"],"not_captured")
        self.assertEqual(EvidenceCapture("","run").manifest(0,False,finished.isoformat())["status"],"unavailable")


@unittest.skipUnless(os.environ.get("DATAQORE_PG_BIN"),"Disposable PostgreSQL required")
class EvidenceMigrationTests(TemporaryPostgres):
    def test_forward_migration_grants_catalog_and_expiry_on_empty_internal_schema(self):
        self.command("engine","baseline")
        self.command("engine","apply")
        self.command("engine","verify")
        self.command("engine","apply")
        with self.connect("engine","srv_dataqore_engine") as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM engine.run_record_evidence").fetchone()[0],0)
            self.assertTrue(conn.execute("SELECT has_table_privilege(current_user,'engine.run_record_evidence','INSERT,SELECT,DELETE')").fetchone()[0])
            self.assertFalse(conn.execute("SELECT has_schema_privilege(current_user,'engine','CREATE')").fetchone()[0])
        from dataqore_engine.evidence import purge_expired
        from dataqore_engine.settings import Settings
        from dataqore_engine.storage import database_engine
        settings=Settings(f"postgresql+psycopg://srv_dataqore_engine@127.0.0.1:{self.port}/dataqore_engine","test-internal-key-123456789",self.secret if hasattr(self,"secret") else Fernet.generate_key().decode())
        engine=database_engine(settings)
        try:self.assertEqual(purge_expired(engine),0)
        finally:engine.dispose()
