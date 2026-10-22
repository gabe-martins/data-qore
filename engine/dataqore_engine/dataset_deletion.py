"""Internal dependency checks and transactional removal of unused datasets."""
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError

from . import models as m
from .storage import DomainError


class DatasetDeletion:
    def __init__(self, engine):
        self.engine = engine

    def comparison_links(self, identifier):
        current = ((m.comparison_definitions.c.left_dataset_id == identifier)
                   | (m.comparison_definitions.c.right_dataset_id == identifier))
        # Frozen sources protect queued, failed and completed comparisons.
        historical_runs = select(m.runs.c.comparison_id).where(
            m.runs.c.kind == "comparison",
            m.runs.c.parameters.contains({"sources": [{"dataset_id": str(identifier)}]})
)
        historical = m.comparison_definitions.c.id.in_(historical_runs)
        return select(m.comparison_definitions.c.id, m.comparison_definitions.c.name,
                      m.comparison_definitions.c.is_active, current.label("current"), historical.label("historical"))\
            .where(current | historical)

    def dependencies(self, identifier, limit, offset):
        with self.engine.begin() as conn:
            conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
            dataset = conn.execute(select(m.datasets.c.id, m.datasets.c.connection_id,
                m.connections.c.name.label("connection_name"), m.datasets.c.catalog_name,
                m.datasets.c.schema_name, m.datasets.c.table_name,
                m.datasets.c.metadata["table_type"].astext.label("table_type"))
                .join(m.connections, m.connections.c.id == m.datasets.c.connection_id)
                .where(m.datasets.c.id == identifier)).mappings().first()
            if dataset is None:
                raise DomainError(404, "not_found", "Dataset not found.")
            links = self.comparison_links(identifier)
            comparison_count = conn.scalar(select(func.count()).select_from(links.subquery()))
            comparisons = conn.execute(links.order_by(m.comparison_definitions.c.name, m.comparison_definitions.c.id)
                                       .limit(limit).offset(offset)).mappings().all()
            reasons = ["dataset_in_use"] if comparison_count else []
            return {"dataset":dict(dataset),"comparisons":{"items":[dict(row) for row in comparisons],
                "total":comparison_count,"limit":limit,"offset":offset},"block_reasons":reasons,"can_delete":not reasons}

    def delete(self, identifier):
        try:
            with self.engine.begin() as conn:
                if conn.scalar(select(m.datasets.c.id).where(m.datasets.c.id == identifier).with_for_update()) is None:
                    raise DomainError(404, "not_found", "Dataset not found.")
                if conn.execute(self.comparison_links(identifier).limit(1)).first() is not None:
                    raise DomainError(409, "dataset_in_use", "This dataset is used by current or historical comparisons.")
                conn.execute(m.datasets.delete().where(m.datasets.c.id == identifier))
        except IntegrityError as error:
            if getattr(error.orig, "sqlstate", None) == "23503":
                raise DomainError(409, "dataset_in_use", "This dataset still has dependencies. Refresh the dependency check.") from None
            raise
        return {"id": identifier, "status": "deleted"}
