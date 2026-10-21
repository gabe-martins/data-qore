"""Business rules: exact typed values, historical snapshots and aggregate-only evidence."""
from datetime import datetime
from decimal import Decimal
import json
import os
from pathlib import Path
import sqlite3
import unittest
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from sqlalchemy import select
from dataqore_engine import models as m
from dataqore_engine.api import create_app
from dataqore_engine.business_rules import RuleInput, RuleSetUpdate, assess_business, validate_rule
from dataqore_engine.core.quality import UnavailableValue, profile_rows
from dataqore_engine.storage import DomainError, database_engine, json_safe
from dataqore_engine.jobs import Queue, run_job
from postgres_fixture import TemporaryPostgres
from test_api import settings


def rule(column="value", kind="required", **definition):
    return {"id":str(uuid4()), "name":"Business check", "column":column, "is_active":True,
        "definition":{"kind":kind, **definition}, "version":1}


def evaluate(rows, rules, columns=None):
    columns = columns or {"value":{"type":"text", "nullable":True}}
    frozen=[]
    for r in rules:
        parsed=RuleInput.model_validate({k:v for k,v in r.items() if k!="version"})
        frozen.append({**parsed.model_dump(mode="json"),"version":r["version"]})
    return assess_business(profile_rows(columns,list(columns),rows),{"revision":1,"rules":frozen})


class BusinessRuleTests(unittest.TestCase):
    def test_required_nullable_null_blank_zero_false_and_spaces(self):
        r=rule()
        result=evaluate([(None,),("",),(" ",),(0,),(False,)], [r])["rules"][0]
        self.assertEqual((result["passed"],result["failed"],result["evaluated"]),(3,2,5))
        r["definition"]["whitespace_blank"]=True
        self.assertEqual(evaluate([(" ",)], [r])["rules"][0]["failed"],1)
        r["definition"]["reject_blank"]=False
        self.assertEqual(evaluate([("",)], [r])["rules"][0]["passed"],1)

    def test_domain_values_are_exact_and_boolean_not_integer(self):
        result=evaluate([("paid",),("PAID",),(" paid",),(None,)], [rule(kind="domain",values=["paid"])])
        self.assertEqual(result["overall"]["passed"],1)
        boolean={"value":{"type":"boolean"}}
        self.assertEqual(evaluate([(False,),(True,)], [rule(kind="domain",values=[False])],boolean)["overall"]["passed"],1)
        with self.assertRaises(DomainError): validate_rule(RuleInput.model_validate({"column":"value","name":"x","definition":{"kind":"domain","values":[0]}}),boolean)

    def test_decimal_precision_and_inclusive_exclusive_bounds(self):
        low="12345678901234567890.12345678901234567890"
        high="12345678901234567890.12345678901234567892"
        r=rule(kind="range",minimum=low,maximum=high,include_maximum=False)
        result=evaluate([(Decimal(low),),(Decimal(high),),(Decimal("12345678901234567890.12345678901234567891"),)], [r], {"value":{"type":"numeric"}})
        self.assertEqual((result["overall"]["passed"],result["overall"]["failed"]),(2,1))
        for value in ("NaN","Infinity","-Infinity","1,1"," 1"):
            with self.assertRaises(DomainError):validate_rule(RuleInput(column="value",name="x",definition={"kind":"range","minimum":value}),{"value":{"type":"numeric"}})

    def test_unknown_and_skipped_values_reduce_coverage(self):
        r=rule(kind="range",minimum="0",null_policy="skip")
        result=evaluate([(None,),(UnavailableValue("lob"),),("invalid",),(1,)], [r], {"value":{"type":"numeric"}})["rules"][0]
        self.assertEqual((result["passed"],result["evaluated"],result["not_evaluated"],result["coverage_percentage"]),(1,1,3,Decimal(25)))
        self.assertEqual(result["state"],"inconclusive")
        self.assertNotIn("lob",json.dumps(json_safe(result)))

    def test_empty_disabled_and_no_rules_never_approve(self):
        r=rule(); r["is_active"]=False
        self.assertIsNone(evaluate([("x",)], [r])["overall"]["percentage"])
        self.assertIsNone(evaluate([], [rule()])["overall"]["percentage"])
        self.assertIsNone(evaluate([("x",)], [])["overall"]["percentage"])

    def test_schema_changed_is_explicit_inconclusive(self):
        result=evaluate([(1,)], [rule(column="removed")], {"value":{"type":"integer"}})["rules"][0]
        self.assertEqual(result["reasons"],{"schema_incompatible":1})
        self.assertIsNone(result["percentage"])

    def test_temporal_ranges_order_and_timezone(self):
        columns={"value":{"type":"timestamp"},"end":{"type":"timestamp"}}
        r=rule(kind="temporal_order",other_column="end",timezone="America/Sao_Paulo")
        result=evaluate([(datetime(2026,10,1,10),datetime(2026,10,1,11)),(datetime(2026,10,1,12),datetime(2026,10,1,11)),(None,datetime(2026,10,1,11))], [r],columns)
        self.assertEqual((result["overall"]["passed"],result["overall"]["failed"]),(1,2))
        r["definition"].pop("timezone")
        with self.assertRaises(DomainError):validate_rule(RuleInput.model_validate({k:v for k,v in r.items() if k!="version"}),columns)
        r=rule(kind="range",minimum="2026-10-01T12:00:00Z",maximum="2026-10-01T13:00:00Z",timezone="America/Sao_Paulo")
        self.assertEqual(evaluate([(datetime(2026,10,1,9),)], [r],{"value":columns["value"]})["overall"]["passed"],1)

    def test_dst_ambiguous_and_nonexistent_times_not_evaluated(self):
        r=rule(kind="range",minimum="2026-01-01T00:00:00Z",timezone="America/New_York")
        result=evaluate([(datetime(2026,11,1,1,30),),(datetime(2026,3,8,2,30),)], [r],{"value":{"type":"timestamp"}})
        self.assertEqual(result["overall"]["evaluated"],0)

    def test_timestamp_domain_requires_explicit_naive_timezone(self):
        r=rule(kind="domain",values=["2026-10-01T12:00:00Z"],timezone="America/Sao_Paulo")
        result=evaluate([(datetime(2026,10,1,9),),(datetime(2026,10,1,10),)], [r],{"value":{"type":"timestamp"}})
        self.assertEqual((result["overall"]["passed"],result["overall"]["failed"]),(1,1))

    def test_temporal_submicrosecond_precision_is_not_truncated(self):
        r=rule(kind="range",minimum="2026-10-01T00:00:00.1234568Z")
        columns={"value":{"type":"timestamp with time zone"}}
        result=evaluate([("2026-10-01T00:00:00.1234567Z",),("2026-10-01T00:00:00.1234568Z",)], [r],columns)
        self.assertEqual((result["overall"]["passed"],result["overall"]["failed"]),(1,1))

    def test_date_boundaries_and_incompatible_types(self):
        r=rule(kind="range",minimum="2026-10-01",maximum="2026-10-02",include_maximum=False)
        self.assertEqual(evaluate([("2026-10-01",),("2026-10-02",)], [r],{"value":{"type":"date"}})["overall"]["passed"],1)
        with self.assertRaises(DomainError):validate_rule(RuleInput.model_validate({k:v for k,v in r.items() if k!="version"}),{"value":{"type":"text"}})
        with self.assertRaises(ValueError):RuleSetUpdate(expected_revision=0,rules=[{"name":"x","column":"value","definition":{"kind":"required","sql":"DROP TABLE x"}}])


@unittest.skipUnless(os.environ.get("DATAQORE_PG_BIN"),"Requires disposable PostgreSQL")
class BusinessRulesIntegrationTests(TemporaryPostgres):
    def setUp(self):
        super().setUp(); self.command("engine","baseline"); self.command("engine","apply")
        self.cfg=settings(f"postgresql+psycopg://srv_dataqore_engine@127.0.0.1:{self.port}/dataqore_engine",self.directory)
        self.db=database_engine(self.cfg); self.addCleanup(self.db.dispose)
        self.client=TestClient(create_app(self.cfg)); self.client.__enter__();self.addCleanup(self.client.__exit__,None,None,None)
        self.headers={"X-API-Key":self.cfg.api_key}
        self.path=self.directory/(str(uuid4())+".sqlite")
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE records(id integer primary key, value text, amount numeric)")
            db.executemany("INSERT INTO records VALUES(?,?,?)",[(1,None,10),(2,"",20),(3,"paid",30)])
        response=self.client.post("/v1/connections",headers=self.headers,json={"name":"Rules source","connector":"sqlite","credentials":{"database":str(self.path)}})
        self.assertEqual(response.status_code,201,response.text)
        response=self.client.post("/v1/datasets",headers=self.headers,json={"connection_id":response.json()["id"],"table_name":"records"})
        self.assertEqual(response.status_code,201,response.text);self.dataset=response.json()["id"]

    def test_version_conflict_frozen_rules_and_profile_atomicity(self):
        path=f"/v1/datasets/{self.dataset}/quality-rules"
        self.assertEqual(self.client.get(path).status_code,401)
        body={"expected_revision":0,"rules":[{"name":"Mandatory value","column":"value","definition":{"kind":"required"}}]}
        response=self.client.post(path,headers=self.headers,json=body);self.assertEqual(response.status_code,200,response.text)
        saved=response.json();self.assertEqual(saved["rules"][0]["version"],1)
        self.assertEqual(self.client.post(path,headers=self.headers,json=body).status_code,409)
        run=self.client.post(f"/v1/datasets/{self.dataset}/profile-runs",headers={**self.headers,"Idempotency-Key":"frozen-business-rules"},json={"sample_size":3}).json()
        item={k:v for k,v in saved["rules"][0].items() if k!="version"};item["is_active"]=False
        response=self.client.post(path,headers=self.headers,json={"expected_revision":1,"rules":[item]})
        self.assertEqual(response.json()["rules"][0]["version"],2)
        replay=self.client.post(f"/v1/datasets/{self.dataset}/profile-runs",headers={**self.headers,"Idempotency-Key":"frozen-business-rules"},json={"sample_size":3}).json()
        self.assertEqual(replay["id"],run["id"])
        self.assertEqual(replay["parameters"]["sources"][0]["quality_rules"]["revision"],1)
        queue=Queue(self.db);identifier=queue.claim();run_job(self.cfg,identifier)
        response=self.client.get(f"/v1/runs/{run['id']}/result",headers=self.headers);self.assertEqual(response.status_code,200,response.text)
        result=response.json()["result"];self.assertNotIn("sample_rows",json.dumps(result));quality=result["indicators"]["business_quality"]
        self.assertEqual((quality["overall"]["passed"],quality["overall"]["failed"]),(1,2))
        self.assertEqual(quality["sources"][0]["rules_revision"],1)
        self.assertEqual(quality["sources"][0]["rules"][0]["rule"]["version"],1)
        self.assertEqual(result["summary"]["status"],"difference_observed")
        self.assertEqual(result["indicators"]["quality"]["overall"]["failed"],0)
        with self.db.connect() as conn:
            self.assertEqual(len(conn.execute(select(m.column_profiles).where(m.column_profiles.c.run_id==identifier)).all()),3)
            self.assertEqual(conn.scalar(select(m.runs.c.status).where(m.runs.c.id==identifier)),"succeeded")
        run2=self.client.post(f"/v1/datasets/{self.dataset}/profile-runs",headers=self.headers,json={"sample_size":3}).json()
        run_job(self.cfg,queue.claim())
        result2=self.client.get(f"/v1/runs/{run2['id']}/result",headers=self.headers).json()["result"]
        self.assertIsNone(result2["indicators"]["business_quality"]["overall"]["percentage"])
        self.assertEqual(result2["indicators"]["business_quality"]["sources"][0]["rules"][0]["state"],"disabled")
        before=self.table_oids("engine");self.command("engine","apply");self.assertEqual(before,self.table_oids("engine"))
        with self.connect("engine") as conn:
            self.assertEqual(conn.execute("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='engine.datasets'::regclass").fetchone()[0],"dataqore_engine_owner")
            self.assertFalse(conn.execute("SELECT has_schema_privilege('srv_dataqore_engine','engine','CREATE')").fetchone()[0])

    def test_validation_concurrent_updates_and_comparison_schedule_snapshot(self):
        path=f"/v1/datasets/{self.dataset}/quality-rules"
        invalid={"expected_revision":0,"rules":[{"name":"Bad date","column":"value","definition":{"kind":"range","minimum":"2026-10-01"}}]}
        self.assertEqual(self.client.post(path,headers=self.headers,json=invalid).status_code,422)
        from dataqore_engine.business_rules import BusinessRules
        payload=RuleSetUpdate(expected_revision=0,rules=[{"name":"Allowed amount","column":"amount","definition":{"kind":"range","minimum":"15"}}])
        def update(_):
            try:return BusinessRules(self.db).replace(self.dataset,payload)["revision"]
            except DomainError as e:return e.status
        with ThreadPoolExecutor(max_workers=2) as pool:self.assertEqual(sorted(pool.map(update,range(2))),[1,409])
        connection=self.client.post("/v1/connections",headers=self.headers,json={"name":"Second source","connector":"sqlite","credentials":{"database":str(self.path)}}).json()
        response=self.client.post("/v1/datasets",headers=self.headers,json={"connection_id":connection["id"],"table_name":"records"})
        self.assertEqual(response.status_code,201,response.text)
        other=response.json()["id"]
        comparison=self.client.post("/v1/comparisons",headers=self.headers,json={"name":"Business comparison","left_dataset_id":self.dataset,"right_dataset_id":other}).json()
        response=self.client.post(f"/v1/comparisons/{comparison['id']}/runs",headers={**self.headers,"Idempotency-Key":"schedule:controlled-quality"},json={})
        self.assertEqual(response.status_code,202,response.text)
        queue=Queue(self.db);identifier=queue.claim();run_job(self.cfg,identifier)
        result=self.client.get(f"/v1/runs/{identifier}/result",headers=self.headers).json()["result"]
        self.assertEqual(result["indicators"]["business_quality"]["overall"]["failed"],1)
        self.assertEqual(len(result["indicators"]["business_quality"]["sources"]),2)
        self.assertEqual(result["indicators"]["agreement"]["percentage"],"100.0000")
