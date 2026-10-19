# DataQore

Trust your data.

**DataQore** é o nome comercial da aplicação. Sua funcionalidade de análise e
comparação de dados é **ADQ — Advanced Data Quality**. O repositório mantém
o nome `data-qore`; databases e contas de serviço usam o prefixo `dataqore`.

## Início rápido local

```bash
./dataqore.sh
```

Prepara dependências, preserva os arquivos de ambiente e inicia os quatro
serviços em segundo plano. Abra http://127.0.0.1:5173/.
Use `./dataqore.sh status`, `./dataqore.sh logs`, `./dataqore.sh stop` ou
`./dataqore.sh restart`. [Detalhes da inicialização](scripts/README.md).

## Banco de dados — primeira entrega

Scripts PostgreSQL para os databases isolados `dataqore_app` e `dataqore_engine`,
tabelas iniciais, contas `srv_dataqore_app` / `srv_dataqore_engine`, grants e partições
mensais de métricas: [instruções e DDL](database/README.md).

Exemplos de configuração: [controller](controller.env.example) e
[motor](engine.env.example). O inicializador não executa DDL ou migrations.

## Migrations

Prisma 7 no controller e SQLAlchemy/Alembic no motor, com contas dedicadas,
conferência de catálogo e baseline sem recriação das tabelas existentes.
Consulte o [roteiro de migrations](database/MIGRATIONS.md) para provisionar os
migrators, configurar `MIGRATION_DATABASE_URL` e registrar os bancos atuais.

## API do motor ADQ

FastAPI, cinco conectores, perfis e comparações amostrais, fila Postgres e
worker separado. Consulte [instalação, configuração e exemplos](engine/README.md)
e o [OpenAPI do motor](docs/openapi-engine.json).

## App Controller e Web App

BFF NestJS/Fastify com autenticação local e Web App React integrado. Consulte
[configuração e administrador](controller/README.md) e
[inicialização do Web App](web/README.md). Use `./dataqore.sh` para iniciar
motor, worker, controller e Vite, ou os comandos individuais dos guias.

O manual operacional completo fica fora do repositório, em
`/home/biel/analytics-data-quality/docs/DATAQORE_CONFIGURACAO.html`.
