"""Projection tests: real formulas, missing evaluations and local calendar bounds."""
import unittest
from unittest.mock import patch
from datetime import datetime, timezone
from dataqore_engine.overview_metrics import trend_value, window
from dataqore_engine.storage import DomainError

class OverviewMetricsTests(unittest.TestCase):
    def test_directional_rates_and_single_column_keep_their_denominators(self):
        def rate(n,d):return {'percentage':str(n*100/d) if d else None,'numerator':n,'denominator':d,'total':d,'not_evaluated':0,'scope':'selected_key_sample'}
        metrics={'key_coverage':{'reference_to_target':rate(8,10),'target_to_reference':rate(8,8)},
            'column_match_rate':[{'left_column':'a','right_column':'b',**rate(7,10)},{'left_column':'c','right_column':'d',**rate(10,10)}],
            'row_match_rate':rate(7,10)}
        values=trend_value('key_coverage',metrics)
        self.assertEqual([(v['numerator'],v['denominator']) for v in values],[(8,10),(8,8)])
        self.assertEqual(trend_value('column_match_rate',metrics,'a','b')[0]['percentage'],'70.0')
        self.assertEqual(trend_value('column_match_rate',metrics,'x','b'),[])
        self.assertEqual(trend_value('row_match_rate',None),[])
    def test_volume_and_duplicates_are_lower_is_better_without_new_scores(self):
        metrics={'row_count_match':{'percentage_difference':'200','absolute_difference':2,'reference_count':1,'scope':'entire_selected_scope','reason':None},
            'duplicate_key_rate':[{'percentage':'0.0000','numerator':0,'denominator':200,'total':200,'not_evaluated':0,'scope':'entire_selected_scope'}]}
        self.assertEqual(trend_value('row_count_match',metrics)[0]['percentage'],'200')
        self.assertEqual(trend_value('duplicate_key_rate',metrics)[0]['denominator'],200)
        metrics['row_count_match'].update(percentage_difference=None,reference_count=0,reason='reference_count_zero')
        self.assertIsNone(trend_value('row_count_match',metrics)[0]['percentage'])
    def test_local_day_boundary_and_invalid_filters(self):
        with patch('dataqore_engine.overview_metrics.datetime') as clock:
            clock.now.return_value=datetime(2026,1,1,1,30,tzinfo=timezone.utc)
            clock.combine.side_effect=datetime.combine
            clock.min=datetime.min
            _,first,last,start=window(7,'America/Sao_Paulo')
            self.assertEqual(str(last),'2025-12-31');self.assertEqual(str(first),'2025-12-25');self.assertEqual(start.hour,0)
        for days,zone in [(1,'UTC'),(30,'Invalid/Zone')]:
            with self.assertRaises(DomainError):window(days,zone)
