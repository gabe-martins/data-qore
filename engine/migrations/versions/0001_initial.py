"""Schema inicial do motor, funções, grants e partições mensais."""
from pathlib import Path
from alembic import op

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    # SQL congelado da revisão: não ler os DDL administrativos mutáveis.
    script = Path(__file__).with_name("0001_initial.sql").read_text()
    # Alembic usa SQLAlchemy text(): ':' em literais JSON não é um bind.
    op.execute(script.replace(":", r"\:"))


def downgrade():
    raise RuntimeError("A baseline não pode ser removida por downgrade. Use uma migration de correção.")
