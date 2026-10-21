# Validação da API do motor ADQ

## Issue #7 — interpretação de avaliações — 21/10/2026

As respostas de resultados, perfis e métricas incluem informações tipadas de
disponibilidade: `available`, `partial`, `not_applicable` ou `not_evaluated`,
com código de motivo e contagens existentes. A interpretação é calculada na
leitura dos agregados; não altera fórmulas, conclusões, amostragem ou históricos.

- Perfis individuais não apresentam indicadores de correspondência entre fontes.
- Comparações sem chave apresentam estatísticas descritivas por fonte; chave
  inválida possui diagnóstico distinto da ausência de alinhamento.
- Estatísticas seguem os tipos declarados. Zero, `false`, texto em branco,
  NULL, amostra vazia e captura parcial permanecem distintos.
- Séries obtêm a explicação do perfil da mesma execução/dataset/coluna em uma
  consulta em lote. O teste HTTP verifica limite de quatro SELECTs por página,
  ausência de acessos às fontes e preservação integral do JSON persistido.
- Evidências históricas insuficientes usam `historical_reason_unavailable`;
  os históricos v4/v5 não são regravados nem reexecutados.

Regressão do motor/API: **147 testes aprovados**, incluindo 12 testes específicos
de interpretação e o novo fluxo HTTP em PostgreSQL descartável. Databricks usa
drivers/fontes simulados nesta validação; isto não homologa um workspace real.
O fixture completo também terminou com sucesso: **21 testes de navegador e 14
de controller/agendamentos**, incluindo os dois novos cenários de apresentação,
teclado, capturas desktop/celular, ambos os temas e zero sem substituição.

Reprodução das verificações específicas:

```bash
PYTHONPATH=engine:tests engine/.venv/bin/python -m unittest test_evaluation
PYTHONPATH=engine:tests DATAQORE_PG_BIN=/CAMINHO/POSTGRES/bin \
  engine/.venv/bin/python -m unittest \
  test_api.APITests.test_evaluation_is_read_only_and_metric_reasons_are_batched
```

Os cenários de navegador estão em `web/tests/evaluation.spec.ts` e integram o
fixture `test_full_stack`, com login normal de teste, bancos temporários,
fontes SQLite controladas e Databricks simulado. O manual operacional externo
contém o procedimento de interpretação, na seção 33. Não há nova migration.

## Validação inicial — 17/10/2026

Data: 17/10/2026. Ambiente: Python 3.12, PostgreSQL 16.15, FastAPI 0.143.3,
SQLAlchemy 2.1.5 e psycopg 3.3.6.

**Resultado: 80 testes aprovados.** A execução completa usou clusters
PostgreSQL descartáveis, arquivos SQLite temporários e contas restritas.
Não foram usados servidores pessoais ou credenciais de arquivos `.env` reais.

| Fonte | Evidência nesta entrega |
| --- | --- |
| PostgreSQL | Conexão real de leitura, catálogo, perfil e precisão Decimal |
| SQLite | Fluxo HTTP completo, comparação, perfil, atualização de dados/metadados e abertura somente leitura |
| MySQL | Contratos SQL, parâmetros, limites e preparação de sessão |
| SQL Server | Contratos SQL, projeções temporais/binárias, parâmetros e preparação de sessão |
| Oracle | Contratos SQL, catálogos/constraints, projeções e preparação de sessão |

MySQL, SQL Server e Oracle ainda exigem validação em servidores reais. A
instalação de um driver e testes de contratos não comprovam integração real.

Cobertura adicional:

- 50 regressões portadas do núcleo de cálculo e adaptadores, independentes da CLI.
- Perfil independente com limite final menor que o piloto, expansão e amostra vazia.
- API key, validação sanitizada, criptografia e indisponibilidade de versões da chave.
- Idempotência concorrente, snapshots e coleta de valores/metadados novos por run.
- Exclusão mútua de workers, subprocesso real, timeout, crash e recuperação.
- Recusa de publicação tardia e rollback completo quando falta uma partição.
- Baseline/migrations, preservação de dados, grants e isolamento entre databases.

Também foram verificados: compilação Python, ausência de conflitos de
dependências, autenticação declarada nas operações `/v1` do OpenAPI e ausência
de alterações nas migrations iniciais. O contrato exportado contém 21 caminhos.

Reproduzir a suíte completa:

```bash
PYTHONPATH=engine DATAQORE_PG_BIN=/CAMINHO/POSTGRES/bin \
  engine/.venv/bin/python -m unittest discover -s tests -v
```

Consulte o [guia do motor](../engine/README.md) e o
[OpenAPI exportado](openapi-engine.json).

## Verificação operacional SQL Server — 18/10/2026

Sob autorização do usuário, a conexão SQL Server já cadastrada no servidor
pessoal foi testada com suas credenciais criptografadas. Corrigido o parâmetro
`Connection Timeout`, rejeitado pelo parser de mssql-python 1.16.0; o login
agora usa `connect(..., timeout=10)`.

O servidor usa certificado autoassinado. A exceção `TrustServerCertificate`
foi autorizada e aplicada somente a essa conexão, mantendo `Encrypt=yes`.
Após reiniciar os serviços, os endpoints de teste, schemas e tabelas
retornaram HTTP 200: `SELECT 1` aprovado, um schema e seis tabelas no catálogo.
Nenhum registro das tabelas foi capturado, nem houve alteração na fonte.

Nove testes de segurança/configuração passaram, incluindo o parser real do
driver, caracteres especiais na senha, timeout, validação padrão do
certificado e mensagem sanitizada para certificado inválido. Controller e Web
App compilaram durante a reinicialização. Essa verificação operacional é
separada da suíte descartável descrita acima; perfil e comparação completos
no SQL Server ainda não foram validados nesse servidor.
