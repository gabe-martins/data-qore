"""Perfil independente de uma fonte usando as mesmas estatísticas do motor v4."""
from datetime import datetime,timezone
from uuid import uuid4

from .assessment import combine_quality,unaligned_agreement
from .comparison_engine import _capture,quality_findings
from .quality import name_map,profile_rows
from .query_audit import RecordingConnection
from .sampling import SamplingOptions,pilot_size,plan_sample


def execute_profile(selected,options=None,sample_size=None,execution_id=None):
    options=options or SamplingOptions()
    started=datetime.now(timezone.utc).isoformat()
    events=[]
    source={**selected,"conn":RecordingConnection(selected["conn"],events)}
    columns=source["adapter"].metadata(source["conn"],source["schema"],source["table"])
    if not columns:
        raise ValueError("Metadados indisponíveis para o perfil.")
    source.update(columns=columns,names=name_map(columns),query_log=events,
        estimated_rows=source["adapter"].estimate_rows(source["conn"],source["schema"],source["table"]))
    initial=pilot_size([source],options,sample_size)
    pilot=_capture(source,initial)
    plan=plan_sample([source],[pilot],options,"independent_random",[],None,sample_size)
    target=plan["target_rows"]
    if target>initial and pilot["sample_size"]==initial:
        profile=_capture(source,target)
        plan["rounds"].append({"stage":"expanded","requested_rows_per_source":target,
            "observed_rows":[profile["sample_size"]],"note":"fresh draw replaces pilot"})
    else:
        profile=profile_rows(columns,pilot["sample_columns"],pilot["sample_rows"][:target])
    plan.update(actual_rows=[profile["sample_size"]],metric_scope="single table observed sample",
        selection="independent random sample")
    plan["strategy_reason"]=plan["strategy_reason"].replace("both pilot reads exhausted their tables","pilot read exhausted the table")
    public={k:v for k,v in profile.items() if k not in {"sample_rows","sample_columns"}}
    public.update(connection=source["connection"],database_type=source["creds"]["type"],
        catalog_name=source.get("catalog_name",""),schema=source["schema"],table_name=source["table"],
        table=".".join(p for p in (source.get("catalog_name",""),source["schema"],source["table"]) if p),estimated_rows=source["estimated_rows"])
    if source["creds"]["type"]=='databricks':
        public['table_details']=source['adapter'].table_details(source['conn'],source['schema'],source['table'])
    finished=datetime.now(timezone.utc).isoformat()
    return {"format_version":4,"engine_version":"4.0","execution_id":str(execution_id or uuid4()),
        "started_at":started,"finished_at":finished,"created_at":finished,
        "sample_size":target,"sampling_plan":plan,"sources":[public],
        "summary":{"status":"profile_only" if profile["sample_size"] else "inconclusive","scope":"sample"},
        "indicators":{"method_version":1,"agreement":unaligned_agreement(),"quality":combine_quality([profile])},
        "schema_findings":[],"quality_findings":quality_findings([profile]),
        "row_comparisons":[],"metric_comparisons":[],"value_distributions":[],
        "query_log":[{"source":1,**event} for event in events],
        "warnings":["Perfil amostral descritivo; não representa toda a população.",
            "A ordenação aleatória pode percorrer a tabela inteira; o limite de linhas não limita esse custo."] + (["Databricks uses best-effort reads; separate statements do not share a guaranteed snapshot."] if source["creds"]["type"]=="databricks" else [])}
