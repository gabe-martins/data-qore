# DataQore

Trust your data.

**DataQore** é o nome comercial da aplicação. Sua funcionalidade de análise e
comparação de dados é **ADQ — Advanced Data Quality**. O repositório mantém
o nome `data-qore`; databases e contas de serviço usam o prefixo `dataqore`.

## Banco de dados — primeira entrega

Scripts PostgreSQL para os databases isolados `dataqore_app` e `dataqore_engine`,
tabelas iniciais, contas `srv_dataqore_app` / `srv_dataqore_engine`, grants e partições
mensais de métricas: [instruções e DDL](database/README.md).

Exemplos de configuração futura: [controller](controller.env.example) e
[motor](engine.env.example). Nenhum script é executado automaticamente.

## Migrations

Prisma 7 no controller e SQLAlchemy/Alembic no motor, com contas dedicadas,
conferência de catálogo e baseline sem recriação das tabelas existentes.
Consulte o [roteiro de migrations](database/MIGRATIONS.md) para provisionar os
migrators, configurar `MIGRATION_DATABASE_URL` e registrar os bancos atuais.

## API do motor ADQ

FastAPI, cinco conectores, perfis e comparações amostrais, fila Postgres e
worker separado. Consulte [instalação, configuração e exemplos](engine/README.md)
e o [OpenAPI do motor](docs/openapi-engine.json).
