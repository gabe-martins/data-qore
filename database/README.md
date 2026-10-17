# DataQore — PostgreSQL, primeira entrega

**DataQore** identifica a aplicação; **ADQ — Advanced Data Quality** identifica
a funcionalidade de análise e comparação de dados. Os recursos de infraestrutura
usam `dataqore`, enquanto os schemas permanecem `app` e `engine`.

DDL inicial para PostgreSQL **15 ou superior**, sem extensões obrigatórias.
O PostgreSQL pode continuar no container existente: estes arquivos não criam
containers, não alteram sua configuração e não conectam nas fontes dos clientes.

## Databases e contas

| Database | Schema | Conta da aplicação | Role proprietária sem login |
| --- | --- | --- | --- |
| `dataqore_app` | `app` | `srv_dataqore_app` | `dataqore_app_owner` |
| `dataqore_engine` | `engine` | `srv_dataqore_engine` | `dataqore_engine_owner` |

As contas de execução `srv_dataqore_app` e `srv_dataqore_engine` não são
proprietárias, não pertencem às roles proprietárias e
não possuem poderes de superusuário, criação de databases, roles ou objetos.
Recebem `CONNECT` no próprio database, `USAGE` no próprio schema e
`SELECT, INSERT, UPDATE, DELETE` nas tabelas. Não recebem `TRUNCATE`, `REFERENCES`
ou `TRIGGER`. Para `app.audit_log`, recebem apenas `SELECT, INSERT`.

Os privilégios padrão de `PUBLIC` nos dois databases e nos schemas `public`
são removidos. Assim, uma conta do app não conecta no engine e vice-versa.
Superusuários continuam com acesso administrativo. Não alteramos permissões
de outros databases existentes no seu servidor; eles podem ter acesso por
`PUBLIC` conforme a configuração anterior da instância.

As roles proprietárias ficam reservadas para DDL/migrations. Nesta entrega,
o administrador executa os scripts, que usam `SET LOCAL ROLE` para criar objetos
com o proprietário correto. Os serviços nunca recebem a senha do administrador.
A configuração das contas dedicadas `*_migrator` e do baseline Prisma/Alembic
está no [roteiro de migrations](MIGRATIONS.md). Não usar as contas de execução
para migrations. Os passos abaixo descrevem o provisionamento inicial por DDL;
para um ambiente novo controlado por migrations, seguir o roteiro específico.

## Ordem de execução

1. Conectar ao database `postgres` como administrador e executar
   [00_databases_and_roles.sql](00_databases_and_roles.sql), **com autocommit**.
2. Conectar ao `dataqore_app` e executar [01_app.sql](01_app.sql).
3. Conectar ao `dataqore_engine` e executar [02_engine.sql](02_engine.sql).
4. Ainda no `dataqore_engine`, executar [03_metrics_partitions.sql](03_metrics_partitions.sql).
5. Definir as senhas e executar as verificações abaixo.

Exemplo com cliente `psql` instalado na sua máquina, a partir da raiz do projeto:

```bash
export PGHOST='ENDERECO_DO_SERVIDOR'
export PGPORT='5432'  # substituir pela porta publicada do container
export PGUSER='postgres'  # ou seu administrador

psql -X -W -v ON_ERROR_STOP=1 -d postgres -f database/00_databases_and_roles.sql
psql -X -W -v ON_ERROR_STOP=1 -d dataqore_app -f database/01_app.sql
psql -X -W -v ON_ERROR_STOP=1 -d dataqore_engine -f database/02_engine.sql
psql -X -W -v ON_ERROR_STOP=1 -d dataqore_engine -f database/03_metrics_partitions.sql
psql -X -W -v ON_ERROR_STOP=1 -d postgres -f database/04_verify_access.psql
```

`-W` solicita a senha sem incluí-la nos comandos. É possível usar o `psql`
que já existe no container, fornecendo os arquivos por entrada padrão ou
copiando-os para ele. Em clientes gráficos, selecionar o database correto para
cada arquivo. `04_verify_access.psql` usa comandos específicos do `psql`;
em uma interface gráfica executar os dois blocos SELECT nas conexões indicadas.

Os arquivos `00`, `01` e `02` são de **provisionamento inicial**, não são
idempotentes e devem ser executados somente uma vez sobre databases novos.
Não usar `--single-transaction` no arquivo `00`: `CREATE DATABASE` não pode
rodar em uma transação. Os arquivos `01`, `02` e `03` têm suas próprias
transações. Se o `00` falhar após criar algum objeto, conferir o estado antes
de continuar; não apagar databases para tentar novamente.

### Senhas

Abrir uma sessão administrativa interativa:

```bash
psql -X -W -d postgres
```

Executar dentro do `psql`:

```text
\password srv_dataqore_app
\password srv_dataqore_engine
```

As contas nascem com `PASSWORD NULL`: autenticação por senha só funciona após
esta configuração. A autenticação também depende do `pg_hba.conf` existente;
não usar `trust` para as conexões da aplicação. A porta precisa estar publicada
e acessível pela máquina onde os serviços rodarão.

### Verificação

Todas as linhas da coluna `passed` do arquivo `04` devem ser `true`.
Também testar autenticação de verdade com as duas contas, usando `-W`:

```bash
psql -X -W -h ENDERECO_DO_SERVIDOR -p 5432 -U srv_dataqore_app -d dataqore_app -c 'SELECT current_user, current_database();'
psql -X -W -h ENDERECO_DO_SERVIDOR -p 5432 -U srv_dataqore_engine -d dataqore_engine -c 'SELECT current_user, current_database();'

# As duas tentativas cruzadas DEVEM falhar com permission denied for database:
psql -X -W -h ENDERECO_DO_SERVIDOR -p 5432 -U srv_dataqore_app -d dataqore_engine -c 'SELECT 1;'
psql -X -W -h ENDERECO_DO_SERVIDOR -p 5432 -U srv_dataqore_engine -d dataqore_app -c 'SELECT 1;'
```

## Tabelas

| Schema | Tabela | Finalidade |
| --- | --- | --- |
| app | users | Administrador, hash de senha e ativação |
| app | auth_sessions | Hash dos refresh tokens, expiração e revogação |
| app | audit_log | Eventos e recursos, com detalhes sem segredos |
| engine | connections | Conectores e payload de conexão criptografado |
| engine | datasets | Identificação de schema/tabela e metadados do catálogo |
| engine | comparison_definitions | Duas tabelas, modo, amostragem e tolerâncias |
| engine | runs | Fila e acompanhamento de comparações/perfis |
| engine | run_results | Conclusão e resultado agregado versionado |
| engine | column_profiles | Perfis agregados das colunas por execução |
| engine | metrics | Série temporal numérica, particionada por mês UTC |

UUIDs são gerados com `gen_random_uuid()`, nativo nas versões suportadas.
Datas usam `timestamptz`; databases operam em UTC. `updated_at` deve ser
atualizado explicitamente pela aplicação: não há trigger nesta entrega.
Chaves estrangeiras impedem remover fontes/definições com histórico associado;
conexões e definições podem ser desativadas com `is_active`.

Os runs distinguem estado operacional (`queued`, `running`, `succeeded`,
`failed`) da conclusão de comparação (`compatible_in_sample`,
`difference_observed`, `profile_only`, `inconclusive`). `parameters` conserva
um snapshot das opções e da identificação das fontes, sem credenciais.
Ao finalizar um run, gravar resultado, perfis, métricas e estado final na mesma
transação. O UUID do resultado produzido pelo motor deve corresponder ao run.

JSONB não valida sozinho o conteúdo semântico: o motor validará as opções
de amostragem e o contrato do resultado v4. Antes de persistir, deve excluir
registros, chaves sorteadas, valores de parâmetros SQL, senhas e prévias.
Mínimos/máximos de texto ou datas ficam no perfil JSONB; a série `metrics`
recebe somente valores numéricos finitos. Valor ausente é `NULL`, nunca zero
inventado. Preservar Decimal na serialização; não converter para float.
Denominadores podem acompanhar métricas de taxas e cobertura.

As permissões de escrita referem-se **aos databases internos do DataQore**.
As credenciais usadas para consultar os bancos das fontes são outras e
precisam ser restritas a leitura nesses servidores.

Workspaces, times, papéis adicionais, schedules, baselines e notificações
não são criados nesta primeira entrega; entrarão em migrations próprias.
O administrador da aplicação será criado por comando local na etapa de auth:
não há usuário web ou senha de aplicação predefinidos no SQL.

## Partições mensais

O arquivo `03` prepara o mês anterior, o atual e os três seguintes.
Os índices do pai são propagados para as partições pelo PostgreSQL.
Para manutenção mensal, executar como administrador no `dataqore_engine`:

```sql
BEGIN;
SET LOCAL ROLE dataqore_engine_owner;
SELECT engine.ensure_metrics_partitions(
    date_trunc('month', now() AT TIME ZONE 'UTC')::date, 4
);
COMMIT;
```

A rotina pode ser repetida. O serviço `srv_dataqore_engine` não pode executá-la.
Por enquanto a manutenção é manual; a automação administrativa fica para
depois. Sem partição para a data informada, uma inserção falha explicitamente.
Não há exclusão automática de métricas ou retenção nesta entrega.

## Arquivos .env futuros

Os exemplos [controller.env.example](../controller.env.example) e
[engine.env.example](../engine.env.example) mostram as conexões separadas.
Manter as configurações locais na raiz em `controller.env` e `engine.env`.
Os comandos de migrations já carregam `MIGRATION_DATABASE_URL` desses arquivos;
o carregamento de `DATABASE_URL` pelos serviços será integrado posteriormente.

Substituir host, porta e senha. Caracteres especiais da senha precisam de
percent-encoding na URL. O controller usa `schema=app` para Prisma; o motor
usa o schema `engine` explicitamente em seus modelos SQLAlchemy.

`sslmode=prefer` permite o ambiente pessoal sem TLS. Para acesso que exija
validação de identidade do servidor, configurar certificados e
`sslmode=verify-full`. Não habilitar `require`/`verify-full` sem configurar
TLS no PostgreSQL.

Alterar host/porta/senha no `.env` não requer migration; os serviços deverão
ser reiniciados para recarregar a configuração. Trocar o database aponta para
outro armazenamento e não transfere dados. Alterar uma senha no `.env` não
altera a senha da role no servidor. A chave Fernet é independente da senha
do Postgres; preservar a chave e sua versão, pois trocar a chave sem recifrar
as conexões impede descriptografar os valores existentes.

## Referências

- [CREATE DATABASE e restrição de transação](https://www.postgresql.org/docs/15/sql-createdatabase.html)
- [Privilégios PostgreSQL](https://www.postgresql.org/docs/15/ddl-priv.html)
- [Privilégios padrão por proprietário](https://www.postgresql.org/docs/15/sql-alterdefaultprivileges.html)
- [Particionamento declarativo](https://www.postgresql.org/docs/15/ddl-partitioning.html)
