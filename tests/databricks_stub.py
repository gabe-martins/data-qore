"""SQL Warehouse simulator for isolated tests only. Never installed in the app."""
import os
import re
import json
import sqlite3
from pathlib import Path
from dataqore_engine.databricks import Connection


class NativeCursor:
    def __init__(self,conn):self.conn=conn;self.rows=[]
    def execute(self,sql,parameters=None):
        parameters=list(parameters or [])
        if sql.startswith('DESCRIBE TABLE EXTENDED '):
            self.rows=[(json.dumps({'type':'VIEW' if 'records_view`' in sql else 'MANAGED',
                'provider':'delta','created_time':'2026-09-27T01:48:51Z','partition_columns':[],
                'statistics':{'num_rows':2,'size_in_bytes':128}}),)];return self
        if sql=='SHOW CATALOGS':self.rows=[('main',),('other',)];return self
        if '.information_schema.schemata' in sql:self.rows=[('sales',)];return self
        if '.information_schema.tables' in sql:
            self.rows=[('sales','records','MANAGED'),('sales','records_view','VIEW')];return self
        if '.information_schema.columns' in sql:
            self.rows=[('id','INT','NO',10,0),('amount','DECIMAL(20,2)','NO',20,2),('status','STRING','YES',None,None)];return self
        if '.information_schema.table_constraints' in sql:
            self.rows=[] if parameters[-1]=='records_view' else [('informational_pk','PRIMARY KEY','id',1)];return self
        sql=re.sub(r'`(?:[^`]|``)+`\.`sales`\.`(records(?:_view)?)`',r'"\1"',sql)
        sql=sql.replace('RAND()','RANDOM()')
        sql=re.sub(r'octet_length\((`[^`]+`)\)',r'length(CAST(\1 AS BLOB))',sql)
        self.rows=self.conn.execute(sql,parameters).fetchall();return self
    def fetchall(self):return self.rows[:]
    def fetchone(self):return self.rows[0] if self.rows else None
    def fetchmany(self,count):
        batch,self.rows=self.rows[:count],self.rows[count:]
        return batch
    def close(self):pass


class NativeConnection:
    def __init__(self,path):self.conn=sqlite3.connect(path)
    def cursor(self):return NativeCursor(self.conn)
    def close(self):self.conn.close()


def connect(credentials):
    if os.environ.get('DATAQORE_ISOLATED_TEST')!='1':raise RuntimeError('Disposable fixture required')
    return Connection(NativeConnection(Path(os.environ['DATAQORE_DATABRICKS_STUB_ROOT'])/'databricks.sqlite'))
