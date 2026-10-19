# DataQore — App Controller

NestJS + Fastify e Prisma 7.10.1. Única API usada pelo Web App; conta restrita
`srv_dataqore_app`, schema `app`, separado do armazenamento do motor.

## Preparar

Na raiz do projeto, com Node.js 24 e migrations já aplicadas:

```bash
npm ci --prefix controller
npm run prisma:generate --prefix controller
npm run build --prefix controller
```

O arquivo `controller.env` fica na raiz. Configure `DATABASE_URL`,
`ENGINE_API_URL`, `ENGINE_API_KEY` (mesmo segredo do motor), `JWT_SECRET`
(32+ caracteres aleatórios), `WEB_ORIGIN=http://127.0.0.1:5173`,
`ACCESS_TOKEN_SECONDS=900` e `REFRESH_TOKEN_SECONDS=604800`.
`MIGRATION_DATABASE_URL` pertence somente às ferramentas de migrations.
Variáveis exportadas prevalecem; `DATAQORE_ENV_FILE` seleciona outro arquivo.
Não é necessário usar `source`.

As novas configurações locais foram preenchidas nesta entrega, sem alterar
as URLs dos databases ou a chave Fernet. O administrador inicial foi criado na configuração assistida solicitada pelo
usuário e seu login foi validado. A senha não consta na documentação.
Os comandos interativos abaixo servem para instalações novas e recuperação.

## Verificar o acesso de execução

```bash
npm run db:runtime-check --prefix controller
```

Esse comando consulta somente identidade e quantidade de administradores,
sem alterar o banco ou exibir credenciais. `database_network_unreachable`
indica falha de rota/LAN/VPN; `database_connection_refused` indica serviço ou
porta indisponível. Verifique rede antes de alterar senhas ou grants.
`database_starting_up` (SQLSTATE 57P03) indica inicialização/recuperação do
PostgreSQL; aguarde e confirme uma conexão nova com SELECT 1.
O comando de administrador também distingue esses erros de autenticação,
permissões, schema e TLS, mantendo mensagens dos drivers e URLs em sigilo.

## Administrador

```bash
npm run admin:create --prefix controller
# Recuperação local, quando necessário:
npm run admin:reset-password --prefix controller
```

Os comandos pedem e-mail e senha sem eco, nunca aceitam senha em argumentos.
Criação pede também nome. Use senha de 12–128 caracteres. É permitido somente
um administrador, sem cadastro público. Redefinir senha revoga as sessões.
A conta de banco restrita basta; nenhuma conta administrativa é necessária.

## Executar

```bash
npm run dev --prefix controller
# Ou, após build:
npm start --prefix controller
```

Escuta em `127.0.0.1:3000`. O navegador usa o Vite em
`http://127.0.0.1:5173`, que encaminha `/api` ao controller. Use esse endereço
exato; `localhost` é outra origem. O controller não aplica migrations.

- `/health/live` e `/health/ready`: processo, acesso ao app e conta restrita.
- `/api/openapi.json`: contrato público sem valores secretos.
- `/api/v1/auth/login`, `refresh`, `logout`, `me`, `change-password`.
- Recursos de conexões, catálogo, datasets, perfis, comparações, runs, métricas
  e resumos: `/api/v1/...`, com Bearer token obrigatório.

Access JWT dura 15 minutos e fica na memória do browser. Refresh opaco em
cookie HttpOnly/SameSite=Strict dura até sete dias, com hash no banco,
rotação e detecção de reutilização. Logout revoga a sessão; troca de senha
revoga todas. Operações de autenticação validam Origin; há limite de 20
operações de autenticação por minuto/IP. HTTP e cookies sem Secure são
exclusivos deste ambiente local; publicação em rede não foi preparada.

Mutações remotas nunca são repetidas automaticamente. Em erro de transporte
ao solicitar run, confira histórico ou reutilize a mesma Idempotency-Key.
Auditoria sanitizada é gravada no app; falha ao registrar auditoria é
identificada por request_id no stderr, sem repetir a ação no motor.

## Contratos e testes

```bash
npm run openapi:export --prefix controller
npm run types:generate --prefix controller
npm run types:generate --prefix web
```

O arquivo `docs/openapi-engine.json` gera os tipos do cliente interno e o
contrato do controller. Seus endpoints são registrados individualmente:
não há proxy de caminhos arbitrários. Os payloads de autenticação são
validados no controller; os payloads dos recursos são validados no motor.

Os testes reais são iniciados pelo fixture Python descrito no manual e em
`web/README.md`; não execute contra seu banco pessoal. Sem o indicador
interno do fixture, os testes de integração Node são pulados.
