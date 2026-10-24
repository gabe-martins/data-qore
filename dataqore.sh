#!/usr/bin/env bash
# Ambiente local DataQore. Não modifica databases, roles ou migrations.
set -Eeuo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
ACTION="${1:-start}"
case "$ACTION" in
  start|setup|restart|stop|status|logs) ;;
  -h|--help|help)
    cat <<'HELP'
DataQore — ambiente local
  ./dataqore.sh             Prepara o que faltar e inicia os quatro serviços.
  ./dataqore.sh start       Mesmo comportamento padrão.
  ./dataqore.sh setup       Instala/configura/compila e verifica o banco.
  ./dataqore.sh status      Mostra processos e health checks.
  ./dataqore.sh logs        Mostra as últimas linhas dos logs.
  ./dataqore.sh stop        Encerra somente processos iniciados por este script.
  ./dataqore.sh restart     Para os processos gerenciados e inicia novamente.

URLs: Web http://127.0.0.1:5173 | Controller :3000 | Motor :8000
Requisitos: Linux, Python 3.12+, Node.js 24+, npm e PostgreSQL já provisionado.
Arquivos reais: engine.env e controller.env na raiz; nenhum segredo é exibido.
Não executa migrations, não cria Docker e não troca a senha do administrador.
HELP
    exit 0 ;;
  *) echo "Comando inválido: $ACTION. Use ./dataqore.sh --help." >&2; exit 2 ;;
esac
command -v python3 >/dev/null || { echo 'Instale Python 3.12 ou superior.' >&2; exit 1; }
command -v flock >/dev/null || { echo 'Instale flock (util-linux).' >&2; exit 1; }
mkdir -p "$ROOT/.local"
exec 9>"$ROOT/.local/launcher.lock"
flock -n 9 || { echo 'Outro comando dataqore.sh está em execução.' >&2; exit 1; }
# Serviços usam explicitamente seus arquivos, sem herdar URLs/segredos de outro serviço.
unset DATABASE_URL MIGRATION_DATABASE_URL ENGINE_API_KEY CONNECTIONS_ENCRYPTION_KEY CONNECTIONS_ENCRYPTION_KEY_VERSION
unset EVIDENCE_ENCRYPTION_KEY
unset DATAQORE_ENV_FILE ENGINE_API_URL JWT_SECRET WEB_ORIGIN ACCESS_TOKEN_SECONDS REFRESH_TOKEN_SECONDS
unset SQLITE_ALLOWED_ROOT WORKER_HEARTBEAT_SECONDS WORKER_JOB_TIMEOUT_SECONDS WORKER_POLL_SECONDS DATAQORE_CONTROLLER_URL
PYTHON="$ROOT/engine/.venv/bin/python"
export PYTHONPATH="$ROOT/engine"
if [[ "$ACTION" == stop || "$ACTION" == status || "$ACTION" == logs ]]; then
  exec python3 "$ROOT/tools/local_app.py" "$ACTION"
fi
if [[ "$ACTION" == restart ]]; then
  python3 "$ROOT/tools/local_app.py" stop
fi
command -v node >/dev/null || { echo 'Instale Node.js 24 ou superior.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Instale npm.' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<24){console.error("Use Node.js 24 ou superior.");process.exit(1)}'
python3 -c 'import sys;sys.exit(0 if sys.version_info >= (3,12) else "Use Python 3.12 ou superior.")'
if [[ ! -x "$PYTHON" ]]; then
  echo 'Criando ambiente virtual Python…'
  python3 -m venv "$ROOT/engine/.venv"
fi
fingerprint() { sha256sum "$@" | sha256sum | cut -d ' ' -f 1; }
PY_STAMP="$(fingerprint engine/requirements.lock)"
if [[ ! -f .local/python.stamp || "$(cat .local/python.stamp)" != "$PY_STAMP" ]] || ! "$PYTHON" -c 'import fastapi,sqlalchemy,alembic,psycopg,cryptography,dotenv,uvicorn' 2>/dev/null; then
  echo 'Instalando dependências Python fixadas…'
  "$PYTHON" -m pip install -r engine/requirements.lock
  printf '%s\n' "$PY_STAMP" > .local/python.stamp
fi
for SERVICE in controller web; do
  NPM_STAMP="$(fingerprint "$SERVICE/package.json" "$SERVICE/package-lock.json")"
  if [[ ! -d "$SERVICE/node_modules" || ! -f ".local/$SERVICE.stamp" || "$(cat ".local/$SERVICE.stamp")" != "$NPM_STAMP" ]]; then
    echo "Instalando dependências de $SERVICE…"
    npm ci --prefix "$SERVICE"
    printf '%s\n' "$NPM_STAMP" > ".local/$SERVICE.stamp"
  fi
done
"$PYTHON" "$ROOT/tools/local_app.py" configure
# Geração/compilação local; nenhum destes comandos aplica migrations.
npm run prisma:generate --prefix controller
npm run build --prefix controller
npm run build --prefix web
"$PYTHON" "$ROOT/tools/local_app.py" check
ADMIN_COUNT="$(DATAQORE_ENV_FILE="$ROOT/controller.env" node --import "$ROOT/controller/node_modules/tsx/dist/loader.mjs" --input-type=module - <<'JS'
import {loadConfig} from './controller/src/config.ts';
import {database} from './controller/src/db.ts';
const db=database(loadConfig().databaseUrl);
try{console.log(await db.user.count());}catch{process.exitCode=1;}finally{await db.$disconnect();}
JS
)" || { echo 'Não foi possível verificar o administrador.' >&2; exit 1; }
if [[ "$ADMIN_COUNT" == 0 ]]; then
  if [[ -t 0 ]]; then
    echo 'Primeira instalação: defina seu administrador. A senha não será exibida.'
    npm run admin:create --prefix controller
  else
    echo 'Nenhum administrador cadastrado. Execute ./dataqore.sh em um terminal interativo.' >&2
    exit 1
  fi
else
  echo 'Administrador existente preservado.'
fi
if [[ "$ACTION" == setup ]]; then
  echo 'Configuração validada. Para iniciar: ./dataqore.sh start'
else
  "$PYTHON" "$ROOT/tools/local_app.py" start
fi
