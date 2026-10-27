# Atualização de dependências — 26/10/2026

Foram consultados os registros oficiais npm e PyPI para selecionar versões
estáveis compatíveis com o aplicativo. As versões diretas e transitivas continuam
fixadas nos manifests e lockfiles existentes.

## Versões atualizadas

| Componente | Antes | Depois |
| --- | --- | --- |
| NestJS (`common`, `core`, `platform-fastify`) | 12.1.3 | 12.2.0 |
| Fastify, transitivo do NestJS | 5.12.5 | 5.12.7 |
| Vite | 8.3.4 | 8.3.5 |
| TanStack React Query | 5.104.4 | 5.105.0 |
| Lucide React | 1.59.0 | 1.61.0 |
| dotenv (Node) | 18.0.8 | 18.0.9 |
| jose | 6.2.12 | 6.2.13 |
| FastAPI | 0.143.3 | 0.162.0 |
| Starlette | 1.8.0 | 1.10.0 |
| SQLAlchemy | 2.1.5 | 2.1.6 |
| Alembic | 1.20.0 | 1.20.1 |
| Databricks SDK | 0.154.0 | 0.157.0 |
| Databricks SQL Connector | 4.7.0 | 4.8.0 |
| pandas | 3.0.6 | 3.1.0 |
| certifi | 2026.7.22 | 2026.10.23 |
| pycparser | 3.11 | 3.12 |
| fast-uri, transitivo de AJV | 3.1.8 | 3.1.9 |

O `fast-uri` 3.1.9 corrige os avisos identificados pelo npm audit, incluindo
[GHSA-w74x-v6f9-j3xg](https://github.com/fastify/fast-uri/security/advisories/GHSA-w74x-v6f9-j3xg),
[GHSA-xhq7-xmqj-769h](https://github.com/fastify/fast-uri/security/advisories/GHSA-xhq7-xmqj-769h),
[GHSA-wjr9-j795-jxcr](https://github.com/fastify/fast-uri/security/advisories/GHSA-wjr9-j795-jxcr) e
[GHSA-333x-w4r6-6crp](https://github.com/fastify/fast-uri/security/advisories/GHSA-333x-w4r6-6crp).
As outras ocorrências desse pacote usam a versão corrigida 4.2.3.

## Compatibilidade

- React/React DOM 19.3.1, Tailwind CSS 4.3.3, Pydantic 2.14.1,
  Uvicorn 0.54.0 e cryptography 50.0.2 já estavam nas versões estáveis atuais.
- Prisma CLI, Client e adapter-pg permanecem alinhados em 7.10.1, a versão
  estável atual. A tag npm `latest` do CLI aponta para `8.0.0-rc.27`, um
  pré-lançamento que não foi adotado.
- TypeScript permanece em 5.9.3 porque `openapi-typescript` 7.13.0 exige
  `typescript: ^5.x`. As versões 6 e 7 não satisfazem esse contrato. O
  [TypeScript 7 também altera a disponibilidade da API do compilador](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
- `python-dateutil` permanece em 2.9.0.post0: Databricks SQL Connector 4.8.0
  exige `>=2.8.0,<3.0.0`. O resolver rejeitou a versão 3.0.0.
- O FastAPI atualizado deixou de aceitar `enum` diretamente em `Query`.
  A declaração passou a usar `json_schema_extra`; a validação dos intervalos
  7/15/30 dias e o documento OpenAPI foram preservados.

## Verificações

- Builds de produção do controller e web; validação e geração do Prisma.
- Geração dos tipos OpenAPI nos dois projetos, sem alteração dos contratos.
- `pip check`, resolução limpa das 56 dependências Python e conferência da
  completude do lockfile base.
- `npm audit` completo em controller e web: zero vulnerabilidades conhecidas.
- `pip-audit` na união dos lockfiles base e opcionais: 56 pacotes,
  zero vulnerabilidades conhecidas.
- Suíte Python com bancos descartáveis: 113 casos cobertos; 111 passaram na
  execução completa e o fixture full-stack passou na reexecução após o ajuste
  do helper descrito abaixo. Um teste de configuração Compose foi ignorado
  porque o CLI Docker Compose não está instalado.
- Fixture full-stack: API, worker, controller e navegador com PostgreSQL e
  SQLite sintéticos; 26 cenários Playwright aprovados, incluindo autenticação,
  permissões, grupos, usuários, comparação, aparência e navegação.

O helper Playwright de tema foi corrigido para usar o menu da aplicação. Ele
recarregava a página após a seleção e descartava a preferência em memória no
cenário com armazenamento bloqueado. As asserções desse cenário foram mantidas.
Os testes unitários do controller e da web também passaram.

Os resultados de auditoria refletem os avisos disponíveis na data acima. Eles
cobrem dependências e não substituem a avaliação de autorização, criptografia,
configuração de produção ou testes de penetração da aplicação.

Para repetir a auditoria npm:

```bash
npm audit --prefix controller
npm audit --prefix web
```

Para Python, una as linhas `nome==versão` de `requirements.lock`,
`requirements-connectors.txt` e `requirements-databricks.lock` em um arquivo
temporário, eliminando duplicatas com o mesmo nome normalizado. Execute
`pip-audit --disable-pip --no-deps -r /caminho/arquivo-temporario` com uma
instalação separada da ferramenta. Essa união garante que o arquivo base
referenciado por `-r` no arquivo de conectores também seja auditado.
