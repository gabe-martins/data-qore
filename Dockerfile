# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG NGINX_IMAGE=nginx:1.30-alpine

FROM ${NODE_IMAGE} AS node-base
RUN apt-get update && apt-get install -y --no-install-recommends openssl tzdata \
    && rm -rf /var/lib/apt/lists/*

FROM node-base AS node-build
WORKDIR /app/controller
COPY controller/package*.json ./
RUN npm ci
COPY controller/prisma ./prisma
COPY controller/prisma.config.ts controller/tsconfig.json ./
RUN npm run prisma:generate
COPY controller/src ./src
RUN npm run build

FROM node-build AS controller-production
RUN npm prune --omit=dev

FROM node-base AS controller
WORKDIR /app/controller
COPY --from=controller-production /app/controller/package.json ./package.json
COPY --from=controller-production /app/controller/node_modules ./node_modules
COPY --from=controller-production /app/controller/dist ./dist
COPY engine.env.example /app/engine.env.example
COPY docs/openapi-engine.json /app/docs/openapi-engine.json
USER node
ENTRYPOINT ["node"]
CMD ["dist/src/main.js"]

FROM node-base AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM ${NGINX_IMAGE} AS web
RUN apk add --no-cache tzdata
COPY --from=web-build /app/web/dist /app/web
COPY docker/nginx.conf /etc/nginx/nginx.conf
USER nginx
ENTRYPOINT ["nginx"]
CMD ["-c", "/etc/nginx/nginx.conf", "-e", "/dev/stderr", "-g", "daemon off;"]

FROM ${PYTHON_IMAGE} AS python-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 libatomic1 libgssapi-krb5-2 libltdl7 openssl tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 dataqore \
    && useradd --uid 1000 --gid 1000 --create-home dataqore
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

# Only bootstrap can write the master configuration and service exports.
FROM python-base AS bootstrap
COPY docker/configure.py docker/bootstrap.py /app/docker/
ENTRYPOINT ["python", "/app/docker/bootstrap.py"]

FROM python-base AS python-build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY engine/requirements* ./engine/
RUN python -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir \
       -r engine/requirements-connectors.txt -r engine/requirements-databricks.lock \
    && /opt/venv/bin/python -m pip check

FROM python-base AS python-runtime
ENV PYTHONPATH=/app/engine
COPY --from=python-build /opt/venv /opt/venv
COPY engine/dataqore_engine ./engine/dataqore_engine
USER dataqore
ENTRYPOINT ["/opt/venv/bin/python"]

FROM python-runtime AS engine
COPY docker/worker-health.py docker/verify.py /app/docker/
CMD ["-m", "uvicorn", "dataqore_engine.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]

FROM python-runtime AS migrate
# Both stages use Debian Bookworm; Node's ELF dependencies are in python-base.
COPY --from=node-build /usr/local/bin/node /usr/local/bin/node
COPY --from=node-build /app/controller/node_modules /app/controller/node_modules
COPY --from=node-build /app/controller/dist /app/controller/dist
COPY controller/package.json controller/prisma.config.ts /app/controller/
COPY controller/prisma /app/controller/prisma
COPY engine.env.example /app/engine.env.example
COPY engine/alembic.ini /app/engine/alembic.ini
COPY engine/migrations /app/engine/migrations
COPY tools/__init__.py tools/migrations.py tools/migration_config.py tools/catalog.py tools/encrypt_documents.py /app/tools/
COPY tools/baselines /app/tools/baselines
COPY docker/migrate.py /app/docker/migrate.py
CMD ["/app/docker/migrate.py"]
