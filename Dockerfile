# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.22.1
ARG PYTHON_VERSION=3.12.15
ARG NGINX_VERSION=1.30.6

FROM reg.mini.dev/node:${NODE_VERSION}-dev AS node-build
USER root
WORKDIR /app/controller
COPY controller/package*.json ./
RUN npm ci
COPY controller/prisma ./prisma
COPY controller/prisma.config.ts controller/tsconfig.json ./
RUN npm run prisma:generate
COPY controller/src ./src
RUN npm run build
# The one-shot migration image needs Node as well as Python. Export the ELF
# executable and its resolved shared libraries, not a shell or a package manager.
COPY docker/collect-node.mjs /app/docker/collect-node.mjs
RUN node /app/docker/collect-node.mjs /node-runtime

FROM node-build AS controller-production
RUN npm prune --omit=dev

FROM reg.mini.dev/node:${NODE_VERSION} AS controller
WORKDIR /app/controller
COPY --from=controller-production /app/controller/package.json ./package.json
COPY --from=controller-production /app/controller/node_modules ./node_modules
COPY --from=controller-production /app/controller/dist ./dist
# Bypass the base's shell entrypoint: production commands are direct execs.
ENTRYPOINT ["node"]
CMD ["dist/src/main.js"]

FROM reg.mini.dev/node:${NODE_VERSION}-dev AS web-build
USER root
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM reg.mini.dev/nginx:${NGINX_VERSION} AS web
COPY --from=web-build /app/web/dist /app/web
COPY docker/nginx.conf /etc/nginx/nginx.conf
# Keep the image's non-root user, direct Nginx entrypoint and SIGQUIT.

FROM reg.mini.dev/python:${PYTHON_VERSION} AS python-base

FROM reg.mini.dev/python:${PYTHON_VERSION}-dev AS python-build
USER root
WORKDIR /app
COPY --from=python-base / /runtime-base/
COPY engine/requirements* ./engine/
RUN python -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir \
       -r engine/requirements-connectors.txt -r engine/requirements-databricks.lock \
    && /opt/venv/bin/python -m pip check
COPY docker/collect-python.py /app/docker/collect-python.py
# Resolve wheel dependencies while the build tools are available. Missing
# libraries fail the build rather than producing a broken driver at runtime.
RUN /opt/venv/bin/python /app/docker/collect-python.py /python-runtime /opt/venv /runtime-base

FROM python-build AS migration-build
COPY --from=node-build /node-runtime /node-runtime
# Keep the Python base's core libraries; add only missing Node dependencies.
RUN /opt/venv/bin/python /app/docker/collect-python.py /migration-runtime /opt/venv /runtime-base /node-runtime

FROM python-base AS python-runtime
WORKDIR /app
ENV PYTHONPATH=/app/engine PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY --from=python-build /opt/venv /opt/venv
COPY --from=python-build /python-runtime/ /
COPY engine/dataqore_engine ./engine/dataqore_engine
ENTRYPOINT ["/opt/venv/bin/python"]

FROM python-runtime AS engine
COPY docker/worker-health.py /app/docker/worker-health.py
COPY docker/verify.py /app/docker/verify.py
CMD ["-m", "uvicorn", "dataqore_engine.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]

FROM python-runtime AS migrate
COPY --from=migration-build /migration-runtime/ /
COPY --from=node-build /app/controller/node_modules /app/controller/node_modules
COPY --from=node-build /app/controller/dist /app/controller/dist
COPY controller/package.json controller/prisma.config.ts /app/controller/
COPY controller/prisma /app/controller/prisma
COPY engine/alembic.ini /app/engine/alembic.ini
COPY engine/migrations /app/engine/migrations
COPY tools/__init__.py tools/migrations.py tools/migration_config.py tools/catalog.py tools/encrypt_documents.py /app/tools/
COPY tools/baselines /app/tools/baselines
COPY docker/migrate.py /app/docker/migrate.py
CMD ["/app/docker/migrate.py"]
