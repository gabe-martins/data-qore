#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root"
compose() { docker compose -f compose.yaml "$@"; }
case "${1:-help}" in
  setup)
    echo 'Setup is automatic. Set TZ and WEB_ORIGIN in compose.yaml, then run: docker compose up -d --build'
    ;;
  up)
    compose config --quiet
    compose build
    # Finish/interrupt running jobs before schema changes, including upgrades.
    compose stop web controller worker engine
    # Force a fresh one-shot check on every up, even when the image is cached.
    compose rm --force migrate
    compose up --detach --wait --wait-timeout 180
    compose run --rm --no-deps engine /app/docker/verify.py
    ;;
  verify)
    compose exec -T web /usr/bin/nginx -t
    compose run --rm --no-deps engine /app/docker/verify.py
    ;;
  admin)
    compose run --rm --no-deps controller dist/src/admin.js create
    ;;
  reset-password)
    compose run --rm --no-deps controller dist/src/admin.js reset-password
    ;;
  down) compose down ;;
  status) compose ps --all ;;
  logs) shift; compose logs --tail 100 "$@" ;;
  check) compose config --quiet ;;
  *)
    echo 'Uso: ./docker.sh up | reset-password | status | logs [serviço] | down | check | verify'
    ;;
esac
