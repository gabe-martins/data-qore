"""Configuração de execução; não carrega nem usa credenciais de migrations."""
from dataclasses import dataclass, field
import os
import math
from pathlib import Path

from cryptography.fernet import Fernet
from dotenv import dotenv_values
from sqlalchemy.engine import make_url

ENGINE_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    database_url: str = field(repr=False)
    api_key: str = field(repr=False)
    encryption_key: str = field(repr=False)
    encryption_key_version: str = "v1"
    sqlite_allowed_root: Path = ENGINE_ROOT / "local_sources"
    heartbeat_seconds: float = 5
    job_timeout_seconds: float = 600
    poll_seconds: float = 1
    evidence_encryption_key: str = field(default="", repr=False)

    def __post_init__(self):
        try:
            url = make_url(self.database_url)
            if url.drivername not in {"postgresql", "postgresql+psycopg"}:
                raise ValueError
            if url.username != "srv_dataqore_engine" or url.database != "dataqore_engine":
                raise ValueError
        except Exception:
            raise ValueError("DATABASE_URL deve usar a conta srv_dataqore_engine no database dataqore_engine.") from None
        if len(self.api_key) < 16 or self.api_key.startswith("SUBSTITUIR"):
            raise ValueError("Configure ENGINE_API_KEY com um segredo interno de pelo menos 16 caracteres.")
        try:
            Fernet(self.encryption_key.encode())
        except Exception:
            raise ValueError("CONNECTIONS_ENCRYPTION_KEY deve ser uma chave Fernet válida.") from None
        if not self.encryption_key_version or any(not math.isfinite(v) or v<=0
            for v in (self.heartbeat_seconds,self.job_timeout_seconds,self.poll_seconds)):
            raise ValueError("Versão da chave e intervalos do worker precisam ser válidos.")
        object.__setattr__(self,"sqlite_allowed_root",Path(self.sqlite_allowed_root).resolve())
        if self.evidence_encryption_key:
            Fernet(self.evidence_encryption_key.encode())


def load_settings():
    path = Path(os.environ.get("DATAQORE_ENV_FILE",ENGINE_ROOT.parent / "engine.env"))
    values = dotenv_values(path,interpolate=False) if path.exists() else {}
    def get(name,default=""):
        return os.environ.get(name,values.get(name,default))
    return Settings(
        database_url=get("DATABASE_URL"), api_key=get("ENGINE_API_KEY"),
        encryption_key=get("CONNECTIONS_ENCRYPTION_KEY"),
        encryption_key_version=get("CONNECTIONS_ENCRYPTION_KEY_VERSION","v1"),
        sqlite_allowed_root=Path(get("SQLITE_ALLOWED_ROOT",str(ENGINE_ROOT / "local_sources"))),
        heartbeat_seconds=float(get("WORKER_HEARTBEAT_SECONDS","5")),
        job_timeout_seconds=float(get("WORKER_JOB_TIMEOUT_SECONDS","600")),
        poll_seconds=float(get("WORKER_POLL_SECONDS","1")),
        evidence_encryption_key=get("EVIDENCE_ENCRYPTION_KEY"),
    )
