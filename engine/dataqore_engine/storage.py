"""Persistência e serialização exata dos agregados."""
from datetime import date,datetime,time
from decimal import Decimal
import json
import math
from uuid import UUID

from sqlalchemy import create_engine,func,select
from sqlalchemy.engine import make_url


class DomainError(Exception):
    def __init__(self,status,code,message):
        self.status,self.code,self.message=status,code,message
        super().__init__(code)


def json_safe(value):
    if isinstance(value,Decimal):
        return str(value) if value.is_finite() else None
    if isinstance(value,(UUID,date,datetime,time)):
        return str(value) if isinstance(value,UUID) else value.isoformat()
    if isinstance(value,dict):
        return {str(k):json_safe(v) for k,v in value.items()}
    if isinstance(value,(tuple,list)):
        return [json_safe(v) for v in value]
    if isinstance(value,float) and not math.isfinite(value):
        return None
    if value is None or isinstance(value,(str,bool,int,float)):
        return value
    raise TypeError("Tipo não suportado no resultado agregado.")


def database_engine(settings):
    url=make_url(settings.database_url).set(drivername="postgresql+psycopg")
    return create_engine(url,pool_pre_ping=True,pool_size=5,max_overflow=5,hide_parameters=True,
        connect_args={"connect_timeout":10},
        json_serializer=lambda v:json.dumps(json_safe(v),allow_nan=False))


class Repository:
    def __init__(self,engine):
        self.engine=engine

    def get(self,table,identifier):
        with self.engine.connect() as conn:
            row=conn.execute(select(table).where(table.c.id==identifier)).mappings().first()
        if row is None:
            raise DomainError(404,"not_found","Recurso não encontrado.")
        return dict(row)

    def add(self,table,values):
        with self.engine.begin() as conn:
            return dict(conn.execute(table.insert().values(**values).returning(table)).mappings().one())

    def update(self,table,identifier,values):
        with self.engine.begin() as conn:
            row=conn.execute(table.update().where(table.c.id==identifier).values(**values).returning(table)).mappings().first()
        if row is None:
            raise DomainError(404,"not_found","Recurso não encontrado.")
        return dict(row)

    def page(self,table,limit,offset,*conditions,order=None):
        with self.engine.connect() as conn:
            total=conn.scalar(select(func.count()).select_from(table).where(*conditions))
            rows=conn.execute(select(table).where(*conditions).order_by(*(order or [table.c.id])).limit(limit).offset(offset)).mappings().all()
        return {"items":[dict(r) for r in rows],"total":total,"limit":limit,"offset":offset}
