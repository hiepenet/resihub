-- 050_m11_m13_service_requests_sla_and_zalo_announcements.sql
-- Week 6: Service Requests & SLA Dispatch (M11: FR-042..FR-047, AC-004.1, AC-004.2, RP-05)
--       & Scoped Announcements + Zalo Group Copy Workflow (M13: FR-053..FR-056, FR-069, PRD 6.2, 13.2, 13.6, 14.3)

BEGIN;

-- ============================================================================
-- 1. M11: Extend service_request schema, status check constraint & SLA backfill
-- ============================================================================
ALTER TABLE service_request
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_detail TEXT,
  ADD COLUMN IF NOT EXISTS preferred_slot TEXT,
  ADD COLUMN IF NOT EXISTS sla_response_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hold_reason TEXT,
  ADD COLUMN IF NOT EXISTS next_appointment_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_note TEXT,
  ADD COLUMN IF NOT EXISTS resolution_images JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopen_reason TEXT,
  ADD COLUMN IF NOT EXISTS reopen_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'service_request'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE service_request DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  ALTER TABLE service_request
    ADD CONSTRAINT service_request_status_check
    CHECK (status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'REOPENED', 'CLOSED', 'CANCELLED'));
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_service_request_tracking_code
  ON service_request(tracking_code);

CREATE INDEX IF NOT EXISTS idx_service_request_sla_due
  ON service_request(status, sla_due_at);

UPDATE service_request
SET sla_response_due_at = COALESCE(sla_response_due_at, created_at + INTERVAL '2 hours'),
    sla_due_at = COALESCE(
      sla_due_at,
      created_at + CASE WHEN priority = 'URGENT' THEN INTERVAL '4 hours' ELSE INTERVAL '24 hours' END
    )
WHERE sla_response_due_at IS NULL
   OR sla_due_at IS NULL;

-- ============================================================================
-- 2. M13: Create zalo_group & announcement tables + notification.announcement_id
-- ============================================================================
CREATE TABLE IF NOT EXISTS zalo_group (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id  UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  apartment_id UUID REFERENCES apartment(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL CHECK (scope IN ('BUILDING', 'APARTMENT')),
  name         TEXT NOT NULL,
  invite_link  TEXT,
  note         TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_zalo_group_scope_target CHECK (
    (scope = 'BUILDING' AND apartment_id IS NULL)
    OR (scope = 'APARTMENT' AND apartment_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_zalo_group_target_name
  ON zalo_group (
    building_id,
    COALESCE(apartment_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(name))
  );

CREATE INDEX IF NOT EXISTS idx_zalo_group_building_scope
  ON zalo_group(building_id, scope, is_active);

CREATE INDEX IF NOT EXISTS idx_zalo_group_apartment
  ON zalo_group(apartment_id)
  WHERE apartment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS announcement (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id        UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  target_scope       TEXT NOT NULL CHECK (target_scope IN ('BUILDING', 'FLOOR', 'APARTMENT')),
  floor_id           UUID REFERENCES floor(id) ON DELETE SET NULL,
  apartment_id       UUID REFERENCES apartment(id) ON DELETE SET NULL,
  audience           JSONB NOT NULL DEFAULT '{}'::jsonb,
  type               TEXT NOT NULL DEFAULT 'ANNOUNCEMENT'
                     CHECK (type IN ('ANNOUNCEMENT', 'MAINTENANCE_NOTICE', 'SECURITY_ALERT', 'UTILITY_INTERRUPTION', 'HOUSE_RULES', 'SYSTEM')),
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  zalo_content       TEXT,
  channels           TEXT[] NOT NULL DEFAULT ARRAY['IN_APP', 'ZALO_MANUAL'],
  status             TEXT NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT', 'SCHEDULED', 'SENT', 'CANCELLED')),
  scheduled_at       TIMESTAMPTZ,
  sent_at            TIMESTAMPTZ,
  manual_sent_at     TIMESTAMPTZ,
  manual_sent_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
  manual_sent_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  recipient_count    INT NOT NULL DEFAULT 0,
  created_by         UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_announcement_building_status
  ON announcement(building_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_announcement_scheduled_due
  ON announcement(status, scheduled_at)
  WHERE status = 'SCHEDULED';

ALTER TABLE notification
  ADD COLUMN IF NOT EXISTS announcement_id UUID REFERENCES announcement(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notification_announcement_id
  ON notification(announcement_id);

-- ============================================================================
-- 3. SECURITY DEFINER RPCs for 403/404 Scope Resolution & Manager Alerts
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

CREATE OR REPLACE FUNCTION fn_list_building_assignees(
  p_building_id UUID
)
RETURNS TABLE (
  id UUID,
  full_name TEXT,
  phone TEXT,
  role_code TEXT
) AS $$
BEGIN
  IF p_building_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT (
    is_org_admin()
    OR p_building_id IN (SELECT gb.building_id FROM get_user_assigned_buildings() gb)
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT au.id, p.full_name, p.phone, r.code AS role_code
  FROM app_user au
  JOIN person p ON p.id = au.person_id
  JOIN user_role ur ON ur.user_id = au.id
  JOIN role r ON r.id = ur.role_id
  WHERE au.status = 'ACTIVE'
    AND r.code = 'MANAGER'
    AND ur.building_id = p_building_id
  ORDER BY p.full_name ASC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_list_building_assignees(UUID) TO resihub_app;

CREATE OR REPLACE FUNCTION fn_notify_service_request_managers(
  p_service_request_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_content TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS INT AS $$
DECLARE
  v_sr service_request%ROWTYPE;
  v_caller UUID;
  v_authorized BOOLEAN := FALSE;
  v_inserted INT := 0;
BEGIN
  v_caller := get_current_user_id();
  IF v_caller IS NULL OR p_service_request_id IS NULL THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sr
  FROM service_request
  WHERE id = p_service_request_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF is_manager() AND v_sr.building_id IN (SELECT gb.building_id FROM get_manager_building_ids() gb) THEN
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

  INSERT INTO notification (org_id, user_id, type, title, content, payload)
  SELECT
    v_sr.org_id,
    recipients.user_id,
    COALESCE(NULLIF(btrim(p_type), ''), 'SERVICE_REQUEST_CREATED'),
    p_title,
    p_content,
    COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object(
      'service_request_id', v_sr.id,
      'tracking_code', v_sr.tracking_code,
      'building_id', v_sr.building_id,
      'apartment_id', v_sr.apartment_id
    )
  FROM (
    SELECT DISTINCT au.id AS user_id
    FROM app_user au
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    WHERE au.status = 'ACTIVE'
      AND r.code = 'MANAGER'
      AND ur.building_id = v_sr.building_id
    UNION
    SELECT au2.id AS user_id
    FROM app_user au2
    WHERE v_sr.assigned_to IS NOT NULL
      AND au2.id = v_sr.assigned_to
      AND au2.status = 'ACTIVE'
  ) recipients;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_notify_service_request_managers(UUID, TEXT, TEXT, TEXT, JSONB) TO resihub_app;

-- ============================================================================
-- 4. Privilege & 2-Layer FORCE ROW LEVEL SECURITY Policies (PRD 6.2 & NFR-008)
-- ============================================================================
REVOKE DELETE, TRUNCATE ON TABLE service_request FROM resihub_app;
GRANT SELECT, INSERT, UPDATE ON TABLE service_request TO resihub_app;
GRANT SELECT, INSERT, UPDATE ON TABLE zalo_group TO resihub_app;
GRANT SELECT, INSERT, UPDATE ON TABLE announcement TO resihub_app;

ALTER TABLE service_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_service_request_select ON service_request;
DROP POLICY IF EXISTS rls_service_request_insert ON service_request;
DROP POLICY IF EXISTS rls_service_request_update ON service_request;
DROP POLICY IF EXISTS rls_service_request_delete ON service_request;

CREATE POLICY rls_service_request_select ON service_request FOR SELECT
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR created_by = get_current_user_id()
  OR apartment_id IN (
    SELECT c.apartment_id
    FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
);

CREATE POLICY rls_service_request_insert ON service_request FOR INSERT
WITH CHECK (
  (
    is_manager()
    AND building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  OR (
    is_resident()
    AND apartment_id IN (
      SELECT c.apartment_id
      FROM contract c
      WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
    )
  )
);

CREATE POLICY rls_service_request_update ON service_request FOR UPDATE
USING (
  (
    is_manager()
    AND building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  OR (
    is_resident()
    AND (
      created_by = get_current_user_id()
      OR apartment_id IN (
        SELECT c.apartment_id
        FROM contract c
        WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
      )
    )
  )
)
WITH CHECK (
  (
    is_manager()
    AND building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  OR (
    is_resident()
    AND (
      created_by = get_current_user_id()
      OR apartment_id IN (
        SELECT c.apartment_id
        FROM contract c
        WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
      )
    )
  )
);

CREATE POLICY rls_service_request_delete ON service_request FOR DELETE
USING (FALSE);

-- zalo_group RLS
ALTER TABLE zalo_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE zalo_group FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_zalo_group_select ON zalo_group;
DROP POLICY IF EXISTS rls_zalo_group_insert ON zalo_group;
DROP POLICY IF EXISTS rls_zalo_group_update ON zalo_group;
DROP POLICY IF EXISTS rls_zalo_group_delete ON zalo_group;

CREATE POLICY rls_zalo_group_select ON zalo_group FOR SELECT
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

CREATE POLICY rls_zalo_group_insert ON zalo_group FOR INSERT
WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

CREATE POLICY rls_zalo_group_update ON zalo_group FOR UPDATE
USING (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
)
WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

CREATE POLICY rls_zalo_group_delete ON zalo_group FOR DELETE
USING (FALSE);

-- announcement RLS
ALTER TABLE announcement ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_announcement_select ON announcement;
DROP POLICY IF EXISTS rls_announcement_insert ON announcement;
DROP POLICY IF EXISTS rls_announcement_update ON announcement;
DROP POLICY IF EXISTS rls_announcement_delete ON announcement;

CREATE POLICY rls_announcement_select ON announcement FOR SELECT
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR (
    is_resident()
    AND status = 'SENT'
    AND (
      (
        target_scope = 'BUILDING'
        AND EXISTS (
          SELECT 1 FROM contract c
          WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
            AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
            AND c.building_id = announcement.building_id
        )
      )
      OR (
        target_scope = 'FLOOR'
        AND EXISTS (
          SELECT 1 FROM contract c
          JOIN apartment apt ON apt.id = c.apartment_id
          WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
            AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
            AND apt.floor_id = announcement.floor_id
        )
      )
      OR (
        target_scope = 'APARTMENT'
        AND EXISTS (
          SELECT 1 FROM contract c
          WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
            AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
            AND c.apartment_id = announcement.apartment_id
        )
      )
    )
  )
);

CREATE POLICY rls_announcement_insert ON announcement FOR INSERT
WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

CREATE POLICY rls_announcement_update ON announcement FOR UPDATE
USING (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
)
WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

CREATE POLICY rls_announcement_delete ON announcement FOR DELETE
USING (FALSE);

-- Extend rls_notification_select for FR-056 read-receipt counters
DROP POLICY IF EXISTS rls_notification_select ON notification;
CREATE POLICY rls_notification_select ON notification FOR SELECT
USING (
  is_org_admin()
  OR user_id = get_current_user_id()
  OR (
    user_id IS NULL
    AND get_current_user_id() IS NOT NULL
    AND org_id = get_current_user_org_id()
  )
  OR (
    (is_manager() OR is_accountant())
    AND org_id = get_current_user_org_id()
    AND (payload->>'sent_by') = get_current_user_id()::text
  )
  OR (
    (is_manager() OR is_owner())
    AND announcement_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM announcement ann
      WHERE ann.id = notification.announcement_id
        AND ann.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
    )
  )
);

-- Additive permissive policy on audit_log FOR SELECT for M11 & M13 entities
DROP POLICY IF EXISTS rls_audit_log_select_m11_m13 ON audit_log;
CREATE POLICY rls_audit_log_select_m11_m13 ON audit_log FOR SELECT
USING (
  (is_owner() OR is_manager())
  AND (
    (
      entity = 'service_request'
      AND (
        entity_id IN (
          SELECT sr.id FROM service_request sr
          WHERE sr.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        )
        OR entity_id IN (SELECT building_id FROM get_user_assigned_buildings())
      )
    )
    OR (
      entity = 'announcement'
      AND (
        entity_id IN (
          SELECT ann.id FROM announcement ann
          WHERE ann.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        )
        OR entity_id IN (SELECT building_id FROM get_user_assigned_buildings())
      )
    )
    OR (
      entity = 'zalo_group'
      AND (
        entity_id IN (
          SELECT zg.id FROM zalo_group zg
          WHERE zg.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        )
        OR entity_id IN (SELECT building_id FROM get_user_assigned_buildings())
      )
    )
    OR (
      entity = 'notification'
      AND (
        entity_id IN (
          SELECT n.id FROM notification n
          JOIN announcement ann ON ann.id = n.announcement_id
          WHERE ann.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        )
        OR entity_id IN (SELECT building_id FROM get_user_assigned_buildings())
      )
    )
  )
);

-- ============================================================================
-- 5. Merge reopen_window_days into system_setting (sla_config)
-- ============================================================================
UPDATE system_setting
SET value = '{"reopen_window_days": 3}'::jsonb || COALESCE(value, '{}'::jsonb)
WHERE key = 'sla_config';

COMMIT;
