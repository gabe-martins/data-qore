# DataQore — API do motor ADQ

FastAPI para conexões, catálogo, perfis e comparação amostral. O cálculo roda
em um worker Python separado, usando fila no PostgreSQL. A API não conhece
usuários e será acessada pelo futuro App Controller. A CLI antiga permanece
independente; nenhum módulo do serviço depende dela.

## Instalação

Python 3.12, migrations já aplicadas e arquivos locais na raiz do repositório:

```bash
cd /home/biel/analytics-data-quality/data-qore
python3 -m venv engine/.venv
engine/.venv/bin/python -m pip install -r engine/requirements.lock
```

A instalação base inclui PostgreSQL (`psycopg`) e SQLite. Para habilitar os
drivers MySQL, Oracle e SQL Server:

```bash
engine/.venv/bin/python -m pip install -r engine/requirements-connectors.txt
```

Dependências são fixadas; requisitos de sistema dos drivers variam por
plataforma. Um driver ausente não impede usar os demais. `/v1/connectors`
informa os pacotes disponíveis; a conectividade é validada pelo teste da fonte.

## Configuração

Complete `engine.env` na raiz, usando [engine.env.example](../engine.env.example)
como referência. Preserve a configuração de migrations existente.

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | Conta restrita `srv_dataqore_engine` no database `dataqore_engine` |
| `ENGINE_API_KEY` | Segredo interno com ao menos 16 caracteres, compartilhado com o futuro controller |
| `CONNECTIONS_ENCRYPTION_KEY` | Chave Fernet para o payload completo das conexões |
| `CONNECTIONS_ENCRYPTION_KEY_VERSION` | Versão da chave, inicialmente `v1` |
| `SQLITE_ALLOWED_ROOT` | Diretório absoluto permitido para arquivos SQLite existentes |
| `WORKER_HEARTBEAT_SECONDS` | Intervalo de heartbeat; padrão `5` |
| `WORKER_JOB_TIMEOUT_SECONDS` | Tempo total máximo de um run; padrão `600` |
| `WORKER_POLL_SECONDS` | Intervalo de consulta da fila vazia; padrão `1` |

Para gerar uma chave Fernet, execute localmente:

```bash
engine/.venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Guarde o valor em `CONNECTIONS_ENCRYPTION_KEY`. Essa chave é independente da
senha PostgreSQL e da API key. Trocar a chave sem recifrar os dados impede
abrir as conexões salvas. Esta entrega detecta versões diferentes e falha
explicitamente; não implementa rotação automática.

Os comandos localizam `engine.env` pela raiz do projeto. Variáveis do processo
prevalecem; `DATAQORE_ENV_FILE` permite selecionar outro arquivo.
API/worker não usam `MIGRATION_DATABASE_URL` nem executam migrations.

## Iniciar

Em um terminal, a partir da raiz:

```bash
PYTHONPATH=engine engine/.venv/bin/python -m dataqore_engine api
```

Em outro terminal:

```bash
PYTHONPATH=engine engine/.venv/bin/python -m dataqore_engine worker
```

A API escuta em `127.0.0.1:8000`. Abra
[Swagger](http://127.0.0.1:8000/docs) e use **Authorize** para informar a API key.
As rotas `/v1` exigem o header `X-API-Key`. Health checks e documentação local
não contêm configurações ou dados de fontes. Não há CORS habilitado para o
frontend falar diretamente com o motor.

`/health/live` verifica o processo; `/health/ready` verifica acesso ao database,
à tabela de conexões e a identidade restrita da conta de execução.

## Primeiro fluxo

1. Consulte `GET /v1/connectors`.
2. Teste uma configuração com `POST /v1/connections/test` e cadastre-a com
   `POST /v1/connections`. O cadastro não faz teste de rede automaticamente.
3. Consulte schemas e tabelas em `/v1/connections/{id}/schemas` e `/tables`.
4. Registre uma tabela em `POST /v1/datasets`. Metadados são consultados na fonte.
5. Solicite perfil com `POST /v1/datasets/{id}/profile-runs`.
6. Para comparar, registre dois datasets distintos, crie uma definição em
   `POST /v1/comparisons` e execute `POST /v1/comparisons/{id}/runs`.
7. A resposta **202** contém o UUID do run. Acompanhe `GET /v1/runs/{id}` e
   consulte `/result` quando o estado for `succeeded`.

Exemplo de conexão PostgreSQL:

```json
{
  "name": "origem",
  "connector": "postgresql",
  "credentials": {
    "hostname": "SERVIDOR",
    "port": 5432,
    "database": "BASE_ORIGEM",
    "username": "USUARIO_SOMENTE_LEITURA",
    "password": "SUBSTITUIR",
    "sslmode": "prefer"
  }
}
```

Exemplo SQLite, relativo a `SQLITE_ALLOWED_ROOT`:

```json
{"name":"arquivo-local","connector":"sqlite","credentials":{"database":"origem.sqlite"}}
```

Não há upload. O arquivo deve existir no diretório permitido nesta máquina.
Caminhos externos, arquivos ausentes e symlinks que escapem do diretório são
recusados. A abertura usa `mode=ro` e `PRAGMA query_only`.

Oracle usa `database` como service name. SQL Server usa criptografia de
transporte e valida o certificado; `trust_server_certificate: true` permite
configurar explicitamente a exceção para o ambiente pessoal. `sslmode` é a
opção de transporte do conector PostgreSQL. Portas padrão: PostgreSQL 5432,
MySQL 3306, SQL Server 1433 e Oracle 1521.

Registrar dataset:

```json
{"connection_id":"UUID_DA_CONEXAO","schema_name":"public","table_name":"sale"}
```

Criar comparação:

```json
{
  "name": "sales-origem-destino",
  "left_dataset_id": "UUID_DATASET_ORIGEM",
  "right_dataset_id": "UUID_DATASET_DESTINO",
  "mode": "auto",
  "absolute_tolerance": "0",
  "relative_tolerance": "0",
  "sampling_options": {
    "pilot_rows": 64,
    "min_rows": 64,
    "max_rows": 1000,
    "max_cells": 100000,
    "max_sample_bytes": 16777216,
    "proportion_margin": 0.05
  }
}
```

Os modos são `auto`, `matched_keys` e `independent_random`. `sample_size` é
opcional e não pode exceder `max_rows`; o máximo é 10.000 linhas. Os orçamentos
limitam o planejamento, mas os bytes são uma estimativa, e a ordenação
aleatória pode percorrer toda a tabela na fonte.

Listagens usam `limit` (padrão 50, máximo 200) e `offset`. Catálogo consulta
as fontes atuais; datasets/históricos consultam o armazenamento interno.
Use `POST /v1/datasets/{id}/refresh` para atualizar metadados armazenados.
Toda execução coleta metadados e amostras novos, sem reutilizar os resultados
históricos como se fossem atuais.

## Histórico e métricas

O estado operacional (`queued`, `running`, `succeeded`, `failed`) é separado
da conclusão (`compatible_in_sample`, `difference_observed`, `profile_only`,
`inconclusive`). Uma comparação que encontrou diferenças é uma execução
`succeeded`. Um perfil independente nunca afirma correspondência de registros.

`GET /v1/runs/{id}/result` devolve o resultado agregado v4 e o mesmo UUID da
execução. Enquanto não houver resultado concluído, retorna 409. Consultar o
histórico não abre conexões nas fontes.

`GET /v1/datasets/{id}/profiles` lista perfis por coluna, com `run_id`, data e
escopo. Perfis de comparação consideram todas as linhas obtidas na respectiva
fonte; métricas comparativas em alinhamento continuam restritas às chaves comuns
e estão identificadas separadamente no resultado.

`GET /v1/metrics?dataset_id=UUID` aceita `column_name`, `metric_name`,
`from_time` e `to_time`. O período padrão são os últimos 30 dias; datas devem
ter timezone explícito, por exemplo `2026-10-17T00:00:00Z`. São métricas
numéricas finitas, com Decimal serializado como string. Valores não avaliados
são `null`, não zero inventado. Estatísticas temporais continuam no perfil.

Conexões e definições são atualizadas por `PATCH`; `is_active: false` desativa
sem apagar histórico. Credenciais novas substituem o payload inteiro e nunca
são devolvidas pela API, incluindo respostas de validação ou erro.

## Fila e falhas

Cada solicitação cria um run novo. Para repetir uma requisição sem duplicá-lo,
envie o header `Idempotency-Key` com um identificador opaco: mesma chave e mesma
solicitação retornam o run original; reutilização para outro pedido retorna 409.

O run congela opções e seleção de tabelas. Credenciais são resolvidas no início
da execução; uma conexão desativada impede executar o job. Mudanças posteriores
na definição não alteram o run já enfileirado.

Há um worker ativo por database, protegido por advisory lock. Cada job roda em
subprocesso com heartbeat e timeout. Interrupções são registradas como falha e
não são repetidas automaticamente. No próximo início, o worker marca runs que
ficaram `running` como `worker_interrupted`. Um cálculo atrasado não publica
resultado após o run ter sido encerrado.

Resultado, perfis, métricas e conclusão são gravados na mesma transação. Se
faltar uma partição de métricas ou houver outra falha de persistência, toda a
publicação é revertida e o run é marcado como falha. O serviço não cria
partições nem recebe poderes de DDL. A manutenção segue o
[roteiro do banco](../database/README.md#partições-mensais).

Respostas de erro têm `code`, `message` e `request_id`, também disponível no
header `X-Request-ID`. Logs do worker identificam o run e um código estável;
não registram senhas, valores de parâmetros SQL ou registros amostrados.
Não há consultas SQL arbitrárias ou sincronização de dados nesta API.

## OpenAPI e testes

Exportar sem acessar bancos ou precisar dos segredos locais:

```bash
PYTHONPATH=engine engine/.venv/bin/python -m dataqore_engine openapi --output docs/openapi-engine.json
```

O [contrato exportado](../docs/openapi-engine.json) será usado na integração
com o controller. Este serviço continua interno, sem login de usuários.

```bash
# Testes do núcleo e configuração; integrações são puladas sem os binários.
PYTHONPATH=engine engine/.venv/bin/python -m unittest discover -s tests -v

# Integração completa: cria e encerra clusters locais descartáveis.
PYTHONPATH=engine DATAQORE_PG_BIN=/CAMINHO/POSTGRES/bin \
  engine/.venv/bin/python -m unittest discover -s tests -v
```

Os testes não usam arquivos `.env` reais nem aceitam URL de servidor pessoal.
Há integração real PostgreSQL/SQLite, contratos SQL dos cinco adaptadores e
testes de worker, falhas, idempotência, precisão e ausência de dados privados.
MySQL, SQL Server e Oracle ainda precisam de servidores reais para comprovar
a integração completa nesta versão; contratos de consulta não substituem isso.
