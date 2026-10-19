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
            "timezone":"America/New_York","days":1,"safety_delay_minutes":90}}}
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
        with self.assertRaises(DomainError) as unavailable:validate_options({'mapping':option['mapping']},columns,'matched_keys')
        self.assertEqual(unavailable.exception.code,'comparison_key_unavailable')
        with self.assertRaises(DomainError):validate_options(option,columns,'independent_random')


class ScopedSQLite(unittest.TestCase):
    def setUp(self):
        self.sources=[]
        for side in ('left','right'):
            conn=sqlite3.connect(':memory:');self.addCleanup(conn.close)
            columns='account text, item integer, day date, batch text, amount numeric' if side=='left' else 'customer text, line integer, loaded date, batch text, total numeric'
            conn.execute('CREATE TABLE records('+columns+')')
            conn.executemany('INSERT INTO records VALUES(?,?,?,?,?)',[
                ('A',1,'2026-10-01','B',10),('A',2,'2026-10-01','B',20),
                ('A',1,'2026-09-30','B',999),('A',1,'2026-10-02','B',999),
                ('A',1,'2026-10-01','OTHER',999),(None,9,'2026-09-30','B',999)])
            self.sources.append(dict(conn=conn,creds={'type':'sqlite'},connection=side,schema='',table='records',read_consistency='stable_snapshot'))
        self.options={'mapping':[{'left':'account','right':'customer'},{'left':'item','right':'line'},
            {'left':'day','right':'loaded'},{'left':'amount','right':'total'}],
            'business_key':[{'left':'account','right':'customer'},{'left':'item','right':'line'}],
            'scope':{'period':{'left':'day','right':'loaded','kind':'fixed','start':'2026-10-01','end':'2026-10-02'},
                'filters':[{'left':'batch','right':'batch','operator':'eq','value':'B'}]}}

    def execute(self,**kwargs):
        return execute_comparison(self.sources,comparison_options=self.options,preview_limit=0,
            options=SamplingOptions(pilot_rows=1,min_rows=1,max_rows=2),sample_size=2,**kwargs)

    def test_same_scope_applies_pilot_expansion_and_composite_or_lookup(self):
        result=self.execute()
        self.assertEqual(result['format_version'],5)
        self.assertEqual(result['summary']['status'],'compatible_in_sample')
        self.assertEqual(result['row_comparisons'][0]['common_keys'],2)
        self.assertEqual(result['row_comparisons'][0]['different_rows'],0)
        self.assertEqual([v['total_rows'] for v in result['key_validation']],[2,2])
        self.assertEqual(result['sources'][0]['estimated_rows'],None)
        self.assertIn('customer',result['sources'][1]['metrics'])
        self.assertNotIn('account',result['sources'][1]['metrics'])
        self.assertEqual(result['metric_comparisons'][0]['left_column'],'account')
        queries=[q['sql'] for q in result['query_log'] if 'ORDER BY RANDOM()' in q['sql'] or ' OR ' in q['sql'] and 'SELECT CASE' in q['sql']]
        self.assertTrue(queries)
        for q in queries:self.assertIn('WHERE',q)
        self.assertNotIn('2026-10-01',str(result['query_log']))
        # Noncontiguous calendar dates can also be criteria without inventing
        # timestamp timezone semantics in an untyped filter.
        self.options['scope'].pop('period')
        self.options['scope']['filters'].append({'left':'day','right':'loaded','operator':'in','value':['2026-10-01']})
        self.assertEqual([v['total_rows'] for v in self.execute()['key_validation']],[2,2])
        # Different technical PKs must not replace the selected business key.
        for index,source in enumerate(self.sources):
            columns='account text,item integer,day date,batch text,amount numeric' if index==0 else 'customer text,line integer,loaded date,batch text,total numeric'
            source['conn'].execute('CREATE TABLE keyed(id integer PRIMARY KEY,'+columns+')')
            source['conn'].execute(f'INSERT INTO keyed SELECT rowid+{index*100},* FROM records')
            source['table']='keyed'
        aligned=self.execute()
        self.assertEqual(aligned['sampling_plan']['key_kind'],'business_key')
        self.assertEqual(aligned['row_comparisons'][0]['common_keys'],2)
        self.assertEqual(aligned['row_comparisons'][0]['different_values']['id'],2)

    def test_duplicate_and_null_outside_sample_inside_scope_are_inconclusive(self):
        self.sources[0]['conn'].executemany('INSERT INTO records VALUES(?,?,?,?,?)',
            [('DUP',1,'2026-10-01','B',1),('DUP',1,'2026-10-01','B',1),(None,8,'2026-10-01','B',1)])
        result=self.execute(mode='matched_keys')
        self.assertEqual(result['summary']['status'],'inconclusive')
        self.assertEqual(result['key_validation'][0]['null_key_rows'],1)
        self.assertEqual(result['key_validation'][0]['duplicate_groups'],1)
        self.assertEqual(result['row_comparisons'],[])
        self.assertIsNone(result['indicators']['agreement']['percentage'])
        self.assertEqual(result['sampling_plan']['mode'],'key_validation_failed')

    def test_changed_metadata_is_explicit_failure(self):
        for source in self.sources:
            source['expected_columns']=metadata_signature(get_adapter('sqlite').metadata(source['conn'],'','records'))
        self.sources[0]['conn'].execute('ALTER TABLE records ADD COLUMN changed text')
        with self.assertRaises(DomainError) as err:self.execute()
        self.assertEqual(err.exception.code,'source_schema_changed')

    def test_unpaired_column_remains_schema_difference(self):
        self.sources[1]['conn'].execute('ALTER TABLE records ADD COLUMN technical_id integer')
        result=self.execute()
        self.assertEqual(result['summary']['status'],'difference_observed')
        self.assertEqual(result['unmatched_columns']['right'],['technical_id'])
        self.assertTrue(any(f['kind']=='column_presence' and f['right_column']=='technical_id' for f in result['schema_findings']))

    def test_stable_read_unavailable_is_warning_not_silent_guarantee(self):
        self.sources[1]['read_consistency']='best_effort'
        result=self.execute()
        self.assertTrue(any('Source 2: stable read unavailable' in w for w in result['warnings']))
        self.assertEqual(result['key_validation'][1]['read_consistency'],'best_effort')

    def test_key_becoming_invalid_after_validation_never_falls_back_to_another_key(self):
        self.sources[0]['conn'].execute("UPDATE records SET account=NULL WHERE item=2 AND batch='B'")
        diagnostic=dict(total_rows=2,null_key_rows=0,duplicate_groups=0,duplicate_excess_rows=0,valid=True,scope='entire selected scope')
        with patch('dataqore_engine.core.db_adapters.DatabaseAdapter.validate_key',return_value=diagnostic):
            result=self.execute(mode='auto')
        self.assertEqual(result['summary']['status'],'inconclusive')
        self.assertEqual(result['row_comparisons'],[])
        self.assertTrue(all(v['reason']=='key_unavailable_or_changed_after_validation' for v in result['key_validation']))

    def test_legacy_contract_unchanged_without_options(self):
        c=sqlite3.connect(':memory:');self.addCleanup(c.close)
        c.execute('CREATE TABLE records(id integer PRIMARY KEY)');c.execute('INSERT INTO records VALUES(1)')
        source=dict(conn=c,creds={'type':'sqlite'},connection='legacy',schema='',table='records')
        result=execute_comparison([source,source],preview_limit=0)
        self.assertEqual(result['format_version'],4)
        self.assertNotIn('comparison_options',result)

    def test_naive_sqlite_iso_timestamps_keep_fractional_boundaries(self):
        c=sqlite3.connect(':memory:');self.addCleanup(c.close)
        c.execute('CREATE TABLE times(id integer PRIMARY KEY, at timestamp)')
        c.executemany('INSERT INTO times VALUES(?,?)',[(1,'2026-10-01T00:00:00.099999'),
            (2,'2026-10-01 00:00:00.1'),(3,'2026-10-01T00:00:00.199999'),(4,'2026-10-01 00:00:00.2')])
        source=dict(conn=c,creds={'type':'sqlite'},connection='times',schema='',table='times')
        options={'scope':{'period':{'left':'at','right':'at','kind':'fixed','timezone':'UTC',
            'start':'2026-10-01T00:00:00.1Z','end':'2026-10-01T00:00:00.2Z',
            'left_naive_timezone':'UTC','right_naive_timezone':'UTC'}}}
        result=execute_comparison([source,source],comparison_options=options,preview_limit=0)
        self.assertEqual([s['sample_size'] for s in result['sources']],[2,2])
        self.assertEqual(result['row_comparisons'][0]['common_keys'],2)
        c.execute("INSERT INTO times VALUES (5,'2026-10-01T00:00:00.123456789')")
        with self.assertRaises(sqlite3.OperationalError) as error:
            execute_comparison([source,source],comparison_options=options,preview_limit=0)
        self.assertEqual(source_failure('sqlite',error.exception).code,'source_scope_encoding_invalid')

    def test_sqlite_decimal_filter_does_not_round_threshold_to_binary_float(self):
        c=sqlite3.connect(':memory:');self.addCleanup(c.close)
        c.execute('CREATE TABLE numbers(id integer PRIMARY KEY, amount numeric)')
        c.execute('INSERT INTO numbers VALUES(1,0.1)')
        source=dict(conn=c,creds={'type':'sqlite'},connection='numbers',schema='',table='numbers')
        options={'scope':{'filters':[{'left':'amount','right':'amount','operator':'gte',
            'value':'0.100000000000000000000000001'}]}}
        result=execute_comparison([source,source],comparison_options=options,preview_limit=0)
        self.assertEqual([s['sample_size'] for s in result['sources']],[0,0])
        self.assertEqual(result['summary']['status'],'inconclusive')

    def test_text_scope_ignores_collation_and_preserves_case_accents_and_spaces(self):
        sources=[]
        for collation in ('BINARY','NOCASE'):
            c=sqlite3.connect(':memory:');self.addCleanup(c.close)
            c.execute(f'CREATE TABLE strings(id integer PRIMARY KEY, batch text COLLATE {collation})')
            c.executemany('INSERT INTO strings VALUES(?,?)',list(enumerate(['B','b','B ','é','É','e\u0301'],1)))
            sources.append(dict(conn=c,creds={'type':'sqlite'},connection=collation,schema='',table='strings'))
        for text in ('B','é'):
            opts={'business_key':[{'left':'id','right':'id'}],
                'scope':{'filters':[{'left':'batch','right':'batch','operator':'eq','value':text}]}}
            result=execute_comparison(sources,comparison_options=opts,preview_limit=0)
            self.assertEqual([v['total_rows'] for v in result['key_validation']],[1,1])
            self.assertEqual(result['summary']['status'],'compatible_in_sample')

    def test_text_key_lookup_does_not_align_different_case_under_nocase(self):
        sources=[]
        for value in ('B','b'):
            c=sqlite3.connect(':memory:');self.addCleanup(c.close)
            c.execute('CREATE TABLE text_keys(code text COLLATE NOCASE, amount integer)')
            c.execute('INSERT INTO text_keys VALUES(?,1)',(value,))
            sources.append(dict(conn=c,creds={'type':'sqlite'},connection='text',schema='',table='text_keys'))
        result=execute_comparison(sources,comparison_options={'business_key':[{'left':'code','right':'code'}]},
            sample_size=1,options=SamplingOptions(seed=1),preview_limit=0)
        self.assertEqual(result['summary']['status'],'difference_observed')
        self.assertEqual(result['row_comparisons'][0]['common_keys'],0)


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

    def test_random_scope_parameter_order_and_aggregates(self):
        for kind in ('postgresql','mysql','mssql','oracle','sqlite'):
            adapter=get_adapter(kind);conn=MagicMock();cursor=conn.cursor.return_value
            cursor.fetchmany.return_value=[]
            adapter.fetch_random(conn,'','table',['id'],5,scope=[('batch','eq',['B'])])
            sql,values=cursor.execute.call_args.args
            self.assertEqual(values,(5,'B') if kind=='mssql' else ('B',5))
            if kind=='oracle':self.assertIn('ROWNUM <= :2',sql)
            cursor.fetchone.side_effect=[(3,1),(1,1)]
            result=adapter.validate_key(conn,'','table',['id'],[('batch','eq',['B'])])
            self.assertFalse(result['valid'])
            self.assertEqual(result['total_rows'],3)

    def test_oracle_aware_bound_is_not_silently_bound_as_naive_date(self):
        at=datetime(2026,10,1,tzinfo=timezone.utc)
        sql,params=get_adapter('oracle')._scope_sql([('created','gte',[at])])
        self.assertIn('TO_TIMESTAMP_TZ(:1',sql)
        self.assertEqual(params,['2026-10-01T00:00:00.000000+00:00'])


if __name__=='__main__':unittest.main()
