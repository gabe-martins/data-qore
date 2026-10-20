# Concordância e qualidade na Overview

A Overview apresenta dois indicadores distintos:

- **Comparison agreement:** posições amostrais iguais ÷ posições avaliadas × 100.
  Reflete divergências de valores e posições ausentes após alinhamento seguro.
- **Sample quality:** checks de validade aprovados ÷ checks avaliados × 100,
  incluindo tipos, obrigatoriedade, finitude e integridade de chaves.

Valores válidos podem divergir entre bancos. Por isso, uma comparação pode ter
71% de concordância e 100% de qualidade. O indicador principal e **Quality over
time** agora usam concordância. Diferenças de schema continuam nos achados e
conclusões; não recebem penalidade numérica inventada. Sem alinhamento seguro,
a concordância permanece indisponível, sem substituição pela qualidade.

## Execuções e atualização

Os cards usam a última execução finalizada de cada comparação ativa, ordenada
por `finished_at` e UUID. Uma nova execução queued/running não apaga o resultado
concluído. Se a última finalizou com falha ou sem avaliações, não se recupera
silenciosamente um resultado anterior. Execuções manuais e agendadas seguem os
mesmos critérios. O agregado soma as contagens, sem média dos percentuais.

No gráfico, cada comparação tem até um ponto por dia: a última execução
finalizada daquele dia. Filtros de 7, 15 e 30 dias; fuso America/Sao_Paulo e dia
atual parcial. Dias sem avaliação são lacunas nas séries observadas. Perfis e
comparações desativadas não entram. O filtro afeta somente o gráfico.

Overview e gráfico consultam novamente ao abrir/montar a página, voltar à aba e
a cada 30 segundos com a página visível. A API lê apenas agregados persistidos,
sem abrir fontes ou iniciar comparações. O tooltip e **Daily run details**
mostram execução, conclusão, concordância, cobertura e posições iguais/avaliadas.

## Tendência e meta

A linha tracejada **Overall linear trend** é uma regressão linear por mínimos
quadrados no período selecionado. Para cada dia, primeiro somam-se posições
iguais e avaliadas da última execução diária de cada comparação ativa; esse
percentual consolidado é uma observação da regressão. Cada dia avaliado tem o
mesmo peso no ajuste e usa sua distância real em dias, inclusive lacunas.

São necessários pelo menos dois dias avaliados. Não há extrapolação além da
primeira/última observação nem alteração dos pontos originais. A linha ajustada
pode atravessar dias sem execução: é derivada, não uma avaliação nem previsão.
Percentuais calculados fora de 0–100% são preservados na API e recortados apenas
pelo eixo do gráfico. Regressão e percentuais são calculados com Decimal;
a conversão para Number ocorre somente na apresentação.

A linha **Target** é uma referência global, inicialmente 95%. Em **Environment
settings**, o administrador pode definir 0 a 100%, com até quatro casas
decimais. A configuração persiste em `app.environment_settings`, é compartilhada
entre sessões e auditada. Não muda tolerâncias, resultados ou agendamentos.

## Contratos

- `/v1/overview` acrescenta `comparison_agreement` e `evaluated_comparisons`,
  preservando `sample_quality`. Atenção inclui nome da comparação.
- `/v1/overview/quality-trend` aceita `metric=agreement|sample_quality`; o padrão
  continua `sample_quality` para compatibilidade. A web envia `agreement`.
- A resposta acrescenta `overall`, `linear_trend`, `regression_observations`,
  `metric` e conclusão nos pontos. Percentuais são strings decimais ou null.
- O controller expõe os recursos do motor sob `/api/v1`, autenticados.
- `GET/PATCH /api/v1/environment-settings` pertence somente ao controller.
  PATCH recebe `{"comparison_target_percentage":"95.0000"}`. Não usa a
  configuração do navegador nem dá ao controller acesso ao database do motor.

## Atualização local

Na raiz `/home/biel/analytics-data-quality/data-qore`:

```bash
engine/.venv/bin/python tools/migrations.py app status
engine/.venv/bin/python tools/migrations.py app verify
engine/.venv/bin/python tools/migrations.py app apply
engine/.venv/bin/python tools/migrations.py app verify
./dataqore.sh restart
```

A nova migration é **2_environment_settings**. Não altere as iniciais nem
registre baseline novamente. O migrator cria a tabela e sua linha inicial;
a conta de execução recebe somente SELECT/UPDATE nessa tabela, sem DDL,
INSERT ou DELETE. Não há migration do motor nem nova variável de ambiente.
Antes do reinício, aguarde execuções em andamento. A configuração pode ser
alterada depois pela tela, sem reinício.

## Evidências em 20/10/2026

A regressão cobriu 143 testes Python: 142 aprovados na execução completa e o
fluxo de navegador restante reaprovado após selecionar um ponto realmente
avaliado (séries sem alinhamento agora não têm pontos de concordância). O fluxo
completo aprovado incluiu sete testes do controller, seis cenários Playwright
e cinco testes de cron. Foram verificados limites/precisão/persistência/auditoria
da meta, atualização após reload, tooltip e layouts desktop/390 px, além de
owners, grants, constraints e segunda aplicação sem alterações. Builds passaram.

No ambiente pessoal, a migration `2_environment_settings` foi aplicada e a
segunda aplicação não encontrou pendências. Usuários, hashes de senha,
credenciais de conexão, IDs de datasets, definições e schedules foram
comparados antes/depois e preservados. A meta foi inicializada em 95%.

A API real confirmou **71% de concordância** (3.550 posições iguais de 5.000
avaliadas), **100% de validade** e `sales` em Requires attention. O gráfico usa
três dias avaliados na regressão; a fonte não foi aberta para essas consultas.
A verificação visual autenticada em navegador e a edição de configurações
foram realizadas no ambiente descartável. A conferência visual no ambiente
pessoal depende de login normal/autorização específica; não foi criada sessão
fora do fluxo de autenticação sem essa autorização.
