# DataQore com Docker Compose

Instalação nova para um servidor pessoal Linux Intel/AMD de 64 bits, acessível
por HTTP na rede local. Execute os comandos **no servidor**, a partir da raiz
do projeto. É necessário Docker Engine com Compose v2.24 ou posterior, acesso
à internet para baixar imagens/dependências e uma porta TCP livre.

## Primeira instalação

Escolha um IP estável ou hostname resolvível pelos computadores da rede. Neste
exemplo, o servidor é `192.168.1.50` e a porta publicada é `8080`:

```bash
./docker.sh setup http://192.168.1.50:8080
./docker.sh up
./docker.sh admin
```

`setup` usa a imagem Python para gerar `.env.docker` com permissão `0600`;
não precisa instalar Python ou Node no servidor. O arquivo contém senhas
independentes, segredo da API interna, assinatura JWT e chaves Fernet.
Executar `setup` novamente preserva o arquivo existente, inclusive o endereço.
`docker.env.example` é apenas uma referência dos campos disponíveis.

`up` constrói as imagens, aguarda o PostgreSQL, executa e confere as migrations
e inicia os serviços. Ao final, verifica imports dos drivers, saúde das APIs,
arquivos compilados, rotas da SPA e proxy Nginx, sem consultar fontes cadastradas.
`admin` pede nome, e-mail e senha em um terminal
interativo, sem exibir a senha. Não existe conta padrão. Depois, abra
`http://192.168.1.50:8080` no navegador e faça login.

O PostgreSQL cria os bancos `dataqore_app` e `dataqore_engine`, owners,
contas de execução e migrators pelos scripts administrativos `00` e `05`.
As tabelas são criadas pelas migrations Prisma/Alembic existentes. Os scripts
antigos `01`, `02` e `03` não são executados nesse fluxo. Se uma migration
falhar, engine, worker e controller não são iniciados.

## Configuração e fontes

Somente a porta web é publicada. Nginx serve os arquivos compilados e encaminha
`/api/` ao controller, preservando a origem usada pela autenticação.
Controller, engine, worker e PostgreSQL usam a rede privada do Compose.
Nenhuma porta desses serviços é publicada no host.

Para mudar o endereço, edite **ambos** `WEB_ORIGIN` e `WEB_PORT` em
`.env.docker` e execute `./docker.sh up`. Use a origem exata, sem barra final,
por exemplo `http://dataqore.lan:8080`. `WEB_BIND_ADDRESS` controla em qual
interface do servidor a porta é publicada; o padrão `0.0.0.0` aceita acesso
pela rede. Em HTTP na porta 80, use `WEB_ORIGIN=http://dataqore.lan` e
`WEB_PORT=80`. Permita a porta escolhida no firewall da sua rede.

A configuração Docker é independente de `engine.env`, `controller.env` e
dos bancos da instalação local. As credenciais administrativas e de migrations
não são entregues aos processos de execução da aplicação. Os dois bancos
internos usam um volume nomeado `<projeto>_postgres-data`.

A imagem do engine/worker inclui os clientes PostgreSQL, SQLite, MySQL,
Oracle, SQL Server e Databricks. Os servidores das fontes continuam externos;
cadastre suas conexões pela interface. Dentro do container, `localhost`
identifica o próprio container: para uma fonte na rede, informe o IP ou
hostname real do servidor dessa fonte. Nenhuma fonte, regra ou execução é
criada automaticamente.

SQLite não armazena os dados internos do DataQore. Se quiser usá-lo como
fonte, forneça os arquivos explicitamente por um override, montando o mesmo
diretório em engine e worker, somente para leitura:

```yaml
# compose.sources.yaml (opcional; caminhos do servidor)
services:
  engine:
    volumes:
      - /srv/dataqore-sources:/sources:ro
  worker:
    volumes:
      - /srv/dataqore-sources:/sources:ro
```

Nesse caso, use `docker compose --env-file .env.docker -f compose.yaml
-f compose.sources.yaml` em todas as operações Compose, incluindo builds e
atualizações. Os arquivos precisam existir e ser legíveis pelo UID 1000;
cadastre `/sources/arquivo.sqlite` na aplicação.

## Operação e atualização

```bash
./docker.sh status
./docker.sh verify
./docker.sh logs
./docker.sh logs worker
./docker.sh reset-password
./docker.sh down
```

`down` remove os containers e a rede, preservando o volume. Para subir
novamente ou atualizar após obter uma nova versão do código, use
`./docker.sh up`. O comando constrói primeiro; depois para os processos da
aplicação, remove somente o container temporário de migrations e inicia
novamente. O worker recebe SIGTERM e tem 20 segundos para encerrar. O
agendador continua dentro do controller; mantenha uma instância do controller
e do worker por instalação.

Não use `down --volumes` em uma instalação que deseja preservar. Não troque
as chaves de criptografia ou as senhas no arquivo como forma de atualizar a
instalação. Alterar uma senha em `.env.docker` não altera a senha já gravada
no PostgreSQL; o script de inicialização só roda em um volume novo.
Se o provisionamento inicial falhar parcialmente, examine os logs e os
objetos existentes antes de tentar corrigir; não há reset automático.

As bases selecionadas são Minimus Node 24.22.1, Python 3.12.15, Nginx 1.30.6
e PostgreSQL 16.15. O Dockerfile usa builds em estágios separados e comandos
diretos nos runtimes; mantém o usuário 1000 dos serviços da aplicação. O
PostgreSQL mantém seu entrypoint para preparar o volume e trocar de usuário.
Os contratos públicos podem ser conferidos na
[galeria Minimus](https://images.minimus.io/). Se tiver uma conta Minimus,
`docker login reg.mini.dev` no servidor permite usar os limites de pull dessa
conta; não coloque tokens no Dockerfile ou no Git.

Na consulta de 25/10/2026, a galeria publicou zero vulnerabilidades nas bases
Node 24.22.1, Nginx 1.30.6 e PostgreSQL 16.15, e cinco na base Python 3.12.15.
Essas contagens são das bases publicadas, não uma análise das imagens da
aplicação ou de suas dependências.

## Backup consistente

Faça backup antes de atualizar. Pare os processos que escrevem nos bancos,
mantendo o PostgreSQL ativo. Os dumps dos dois bancos e o arquivo de
configuração formam um conjunto: preserve-os juntos e com acesso restrito.

```bash
umask 077
backup_dir="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
docker compose --env-file .env.docker stop web controller worker engine
docker compose --env-file .env.docker exec -T postgres pg_dump -U postgres -Fc dataqore_app > "$backup_dir/app.dump"
docker compose --env-file .env.docker exec -T postgres pg_dump -U postgres -Fc dataqore_engine > "$backup_dir/engine.dump"
install -m 600 .env.docker "$backup_dir/config.env"
docker compose --env-file .env.docker exec -T postgres pg_restore --list < "$backup_dir/app.dump" > /dev/null
docker compose --env-file .env.docker exec -T postgres pg_restore --list < "$backup_dir/engine.dump" > /dev/null
./docker.sh up
```

Execute cada comando verificando seu código de saída. Se um dump falhar,
não o trate como backup válido. A listagem confere o formato do arquivo;
um teste completo de recuperação requer restauração em outra instalação.
Os dumps preservam histórico de migrations e proprietários. Como o
provisionamento recria as mesmas contas, não é necessário exportar roles
globais. Fontes externas e arquivos SQLite têm seus próprios backups.

## Restauração

Use uma instalação separada com volume vazio e o mesmo código do backup para
testar a recuperação. Copie `config.env` do conjunto para `.env.docker` com
permissão `0600`. Para coexistir no mesmo host, ajuste somente
`COMPOSE_PROJECT_NAME`, `WEB_ORIGIN` e `WEB_PORT`, mantendo senhas e chaves.

```bash
docker compose --env-file .env.docker up -d --wait postgres
docker compose --env-file .env.docker exec -T postgres pg_restore -U postgres --exit-on-error --clean --if-exists -d dataqore_app < /CAMINHO/DO/BACKUP/app.dump
docker compose --env-file .env.docker exec -T postgres pg_restore -U postgres --exit-on-error --clean --if-exists -d dataqore_engine < /CAMINHO/DO/BACKUP/engine.dump
./docker.sh up
```

Os comandos de restore substituem os objetos dos bancos de destino. Use-os
somente na instalação escolhida para recuperação, com a aplicação parada.
Confira login, configurações e resultados após a restauração. Sem as chaves
originais, credenciais de fontes e evidências criptografadas ficam ilegíveis.

## Validação

`./docker.sh check` valida o Compose sem iniciar serviços. `./docker.sh verify`
repete as verificações dos runtimes ativos e testa a configuração do Nginx.
A configuração
expandida contém segredos; evite imprimir `docker compose config` completo.
Os testes de preparação e bootstrap usam somente arquivos e PostgreSQL
descartáveis:

```bash
PYTHONPATH=engine:tests engine/.venv/bin/python -m unittest discover -s tests -p test_docker.py -v
# Inclui bootstrap/migrations quando houver binários locais do PostgreSQL 16:
DATAQORE_PG_BIN=/CAMINHO/postgresql/16/bin PYTHONPATH=engine:tests \
  engine/.venv/bin/python -m unittest discover -s tests -p test_docker.py -v
# Também testa a topologia/credenciais do Compose, sem precisar de daemon:
DATAQORE_COMPOSE_BIN=/CAMINHO/docker-compose PYTHONPATH=engine:tests \
  engine/.venv/bin/python -m unittest discover -s tests -p test_docker.py -v
```

No servidor com Docker, conclua o aceite em uma instalação descartável:

1. Execute setup/up/admin; confira `status`: PostgreSQL, engine, worker e
   controller saudáveis, web em execução e migrate encerrado com código zero.
2. Confira `http://IP:PORTA/health/live`, faça login pelo navegador, recarregue
   uma rota como `/comparisons` e confirme a renovação da sessão.
3. Cadastre explicitamente uma fonte de teste descartável, dois datasets e
   uma comparação; execute e confira o resultado e os logs do worker.
4. Execute down/up; confirme que usuário, conexão, comparação e resultado
   continuam disponíveis e que a conexão ainda é descriptografada.
5. Verifique `docker compose --env-file .env.docker ps`: somente web deve
   mostrar uma porta publicada. Confira as imagens e o conteúdo permitido
   em `.dockerignore`; arquivos de configuração e fontes ficam fora do build.

Build de imagem, imports nativos dentro dos runtimes, proxy Nginx e esse
aceite completo precisam ser verificados em Docker. Os testes locais de
Compose/migrations e os builds Node não substituem essa validação.
