"""Fila transacional, snapshots sem segredos e publicação com verificação de estado."""
from contextlib import ExitStack
from datetime import datetime,timezone
from decimal import Decimal
import hashlib
import json
import logging
from uuid import UUID

from sqlalchemy import func,select,text

from . import models as m
from .connectors import SourceManager
from .core.comparison_engine import execute_comparison
from .core.profile_engine import execute_profile
from .core.sampling import SamplingOptions
from .comparison_options import compact_options, metadata_signature, resolve_scope, validate_options
from .storage import DomainError,Repository,database_engine,json_safe

logger=logging.getLogger("dataqore.worker")


class Queue:
    def __init__(self,engine):
        self.engine=engine
        self.repository=Repository(engine)

    def enqueue(self,kind,target,options=None,key=None):
        request={"kind":kind,"target":str(target),"options":json_safe(options or {})}
        fingerprint=hashlib.sha256(json.dumps(request,sort_keys=True,separators=(",",":")).encode()).hexdigest()
        with self.engine.begin() as conn:
            if key is not None:
                lock=int.from_bytes(hashlib.sha256(key.encode()).digest()[:8],signed=True)
                conn.execute(text("SELECT pg_advisory_xact_lock(:key)"),{"key":lock})
                old=conn.execute(select(m.runs).where(m.runs.c.idempotency_key==key)).mappings().first()
                if old:
                    if old["parameters"].get("request_fingerprint")!=fingerprint:
                        raise DomainError(409,"idempotency_conflict","A chave já foi usada para outra solicitação.")
                    return dict(old)
            def get(table,identifier):
                row=conn.execute(select(table).where(table.c.id==identifier)).mappings().first()
                if row is None:
                    raise DomainError(404,"not_found","Recurso não encontrado.")
                return dict(row)
            if kind=="comparison":
                definition=get(m.comparison_definitions,target)
                if not definition["is_active"]:
                    raise DomainError(409,"comparison_inactive","A comparação está desativada.")
                identifiers=[definition["left_dataset_id"],definition["right_dataset_id"]]
                parameters={k:definition[k] for k in ("mode","sampling_options","sample_size","absolute_tolerance","relative_tolerance","comparison_options")}
            else:
                identifiers=[target]
                parameters=dict(options)
            sources=[]
            columns=[]
            for identifier in identifiers:
                dataset=get(m.datasets,identifier)
                columns.append(dataset["metadata"].get("columns",{}))
                connection=get(m.connections,dataset["connection_id"])
                if not connection["is_active"]:
                    raise DomainError(409,"connection_inactive","Uma conexão está desativada.")
                sources.append({k:dataset[k] for k in ("connection_id","schema_name","table_name")}|{"dataset_id":identifier})
            if kind=="comparison" and compact_options(parameters["comparison_options"]):
                at=datetime.now(timezone.utc)
                parameters["resolved_scope"]=resolve_scope(parameters["comparison_options"],at)
                validate_options(parameters["comparison_options"],columns,parameters["mode"],parameters["resolved_scope"])
                for source,metadata in zip(sources,columns):
                    source["expected_columns"]=metadata_signature(metadata)
            parameters.update(sources=sources,request_fingerprint=fingerprint)
            values={"kind":kind,"comparison_id":target if kind=="comparison" else None,
                "dataset_id":target if kind=="profile" else None,"parameters":json_safe(parameters),"idempotency_key":key}
            return dict(conn.execute(m.runs.insert().values(**values).returning(m.runs)).mappings().one())

    def claim(self):
        with self.engine.begin() as conn:
            row=conn.execute(select(m.runs.c.id).where(m.runs.c.status=="queued")
                .order_by(m.runs.c.requested_at,m.runs.c.id).with_for_update(skip_locked=True).limit(1)).first()
            if row is None:
                return None
            return conn.execute(m.runs.update().where(m.runs.c.id==row.id)
                .values(status="running",started_at=func.now(),heartbeat_at=func.now()).returning(m.runs.c.id)).scalar_one()

    def heartbeat(self,identifier):
        with self.engine.begin() as conn:
            conn.execute(m.runs.update().where(m.runs.c.id==identifier,m.runs.c.status=="running").values(heartbeat_at=func.now()))

    def fail(self,identifier,code):
        with self.engine.begin() as conn:
            conn.execute(m.runs.update().where(m.runs.c.id==identifier,m.runs.c.status=="running")
                .values(status="failed",finished_at=func.now(),error_code=code,
                    error_message="A execução não foi concluída. Consulte o código da falha e a configuração da fonte."))

    def recover_interrupted(self):
        with self.engine.begin() as conn:
            return conn.execute(m.runs.update().where(m.runs.c.status=="running")
                .values(status="failed",finished_at=func.now(),error_code="worker_interrupted",
                    error_message="Execução interrompida antes da conclusão; não foi repetida automaticamente.")).rowcount

    def publish(self,identifier,result,source_ids):
        # Todos os inserts e o estado final são confirmados juntos.
        with self.engine.begin() as conn:
            status=conn.execute(select(m.runs.c.status).where(m.runs.c.id==identifier).with_for_update()).scalar_one()
            if status!="running":
                return False
            if str(result["execution_id"])!=str(identifier) or len(result["sources"])!=len(source_ids):
                raise ValueError("Resultado não corresponde à execução.")
            public=json_safe(result)
            measured=datetime.fromisoformat(result["finished_at"])
            conn.execute(m.run_results.insert().values(run_id=identifier,format_version=result["format_version"],
                conclusion=result["summary"]["status"],result=public))
            profiles,series=[],[]
            for dataset_id,source in zip(source_ids,result["sources"]):
                for column,metric in source["metrics"].items():
                    profiles.append({"run_id":identifier,"dataset_id":dataset_id,"column_name":column,
                        "profile":json_safe({"metadata":source["columns"][column],"metrics":metric,
                            "sample_size":source["sample_size"],
                            "sampling_scope":"sample within frozen scope" if result.get("resolved_scope") else "all rows obtained for this source",
                            **({"resolved_scope":result["resolved_scope"]} if result.get("resolved_scope") else {})})})
                    for name,value in metric.items():
                        if isinstance(value,bool) or value is not None and not isinstance(value,(int,float,Decimal)):
                            continue
                        # NULL só é série quando é uma métrica numérica conhecida.
                        if value is None and name not in {"min","max","mean","median","q25","q75","stddev","null_rate","blank_rate","distinct_rate","duplicate_rate"}:
                            continue
                        number=Decimal(str(value)) if value is not None else None
                        if number is not None and not number.is_finite():
                            number=None
                        denominator={"null_rate":"null_denominator","blank_rate":"blank_denominator",
                            "distinct_rate":"distinct_denominator","duplicate_rate":"distinct_denominator"}.get(name)
                        series.append({"measured_at":measured,"run_id":identifier,"dataset_id":dataset_id,
                            "column_name":column,"metric_name":name,"value":number,
                            "evaluated_count":metric.get(denominator) if denominator else None,
                            "applicable_count":metric.get(denominator) if denominator else None})
            for table,rows in ((m.column_profiles,profiles),(m.metrics,series)):
                for offset in range(0,len(rows),500):
                    conn.execute(table.insert(),rows[offset:offset+500])
            conn.execute(m.runs.update().where(m.runs.c.id==identifier)
                .values(status="succeeded",finished_at=func.now(),heartbeat_at=func.now(),error_code=None,error_message=None))
            return True


def run_job(settings,identifier):
    """Entrada do subprocesso: nenhuma amostra ou credencial passa por IPC."""
    engine=database_engine(settings)
    queue=Queue(engine)
    try:
        run=queue.repository.get(m.runs,identifier)
        if run["status"]!="running":
            return
        parameters=run["parameters"]
        manager=SourceManager(settings)
        selected=[]
        with ExitStack() as stack:
            for frozen in parameters["sources"]:
                row=queue.repository.get(m.connections,UUID(frozen["connection_id"]))
                source=stack.enter_context(manager.session(row,comparison=run["kind"]=="comparison" and bool(compact_options(parameters.get("comparison_options")))))
                schema=frozen["schema_name"]
                table=frozen["table_name"]
                if (schema,table) not in source["adapter"].list_tables(source["conn"]):
                    raise DomainError(404,"source_table_not_found","A tabela não está no catálogo atual.")
                selected.append({**source,"schema":schema,"table":table,
                    **({"expected_columns":frozen["expected_columns"]} if "expected_columns" in frozen else {})})
            options=SamplingOptions(**parameters["sampling_options"])
            if run["kind"]=="comparison":
                result=execute_comparison(selected,mode=parameters["mode"],options=options,
                    sample_size=parameters.get("sample_size"),absolute_tolerance=Decimal(parameters["absolute_tolerance"]),
                    relative_tolerance=Decimal(parameters["relative_tolerance"]),preview_limit=0,execution_id=identifier,
                    comparison_options=parameters.get("comparison_options"),resolved_scope=parameters.get("resolved_scope"))
            else:
                result=execute_profile(selected[0],options=options,sample_size=parameters.get("sample_size"),execution_id=identifier)
        queue.publish(identifier,result,[UUID(s["dataset_id"]) for s in parameters["sources"]])
    except Exception as error:
        code=error.code if isinstance(error,DomainError) else "execution_failed"
        # Não usar logger.exception: drivers podem incluir valores privados nas mensagens.
        logger.error("run_failed run_id=%s code=%s",identifier,code)
        try:
            queue.fail(identifier,code)
        except Exception:
            logger.error("run_failure_not_persisted run_id=%s",identifier)
    finally:
        engine.dispose()
