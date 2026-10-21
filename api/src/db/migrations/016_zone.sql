-- 016_zone.sql
-- B1 / FR-007: phân khu (Khu/Block) trong tòa nhà — cây Tòa · Khu/Block · Tầng · Căn hộ.
CREATE TABLE IF NOT EXISTS zone (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organization(id),
  building_id UUID NOT NULL REFERENCES building(id),
  code        TEXT NOT NULL,
  name        TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (building_id, code)
);

ALTER TABLE apartment ADD COLUMN IF NOT EXISTS zone_id UUID REFERENCES zone(id);

-- RLS: sao chép policy của floor (013) — cùng ngữ cảnh truy cập
ALTER TABLE zone ENABLE ROW LEVEL SECURITY;
ALTER TABLE zone FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_zone_select ON zone;
CREATE POLICY rls_zone_select ON zone FOR SELECT
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (
    SELECT c.building_id FROM contract c
    WHERE c.primary_tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
      AND c.status = 'ACTIVE'
  )
);

DROP POLICY IF EXISTS rls_zone_insert ON zone;
CREATE POLICY rls_zone_insert ON zone FOR INSERT
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

DROP POLICY IF EXISTS rls_zone_update ON zone;
CREATE POLICY rls_zone_update ON zone FOR UPDATE
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

DROP POLICY IF EXISTS rls_zone_delete ON zone;
CREATE POLICY rls_zone_delete ON zone FOR DELETE
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);
