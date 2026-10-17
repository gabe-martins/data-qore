-- Execute como administrador, conectado ao database postgres, com autocommit.
-- Provisionamento inicial: interrompe se os nomes já existirem. Não remove dados.
-- PostgreSQL 15+. Não envolver este arquivo em BEGIN/COMMIT.

CREATE ROLE dataqore_app_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE dataqore_engine_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

CREATE ROLE srv_dataqore_app LOGIN PASSWORD NULL NOINHERIT NOSUPERUSER
    NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srv_dataqore_engine LOGIN PASSWORD NULL NOINHERIT NOSUPERUSER
    NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

CREATE DATABASE dataqore_app OWNER dataqore_app_owner ENCODING 'UTF8' TEMPLATE template0;
CREATE DATABASE dataqore_engine OWNER dataqore_engine_owner ENCODING 'UTF8' TEMPLATE template0;

REVOKE ALL ON DATABASE dataqore_app FROM PUBLIC;
REVOKE ALL ON DATABASE dataqore_engine FROM PUBLIC;
GRANT CONNECT ON DATABASE dataqore_app TO srv_dataqore_app;
GRANT CONNECT ON DATABASE dataqore_engine TO srv_dataqore_engine;

ALTER DATABASE dataqore_app SET timezone TO 'UTC';
ALTER DATABASE dataqore_engine SET timezone TO 'UTC';
ALTER ROLE srv_dataqore_app IN DATABASE dataqore_app SET search_path TO app, pg_catalog;
ALTER ROLE srv_dataqore_engine IN DATABASE dataqore_engine SET search_path TO engine, pg_catalog;
ALTER ROLE srv_dataqore_app SET statement_timeout TO '30s';
ALTER ROLE srv_dataqore_engine SET statement_timeout TO '30s';
ALTER ROLE srv_dataqore_app SET lock_timeout TO '5s';
ALTER ROLE srv_dataqore_engine SET lock_timeout TO '5s';
ALTER ROLE srv_dataqore_app SET idle_in_transaction_session_timeout TO '60s';
ALTER ROLE srv_dataqore_engine SET idle_in_transaction_session_timeout TO '60s';

-- Defina as senhas fora deste arquivo, usando os comandos interativos do psql:
-- \password srv_dataqore_app
-- \password srv_dataqore_engine
-- Não conceder as roles *_owner às contas srv_*.
