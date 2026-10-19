# DataQore — recortes equivalentes e chaves de negócio

O assistente permite comparar o mesmo período/lote lógico em fontes com nomes
de colunas diferentes. Os valores continuam sendo comparados por amostragem;
a validação da chave de negócio não se limita à amostra.

## Atualização de um ambiente existente

Execute na raiz do projeto, com os processos parados e sem jobs pendentes:

```bash
cd /home/biel/analytics-data-quality/data-qore
./dataqore.sh stop
engine/.venv/bin/python tools/migrations.py engine status
engine/.venv/bin/python tools/migrations.py engine verify
engine/.venv/bin/python tools/migrations.py engine apply
engine/.venv/bin/python tools/migrations.py engine verify
./dataqore.sh start
```

A revisão `0002_comparison_options` acrescenta uma coluna JSONB com padrão `{}`
e CHECK de objeto em `engine.comparison_definitions`. Não altera as revisões
iniciais, não recria tabelas, não muda grants e não atualiza as definições
existentes. O DDL usa a conta migrator/owner; os processos usam somente a conta
restrita de execução. A aquisição do lock tem limite de cinco segundos e o DDL,
de trinta segundos. Em instalação nova, `apply` executa as duas revisões.
Não registre novamente o baseline em um ambiente já versionado.

## Fluxo na interface

1. **Datasets & scope:** escolha as fontes, o nome e, opcionalmente, um período.
   Associe a coluna de data/hora de cada lado. Configure fuso IANA e interpretação
   explícita de timestamps sem fuso. Acrescente filtros/lotes equivalentes.
2. **Mapping & rules:** confirme os pares sugeridos, escolha correspondências
   manuais e marque uma ou mais colunas como chave de negócio. A estratégia
   independente desabilita a seleção de chave. Configure as tolerâncias numéricas.
3. **Review:** confira a prévia com metadados atuais, limites e colunas sem par.
   A prévia não faz varredura de unicidade. Salve ou enfileire a execução.
4. Nos resultados, confira o recorte congelado, os pares, as contagens agregadas
   de validação da chave e os avisos de consistência. Os detalhes também mostram
   a configuração salva e, em Settings, o contexto da última execução concluída.

Pares manuais têm precedência. Os nomes restantes só são pareados quando não
há ambiguidade, sem reutilizar colunas. Colunas sem par continuam sendo
diferenças de schema. O mapeamento não converte valores nem oculta diferenças
de tipos nativos. Os perfis persistidos mantêm os nomes físicos.

## Contrato e exemplo

Criação, consulta e atualização aceitam `comparison_options`. O PATCH substitui
esse objeto completo; `{}` remove as novas opções e preserva o fluxo anterior.
O endpoint `POST /v1/comparisons/preview` recebe a mesma definição completa de
criação. Pelo controller, use `/api/v1/comparisons/preview`, com autenticação.
Nenhuma chamada do navegador precisa da API key do motor.

Exemplo do campo, para timestamps sem fuso interpretados em São Paulo:

```json
{
  "comparison_options": {
    "mapping": [
      { "left": "order_number", "right": "numero_pedido" },
      { "left": "item_number", "right": "numero_item" },
      { "left": "created_at", "right": "data_criacao" },
      { "left": "amount", "right": "valor" }
    ],
    "business_key": [
      { "left": "order_number", "right": "numero_pedido" },
      { "left": "item_number", "right": "numero_item" }
    ],
    "scope": {
      "period": {
        "left": "created_at",
        "right": "data_criacao",
        "kind": "relative",
        "days": 1,
        "timezone": "America/Sao_Paulo",
        "safety_delay_minutes": 30,
        "left_naive_timezone": "America/Sao_Paulo",
        "right_naive_timezone": "America/Sao_Paulo"
      },
      "filters": [
        { "left": "batch", "right": "lote", "operator": "in", "value": ["B01", "B02"] },
        { "left": "amount", "right": "valor", "operator": "gte", "value": "0.00000000000000000001" }
      ]
    }
  }
}
```

Operadores: `eq`, `in`, `gte`, `lt`, `is_null`, `is_not_null`, sempre combinados
por E. Igualdade/lista são adequadas a lotes. Para nulos, omita o valor.
Igualdade/lista de texto preservam caixa, acentos, composição Unicode e espaços,
independentemente da collation da coluna. Números decimais usam strings com ponto; booleanos usam `true`/`false` JSON.
Datas sem horário usam YYYY-MM-DD também em filtros/listas; timestamps usam
o período, com fuso explícito. Não são aceitos SQL livre, conversões textuais de
tipos incompatíveis, ordenação
de texto por `gte/lt` ou filtros de ponto flutuante. Há no máximo 20 critérios,
100 itens por lista e 800 parâmetros de recorte; buscas por chave repartem os
pedidos para manter o total de parâmetros em até 900 por consulta.

Períodos fixos usam `kind: "fixed"`, `start` e `end`, sem janela relativa.
Datas usam `YYYY-MM-DD`; timestamps da API exigem offset explícito e no máximo
seis casas fracionárias nos limites. A interface oferece dias completos.
O início é inclusivo e o fim exclusivo: `[início, fim)`.

Na janela relativa, o motor subtrai o atraso do instante de enfileiramento,
localiza o início daquele dia no fuso escolhido e volta N dias de calendário.
Dias com horário de verão podem ter 23 ou 25 horas. Limites ambíguos em colunas
sem fuso são rejeitados. Colunas somente de data exigem dias completos e
interpretação equivalente à outra fonte.

O run congela opções, metadados esperados e janela resolvida. A repetição com
a mesma `Idempotency-Key` recupera o run original antes de calcular outra janela,
mesmo se houver espera na fila ou edição posterior da definição. A prévia é
provisória; não reserva uma janela para a execução futura.

## Segurança da conclusão

- Uma chave explícita precisa pertencer aos pares efetivos e ter tipos
  compatíveis. Não exige PK/UNIQUE e não pode ser usada com perfis independentes.
  Nesta etapa aceita inteiros, decimais, texto, binário e UUID; tipos temporais
  e ponto flutuante não são aceitos como identidade entre fontes.
- A varredura de chaves textuais usa a igualdade nativa da fonte: uma collation
  que agrupa caixa/acentos/espaços pode invalidar a chave de forma conservadora.
  Isso gera aviso explícito. As buscas por chave e a comparação dos valores
  preservam o conteúdo exato, sem normalização.
- Consultas agregadas contam linhas, nulos em qualquer componente e grupos
  duplicados em todo o recorte de cada fonte, sem trazer os valores das chaves.
- Nulos/duplicidades impedem o alinhamento: o run termina tecnicamente com
  sucesso, mas sua conclusão é **inconclusive**, sem concordância entre registros.
  Se a chave ficar indisponível ou mudar durante a leitura, a conclusão também
  é inconclusiva, com motivo explícito. Nenhuma chave alternativa é escolhida.
- Piloto, expansão, validação e buscas por chaves usam o recorte. A busca combina
  `recorte AND (chave1 OR chave2 ...)`; estimativas globais não são contagens do
  recorte e ficam indisponíveis nos resultados filtrados.
- Mudança nos metadados após o enfileiramento gera `source_schema_changed`.
  Falhas de acesso/timeout permanecem falhas técnicas. A publicação continua
  atômica: resultado, perfis, métricas e conclusão são confirmados juntos.
- Linhas, chaves sorteadas e valores de parâmetros SQL não são persistidos nos
  resultados ou logs. Os critérios fornecidos pelo usuário fazem parte da
  configuração e do snapshot do run, conforme o contrato.

## Consistência e particularidades das fontes

PostgreSQL usa REPEATABLE READ/READ ONLY; Oracle usa transação READ ONLY;
SQLite abre o arquivo somente para leitura e mantém transação estável apenas
quando ele já usa WAL. Nos outros modos, executa com aviso e não mantém uma
transação longa que impeça o commit de escritores. O journal mode não é alterado. MySQL usa
REPEATABLE READ e snapshot consistente, mas só informa garantia estável para
InnoDB. A sessão MySQL lê TIMESTAMP em UTC: configure interpretação **UTC**
para essas colunas. DATETIME continua exigindo seu fuso de interpretação.

SQL Server só usa SNAPSHOT se a opção já estiver habilitada no database. Caso
contrário, executa com aviso de leitura sem snapshot estável, preservando os
timeouts. O serviço não habilita opções no servidor nem adota isolamento com
mais bloqueios. Mesmo com snapshots locais, não há sincronização entre bancos.
As contas das fontes devem ter somente permissões de leitura.

No SQLite, colunas de período precisam ter tipo declarado DATE/TIMESTAMP ou
equivalente reconhecido. Datas usam ISO `YYYY-MM-DD`; timestamps usam
`YYYY-MM-DD HH:MM:SS` ou `T`, com até seis casas fracionárias e timezone
coerente com o tipo declarado. Valores não canônicos falham explicitamente com
`source_scope_encoding_invalid`, sem truncamento silencioso ou resultados
parciais. Funções de leitura locais validam esses valores; não criam objetos no
arquivo. Consultas SQLite têm prazo de trinta segundos, além do limite do worker.
Filtros decimais SQLite comparam representações numéricas exatas com o critério
Decimal, sem arredondar seu limite para float. Isso preserva a precisão do
critério; não recupera precisão já perdida ao armazenar um número no SQLite.

As verificações completas de chave e a ordenação aleatória podem percorrer o
recorte inteiro no servidor. O orçamento amostral limita o materializado,
não o trabalho das consultas.

Resultados com novas opções usam formato 5. Sem opções, o formato e comportamento
v4 continuam disponíveis; o frontend lê os históricos anteriores.

Referências de consistência: [MySQL: consistent reads](https://dev.mysql.com/doc/refman/8.0/en/innodb-consistent-read.html),
[SQL Server: SNAPSHOT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-transaction-isolation-level-transact-sql?view=sql-server-ver17).


## Evidências de validação — 19/10/2026

- **123 testes Python aprovados**, incluindo regressões do núcleo, fila,
  publicação atômica, API, segurança, isolamento de contas e migrations.
- **6 testes do controller**, **4 fluxos Playwright** e **3 testes de conversão
  de tolerância** aprovados. Builds TypeScript/Vite do controller e Web aprovados.
- Recortes testados com limites inclusivo/exclusivo, horário de verão, atraso,
  instantes representados em outro fuso, congelamento e repetição idempotente.
- Duplicidades/nulos em todo o recorte, colunas sem par, tipos incompatíveis,
  mudança de schema e indisponibilidade da chave bloqueiam conclusões indevidas.
- PostgreSQL e SQLite descartáveis: comparação com nomes distintos, chave composta,
  manutenção de nomes físicos, snapshot estável comprovado (SQLite já em WAL) diante de uma escrita
  concorrente de teste e conta da fonte limitada a SELECT.
- Filtros textuais exatos comprovados em PostgreSQL/SQL Server reais com SELECT
  sobre constantes: caixa, acentos, composição Unicode e espaços. SQL Server
  também distingue NUL e o caractere sentinela. PostgreSQL descartável inclui
  preenchimento de CHAR; SQLite inclui collation NOCASE e chaves em caixa distinta.
- Contratos SQL dos **cinco conectores** testados com drivers simulados: binding,
  agrupamento de OR, limites de parâmetros, agregações e modos de consistência.
  MySQL e Oracle não tiveram integração real nesta entrega.
- PostgreSQL ↔ SQL Server reais já cadastrados: leitura controlada em tabelas
  pequenas, recorte por quatro chaves, duas linhas amostrais por fonte, validação
  completa do recorte e resultado formato 5 compatível na amostra. Somente SELECT;
  nenhum dado/resultado de teste foi gravado. PostgreSQL usou snapshot estável;
  SQL Server operou com aviso de leitura best effort, sem habilitar configurações.
- Migration em PostgreSQL descartável: instalação nova, preservação de dados/OIDs,
  grants, ownership, CHECK, ausência de DDL para runtime e segunda aplicação sem
  alterações. O catálogo versionado também foi conferido após aplicação no banco
  local, que passou de 0001_initial para 0002_comparison_options.
- SQLite com journal padrão: escrita concorrente não é bloqueada por uma
  transação longa do leitor; com WAL pré-existente, snapshot estável preservado
  durante commit concorrente, sem alterar a configuração da fonte.
- Capturas desktop/mobile do assistente, prévia e resultado conferidas. Navegação
  por teclado e toque, edição/reabertura e ausência de chamadas diretas ao motor
  validadas. O manual HTML externo teve âncoras e ausência de segredos verificados.

Reprodução da suíte com binários PostgreSQL descartáveis:

```bash
PYTHONPATH=engine:tests DATAQORE_PG_BIN=/caminho/postgresql/bin \
  engine/.venv/bin/python -m unittest discover -s tests -v
node --experimental-strip-types web/unit/tolerances.test.ts
npm run build --prefix controller
npm run build --prefix web
```

A suíte completa inicia os serviços de teste e executa controller/Playwright.
Ela não lê os arquivos produtivos nem aceita um servidor pessoal como destino
para testes destrutivos. A leitura real entre fontes foi uma verificação manual
separada; seus valores de chave ficaram somente em memória.


## Arquivos principais para revisão

| Área | Arquivos | Comportamento |
| --- | --- | --- |
| Configuração tipada | `engine/dataqore_engine/comparison_options.py`, `schemas.py` | Critérios, períodos, fuso, pareamento e validação de tipos |
| Cálculo e fontes | `engine/dataqore_engine/core/comparison_engine.py`, `db_adapters.py`, `quality.py`, `connectors.py` | Recorte em todas as etapas, chave completa, leitura estável e comparação textual exata |
| API e fila | `engine/dataqore_engine/api.py`, `jobs.py`, `models.py` | Prévia, configuração persistida, snapshot idempotente e resultado v5 atômico |
| Migration | `engine/migrations/versions/0002_comparison_options.py` | Coluna JSONB e CHECK, sem modificar a inicial |
| Catálogo esperado | `tools/catalog.py`, `tools/migrations.py`, `tools/baselines/engine_0002_comparison_options.json` | Verificação da revisão atual e dos grants/owners |
| Controller e contratos | `controller/src/app.ts`, `controller/src/engine-api.d.ts`, `docs/openapi-*.json`, `web/src/api-schema.d.ts` | Prévia autenticada via proxy e mensagens públicas, sem acesso ao banco do motor |
| Assistente e resultados | `web/src/components/ComparisonOptionsEditor.tsx`, `web/src/pages/Comparisons.tsx`, `Runs.tsx`, `styles.css` | Três etapas, revisão legível, edição, recorte congelado e avisos |
| Testes | `tests/test_scoped_comparisons_core.py`, `test_api.py`, `test_migrations.py`, `test_full_stack.py`, `web/tests/flow.spec.ts` | Regressões, persistência, drivers e fluxo real no navegador |
| Operação | `database/MIGRATIONS.md`, `engine/README.md`, este guia | Atualização e limites da entrega |

O manual HTML operacional também foi atualizado fora do Git em
`/home/biel/analytics-data-quality/docs/DATAQORE_CONFIGURACAO.html`, seção 23.
