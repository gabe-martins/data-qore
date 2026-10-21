# Amostra SQL Server com mais de um milhão de registros

O gerador administrativo `tools/seed_sqlserver_sample.py` cria somente
`dbo.dataqore_sample_sales`, no database da conexão SQL Server selecionada.
Não modifica as tabelas `Sale`/`SaleItem` nem cadastra datasets automaticamente.
Não faz parte da API: as sessões de leitura das fontes continuam inalteradas.

## Carga e verificação

Na raiz do projeto, usando o ambiente Python e o driver SQL Server existentes:

```bash
engine/.venv/bin/python tools/seed_sqlserver_sample.py --check
engine/.venv/bin/python tools/seed_sqlserver_sample.py --rows 1200000 --batch-size 100000
engine/.venv/bin/python tools/seed_sqlserver_sample.py --check
```

Se houver mais de uma conexão SQL Server ativa, informe `--connection-id UUID`.
O script usa as credenciais já criptografadas, sem imprimi-las. A conta precisa
ter permissão para criar e preencher a tabela. Nenhuma role ou grant é alterado.

Os lotes são confirmados individualmente. Em caso de interrupção, execute o
mesmo comando para retomar. O script verifica uma marca de propriedade e a
sequência das chaves antes de continuar; não adota tabelas sem sua marca e não
executa DELETE, TRUNCATE ou DROP. Reexecutar com o mesmo total não duplica linhas;
informar um total menor não remove dados. Há bloqueio contra cargas simultâneas
desse gerador, limite de 5 milhões de linhas e lote máximo de 100 mil.

## Conteúdo

- `SaleId`: BIGINT, chave primária sequencial.
- `SaleDate`: DATETIME2, período fixo de 21/09/2026 a 20/10/2026.
- `SaleType`, `PaymentMethod`, `Category`, `Region`: categorias sintéticas.
- `SellerId`, `CustomerId`, `Quantity`: identificadores e quantidades fictícios.
- `Amount`: DECIMAL(18,2), sem conversão por ponto flutuante.
- `Notes`: NVARCHAR, com 1% NULL e 1% de textos vazios.

Os dados são determinísticos e totalmente sintéticos; as distribuições não
representam uma população de produção nem constituem uma amostra estatística.

## Resultado observado em 21/10/2026

Carga real autorizada no database `poc_adq`, pela conexão `sql-sales`:
**1.200.000 linhas**, IDs de **1 a 1.200.000**, **12.000 Notes nulas**,
**12.000 Notes vazias**, valores entre **0,00 e 9.999,99**. Os 12 lotes
terminaram em aproximadamente 34 segundos, incluindo a conferência final.

Para usar no DataQore: **Catalog → sql-sales → dbo → dataqore_sample_sales**,
registre o dataset e solicite um perfil. O volume da fonte não altera o limite
amostral configurado no motor: um perfil ou uma comparação amostral não avalia
automaticamente todas as 1,2 milhão de linhas.
