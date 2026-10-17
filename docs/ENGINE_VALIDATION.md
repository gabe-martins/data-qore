# Validação da API do motor ADQ

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
