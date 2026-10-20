-- 013_rls_fixes.sql
-- Sửa toàn diện các lỗ hổng RLS: D1, D10, D13, R1..R5
-- Tuân thủ PRD v2.0 (Mục 6.2 Ma trận RBAC, NFR-008 Zero Data Leak)

-- ============================================================================
-- 1. HELPER FUNCTIONS (SECURITY DEFINER + SET row_security = off chống đệ quy)
-- ============================================================================

-- 1.1 Hàm kiểm tra quản trị toàn tổ chức (OWNER hoặc SYS_ADMIN)
-- R1: NULL context -> FALSE (Default-deny, đóng bypass)
-- R2: Bổ sung quyền SYS_ADMIN
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
    WHERE ur.user_id = v_user_id 
      AND r.code IN ('OWNER', 'SYS_ADMIN')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- 1.2 Hàm kiểm tra người dùng có vai trò MANAGER không
CREATE OR REPLACE FUNCTION is_manager()
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
    WHERE ur.user_id = v_user_id 
      AND r.code = 'MANAGER'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- 1.3 Hàm lấy org_id của người dùng hiện tại
CREATE OR REPLACE FUNCTION get_current_user_org_id()
RETURNS UUID AS $$
DECLARE
  v_user_id UUID;
  v_org_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.org_id INTO v_org_id
  FROM app_user u
  JOIN person p ON p.id = u.person_id
  WHERE u.id = v_user_id;

  RETURN v_org_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- 1.4 Hàm lấy person_id của người dùng hiện tại
CREATE OR REPLACE FUNCTION get_current_user_person_id()
RETURNS UUID AS $$
DECLARE
  v_user_id UUID;
  v_person_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT u.person_id INTO v_person_id
  FROM app_user u
  WHERE u.id = v_user_id;

  RETURN v_person_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- 1.5 Hàm lấy phone của người dùng hiện tại
CREATE OR REPLACE FUNCTION get_current_user_phone()
RETURNS VARCHAR AS $$
DECLARE
  v_user_id UUID;
  v_phone VARCHAR;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.phone INTO v_phone
  FROM app_user u
  JOIN person p ON p.id = u.person_id
  WHERE u.id = v_user_id;

  RETURN v_phone;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- 1.6 Hàm lấy danh sách tòa nhà người dùng được phân quyền quản lý
-- NULL context -> trả rỗng (Default-deny)
CREATE OR REPLACE FUNCTION get_user_assigned_buildings()
RETURNS TABLE (building_id UUID) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Nếu có quyền cấp tổ chức (OWNER hoặc SYS_ADMIN) -> Toàn bộ tòa thuộc org
  IF EXISTS (
    SELECT 1 FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.user_id = v_user_id AND r.code IN ('OWNER', 'SYS_ADMIN')
  ) THEN
    RETURN QUERY 
    SELECT b.id 
    FROM building b
    WHERE b.org_id = get_current_user_org_id();
    RETURN;
  END IF;

  -- Trả về các tòa nhà được gán cụ thể cho MANAGER/STAFF
  RETURN QUERY
  SELECT ur.building_id
  FROM user_role ur
  WHERE ur.user_id = v_user_id AND ur.building_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- 1.7 Hàm lấy danh sách tenant ID của cư dân hiện tại
-- NULL context -> trả rỗng (Default-deny)
CREATE OR REPLACE FUNCTION get_resident_tenant_ids()
RETURNS TABLE (tenant_id UUID) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT t.id
  FROM tenant t
  WHERE t.person_id = get_current_user_person_id();
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- 1.8 Hàm lấy danh sách user_id của Ban quản lý tòa nhà cư dân đang ở
CREATE OR REPLACE FUNCTION get_resident_manager_user_ids(v_resident_user_id UUID)
RETURNS TABLE (manager_user_id UUID) AS $$
BEGIN
  IF v_resident_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT ur.user_id
  FROM user_role ur
  JOIN role r ON r.id = ur.role_id
  WHERE r.code IN ('MANAGER', 'STAFF')
    AND ur.building_id IN (
      SELECT c.building_id FROM contract c
      JOIN tenant t ON t.id = c.primary_tenant_id
      WHERE t.person_id = (SELECT u.person_id FROM app_user u WHERE u.id = v_resident_user_id)
        AND c.status = 'ACTIVE'
      UNION
      SELECT rsv.building_id FROM reservation rsv
      JOIN person p ON p.phone = rsv.phone
      WHERE p.id = (SELECT u.person_id FROM app_user u WHERE u.id = v_resident_user_id)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- ============================================================================
-- 2. BẬT VÀ ÉP BUỘC RLS TRÊN CÁC BẢNG BỊ THIẾU (D13 / R3 / NFR-008)
-- ============================================================================
ALTER TABLE floor ENABLE ROW LEVEL SECURITY;
ALTER TABLE floor FORCE ROW LEVEL SECURITY;

ALTER TABLE reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation FORCE ROW LEVEL SECURITY;

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;

ALTER TABLE user_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role FORCE ROW LEVEL SECURITY;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- 3. POLICIES CHO CÁC BẢNG MỚI ĐƯỢC BẢO VỆ
-- ============================================================================

-- 🏢 BẢNG FLOOR:
DROP POLICY IF EXISTS rls_floor_select ON floor;
DROP POLICY IF EXISTS rls_floor_modify ON floor;
DROP POLICY IF EXISTS rls_floor_insert ON floor;
DROP POLICY IF EXISTS rls_floor_update ON floor;
DROP POLICY IF EXISTS rls_floor_delete ON floor;

CREATE POLICY rls_floor_select ON floor FOR SELECT
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (
    SELECT c.building_id FROM contract c 
    WHERE c.primary_tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
      AND c.status = 'ACTIVE'
  )
);

CREATE POLICY rls_floor_insert ON floor FOR INSERT
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

CREATE POLICY rls_floor_update ON floor FOR UPDATE
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

CREATE POLICY rls_floor_delete ON floor FOR DELETE
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

-- 🔖 BẢNG RESERVATION:
DROP POLICY IF EXISTS rls_reservation_select ON reservation;
DROP POLICY IF EXISTS rls_reservation_modify ON reservation;
DROP POLICY IF EXISTS rls_reservation_insert ON reservation;
DROP POLICY IF EXISTS rls_reservation_update ON reservation;
DROP POLICY IF EXISTS rls_reservation_delete ON reservation;

CREATE POLICY rls_reservation_select ON reservation FOR SELECT
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR phone = get_current_user_phone()
);

CREATE POLICY rls_reservation_insert ON reservation FOR INSERT
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR phone = get_current_user_phone()
);

CREATE POLICY rls_reservation_update ON reservation FOR UPDATE
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

CREATE POLICY rls_reservation_delete ON reservation FOR DELETE
USING (
  is_org_admin()
);

-- 🔔 BẢNG NOTIFICATION:
DROP POLICY IF EXISTS rls_notification_select ON notification;
DROP POLICY IF EXISTS rls_notification_modify ON notification;
DROP POLICY IF EXISTS rls_notification_insert ON notification;
DROP POLICY IF EXISTS rls_notification_update ON notification;
DROP POLICY IF EXISTS rls_notification_delete ON notification;

CREATE POLICY rls_notification_select ON notification FOR SELECT
USING (
  is_org_admin()
  OR user_id = get_current_user_id()
  OR user_id IS NULL
);

CREATE POLICY rls_notification_insert ON notification FOR INSERT
WITH CHECK (
  is_org_admin()
  OR user_id = get_current_user_id()
  OR user_id IS NULL
);

CREATE POLICY rls_notification_update ON notification FOR UPDATE
USING (
  is_org_admin()
  OR user_id = get_current_user_id()
)
WITH CHECK (
  is_org_admin()
  OR user_id = get_current_user_id()
);

CREATE POLICY rls_notification_delete ON notification FOR DELETE
USING (
  is_org_admin()
  OR user_id = get_current_user_id()
);

-- 👤 BẢNG APP_USER:
DROP POLICY IF EXISTS rls_app_user_select ON app_user;
DROP POLICY IF EXISTS rls_app_user_modify ON app_user;
DROP POLICY IF EXISTS rls_app_user_insert ON app_user;
DROP POLICY IF EXISTS rls_app_user_update ON app_user;
DROP POLICY IF EXISTS rls_app_user_delete ON app_user;

CREATE POLICY rls_app_user_select ON app_user FOR SELECT
USING (
  id = get_current_user_id()
  OR is_org_admin()
  OR id IN (SELECT manager_user_id FROM get_resident_manager_user_ids(get_current_user_id()))
);

CREATE POLICY rls_app_user_insert ON app_user FOR INSERT
WITH CHECK (
  is_org_admin()
);

CREATE POLICY rls_app_user_update ON app_user FOR UPDATE
USING (
  id = get_current_user_id()
  OR is_org_admin()
)
WITH CHECK (
  id = get_current_user_id()
  OR is_org_admin()
);

CREATE POLICY rls_app_user_delete ON app_user FOR DELETE
USING (
  is_org_admin()
);

-- 🔑 BẢNG USER_ROLE:
DROP POLICY IF EXISTS rls_user_role_select ON user_role;
DROP POLICY IF EXISTS rls_user_role_modify ON user_role;
DROP POLICY IF EXISTS rls_user_role_insert ON user_role;
DROP POLICY IF EXISTS rls_user_role_update ON user_role;
DROP POLICY IF EXISTS rls_user_role_delete ON user_role;

CREATE POLICY rls_user_role_select ON user_role FOR SELECT
USING (
  user_id = get_current_user_id()
  OR is_org_admin()
  OR user_id IN (SELECT manager_user_id FROM get_resident_manager_user_ids(get_current_user_id()))
);

CREATE POLICY rls_user_role_insert ON user_role FOR INSERT
WITH CHECK (
  is_org_admin()
);

CREATE POLICY rls_user_role_update ON user_role FOR UPDATE
USING (
  is_org_admin()
)
WITH CHECK (
  is_org_admin()
);

CREATE POLICY rls_user_role_delete ON user_role FOR DELETE
USING (
  is_org_admin()
);

-- 📜 BẢNG AUDIT_LOG:
DROP POLICY IF EXISTS rls_audit_log_select ON audit_log;
DROP POLICY IF EXISTS rls_audit_log_modify ON audit_log;
DROP POLICY IF EXISTS rls_audit_log_insert ON audit_log;

CREATE POLICY rls_audit_log_select ON audit_log FOR SELECT
USING (
  is_org_admin()
  OR actor_id = get_current_user_id()
);

CREATE POLICY rls_audit_log_insert ON audit_log FOR INSERT
WITH CHECK (
  actor_id = get_current_user_id() 
  OR actor_id IS NULL
);

-- ============================================================================
-- 4. CẬP NHẬT CÁC POLICY CỦA BẢNG ĐÃ CÓ (PERSON, TENANT, BUILDING)
-- ============================================================================

-- 👤 BẢNG PERSON (Tách riêng biệt SELECT, INSERT, UPDATE, DELETE):
DROP POLICY IF EXISTS rls_person_select ON person;
DROP POLICY IF EXISTS rls_person_modify ON person;
DROP POLICY IF EXISTS rls_person_insert ON person;
DROP POLICY IF EXISTS rls_person_update ON person;
DROP POLICY IF EXISTS rls_person_delete ON person;

CREATE POLICY rls_person_select ON person FOR SELECT
USING (
  is_org_admin()
  OR id = get_current_user_person_id()
  OR EXISTS (
    SELECT 1 FROM contract c
    JOIN tenant t ON t.id = c.primary_tenant_id
    WHERE t.person_id = person.id 
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR EXISTS (
    SELECT 1 FROM contract c
    JOIN contract_occupant co ON co.contract_id = c.id
    JOIN tenant t ON t.id = co.tenant_id
    WHERE t.person_id = person.id 
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR EXISTS (
    SELECT 1 FROM reservation r
    WHERE r.phone = person.phone
      AND r.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR id IN (
    SELECT u.person_id FROM app_user u
    WHERE u.id IN (SELECT manager_user_id FROM get_resident_manager_user_ids(get_current_user_id()))
  )
  OR (
    -- Cho phép Manager SELECT uncontracted person cùng org để check trùng
    is_manager()
    AND person.org_id = get_current_user_org_id()
    AND NOT EXISTS (
      SELECT 1 FROM contract c_other
      JOIN tenant t_other ON t_other.id = c_other.primary_tenant_id
      WHERE t_other.person_id = person.id
        AND c_other.building_id NOT IN (SELECT building_id FROM get_user_assigned_buildings())
    )
  )
);

CREATE POLICY rls_person_insert ON person FOR INSERT
WITH CHECK (
  is_org_admin()
  OR (
    is_manager()
    AND person.org_id = get_current_user_org_id()
  )
);

CREATE POLICY rls_person_update ON person FOR UPDATE
USING (
  is_org_admin()
  OR id = get_current_user_person_id()
  OR (
    is_manager()
    AND person.org_id = get_current_user_org_id()
  )
)
WITH CHECK (
  is_org_admin()
  OR id = get_current_user_person_id()
  OR (
    is_manager()
    AND person.org_id = get_current_user_org_id()
  )
);

CREATE POLICY rls_person_delete ON person FOR DELETE
USING (
  is_org_admin()
);

-- 👥 BẢNG TENANT (Tách riêng biệt SELECT, INSERT, UPDATE, DELETE):
DROP POLICY IF EXISTS rls_tenant_select ON tenant;
DROP POLICY IF EXISTS rls_tenant_modify ON tenant;
DROP POLICY IF EXISTS rls_tenant_insert ON tenant;
DROP POLICY IF EXISTS rls_tenant_update ON tenant;
DROP POLICY IF EXISTS rls_tenant_delete ON tenant;

CREATE POLICY rls_tenant_select ON tenant FOR SELECT
USING (
  is_org_admin()
  OR EXISTS (
    SELECT 1 FROM contract c 
    WHERE c.primary_tenant_id = tenant.id 
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR EXISTS (
    SELECT 1 FROM contract_occupant co
    JOIN contract c ON c.id = co.contract_id
    WHERE co.tenant_id = tenant.id
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR id IN (SELECT tenant_id FROM get_resident_tenant_ids())
  OR (
    -- Cho phép Manager xem uncontracted tenant cùng org để lập hợp đồng
    is_manager()
    AND tenant.org_id = get_current_user_org_id()
    AND NOT EXISTS (
      SELECT 1 FROM contract c_other
      WHERE c_other.primary_tenant_id = tenant.id
        AND c_other.building_id NOT IN (SELECT building_id FROM get_user_assigned_buildings())
    )
  )
);

CREATE POLICY rls_tenant_insert ON tenant FOR INSERT
WITH CHECK (
  is_org_admin()
  OR (
    is_manager()
    AND tenant.org_id = get_current_user_org_id()
  )
);

CREATE POLICY rls_tenant_update ON tenant FOR UPDATE
USING (
  is_org_admin()
  OR (
    is_manager()
    AND tenant.org_id = get_current_user_org_id()
  )
  OR id IN (SELECT tenant_id FROM get_resident_tenant_ids())
)
WITH CHECK (
  is_org_admin()
  OR (
    is_manager()
    AND tenant.org_id = get_current_user_org_id()
  )
  OR id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

CREATE POLICY rls_tenant_delete ON tenant FOR DELETE
USING (
  is_org_admin()
);

-- 🏢 BẢNG BUILDING (Cập nhật riêng biệt SELECT, INSERT, UPDATE, DELETE):
DROP POLICY IF EXISTS rls_building_modify ON building;
DROP POLICY IF EXISTS rls_building_insert ON building;
DROP POLICY IF EXISTS rls_building_update ON building;
DROP POLICY IF EXISTS rls_building_delete ON building;

CREATE POLICY rls_building_insert ON building FOR INSERT
WITH CHECK (
  is_org_admin()
  OR (
    is_manager()
    AND building.org_id = get_current_user_org_id()
  )
);

CREATE POLICY rls_building_update ON building FOR UPDATE
USING (
  is_org_admin()
  OR id IN (SELECT building_id FROM get_user_assigned_buildings())
)
WITH CHECK (
  is_org_admin()
  OR id IN (SELECT building_id FROM get_user_assigned_buildings())
);

CREATE POLICY rls_building_delete ON building FOR DELETE
USING (
  is_org_admin()
);
