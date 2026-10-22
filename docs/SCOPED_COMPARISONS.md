# Recortes equivalentes e chaves

O contrato atual está no [guia ADQ v6](CRITICAL_METRICS.md).

Use campos de data/hora equivalentes, filtros de lote tipados e pares explícitos
quando os nomes forem diferentes. Intervalos seguem `[início, fim)`. A janela
relativa aceita horas, dias ou meses completos e quantidade inteira positiva.

Todas as etapas usam o mesmo recorte: contagem, validação completa da chave,
seleção por hash e busca dos registros. A chave pode ser composta. Nulos e
duplicidades impedem alinhamento, sem troca automática para outra identidade.

Valores são comparados apenas nas posições selecionadas. As taxas por chave,
linha e coluna são amostrais; contagens e duplicidade da chave cobrem o recorte
inteiro. Metadados e estimativas não substituem contagens completas.
