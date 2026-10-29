-- 023_service_request_table.sql
-- Module M11: Yêu cầu & Báo hỏng (FR-042 -> FR-046, AC-004.1, AC-004.2)

CREATE TABLE IF NOT EXISTS service_request (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id     UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  apartment_id    UUID NOT NULL REFERENCES apartment(id) ON DELETE CASCADE,
  created_by      UUID REFERENCES app_user(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'OTHER'
                  CHECK (category IN ('ELECTRICAL','PLUMBING','HVAC','FURNITURE','APPLIANCE','CLEANING','SECURITY','OTHER')),
  description     TEXT NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'NORMAL'
                  CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status          TEXT NOT NULL DEFAULT 'NEW'
                  CHECK (status IN ('NEW','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED','CANCELLED')),
  tracking_code   TEXT NOT NULL UNIQUE,
  images          TEXT[] DEFAULT '{}',
  assigned_to     UUID REFERENCES app_user(id) ON DELETE SET NULL,
  internal_note   TEXT,
  resolved_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  rating          INTEGER CHECK (rating BETWEEN 1 AND 5),
  rating_note     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_request_org_status ON service_request(org_id, status);
CREATE INDEX IF NOT EXISTS idx_service_request_building_status ON service_request(building_id, status);
CREATE INDEX IF NOT EXISTS idx_service_request_apartment ON service_request(apartment_id, status);
CREATE INDEX IF NOT EXISTS idx_service_request_created_by ON service_request(created_by);

GRANT ALL PRIVILEGES ON TABLE service_request TO resihub_app;

-- Helper kiểm tra STAFF / ACCOUNTANT cho các bảng vận hành mới
CREATE OR REPLACE FUNCTION get_staff_building_ids()
RETURNS TABLE (building_id UUID) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT ur.building_id
  FROM user_role ur
  JOIN role r ON r.id = ur.role_id
  WHERE ur.user_id = v_user_id
    AND r.code IN ('MANAGER', 'STAFF', 'ACCOUNTANT')
    AND ur.building_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

ALTER TABLE service_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_service_request_select ON service_request;
CREATE POLICY rls_service_request_select ON service_request FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR created_by = get_current_user_id()
  OR apartment_id IN (
    SELECT c.apartment_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
);

DROP POLICY IF EXISTS rls_service_request_insert ON service_request;
CREATE POLICY rls_service_request_insert ON service_request FOR INSERT WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR created_by = get_current_user_id()
);

DROP POLICY IF EXISTS rls_service_request_update ON service_request;
CREATE POLICY rls_service_request_update ON service_request FOR UPDATE
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR created_by = get_current_user_id()
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR created_by = get_current_user_id()
);

DROP POLICY IF EXISTS rls_service_request_delete ON service_request;
CREATE POLICY rls_service_request_delete ON service_request FOR DELETE USING (
  is_org_admin()
);

-- Seed dữ liệu mẫu báo hỏng cho các căn đang thuê (nếu bảng đang trống)
INSERT INTO service_request (org_id, building_id, apartment_id, created_by, title, category, description, priority, status, tracking_code, created_at)
SELECT
  b.org_id,
  c.building_id,
  c.apartment_id,
  au.id,
  CASE (ROW_NUMBER() OVER (ORDER BY c.created_at)) % 4
    WHEN 0 THEN 'Điều hòa phòng ngủ không mát'
    WHEN 1 THEN 'Rò rỉ nước dưới bồn rửa bếp'
    WHEN 2 THEN 'Đèn trần phòng khách nhấp nháy'
    ELSE 'Khóa từ cửa chính báo pin yếu'
  END,
  CASE (ROW_NUMBER() OVER (ORDER BY c.created_at)) % 4
    WHEN 0 THEN 'HVAC'
    WHEN 1 THEN 'PLUMBING'
    WHEN 2 THEN 'ELECTRICAL'
    ELSE 'SECURITY'
  END,
  'Cư dân phản ánh sự cố phát sinh trong quá trình sinh hoạt, đề nghị kỹ thuật tòa nhà kiểm tra và xử lý sớm.',
  CASE (ROW_NUMBER() OVER (ORDER BY c.created_at)) % 4
    WHEN 0 THEN 'HIGH'
    WHEN 1 THEN 'URGENT'
    WHEN 2 THEN 'NORMAL'
    ELSE 'LOW'
  END,
  CASE (ROW_NUMBER() OVER (ORDER BY c.created_at)) % 4
    WHEN 0 THEN 'NEW'
    WHEN 1 THEN 'IN_PROGRESS'
    WHEN 2 THEN 'RESOLVED'
    ELSE 'ASSIGNED'
  END,
  'SR-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD((ROW_NUMBER() OVER (ORDER BY c.created_at))::text, 4, '0'),
  NOW() - ((ROW_NUMBER() OVER (ORDER BY c.created_at)) || ' hours')::interval
FROM contract c
JOIN building b ON b.id = c.building_id
JOIN tenant t ON t.id = c.primary_tenant_id
LEFT JOIN app_user au ON au.person_id = t.person_id
WHERE c.status = 'ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM service_request LIMIT 1)
LIMIT 18;

