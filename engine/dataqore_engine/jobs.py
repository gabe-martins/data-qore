"""Fila transacional, snapshots sem segredos e publicação com verificação de estado."""
from contextlib import ExitStack
from datetime import datetime,timezone
from decimal import Decimal
import hashlib
import json
import logging
import secrets
from uuid import UUID

from sqlalchemy import func,select,text

from . import models as m
from .connectors import SourceManager
from .core.comparison_engine import execute_comparison
from .core.sampling import SamplingOptions
from .comparison_options import compact_options, metadata_signature, resolve_scope, validate_options
from .storage import DomainError,Repository,database_engine,json_safe

logger=logging.getLogger("dataqore.worker")


class Queue:
    def __init__(self,engine):
        self.engine=engine
        self.repository=Repository(engine)

    def enqueue(self,kind,target,options=None,key=None):
        if kind != "comparison":raise DomainError(422,"validation_error","Only comparison runs are supported.")
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
                statement=select(table).where(table.c.id==identifier)
                if table is m.comparison_definitions:
                    statement=statement.with_for_update(read=True,key_share=True)
                row=conn.execute(statement).mappings().first()
                if row is None:
                    raise DomainError(404,"not_found","Recurso não encontrado.")
                return dict(row)
            definition=get(m.comparison_definitions,target)
            if not definition["is_active"]:
                raise DomainError(409,"comparison_inactive","Comparison is inactive.")
            identifiers=[definition["left_dataset_id"],definition["right_dataset_id"]]
            parameters={k:definition[k] for k in ("sampling_options","absolute_tolerance","relative_tolerance","comparison_options")}
            parameters["sampling_options"]=dict(parameters["sampling_options"])
            if parameters["sampling_options"].get("seed") is None:
                parameters["sampling_options"]["seed"]=str(secrets.randbits(64))
            # Coordinate frozen comparison sources with dataset deletion, even
            # when the definition changes before the run is inserted.
            datasets={}
            for identifier in sorted(set(identifiers),key=str):
                row=conn.execute(select(m.datasets).where(m.datasets.c.id==identifier)
                    .with_for_update(read=True)).mappings().first()
                if row is None:
                    raise DomainError(404,"not_found","Dataset not found.")
                datasets[identifier]=dict(row)
            sources=[]
            columns=[]
            has_databricks=False
            for identifier in identifiers:
                dataset=datasets[identifier]
                columns.append(dataset["metadata"].get("columns",{}))
                connection=get(m.connections,dataset["connection_id"])
                if not connection["is_active"]:
                    raise DomainError(409,"connection_inactive","Uma conexão está desativada.")
                has_databricks |= connection["connector"]=="databricks"
                sources.append({k:dataset[k] for k in ("connection_id","catalog_name","schema_name","table_name")}|{"dataset_id":identifier})
            parameters["resolved_scope"]=resolve_scope(parameters["comparison_options"],datetime.now(timezone.utc))
            validate_options(parameters["comparison_options"],columns,resolved=parameters["resolved_scope"])
            for source,metadata in zip(sources,columns):source["expected_columns"]=metadata_signature(metadata)
            parameters.update(sources=sources,request_fingerprint=fingerprint)
            parameters["evidence_capture"]={"enabled":True,"retention_days":30,"max_positions":10000,"max_bytes":33554432}
            values={"kind":kind,"comparison_id":target,"parameters":json_safe(parameters),"idempotency_key":key}
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
            run=conn.execute(select(m.runs.c.status,m.runs.c.kind).where(m.runs.c.id==identifier).with_for_update()).mappings().one()
            if run['status']!="running":
                return False
            if str(result["execution_id"])!=str(identifier) or len(result["sources"])!=len(source_ids):
                raise ValueError("Resultado não corresponde à execução.")
            from .schemas import ComparisonResult
            evidence_rows=result.pop("_evidence_rows",[])
            public=json_safe(ComparisonResult.model_validate(result).model_dump())
            conn.execute(m.run_results.insert().values(run_id=identifier,format_version=result["format_version"],
                conclusion=result["summary"]["status"],result=public))
            if evidence_rows:
                expires=result["evidence"]["expires_at"]
                for offset in range(0,len(evidence_rows),100):
                    conn.execute(m.run_record_evidence.insert(),[{**r,"expires_at":datetime.fromisoformat(expires)} for r in evidence_rows[offset:offset+100]])
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
        consistent_comparison=True
        with ExitStack() as stack:
            for frozen in parameters["sources"]:
                row=queue.repository.get(m.connections,UUID(frozen["connection_id"]))
                source=stack.enter_context(manager.session(row,comparison=consistent_comparison,catalog_name=frozen.get("catalog_name","")))
                schema=frozen["schema_name"]
                table=frozen["table_name"]
                tables=source["adapter"].list_tables(source["conn"],schema) if row["connector"]=="databricks" else source["adapter"].list_tables(source["conn"])
                if (schema,table) not in tables:
                    raise DomainError(404,"source_table_not_found","A tabela não está no catálogo atual.")
                selected.append({**source,"schema":schema,"table":table,"dataset_id":frozen["dataset_id"],
                    **({"expected_columns":frozen["expected_columns"]} if "expected_columns" in frozen else {})})
            options=SamplingOptions(**parameters["sampling_options"])
            from .evidence import EvidenceCapture
            frozen_capture=parameters.get("evidence_capture",{})
            capture=EvidenceCapture(settings.evidence_encryption_key if frozen_capture.get("enabled",True) else "",identifier,
                max_bytes=frozen_capture.get("max_bytes",33554432),max_positions=frozen_capture.get("max_positions",10000))
            result=execute_comparison(selected,options=options,evidence_capture=capture,
                absolute_tolerance=Decimal(parameters["absolute_tolerance"]),relative_tolerance=Decimal(parameters["relative_tolerance"]),
                execution_id=identifier,comparison_options=parameters.get("comparison_options"),resolved_scope=parameters.get("resolved_scope"))
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
