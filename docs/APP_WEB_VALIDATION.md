# DataQore — validação do App Controller e Web App

Data: 18/10/2026.

Entrega integrada: controller NestJS/Fastify com Prisma 7.10.1, autenticação
local, proxy explícito do motor e Web App React/Vite em inglês. As telas foram
comparadas visualmente com o PDF fornecido e adaptadas às capacidades atuais,
aplicando os tokens do JSON de cores, com fontes e ícones locais.

## Resultado do aceite

- **82 testes Python aprovados**, incluindo regressões do núcleo, API,
  isolamento, fila, particionamento, preservação de dados e migrations.
- Dentro do fixture integrado: **6 testes do controller aprovados**,
  cobrindo autenticação, cookie, rotação, reutilização, concorrência, logout,
  troca de senha, expiração, limite de tentativas, validação, auditoria,
  precisão Decimal do proxy e indisponibilidade do motor.
- **2 fluxos Playwright aprovados** com os quatro processos reais:
  criação/teste de conexões, catálogo, registro, perfil, assistente de
  comparação, resultado, diferenças agregadas, edição sem reenvio de
  credenciais, histórico, exportação JSON, restauração de sessão e layout
  estreito; comparação sem chave e perfil vazio mantêm conclusões explícitas.
- Criação interativa do primeiro administrador, recusa de segundo e
  redefinição de senha executadas em pseudoterminal no fixture; a saída foi
  verificada para assegurar que a senha de teste não é exibida.
- Builds TypeScript do controller e Web App, validação Prisma e configuração
  compilada aprovados. O Web App carrega páginas sob demanda.
- Capturas revisadas: Overview, Connections, modal, três etapas do assistente,
  detalhes, perfil, resultados, diferenças e layout de 390 pixels.
- Nenhuma migration inicial ou schema foi alterado. API/worker/controller não
  aplicam migrations. O teste usa a conta restrita de cada serviço.

## Ambiente isolado

A suíte criou clusters PostgreSQL 16 em diretórios temporários, portas livres,
roles/databases próprios e arquivos SQLite controlados. Os quatro processos
foram encerrados e o cluster removido ao terminar. Não foram utilizados
servidores ou arquivos de ambiente pessoais nos testes.

As consultas novas `/v1/overview` e `/v1/comparison-summaries` também foram
testadas após remover os arquivos das fontes, demonstrando que os resumos
consultam apenas a persistência interna. Pesquisa literal, paginação,
contagens associadas, cobertura e ausência de valores privados foram conferidas.

## Operação local

`controller.env` recebeu somente novas configurações e a mesma API key do
motor, sem exibição dos segredos ou alteração das URLs existentes. O arquivo
foi protegido com permissão 600. Uma conferência confirmou ausência dos
valores reais nos arquivos versionáveis e no manual HTML.

O primeiro administrador do banco pessoal foi posteriormente criado sob
solicitação explícita do usuário, com senha aleatória e hash Argon2id.
Login real, health checks e proxy autenticado foram validados. A senha foi
entregue ao usuário e não consta neste arquivo. Não existe senha predefinida. Instruções em `controller/README.md`,
`web/README.md` e no manual operacional fora do repositório:
`/home/biel/analytics-data-quality/docs/DATAQORE_CONFIGURACAO.html`.

O ambiente foi preparado para acesso somente em 127.0.0.1, sem publicação,
HTTPS, Docker adicional, times, agendamentos, IA ou armazenamento de diferenças
por registro. As fontes MySQL, SQL Server e Oracle mantêm a situação de
integração descrita em `ENGINE_VALIDATION.md`: a disponibilidade de drivers
não substitui testes de acesso aos servidores reais.
