"""Transactional backfill of sensitive JSON operands; no source connections."""
import json
import psycopg
from psycopg.types.json import Jsonb
from psycopg import sql
from dataqore_engine.document_crypto import DocumentCrypto, LITERALS, is_envelope
from tools.migration_config import postgres_url

def needs_encryption(value):
    if isinstance(value, list): return any(needs_encryption(v) for v in value)
    if not isinstance(value, dict): return False
    return any((k in LITERALS and v is not None and not is_envelope(v,k)) or needs_encryption(v) for k, v in value.items())

def encrypt_documents(url, key):
    codec=DocumentCrypto(key)
    targets=[('comparison_definitions','id','comparison_options'),('runs','id','parameters'),('run_results','run_id','result'),('datasets','id','metadata')]
    changed=0
    with psycopg.connect(postgres_url(url),connect_timeout=10) as conn:
        identity=conn.execute('SELECT session_user,current_user,current_database()').fetchone()
        if identity!=('srv_dataqore_engine_migrator','dataqore_engine_owner','dataqore_engine'):
            raise ValueError('Engine migrator identity required for document encryption.')
        conn.execute("SET LOCAL lock_timeout='5s'");conn.execute("SET LOCAL statement_timeout='60s'")
        for table,identifier,column in targets:
            conn.execute(sql.SQL('LOCK TABLE engine.{} IN SHARE ROW EXCLUSIVE MODE').format(sql.Identifier(table)))
            with conn.cursor(name='sensitive_documents') as cursor:
                cursor.execute(sql.SQL('SELECT {},{} FROM engine.{} ORDER BY {} FOR UPDATE').format(*map(sql.Identifier,[identifier,column,table,identifier])))
                for row_id,stored in cursor:
                    plain=codec.reveal(stored)  # Also verifies already sealed documents before committing.
                    if needs_encryption(stored):
                        conn.execute(sql.SQL('UPDATE engine.{} SET {}=%s WHERE {}=%s').format(*map(sql.Identifier,[table,column,identifier])),(Jsonb(codec.protect(plain)),row_id));changed+=1
    return changed
