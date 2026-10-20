"""Contratos públicos da API; credenciais aparecem somente em entradas."""
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Generic, Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator
from .comparison_options import ComparisonOptions


class Model(BaseModel):
    model_config=ConfigDict(extra="forbid",hide_input_in_errors=True)


Name=Annotated[str,Field(min_length=1,max_length=255,pattern=r"\S")]
Connector=Literal["postgresql","mysql","mssql","oracle","sqlite","databricks"]
Mode=Literal["auto","matched_keys","independent_random"]


class Credentials(Model):
    database: Annotated[str,Field(min_length=1,max_length=4096)]
    hostname: Annotated[str,Field(min_length=1,max_length=255)] | None=None
    port: Annotated[int,Field(strict=True,ge=1,le=65535)] | None=None
    username: Annotated[str,Field(min_length=1,max_length=255)] | None=None
    password: SecretStr | None=None
    sslmode: Literal["disable","allow","prefer","require","verify-ca","verify-full"]="prefer"
    trust_server_certificate: bool=False


class DatabricksCredentials(Model):
    hostname: Annotated[str,Field(min_length=1,max_length=255,pattern=r"^[A-Za-z0-9][A-Za-z0-9.-]*$")]
    http_path: Annotated[str,Field(pattern=r"^/sql/1\.0/warehouses/[A-Za-z0-9-]+$",max_length=255)]
    auth_type: Literal["pat","oauth_m2m"]
    access_token: SecretStr | None=None
    client_id: Annotated[str,Field(min_length=1,max_length=255)] | None=None
    client_secret: SecretStr | None=None

    @model_validator(mode="after")
    def authentication(self):
        if self.auth_type=="pat":
            if not self.access_token or not self.access_token.get_secret_value().strip() or self.client_id is not None or self.client_secret is not None:
                raise ValueError("PAT requires only access_token")
        elif not self.client_id or not self.client_secret or not self.client_secret.get_secret_value().strip() or self.access_token is not None:
            raise ValueError("OAuth M2M requires client_id and client_secret")
        return self


class ConnectionTest(Model):
    connector: Connector
    credentials: Credentials | DatabricksCredentials

    @model_validator(mode="after")
    def network_fields(self):
        if self.connector == "databricks":
            if not isinstance(self.credentials,DatabricksCredentials):raise ValueError("Invalid Databricks credentials")
            return self
        if not isinstance(self.credentials,Credentials):raise ValueError("Invalid database credentials")
        if self.connector != "sqlite" and any(getattr(self.credentials,key) is None for key in ("hostname","username","password")):
            raise ValueError("Fontes de rede exigem hostname, username e password.")
        return self


class ConnectionCreate(ConnectionTest):
    name: Name


class ConnectionUpdate(Model):
    name: Name | None=None
    credentials: Credentials | DatabricksCredentials | None=None
    is_active: bool | None=None

    @model_validator(mode="after")
    def nonempty(self):
        if not self.model_fields_set or any(getattr(self,k) is None for k in self.model_fields_set):
            raise ValueError("Informe ao menos um campo com valor.")
        return self


class ConnectionOut(Model):
    dataset_count: int=0
    id: UUID
    name: str
    connector: Connector
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ConnectorOut(Model):
    connector: Connector
    driver: str
    available: bool


class TestOut(Model):
    status: Literal["ok"]="ok"


class TableOut(Model):
    catalog_name: str=""
    table_type: str="table"
    schema_name: str
    table_name: str


class DatasetCreate(Model):
    catalog_name: Annotated[str,Field(max_length=255)]=""
    connection_id: UUID
    schema_name: str=""
    table_name: Annotated[str,Field(min_length=1,max_length=255)]


class DatasetOut(DatasetCreate):
    id: UUID
    metadata: dict[str,Any]
    discovered_at: datetime


class Sampling(Model):
    pilot_rows: Annotated[int,Field(strict=True,ge=1,le=10000)]=64
    min_rows: Annotated[int,Field(strict=True,ge=1,le=10000)]=64
    max_rows: Annotated[int,Field(strict=True,ge=1,le=10000)]=1000
    max_cells: Annotated[int,Field(strict=True,ge=1)]=100000
    max_sample_bytes: Annotated[int,Field(strict=True,ge=1)]=16777216
    proportion_margin: Annotated[float,Field(gt=0,lt=1,allow_inf_nan=False)]=0.05
    seed: Annotated[int,Field(strict=True,ge=0,le=2**64-1)] | None=None


class ProfileRequest(Model):
    sampling_options: Sampling=Field(default_factory=Sampling)
    sample_size: Annotated[int,Field(strict=True,ge=1,le=10000)] | None=None

    @model_validator(mode="after")
    def sample_budget(self):
        if self.sample_size and self.sample_size>self.sampling_options.max_rows:
            raise ValueError("sample_size excede max_rows.")
        return self


class ComparisonCreate(ProfileRequest):
    name: Name
    left_dataset_id: UUID
    right_dataset_id: UUID
    mode: Mode="auto"
    absolute_tolerance: Annotated[Decimal,Field(ge=0,allow_inf_nan=False)]=Decimal(0)
    relative_tolerance: Annotated[Decimal,Field(ge=0,allow_inf_nan=False)]=Decimal(0)
    comparison_options: ComparisonOptions=Field(default_factory=ComparisonOptions)

    @model_validator(mode="after")
    def distinct_sources(self):
        if self.left_dataset_id==self.right_dataset_id:
            raise ValueError("Selecione dois datasets distintos.")
        if self.mode=="independent_random" and self.comparison_options.business_key:
            raise ValueError("Business keys require key alignment.")
        return self


class ComparisonOut(ComparisonCreate):
    id: UUID
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ComparisonUpdate(Model):
    name: Name | None=None
    left_dataset_id: UUID | None=None
    right_dataset_id: UUID | None=None
    mode: Mode | None=None
    sampling_options: Sampling | None=None
    sample_size: Annotated[int,Field(strict=True,ge=1,le=10000)] | None=None
    absolute_tolerance: Annotated[Decimal,Field(ge=0,allow_inf_nan=False)] | None=None
    relative_tolerance: Annotated[Decimal,Field(ge=0,allow_inf_nan=False)] | None=None
    is_active: bool | None=None
    comparison_options: ComparisonOptions | None=None

    @model_validator(mode="after")
    def nonempty(self):
        if not self.model_fields_set or any(getattr(self,k) is None for k in self.model_fields_set if k!="sample_size"):
            raise ValueError("Informe campos válidos para atualização.")
        return self


class ComparisonPreviewOut(Model):
    mapping: list[dict[str,str]]
    unmatched_columns: dict[str,list[str]]
    business_key: list[dict[str,str]]
    resolved_scope: dict[str,Any]
    key_validation: str


class RunOut(Model):
    id: UUID
    kind: Literal["comparison","profile"]
    comparison_id: UUID | None
    dataset_id: UUID | None
    status: Literal["queued","running","succeeded","failed"]
    parameters: dict[str,Any]
    requested_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    heartbeat_at: datetime | None
    error_code: str | None
    error_message: str | None


class ResultOut(Model):
    run_id: UUID
    format_version: int
    conclusion: Literal["compatible_in_sample","difference_observed","profile_only","inconclusive"]
    result: dict[str,Any]
    created_at: datetime


class ProfileOut(Model):
    id: UUID
    run_id: UUID
    dataset_id: UUID
    column_name: str
    profile: dict[str,Any]
    created_at: datetime


class MetricOut(Model):
    id: UUID
    measured_at: datetime
    run_id: UUID
    dataset_id: UUID
    column_name: str | None
    metric_name: str
    value: Decimal | None
    evaluated_count: int | None
    applicable_count: int | None


T=TypeVar("T")
class Page(Model,Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class ConnectionDatasetReference(Model):
    id: UUID
    catalog_name: str
    schema_name: str
    table_name: str
    table_type: str | None = None


class ConnectionComparisonReference(Model):
    id: UUID
    name: str
    is_active: bool
    left_dataset_id: UUID
    right_dataset_id: UUID


class ConnectionDependenciesOut(Model):
    connection_id: UUID
    datasets: Page[ConnectionDatasetReference]
    comparisons: Page[ConnectionComparisonReference]
    can_delete: bool


class ConnectionDeletedOut(Model):
    id: UUID
    status: Literal["deleted"] = "deleted"


class DatasetDeletionReference(ConnectionDatasetReference):
    connection_id: UUID
    connection_name: str


class DatasetComparisonReference(Model):
    id: UUID
    name: str
    is_active: bool
    current: bool
    historical: bool


class ProfileHistoryCounts(Model):
    runs: int
    results: int
    column_profiles: int
    metrics: int


class DatasetDependenciesOut(Model):
    dataset: DatasetDeletionReference
    comparisons: Page[DatasetComparisonReference]
    profile_history: ProfileHistoryCounts
    active_profile_runs: int
    block_reasons: list[Literal["dataset_in_use", "dataset_busy"]]
    can_delete: bool


class DatasetDeletedOut(Model):
    id: UUID
    status: Literal["deleted"] = "deleted"


class ComparisonDeletionReference(Model):
    id: UUID
    name: str
    is_active: bool


class ComparisonHistoryCounts(Model):
    runs: int
    results: int
    column_profiles: int
    metrics: int


class ComparisonDependenciesOut(Model):
    comparison: ComparisonDeletionReference
    history: ComparisonHistoryCounts
    active_runs: int
    can_delete: bool


class ComparisonDeletedOut(Model):
    id: UUID
    status: Literal["deleted"] = "deleted"


class ErrorOut(Model):
    code: str
    message: str
    request_id: UUID | None=None

class IndicatorOut(Model):
    passed:int
    evaluated:int
    total:int
    percentage:str | None
    coverage_percentage:str | None


class LatestRunOut(Model):
    id:UUID
    status:str
    requested_at:datetime
    finished_at:datetime | None
    error_code:str | None


class LatestResultOut(Model):
    run_id:UUID
    conclusion:str
    finished_at:datetime
    agreement:dict[str,Any] | None
    quality:dict[str,Any] | None


class ComparisonSummaryOut(ComparisonOut):
    latest_run:LatestRunOut | None
    latest_result:LatestResultOut | None


class TrendOut(IndicatorOut):
    day:str


class DailyQualityPoint(TrendOut):
    run_id:UUID | None
    status:Literal["succeeded","failed"] | None
    finished_at:datetime | None
    conclusion:str | None=None


class ComparisonQualitySeries(Model):
    comparison_id:UUID
    name:str
    points:list[DailyQualityPoint]


class LinearTrendPoint(Model):
    day:str
    percentage:str | None


class QualityTrendOut(Model):
    days:Literal[7,15,30]
    timezone:str
    start_day:str
    end_day:str
    as_of:datetime
    series:list[ComparisonQualitySeries]
    metric:Literal['sample_quality','agreement']='sample_quality'
    overall:list[TrendOut]=[]
    linear_trend:list[LinearTrendPoint]=[]
    regression_observations:int=0


class RecentRunOut(Model):
    id:UUID
    kind:str
    status:str
    comparison_id:UUID | None
    dataset_id:UUID | None
    requested_at:datetime
    started_at:datetime | None
    finished_at:datetime | None
    error_code:str | None
    name:str | None
    conclusion:str | None
    agreement:dict[str,Any] | None


class AttentionOut(Model):
    comparison_id:UUID
    state:str
    name:str | None=None


class OverviewOut(Model):
    active_comparisons:int
    sample_quality:IndicatorOut
    comparison_agreement:IndicatorOut
    evaluated_comparisons:int
    latest_conclusions:dict[str,int]
    run_counts:dict[str,int]
    trend:list[TrendOut]
    recent_runs:list[RecentRunOut]
    attention:list[AttentionOut]
    as_of:datetime
    scope:str
