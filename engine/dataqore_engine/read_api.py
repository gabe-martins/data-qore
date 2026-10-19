"""Read models for the UI; never open source connections."""
from datetime import datetime,timedelta,timezone
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from fastapi import Query
from sqlalchemy import select,func,text
from . import models as m
from .storage import json_safe
from .schemas import Page,ComparisonSummaryOut,OverviewOut,QualityTrendOut


def ratio(passed,evaluated,total):
    return {'passed':passed,'evaluated':evaluated,'total':total,
        'percentage':str((Decimal(passed)*100/evaluated).quantize(Decimal('.0001'))) if evaluated else None,
        'coverage_percentage':str((Decimal(evaluated)*100/total).quantize(Decimal('.0001'))) if total else None}


LATEST = """
LEFT JOIN LATERAL (SELECT jsonb_build_object('id',r.id,'status',r.status,
 'requested_at',r.requested_at,'finished_at',r.finished_at,'error_code',r.error_code) AS latest_run
 FROM engine.runs r WHERE r.comparison_id=c.id ORDER BY r.requested_at DESC,r.id DESC LIMIT 1) lr ON true
LEFT JOIN LATERAL (SELECT jsonb_build_object('run_id',r.id,'conclusion',rr.conclusion,
 'finished_at',r.finished_at,'agreement',rr.result#>'{indicators,agreement}',
 'quality',rr.result#>'{indicators,quality,overall}') AS latest_result
 FROM engine.runs r JOIN engine.run_results rr ON rr.run_id=r.id
 WHERE r.comparison_id=c.id AND r.status='succeeded'
 ORDER BY r.requested_at DESC,r.id DESC LIMIT 1) res ON true
"""


def register_read_api(router,engine):
    @router.get('/overview/quality-trend',tags=['overview'],response_model=QualityTrendOut)
    def quality_trend(days:int=Query(7,enum=[7,15,30]),
                      timezone:str=Query('America/Sao_Paulo',min_length=1,max_length=100)):
        from .storage import DomainError
        if days not in (7,15,30):
            raise DomainError(422,'validation_error','Use 7, 15 or 30 days.')
        try:
            zone=ZoneInfo(timezone)
        except (ZoneInfoNotFoundError,ValueError):
            raise DomainError(422,'validation_error','Use a valid IANA timezone.') from None
        now=datetime.now(ZoneInfo('UTC'))
        today=now.astimezone(zone).date()
        start_day=today-timedelta(days=days-1)
        start=datetime.combine(start_day,datetime.min.time(),tzinfo=zone)
        # Rank runs before joining results: a final failure must hide an earlier success.
        with engine.connect() as c:
            rows=c.execute(text("""WITH ranked AS (
                SELECT r.id,r.comparison_id,r.status,r.finished_at,
                    (r.finished_at AT TIME ZONE :zone)::date AS day,
                    row_number() OVER (PARTITION BY r.comparison_id,
                        (r.finished_at AT TIME ZONE :zone)::date
                        ORDER BY r.finished_at DESC,r.id DESC) AS position
                FROM engine.runs r JOIN engine.comparison_definitions cd ON cd.id=r.comparison_id
                WHERE cd.is_active AND r.kind='comparison' AND r.status IN ('succeeded','failed')
                    AND r.finished_at>=:start AND r.finished_at<=:now
            ) SELECT cd.id AS comparison_id,cd.name,r.id AS run_id,r.status,r.finished_at,r.day,
                CASE WHEN r.status='succeeded' THEN rr.result#>'{indicators,quality,overall}' END AS quality
                FROM engine.comparison_definitions cd
                LEFT JOIN ranked r ON r.comparison_id=cd.id AND r.position=1
                LEFT JOIN engine.run_results rr ON rr.run_id=r.id
                WHERE cd.is_active ORDER BY cd.name,cd.id,r.day"""),
                {'zone':timezone,'start':start,'now':now}).mappings().all()
        series={}
        for row in rows:
            item=series.setdefault(row['comparison_id'],{'comparison_id':row['comparison_id'],
                'name':row['name'],'by_day':{}})
            if row['day'] is not None:
                q=row['quality'] or {}
                item['by_day'][row['day']]={'run_id':row['run_id'],'status':row['status'],
                    'finished_at':row['finished_at'],**ratio(int(q.get('passed') or 0),
                        int(q.get('evaluated') or 0),int(q.get('total') or 0))}
        output=[]
        for item in series.values():
            points=[]
            for n in range(days):
                day=start_day+timedelta(days=n)
                point=item['by_day'].get(day,{'run_id':None,'status':None,'finished_at':None,**ratio(0,0,0)})
                points.append({'day':day.isoformat(),**point})
            output.append({'comparison_id':item['comparison_id'],'name':item['name'],'points':points})
        return json_safe({'days':days,'timezone':timezone,'start_day':start_day.isoformat(),
            'end_day':today.isoformat(),'as_of':now,'series':output})

    @router.get('/comparison-summaries',tags=['overview'],response_model=Page[ComparisonSummaryOut])
    def summaries(limit:int=50,offset:int=0,search:str=''):
        from .storage import DomainError
        if not 1<=limit<=200 or offset<0 or len(search)>255:
            raise DomainError(422,'validation_error','Invalid pagination.')
        pattern='%'+search.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
        with engine.connect() as c:
            total=c.scalar(select(func.count()).select_from(m.comparison_definitions).where(m.comparison_definitions.c.name.ilike(pattern)))
            rows=c.execute(text('SELECT c.id,lr.latest_run,res.latest_result FROM engine.comparison_definitions c '+LATEST+
                ' WHERE c.name ILIKE :search ORDER BY c.name,c.id LIMIT :limit OFFSET :offset'),
                dict(search=pattern,limit=limit,offset=offset)).mappings().all()
            ids=[r['id'] for r in rows]
            defs={str(r['id']):dict(r) for r in c.execute(select(m.comparison_definitions).where(m.comparison_definitions.c.id.in_(ids))).mappings()}
        return json_safe({'items':[{**defs[str(r['id'])],'latest_run':r['latest_run'],'latest_result':r['latest_result']} for r in rows],
            'total':total,'limit':limit,'offset':offset})

    @router.get('/overview',tags=['overview'],response_model=OverviewOut)
    def overview():
        now=datetime.now(timezone.utc); start=now.replace(hour=0,minute=0,second=0,microsecond=0)-timedelta(days=6)
        with engine.connect() as c:
            rows=c.execute(text('SELECT c.id,lr.latest_run,res.latest_result FROM engine.comparison_definitions c '+LATEST+' WHERE c.is_active')).mappings().all()
            run_counts=dict(c.execute(select(m.runs.c.status,func.count()).group_by(m.runs.c.status)).all())
            daily=c.execute(text("""SELECT (r.finished_at AT TIME ZONE 'UTC')::date AS day,
                sum((rr.result#>>'{indicators,quality,overall,passed}')::numeric) AS passed,
                sum((rr.result#>>'{indicators,quality,overall,evaluated}')::numeric) AS evaluated,
                sum((rr.result#>>'{indicators,quality,overall,total}')::numeric) AS total
                FROM engine.runs r JOIN engine.run_results rr ON rr.run_id=r.id
                WHERE r.kind='comparison' AND r.status='succeeded' AND r.finished_at>=:start
                GROUP BY 1 ORDER BY 1"""),{'start':start}).mappings().all()
            recent=c.execute(text("""SELECT r.id,r.kind,r.status,r.comparison_id,r.dataset_id,r.requested_at,r.started_at,r.finished_at,
                r.error_code,coalesce(cd.name,d.table_name) AS name,rr.conclusion,
                rr.result#>'{indicators,agreement}' AS agreement
                FROM engine.runs r LEFT JOIN engine.run_results rr ON rr.run_id=r.id
                LEFT JOIN engine.comparison_definitions cd ON cd.id=r.comparison_id
                LEFT JOIN engine.datasets d ON d.id=r.dataset_id
                ORDER BY r.requested_at DESC,r.id DESC LIMIT 20""")).mappings().all()
        passed=evaluated=total=0; conclusions={}; attention=[]
        for row in rows:
            result=row['latest_result']; run=row['latest_run']
            if result:
                q=result.get('quality') or {};passed+=int(q.get('passed',0));evaluated+=int(q.get('evaluated',0));total+=int(q.get('total',0))
            state=('failed' if run and run['status']=='failed' else result['conclusion'] if result else 'not_evaluated')
            conclusions[state]=conclusions.get(state,0)+1
            if state in ('failed','difference_observed','inconclusive'):attention.append({'comparison_id':row['id'],'state':state})
        by_day={r['day'].isoformat():r for r in daily}; trend=[]
        for n in range(7):
            day=(start+timedelta(days=n)).date().isoformat();r=by_day.get(day,{})
            trend.append({'day':day,**ratio(int(r.get('passed') or 0),int(r.get('evaluated') or 0),int(r.get('total') or 0))})
        return json_safe({'active_comparisons':len(rows),'sample_quality':ratio(passed,evaluated,total),
            'latest_conclusions':conclusions,'run_counts':run_counts,'trend':trend,'recent_runs':[dict(r) for r in recent],
            'attention':attention,'as_of':now,'scope':'Latest successful sample per active comparison; trend uses completed comparisons per UTC day.'})
