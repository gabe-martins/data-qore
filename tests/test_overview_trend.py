import unittest
from dataqore_engine.read_api import linear_trend,ratio


class LinearTrendTests(unittest.TestCase):
    def points(self,values):
        return [{'day':str(i),**ratio(v or 0,100 if v is not None else 0,100 if v is not None else 0)} for i,v in enumerate(values)]

    def test_empty_single_day_and_real_zero(self):
        for values in [[],[None,None],[0,None]]:
            fit,n=linear_trend(self.points(values))
            self.assertEqual(n,sum(v is not None for v in values))
            self.assertTrue(all(p['percentage'] is None for p in fit))

    def test_calendar_gaps_are_used_without_changing_observed_values(self):
        points=self.points([None,100,None,60,None]);fit,n=linear_trend(points)
        self.assertEqual(n,2)
        self.assertEqual([p['percentage'] for p in fit],[None,'100.0000','80.0000','60.0000',None])
        self.assertIsNone(points[2]['percentage'])

    def test_ordinary_least_squares_and_constant_trends(self):
        fit,_=linear_trend(self.points([71,80,93]))
        self.assertEqual([p['percentage'] for p in fit],['70.3333','81.3333','92.3333'])
        for v in [0,71,100]:
            fit,_=linear_trend(self.points([v,v,v]))
            self.assertEqual([p['percentage'] for p in fit],[f'{v}.0000']*3)
