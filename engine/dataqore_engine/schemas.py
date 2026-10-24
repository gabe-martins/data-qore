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
    method: Literal["rows", "percentage"] = "rows"
    rows: Annotated[int, Field(strict=True, ge=1, le=10000)] = 1000
    percentage: Annotated[Decimal, Field(gt=0, le=100, allow_inf_nan=False)] | None = None
    seed: Annotated[str, Field(pattern=r"^[0-9]{1,20}$")] | None = None
    max_cells: Annotated[int, Field(strict=True, ge=1)] = 100000
    max_sample_bytes: Annotated[int, Field(strict=True, ge=1)] = 16777216

    @model_validator(mode="after")
    def selection(self):
        if self.seed is not None and int(self.seed) >= 2**64:
            raise ValueError("Seed exceeds unsigned 64-bit range")
        if (self.method == "percentage") != (self.percentage is not None):
            raise ValueError("Select rows or a percentage")
        return self


class ComparisonCreate(Model):
    name: Name
    left_dataset_id: UUID
    right_dataset_id: UUID
    sampling_options: Sampling = Field(default_factory=Sampling)
    absolute_tolerance: Annotated[Decimal,Field(ge=0,allow_inf_nan=False)]=Decimal(0)
    relative_tolerance: Annotated[Decimal,Field(ge=0,allow_inf_nan=False)]=Decimal(0)
    comparison_options: ComparisonOptions=Field(default_factory=ComparisonOptions)

    @model_validator(mode="after")
    def distinct_sources(self):
        if self.left_dataset_id==self.right_dataset_id:
            raise ValueError("Select two different datasets")
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
    sampling_options: Sampling | None=None
    absolute_tolerance: Annotated[Decimal,Field(ge=0,allow_inf_nan=False)] | None=None
    relative_tolerance: Annotated[Decimal,Field(ge=0,allow_inf_nan=False)] | None=None
    is_active: bool | None=None
    comparison_options: ComparisonOptions | None=None

    @model_validator(mode="after")
    def nonempty(self):
        if not self.model_fields_set or any(getattr(self,k) is None for k in self.model_fields_set):
            raise ValueError("Informe campos válidos para atualização.")
        return self


class ComparisonPreviewOut(Model):
    scope_counts: list[int]
    sample_target: int
    suggested_business_key: list[dict[str,str]]
    mapping: list[dict[str,str]]
    unmatched_columns: dict[str,list[str]]
    business_key: list[dict[str,str]]
    resolved_scope: dict[str,Any]
    key_validation: str
    excluded_columns: dict[str,list[str]] = Field(default_factory=dict)
    timestamp_timezones: dict[str,dict[str,str]] = Field(default_factory=dict)


class RunOut(Model):
    id: UUID
    kind: Literal["comparison"]
    comparison_id: UUID | None
    status: Literal["queued","running","succeeded","failed"]
    parameters: dict[str,Any]
    requested_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    heartbeat_at: datetime | None
    error_code: str | None
    error_message: str | None


class MetricRate(Model):
    numerator: int
    denominator: int
    total: int
    not_evaluated: int
    percentage: Decimal | None
    coverage_percentage: Decimal | None
    scope: str
    status: Literal["available", "partial", "not_evaluated"]
    reason: str | None


class RowCountMatch(Model):
    reference_count: int
    target_count: int
    equal: bool
    signed_difference: int
    absolute_difference: int
    percentage_difference: Decimal | None
    reason: str | None
    scope: str


class KeyCoverage(Model):
    reference_to_target: MetricRate
    target_to_reference: MetricRate
    selected_keys: int
    common_keys: int
    missing_in_reference: int
    missing_in_target: int
    unavailable_in_both: int
    scope: str


class DuplicateKeyRate(MetricRate):
    source: int
    duplicate_groups: int | None
    null_key_rows: int | None
    columns: list[str]
    formula: str


class RowMatchRate(MetricRate):
    different_rows: int
    unknown_rows: int
    missing_rows: int
    formula: str


class ColumnMatchRate(MetricRate):
    left_column: str | None
    right_column: str | None
    different_values: int
    unknown_values: int
    formula: str | None = None


class CriticalMetrics(Model):
    row_count_match: RowCountMatch
    key_coverage: KeyCoverage
    duplicate_key_rate: list[DuplicateKeyRate]
    row_match_rate: RowMatchRate
    column_match_rate: list[ColumnMatchRate]


class ComparisonResult(Model):
    format_version: Literal[6,7]
    engine_version: str
    execution_id: UUID
    started_at: datetime
    finished_at: datetime
    sources: list[dict[str,Any]]
    resolved_scope: dict[str,Any]
    column_mapping: list[dict[str,str]]
    unmatched_columns: dict[str,list[str]]
    comparison_options: ComparisonOptions = Field(default_factory=ComparisonOptions)
    key_validation: list[dict[str,Any]]
    sampling_plan: dict[str,Any]
    metrics: CriticalMetrics
    summary: dict[str,Any]
    warnings: list[str]
    query_log: list[dict[str,Any]]
    evidence: dict[str,Any] | None = None


class QualityMetricSummary(Model):
    row_count_match: RowCountMatch
    key_coverage: KeyCoverage
    duplicate_key_rate: list[DuplicateKeyRate]
    row_match_rate: RowMatchRate


class QualityResultContext(Model):
    format_version: Literal[6,7]
    execution_id: UUID
    sources: list[dict[str,Any]]
    comparison_options: ComparisonOptions = Field(default_factory=ComparisonOptions)
    resolved_scope: dict[str,Any]
    sampling_plan: dict[str,Any]
    key_validation: list[dict[str,Any]]
    summary: dict[str,Any]
    warnings: list[str]
    metrics: QualityMetricSummary
    column_count: int
    columns_requiring_review: int
    column_directory: list[dict[str,Any]]


class QualityOut(Model):
    run: RunOut
    comparison_name: str
    result: QualityResultContext | None
    dimensions: list[dict[str,Any]]
    diagnostics: list[dict[str,Any]]
    evidence: dict[str,Any]


class EvidenceRecordOut(Model):
    id: int
    state: str
    affected_columns: list[str]
    key: list[dict[str,Any]]
    cells: list[dict[str,Any]] | None = None


class QualityColumnOut(Model):
    id: str
    left_column: str | None
    right_column: str | None
    left_type: str | None
    right_type: str | None
    status: str
    metric: ColumnMatchRate


class ResultOut(Model):
    run_id: UUID
    format_version: int
    conclusion: Literal["compatible_in_sample","difference_observed","inconclusive"]
    result: ComparisonResult
    created_at: datetime


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


class DatasetDependenciesOut(Model):
    dataset: DatasetDeletionReference
    comparisons: Page[DatasetComparisonReference]
    block_reasons: list[Literal["dataset_in_use"]]
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
    row_match_rate:dict[str,Any] | None


class ComparisonSummaryOut(ComparisonOut):
    latest_run:LatestRunOut | None
    latest_result:LatestResultOut | None


class TrendOut(IndicatorOut):
    day:str


class DailyRowMatchPoint(TrendOut):
    run_id:UUID | None
    status:Literal["succeeded","failed"] | None
    finished_at:datetime | None
    conclusion:str | None=None


class ComparisonRowMatchSeries(Model):
    comparison_id:UUID
    name:str
    points:list[DailyRowMatchPoint]


class RowMatchTrendOut(Model):
    days:Literal[7,15,30]
    timezone:str
    start_day:str
    end_day:str
    as_of:datetime
    series:list[ComparisonRowMatchSeries]
    overall:list[TrendOut]=[]


class RecentRunOut(Model):
    id:UUID
    kind:str
    status:str
    comparison_id:UUID | None
    requested_at:datetime
    started_at:datetime | None
    finished_at:datetime | None
    error_code:str | None
    name:str | None
    conclusion:str | None
    row_match_rate:dict[str,Any] | None


class AttentionOut(Model):
    comparison_id:UUID
    state:str
    name:str | None=None


class OverviewOut(Model):
    active_comparisons:int
    row_match_rate:IndicatorOut
    evaluated_comparisons:int
    latest_conclusions:dict[str,int]
    run_counts:dict[str,int]
    trend:list[TrendOut]
    recent_runs:list[RecentRunOut]
    attention:list[AttentionOut]
    as_of:datetime
    scope:str
