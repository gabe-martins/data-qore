# ADQ v6 — cinco métricas Críticas

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
exatidão no navegador. Deixe vazia para gerar uma no enfileiramento. Chaves e
linhas brutas não são persistidas. O scan percorre o recorte inteiro: 10.000 é o
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

Resultados v6 ficam em `run_results`, em `result.metrics`, com os cinco nomes em
snake_case. As consultas de Overview e `/overview/row-match-trend` usam Row Match
Rate ponderada pelos denominadores. A última falha não reutiliza taxas de um
sucesso anterior. Perfis, séries estatísticas, regras de negócio e a meta global
antiga foram retirados dos contratos e do banco. Não há adaptação de resultados
anteriores à reinicialização desta versão.

## Atualização e reinício operacional

As migrations são forward-only: engine `0005_critical_metrics` e app
`3_critical_metrics`. A migration do motor recusa bases operacionais não vazias.
Preserve arquivos de ambiente, chaves e credenciais migrator. Na raiz do projeto:

```bash
./dataqore.sh stop
engine/.venv/bin/python tools/reset_operational_data.py
engine/.venv/bin/python tools/reset_operational_data.py --apply
engine/.venv/bin/python tools/migrations.py engine apply
engine/.venv/bin/python tools/migrations.py app apply
engine/.venv/bin/python tools/migrations.py engine verify
engine/.venv/bin/python tools/migrations.py app verify
./dataqore.sh start
```

**`--apply` apaga conexões, catálogo, comparações, execuções, resultados,
agendamentos, disparos e auditoria anterior; revoga sessões.** Preserva usuário
administrador, senha, arquivos de ambiente, roles, grants e históricos de migrations.
O comando sem `--apply` apenas inspeciona. Cada base é limpa transacionalmente;
se uma etapa falhar, mantenha os serviços parados e repita após corrigir a causa.
Nenhuma fonte é conectada ou modificada pelo reset. A operação é explícita e
nunca acontece durante o launcher ou o worker.

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

### Evidências desta entrega — 21/10/2026

- 89 testes Python aprovados, sem skips na execução com PostgreSQL descartável.
- 14 testes do controller, 1 teste de tolerâncias e 6 fluxos Playwright aprovados.
- Builds TypeScript/Vite aprovados; contratos OpenAPI e clientes regenerados.
- PostgreSQL e SQLite reais descartáveis: inferência de PK com conta SELECT-only,
  recortes, seleção por hash, persistência atômica, falhas e consulta histórica.
- Contratos de consultas dos seis conectores e execução Databricks simulada,
  inclusive disparo agendado. MySQL, SQL Server, Oracle e Databricks não tiveram
  integração com servidores reais nesta entrega.
- Reset aplicado às bases internas configuradas, com contagens operacionais
  zeradas, migrations verificadas e administrador/senha preservados. Serviços
  engine, controller, worker e web reiniciados. Nenhuma fonte foi modificada.
