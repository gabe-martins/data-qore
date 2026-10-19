# Agendamento de validações

A entrega agenda **comparações cadastradas**. O controller calcula os horários
e solicita runs à fila existente do motor. Perfis individuais continuam manuais.
Não há comandos shell, `crontab` do Linux ou quinto processo.

## Atualização

Com os bancos já provisionados e baseline registrado:

```bash
cd /home/biel/analytics-data-quality/data-qore
npm ci --prefix controller
npm run prisma:generate --prefix controller
engine/.venv/bin/python tools/migrations.py app status
engine/.venv/bin/python tools/migrations.py app apply
engine/.venv/bin/python tools/migrations.py app verify
./dataqore.sh restart
```

`app apply` usa exclusivamente a URL migrator de `controller.env`. A migration
`1_schedules` acrescenta `app.schedules` e `app.schedule_dispatches`, com owner,
índices, constraints e grants. As migrations iniciais permanecem intactas.
Nenhum processo de execução aplica migrations automaticamente. Instalação nova
segue o fluxo existente em `database/MIGRATIONS.md`, aplicando todas as revisões.

## Uso

1. Cadastre uma comparação e abra **Schedules → New schedule**, ou use
   **Schedules** nos detalhes da comparação.
2. Selecione a comparação e informe um nome.
3. Escolha **Guided** para intervalos de minutos, frequência horária, diária,
   semanal ou mensal, ou **Cron expression** para informar cinco campos.
4. Confira o fuso IANA (padrão `America/Sao_Paulo`) e os três próximos horários.
5. Use **Save schedule**. Pause/resume, edite ou abra **Dispatch history**.
   Um disparo entregue apresenta o link para o run e seu resultado.

| Cron | Comportamento no fuso selecionado |
| --- | --- |
| `*/15 * * * *` | A cada 15 minutos |
| `0 * * * *` | A cada hora, no minuto zero |
| `0 8 * * *` | Todos os dias às 08:00 |
| `30 9 * * 1-5` | Segunda a sexta às 09:30 |
| `0 8 1 * *` | Dia 1 de cada mês às 08:00 |

Campos: minuto, hora, dia do mês, mês, dia da semana. Aceita listas, intervalos,
passos e nomes tradicionais de meses/dias. Domingo é 0 ou 7. Quando ambos
os campos de dia são restritos, vale **dia do mês OU dia da semana**. Meses
sem o dia solicitado são pulados. Não aceita segundos, macros, extensões
Quartz, expressões aleatórias ou comandos. O parser respeita o fuso e suas
transições. O formulário calcula uma expressão real, não um timer separado.
Veja o [parser usado](https://github.com/harrisiirak/cron-parser).

## Execução e recuperação

- O controller verifica vencimentos a cada 15 segundos; esse intervalo é
  distinto da granularidade mínima do cron, que é um minuto.
- Controller, motor e worker precisam estar ativos. Worker desligado mantém
  runs na fila. Depois de uma parada, considera uma ocorrência vencida por
  agendamento; não reproduz todas as ocorrências perdidas.
- Antes do primeiro envio, verifica se a comparação já tem run `queued` ou
  `running`. Nesse caso registra `skipped/comparison_busy`. Essa consulta não
  impede uma solicitação manual concorrente; o worker continua processando
  uma execução por vez.
- Um disparo tem UUID e slot únicos, claim com lease de três minutos e chave
  `schedule:<dispatch UUID>`. Reiniciar ou ter controllers concorrentes não
  gera chaves novas para recuperar o mesmo disparo. O worker mantém sua
  exclusão mútua existente.
- Falhas de transporte/5xx têm até cinco tentativas, com esperas de 30, 60,
  120 e 240 segundos. A chave permanece a mesma. Erros definitivos como alvo
  inexistente ou conexão desativada encerram o disparo; a definição continua
  disponível para correção/pausa.
- Pausar bloqueia ocorrências futuras. Não cancela um envio já iniciado nem
  um run já enfileirado. Um envio de resposta incerta ainda é reconciliado
  com a mesma chave para recuperar seu run, mesmo após pausa/edição.
- A definição da comparação e suas tabelas são congeladas pelo motor ao
  enfileirar, conforme o contrato existente. A tentativa de recuperação
  retorna o run original. O app não consulta o database do motor.
- `pending/dispatched/skipped/failed` representam entrega, separados dos
  estados do run e de suas conclusões analíticas. O histórico não armazena
  credenciais, linhas das fontes ou respostas brutas dos drivers.

## API

Rotas autenticadas: `GET/POST /api/v1/schedules`,
`GET/PATCH /api/v1/schedules/{id}`,
`GET /api/v1/schedules/{id}/dispatches` e
`POST /api/v1/schedules/preview`. Listagens têm paginação. Contratos estão
no OpenAPI do controller e nos tipos gerados do Web App.

Nenhum agendamento de fontes pessoais é criado automaticamente durante a
instalação ou nos testes. O usuário escolhe quais comparações ativar.

## Validação — 18/10/2026

- Quatro testes do agendador aprovados: cron/fusos/DST, entradas inválidas,
  concorrência/recuperação/pausa/limite de tentativas e API com run real.
- Seis regressões do controller e dois fluxos Playwright aprovados em
  PostgreSQL e SQLite descartáveis. O navegador criou um agendamento guiado,
  editou a expressão cron e preservou a escolha de mantê-lo pausado.
- Capturas dos dois modos revisadas. Builds e tipos do controller/Web App,
  configuração Prisma e contrato OpenAPI aprovados.
- Migration validada em banco novo descartável, grants e proprietário
  conferidos, conta de execução impedida de criar tabelas, dados e OIDs
  anteriores preservados e segunda aplicação sem alteração adicional.
- No banco pessoal, conferência antes/depois aprovada, histórico atualizado
  com `1_schedules`, nenhum agendamento/disparo criado e serviços ativos.
