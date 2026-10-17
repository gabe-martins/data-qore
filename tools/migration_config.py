"""Carregamento explícito, sem fallback para a conta de execução."""
import os
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]


def load_url(service):
    filename = "controller.env" if service == "app" else "engine.env"
    path = Path(os.environ.get("DATAQORE_ENV_FILE", ROOT / filename))
    values = dotenv_values(path, interpolate=False) if path.exists() else {}
    url = os.environ.get("MIGRATION_DATABASE_URL") or values.get("MIGRATION_DATABASE_URL")
    if not url:
        raise ValueError(f"Configure MIGRATION_DATABASE_URL em {filename} ou no ambiente.")
    parts = urlsplit(url)
    if parts.scheme not in {"postgresql", "postgresql+psycopg"}:
        raise ValueError("MIGRATION_DATABASE_URL deve usar PostgreSQL.")
    if parts.username != f"srv_dataqore_{service}_migrator":
        raise ValueError("Use a conta migrator específica do serviço, nunca a conta de execução.")
    if parts.path != f"/dataqore_{service}":
        raise ValueError("O database da migration não corresponde ao serviço selecionado.")
    return url


def postgres_url(url):
    parts = urlsplit(url)
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if k != "schema"])
    return urlunsplit(("postgresql", parts.netloc, parts.path, query, ""))


def sqlalchemy_url(url):
    return postgres_url(url).replace("postgresql://", "postgresql+psycopg://", 1)


def prisma_url(url):
    parts = urlsplit(postgres_url(url))
    return urlunsplit(parts._replace(query=parts.query + ("&" if parts.query else "") + "schema=app"))
