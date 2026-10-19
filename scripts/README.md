# Inicialização local DataQore

O ponto de entrada é `../dataqore.sh`. Execute na raiz:

```bash
./dataqore.sh
```

Em Linux com Python 3.12+, Node.js 24+, npm e PostgreSQL já provisionado, o
script prepara o ambiente virtual, instala dependências fixadas quando
necessário, gera o cliente Prisma, compila controller/web, valida os bancos
e inicia API, worker, controller e Vite em segundo plano.

Os arquivos `engine.env` e `controller.env` existentes são preservados,
inclusive URLs, chave Fernet válida e senha do administrador. Campos internos
faltantes são preenchidos com valores locais e segredos aleatórios; a chave
interna do controller é sincronizada com a do motor. Uma chave Fernet ausente
somente é gerada após confirmar que não há conexões criptografadas salvas.
Chave inválida ou ausente com dados existentes exige recuperar a original.
Arquivos de ambiente são protegidos com permissão 600.

Em uma instalação nova, exemplos locais são criados se necessário e o
script pede o preenchimento das URLs reais, sem inventar credenciais.
Se o banco estiver vazio de usuários, o terminal solicita a criação do
administrador, com senha sem eco. O usuário existente não é redefinido.
PostgreSQL e migrations precisam estar preparados conforme o manual.
O script não aplica DDL, não executa migrations, não cria containers e
não instala programas do sistema.

```bash
./dataqore.sh status
./dataqore.sh logs
./dataqore.sh stop
./dataqore.sh restart
./dataqore.sh setup
./dataqore.sh --help
```

Acesso: **http://127.0.0.1:5173/**. As portas do motor e controller são 8000 e
3000. Todos os serviços escutam apenas localmente. Os logs ficam em
`.local/logs/` e a identidade dos processos em `.local/run/`, fora do Git.
Não remova esses arquivos enquanto os serviços estiverem ativos.

Repetir `start` mantém os processos existentes gerenciados, sem duplicá-los.
`stop` verifica PID, instante de criação, comando, diretório e grupo antes
de sinalizar processos. Instâncias manuais e processos de outros projetos
não são encerrados. Uma porta ocupada por instância externa interrompe a
inicialização com orientação para fechá-la no terminal original.
Se iniciar um serviço falhar, os serviços novos daquela tentativa são
encerrados; os que já estavam gerenciados são preservados.

Depois de editar código/configuração, use `restart` para recarregar os
serviços. Reiniciar o worker pode interromper um cálculo em andamento;
execuções interrompidas exigem nova solicitação, conforme o contrato do motor.
`setup` prepara e verifica sem iniciar serviços. A instalação inicial requer
acesso aos repositórios de pacotes; as próximas execuções reaproveitam as
dependências enquanto os manifests/locks não mudarem.

O script usa explicitamente os arquivos da raiz e ignora URLs e segredos
exportados pelo terminal, evitando misturar os bancos do app e do motor.
Drivers MySQL/Oracle/SQL Server continuam opcionais, conforme engine/README.md.
