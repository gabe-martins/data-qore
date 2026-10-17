"""API interna do motor ADQ. Não executa migrations nem cálculos em requisições."""
from contextlib import asynccontextmanager
from datetime import datetime,timedelta,timezone
import hmac
from typing import Annotated
from uuid import UUID,uuid4

from fastapi import APIRouter,Depends,FastAPI,Header,Query,Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader
from sqlalchemy import select,text
from sqlalchemy.exc import DBAPIError,IntegrityError
from pydantic import ValidationError

from . import models as m
from . import schemas as s
from .connectors import SourceManager
from .jobs import Queue
from .settings import load_settings
from .storage import DomainError,Repository,database_engine,json_safe

Limit=Annotated[int,Query(ge=1,le=200)]
Offset=Annotated[int,Query(ge=0)]
IdempotencyKey=Annotated[str | None,Header(alias="Idempotency-Key",min_length=1,max_length=200)]


def create_app(settings=None):
    settings=settings or load_settings()
    engine=database_engine(settings)
    repository=Repository(engine)
    sources=SourceManager(settings)
    queue=Queue(engine)

    @asynccontextmanager
    async def lifespan(app):
        yield
        engine.dispose()

    app=FastAPI(title="DataQore — ADQ Engine",version="1.0.0",lifespan=lifespan,
        description="API interna de Advanced Data Quality. Requer X-API-Key em /v1.")
    app.state.settings=settings
    app.state.engine=engine
    security=APIKeyHeader(name="X-API-Key",auto_error=False)

    def authorize(key=Depends(security)):
        if key is None or not hmac.compare_digest(key.encode(),settings.api_key.encode()):
            raise DomainError(401,"unauthorized","API key interna ausente ou inválida.")

    def error_response(request,status,code,message):
        return JSONResponse(status_code=status,content={"code":code,"message":message,
            "request_id":getattr(request.state,"request_id",None)})

    @app.middleware("http")
    async def safe_boundary(request,call_next):
        request.state.request_id=str(uuid4())
        try:
            response=await call_next(request)
        except Exception:
            response=error_response(request,500,"internal_error","Falha interna ao processar a solicitação.")
        response.headers["X-Request-ID"]=request.state.request_id
        return response

    @app.exception_handler(DomainError)
    async def domain_error(request,error):
        return error_response(request,error.status,error.code,error.message)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request,error):
        # Não devolver error.errors(): inclui inputs e, potencialmente, senhas.
        return error_response(request,422,"validation_error","Payload ou parâmetros inválidos; consulte o contrato OpenAPI.")

    @app.exception_handler(IntegrityError)
    async def integrity_error(request,error):
        return error_response(request,409,"resource_conflict","Recurso duplicado ou referências em conflito.")

    @app.exception_handler(DBAPIError)
    async def database_error(request,error):
        return error_response(request,503,"storage_unavailable","Armazenamento do motor indisponível.")

    @app.get("/health/live",tags=["health"])
    def live():
        return {"status":"ok"}

    @app.get("/health/ready",tags=["health"])
    def ready():
        with engine.connect() as conn:
            if conn.scalar(text("SELECT current_user"))!="srv_dataqore_engine":
                raise DomainError(503,"runtime_role_invalid","A conta de execução precisa ser restrita ao motor.")
            conn.execute(select(m.connections.c.id).limit(0))
        return {"status":"ok"}

    router=APIRouter(prefix="/v1",dependencies=[Depends(authorize)],responses={
        code:{"model":s.ErrorOut} for code in (401,404,409,422,503)})

    def out(model,row):
        return model.model_validate({k:row[k] for k in model.model_fields if k in row})

    def page(model,table,limit,offset,*conditions,order=None):
        result=repository.page(table,limit,offset,*conditions,order=order)
        result["items"]=[out(model,row) for row in result["items"]]
        return result

    @router.get("/connectors",response_model=list[s.ConnectorOut],tags=["connections"])
    def connectors():
        return sources.available()

    @router.post("/connections/test",response_model=s.TestOut,tags=["connections"])
    def test_configuration(payload:s.ConnectionTest):
        row={"name":"test","connector":payload.connector,"is_active":True,
            "credentials_ciphertext":sources.encrypt(payload.connector,payload.credentials),
            "encryption_key_version":settings.encryption_key_version}
        return sources.test(row)

    @router.post("/connections",response_model=s.ConnectionOut,status_code=201,tags=["connections"])
    def create_connection(payload:s.ConnectionCreate):
        row=repository.add(m.connections,{"name":payload.name,"connector":payload.connector,
            "credentials_ciphertext":sources.encrypt(payload.connector,payload.credentials),
            "encryption_key_version":settings.encryption_key_version})
        return out(s.ConnectionOut,row)

    @router.get("/connections",response_model=s.Page[s.ConnectionOut],tags=["connections"])
    def list_connections(limit:Limit=50,offset:Offset=0):
        return page(s.ConnectionOut,m.connections,limit,offset)

    @router.get("/connections/{identifier}",response_model=s.ConnectionOut,tags=["connections"])
    def get_connection(identifier:UUID):
        return out(s.ConnectionOut,repository.get(m.connections,identifier))

    @router.patch("/connections/{identifier}",response_model=s.ConnectionOut,tags=["connections"])
    def update_connection(identifier:UUID,payload:s.ConnectionUpdate):
        row=repository.get(m.connections,identifier)
        values=payload.model_dump(exclude_unset=True,exclude={"credentials"})
        if payload.credentials is not None:
            try:
                values.update(credentials_ciphertext=sources.encrypt(row["connector"],payload.credentials),
                    encryption_key_version=settings.encryption_key_version)
            except ValidationError:
                raise DomainError(422,"validation_error","Credenciais incompletas para o conector selecionado.") from None
        values["updated_at"]=datetime.now(timezone.utc)
        return out(s.ConnectionOut,repository.update(m.connections,identifier,values))

    @router.post("/connections/{identifier}/test",response_model=s.TestOut,tags=["connections"])
    def test_connection(identifier:UUID):
        return sources.test(repository.get(m.connections,identifier))

    def catalog_page(identifier,limit,offset,schema=None):
        tables=sources.catalog(repository.get(m.connections,identifier))
        items=[{"schema_name":sch,"table_name":table} for sch,table in tables if schema is None or sch==schema]
        return {"items":items[offset:offset+limit],"total":len(items),"limit":limit,"offset":offset}

    @router.get("/connections/{identifier}/schemas",response_model=s.Page[str],tags=["catalog"])
    def list_schemas(identifier:UUID,limit:Limit=50,offset:Offset=0):
        names=sorted({schema for schema,_ in sources.catalog(repository.get(m.connections,identifier))})
        return {"items":names[offset:offset+limit],"total":len(names),"limit":limit,"offset":offset}

    @router.get("/connections/{identifier}/tables",response_model=s.Page[s.TableOut],tags=["catalog"])
    def list_tables(identifier:UUID,limit:Limit=50,offset:Offset=0,schema:str | None=None):
        return catalog_page(identifier,limit,offset,schema)

    @router.post("/datasets",response_model=s.DatasetOut,status_code=201,tags=["datasets"])
    def create_dataset(payload:s.DatasetCreate):
        row=repository.get(m.connections,payload.connection_id)
        schema,metadata=sources.table_metadata(row,payload.schema_name,payload.table_name)
        return repository.add(m.datasets,{"connection_id":payload.connection_id,"schema_name":schema,
            "table_name":payload.table_name,"metadata":json_safe(metadata)})

    @router.get("/datasets",response_model=s.Page[s.DatasetOut],tags=["datasets"])
    def list_datasets(limit:Limit=50,offset:Offset=0,connection_id:UUID | None=None):
        conditions=[m.datasets.c.connection_id==connection_id] if connection_id else []
        return page(s.DatasetOut,m.datasets,limit,offset,*conditions)

    @router.get("/datasets/{identifier}",response_model=s.DatasetOut,tags=["datasets"])
    def get_dataset(identifier:UUID):
        return repository.get(m.datasets,identifier)

    @router.post("/datasets/{identifier}/refresh",response_model=s.DatasetOut,tags=["datasets"])
    def refresh_dataset(identifier:UUID):
        dataset=repository.get(m.datasets,identifier)
        row=repository.get(m.connections,dataset["connection_id"])
        _,metadata=sources.table_metadata(row,dataset["schema_name"],dataset["table_name"])
        return repository.update(m.datasets,identifier,{"metadata":json_safe(metadata),"discovered_at":datetime.now(timezone.utc)})

    @router.post("/datasets/{identifier}/profile-runs",response_model=s.RunOut,status_code=202,tags=["runs"])
    def profile_run(identifier:UUID,payload:s.ProfileRequest=s.ProfileRequest(),idempotency_key:IdempotencyKey=None):
        return out(s.RunOut,queue.enqueue("profile",identifier,payload.model_dump(),idempotency_key))

    @router.get("/datasets/{identifier}/profiles",response_model=s.Page[s.ProfileOut],tags=["datasets"])
    def profiles(identifier:UUID,limit:Limit=50,offset:Offset=0,run_id:UUID | None=None):
        repository.get(m.datasets,identifier)
        conditions=[m.column_profiles.c.dataset_id==identifier]
        if run_id:
            conditions.append(m.column_profiles.c.run_id==run_id)
        return page(s.ProfileOut,m.column_profiles,limit,offset,*conditions,
            order=[m.column_profiles.c.created_at.desc(),m.column_profiles.c.id])

    def validate_comparison(values,require_active=True):
        for name in ("left_dataset_id","right_dataset_id"):
            dataset=repository.get(m.datasets,values[name])
            if require_active and not repository.get(m.connections,dataset["connection_id"])["is_active"]:
                raise DomainError(409,"connection_inactive","Uma conexão está desativada.")

    @router.post("/comparisons",response_model=s.ComparisonOut,status_code=201,tags=["comparisons"])
    def create_comparison(payload:s.ComparisonCreate):
        values=payload.model_dump()
        validate_comparison(values)
        return repository.add(m.comparison_definitions,values)

    @router.get("/comparisons",response_model=s.Page[s.ComparisonOut],tags=["comparisons"])
    def list_comparisons(limit:Limit=50,offset:Offset=0):
        return page(s.ComparisonOut,m.comparison_definitions,limit,offset)

    @router.get("/comparisons/{identifier}",response_model=s.ComparisonOut,tags=["comparisons"])
    def get_comparison(identifier:UUID):
        return repository.get(m.comparison_definitions,identifier)

    @router.patch("/comparisons/{identifier}",response_model=s.ComparisonOut,tags=["comparisons"])
    def update_comparison(identifier:UUID,payload:s.ComparisonUpdate):
        row=repository.get(m.comparison_definitions,identifier)
        merged={k:row[k] for k in s.ComparisonCreate.model_fields}
        merged.update(payload.model_dump(exclude_unset=True,exclude={"is_active"}))
        try:
            values=s.ComparisonCreate.model_validate(merged).model_dump()
        except ValidationError:
            raise DomainError(422,"validation_error","Definição de comparação inválida.") from None
        validate_comparison(values,require_active=payload.is_active if payload.is_active is not None else row["is_active"])
        if payload.is_active is not None:
            values["is_active"]=payload.is_active
        values["updated_at"]=datetime.now(timezone.utc)
        return repository.update(m.comparison_definitions,identifier,values)

    @router.post("/comparisons/{identifier}/runs",response_model=s.RunOut,status_code=202,tags=["runs"])
    def comparison_run(identifier:UUID,idempotency_key:IdempotencyKey=None):
        return out(s.RunOut,queue.enqueue("comparison",identifier,key=idempotency_key))

    @router.get("/runs",response_model=s.Page[s.RunOut],tags=["runs"])
    def list_runs(limit:Limit=50,offset:Offset=0,comparison_id:UUID | None=None,dataset_id:UUID | None=None,
        status:Annotated[str | None,Query(pattern="^(queued|running|succeeded|failed)$")]=None):
        conditions=[]
        for column,value in ((m.runs.c.comparison_id,comparison_id),(m.runs.c.dataset_id,dataset_id),(m.runs.c.status,status)):
            if value is not None:
                conditions.append(column==value)
        return page(s.RunOut,m.runs,limit,offset,*conditions,order=[m.runs.c.requested_at.desc(),m.runs.c.id])

    @router.get("/runs/{identifier}",response_model=s.RunOut,tags=["runs"])
    def get_run(identifier:UUID):
        return out(s.RunOut,repository.get(m.runs,identifier))

    @router.get("/runs/{identifier}/result",response_model=s.ResultOut,tags=["runs"])
    def get_result(identifier:UUID):
        run=repository.get(m.runs,identifier)
        if run["status"]!="succeeded":
            raise DomainError(409,"result_unavailable","A execução ainda não possui resultado concluído.")
        with engine.connect() as conn:
            row=conn.execute(select(m.run_results).where(m.run_results.c.run_id==identifier)).mappings().first()
        if row is None:
            raise DomainError(404,"result_not_found","Resultado não encontrado.")
        return dict(row)

    @router.get("/metrics",response_model=s.Page[s.MetricOut],tags=["metrics"])
    def metrics(dataset_id:UUID,limit:Limit=50,offset:Offset=0,column_name:str | None=None,
        metric_name:str | None=None,from_time:datetime | None=None,to_time:datetime | None=None):
        repository.get(m.datasets,dataset_id)
        end=to_time or datetime.now(timezone.utc)
        start=from_time or end-timedelta(days=30)
        if start.tzinfo is None or end.tzinfo is None or start>=end:
            raise DomainError(422,"invalid_period","Informe um período crescente com timezone explícito.")
        conditions=[m.metrics.c.dataset_id==dataset_id,m.metrics.c.measured_at>=start,m.metrics.c.measured_at<end]
        if column_name is not None:
            conditions.append(m.metrics.c.column_name==column_name)
        if metric_name is not None:
            conditions.append(m.metrics.c.metric_name==metric_name)
        return page(s.MetricOut,m.metrics,limit,offset,*conditions,order=[m.metrics.c.measured_at.desc(),m.metrics.c.id])

    app.include_router(router)
    return app
