-- ============================================================================
-- Consolidated Migration: 007_grants.sql
-- Description: Application user permissions, schema grants, and RPC execute privileges
-- ============================================================================

DO $$
BEGIN
  -- 1. Full application permissions for resihub_app role
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'resihub_app') THEN
    GRANT USAGE ON SCHEMA public TO resihub_app;
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO resihub_app;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO resihub_app;
    GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO resihub_app;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO resihub_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO resihub_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO resihub_app;

    -- 2-Layer Hardening: Non-destructive immutability on service_request and ai_suggestion (M11, M15)
    REVOKE DELETE, TRUNCATE ON TABLE service_request FROM resihub_app;
    REVOKE DELETE, TRUNCATE ON TABLE ai_suggestion FROM resihub_app;
  END IF;

  -- 2. Grant execute permissions on public schema routines
  EXECUTE 'GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO PUBLIC';
END $$;
