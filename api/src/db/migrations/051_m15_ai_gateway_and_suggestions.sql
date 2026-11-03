-- 051_m15_ai_gateway_and_suggestions.sql
-- Tuần 7: Tích hợp AI Gateway (M15) — ai_suggestion, meter_reading.source, service_request AI triage & 2-Layer RLS
-- Tuân thủ PRD v2.0 Mục 6.2, 12.1–12.5, 13.2, 13.5, NFR-007, NFR-008, NFR-013, NFR-016

BEGIN;

-- ============================================================================
-- 1. Bảng ai_suggestion lưu nháp mọi đầu ra AI ("AI đề xuất, người quyết định")
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_suggestion (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id           UUID REFERENCES building(id) ON DELETE CASCADE,
  task_type             TEXT NOT NULL
                        CHECK (task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT', 'METER_OCR', 'TICKET_TRIAGE')),
  target_entity         TEXT NOT NULL
                        CHECK (target_entity IN ('tenant', 'contract', 'meter_reading', 'service_request')),
  target_entity_id      UUID,
  input_ref             JSONB NOT NULL DEFAULT '{}'::jsonb,
  output                JSONB NOT NULL DEFAULT '{}'::jsonb,
  edited_output         JSONB,
  warnings              JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence            NUMERIC(4,3)
                        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  needs_human_review    BOOLEAN NOT NULL DEFAULT TRUE,
  accepted_fields_count INT NOT NULL DEFAULT 0 CHECK (accepted_fields_count >= 0),
  total_fields_count    INT NOT NULL DEFAULT 0 CHECK (total_fields_count >= 0),
  model                 TEXT NOT NULL,
  prompt_version        TEXT NOT NULL,
  input_tokens          INT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens         INT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  estimated_cost_vnd    BIGINT NOT NULL DEFAULT 0 CHECK (estimated_cost_vnd >= 0),
  latency_ms            INT CHECK (latency_ms IS NULL OR latency_ms >= 0),
  status                TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'ACCEPTED', 'EDITED_ACCEPTED', 'REJECTED', 'EXPIRED', 'FAILED')),
  error_code            TEXT,
  created_by            UUID REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_by           UUID REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at           TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '72 hours'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_suggestion_building_scope CHECK (
    (task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT'))
    OR (building_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_suggestion_org_created
  ON ai_suggestion(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_suggestion_building_task
  ON ai_suggestion(building_id, task_type, status);

CREATE INDEX IF NOT EXISTS idx_ai_suggestion_target
  ON ai_suggestion(target_entity, target_entity_id)
  WHERE target_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_suggestion_pending_exp
  ON ai_suggestion(status, expires_at)
  WHERE status = 'PENDING';

-- ============================================================================
-- 2. Mở rộng meter_reading (PRD 13.2: source = MANUAL / AI / IOT)
-- ============================================================================
ALTER TABLE meter_reading
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS ai_suggestion_id UUID REFERENCES ai_suggestion(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_meter_reading_source'
  ) THEN
    ALTER TABLE meter_reading
      ADD CONSTRAINT chk_meter_reading_source CHECK (source IN ('MANUAL', 'AI', 'IOT'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_meter_reading_ai_suggestion
  ON meter_reading(ai_suggestion_id)
  WHERE ai_suggestion_id IS NOT NULL;

-- ============================================================================
-- 3. Mở rộng service_request cho AI-03 Triage (giữ nguyên status = 'NEW')
-- ============================================================================
ALTER TABLE service_request
  ADD COLUMN IF NOT EXISTS ai_suggestion_id UUID REFERENCES ai_suggestion(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_triage_status TEXT,
  ADD COLUMN IF NOT EXISTS ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_suggested_category TEXT,
  ADD COLUMN IF NOT EXISTS ai_suggested_priority TEXT,
  ADD COLUMN IF NOT EXISTS ai_suggested_assignee_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(4,3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_service_request_ai_triage_status'
  ) THEN
    ALTER TABLE service_request
      ADD CONSTRAINT chk_service_request_ai_triage_status CHECK (
        ai_triage_status IS NULL
        OR ai_triage_status IN (
          'PENDING',
          'SUGGESTED',
          'NEEDS_MANUAL_REVIEW',
          'ACCEPTED',
          'OVERRIDDEN',
          'FAILED',
          'SKIPPED'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_service_request_ai_triage_status
  ON service_request(building_id, ai_triage_status)
  WHERE ai_triage_status IS NOT NULL;

-- ============================================================================
-- 4. SECURITY DEFINER RPCs: Scope check, Monthly AI Usage & Background Triage
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_get_ops_resource_scope(
  p_entity TEXT,
  p_id UUID
)
RETURNS TABLE (
  resource_id UUID,
  org_id UUID,
  building_id UUID
) AS $$
DECLARE
  v_caller_org UUID;
  v_entity_norm TEXT;
BEGIN
  v_caller_org := get_current_user_org_id();
  IF v_caller_org IS NULL OR p_id IS NULL THEN
    RETURN;
  END IF;

  v_entity_norm := lower(btrim(p_entity));

  IF v_entity_norm = 'service_request' THEN
    RETURN QUERY
    SELECT sr.id, sr.org_id, sr.building_id
    FROM service_request sr
    WHERE sr.id = p_id AND sr.org_id = v_caller_org;

  ELSIF v_entity_norm = 'announcement' THEN
    RETURN QUERY
    SELECT a.id, a.org_id, a.building_id
    FROM announcement a
    WHERE a.id = p_id AND a.org_id = v_caller_org;

  ELSIF v_entity_norm = 'zalo_group' THEN
    RETURN QUERY
    SELECT zg.id, zg.org_id, zg.building_id
    FROM zalo_group zg
    WHERE zg.id = p_id AND zg.org_id = v_caller_org;

  ELSIF v_entity_norm = 'meter' THEN
    RETURN QUERY
    SELECT m.id, m.org_id, m.building_id
    FROM meter m
    WHERE m.id = p_id AND m.org_id = v_caller_org;

  ELSIF v_entity_norm = 'ai_suggestion' THEN
    RETURN QUERY
    SELECT s.id, s.org_id, s.building_id
    FROM ai_suggestion s
    WHERE s.id = p_id AND s.org_id = v_caller_org;

  ELSIF v_entity_norm = 'apartment' THEN
    RETURN QUERY
    SELECT apt.id, b.org_id, apt.building_id
    FROM apartment apt
    JOIN building b ON b.id = apt.building_id
    WHERE apt.id = p_id AND b.org_id = v_caller_org;

  ELSIF v_entity_norm = 'floor' THEN
    RETURN QUERY
    SELECT f.id, b.org_id, f.building_id
    FROM floor f
    JOIN building b ON b.id = f.building_id
    WHERE f.id = p_id AND b.org_id = v_caller_org;

  ELSIF v_entity_norm = 'building' THEN
    RETURN QUERY
    SELECT b.id, b.org_id, b.id AS building_id
    FROM building b
    WHERE b.id = p_id AND b.org_id = v_caller_org;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_get_ops_resource_scope(TEXT, UUID) TO resihub_app;

CREATE OR REPLACE FUNCTION fn_get_org_monthly_ai_usage(
  p_org_id UUID,
  p_month_start TIMESTAMPTZ
)
RETURNS TABLE (
  total_calls BIGINT,
  total_tokens BIGINT,
  total_cost_vnd BIGINT
) AS $$
DECLARE
  v_caller_org UUID;
BEGIN
  v_caller_org := get_current_user_org_id();
  IF v_caller_org IS NULL OR p_org_id IS NULL OR v_caller_org <> p_org_id THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*)::bigint AS total_calls,
    COALESCE(SUM(s.input_tokens + s.output_tokens), 0)::bigint AS total_tokens,
    COALESCE(SUM(s.estimated_cost_vnd), 0)::bigint AS total_cost_vnd
  FROM ai_suggestion s
  WHERE s.org_id = p_org_id
    AND s.created_at >= p_month_start;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_get_org_monthly_ai_usage(UUID, TIMESTAMPTZ) TO resihub_app;

CREATE OR REPLACE FUNCTION fn_record_background_ticket_triage(
  p_service_request_id UUID,
  p_triage_status TEXT,
  p_suggested_category TEXT,
  p_suggested_priority TEXT,
  p_suggested_assignee_id UUID,
  p_summary TEXT,
  p_confidence NUMERIC(4,3),
  p_output JSONB,
  p_warnings JSONB,
  p_needs_human_review BOOLEAN,
  p_model TEXT,
  p_prompt_version TEXT,
  p_input_tokens INT,
  p_output_tokens INT,
  p_estimated_cost_vnd BIGINT,
  p_latency_ms INT,
  p_error_code TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_sr service_request%ROWTYPE;
  v_caller UUID;
  v_authorized BOOLEAN := FALSE;
  v_sugg_id UUID := NULL;
  v_sugg_status TEXT;
BEGIN
  v_caller := get_current_user_id();
  IF v_caller IS NULL OR p_service_request_id IS NULL THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sr
  FROM service_request
  WHERE id = p_service_request_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF is_org_admin() AND v_sr.org_id = get_current_user_org_id() THEN
    v_authorized := TRUE;
  ELSIF is_manager() AND v_sr.building_id IN (SELECT gb.building_id FROM get_manager_building_ids() gb) THEN
    v_authorized := TRUE;
  ELSIF is_resident() AND (
    v_sr.created_by = v_caller
    OR v_sr.apartment_id IN (
      SELECT c.apartment_id
      FROM contract c
      WHERE c.id IN (SELECT rc.contract_id FROM get_resident_contract_ids() rc)
    )
  ) THEN
    v_authorized := TRUE;
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  IF p_triage_status <> 'SKIPPED' THEN
    v_sugg_status := CASE WHEN p_triage_status = 'FAILED' THEN 'FAILED' ELSE 'PENDING' END;
    INSERT INTO ai_suggestion (
      org_id,
      building_id,
      task_type,
      target_entity,
      target_entity_id,
      input_ref,
      output,
      warnings,
      confidence,
      needs_human_review,
      total_fields_count,
      model,
      prompt_version,
      input_tokens,
      output_tokens,
      estimated_cost_vnd,
      latency_ms,
      status,
      error_code,
      created_by
    ) VALUES (
      v_sr.org_id,
      v_sr.building_id,
      'TICKET_TRIAGE',
      'service_request',
      v_sr.id,
      jsonb_build_object('service_request_id', v_sr.id, 'apartment_id', v_sr.apartment_id),
      COALESCE(p_output, '{}'::jsonb),
      COALESCE(p_warnings, '[]'::jsonb),
      p_confidence,
      COALESCE(p_needs_human_review, TRUE),
      CASE WHEN p_suggested_category IS NOT NULL AND p_suggested_priority IS NOT NULL THEN 2 ELSE 0 END,
      COALESCE(NULLIF(btrim(p_model), ''), 'gemini-2.5-flash'),
      COALESCE(NULLIF(btrim(p_prompt_version), ''), 'triage-v1.0'),
      GREATEST(0, COALESCE(p_input_tokens, 0)),
      GREATEST(0, COALESCE(p_output_tokens, 0)),
      GREATEST(0, COALESCE(p_estimated_cost_vnd, 0)),
      p_latency_ms,
      v_sugg_status,
      p_error_code,
      v_caller
    )
    RETURNING id INTO v_sugg_id;
  END IF;

  -- Chỉ cập nhật gợi ý AI trên service_request nếu Quản lý chưa duyệt/ghi đè (PRD 12.3)
  UPDATE service_request
  SET
    ai_suggestion_id = COALESCE(v_sugg_id, ai_suggestion_id),
    ai_triage_status = p_triage_status,
    ai_summary = COALESCE(p_summary, ai_summary),
    ai_suggested_category = p_suggested_category,
    ai_suggested_priority = p_suggested_priority,
    ai_suggested_assignee_id = p_suggested_assignee_id,
    ai_confidence = p_confidence,
    updated_at = NOW()
  WHERE id = v_sr.id
    AND (ai_triage_status IS NULL OR ai_triage_status IN ('PENDING', 'FAILED', 'SKIPPED'));

  RETURN v_sugg_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_record_background_ticket_triage(
  UUID, TEXT, TEXT, TEXT, UUID, TEXT, NUMERIC, JSONB, JSONB, BOOLEAN, TEXT, TEXT, INT, INT, BIGINT, INT, TEXT
) TO resihub_app;

-- ============================================================================
-- 5. Phân quyền & 2-Layer FORCE ROW LEVEL SECURITY trên ai_suggestion
-- ============================================================================
REVOKE DELETE, TRUNCATE ON TABLE ai_suggestion FROM resihub_app;
GRANT SELECT, INSERT, UPDATE ON TABLE ai_suggestion TO resihub_app;

ALTER TABLE ai_suggestion ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestion FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_ai_suggestion_select ON ai_suggestion;
DROP POLICY IF EXISTS rls_ai_suggestion_insert ON ai_suggestion;
DROP POLICY IF EXISTS rls_ai_suggestion_update ON ai_suggestion;
DROP POLICY IF EXISTS rls_ai_suggestion_delete ON ai_suggestion;

CREATE POLICY rls_ai_suggestion_select ON ai_suggestion FOR SELECT
USING (
  (
    is_org_admin()
    AND org_id = get_current_user_org_id()
  )
  OR (
    is_manager()
    AND org_id = get_current_user_org_id()
    AND (
      building_id IN (SELECT building_id FROM get_manager_building_ids())
      OR (building_id IS NULL AND created_by = get_current_user_id())
    )
  )
  OR (
    -- PRD 13.5: OWNER chỉ đọc dữ liệu vận hành tòa sở hữu, bị chặn cứng CCCD_EXTRACT & CONTRACT_EXTRACT
    is_owner()
    AND org_id = get_current_user_org_id()
    AND building_id IN (SELECT building_id FROM get_owner_building_ids())
    AND task_type IN ('METER_OCR', 'TICKET_TRIAGE')
  )
);

CREATE POLICY rls_ai_suggestion_insert ON ai_suggestion FOR INSERT
WITH CHECK (
  (
    is_manager()
    AND org_id = get_current_user_org_id()
    AND (
      building_id IN (SELECT building_id FROM get_manager_building_ids())
      OR (building_id IS NULL AND task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT'))
    )
  )
  OR (
    is_org_admin()
    AND org_id = get_current_user_org_id()
    AND task_type = 'CCCD_EXTRACT'
  )
);

CREATE POLICY rls_ai_suggestion_update ON ai_suggestion FOR UPDATE
USING (
  (
    is_manager()
    AND org_id = get_current_user_org_id()
    AND (
      building_id IN (SELECT building_id FROM get_manager_building_ids())
      OR (building_id IS NULL AND created_by = get_current_user_id())
    )
  )
  OR (
    is_org_admin()
    AND org_id = get_current_user_org_id()
    AND task_type = 'CCCD_EXTRACT'
  )
)
WITH CHECK (
  (
    is_manager()
    AND org_id = get_current_user_org_id()
    AND (
      building_id IN (SELECT building_id FROM get_manager_building_ids())
      OR (building_id IS NULL AND task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT'))
    )
  )
  OR (
    is_org_admin()
    AND org_id = get_current_user_org_id()
    AND task_type = 'CCCD_EXTRACT'
  )
);

CREATE POLICY rls_ai_suggestion_delete ON ai_suggestion FOR DELETE
USING (FALSE);

-- Additive audit_log policy cho ai_suggestion (không ghi đè policy cũ)
DROP POLICY IF EXISTS rls_audit_log_select_m15 ON audit_log;
CREATE POLICY rls_audit_log_select_m15 ON audit_log FOR SELECT
USING (
  (is_owner() OR is_manager())
  AND entity = 'ai_suggestion'
  AND (
    entity_id IN (
      SELECT s.id FROM ai_suggestion s
      WHERE s.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        AND (NOT is_owner() OR s.task_type IN ('METER_OCR', 'TICKET_TRIAGE'))
    )
    OR entity_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
);

-- ============================================================================
-- 6. Seed cấu hình mặc định ai_config vào system_setting cho mọi organization
-- ============================================================================
INSERT INTO system_setting (org_id, key, value, description)
SELECT
  o.id,
  'ai_config',
  '{
    "enabled": true,
    "cccd_extract_enabled": true,
    "contract_extract_enabled": true,
    "meter_ocr_enabled": true,
    "ticket_triage_enabled": true,
    "model": "gemini-2.5-flash",
    "confidence_threshold": 0.75,
    "meter_ocr_threshold": 0.8,
    "triage_threshold": 0.7,
    "monthly_budget_vnd": 500000,
    "monthly_token_limit": 2000000,
    "warn_percent": 80,
    "suggestion_ttl_hours": 72
  }'::jsonb,
  'Cấu hình AI Gateway (Kill switch, ngưỡng độ tin cậy, trần ngân sách tháng — M15)'
FROM organization o
ON CONFLICT (org_id, key) DO NOTHING;

COMMIT;

