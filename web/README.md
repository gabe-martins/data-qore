# DataQore — Web App

React + Vite + TypeScript, TanStack Query, componentes shadcn/ui baseados em
Radix, ícones Lucide e gráficos Recharts. Interface em inglês, layout baseado
nas dez páginas do PDF de referência e cores de `src/color-system.json`.
As fontes Inter são servidas localmente pelo pacote @fontsource/inter.

## Iniciar

Na raiz, com controller, motor e worker configurados:

```bash
npm ci --prefix web
npm run dev --prefix web
```

Abra **http://127.0.0.1:5173**. Crie antes o administrador pelo comando local
do controller. Nenhuma senha padrão é incluída. O Vite encaminha `/api`
ao controller em 127.0.0.1:3000; o navegador não recebe a API key do motor.

```bash
npm run tokens:generate --prefix web
npm run types:generate --prefix web
npm run build --prefix web
```

O build verifica os tipos e gera `web/dist`. O fluxo desta entrega é local;
publicação, servidor de arquivos e HTTPS não estão incluídos. `preview`
permite conferir localmente o build com o mesmo proxy.

## Fluxo

Connections → New connection → Test → Save. Em Catalog, selecione a fonte e
registre uma tabela. Abra o dataset e use Run profile. Em Comparisons,
escolha dois datasets, configure estratégia, tolerâncias e orçamento amostral;
salve a definição ou execute. O histórico distingue estado de execução da
conclusão analítica. Resultados e Differences contêm agregados; não há
linhas, chaves amostradas, agendamentos, IA ou incidentes.

Tokens de acesso ficam somente na memória. O refresh usa cookie HttpOnly;
credenciais digitadas não são gravadas em localStorage/sessionStorage.
Credenciais salvas não são recuperadas para edição: substituir exige o
payload completo. A configuração de conexão não exibe host/usuário/senha.

## Teste ponta a ponta descartável

Instale o navegador de teste:

```bash
cd web
npx playwright install chromium
cd ..
```

Com binários PostgreSQL instalados em local próprio (sem usar o servidor pessoal):

```bash
PYTHONPATH=engine:tests DATAQORE_PG_BIN=/CAMINHO/POSTGRESQL/bin \
  engine/.venv/bin/python -m unittest discover -s tests -v
```

O fixture cria um cluster temporário, usa portas livres para os quatro
processos e configura um administrador e duas fontes SQLite de teste.
Também executa os testes de autenticação/proxy do controller. Os processos
são encerrados e o cluster é removido ao terminar. Não usa os `.env` reais.
As capturas visuais ficam em `web/test-results/`, ignorado pelo Git.
