-- ============================================================================
-- Consolidated Migration: 009_cron_jobs.sql
-- Description: Background jobs history, billing engine configuration, and permissions
-- ============================================================================

-- 1. Cron Job Execution Run Tracking Table (PRD 14.5)
CREATE TABLE IF NOT EXISTS cron_job_run (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name      TEXT NOT NULL,
  run_date      DATE NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  attempt_count INT NOT NULL DEFAULT 1,
  duration_ms   INT,
  summary       JSONB,
  error_message TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

-- Index for fast status query and ordering
CREATE INDEX IF NOT EXISTS idx_cron_job_run_date
  ON cron_job_run(job_name, run_date DESC, started_at DESC);

-- Enable & Force RLS
ALTER TABLE cron_job_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE cron_job_run FORCE ROW LEVEL SECURITY;

-- Select policy: Only org admin can view cron execution history
DROP POLICY IF EXISTS rls_cron_job_run_select ON cron_job_run;
CREATE POLICY rls_cron_job_run_select ON cron_job_run FOR SELECT
  USING (is_org_admin());

-- Role permissions for background runner
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'resihub_app') THEN
    GRANT SELECT, INSERT, UPDATE ON cron_job_run TO resihub_app;
  END IF;
END $$;

-- 2. Merge Billing Engine Default Config
INSERT INTO system_setting (org_id, key, value, description, updated_at)
SELECT
  o.id,
  'billing_config',
  '{"due_date_offset_days": 5, "late_fee_grace_days": 5, "late_fee_per_day": 100000, "late_fee_cap": null, "meter_anomaly_threshold_pct": 30}'::jsonb,
  'Cấu hình mặc định động cơ tính tiền và chu kỳ hóa đơn (FR-030..FR-036)',
  NOW()
FROM organization o
ON CONFLICT (org_id, key) DO UPDATE
SET value = EXCLUDED.value || COALESCE(system_setting.value, '{}'::jsonb);
