"""Read-only projections of one frozen execution and its bounded evidence."""
import json
import base64
from uuid import UUID
from sqlalchemy import select, func
from . import models as m
from .comparison_options import compatible
from .evidence import decrypt_row, evidence_state, key_digest
from .storage import DomainError, Repository


class QualityResults:
    def __init__(self, engine, settings):
        self.engine, self.settings = engine, settings
        self.repository = Repository(engine)

    def load(self, run_id):
        run = self.repository.get(m.runs, run_id)
        with self.engine.connect() as conn:
            name = conn.scalar(select(m.comparison_definitions.c.name).where(m.comparison_definitions.c.id == run["comparison_id"]))
            result = conn.scalar(select(m.run_results.c.result).where(m.run_results.c.run_id == run_id)) if run["status"] == "succeeded" else None
        return run, name or "Comparison", result

    def columns(self, result):
        columns = []
        sources = result.get("sources", [])
        mapping_count = len(result.get("column_mapping", []))
        for i, metric in enumerate(result["metrics"]["column_match_rate"]):
            left, right = metric["left_column"], metric["right_column"]
            lm = sources[0]["columns"].get(left, {}) if left else {}
            rm = sources[1]["columns"].get(right, {}) if right else {}
            column_id = f"pair_{i}" if i < mapping_count else "left:" + left if left else "right:" + right
            blocked = not left or not right or not compatible(lm, rm)
            status = "critical" if blocked else "attention" if metric["different_values"] else "not_calculated" if metric["not_evaluated"] or not metric["denominator"] else "passed"
            columns.append({"id": column_id, "left_column": left, "right_column": right,
                "left_type": lm.get("type"), "right_type": rm.get("type"), "status": status, "metric": metric})
        return columns

    def summary(self, run_id):
        run, name, result = self.load(run_id)
        from .schemas import RunOut
        run={k:v for k,v in run.items() if k in RunOut.model_fields}
        parameters={k:v for k,v in run["parameters"].items() if k!="request_fingerprint"}
        parameters["sources"]=[{k:v for k,v in source.items() if k!="expected_columns"} for source in parameters.get("sources",[])]
        run["parameters"]=parameters
        out = {"run": run, "comparison_name": name, "result": result, "dimensions": [], "diagnostics": [],
               "evidence": evidence_state(result or {})}
        if not result:
            return out
        metrics = result["metrics"]
        row, count, keys = (metrics[n] for n in ("row_match_rate", "row_count_match", "key_coverage"))
        invalid = any(not d["valid"] for d in result["key_validation"])
        blockers = sum(c["status"] == "critical" for c in self.columns(result))
        def observed(rate):
            return "not_calculated" if not rate["denominator"] or rate["not_evaluated"] else "passed"
        key_status = "critical" if invalid or keys["missing_in_reference"] or keys["missing_in_target"] else "not_calculated" if any(observed(keys[d]) != "passed" for d in ("reference_to_target", "target_to_reference")) else "passed"
        integrity = "critical" if any((d["null_key_rows"] or 0) or (d["duplicate_groups"] or 0) for d in result["key_validation"]) else "not_calculated" if invalid or any(d["percentage"] is None for d in metrics["duplicate_key_rate"]) else "passed"
        out["dimensions"] = [
            {"id":"volume","name":"Volume","status":"passed" if count["equal"] else "attention","description":"Complete scoped counts; a zero difference means equal volumes.","measures":[{"label":"Difference relative to A","percentage":count["percentage_difference"],"numerator":count["absolute_difference"],"denominator":count["reference_count"],"not_evaluated":0,"reason":count["reason"],"lower_is_better":True}]},
            {"id":"keys","name":"Key Coverage","status":key_status,"description":"Directional presence in the selected key sample.","measures":[{"label":label,**keys[d]} for label,d in (("A → B","reference_to_target"),("B → A","target_to_reference"))]},
            {"id":"consistency","name":"Consistency","status":"attention" if row["different_rows"] else observed(row),"description":"Row and column correspondence under the frozen comparison rules.","measures":[{"label":"Row Match Rate",**row}]},
            {"id":"integrity","name":"Integrity","status":integrity,"description":"Full-scope duplicate and null components of the comparison key.","measures":[{"label":f"Source {i+1}",**d,"lower_is_better":True} for i,d in enumerate(metrics["duplicate_key_rate"])]},
            {"id":"compatibility","name":"Technical Compatibility","status":"critical" if blockers else "passed","description":f"{blockers} unpaired or incompatible column pairs. This is a technical diagnostic, not a quality score.","measures":[]},
        ]
        out["diagnostics"] = [
            {"id":"only_target","label":"Missing in source A","count":keys["missing_in_reference"],"scope":"sample","severity":"critical","record_state":"only_target"},
            {"id":"only_source","label":"Missing in source B","count":keys["missing_in_target"],"scope":"sample","severity":"critical","record_state":"only_source"},
            {"id":"content","label":"Different paired records","count":max(0,row["different_rows"]-row["missing_rows"]),"scope":"sample","severity":"attention","record_state":"different"},
            {"id":"unknown","label":"Unclassified row positions","count":row["unknown_rows"],"scope":"sample","severity":"not_calculated","record_state":"unknown"},
            {"id":"duplicates","label":"Duplicate key groups","count":sum(d["duplicate_groups"] or 0 for d in result["key_validation"]),"scope":"entire_selected_scope","severity":"critical","record_state":None},
            {"id":"null_keys","label":"Rows with null key components","count":sum(d["null_key_rows"] or 0 for d in result["key_validation"]),"scope":"entire_selected_scope","severity":"critical","record_state":None},
            {"id":"technical","label":"Unpaired or incompatible columns","count":blockers,"scope":"frozen_metadata","severity":"critical","record_state":None},
        ]
        if not result["summary"].get("alignment_available") or not row["total"]:
            for d in out["diagnostics"]:
                if d["scope"] == "sample": d["count"] = None
        for d, field in ((out["diagnostics"][4],"duplicate_groups"),(out["diagnostics"][5],"null_key_rows")):
            if any(v[field] is None for v in result["key_validation"]): d["count"] = None
        columns=self.columns(result)
        out["result"]={k:result.get(k,{}) for k in ("format_version","execution_id","comparison_options","resolved_scope","sampling_plan","key_validation","summary","warnings")}
        out["result"].update(sources=[{k:v for k,v in source.items() if k!="columns"} for source in result["sources"]],
            metrics={k:v for k,v in metrics.items() if k!="column_match_rate"},column_count=len(columns),
            columns_requiring_review=sum(c["status"]!="passed" for c in columns),
            column_directory=[{k:c[k] for k in ("id","left_column","right_column")} for c in columns])
        return out

    def result(self, run_id):
        _, _, result = self.load(run_id)
        if result is None:
            raise DomainError(409,"result_unavailable","This execution has no completed result.")
        return result

    def filters(self, run_id, result, state="all", column=None, key=None):
        manifest = evidence_state(result)
        if manifest["status"] == "expired":
            raise DomainError(410,"evidence_expired","Record evidence expired after 30 days. Aggregated results remain available.")
        if manifest["status"] not in {"available","partial"}:
            raise DomainError(409,"evidence_not_captured","This execution has no available record evidence.")
        if not self.settings.evidence_encryption_key:
            raise DomainError(503,"evidence_unavailable","The evidence encryption key is unavailable.")
        conditions = [m.run_record_evidence.c.run_id == run_id, m.run_record_evidence.c.expires_at > func.now()]
        if state != "all": conditions.append(m.run_record_evidence.c.state == state)
        if column:
            if column not in {c["id"] for c in self.columns(result)}:
                raise DomainError(422,"validation_error","Unknown column in this execution.")
            conditions.append(m.run_record_evidence.c.affected_columns.contains([column]))
        if key is not None:
            try:
                values = json.loads(key)
                names = result["key_validation"][0]["columns"]
                if not isinstance(values,list) or len(values) != len(names) or any(not isinstance(v,(str,int)) or isinstance(v,bool) for v in values): raise ValueError()
                infos = [result["sources"][0]["columns"][n] for n in names]
                from .core.quality import metadata_family
                values = [base64.b64decode(v,validate=True) if metadata_family(info)=="binary" else v for v,info in zip(values,infos)]
                digest = key_digest(self.settings.evidence_encryption_key,run_id,values,infos)
            except (ValueError,TypeError,KeyError):
                raise DomainError(422,"validation_error","Supply an exact key as a JSON array of strings, in the displayed key order.") from None
            conditions.append(m.run_record_evidence.c.key_digest == digest)
        return conditions

    def records(self, run_id, limit=50, offset=0, state="all", column=None, key=None, detail=False):
        result = self.result(run_id)
        conditions = self.filters(run_id,result,state,column,key)
        with self.engine.connect() as conn:
            total = conn.scalar(select(func.count()).select_from(m.run_record_evidence).where(*conditions))
            rows = conn.execute(select(m.run_record_evidence).where(*conditions).order_by(m.run_record_evidence.c.ordinal).limit(limit).offset(offset)).mappings().all()
        return {"items":[self.public_row(r,detail) for r in rows],"total":total,"limit":limit,"offset":offset}

    def public_row(self, row, detail=False):
        payload = decrypt_row(self.settings.evidence_encryption_key,row)
        return {"id":row["ordinal"],"state":row["state"],"affected_columns":row["affected_columns"],"key":payload["key"],"cells":payload["cells"] if detail else None}

    def record(self, run_id, ordinal):
        conditions = self.filters(run_id,self.result(run_id))
        with self.engine.connect() as conn:
            row = conn.execute(select(m.run_record_evidence).where(*conditions,m.run_record_evidence.c.ordinal == ordinal)).mappings().first()
        if row is None: raise DomainError(404,"not_found","Record evidence not found in this execution.")
        return self.public_row(row,True)
