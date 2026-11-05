-- 054_rls_and_tenant_navigation_perf.sql
-- Tối ưu toàn diện hiệu năng chuyển trang Hồ sơ cư dân (M04), Hợp đồng (M05) và Căn hộ/Tòa nhà (M03):
--   1. Bổ sung các B-tree index còn thiếu trên khóa ngoại & cột tra cứu RLS (app_user.person_id,
--      contract_occupant.contract_id/tenant_id, contract.parent_contract_id, reservation.phone, ...).
--   2. Thay thế quét PL/pgSQL theo từng dòng (per-row SPI queries) trên rls_person_select,
--      rls_tenant_select, rls_contract_select, rls_contract_occupant_select bằng các hàm tập hợp
--      không tham số dòng (evaluated 1 lần/truy vấn qua InitPlan / Hashed SubPlan), bảo toàn 100%
--      ngữ nghĩa RBAC, default-deny khi chưa gán app.current_user_id và INSERT ... RETURNING *.

BEGIN;

-- ============================================================================
-- 1. BỔ SUNG CÁC INDEX CÒN THIẾU CHO JOIN & RLS LOOKUP
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_app_user_person_id
  ON app_user(person_id);

CREATE INDEX IF NOT EXISTS idx_contract_occupant_contract_id
  ON contract_occupant(contract_id);

CREATE INDEX IF NOT EXISTS idx_contract_occupant_tenant_id
  ON contract_occupant(tenant_id);

CREATE INDEX IF NOT EXISTS idx_contract_parent_contract_id
  ON contract(parent_contract_id)
  WHERE parent_contract_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reservation_phone_building
  ON reservation(phone, building_id)
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_desired_building_id
  ON tenant(desired_building_id)
  WHERE desired_building_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_person_created_by
  ON person(created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_created_by
  ON tenant(created_by)
  WHERE created_by IS NOT NULL;

-- ============================================================================
-- 2. CÁC HÀM TẬP HỢP HỖ TRỢ RLS KHÔNG THAM SỐ DÒNG (EVALUATE 1 LẦN / QUERY)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_assigned_building_reservation_phones()
RETURNS TABLE (phone TEXT) AS $$
DECLARE
  v_user_id UUID;
  v_buildings UUID[];
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  v_buildings := ARRAY(SELECT ub.building_id FROM get_user_assigned_buildings() ub);
  IF cardinality(v_buildings) IS NULL OR cardinality(v_buildings) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT r.phone::TEXT
  FROM reservation r
  WHERE r.phone IS NOT NULL
    AND r.building_id = ANY(v_buildings);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE OR REPLACE FUNCTION get_other_building_contract_person_ids()
RETURNS TABLE (person_id UUID) AS $$
DECLARE
  v_user_id UUID;
  v_mgr_buildings UUID[];
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  v_mgr_buildings := ARRAY(SELECT mb.building_id FROM get_manager_building_ids() mb);

  RETURN QUERY
  SELECT t_other.person_id
  FROM contract c_other
  JOIN tenant t_other ON t_other.id = c_other.primary_tenant_id
  WHERE NOT (c_other.building_id = ANY(v_mgr_buildings))
  UNION
  SELECT t_occ.person_id
  FROM contract c_occ
  JOIN contract_occupant co_other ON co_other.contract_id = c_occ.id
  JOIN tenant t_occ ON t_occ.id = co_other.tenant_id
  WHERE NOT (c_occ.building_id = ANY(v_mgr_buildings));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE OR REPLACE FUNCTION get_other_building_contract_tenant_ids()
RETURNS TABLE (tenant_id UUID) AS $$
DECLARE
  v_user_id UUID;
  v_mgr_buildings UUID[];
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  v_mgr_buildings := ARRAY(SELECT mb.building_id FROM get_manager_building_ids() mb);

  RETURN QUERY
  SELECT c_other.primary_tenant_id
  FROM contract c_other
  WHERE NOT (c_other.building_id = ANY(v_mgr_buildings))
  UNION
  SELECT co_other.tenant_id
  FROM contract_occupant co_other
  JOIN contract c_occ ON c_occ.id = co_other.contract_id
  WHERE NOT (c_occ.building_id = ANY(v_mgr_buildings));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE OR REPLACE FUNCTION get_manager_created_person_ids()
RETURNS TABLE (person_id UUID) AS $$
DECLARE
  v_user_id UUID;
  v_user_org_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL OR NOT is_manager() THEN
    RETURN;
  END IF;

  v_user_org_id := get_current_user_org_id();
  IF v_user_org_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id
  FROM person p
  WHERE p.org_id = v_user_org_id
    AND p.created_by = v_user_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE OR REPLACE FUNCTION get_accessible_person_ids()
RETURNS TABLE (person_id UUID) AS $$
DECLARE
  v_user_id UUID;
  v_person_id UUID;
  v_user_org_id UUID;
  v_is_owner BOOLEAN;
  v_is_manager BOOLEAN;
  v_assigned_buildings UUID[];
  v_owner_buildings UUID[];
  v_mgr_buildings UUID[];
  v_other_contract_persons UUID[];
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  v_person_id := get_current_user_person_id();
  IF v_person_id IS NOT NULL THEN
    RETURN QUERY SELECT v_person_id;
  END IF;

  v_user_org_id := get_current_user_org_id();
  v_is_owner := is_owner();
  v_is_manager := is_manager();
  v_assigned_buildings := ARRAY(SELECT ub.building_id FROM get_user_assigned_buildings() ub);

  -- 1. Cư dân có HĐ đứng tên, ở cùng, giữ chỗ hoặc đơn tự khai vào các tòa được gán (OWNER / MANAGER)
  IF cardinality(v_assigned_buildings) > 0 THEN
    RETURN QUERY
    SELECT t.person_id
    FROM contract c
    JOIN tenant t ON t.id = c.primary_tenant_id
    WHERE c.building_id = ANY(v_assigned_buildings)
    UNION
    SELECT t.person_id
    FROM contract c
    JOIN contract_occupant co ON co.contract_id = c.id
    JOIN tenant t ON t.id = co.tenant_id
    WHERE c.building_id = ANY(v_assigned_buildings)
    UNION
    SELECT p.id
    FROM reservation r
    JOIN person p ON p.phone = r.phone
    WHERE r.phone IS NOT NULL
      AND r.building_id = ANY(v_assigned_buildings)
    UNION
    SELECT td.person_id
    FROM tenant td
    WHERE td.desired_building_id = ANY(v_assigned_buildings);
  END IF;

  -- 2. OWNER xem thông tin SYS_ADMIN & MANAGER phụ trách tòa mình sở hữu (cùng org)
  IF v_is_owner AND v_user_org_id IS NOT NULL THEN
    v_owner_buildings := ARRAY(SELECT ob.building_id FROM get_owner_building_ids() ob);
    RETURN QUERY
    SELECT au.person_id
    FROM app_user au
    JOIN person p ON p.id = au.person_id
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role rl ON rl.id = ur.role_id
    WHERE p.org_id = v_user_org_id
      AND (
        rl.code = 'SYS_ADMIN'
        OR (rl.code = 'MANAGER' AND ur.building_id = ANY(v_owner_buildings))
      );
  END IF;

  -- 3. MANAGER xem thông tin OWNER của tòa mình quản lý, SYS_ADMIN cùng org, và hồ sơ chưa lên HĐ do chính mình tạo
  IF v_is_manager AND v_user_org_id IS NOT NULL THEN
    v_mgr_buildings := ARRAY(SELECT mb.building_id FROM get_manager_building_ids() mb);
    v_other_contract_persons := ARRAY(
      SELECT op.person_id FROM get_other_building_contract_person_ids() op
    );

    RETURN QUERY
    SELECT o.person_id
    FROM owner o
    JOIN building b ON b.owner_id = o.id
    JOIN person p ON p.id = o.person_id
    WHERE p.org_id = v_user_org_id
      AND b.id = ANY(v_mgr_buildings)
    UNION
    SELECT au.person_id
    FROM app_user au
    JOIN person p ON p.id = au.person_id
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role rl ON rl.id = ur.role_id
    WHERE p.org_id = v_user_org_id
      AND rl.code = 'SYS_ADMIN'
    UNION
    SELECT p_self.id
    FROM person p_self
    WHERE p_self.org_id = v_user_org_id
      AND p_self.created_by = v_user_id
      AND NOT (p_self.id = ANY(v_other_contract_persons));
  END IF;

  -- 4. Cư dân xem thông tin liên hệ BQL tòa mình đang ở / giữ chỗ (join qua PK app_user.id 1 lần)
  RETURN QUERY
  SELECT u.person_id
  FROM get_resident_manager_user_ids(v_user_id) gm
  JOIN app_user u ON u.id = gm.manager_user_id
  WHERE u.person_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE OR REPLACE FUNCTION get_accessible_tenant_ids()
RETURNS TABLE (tenant_id UUID) AS $$
DECLARE
  v_user_id UUID;
  v_person_id UUID;
  v_user_org_id UUID;
  v_is_manager BOOLEAN;
  v_assigned_buildings UUID[];
  v_other_contract_tenants UUID[];
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  v_person_id := get_current_user_person_id();
  IF v_person_id IS NOT NULL THEN
    RETURN QUERY
    SELECT t.id FROM tenant t WHERE t.person_id = v_person_id;
  END IF;

  RETURN QUERY
  SELECT rt.tenant_id FROM get_resident_tenant_ids() rt;

  v_assigned_buildings := ARRAY(SELECT ub.building_id FROM get_user_assigned_buildings() ub);
  IF cardinality(v_assigned_buildings) > 0 THEN
    RETURN QUERY
    SELECT c.primary_tenant_id
    FROM contract c
    WHERE c.building_id = ANY(v_assigned_buildings)
    UNION
    SELECT co.tenant_id
    FROM contract_occupant co
    JOIN contract c ON c.id = co.contract_id
    WHERE c.building_id = ANY(v_assigned_buildings)
    UNION
    SELECT t.id
    FROM reservation r
    JOIN person p ON p.phone = r.phone
    JOIN tenant t ON t.person_id = p.id
    WHERE r.phone IS NOT NULL
      AND r.building_id = ANY(v_assigned_buildings)
    UNION
    SELECT td.id
    FROM tenant td
    WHERE td.desired_building_id = ANY(v_assigned_buildings);
  END IF;

  v_is_manager := is_manager();
  v_user_org_id := get_current_user_org_id();
  IF v_is_manager AND v_user_org_id IS NOT NULL THEN
    v_other_contract_tenants := ARRAY(
      SELECT ot.tenant_id FROM get_other_building_contract_tenant_ids() ot
    );
    RETURN QUERY
    SELECT ts.id
    FROM tenant ts
    JOIN person ps ON ps.id = ts.person_id
    WHERE ts.org_id = v_user_org_id
      AND (ts.created_by = v_user_id OR ps.created_by = v_user_id)
      AND NOT (ts.id = ANY(v_other_contract_tenants));
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- ============================================================================
-- 3. TỐI ƯU HÀM can_select_person & can_select_tenant CHO CÁC RPC GỌI TRỰC TIẾP
-- ============================================================================
CREATE OR REPLACE FUNCTION can_select_person(
  p_id UUID,
  p_org_id UUID,
  p_phone TEXT,
  p_created_by UUID DEFAULT NULL
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

  IF p_id = get_current_user_person_id() THEN
    RETURN TRUE;
  END IF;

  IF p_id IN (SELECT gp.person_id FROM get_accessible_person_ids() gp) THEN
    RETURN TRUE;
  END IF;

  IF p_phone IS NOT NULL AND p_phone IN (SELECT rp.phone FROM get_assigned_building_reservation_phones() rp) THEN
    RETURN TRUE;
  END IF;

  IF is_manager()
     AND p_org_id = get_current_user_org_id()
     AND p_created_by = v_user_id
     AND NOT (p_id IN (SELECT op.person_id FROM get_other_building_contract_person_ids() op)) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE OR REPLACE FUNCTION can_select_tenant(
  t_id UUID,
  t_person_id UUID,
  t_org_id UUID,
  t_created_by UUID DEFAULT NULL,
  t_desired_building_id UUID DEFAULT NULL
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

  IF t_person_id = get_current_user_person_id() THEN
    RETURN TRUE;
  END IF;

  IF t_id IN (SELECT gt.tenant_id FROM get_accessible_tenant_ids() gt) THEN
    RETURN TRUE;
  END IF;

  IF t_desired_building_id IS NOT NULL
     AND t_desired_building_id IN (SELECT ub.building_id FROM get_user_assigned_buildings() ub) THEN
    RETURN TRUE;
  END IF;

  IF is_manager()
     AND t_org_id = get_current_user_org_id()
     AND (
       t_created_by = v_user_id
       OR t_person_id IN (SELECT mp.person_id FROM get_manager_created_person_ids() mp)
     )
     AND NOT (t_id IN (SELECT ot.tenant_id FROM get_other_building_contract_tenant_ids() ot)) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- ============================================================================
-- 4. CẬP NHẬT POLICIES SANG INITPLAN + HASHED SUBPLAN (KHÔNG QUÉT PER-ROW)
-- ============================================================================
DROP POLICY IF EXISTS rls_person_select ON person;
CREATE POLICY rls_person_select ON person FOR SELECT
USING (
  (SELECT get_current_user_id()) IS NOT NULL
  AND (
    (SELECT is_org_admin())
    OR person.id = (SELECT get_current_user_person_id())
    OR person.id IN (SELECT gp.person_id FROM get_accessible_person_ids() gp)
    OR (
      person.phone IS NOT NULL
      AND person.phone IN (SELECT rp.phone FROM get_assigned_building_reservation_phones() rp)
    )
    OR (
      (SELECT is_manager())
      AND person.org_id = (SELECT get_current_user_org_id())
      AND person.created_by = (SELECT get_current_user_id())
      AND NOT (person.id IN (SELECT op.person_id FROM get_other_building_contract_person_ids() op))
    )
  )
);

DROP POLICY IF EXISTS rls_tenant_select ON tenant;
CREATE POLICY rls_tenant_select ON tenant FOR SELECT
USING (
  (SELECT get_current_user_id()) IS NOT NULL
  AND (
    (SELECT is_org_admin())
    OR tenant.person_id = (SELECT get_current_user_person_id())
    OR tenant.id IN (SELECT gt.tenant_id FROM get_accessible_tenant_ids() gt)
    OR (
      tenant.desired_building_id IS NOT NULL
      AND tenant.desired_building_id IN (SELECT ub.building_id FROM get_user_assigned_buildings() ub)
    )
    OR (
      (SELECT is_manager())
      AND tenant.org_id = (SELECT get_current_user_org_id())
      AND (
        tenant.created_by = (SELECT get_current_user_id())
        OR tenant.person_id IN (SELECT mp.person_id FROM get_manager_created_person_ids() mp)
      )
      AND NOT (tenant.id IN (SELECT ot.tenant_id FROM get_other_building_contract_tenant_ids() ot))
    )
  )
);

DROP POLICY IF EXISTS rls_contract_select ON contract;
CREATE POLICY rls_contract_select ON contract FOR SELECT
USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  OR id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_contract_occupant_select ON contract_occupant;
CREATE POLICY rls_contract_occupant_select ON contract_occupant FOR SELECT
USING (
  (SELECT is_org_admin())
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

COMMIT;
