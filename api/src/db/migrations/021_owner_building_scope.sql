-- 021_owner_building_scope.sql
-- Fix phân quyền OWNER: Mỗi Owner chỉ xem được chung cư mà mình sở hữu
-- Thay vì OWNER có quyền god-mode xem toàn bộ org như hiện tại
-- Theo PRD v2.0 - FR-070: Multi-owner management

-- ============================================================================
-- 1. Thêm person_id vào bảng owner để liên kết owner ↔ person (auth)
-- ============================================================================
ALTER TABLE owner ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES person(id);

-- Backfill person_id bằng cách map email owner → person
UPDATE owner o
SET person_id = p.id
FROM person p
WHERE o.email = p.email AND o.person_id IS NULL;

-- Index cho truy vấn nhanh
CREATE INDEX IF NOT EXISTS idx_owner_person_id ON owner(person_id);
CREATE INDEX IF NOT EXISTS idx_building_owner_id ON building(owner_id);

-- ============================================================================
-- 2. Tạo hàm is_owner() — kiểm tra user có role OWNER
-- ============================================================================
CREATE OR REPLACE FUNCTION is_owner()
RETURNS BOOLEAN AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.user_id = v_user_id AND r.code = 'OWNER'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- ============================================================================
-- 3. Sửa is_org_admin() — CHỈ trả TRUE cho SYS_ADMIN (loại bỏ OWNER)
-- ============================================================================
CREATE OR REPLACE FUNCTION is_org_admin()
RETURNS BOOLEAN AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.user_id = v_user_id AND r.code = 'SYS_ADMIN'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- ============================================================================
-- 4. Tạo is_org_member() — OWNER hoặc SYS_ADMIN (giữ logic cũ cho bảng 
--    không có scope theo building: person, tenant, organization, role, ...)
-- ============================================================================
CREATE OR REPLACE FUNCTION is_org_member()
RETURNS BOOLEAN AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.user_id = v_user_id AND r.code IN ('OWNER', 'SYS_ADMIN')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- ============================================================================
-- 5. Tạo get_owner_building_ids() — trả về danh sách building mà OWNER sở hữu
-- ============================================================================
CREATE OR REPLACE FUNCTION get_owner_building_ids()
RETURNS TABLE (building_id UUID) AS $$
DECLARE
  v_person_id UUID;
  v_org_id UUID;
BEGIN
  v_person_id := get_current_user_person_id();
  v_org_id := get_current_user_org_id();

  IF v_person_id IS NULL OR v_org_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT b.id
  FROM building b
  JOIN owner o ON o.id = b.owner_id
  WHERE o.person_id = v_person_id AND b.org_id = v_org_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- ============================================================================
-- 6. Sửa get_user_assigned_buildings() — OWNER chỉ nhận buildings mình sở hữu
-- ============================================================================
CREATE OR REPLACE FUNCTION get_user_assigned_buildings()
RETURNS TABLE (building_id UUID) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- SYS_ADMIN → Toàn bộ tòa thuộc org
  IF is_org_admin() THEN
    RETURN QUERY
    SELECT b.id
    FROM building b
    WHERE b.org_id = get_current_user_org_id();
    RETURN;
  END IF;

  -- OWNER → Chỉ các tòa mình sở hữu (qua owner.person_id)
  IF is_owner() THEN
    RETURN QUERY
    SELECT gb.building_id FROM get_owner_building_ids() gb;
    RETURN;
  END IF;

  -- MANAGER/STAFF → Các tòa nhà được gán cụ thể
  RETURN QUERY
  SELECT ur.building_id
  FROM user_role ur
  WHERE ur.user_id = v_user_id AND ur.building_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- ============================================================================
-- 7. Cập nhật RLS policies cho các bảng KHÔNG có scope theo building
--    (person, tenant, organization, owner, role, app_user, user_role, audit_log)
--    Thay is_org_admin() → is_org_member() để OWNER vẫn truy cập được
-- ============================================================================

-- 7a. PERSON - SELECT
DROP POLICY IF EXISTS rls_person_select ON person;
CREATE POLICY rls_person_select ON person FOR SELECT USING (
  is_org_member()
  OR person.id = get_current_user_person_id()
);

-- 7b. PERSON - INSERT/UPDATE/DELETE
DROP POLICY IF EXISTS rls_person_insert ON person;
CREATE POLICY rls_person_insert ON person FOR INSERT WITH CHECK (is_org_member());

DROP POLICY IF EXISTS rls_person_update ON person;
CREATE POLICY rls_person_update ON person FOR UPDATE
  USING (is_org_member())
  WITH CHECK (is_org_member());

DROP POLICY IF EXISTS rls_person_delete ON person;
CREATE POLICY rls_person_delete ON person FOR DELETE USING (is_org_member());

-- 7c. TENANT - SELECT
DROP POLICY IF EXISTS rls_tenant_select ON tenant;
CREATE POLICY rls_tenant_select ON tenant FOR SELECT USING (
  is_org_member()
  OR tenant.org_id = get_current_user_org_id() AND tenant.id IN (SELECT tid FROM get_resident_tenant_ids() AS tid)
);

-- 7d. TENANT - INSERT/UPDATE/DELETE (OWNER và SYS_ADMIN đều cần)
DROP POLICY IF EXISTS rls_tenant_insert ON tenant;
CREATE POLICY rls_tenant_insert ON tenant FOR INSERT WITH CHECK (
  is_org_member()
  OR (
    tenant.org_id = get_current_user_org_id()
    AND tenant.person_id = get_current_user_person_id()
  )
);

DROP POLICY IF EXISTS rls_tenant_update ON tenant;
CREATE POLICY rls_tenant_update ON tenant FOR UPDATE
  USING (is_org_member())
  WITH CHECK (is_org_member());

DROP POLICY IF EXISTS rls_tenant_delete ON tenant;
CREATE POLICY rls_tenant_delete ON tenant FOR DELETE USING (is_org_member());

-- 7e. ORGANIZATION - SELECT/MODIFY
DROP POLICY IF EXISTS rls_organization_select ON organization;
CREATE POLICY rls_organization_select ON organization FOR SELECT USING (
  id = get_current_user_org_id() OR is_org_member()
);

DROP POLICY IF EXISTS rls_organization_modify ON organization;
CREATE POLICY rls_organization_modify ON organization FOR ALL USING (is_org_admin());

-- 7f. OWNER table - SELECT/MODIFY
DROP POLICY IF EXISTS rls_owner_select ON owner;
CREATE POLICY rls_owner_select ON owner FOR SELECT USING (
  org_id = get_current_user_org_id() OR is_org_member()
);

DROP POLICY IF EXISTS rls_owner_modify ON owner;
CREATE POLICY rls_owner_modify ON owner FOR ALL USING (is_org_admin());

-- 7g. ROLE - SELECT/MODIFY (mọi user trong org cần đọc danh sách role)
DROP POLICY IF EXISTS rls_role_select ON role;
CREATE POLICY rls_role_select ON role FOR SELECT USING (
  org_id = get_current_user_org_id() OR is_org_member()
);

DROP POLICY IF EXISTS rls_role_modify ON role;
CREATE POLICY rls_role_modify ON role FOR ALL USING (is_org_admin());

-- 7h. APP_USER - SELECT/INSERT/UPDATE/DELETE
DROP POLICY IF EXISTS rls_app_user_select ON app_user;
CREATE POLICY rls_app_user_select ON app_user FOR SELECT USING (
  is_org_member()
  OR id = get_current_user_id()
);

DROP POLICY IF EXISTS rls_app_user_insert ON app_user;
CREATE POLICY rls_app_user_insert ON app_user FOR INSERT WITH CHECK (is_org_member());

DROP POLICY IF EXISTS rls_app_user_update ON app_user;
CREATE POLICY rls_app_user_update ON app_user FOR UPDATE
  USING (is_org_member() OR id = get_current_user_id())
  WITH CHECK (is_org_member() OR id = get_current_user_id());

DROP POLICY IF EXISTS rls_app_user_delete ON app_user;
CREATE POLICY rls_app_user_delete ON app_user FOR DELETE USING (is_org_admin());

-- 7i. USER_ROLE - SELECT/INSERT/UPDATE/DELETE
DROP POLICY IF EXISTS rls_user_role_select ON user_role;
CREATE POLICY rls_user_role_select ON user_role FOR SELECT USING (
  is_org_member()
  OR user_id = get_current_user_id()
);

DROP POLICY IF EXISTS rls_user_role_insert ON user_role;
CREATE POLICY rls_user_role_insert ON user_role FOR INSERT WITH CHECK (is_org_admin());

DROP POLICY IF EXISTS rls_user_role_update ON user_role;
CREATE POLICY rls_user_role_update ON user_role FOR UPDATE
  USING (is_org_admin())
  WITH CHECK (is_org_admin());

DROP POLICY IF EXISTS rls_user_role_delete ON user_role;
CREATE POLICY rls_user_role_delete ON user_role FOR DELETE USING (is_org_admin());

-- 7j. AUDIT_LOG - SELECT
DROP POLICY IF EXISTS rls_audit_log_select ON audit_log;
CREATE POLICY rls_audit_log_select ON audit_log FOR SELECT USING (is_org_member());

-- ============================================================================
-- 8. Cập nhật RLS policies cho BUILDING — OWNER chỉ thấy building mình sở hữu
-- ============================================================================
DROP POLICY IF EXISTS rls_building_select ON building;
CREATE POLICY rls_building_select ON building FOR SELECT USING (
  is_org_admin()
  OR id IN (SELECT gb.building_id FROM get_user_assigned_buildings() gb)
  OR (
    -- RESIDENT: xem tòa có hợp đồng của mình
    org_id = get_current_user_org_id()
    AND id IN (
      SELECT c.building_id FROM contract c
      JOIN tenant t ON t.id = c.primary_tenant_id
      WHERE t.person_id = get_current_user_person_id()
    )
  )
);

-- Building INSERT/UPDATE/DELETE — chỉ admin hoặc manager có quyền
DROP POLICY IF EXISTS rls_building_modify ON building;
DROP POLICY IF EXISTS rls_building_insert ON building;
CREATE POLICY rls_building_insert ON building FOR INSERT WITH CHECK (
  is_org_admin()
  OR id IN (SELECT gb.building_id FROM get_user_assigned_buildings() gb)
);

DROP POLICY IF EXISTS rls_building_update ON building;
CREATE POLICY rls_building_update ON building FOR UPDATE
  USING (is_org_admin() OR id IN (SELECT gb.building_id FROM get_user_assigned_buildings() gb))
  WITH CHECK (is_org_admin() OR id IN (SELECT gb.building_id FROM get_user_assigned_buildings() gb));

DROP POLICY IF EXISTS rls_building_delete ON building;
CREATE POLICY rls_building_delete ON building FOR DELETE USING (is_org_admin());

-- ============================================================================
-- 9. Các bảng scope theo building (apartment, floor, zone, contract, deposit, 
--    deposit_transaction, reservation, notification, contract_request,
--    attachment, contract_version, contract_occupant, contract_service_price)
--    Các bảng này đã dùng get_user_assigned_buildings() nên tự động fix
--    khi hàm get_user_assigned_buildings() được cập nhật ở bước 6.
--    Chỉ cần đảm bảo policy có fallback is_org_admin() → nay chỉ SYS_ADMIN.
-- ============================================================================

-- Không cần thay đổi thêm — các policy SELECT trên apartment, floor, zone,
-- contract, deposit, deposit_transaction, reservation, notification v.v.
-- đều sử dụng pattern:
--   is_org_admin() OR building_id IN (get_user_assigned_buildings()) OR ...
-- Vì is_org_admin() nay chỉ match SYS_ADMIN, OWNER sẽ rơi vào nhánh
-- get_user_assigned_buildings() → chỉ trả buildings mình sở hữu → ĐÚNG.

-- ============================================================================
-- 10. Tạo index hỗ trợ truy vấn owner → buildings cho performance
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_owner_org_person ON owner(org_id, person_id);

