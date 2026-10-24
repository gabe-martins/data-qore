"""Daily projections of saved metrics. Never opens a source connection."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from sqlalchemy import text
from .read_api import ratio
from .storage import DomainError, json_safe


def window(days, timezone):
    if days not in (7, 15, 30):
        raise DomainError(422, 'validation_error', 'Use 7, 15 or 30 days.')
    try:
        zone = ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise DomainError(422, 'validation_error', 'Use a valid IANA timezone.') from None
    now = datetime.now(ZoneInfo('UTC'))
    end = now.astimezone(zone).date()
    start = end - timedelta(days=days-1)
    return now, start, end, datetime.combine(start, datetime.min.time(), tzinfo=zone)


def daily_rows(connection, ids, start, now, timezone):
    if not ids:
        return []
    return connection.execute(text("""WITH ranked AS (
        SELECT r.id,r.comparison_id,r.status,r.finished_at,
            (r.finished_at AT TIME ZONE :zone)::date AS day,
            row_number() OVER (PARTITION BY r.comparison_id,
                (r.finished_at AT TIME ZONE :zone)::date
                ORDER BY r.finished_at DESC,r.id DESC) AS position
        FROM engine.runs r WHERE r.comparison_id=ANY(:ids)
            AND r.kind='comparison' AND r.status IN ('succeeded','failed')
            AND r.finished_at>=:start AND r.finished_at<=:now
    ) SELECT r.*,rr.conclusion,
        CASE WHEN r.status='succeeded' THEN rr.result->'metrics' END AS metrics
        FROM ranked r LEFT JOIN engine.run_results rr ON rr.run_id=r.id
        WHERE r.position=1 ORDER BY r.day"""),
        {'ids':ids,'start':start,'now':now,'zone':timezone}).mappings().all()


def trend_value(metric, metrics, left=None, right=None):
    """Preserve rates and denominators; never average column rates into a score."""
    if not metrics:
        return []
    if metric == 'row_count_match':
        m = metrics[metric]
        return [{'label':'Absolute volume difference / A', 'percentage':m['percentage_difference'],
                 'numerator':m['absolute_difference'],'denominator':m['reference_count'],
                 'total':None,'not_evaluated':0,'scope':m['scope'],'reason':m.get('reason')}]
    if metric == 'key_coverage':
        return [{'label':label, **metrics[metric][direction]} for label,direction in
                (('A → B','reference_to_target'),('B → A','target_to_reference'))]
    if metric == 'duplicate_key_rate':
        return [{'label':f'Source {i+1}',**m} for i,m in enumerate(metrics[metric])]
    if metric == 'column_match_rate':
        matches=[m for m in metrics[metric] if m['left_column']==left and m['right_column']==right]
        return [{'label':f'{left or "Unpaired"} → {right or "Unpaired"}',**m} for m in matches]
    return [{'label':'Row Match Rate',**metrics['row_match_rate']}]


def register_overview_metrics(router, engine):
    from fastapi import Query
    from typing import Literal
    from uuid import UUID
    from .schemas import OverviewComparisonsOut, MetricTrendOut

    @router.get('/overview/comparisons', tags=['overview'], response_model=OverviewComparisonsOut)
    def comparisons(days:int=7, timezone:str=Query('America/Sao_Paulo',max_length=100),
                    limit:int=Query(25,ge=1,le=50), offset:int=Query(0,ge=0), search:str=Query('',max_length=255)):
        now, first, last, start=window(days,timezone)
        pattern='%'+search.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
        with engine.connect() as conn:
            total=conn.scalar(text('SELECT count(*) FROM engine.comparison_definitions WHERE is_active AND name ILIKE :search'),{'search':pattern})
            rows=conn.execute(text("""SELECT cd.id AS comparison_id,cd.name,r.id AS run_id,r.status,r.finished_at,
                pending.status AS execution_status,rr.conclusion,
                CASE WHEN r.status='succeeded' THEN rr.result->'metrics' END AS metrics,
                CASE WHEN r.status='succeeded' THEN rr.result->'summary' END AS summary,
                ld.table_name AS source_table,rd.table_name AS target_table
                FROM engine.comparison_definitions cd
                JOIN engine.datasets ld ON ld.id=cd.left_dataset_id
                JOIN engine.datasets rd ON rd.id=cd.right_dataset_id
                LEFT JOIN LATERAL (SELECT id,status,finished_at FROM engine.runs
                    WHERE comparison_id=cd.id AND kind='comparison' AND status IN ('succeeded','failed')
                        AND finished_at<=:now ORDER BY finished_at DESC,id DESC LIMIT 1) r ON true
                LEFT JOIN LATERAL (SELECT status FROM engine.runs WHERE comparison_id=cd.id AND kind='comparison'
                    ORDER BY requested_at DESC,id DESC LIMIT 1) pending ON true
                LEFT JOIN engine.run_results rr ON rr.run_id=r.id
                WHERE cd.is_active AND cd.name ILIKE :search ORDER BY cd.name,cd.id LIMIT :limit OFFSET :offset"""),
                {'now':now,'search':pattern,'limit':limit,'offset':offset}).mappings().all()
            daily=daily_rows(conn,[r['comparison_id'] for r in rows],start,now,timezone)
        by_day={(r['comparison_id'],r['day']):r for r in daily}
        items=[]
        for r in rows:
            points=[]
            column_pairs={}
            for saved_metrics in [r['metrics'],*[saved['metrics'] for saved in daily if saved['comparison_id']==r['comparison_id']]]:
                for pair in (saved_metrics or {}).get('column_match_rate',[]):
                    names=(pair['left_column'],pair['right_column'])
                    column_pairs[names]={'left_column':names[0],'right_column':names[1]}
            for n in range(days):
                day=first+timedelta(days=n)
                saved=by_day.get((r['comparison_id'],day),{})
                m=((saved.get('metrics') or {}).get('row_match_rate') or {})
                points.append({'day':day.isoformat(),'run_id':saved.get('id'),'status':saved.get('status'),
                    'finished_at':saved.get('finished_at'),'conclusion':saved.get('conclusion'),
                    **ratio(int(m.get('numerator') or 0),int(m.get('denominator') or 0),int(m.get('total') or 0))})
            items.append({**r,'points':points,'column_pairs':list(column_pairs.values())})
        return json_safe({'items':items,'total':total,'limit':limit,'offset':offset,'days':days,'timezone':timezone,
            'start_day':first.isoformat(),'end_day':last.isoformat(),'as_of':now})

    @router.get('/overview/metric-trend', tags=['overview'], response_model=MetricTrendOut)
    def metric_trend(comparison_id:UUID, metric:Literal['row_count_match','key_coverage','duplicate_key_rate','row_match_rate','column_match_rate']='row_match_rate',
                     days:int=7, timezone:str=Query('America/Sao_Paulo',max_length=100),
                     left_column:str|None=Query(None,max_length=255),right_column:str|None=Query(None,max_length=255)):
        now,first,last,start=window(days,timezone)
        if metric=='column_match_rate' and left_column is None and right_column is None:
            raise DomainError(422,'validation_error','Choose one column pair for its historical rate.')
        with engine.connect() as conn:
            name=conn.scalar(text('SELECT name FROM engine.comparison_definitions WHERE id=:id'),{'id':comparison_id})
            if name is None:
                raise DomainError(404,'not_found','Comparison not found.')
            daily=daily_rows(conn,[comparison_id],start,now,timezone)
        by_day={r['day']:r for r in daily}
        points=[]
        for n in range(days):
            day=first+timedelta(days=n)
            r=by_day.get(day,{})
            points.append({'day':day.isoformat(),'run_id':r.get('id'),'status':r.get('status'),
                'values':trend_value(metric,r.get('metrics'),left_column,right_column)})
        return json_safe({'comparison_id':comparison_id,'name':name,'metric':metric,'days':days,
            'timezone':timezone,'start_day':first.isoformat(),'end_day':last.isoformat(),'as_of':now,'points':points})
