# DataQore — regras de qualidade de negócio

Implementação da [issue #15](https://github.com/gabe-martins/data-qore/issues/15).

## Instalação e atualização

A revisão `0004_quality_rules`, posterior à `0003_databricks`, acrescenta uma
configuração JSONB versionada aos datasets. Não edite nem repita o baseline.
Não há novas variáveis, tabelas de fontes ou grants de execução.

No diretório `/home/biel/analytics-data-quality/data-qore`, com as credenciais
migrator já configuradas em `engine.env`:

```bash
engine/.venv/bin/python tools/migrations.py engine status
engine/.venv/bin/python tools/migrations.py engine verify
engine/.venv/bin/python tools/migrations.py engine apply
engine/.venv/bin/python tools/migrations.py engine verify
```

Aguarde os runs ativos antes de reiniciar API, worker, controller e web. O worker
não executa migrations. Preserve os arquivos de ambiente e a chave Fernet.

## Configuração pela interface

1. Entre normalmente e abra **Catalog → dataset**.
2. Em **Business quality rules**, clique em **Add rule**.
3. Informe nome, coluna e tipo de regra; mantenha **Active** para avaliá-la.
4. Configure a regra:
   - **Required field:** NULL reprova. É possível reprovar string vazia e,
     explicitamente, textos compostos somente por espaços. Zero e false são
     valores presentes. O conteúdo não é alterado.
   - **Allowed values:** um valor por linha, preservando espaços e maiúsculas.
     Números são decimais exatos; para booleanos use `true`/`false`. Não há
     conversão de STRING em número ou data.
   - **Numeric / temporal range:** mínimo e/ou máximo, com inclusão de cada
     limite selecionável. Use ponto decimal e datas/timestamps ISO.
   - **Temporal order:** selecione outra coluna temporal do mesmo tipo e a
     relação `<`, `<=`, `>` ou `>=`.
5. Para regras não obrigatórias, escolha **Fail the rule** ou **Skip and report
   as not evaluated** para NULL. O padrão é reprovar.
6. Timestamps sem fuso exigem uma zona IANA, como `America/Sao_Paulo`.
   Instantes locais ambíguos/inexistentes não são aprovados. Valores com fuso
   explícito são comparados como instantes; colunas DATE usam datas civis.
7. Clique em **Save quality rules**. A revisão do conjunto aumenta; a versão
   de uma regra aumenta quando sua definição/nome/ativação muda.
8. Solicite um novo perfil ou comparação e acompanhe em **Runs**.

Há limite de 100 regras por dataset e 200 valores por domínio. Alterações são
validadas contra os metadados registrados. Atualize os metadados pelo controle
existente antes de configurar colunas novas. Em conflito de edição, use **Reload
saved rules** e reaplique a alteração; não sobrescrevemos a configuração de outra
sessão silenciosamente.

## Interpretação dos resultados

**Business quality** aparece no perfil e nos resultados das comparações,
separada dos controles estruturais de tipo/chave e da concordância entre fontes.
Cada regra apresenta versão, estado, aprovados, reprovados, avaliados, não
avaliados e motivos. As definições congeladas podem ser consultadas nos detalhes.

O denominador de cada regra ativa é a quantidade de linhas observadas naquela
fonte. NULL ignorado, valor indisponível ou tipo incompatível não é aprovado e
reduz a cobertura. Uma amostra vazia, conjunto vazio ou somente regras
desativadas não gera qualidade de 100%. Regras desativadas são identificadas e
não entram no indicador agregado.

Uma violação é um achado analítico; o run pode terminar tecnicamente com sucesso
por ter calculado e persistido corretamente uma reprovação. A concordância
entre fontes e os checks estruturais continuam com seus próprios cálculos.
O resultado não garante qualidade integral da população.

## Histórico e agendamentos

A configuração completa é congelada transacionalmente no enfileiramento de
perfis e comparações, inclusive disparos agendados. Um run já enfileirado usa
as regras e versões daquele instante; alterações posteriores valem para novos
runs. Idempotência recupera o mesmo snapshot original.

Remover/desativar uma regra não altera resultados antigos. Históricos anteriores
à funcionalidade mostram que regras de negócio não foram capturadas, sem
reexecução nem aprovação artificial. Resultados v4/v5 recebem um campo aditivo
`indicators.business_quality` com `method_version: 1`; as fórmulas legadas não
são convertidas.

## API e segurança

- `GET /v1/datasets/{id}/quality-rules`: revisão e regras atuais.
- `POST /v1/datasets/{id}/quality-rules`: substitui a configuração com
  `expected_revision` e `rules`; preserva o `id` ao editar uma regra.
- Conflito de revisão: 409. Colunas/tipos/limites inválidos: 422. Dataset
  inexistente: 404.
- O controller expõe as rotas autenticadas em `/api/v1`. Somente ele acrescenta
  a API key interna; alterações são auditadas sem o corpo das regras.

Exemplo de corpo (sem credenciais):

```json
{
  "expected_revision": 0,
  "rules": [
    {"name":"Valor obrigatório","column":"amount","is_active":true,
     "definition":{"kind":"required","reject_blank":true,"whitespace_blank":false}},
    {"name":"Faixa permitida","column":"amount","is_active":true,
     "definition":{"kind":"range","minimum":"0.00","maximum":"999999.99",
       "include_minimum":true,"include_maximum":true,"null_policy":"fail"}}
  ]
}
```

A avaliação ocorre exclusivamente sobre a amostra já capturada: não executa SQL
livre, novas consultas, alterações na fonte ou armazenamento de registros
infratores. Apenas configuração e evidências agregadas são persistidas na mesma
transação dos resultados existentes.

## Validação e disponibilização em 21/10/2026

- 182 testes Python de regressão aprovados: núcleo, API, fila, conectores e
  migrations; os 13 testes de regras foram repetidos no aceite final.
- Aceite com 22 testes de navegador e 14 de controller/agendamentos aprovados,
  usando PostgreSQL descartável, SQLite controlado e Databricks simulado.
- Builds TypeScript/Vite e controller aprovados; contratos regenerados.
- Migration aplicada no ambiente local; catálogo, proprietários e grants
  conferidos. Conexões, datasets anteriores, definições, runs, resultados,
  perfis e métricas comparados antes/depois e preservados.
- API, worker, controller e web reiniciados após a fila ficar vazia. Consulta
  autenticada de configuração das regras aprovada na API local.
- Nenhuma regra foi cadastrada automaticamente e nenhuma fonte pessoal foi
  consultada ou alterada para homologar as regras. A integração real com
  Databricks/SQL Server para estas regras continua dependendo de execução
  explicitamente configurada pelo usuário; simulações não comprovam essa etapa.
