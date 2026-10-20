"""Remove a comparison and its terminal execution evidence, never source data."""
from sqlalchemy import func, select, text

from . import models as m
from .storage import DomainError


class ComparisonDeletion:
    def __init__(self, engine):
        self.engine = engine

    def runs(self, identifier):
        return select(m.runs.c.id).where(m.runs.c.comparison_id == identifier)

    def dependencies(self, identifier):
        with self.engine.begin() as conn:
            conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
            comparison = conn.execute(select(m.comparison_definitions.c.id, m.comparison_definitions.c.name,
                m.comparison_definitions.c.is_active).where(m.comparison_definitions.c.id == identifier)).mappings().first()
            if comparison is None:
                raise DomainError(404, "not_found", "Comparison not found.")
            runs = self.runs(identifier)
            active = conn.scalar(select(func.count()).select_from(m.runs).where(
                m.runs.c.id.in_(runs), m.runs.c.status.in_(["queued", "running"])))
            history = {"runs": conn.scalar(select(func.count()).select_from(m.runs).where(m.runs.c.id.in_(runs)))}
            for name, table in (("results", m.run_results), ("column_profiles", m.column_profiles), ("metrics", m.metrics)):
                history[name] = conn.scalar(select(func.count()).select_from(table).where(table.c.run_id.in_(runs)))
            return {"comparison": dict(comparison), "history": history, "active_runs": active, "can_delete": active == 0}

    def delete(self, identifier):
        with self.engine.begin() as conn:
            if conn.scalar(select(m.comparison_definitions.c.id).where(
                m.comparison_definitions.c.id == identifier).with_for_update()) is None:
                raise DomainError(404, "not_found", "Comparison not found.")
            runs = self.runs(identifier)
            if conn.scalar(select(m.runs.c.id).where(m.runs.c.id.in_(runs),
                m.runs.c.status.in_(["queued", "running"])).limit(1)) is not None:
                raise DomainError(409, "comparison_busy", "Wait for queued or running comparisons to finish before deleting.")
            conn.execute(runs.order_by(m.runs.c.id).with_for_update()).all()
            for table in (m.metrics, m.column_profiles, m.run_results):
                conn.execute(table.delete().where(table.c.run_id.in_(runs)))
            conn.execute(m.runs.delete().where(m.runs.c.id.in_(runs)))
            conn.execute(m.comparison_definitions.delete().where(m.comparison_definitions.c.id == identifier))
        return {"id": identifier, "status": "deleted"}
