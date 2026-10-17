# DataQore

Trust your data.

**DataQore** é o nome comercial da aplicação. Sua funcionalidade de análise e
comparação de dados é **ADQ — Advanced Data Quality**. O repositório mantém
o nome `data-qore`; databases e contas de serviço usam o prefixo `dataqore`.

## Banco de dados — primeira entrega

Scripts PostgreSQL para os databases isolados `dataqore_app` e `dataqore_engine`,
tabelas iniciais, contas `srv_dataqore_app` / `srv_dataqore_engine`, grants e partições
mensais de métricas: [instruções e DDL](database/README.md).

Exemplos de configuração futura: [controller](controller.env.example) e
[motor](engine.env.example). Nenhum script é executado automaticamente.
