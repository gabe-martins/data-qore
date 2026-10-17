"""Migrations do motor: configuração e credenciais separadas da execução."""
from pathlib import Path
import sys

from alembic import context
from sqlalchemy import create_engine, pool, text

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.migration_config import load_url, sqlalchemy_url
from dataqore_engine.models import metadata


def include_name(name, type_, parent_names):
    if type_ == "schema":
        return name == "engine"
    if type_ == "table":
        # Inclui só as tabelas modeladas. Partições e histórico não são produto.
        return f"engine.{name}" in metadata.tables
    return True


settings = dict(
    target_metadata=metadata,
    version_table_schema="engine",
    include_schemas=True,
    include_name=include_name,
    compare_type=True,
    compare_server_default=True,
)
url = sqlalchemy_url(load_url("engine"))
if context.is_offline_mode():
    context.configure(url=url, literal_binds=True, dialect_opts={"paramstyle": "named"}, **settings)
    with context.begin_transaction():
        context.execute("SET LOCAL ROLE dataqore_engine_owner")
        context.execute("CREATE SCHEMA IF NOT EXISTS engine AUTHORIZATION dataqore_engine_owner")
        context.run_migrations()
else:
    with create_engine(url, poolclass=pool.NullPool).connect() as connection:
        with connection.begin():
            connection.execute(text("SET LOCAL ROLE dataqore_engine_owner"))
            connection.execute(text("SET LOCAL search_path TO pg_catalog"))
            # Impede que engine seja normalizado para o schema implícito (None).
            connection.dialect.default_schema_name = "public"
            connection.execute(text("CREATE SCHEMA IF NOT EXISTS engine AUTHORIZATION dataqore_engine_owner"))
            context.configure(connection=connection, **settings)
            context.run_migrations()
