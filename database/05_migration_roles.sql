-- Executar como administrador no database postgres, depois do provisionamento 00.
-- Reexecutável: não altera senhas já configuradas nem permissões dos serviços.
BEGIN;
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'srv_dataqore_app_migrator') THEN
        CREATE ROLE srv_dataqore_app_migrator LOGIN PASSWORD NULL NOINHERIT
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'srv_dataqore_engine_migrator') THEN
        CREATE ROLE srv_dataqore_engine_migrator LOGIN PASSWORD NULL NOINHERIT
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
END $$;
GRANT dataqore_app_owner TO srv_dataqore_app_migrator;
GRANT dataqore_engine_owner TO srv_dataqore_engine_migrator;
GRANT CONNECT ON DATABASE dataqore_app TO srv_dataqore_app_migrator;
GRANT CONNECT ON DATABASE dataqore_engine TO srv_dataqore_engine_migrator;

-- Assume o owner em CADA conexão, incluindo as conexões internas do Prisma.
-- session_user continua identificando o migrator; current_user identifica o owner.
ALTER ROLE srv_dataqore_app_migrator IN DATABASE dataqore_app
    SET role TO 'dataqore_app_owner';
ALTER ROLE srv_dataqore_engine_migrator IN DATABASE dataqore_engine
    SET role TO 'dataqore_engine_owner';
ALTER ROLE srv_dataqore_app_migrator IN DATABASE dataqore_app SET search_path TO app, pg_catalog;
ALTER ROLE srv_dataqore_engine_migrator IN DATABASE dataqore_engine SET search_path TO engine, pg_catalog;
COMMIT;

-- Definir fora deste arquivo, em sessão interativa psql:
-- \password srv_dataqore_app_migrator
-- \password srv_dataqore_engine_migrator
