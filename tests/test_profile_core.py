"""Regressões do perfil independente e seus limites finais."""
import sqlite3
import unittest

from dataqore_engine.core.db_adapters import get_adapter
from dataqore_engine.core.profile_engine import execute_profile
from dataqore_engine.core.sampling import SamplingOptions


class ProfileTests(unittest.TestCase):
    def source(self,count):
        conn=sqlite3.connect(':memory:')
        self.addCleanup(conn.close)
        conn.execute('CREATE TABLE sample(id integer PRIMARY KEY,body text)')
        conn.executemany('INSERT INTO sample VALUES (?,?)',[(n,'x'*1000) for n in range(count)])
        return {'conn':conn,'connection':'test','creds':{'type':'sqlite'},'schema':'','table':'sample','adapter':get_adapter('sqlite')}

    def test_final_profile_respects_byte_estimate_when_pilot_is_larger(self):
        result=execute_profile(self.source(100),options=SamplingOptions(max_sample_bytes=1))
        self.assertEqual(result['sample_size'],1)
        self.assertEqual(result['sources'][0]['sample_size'],1)
        self.assertEqual(result['sampling_plan']['actual_rows'],[1])

    def test_expansion_replaces_pilot_and_empty_profile_is_inconclusive(self):
        result=execute_profile(self.source(200),sample_size=100)
        self.assertEqual(result['sources'][0]['sample_size'],100)
        self.assertEqual(result['sampling_plan']['rounds'][-1]['stage'],'expanded')
        empty=execute_profile(self.source(0))
        self.assertEqual(empty['summary']['status'],'inconclusive')
        self.assertIsNone(empty['indicators']['quality']['overall']['percentage'])
