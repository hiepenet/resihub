-- 030_owner_and_tenant_privacy.sql
-- Bảo mật danh tính Chủ đầu tư (OWNER) & Dữ liệu định danh Cư dân (PII) theo PRD v2.0:
--   1. Siết chặt RLS bảng owner: chỉ SYS_ADMIN hoặc chính OWNER đó mới có quyền SELECT trực tiếp.
--      Mọi tài khoản MANAGER / STAFF / ACCOUNTANT / RESIDENT không thể đọc bảng owner ở tầng CSDL
--      (MANAGER chỉ tra cứu khớp chính xác Email/SĐT qua endpoint backend có rate-limit & PII masking).
--   2. Bổ sung cột created_by vào bảng person và tenant để cô lập hồ sơ cư dân chưa lên hợp đồng:
--      MANAGER Tòa A tạo hồ sơ cư dân mới sẽ không bao giờ bị lộ sang danh sách của MANAGER Tòa B.
--   3. Vá hàm can_select_person & can_select_tenant: chặn rò rỉ người ở cùng (contract_occupant)
--      và người giữ chỗ (reservation) thuộc tòa nhà khác ngoài phạm vi quản lý.

-- ============================================================================
-- 1. SIẾT CHẶT RLS BẢNG OWNER (NFR-008 & FR-070)
-- ============================================================================
ALTER TABLE owner ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_owner_select ON owner;
DROP POLICY IF EXISTS rls_owner_modify ON owner;

CREATE POLICY rls_owner_select ON owner FOR SELECT
  USING (
    is_org_admin()
    OR person_id = get_current_user_person_id()
  );

CREATE POLICY rls_owner_modify ON owner FOR ALL
  USING (is_org_admin())
  WITH CHECK (is_org_admin());

-- ============================================================================
-- 2. BỔ SUNG CỘT CREATED_BY CHO BẢNG PERSON VÀ TENANT
-- ============================================================================
ALTER TABLE person ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT get_current_user_id() REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE person ALTER COLUMN created_by SET DEFAULT get_current_user_id();

ALTER TABLE tenant ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT get_current_user_id() REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE tenant ALTER COLUMN created_by SET DEFAULT get_current_user_id();

CREATE INDEX IF NOT EXISTS idx_person_created_by ON person(created_by);
CREATE INDEX IF NOT EXISTS idx_tenant_created_by ON tenant(created_by);

-- ============================================================================
-- 3. CẬP NHẬT CAN_SELECT_PERSON & CAN_SELECT_TENANT (CHỐNG LỘ PII XUYÊN TÒA)
--    Truyền trực tiếp p_created_by / t_created_by từ tuple vào hàm RLS để
--    tương thích hoàn toàn với INSERT ... RETURNING * dưới STABLE snapshot.
-- ============================================================================
DROP POLICY IF EXISTS rls_person_select ON person;
DROP POLICY IF EXISTS rls_tenant_select ON tenant;

DROP FUNCTION IF EXISTS can_select_person(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS can_select_person(UUID, UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS can_select_tenant(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS can_select_tenant(UUID, UUID, UUID, UUID);

CREATE OR REPLACE FUNCTION can_select_person(
  p_id UUID,
  p_org_id UUID,
  p_phone TEXT,
  p_created_by UUID DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
  v_user_id UUID;
  v_user_org_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF is_org_admin() THEN
    RETURN TRUE;
  END IF;

  IF p_id = get_current_user_person_id() THEN
    RETURN TRUE;
  END IF;

  v_user_org_id := get_current_user_org_id();

  -- OWNER (tòa sở hữu) & MANAGER (tòa được gán): xem person có HĐ chính, ở cùng hoặc giữ chỗ trong tòa của mình
  IF EXISTS (
    SELECT 1 FROM contract c
    JOIN tenant t ON t.id = c.primary_tenant_id
    WHERE t.person_id = p_id
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  ) THEN
    RETURN TRUE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM contract c
    JOIN contract_occupant co ON co.contract_id = c.id
    JOIN tenant t ON t.id = co.tenant_id
    WHERE t.person_id = p_id
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  ) THEN
    RETURN TRUE;
  END IF;

  IF p_phone IS NOT NULL AND EXISTS (
    SELECT 1 FROM reservation r
    WHERE r.phone = p_phone
      AND r.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  ) THEN
    RETURN TRUE;
  END IF;

  -- Cho phép OWNER xem thông tin MANAGER phụ trách tòa mình (để hiển thị người lập trên hợp đồng/tất toán)
  IF is_owner() AND p_org_id = v_user_org_id AND EXISTS (
    SELECT 1 FROM app_user au
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role rl ON rl.id = ur.role_id
    WHERE au.person_id = p_id
      AND (
        rl.code = 'SYS_ADMIN'
        OR (rl.code = 'MANAGER' AND ur.building_id IN (SELECT building_id FROM get_owner_building_ids()))
      )
  ) THEN
    RETURN TRUE;
  END IF;

  -- Cho phép MANAGER chỉ xem tên người duyệt thuộc đúng tòa mình quản lý (OWNER của tòa đó hoặc SYS_ADMIN),
  -- KHÔNG xem được OWNER hay MANAGER của các tòa khác!
  IF is_manager() AND p_org_id = v_user_org_id AND (
    EXISTS (
      SELECT 1 FROM owner o
      JOIN building b ON b.owner_id = o.id
      WHERE o.person_id = p_id
        AND b.id IN (SELECT building_id FROM get_manager_building_ids())
    )
    OR EXISTS (
      SELECT 1 FROM app_user au
      JOIN user_role ur ON ur.user_id = au.id
      JOIN role rl ON rl.id = ur.role_id
      WHERE au.person_id = p_id AND rl.code = 'SYS_ADMIN'
    )
  ) THEN
    RETURN TRUE;
  END IF;

  -- Cư dân xem thông tin liên hệ BQL tòa mình đang ở / giữ chỗ
  IF EXISTS (
    SELECT 1 FROM app_user u
    WHERE u.person_id = p_id
      AND u.id IN (SELECT manager_user_id FROM get_resident_manager_user_ids(v_user_id))
  ) THEN
    RETURN TRUE;
  END IF;

  -- MANAGER chỉ xem được hồ sơ chưa lên hợp đồng DO CHÍNH MÌNH TẠO (p_created_by = v_user_id)
  -- và chưa từng gắn vào hợp đồng/người ở cùng của tòa khác!
  IF is_manager() AND p_org_id = v_user_org_id AND (
    p_created_by = v_user_id
    OR EXISTS (
      SELECT 1 FROM person p_self
      WHERE p_self.id = p_id AND p_self.created_by = v_user_id
    )
  ) AND NOT EXISTS (
    SELECT 1 FROM contract c_other
    JOIN tenant t_other ON t_other.id = c_other.primary_tenant_id
    WHERE t_other.person_id = p_id
      AND c_other.building_id NOT IN (SELECT building_id FROM get_manager_building_ids())
  ) AND NOT EXISTS (
    SELECT 1 FROM contract c_occ
    JOIN contract_occupant co_other ON co_other.contract_id = c_occ.id
    JOIN tenant t_occ ON t_occ.id = co_other.tenant_id
    WHERE t_occ.person_id = p_id
      AND c_occ.building_id NOT IN (SELECT building_id FROM get_manager_building_ids())
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE OR REPLACE FUNCTION can_select_tenant(
  t_id UUID,
  t_person_id UUID,
  t_org_id UUID,
  t_created_by UUID DEFAULT NULL
)
RETURNS BOOLEAN AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF is_org_admin() THEN
    RETURN TRUE;
  END IF;

  IF t_person_id = get_current_user_person_id() OR t_id IN (SELECT tenant_id FROM get_resident_tenant_ids()) THEN
    RETURN TRUE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM contract c
    WHERE c.primary_tenant_id = t_id
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  ) THEN
    RETURN TRUE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM contract_occupant co
    JOIN contract c ON c.id = co.contract_id
    WHERE co.tenant_id = t_id
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  ) THEN
    RETURN TRUE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM person p
    JOIN reservation r ON r.phone = p.phone
    WHERE p.id = t_person_id
      AND r.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  ) THEN
    RETURN TRUE;
  END IF;

  -- Hồ sơ cư dân chưa lên hợp đồng: chỉ chính MANAGER đã tạo (t_created_by = v_user_id) mới được SELECT
  IF is_manager() AND t_org_id = get_current_user_org_id() AND (
    t_created_by = v_user_id
    OR EXISTS (SELECT 1 FROM tenant ts WHERE ts.id = t_id AND ts.created_by = v_user_id)
    OR EXISTS (SELECT 1 FROM person ps WHERE ps.id = t_person_id AND ps.created_by = v_user_id)
  ) AND NOT EXISTS (
    SELECT 1 FROM contract c_other
    WHERE c_other.primary_tenant_id = t_id
      AND c_other.building_id NOT IN (SELECT building_id FROM get_manager_building_ids())
  ) AND NOT EXISTS (
    SELECT 1 FROM contract_occupant co_other
    JOIN contract c_occ ON c_occ.id = co_other.contract_id
    WHERE co_other.tenant_id = t_id
      AND c_occ.building_id NOT IN (SELECT building_id FROM get_manager_building_ids())
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE POLICY rls_person_select ON person FOR SELECT
  USING (can_select_person(person.id, person.org_id, person.phone, person.created_by));

CREATE POLICY rls_tenant_select ON tenant FOR SELECT
  USING (can_select_tenant(tenant.id, tenant.person_id, tenant.org_id, tenant.created_by));
