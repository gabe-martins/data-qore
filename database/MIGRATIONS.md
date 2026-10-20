# DataQore — migrations

Prisma **7.10.1** controla `app` em `dataqore_app`; Alembic **1.20.0** e
SQLAlchemy controlam `engine` em `dataqore_engine`. As revisões iniciais
reproduzem os DDL entregues. Não há reset ou downgrade automático.

## 1. Preparação administrativa

Nos bancos atuais, **não executar novamente `00`, `01` ou `02`**. Execute
somente [05_migration_roles.sql](05_migration_roles.sql) como administrador,
conectado ao database `postgres`. Esse script é repetível e preserva senhas.

| Conta | Database permitido | Role assumida na conexão |
| --- | --- | --- |
| `srv_dataqore_app_migrator` | `dataqore_app` | `dataqore_app_owner` |
| `srv_dataqore_engine_migrator` | `dataqore_engine` | `dataqore_engine_owner` |

Defina senhas distintas em uma sessão administrativa interativa do `psql`:

```text
\password srv_dataqore_app_migrator
\password srv_dataqore_engine_migrator
```

As contas têm `NOINHERIT`, pertencem ao respectivo owner e recebem `CONNECT`
no próprio database. A configuração `role` por database faz **cada conexão
nova** assumir o owner, incluindo as conexões internas do Prisma. Os comandos
conferem `session_user`, `current_user`, database e versão do PostgreSQL.

As contas não recebem superuser, CREATEDB, CREATEROLE ou associação ao outro
owner. Os usuários de execução permanecem restritos. As permissões de outros
databases da instância não são alteradas.

## 2. Configuração local

Preserve `DATABASE_URL` e os demais segredos. Acrescente somente
`MIGRATION_DATABASE_URL` aos arquivos locais da raiz:

`controller.env`:

```dotenv
MIGRATION_DATABASE_URL=postgresql://srv_dataqore_app_migrator:SENHA_URL_ENCODED@HOST:5432/dataqore_app?schema=app&sslmode=prefer
```

`engine.env`:

```dotenv
MIGRATION_DATABASE_URL=postgresql+psycopg://srv_dataqore_engine_migrator:SENHA_URL_ENCODED@HOST:5432/dataqore_engine?sslmode=prefer
```

Use host/porta publicados pelo container, percent-encode das senhas e TLS
conforme seu servidor. Esses valores são independentes das credenciais usadas
pelos serviços. Os arquivos reais `*.env` e `.env*` são ignorados pelo Git;
somente os exemplos são versionados.

Os comandos encontram esses arquivos pela raiz do projeto, independentemente
do diretório atual. `MIGRATION_DATABASE_URL` exportada prevalece sobre o
arquivo; `DATAQORE_ENV_FILE` permite escolher outro arquivo. Não há fallback
para `DATABASE_URL`. Não é necessário usar `source` ou exportar as senhas.

Instale as dependências na raiz do repositório:

```bash
cd /home/biel/analytics-data-quality/data-qore
python3 -m venv engine/.venv
engine/.venv/bin/python -m pip install -r engine/requirements.lock
npm ci --prefix controller
npm run schema:validate --prefix controller
```

O ambiente validado usa Python 3.12 e Node.js 24 LTS. As dependências são
fixadas em `engine/requirements.lock` e `controller/package-lock.json`.

## 3. Baseline dos bancos existentes

Primeiro execute os comandos somente de leitura:

```bash
engine/.venv/bin/python tools/migrations.py app check
engine/.venv/bin/python tools/migrations.py engine check
engine/.venv/bin/python tools/migrations.py app verify
engine/.venv/bin/python tools/migrations.py engine verify
engine/.venv/bin/python tools/migrations.py app status
engine/.venv/bin/python tools/migrations.py engine status
```

`verify` compara o catálogo com `tools/baselines/`: tabelas, colunas, tipos,
defaults, nulabilidade, constraints, índices, owners, grants, roles, triggers
e função de manutenção. As partições devem corresponder a meses UTC; sua
quantidade e meses podem variar. Não são consultados registros do produto.
A leitura do catálogo é feita em uma transação consistente somente de leitura.

Divergências interrompem o procedimento e indicam o caminho do catálogo a
revisar. Não alterar o contrato automaticamente para silenciar diferenças.
Os contratos foram gerados em PostgreSQL 16; diferenças de representação
entre versões também precisam de revisão explícita.

Com as conferências aprovadas:

```bash
engine/.venv/bin/python tools/migrations.py app baseline
engine/.venv/bin/python tools/migrations.py engine baseline
```

`baseline` repete a conferência antes de chamar `prisma migrate resolve
--applied 0_initial` ou `alembic stamp 0001_initial`. O DDL não é reexecutado.
Apenas os controles `app._prisma_migrations` e `engine.alembic_version` são
criados/preenchidos. Seus grants são removidos das contas de execução para
que somente migrators/owners administrem o histórico.

Repetir o baseline com a mesma versão e catálogo inicial é seguro. Um
histórico posterior/diferente é recusado: não há rebaixamento de versão.
Falhas não são tratadas como registro bem-sucedido.

## 4. Migrations pendentes

```bash
engine/.venv/bin/python tools/migrations.py app status
engine/.venv/bin/python tools/migrations.py app apply
engine/.venv/bin/python tools/migrations.py engine status
engine/.venv/bin/python tools/migrations.py engine apply
```

`apply` chama `prisma migrate deploy` ou `alembic upgrade head`. Se houver
tabelas e nenhum histórico, recusa continuar até o baseline. Comandos locais
do mesmo serviço são serializados por advisory lock. Sem migrations novas,
o histórico e os dados permanecem iguais.

Aliases do controller:

```bash
npm run db:check --prefix controller
npm run db:verify --prefix controller
npm run db:status --prefix controller
npm run db:baseline --prefix controller
npm run db:migrate --prefix controller
```

`verify` confere o catálogo esperado para a revisão registrada. Sem histórico,
confere o contrato inicial para adoção do baseline. O motor também possui um
catálogo versionado para `0002_comparison_options`, obtido em PostgreSQL
descartável. Não registre novamente o baseline nem altere os contratos históricos.

A revisão `0002_comparison_options` acrescenta apenas uma coluna JSONB com
padrão vazio e CHECK em `engine.comparison_definitions`. Consulte
[recortes e chaves de negócio](../docs/SCOPED_COMPARISONS.md) antes de atualizar
um ambiente existente. O controller também possui a migration `1_schedules` para agendamentos; o catálogo versionado `app_1_schedules` é selecionado quando ela está aplicada.

## 5. Ambiente novo

O administrador executa `00_databases_and_roles.sql` e
`05_migration_roles.sql`, define as senhas e configura os arquivos locais.
Nesse fluxo, não executar os DDL de tabelas `01`, `02` ou `03`.

Execute `apply` nos dois serviços. As primeiras migrations criam tabelas,
constraints, índices, grants e, no motor, função e partições mensais. Todo
DDL usa o owner correto. Depois, execute `verify`.

Databases e roles são provisionamento administrativo, fora das migrations.
Os DDL antigos permanecem como referência; o SQL das revisões iniciais foi
congelado em arquivos próprios e não depende de ler os DDL administrativos.

## 6. Alterações futuras e partições

- App: criar uma nova pasta ordenada em `controller/prisma/migrations/`,
  com `migration.sql` revisado. Usar `BEGIN`, `SET LOCAL ROLE
  dataqore_app_owner` e `COMMIT`. Manter o schema Prisma sincronizado.
- Motor: gerar revisão com `engine/.venv/bin/python -m alembic -c
  engine/alembic.ini revision --autogenerate -m "descricao"` e revisar antes
  de aplicar. Os modelos ficam em `engine/dataqore_engine/models.py`.
- Revisar manualmente constraints/grants/funções. O schema Prisma não
  representa o índice por `lower(email)` ou todos os CHECKs; o SQL preserva
  esses recursos. Alembic não gera funções, grants ou particionamento.
- Partições e tabelas fora dos modelos são excluídas da comparação automática
  do Alembic. Remover uma tabela exige alteração manual e revisada.
- A manutenção de partições continua com `engine.ensure_metrics_partitions`
  sob `dataqore_engine_owner`, conforme o guia de banco. Não exige nova revisão.
- Não editar revisões aplicadas, usar `db push`, reset ou downgrade nos bancos
  existentes. A baseline Alembic recusa downgrade; correções usam novas revisões.
- Caso seja configurada geração Prisma com shadow database, usar um database
  descartável separado, nunca os bancos pessoais existentes.

## 7. Testes

Testes de configuração (integração é pulada sem os binários PostgreSQL):

```bash
engine/.venv/bin/python -m unittest discover -s tests -v
```

Integração completa com PostgreSQL local:

```bash
DATAQORE_PG_BIN=/caminho/postgresql/bin \
  engine/.venv/bin/python -m unittest discover -s tests -v
```

A suíte inicia um cluster próprio em diretório temporário e porta livre,
provisiona os bancos de teste e remove o cluster ao terminar. Não aceita URL
de servidor existente nem usa credenciais dos arquivos `.env`. O modo `trust`
é exclusivo desse cluster descartável de teste.

São verificados dados/OIDs preservados, repetição, instalação vazia, recusa de
drift, isolamento, grants de tabelas/sequences futuras, proteção do histórico,
precisão Decimal, partições mensais, ausência de DROP de partições na comparação
Alembic e redação de segredos.

Referências: [baseline Prisma 7](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/baselining),
[stamp Alembic](https://alembic.sqlalchemy.org/en/latest/api/commands.html#alembic.command.stamp).

## Databricks e Unity Catalog

A revisão `0003_databricks` mantém os datasets antigos com `catalog_name` vazio,
permite o novo conector e inclui catálogo na identidade única do dataset.
O catálogo esperado `engine_0003_databricks` foi gerado em PostgreSQL descartável.
Use `engine status`, `verify`, `apply` e `verify` pelo roteiro existente;
não repita baseline ou migrations iniciais. Veja [Databricks](../docs/DATABRICKS.md).

## Meta global da Overview

A migration do app `2_environment_settings` cria a configuração persistida da
meta de concordância, inicialmente 95%, com bounds de 0 a 100. A conta runtime
recebe somente SELECT/UPDATE nessa tabela; o owner é `dataqore_app_owner`.
O catálogo `app_2_environment_settings` foi gerado em PostgreSQL descartável.
Use `app status`, `app verify`, `app apply`, `app verify`; não repita baseline.
Não há mudança nas migrations do motor. Consulte `docs/OVERVIEW_QUALITY.md`.
