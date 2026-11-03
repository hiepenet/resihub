-- 049_m08_m09_billing_engine_and_cron_lock.sql
-- Tuần 5: Engine Tính tiền & Hóa đơn (M08, M09, FR-030..FR-036, FR-063..FR-066, PRD 6.2 & 14.5)

-- ============================================================================
-- 1. M08: Cột trạng thái xác nhận & đường cơ sở trung bình 3 kỳ cho meter_reading
-- ============================================================================
ALTER TABLE meter_reading
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'CONFIRMED',
  ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS baseline_avg_consumption NUMERIC(12,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_meter_reading_status'
  ) THEN
    ALTER TABLE meter_reading
      ADD CONSTRAINT chk_meter_reading_status CHECK (status IN ('DRAFT', 'CONFIRMED', 'FLAGGED'));
  END IF;
END $$;

UPDATE meter_reading
SET confirmed_at = COALESCE(confirmed_at, recorded_at),
    confirmed_by = COALESCE(confirmed_by, recorded_by)
WHERE status = 'CONFIRMED'
  AND confirmed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_meter_reading_status_period
  ON meter_reading(building_id, period, status);

-- ============================================================================
-- 2. M08 RBAC & RLS Hardening (PRD 6.2: SYS_ADMIN = R, OWNER = R, MANAGER = CRUD, RESIDENT = R CONFIRMED)
-- ============================================================================
DROP POLICY IF EXISTS rls_meter_select ON meter;
CREATE POLICY rls_meter_select ON meter FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR apartment_id IN (
    SELECT c.apartment_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
);

DROP POLICY IF EXISTS rls_meter_modify ON meter;
CREATE POLICY rls_meter_modify ON meter FOR ALL
USING (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
)
WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

DROP POLICY IF EXISTS rls_meter_reading_select ON meter_reading;
CREATE POLICY rls_meter_reading_select ON meter_reading FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR (
    status = 'CONFIRMED'
    AND apartment_id IN (
      SELECT c.apartment_id FROM contract c
      WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
    )
  )
);

DROP POLICY IF EXISTS rls_meter_reading_modify ON meter_reading;
CREATE POLICY rls_meter_reading_modify ON meter_reading FOR ALL
USING (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
)
WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

-- ============================================================================
-- 3. Mở rộng fn_get_finance_resource_scope (apartment, meter, meter_reading)
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_get_finance_resource_scope(
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

  IF v_entity_norm = 'service_catalog' THEN
    RETURN QUERY
    SELECT sc.id, sc.org_id, sc.building_id
    FROM service_catalog sc
    WHERE sc.id = p_id AND sc.org_id = v_caller_org;

  ELSIF v_entity_norm = 'service_subscription' THEN
    RETURN QUERY
    SELECT ss.id, ss.org_id, ss.building_id
    FROM service_subscription ss
    WHERE ss.id = p_id AND ss.org_id = v_caller_org;

  ELSIF v_entity_norm = 'contract_service_price' THEN
    RETURN QUERY
    SELECT csp.id, b.org_id, c.building_id
    FROM contract_service_price csp
    JOIN contract c ON c.id = csp.contract_id
    JOIN building b ON b.id = c.building_id
    WHERE csp.id = p_id AND b.org_id = v_caller_org;

  ELSIF v_entity_norm = 'invoice' THEN
    RETURN QUERY
    SELECT i.id, i.org_id, i.building_id
    FROM invoice i
    WHERE i.id = p_id AND i.org_id = v_caller_org;

  ELSIF v_entity_norm = 'invoice_adjustment' THEN
    RETURN QUERY
    SELECT ia.id, ia.org_id, ia.building_id
    FROM invoice_adjustment ia
    WHERE ia.id = p_id AND ia.org_id = v_caller_org;

  ELSIF v_entity_norm = 'payment' THEN
    RETURN QUERY
    SELECT p.id, p.org_id, p.building_id
    FROM payment p
    WHERE p.id = p_id AND p.org_id = v_caller_org;

  ELSIF v_entity_norm = 'receivable' THEN
    RETURN QUERY
    SELECT r.id, r.org_id, r.building_id
    FROM receivable r
    WHERE r.id = p_id AND r.org_id = v_caller_org;

  ELSIF v_entity_norm = 'credit_balance' THEN
    RETURN QUERY
    SELECT cb.id, cb.org_id, cb.building_id
    FROM credit_balance cb
    WHERE cb.id = p_id AND cb.org_id = v_caller_org;

  ELSIF v_entity_norm = 'contract' THEN
    RETURN QUERY
    SELECT c.id, b.org_id, c.building_id
    FROM contract c
    JOIN building b ON b.id = c.building_id
    WHERE c.id = p_id AND b.org_id = v_caller_org;

  ELSIF v_entity_norm = 'deposit' THEN
    RETURN QUERY
    SELECT d.id, b.org_id, c.building_id
    FROM deposit d
    JOIN contract c ON c.id = d.contract_id
    JOIN building b ON b.id = c.building_id
    WHERE d.id = p_id AND b.org_id = v_caller_org;

  ELSIF v_entity_norm = 'building' THEN
    RETURN QUERY
    SELECT b.id, b.org_id, b.id AS building_id
    FROM building b
    WHERE b.id = p_id AND b.org_id = v_caller_org;

  ELSIF v_entity_norm = 'apartment' THEN
    RETURN QUERY
    SELECT a.id, b.org_id, a.building_id
    FROM apartment a
    JOIN building b ON b.id = a.building_id
    WHERE a.id = p_id AND b.org_id = v_caller_org;

  ELSIF v_entity_norm = 'meter' THEN
    RETURN QUERY
    SELECT m.id, m.org_id, m.building_id
    FROM meter m
    WHERE m.id = p_id AND m.org_id = v_caller_org;

  ELSIF v_entity_norm = 'meter_reading' THEN
    RETURN QUERY
    SELECT mr.id, mr.org_id, mr.building_id
    FROM meter_reading mr
    WHERE mr.id = p_id AND mr.org_id = v_caller_org;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_get_finance_resource_scope(TEXT, UUID) TO resihub_app;

-- ============================================================================
-- 4. Mở rộng can_select_attachment (cư dân xem ảnh meter_reading CONFIRMED - FR-032)
-- ============================================================================
CREATE OR REPLACE FUNCTION can_select_attachment(p_owner_entity TEXT, p_owner_id UUID, p_uploaded_by UUID)
RETURNS BOOLEAN AS $$
BEGIN
  IF is_org_admin() OR p_uploaded_by = get_current_user_id() THEN
    RETURN TRUE;
  END IF;

  IF is_manager() OR is_owner() THEN
    IF p_owner_entity = 'contract' THEN
      RETURN EXISTS (
        SELECT 1 FROM contract c
        WHERE c.id = p_owner_id
          AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'person' THEN
      RETURN is_manager() AND EXISTS (
        SELECT 1 FROM person p
        WHERE p.id = p_owner_id
          AND can_select_person(p.id, p.org_id, p.phone, p.created_by)
      );
    ELSIF p_owner_entity = 'tenant' THEN
      RETURN is_manager() AND EXISTS (
        SELECT 1 FROM tenant t
        WHERE t.id = p_owner_id
          AND can_select_tenant(t.id, t.person_id, t.org_id, t.created_by, t.desired_building_id)
      );
    ELSIF p_owner_entity = 'deposit' THEN
      RETURN EXISTS (
        SELECT 1 FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        WHERE d.id = p_owner_id
          AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'reservation' THEN
      RETURN EXISTS (
        SELECT 1 FROM reservation r
        WHERE r.id = p_owner_id
          AND r.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'apartment' THEN
      RETURN EXISTS (
        SELECT 1 FROM apartment a
        WHERE a.id = p_owner_id
          AND a.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'service_request' THEN
      RETURN EXISTS (
        SELECT 1 FROM service_request sr
        WHERE sr.id = p_owner_id
          AND sr.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'payment' THEN
      RETURN EXISTS (
        SELECT 1 FROM payment pay
        WHERE pay.id = p_owner_id
          AND pay.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'meter_reading' THEN
      RETURN EXISTS (
        SELECT 1 FROM meter_reading mr
        WHERE mr.id = p_owner_id
          AND mr.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'credit_balance' THEN
      RETURN EXISTS (
        SELECT 1 FROM credit_balance cb
        WHERE cb.id = p_owner_id
          AND cb.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'invoice' THEN
      RETURN EXISTS (
        SELECT 1 FROM invoice i
        WHERE i.id = p_owner_id
          AND i.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'invoice_adjustment' THEN
      RETURN EXISTS (
        SELECT 1 FROM invoice_adjustment ia
        WHERE ia.id = p_owner_id
          AND ia.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    END IF;
  END IF;

  IF is_resident() THEN
    IF p_owner_entity = 'person' AND p_owner_id = get_current_user_person_id() THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'tenant' AND p_owner_id IN (SELECT tenant_id FROM get_resident_tenant_ids()) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'contract' AND p_owner_id IN (SELECT contract_id FROM get_resident_contract_ids()) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'deposit' AND EXISTS (
      SELECT 1 FROM deposit d
      WHERE d.id = p_owner_id
        AND d.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'reservation' AND EXISTS (
      SELECT 1 FROM reservation r
      WHERE r.id = p_owner_id
        AND r.phone = (SELECT phone FROM person WHERE id = get_current_user_person_id())
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'service_request' AND EXISTS (
      SELECT 1 FROM service_request sr
      WHERE sr.id = p_owner_id
        AND (sr.created_by = get_current_user_id() OR sr.apartment_id IN (
          SELECT c.apartment_id FROM contract c WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
        ))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'payment' AND EXISTS (
      SELECT 1 FROM payment pay
      WHERE pay.id = p_owner_id
        AND (pay.reported_by = get_current_user_id() OR pay.contract_id IN (SELECT contract_id FROM get_resident_contract_ids()))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'meter_reading' AND EXISTS (
      SELECT 1 FROM meter_reading mr
      WHERE mr.id = p_owner_id
        AND mr.status = 'CONFIRMED'
        AND mr.apartment_id IN (
          SELECT c.apartment_id FROM contract c
          WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
        )
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'credit_balance' AND EXISTS (
      SELECT 1 FROM credit_balance cb
      WHERE cb.id = p_owner_id
        AND (cb.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          OR cb.tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids()))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'invoice' AND EXISTS (
      SELECT 1 FROM invoice i
      WHERE i.id = p_owner_id
        AND i.status <> 'DRAFT'
        AND (i.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          OR i.tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids()))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'invoice_adjustment' AND EXISTS (
      SELECT 1 FROM invoice_adjustment ia
      JOIN invoice i ON i.id = ia.invoice_id
      WHERE ia.id = p_owner_id
        AND ia.status = 'APPROVED'
        AND (i.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          OR i.tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids()))
    ) THEN
      RETURN TRUE;
    END IF;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- ============================================================================
-- 5. Mở rộng rls_audit_log_select (bổ sung meter & meter_reading theo building_id)
-- ============================================================================
DROP POLICY IF EXISTS rls_audit_log_select ON audit_log;
CREATE POLICY rls_audit_log_select ON audit_log FOR SELECT
  USING (
    is_org_admin()
    OR actor_id = get_current_user_id()
    OR (
      is_owner() AND (
        (entity = 'building' AND entity_id IN (SELECT building_id FROM get_owner_building_ids()))
        OR (entity = 'apartment' AND entity_id IN (SELECT id FROM apartment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'reservation' AND entity_id IN (SELECT id FROM reservation WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'contract' AND entity_id IN (SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'deposit' AND entity_id IN (SELECT d.id FROM deposit d JOIN contract c ON c.id = d.contract_id WHERE c.building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'deposit_transaction' AND entity_id IN (
          SELECT dt.id
          FROM deposit_transaction dt
          JOIN deposit d ON d.id = dt.deposit_id
          JOIN contract c ON c.id = d.contract_id
          WHERE c.building_id IN (SELECT building_id FROM get_owner_building_ids())
        ))
        OR (entity = 'invoice' AND entity_id IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'invoice_line' AND (
          entity_id IN (SELECT il.id FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id WHERE i.building_id IN (SELECT building_id FROM get_owner_building_ids()))
          OR (before->>'invoice_id')::uuid IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_owner_building_ids()))
        ))
        OR (entity = 'invoice_adjustment' AND entity_id IN (SELECT id FROM invoice_adjustment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'payment' AND entity_id IN (SELECT id FROM payment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'receivable' AND entity_id IN (SELECT id FROM receivable WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'credit_balance' AND entity_id IN (SELECT id FROM credit_balance WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'service_subscription' AND entity_id IN (SELECT id FROM service_subscription WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'service_catalog' AND (
          entity_id IN (SELECT id FROM service_catalog WHERE building_id IN (SELECT building_id FROM get_owner_building_ids()))
          OR entity_id IN (SELECT id FROM service_catalog WHERE building_id IS NULL AND org_id = get_current_user_org_id())
        ))
        OR (entity = 'contract_service_price' AND entity_id IN (
          SELECT csp.id FROM contract_service_price csp JOIN contract c ON c.id = csp.contract_id WHERE c.building_id IN (SELECT building_id FROM get_owner_building_ids())
        ))
        OR (entity = 'meter' AND entity_id IN (SELECT id FROM meter WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'meter_reading' AND entity_id IN (SELECT id FROM meter_reading WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
      )
    )
    OR (
      is_manager() AND (
        (entity = 'building' AND entity_id IN (SELECT building_id FROM get_manager_building_ids()))
        OR (entity = 'apartment' AND entity_id IN (SELECT id FROM apartment WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'reservation' AND entity_id IN (SELECT id FROM reservation WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'contract' AND entity_id IN (SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'deposit' AND entity_id IN (SELECT d.id FROM deposit d JOIN contract c ON c.id = d.contract_id WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'deposit_transaction' AND entity_id IN (
          SELECT dt.id
          FROM deposit_transaction dt
          JOIN deposit d ON d.id = dt.deposit_id
          JOIN contract c ON c.id = d.contract_id
          WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
        ))
        OR (entity = 'invoice' AND entity_id IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'invoice_line' AND (
          entity_id IN (SELECT il.id FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id WHERE i.building_id IN (SELECT building_id FROM get_manager_building_ids()))
          OR (before->>'invoice_id')::uuid IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids()))
        ))
        OR (entity = 'invoice_adjustment' AND entity_id IN (SELECT id FROM invoice_adjustment WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'payment' AND entity_id IN (SELECT id FROM payment WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'receivable' AND entity_id IN (SELECT id FROM receivable WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'credit_balance' AND entity_id IN (SELECT id FROM credit_balance WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'service_subscription' AND entity_id IN (SELECT id FROM service_subscription WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'service_catalog' AND (
          entity_id IN (SELECT id FROM service_catalog WHERE building_id IN (SELECT building_id FROM get_manager_building_ids()))
          OR entity_id IN (SELECT id FROM service_catalog WHERE building_id IS NULL AND org_id = get_current_user_org_id())
        ))
        OR (entity = 'contract_service_price' AND entity_id IN (
          SELECT csp.id FROM contract_service_price csp JOIN contract c ON c.id = csp.contract_id WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
        ))
        OR (entity = 'meter' AND entity_id IN (SELECT id FROM meter WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'meter_reading' AND entity_id IN (SELECT id FROM meter_reading WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
      )
    )
  );

-- ============================================================================
-- 6. Bảng lịch sử chạy cron job (PRD 14.5: quan sát, retry & chống chồng chéo)
-- ============================================================================
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

CREATE INDEX IF NOT EXISTS idx_cron_job_run_date
  ON cron_job_run(job_name, run_date DESC, started_at DESC);

GRANT SELECT ON TABLE cron_job_run TO resihub_app;

ALTER TABLE cron_job_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE cron_job_run FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_cron_job_run_select ON cron_job_run;
CREATE POLICY rls_cron_job_run_select ON cron_job_run FOR SELECT
  USING (is_org_admin());

-- ============================================================================
-- 7. Hợp nhất cấu hình mặc định billing_config (không ghi đè giá trị tổ chức đã lưu)
-- ============================================================================
UPDATE system_setting
SET value = '{"due_date_offset_days": 5, "late_fee_grace_days": 5, "late_fee_per_day": 100000, "late_fee_cap": null, "meter_anomaly_threshold_pct": 30}'::jsonb
            || COALESCE(value, '{}'::jsonb)
WHERE key = 'billing_config';

