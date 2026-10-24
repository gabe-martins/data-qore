# ADQ v7 — comparison quality and record evidence

O motor publica somente Row Count Match, Key Coverage, Duplicate Key Rate,
Row Match Rate e Column Match Rate. Resultados e configurações ficam salvos por
execução. Sucesso técnico não significa aprovação dos dados.

## Configuração

Cadastre conexões e tabelas no Catalog. Em Comparisons, escolha duas fontes,
defina o recorte, confirme os pares de colunas e selecione uma chave de negócio
simples ou composta. Sem chave explícita, o motor procura uma PK/UNIQUE não nula
compatível. A prévia apresenta a sugestão e contagens completas provisórias;
a execução valida a chave no recorte inteiro. Não existe perfil independente.

O recorte pode abranger a tabela inteira, um intervalo fixo ou as últimas N
horas, dias ou meses completos. O fim é exclusivo. Horas exigem timestamp;
dias e meses aceitam DATE. O fuso padrão é America/Sao_Paulo. Timestamps sem
fuso exigem interpretação explícita. Filtros de lote usam os critérios tipados
existentes; não há SQL livre. A janela e a semente são congeladas no enfileiramento.

A amostra usa quantidade inteira entre 1 e 10.000 ou percentual maior que zero
até 100. O percentual é aplicado à maior contagem completa entre as fontes,
arredondando para cima. Não representa percentual da união de chaves.
Solicitações acima de 10.000 ou dos orçamentos de captura são rejeitadas sem
redução silenciosa. Se a união tiver menos chaves, a seleção efetiva será menor.

## Reprodução

O motor percorre somente as chaves do recorte, em lotes, e seleciona as K menores
classificações SHA-256 da união, com canonicalização tipada e uma semente.
Depois busca essas mesmas chaves nas duas fontes. A representação canônica e o
algoritmo são versionados. Não há sorteios SQL independentes.

A mesma semente, configuração e conjunto de chaves reproduzem a seleção; valores
podem mudar. A semente é uma string decimal de 64 bits sem sinal para preservar
exatidão no navegador. Deixe vazia para gerar uma no enfileiramento. O resultado
agregado não contém chaves ou linhas brutas; a evidência v7 separada é cifrada e
expira, conforme descrito abaixo. O scan percorre o recorte inteiro: 10.000 é o
limite da comparação, não de trabalho no servidor ou tráfego das chaves.

## Interpretação

| Métrica | Denominador e alcance |
| --- | --- |
| Row Count Match | Contagens completas A/B, diferença B−A, absoluta e percentual absoluto sobre A. Percentual indefinido se A=0 e B>0. |
| Key Coverage | Duas direções: chaves comuns / chaves observadas no respectivo lado da amostra. |
| Duplicate Key Rate | Excesso de linhas duplicadas / linhas com chave não nula no recorte completo. Nulos e grupos duplicados separados. |
| Row Match Rate | Registros inteiramente iguais / posições avaliadas na amostra; ausências contam como diferença. |
| Column Match Rate | Valores iguais / posições avaliadas por par de colunas; ausências contam como diferença. |

Taxas usam 0–100, numerador, denominador, total, não avaliados e cobertura.
O resumo do resultado destaca correspondência por linha, cobertura e quantidade
de linhas diferentes. As colunas com divergências ou valores desconhecidos
aparecem primeiro. Diferença de volume de 0% significa contagens iguais; taxa de
duplicidade de 0% significa ausência de excesso duplicado, e recebe indicação
própria. Uma avaliação parcial exibe seu denominador e um aviso; uma seleção
vazia permanece não avaliada. O cadastro também resume chave, exclusões, fusos,
tolerâncias e semente sem exigir leitura do JSON técnico.
Denominador zero não gera 100%. Valor desconhecido não é igualdade. Diferença
comprovada em uma linha prevalece sobre outro campo desconhecido; sem diferença
comprovada, a linha parcialmente desconhecida fica fora do denominador.
Colunas sem par ou incompatíveis impedem aprovação integral da linha. Tolerâncias
numéricas são explícitas; texto mantém caixa e espaços.

Volume diferente, nulos/duplicidade na identidade ou divergência comprovada geram
`difference_observed`. Falta de evidência necessária gera `inconclusive`.
`compatible_in_sample` exige volume/chave aprovados e amostra totalmente avaliada
sem diferenças; não certifica igualdade integral.

Snapshots locais não sincronizam bancos distintos. Fontes sem leitura estável
recebem aviso. Agrupamento completo de chaves textuais usa a collation da fonte
e pode invalidar uma identidade de modo conservador.

## API e histórico

O assistente inclui uma etapa **Columns and timezones**. Marque quais colunas
participam em cada fonte e informe a zona IANA de cada timestamp sem fuso quando
necessário (por exemplo, `America/Sao_Paulo` ou `UTC`). Não escolha o fuso pelo
local do navegador: ele deve representar o significado dos valores armazenados.

`comparison_options.excluded_columns` contém listas `left` e `right`. Exclusões
são explícitas e não aparecem em Column Match Rate nem bloqueiam Row Match Rate.
Contagens, filtros e integridade da identidade permanecem completos. Não se pode
excluir uma chave de negócio selecionada ou a PK usada para sugerir identidade;
pares manuais que apontem para uma coluna excluída são rejeitados. Para retirar um
par completo, exclua a coluna de cada fonte. Uma coluna remanescente sem par
continua sendo um impedimento. A captura deixa de materializar colunas excluídas.

`comparison_options.timestamp_timezones` contém mapas `left` e `right`, de nome
de coluna para zona IANA. Exemplo: `{"left":{"SaleDate":"America/Sao_Paulo"}}`.
A opção aplica-se à comparação dos valores mesmo sem recorte temporal. Valores
com offset mantêm o instante registrado; valores sem offset são interpretados na
zona declarada e comparados em UTC, preservando a precisão fracionária. Horários
locais ambíguos ou inexistentes ficam não avaliados. Sem configuração, o motor não
presume equivalência entre timestamps com e sem fuso.

Se a coluna também define o período, essa interpretação preenche o fuso ausente
do recorte no enfileiramento; configurações conflitantes são rejeitadas. O fuso
da janela continua independente da interpretação dos valores. Exclusões e zonas
ficam congeladas na fila e no resultado histórico; editar uma definição não muda
execuções já criadas. Nenhuma configuração ou resultado existente é alterado
automaticamente por essa funcionalidade.

`sampling_options` contém `method` (`rows` ou `percentage`), `rows` (padrão 1000),
`percentage`, `seed`, `max_cells` e `max_sample_bytes`. Use percentual somente no
modo percentage. `comparison_options.scope.period` contém `kind`, colunas left/right,
`unit` e `quantity` na janela relativa, além de fuso e atraso; intervalos fixos
usam start/end. Nomes e tipos completos estão no OpenAPI gerado.

Resultados v6 e v7 ficam em `run_results`, em `result.metrics`, com os cinco nomes em
snake_case. As consultas de Overview e `/overview/row-match-trend` usam Row Match
Rate ponderada pelos denominadores. A última falha não reutiliza taxas de um
sucesso anterior. Perfis, séries estatísticas, regras de negócio e a meta global
antiga foram retirados dos contratos e do banco na simplificação anterior.
Esta atualização preserva os resultados v6; evidências individuais não são
reconstruídas para execuções antigas.

## Comparison Quality — one selected execution

The comparison page is the canonical place for quality investigation. The run
page keeps technical status, frozen configuration and aggregate download, and
links back with `run_id`. The selected run is pinned in the URL independently of
history pagination. Existing readers can open this read-only context without
receiving comparison, connection or execution management permissions.

The section contains summary, quality dimensions, column analysis, divergence
diagnosis and record inspection. Row Match Rate is the main indicator; no
composite score, global cell agreement, statistical profiles or business rules
are added. Compatibility is a frozen-metadata diagnostic without a percentage.
Invalid identities, missing keys and structural blockers are Critical; content
and count differences are Attention. Calculation availability remains separate
from validation status. Technical failures never become zero-valued quality.

Column and record filters/pagination run in the engine database, not the source
systems. The summary excludes the full column metrics, schema and SQL audit;
column details are loaded separately. Overlapping diagnostic categories must not
be added as distinct records. Affected-column filters select evidence containing
a differing or unavailable cell in that pair. Exact key search requires a JSON
array containing every key component in the displayed order, using strings to
preserve numeric precision and text case/whitespace.

## Encrypted sample evidence

Future queued runs freeze capture settings and publish result version 7 with
exactly the same five metric formulas. Result v6 remains readable and unchanged;
its record inspection is Not captured. No source re-reading reconstructs history.

Capture reuses the selected records already read by the engine. It includes equal,
different, one-sided and unknown positions, at most 10,000 positions and 32 MiB of
serialized content per run. Differences and missing records have priority when
limits are reached. Partial capture is explicit and does not change aggregate
metrics. Invalid identity prevents aligned evidence capture.

`EVIDENCE_ENCRYPTION_KEY` is a dedicated Fernet key outside the database. The
launcher creates it once when no evidence exists and refuses to silently replace
a missing key when evidence is present. Preserve it together with the environment
configuration. Each encrypted payload is bound to its run and ordinal; key-search
indexes use an HMAC scoped to the execution. Plaintext rows never enter the
aggregate result, query audit or operational audit.

Evidence expires 30 days after capture. API access is rejected after expiry even
if cleanup is pending. The worker removes up to 1,000 expired records at startup
and every minute. Aggregate metrics and execution configuration remain available.
Deleting a comparison also deletes its evidence transactionally.

All profiles with `results.read`, including Results Viewer, can inspect and export
captured records. The controller audits record reads and exports without values
or search keys. JSON export contains only captured evidence and preserves types,
precision and explicit NULL/empty/whitespace/missing/unavailable distinctions.

Internal resources are rooted at `/v1/runs/{id}/quality`, mirrored under
`/api/v1` by the controller: summary, `/columns`, `/records`,
`/records/{ordinal}` and `/export`. Pages default to 50 items, maximum 100.
Record export is bounded by the run's capture limits and retains the manifest
so a partial sample cannot be mistaken for full-population evidence.

## Upgrade from v6 — preserve operational data

Engine migration `0006_record_evidence` adds the evidence table and indexes.
It does not reset connections, datasets, comparisons, users or history. Wait for
active executions, stop managed services, then run:

```bash
./dataqore.sh stop
engine/.venv/bin/python tools/migrations.py engine apply
engine/.venv/bin/python tools/migrations.py engine verify
./dataqore.sh start
```

The launcher prepares the dedicated evidence key and verifies restricted runtime
access. Do not run the old operational-reset tool during this upgrade.

## Validação

```bash
PYTHONPATH=engine:tests engine/.venv/bin/python -m unittest discover -s tests -v
PYTHONPATH=engine:tests DATAQORE_PG_BIN=/caminho/postgresql/bin \
  engine/.venv/bin/python -m unittest discover -s tests -v
npm run build --prefix controller
npm run build --prefix web
```

A suíte completa usa cluster PostgreSQL descartável, fontes SQLite temporárias,
conta PostgreSQL de fonte somente leitura e navegador com serviços isolados.
Contratos SQL cobrem PostgreSQL, SQLite, MySQL, SQL Server, Oracle e Databricks;
Databricks também usa um SQL Warehouse simulado. A validação real dos demais
conectores depende dos respectivos servidores e drivers.

### Evidências desta entrega — 24/10/2026

- 62 testes Python direcionados aprovados; migration testada também em PostgreSQL
  descartável, incluindo reaplicação, catálogo, grants e limpeza vazia.
- Controller: 6 testes aprovados e 12 de integração não executados nesta rodada.
  Formatação de percentuais: 1 teste aprovado. Navegador: 8 fluxos de execução e
  3 fluxos de apresentação com resultados reais aprovados.
- Builds TypeScript/Vite aprovados; contratos OpenAPI e clientes regenerados.
- Duas novas execuções das comparações existentes, sem criar dados de fonte ou
  cadastros: `sales` com 991/1.000 registros iguais (99,1%) e `sales-dr` com
  301/1.000 (30,1%), incluindo 699 ausências no destino. Cada execução publicou
  1.000 evidências cifradas, conferidas contra os agregados.
- Migration aplicada às bases internas; usuários/senhas, conexões, datasets,
  definições e resultados anteriores conferidos e preservados. Nenhum reset ou
  comando de alteração nas fontes foi executado nesta entrega.
- Não houve nova integração real com MySQL, SQL Server, Oracle ou Databricks;
  não extrapolar estes testes para servidores não utilizados nesta validação.

Read-only browser acceptance can use explicitly selected existing comparisons:

```bash
DATAQORE_EXISTING_RUNS_FILE=/path/to/selected-existing-runs.json \
  npm run test:e2e --prefix web -- quality-existing.spec.ts
```

The manifest lists comparison/run identities and a historical run per comparison.
This acceptance path performs only GET requests and never creates source data,
connections, datasets or comparisons. Its authentication preview is simulated;
all displayed metrics and record values come from the selected saved executions.
