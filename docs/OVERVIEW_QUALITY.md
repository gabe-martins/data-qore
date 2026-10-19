# Qualidade diária na Overview

O bloco **Quality over time** exibe uma série por comparação atualmente ativa.
O seletor **Period** permite 7, 15 e 30 dias, começando em sete. Os dias seguem
`America/Sao_Paulo`, incluem o dia atual parcial e são atualizados a cada trinta
segundos enquanto a página está visível.

Cada ponto corresponde à última execução finalizada naquele dia, ordenada por
`finished_at` e UUID em caso de empate. Uma última execução com falha ou sem
avaliações deixa uma lacuna: não recupera um sucesso anterior nem exibe zero.
Execuções em fila/em andamento e perfis individuais não entram na série.
O gráfico não conecta os intervalos sem observação.

A qualidade é `passed / evaluated × 100`, usando os checks persistidos daquela
execução; não é média das execuções do dia nem concordância entre fontes.
O tooltip informa horário local, estado, qualidade, cobertura e checks.
A legenda identifica as comparações sem qualidade disponível no período.
**Daily run details** oferece os mesmos dados para teclado e toque.

A escolha do período afeta apenas o gráfico. Cards, atenção e histórico da
Overview mantêm seu cálculo anterior; o contrato `/overview` permanece intacto.

## Contrato

- Motor: `GET /v1/overview/quality-trend?days=7&timezone=America%2FSao_Paulo`.
- Controller: `GET /api/v1/overview/quality-trend`, autenticado, mesmos filtros.
- Dias permitidos: 7, 15 ou 30. Fuso IANA válido; padrão `America/Sao_Paulo`.
- Resposta: período, fuso, instante da consulta e `series` com ID/nome da
  comparação e pontos diários (run, estado, horário, counts e percentuais).
- Percentuais são strings decimais; `null` significa ausência de avaliação.
- A consulta usa somente o banco interno, sem abrir fontes. Não há migration.

## Atualização local

Após obter o código atualizado, execute `./dataqore.sh restart` na raiz do
projeto e atualize o navegador com Ctrl + Shift + R. O inicializador recompila
os serviços e preserva configurações e credenciais existentes. Antes de uma
parada, verifique se há comparações em execução.

## Validação desta entrega

Os testes em PostgreSQL descartável verificaram os três períodos, seleção por
horário de conclusão e UUID, fronteiras de São Paulo e horário de verão,
falhas após sucessos, ausência de avaliações, perfis e comparações desativadas.
As fontes SQLite de teste são removidas antes da consulta, confirmando que o
histórico depende apenas dos agregados persistidos.

Foram aprovados os cinco fluxos Playwright (incluindo tooltip, filtros e tela
estreita), seis testes do controller e quatro de cron no fixture completo.
Os grupos HTTP do fixture usam instâncias separadas do controller para evitar
interferência entre seus limites de autenticação, sem relaxar a configuração
da aplicação. Os builds e testes de conversão percentual também passaram.
