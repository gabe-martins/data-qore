"""Check the worker's session leadership without claiming jobs or locks."""
import psycopg
from dataqore_engine.settings import load_settings

url = load_settings().database_url.replace("postgresql+psycopg://", "postgresql://", 1)
with psycopg.connect(url, connect_timeout=5) as connection:
    active = connection.execute("""
        SELECT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory'
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=80419 AND objid=1 AND objsubid=2 AND granted)
    """).fetchone()[0]
raise SystemExit(0 if active else 1)
