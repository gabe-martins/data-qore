# Databricks e Unity Catalog

O sexto conector permite selecionar **catalog → schema → tabela/view** em um
SQL Warehouse com Unity Catalog. O fluxo de perfil, comparação e agendamento
é o mesmo das outras fontes. Não há integração com notebooks, clusters,
volumes, streaming tables, views de métricas ou refresh de materialized views.

## Instalação e atualização

Na raiz do projeto, usando o ambiente virtual existente:

```bash
engine/.venv/bin/pip install -r engine/requirements-databricks.lock
engine/.venv/bin/python tools/migrations.py engine status
engine/.venv/bin/python tools/migrations.py engine verify
engine/.venv/bin/python tools/migrations.py engine apply
engine/.venv/bin/python tools/migrations.py engine verify
./dataqore.sh restart
```

A revisão `0003_databricks` permite o novo conector, acrescenta `catalog_name`
aos datasets e inclui catálogo na identidade única da tabela. Datasets antigos
mantêm catálogo vazio, IDs, referências e histórico. Não registre novamente o
baseline nem altere migrations anteriores. O comando `apply` aplica somente as
revisões pendentes; API e worker nunca executam DDL.

Os drivers são opcionais: sem eles, os outros conectores continuam disponíveis.
O lock fixa o SQL Connector 4.7.0, SDK 0.154.0 e dependências transitivas.
PyArrow e CloudFetch não são usados. Nenhuma variável de ambiente adicional é
necessária: credenciais são cadastradas por conexão e criptografadas com a
Fernet já configurada no motor.

## Preparar o acesso Databricks

1. Tenha um SQL Warehouse existente, acessível por HTTPS a partir desta máquina.
2. Em **SQL Warehouses → seu warehouse → Connection details**, copie **Server
   hostname** e **HTTP path**. O hostname não deve incluir `https://`, porta ou
   caminho. O HTTP path tem o formato `/sql/1.0/warehouses/ID`.
3. Use identidade com **CAN USE** no warehouse e somente os privilégios de dados
   necessários: **USE CATALOG**, **USE SCHEMA** e **SELECT** nas tabelas/views.
   Visibilidade de metadados não garante permissão para ler os dados.
4. Para PAT, gere um token Databricks de uma identidade com essas permissões.
   Para OAuth M2M, cadastre um service principal no workspace e gere seu secret
   OAuth Databricks; use client ID e client secret. O formulário não recebe
   senha de usuário nem secret de aplicativo Entra como substituição automática.
5. Não envie tokens e secrets pelo chat. Não conceda permissões de escrita para
   resolver erros de leitura. As primeiras consultas podem iniciar um warehouse
   parado e consumir recursos; inicialize-o antes de testar caso seja necessário.

## Usar o DataQore

### Catálogo aparece, mas os schemas ou tabelas não abrem

Um teste de conexão bem-sucedido executa `SELECT 1`: ele comprova acesso ao
warehouse, mas não verifica acesso às tabelas. Descobrir nomes com `SHOW CATALOGS`
ou `SHOW TABLES` também não comprova permissão de leitura. A interface diferencia
agora a falta de `USE CATALOG` e de `USE SCHEMA`, sem retornar mensagens brutas
do driver.

No SQL Editor do Databricks, usando **a mesma identidade da conexão**, consulte:

```sql
SELECT current_user();
```

Peça ao proprietário dos objetos ou administrador autorizado para executar o
modelo abaixo, substituindo os identificadores e a identidade. Para PAT, a
identidade é o proprietário do token; para OAuth M2M, é o service principal.
Use a identidade retornada acima, não o administrador que executará os grants.

```sql
GRANT USE CATALOG ON CATALOG `SEU_CATALOGO` TO `IDENTIDADE_DA_CONEXAO`;
GRANT USE SCHEMA ON SCHEMA `SEU_CATALOGO`.`SEU_SCHEMA` TO `IDENTIDADE_DA_CONEXAO`;
GRANT SELECT ON TABLE `SEU_CATALOGO`.`SEU_SCHEMA`.`SUA_TABELA` TO `IDENTIDADE_DA_CONEXAO`;
```

Repita os grants de schema e tabela somente para os objetos necessários.
Não é necessário conceder escrita, criar outro token ou recriar a conexão.
Depois, volte ao Catalog do DataQore, selecione novamente a conexão, catálogo e
schema; registre o dataset e execute seu perfil. O Catalog mostra metadados;
estatísticas dos dados aparecem no perfil, sem prévia de registros.

Diagnóstico local em 20/10/2026: a conexão real conseguiu testar o warehouse e
listar objetos em `samples`; consultas ao catálogo `security_incidents` foram
recusadas por ausência de `USE CATALOG`, inclusive uma consulta `LIMIT 0` à
tabela. Nenhum grant foi executado pelo DataQore. Após a liberação pelo usuário,
o perfil real foi validado conforme as evidências ao final deste guia.

Referência: [privilégios do Unity Catalog](https://docs.databricks.com/aws/en/data-governance/unity-catalog/privileges-reference).

## Fluxo de uso

1. Abra **Connections → New connection**, escolha **databricks** e informe nome,
   hostname e HTTP path.
2. Selecione **Personal access token (PAT)** ou **OAuth M2M — service principal**.
   Preencha somente os campos do método escolhido; teste e salve.
3. Em **Catalog**, selecione conexão, **Catalog** e **Schema**. Trocar catálogo
   limpa a seleção de schema. O conector não enumera todas as tabelas de todos
   os catálogos para preencher esse seletor.
4. Confira o tipo de objeto e registre a tabela ou view como dataset. O catálogo
   legado `hive_metastore` não é oferecido nesta entrega. Tabelas
   gerenciadas/externas e seus shallow clones, além de views SQL comuns, são
   suportadas; os outros tipos não entram na listagem.
5. Abra o dataset, atualize metadados quando necessário e configure uma comparação em **Comparisons**.
6. Crie uma comparação com outro dataset, inclusive PostgreSQL, SQL Server ou
   SQLite. O assistente mostra a identidade qualificada do objeto. Em views sem
   PK declarada, escolha uma chave de negócio para alinhar registros; sem chave
   disponível o modo automático usa perfis independentes.
7. Confira mapeamentos, recorte, tolerâncias e amostragem. Chaves informativas
   do Unity Catalog, inferidas ou escolhidas, são validadas em todo o recorte.
   Nulos ou duplicidades tornam a execução inconclusiva, sem concordância entre
   registros. Falhas de acesso/timeout são falhas técnicas, sem resultado parcial.
8. Use **Schedules** para agendar a comparação. Catálogo, schema e tabela são
   congelados no run; as credenciais atuais são resolvidas quando ele começa.

## Precisão e limites

### Detalhes da tabela e perfil

Metadados e perfis consultam `DESCRIBE TABLE EXTENDED catalog.schema.table AS JSON`
uma vez por objeto/operação. São conservados somente formato, tipo de objeto,
tamanho estatístico, criação, colunas de particionamento, estimativa de linhas,
origem e instante da coleta. Localização de armazenamento, SQL de views e
propriedades internas não são persistidos. O comando JSON requer suporte do
warehouse (Databricks Runtime 16.2+); quando não suportado, os detalhes ficam
indisponíveis e o perfil continua usando metadados das colunas.

`estimated_rows` passa a usar `statistics.num_rows`, incluindo zero. Ausência ou
valor inválido não vira zero. Essa é uma estimativa global do otimizador, que
pode estar desatualizada: a data de coleta não é a data da atualização das
estatísticas. O tamanho também vem das estatísticas do catálogo. Não há
`COUNT(*)` nem `ANALYZE TABLE` automáticos para preencher esses campos.

Os campos aditivos ficam em `dataset.metadata.table_details` e em
`result.sources[].table_details` para perfis Databricks. Os contratos JSON
existentes já permitem esses detalhes; não há nova rota nem migration.
Históricos anteriores continuam disponíveis, sem preenchimento retroativo.
Falhas técnicas, como timeout, autenticação ou acesso negado, continuam falhando
a operação com código sanitizado. Apenas comando não suportado ou estatísticas
ausentes/inválidas geram indisponibilidade dos detalhes opcionais.

Na tela do dataset, **Current table details** mostra os metadados atuais;
**Table details captured for this execution** mostra o snapshot do perfil
selecionado. O perfil publica os detalhes atuais na mesma transação dos
resultados, perfis por coluna e métricas, sem substituir uma coleta mais recente.
Uma falha não publica metadados ou resultados parciais.

O planejamento amostral usa a estimativa, preservando seus limites de linhas,
células e bytes. Por exemplo, 40.000 linhas estimadas podem levar ao teto padrão
de 1.000 linhas analisadas; a amostra não é uma contagem integral da tabela.
Datasets continuam podendo ser atualizados por **Refresh metadata**.

Os cards por coluna mostram nulos, brancos, distintos, duplicidades observadas,
comprimentos de texto e limites temporais. Taxas são exibidas em percentual.
Colunas declaradas `STRING`, mesmo quando contêm números ou datas, continuam
texto: não recebem média, mediana ou distribuição numérica por conversão
implícita. A ausência dessas métricas é explicada na interface.

As consultas usam identificadores escapados individualmente e parâmetros
nativos. Decimal não passa por float; parâmetros acima da precisão 38 são
recusados. Binários preservam bytes. `TIMESTAMP`/`TIMESTAMP_LTZ` são lidos em
UTC com offset explícito; `TIMESTAMP_NTZ` preserva horário sem fuso e exige
interpretação explícita ao definir períodos.

Os tipos escalares suportados preservam famílias, precisão e escala. Arrays,
maps, structs, variants, intervals e outros tipos não suportados permanecem nos
metadados como indisponíveis: não são convertidos silenciosamente em texto e
reduzem a cobertura. Células grandes usam os limites existentes de captura.

A leitura Databricks é **best effort**: não há time travel nem snapshot comum
entre consultas ou bancos. Esse aviso aparece nos resultados. Contagens globais
não são estimadas por um `COUNT(*)` adicional; a validação de chaves ainda
percorre todo o recorte. A ordenação aleatória pode percorrer a tabela/view
inteira, mesmo com limite de linhas.

Conexões HTTP e obtenção de token têm timeout de dez segundos por requisição;
consultas usam `STATEMENT_TIMEOUT=30` apenas na sessão. O worker mantém seu
limite global existente. OAuth usa o cache e renovação do SDK com troca de token
HTTP limitada, sem login interativo. PAT, secret e tokens não são retornados,
registrados em logs ou armazenados no navegador. Ao editar, renomear ou pausar
não exige reenviar credenciais; substituí-las exige o payload completo.

## API

- `GET /v1/connectors` inclui `databricks` e disponibilidade do driver.
- `POST /v1/connections` e `/v1/connections/test`: `connector="databricks"` e
  `credentials={hostname,http_path,auth_type,...}`. PAT usa `access_token`;
  OAuth usa `client_id` e `client_secret`, sem misturar métodos.
- `GET /v1/connections/{id}/catalogs` lista catálogos.
- `GET /v1/connections/{id}/schemas?catalog=...` lista schemas.
- `GET /v1/connections/{id}/tables?catalog=...&schema=...` lista objetos e tipos.
- `POST /v1/datasets` recebe `catalog_name`, `schema_name`, `table_name` e
  `connection_id`. Nos conectores antigos, `catalog_name` continua vazio.

O controller expõe as mesmas operações sob `/api/v1`, com autenticação. Não há
acesso direto do navegador ao motor. Comparações Databricks usam resultado v5;
históricos anteriores continuam legíveis.

## Evidências e homologação pendente

### Validação real em 20/10/2026

Com a conexão e o dataset já cadastrados, o perfil
`c3ba570e-8df8-4c49-b46b-61074716686d` terminou com sucesso pela fila/worker:

- Dataset: `security_incidents.bronze.incidents`, 16 colunas.
- Estatísticas publicadas: 40.000 linhas estimadas, 313.604 bytes, formato Delta.
- Amostra efetivamente analisada: 1.000 linhas; 16 perfis de coluna e 333 métricas
  persistidas. Nenhuma célula indisponível ou tipo não suportado na amostra.
- Quinze colunas de texto e um timestamp, sem conversão automática de conteúdo.
- Metadados atuais e snapshot da execução conferidos via API e navegador em
  desktop/390 px, incluindo textos, intervalos temporais e ausência de acesso
  direto do navegador ao motor. A verificação visual usou token temporário em
  memória para uma sessão local já ativa; não validou um novo login pessoal.
- Credenciais das conexões e IDs dos datasets preservados. Catálogo, owners e
  grants da revisão existente conferidos; nenhuma nova migration ou DDL na fonte.

### Validação controlada

A suíte cobriu 138 testes Python: 137 aprovados na execução completa e o cenário
restante de navegador reaprovado isoladamente após corrigir a seleção da tabela
homônima. O fluxo completo aprovado incluiu seis cenários Playwright, seis testes
do controller e cinco do agendador. Builds web/controller e verificação de diff
também passaram. Casos de falha e migrations usaram PostgreSQL descartável.

Contratos PAT/OAuth, renovação, criptografia, ausência do driver, parâmetros,
Decimal, timestamps, tipos complexos, recursos e SQL gerado foram testados com
os pacotes oficiais instalados e transporte simulado. O fluxo HTTP/navegador
usa um SQL Warehouse simulado, persistência PostgreSQL descartável e fonte
SQLite controlada; cobre views, perfis, comparação entre fontes e disparo real
do agendador. Essas evidências simuladas complementam o perfil real acima;
não comprovam comparação ou agendamento em workspace real.

Para completar a homologação, valide ambos os métodos de autenticação com identidade de
leitura, confirme listagem e permissão em dois catálogos, registre uma tabela e
uma view e execute perfil/comparação com recorte limitado. Compare Decimal,
timestamps e binários conhecidos; confira chaves nulas/duplicadas em dados de
homologação previamente preparados e um disparo agendado. Não crie ou altere
dados através do DataQore para fazer essa validação.

Referências: [SQL Connector](https://docs.databricks.com/aws/en/dev-tools/python-sql-connector),
[constraints informativas](https://docs.databricks.com/aws/en/tables/constraints),
[privilégios Unity Catalog](https://docs.databricks.com/aws/en/data-governance/unity-catalog/access-control/privileges-reference).
