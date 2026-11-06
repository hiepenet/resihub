-- 001_extensions_and_roles.sql
-- Consolidated Migration 001: Extensions and Roles
-- Enables core PostgreSQL extensions, creates application role 'resihub_app',
-- and sets default schema privileges.

-- 1. Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Application Role & Privileges
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'resihub_app') THEN
    CREATE ROLE resihub_app WITH LOGIN PASSWORD 'resihub_app_secret';
  END IF;

  GRANT USAGE ON SCHEMA public TO resihub_app;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO resihub_app;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO resihub_app;
  GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO resihub_app;

  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO resihub_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO resihub_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO resihub_app;
END $$;

-- 3. Optimization
-- Disable JIT compilation overhead for the session (ALTER DATABASE omitted as migrations run inside transactions)
SET jit = off;
