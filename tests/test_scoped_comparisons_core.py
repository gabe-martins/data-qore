"""Pure scope contracts and real SQLite reads; no personal configuration."""
from datetime import datetime, timezone
from decimal import Decimal
import sqlite3
import unittest
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

from pydantic import ValidationError

from dataqore_engine.comparison_options import (ComparisonOptions, effective_mapping,
    metadata_signature, resolve_scope, validate_options)
from dataqore_engine.core.comparison_engine import execute_comparison
from dataqore_engine.core.db_adapters import get_adapter
from dataqore_engine.core.db_adapters import TextCriterion
from dataqore_engine.core.sampling import SamplingOptions
from dataqore_engine.storage import DomainError
from dataqore_engine.connectors import prepare_read_session, source_failure, ReadOnlySQLiteConnection


class ScopeContracts(unittest.TestCase):
    def test_relative_uses_calendar_days_across_dst_and_delay(self):
        options={"scope":{"period":{"left":"d","right":"d","kind":"relative",
            "timezone":"America/New_York","quantity":1,"safety_delay_minutes":90}}}
        # After spring transition: previous calendar day has 23 hours.
        resolved=resolve_scope(options,datetime(2026,3,9,7,tzinfo=timezone.utc))["period"]
        a,b=(datetime.fromisoformat(resolved[k]) for k in ("start","end"))
        self.assertEqual((b-a).total_seconds(),23*3600)
        self.assertEqual(resolved['start_day'],'2026-03-08')
        # Safety delay crosses local midnight, choosing the earlier complete day.
        result=resolve_scope(options,datetime(2026,3,9,4,30,tzinfo=timezone.utc))["period"]
        self.assertEqual(result['end_day'],'2026-03-08')
        fall=resolve_scope(options,datetime(2026,11,2,8,tzinfo=timezone.utc))["period"]
        self.assertEqual((datetime.fromisoformat(fall['end'])-datetime.fromisoformat(fall['start'])).total_seconds(),25*3600)
        instant=datetime(2026,11,1,6,15,tzinfo=timezone.utc)
        self.assertEqual(resolve_scope(options,instant),resolve_scope(options,instant.astimezone(ZoneInfo('America/New_York'))))

    def test_midnight_skipped_by_dst_is_first_real_instant_of_day(self):
        p=resolve_scope({'scope':{'period':{'left':'d','right':'d','kind':'fixed',
            'start':'2018-11-04','end':'2018-11-05','timezone':'America/Sao_Paulo'}}})['period']
        self.assertEqual(p['start'],'2018-11-04T03:00:00+00:00')

    def test_rejects_invalid_zones_and_free_sql_operators(self):
        for options in ({'scope':{'period':{'left':'d','right':'d','kind':'relative','timezone':'invalid/zone'}}},
            {'scope':{'filters':[{'left':'d','right':'d','operator':'raw_sql','value':'1=1'}]}},
            {'scope':{'filters':[{'left':'d','right':'d','operator':'in','value':[]}]}},
            {'scope':{'filters':[{'left':'d','right':'d','operator':'eq','value':1.2}]}},
            {'scope':{'filters':[{'left':'d','right':'d','operator':'is_null','value':'secret'}]}}):
            with self.assertRaises(ValidationError): ComparisonOptions.model_validate(options)

    def test_naive_timezone_required_and_date_bounds_are_full_days(self):
        opts={'scope':{'period':{'left':'d','right':'d','kind':'fixed','start':'2026-10-01','end':'2026-10-02'}}}
        columns=[{'d':{'type':'timestamp without time zone'}},{'d':{'type':'date'}}]
        with self.assertRaises(DomainError) as err:validate_options(opts,columns)
        self.assertEqual(err.exception.code,'naive_timezone_required')
        opts['scope']['period']['left_naive_timezone']='America/Sao_Paulo'
        result=validate_options(opts,columns)
        self.assertEqual(result['predicates'][0][0][2][0],datetime(2026,10,1))
        opts['scope']['period']['start']='2026-10-01T12:00:00-03:00'
        with self.assertRaises(DomainError):validate_options(opts,columns)

    def test_precision_and_incompatible_filter_values(self):
        columns=[{'n':{'type':'numeric'}},{'n':{'type':'decimal'}}]
        option={'scope':{'filters':[{'left':'n','right':'n','operator':'gte','value':'0.123456789012345678901234567890'}]}}
        result=validate_options(option,columns)
        self.assertEqual(result['predicates'][0][0][2],[Decimal('0.123456789012345678901234567890')])
        for value in ('NaN','Infinity','1,5',True):
            option['scope']['filters'][0]['value']=value
            with self.assertRaises(DomainError):validate_options(option,columns)

    def test_explicit_pairs_first_ambiguity_and_no_reuse(self):
        columns=[{'ID':{'type':'integer'},'id':{'type':'integer'},'Value':{'type':'text'}},
                 {'id':{'type':'integer'},'amount':{'type':'text'}}]
        pairs,unpaired=effective_mapping(columns,ComparisonOptions())
        self.assertEqual(pairs,[])
        self.assertEqual(len(unpaired['left']),3)
        opts=ComparisonOptions(mapping=[{'left':'ID','right':'id'},{'left':'Value','right':'amount'}])
        pairs,unpaired=effective_mapping(columns,opts)
        self.assertEqual(len(pairs),2)
        self.assertEqual(unpaired['left'],['id'])
        opts.mapping.append(opts.mapping[0])
        with self.assertRaises(DomainError): effective_mapping(columns,opts)

    def test_business_keys_must_be_effective_pairs_and_aligned(self):
        columns=[{'a':{'type':'integer'}},{'b':{'type':'integer'}}]
        option={'business_key':[{'left':'a','right':'b'}]}
        with self.assertRaises(DomainError):validate_options(option,columns)
        option['mapping']=option['business_key']
        self.assertTrue(validate_options(option,columns)['business_key'])


class AdapterScopeContracts(unittest.TestCase):
    def test_text_filter_compilation_is_exact_for_all_five_connectors(self):
        expected={'postgresql':"convert_to",'mysql':"AS BINARY",'mssql':"Latin1_General_100_BIN2",'oracle':"DBMS_LOB.COMPARE",'sqlite':"dataqore_scope_text"}
        for kind,expression in expected.items():
            sql,params=get_adapter(kind)._scope_sql([('batch','in',[TextCriterion('Case'),TextCriterion('Case ')])])
            self.assertIn(expression,sql)
            self.assertEqual(params,['Case','Case '])
            self.assertNotIn('Case',sql)
            self.assertIn(' OR ',sql)
    def test_sqlite_query_deadline_cancels_work_with_specific_code(self):
        conn=sqlite3.connect(':memory:',factory=ReadOnlySQLiteConnection)
        self.addCleanup(conn.close)
        with patch('dataqore_engine.connectors.monotonic',return_value=0) as clock:
            cursor=conn.cursor();clock.return_value=31
            with self.assertRaises(sqlite3.OperationalError) as error:
                cursor.execute('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) SELECT sum(x) FROM n')
            self.assertEqual(source_failure('sqlite',error.exception).code,'source_query_timeout')

    def test_read_consistency_contracts_without_enabling_server_options(self):
        for kind in ('postgresql','oracle','sqlite'):
            conn=MagicMock()
            if kind=='sqlite':conn.cursor.return_value.fetchone.return_value=('wal',)
            self.assertEqual(prepare_read_session(conn,kind,comparison=True),'stable_snapshot')
        conn=MagicMock();conn.cursor.return_value.fetchone.return_value=('delete',)
        self.assertEqual(prepare_read_session(conn,'sqlite',comparison=True),'best_effort')
        self.assertFalse(any(call.args[0]=='BEGIN' for call in conn.cursor.return_value.execute.call_args_list))
        conn=MagicMock();conn.cursor.return_value.fetchone.return_value=(1,)
        self.assertEqual(prepare_read_session(conn,'mssql',comparison=True),'stable_snapshot')
        conn.cursor.return_value.execute.assert_any_call('SET TRANSACTION ISOLATION LEVEL SNAPSHOT')
        self.assertFalse(any('ALTER DATABASE' in str(call) or 'SERIALIZABLE' in str(call) for call in conn.cursor.return_value.execute.call_args_list))
        conn=MagicMock();conn.cursor.return_value.fetchone.return_value=(0,)
        self.assertEqual(prepare_read_session(conn,'mssql',comparison=True),'best_effort')
        conn=MagicMock()
        self.assertEqual(prepare_read_session(conn,'mysql',comparison=True),'transactional_snapshot_pending')
        conn.cursor.return_value.execute.assert_any_call('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')

    def test_driver_timeouts_have_specific_safe_codes(self):
        for kind in ('mysql','mssql','oracle','sqlite'):
            error=source_failure(kind,RuntimeError('query timeout PRIVATE_PASSWORD'))
            self.assertEqual(error.code,'source_query_timeout')
            self.assertNotIn('PRIVATE_PASSWORD',error.message)

    def test_five_drivers_bind_scope_before_grouped_keys_and_budget_batches(self):
        for kind in ('postgresql','mysql','mssql','oracle','sqlite'):
            adapter=get_adapter(kind);conn=MagicMock();cursor=conn.cursor.return_value
            cursor.fetchmany.return_value=[]
            scope=[('batch','eq',['PRIVATE_BATCH']),('amount','gte',[Decimal('0.1')])]
            adapter.fetch_keys(conn,'s','table',['id','batch','amount'],['id'],[(1,),(2,)],scope=scope)
            sql,values=cursor.execute.call_args.args
            self.assertIn(' AND ((',sql)
            self.assertNotIn('PRIVATE_BATCH',sql)
            self.assertEqual(values[:2],('PRIVATE_BATCH','0.1' if kind=='sqlite' else Decimal('0.1')))
            self.assertEqual(values[2:],(1,2))
            if kind=='oracle':self.assertIn(':4',sql)
            many=[('batch','in',list(range(100)))]*8
            adapter.fetch_keys(conn,'s','table',['id','batch'],['id'],[(i,) for i in range(205)],scope=many)
            for call in cursor.execute.call_args_list:self.assertLessEqual(len(call.args[1]),900)

    def test_oracle_aware_bound_is_not_silently_bound_as_naive_date(self):
        at=datetime(2026,10,1,tzinfo=timezone.utc)
        sql,params=get_adapter('oracle')._scope_sql([('created','gte',[at])])
        self.assertIn('TO_TIMESTAMP_TZ(:1',sql)
        self.assertEqual(params,['2026-10-01T00:00:00.000000+00:00'])


if __name__=='__main__':unittest.main()
