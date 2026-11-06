-- ============================================================================
-- 004_helper_functions.sql
-- Consolidated Security Helpers, Scope Predicates, and Business RPCs
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. User Context Helpers
-- ----------------------------------------------------------------------------

-- Function: get_current_user_id
CREATE OR REPLACE FUNCTION get_current_user_id()
RETURNS UUID AS $$
DECLARE
  v_uid TEXT;
BEGIN
  v_uid := current_setting('request.jwt.claim.sub', true);
  IF v_uid IS NOT NULL AND v_uid <> '' THEN
    RETURN v_uid::UUID;
  END IF;

  v_uid := current_setting('app.current_user_id', true);
  IF v_uid IS NOT NULL AND v_uid <> '' THEN
    RETURN v_uid::UUID;
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Function: get_current_user_org_id
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

-- Function: get_current_user_person_id
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

-- Function: get_current_user_phone
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


-- ----------------------------------------------------------------------------
-- 2. Role Predicates (Simplified 4-Role Model)
-- ----------------------------------------------------------------------------

-- Function: is_org_admin
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

-- Function: is_owner
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

-- Function: is_manager
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
    WHERE ur.user_id = v_user_id AND r.code = 'MANAGER'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Function: is_resident
CREATE OR REPLACE FUNCTION is_resident()
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
      AND r.code = 'RESIDENT'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Function: is_org_member
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

-- Function: is_accountant
CREATE OR REPLACE FUNCTION is_accountant()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;


-- ----------------------------------------------------------------------------
-- 3. Building Scope & Assignment Helpers
-- ----------------------------------------------------------------------------

-- Function: get_resident_tenant_ids
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

-- Function: get_resident_contract_ids
CREATE OR REPLACE FUNCTION get_resident_contract_ids()
RETURNS TABLE(contract_id UUID) AS $$
BEGIN
  RETURN QUERY
  SELECT c.id FROM contract c
  WHERE c.primary_tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
     OR EXISTS (
       SELECT 1 FROM contract_occupant co
       WHERE co.contract_id = c.id
         AND co.tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
     );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Function: get_resident_manager_user_ids
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

-- Function: get_owner_building_ids
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

-- Function: get_manager_building_ids
CREATE OR REPLACE FUNCTION get_manager_building_ids()
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
    AND r.code = 'MANAGER'
    AND ur.building_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Function: get_accountant_building_ids
CREATE OR REPLACE FUNCTION get_accountant_building_ids()
RETURNS TABLE (building_id UUID) AS $$
BEGIN
  RETURN;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Function: get_staff_building_ids
CREATE OR REPLACE FUNCTION get_staff_building_ids()
RETURNS TABLE (building_id UUID) AS $$
BEGIN
  RETURN QUERY SELECT gb.building_id FROM get_manager_building_ids() gb;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Function: get_user_assigned_buildings
CREATE OR REPLACE FUNCTION get_user_assigned_buildings()
RETURNS TABLE (building_id UUID) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  IF is_org_admin() THEN
    RETURN QUERY
    SELECT b.id
    FROM building b
    WHERE b.org_id = get_current_user_org_id();
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT sub.building_id
  FROM (
    SELECT gb.building_id FROM get_owner_building_ids() gb
    UNION
    SELECT mb.building_id FROM get_manager_building_ids() mb
  ) sub
  WHERE sub.building_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Function: get_non_staff_assigned_buildings
CREATE OR REPLACE FUNCTION get_non_staff_assigned_buildings()
RETURNS TABLE (building_id UUID) AS $$
BEGIN
  RETURN QUERY SELECT ub.building_id FROM get_user_assigned_buildings() ub;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Function: building_has_active_owner
CREATE OR REPLACE FUNCTION building_has_active_owner(p_building_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  IF p_building_id IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM building b
    JOIN owner o ON o.id = b.owner_id
    JOIN app_user au ON au.person_id = o.person_id
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    WHERE b.id = p_building_id
      AND au.status = 'ACTIVE'
      AND r.code = 'OWNER'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public SET row_security = off;


-- ----------------------------------------------------------------------------
-- 4. Set-Based Performance Helpers & Privacy Predicates
-- ----------------------------------------------------------------------------

-- Function: get_assigned_building_reservation_phones
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

-- Function: get_other_building_contract_person_ids
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

-- Function: get_other_building_contract_tenant_ids
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

-- Function: get_manager_created_person_ids
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

-- Function: get_accessible_person_ids
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

-- Function: get_accessible_tenant_ids
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

-- Function: can_select_person
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

-- Function: can_select_tenant
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

-- Function: can_select_app_user
CREATE OR REPLACE FUNCTION can_select_app_user(u_id UUID, u_person_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_cur_id UUID;
BEGIN
  v_cur_id := get_current_user_id();
  IF v_cur_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF is_org_admin() OR u_id = v_cur_id THEN
    RETURN TRUE;
  END IF;

  IF u_id IN (SELECT manager_user_id FROM get_resident_manager_user_ids(v_cur_id)) THEN
    RETURN TRUE;
  END IF;

  -- Cho phép OWNER / MANAGER tra cứu user_id của cư dân thuộc tòa mình (gửi notification) hoặc người duyệt cùng org
  IF (is_owner() OR is_manager()) AND EXISTS (
    SELECT 1 FROM person p
    WHERE p.id = u_person_id
      AND can_select_person(p.id, p.org_id, p.phone)
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Function: can_select_attachment
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
        AND (
          (
            mr.contract_id IS NOT NULL
            AND mr.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          )
          OR (
            mr.contract_id IS NULL
            AND mr.apartment_id IN (
              SELECT c.apartment_id FROM contract c
              WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
            )
          )
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


-- ----------------------------------------------------------------------------
-- 5. Business & Operations Security Definer RPCs
-- ----------------------------------------------------------------------------

-- Function: fn_get_deposit_access_meta
CREATE OR REPLACE FUNCTION fn_get_deposit_access_meta(p_deposit_id UUID)
RETURNS TABLE (
  deposit_id UUID,
  contract_id UUID,
  apartment_id UUID,
  building_id UUID,
  org_id UUID,
  building_has_active_owner BOOLEAN,
  is_contract_resident BOOLEAN,
  is_primary_resident BOOLEAN,
  latest_photo_handover_at TIMESTAMPTZ
) AS $$
DECLARE
  v_caller_org UUID;
BEGIN
  v_caller_org := get_current_user_org_id();
  IF v_caller_org IS NULL OR p_deposit_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    d.id AS deposit_id,
    c.id AS contract_id,
    c.apartment_id,
    c.building_id,
    b.org_id,
    building_has_active_owner(c.building_id) AS building_has_active_owner,
    (c.id IN (SELECT rc.contract_id FROM get_resident_contract_ids() rc)) AS is_contract_resident,
    (c.primary_tenant_id IN (SELECT rt.tenant_id FROM get_resident_tenant_ids() rt)) AS is_primary_resident,
    (
      SELECT MAX(al.at)
      FROM audit_log al
      WHERE al.entity = 'apartment'
        AND al.action = 'HANDOVER'
        AND al.entity_id = c.apartment_id
        AND (
          (al.at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= COALESCE(c.terminated_at, c.end_date)
          OR al.at::date >= COALESCE(c.terminated_at, c.end_date)
        )
        AND jsonb_typeof(COALESCE(al.after->'evidence', '[]'::jsonb)) = 'array'
        AND jsonb_array_length(COALESCE(al.after->'evidence', '[]'::jsonb)) >= 1
    ) AS latest_photo_handover_at
  FROM deposit d
  JOIN contract c ON c.id = d.contract_id
  JOIN building b ON b.id = c.building_id
  WHERE d.id = p_deposit_id
    AND b.org_id = v_caller_org;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_sync_apartment_status_after_reservation
CREATE OR REPLACE FUNCTION fn_sync_apartment_status_after_reservation(p_apartment_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_caller_org UUID;
  v_apt RECORD;
  v_today_vn DATE := (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  v_target TEXT;
BEGIN
  v_caller_org := get_current_user_org_id();
  IF v_caller_org IS NULL OR p_apartment_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT a.id, a.status, a.building_id, b.org_id
  INTO v_apt
  FROM apartment a
  JOIN building b ON b.id = a.building_id
  WHERE a.id = p_apartment_id
    AND b.org_id = v_caller_org
  FOR UPDATE OF a;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT (
    (is_manager() AND v_apt.building_id IN (SELECT building_id FROM get_manager_building_ids()))
    OR (is_owner() AND v_apt.building_id IN (SELECT building_id FROM get_owner_building_ids()))
    OR (is_org_admin() AND NOT building_has_active_owner(v_apt.building_id))
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN_APARTMENT_SYNC' USING ERRCODE = '42501';
  END IF;

  IF v_apt.status IN ('INACTIVE', 'BLOCKED') THEN
    RETURN v_apt.status;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM contract c
    WHERE c.apartment_id = p_apartment_id
      AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
      AND c.start_date <= v_today_vn
      AND COALESCE(c.terminated_at, c.end_date) > v_today_vn
  ) THEN
    v_target := 'OCCUPIED';
  ELSIF v_apt.status = 'MAINTENANCE' THEN
    v_target := 'MAINTENANCE';
  ELSIF EXISTS (
    SELECT 1
    FROM contract c
    WHERE c.apartment_id = p_apartment_id
      AND c.status IN ('ACTIVE', 'RENEWAL_PENDING')
      AND c.start_date > v_today_vn
    UNION ALL
    SELECT 1
    FROM reservation r
    WHERE r.apartment_id = p_apartment_id
      AND r.status IN ('HELD', 'CANCEL_PENDING_APPROVAL')
      AND (r.hold_until IS NULL OR r.hold_until >= v_today_vn)
  ) THEN
    v_target := 'RESERVED';
  ELSE
    v_target := 'AVAILABLE';
  END IF;

  IF v_target <> v_apt.status THEN
    UPDATE apartment
    SET status = v_target,
        updated_at = NOW()
    WHERE id = p_apartment_id;
  END IF;

  RETURN v_target;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_submit_deposit_dispute
CREATE OR REPLACE FUNCTION fn_submit_deposit_dispute(
  p_deposit_id UUID,
  p_reason TEXT
)
RETURNS deposit AS $$
DECLARE
  v_user_id UUID;
  v_caller_org UUID;
  v_dep deposit%ROWTYPE;
  v_contract_id UUID;
  v_building_id UUID;
  v_apartment_code TEXT;
  v_org_id UUID;
  v_actor_role TEXT;
  v_trimmed_reason TEXT := BTRIM(COALESCE(p_reason, ''));
  v_settlement JSONB;
  v_thread JSONB;
  v_anchor_ts TIMESTAMPTZ;
  v_now_iso TEXT;
BEGIN
  v_user_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();
  IF v_user_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  IF v_trimmed_reason = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT d.*
  INTO v_dep
  FROM deposit d
  JOIN contract c ON c.id = d.contract_id
  JOIN building b ON b.id = c.building_id
  WHERE d.id = p_deposit_id
    AND b.org_id = v_caller_org
  FOR UPDATE OF d;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT c.id, c.building_id, a.code, b.org_id
  INTO v_contract_id, v_building_id, v_apartment_code, v_org_id
  FROM contract c
  JOIN apartment a ON a.id = c.apartment_id
  JOIN building b ON b.id = c.building_id
  WHERE c.id = v_dep.contract_id;

  IF v_contract_id IN (SELECT rc.contract_id FROM get_resident_contract_ids() rc) THEN
    v_actor_role := 'RESIDENT';
  ELSIF is_manager() AND v_building_id IN (SELECT mb.building_id FROM get_manager_building_ids() mb) THEN
    v_actor_role := 'MANAGER';
  ELSE
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  v_settlement := COALESCE(v_dep.settlement, '{}'::jsonb);

  IF COALESCE(v_settlement->>'post_settlement_dispute_closed', 'false') = 'true' THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_FINALIZED' USING ERRCODE = 'P0001';
  END IF;

  IF v_dep.status NOT IN (
    'PENDING_APPROVAL',
    'APPROVED_PENDING_PAYOUT',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'DEDUCTED_FULL'
  ) THEN
    RAISE EXCEPTION 'DISPUTE_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(v_settlement->>'accounting_committed_at', '') <> ''
     OR v_dep.status IN ('PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL') THEN
    v_anchor_ts := COALESCE(
      NULLIF(v_settlement->>'payout_at', '')::timestamptz,
      NULLIF(v_settlement->>'approved_at', '')::timestamptz,
      v_dep.updated_at
    );
    IF NOW() > v_anchor_ts + INTERVAL '7 days' THEN
      RAISE EXCEPTION 'DISPUTE_WINDOW_EXPIRED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_thread := CASE
    WHEN jsonb_typeof(v_settlement->'dispute_thread') = 'array' THEN v_settlement->'dispute_thread'
    ELSE '[]'::jsonb
  END;
  v_now_iso := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  v_settlement := v_settlement || jsonb_build_object(
    'previous_status_before_dispute', v_dep.status,
    'disputed_by', v_user_id::text,
    'disputed_by_role', v_actor_role,
    'disputed_at', v_now_iso,
    'dispute_reason', v_trimmed_reason,
    'dispute_thread', v_thread || jsonb_build_array(
      jsonb_build_object(
        'type', 'DISPUTE',
        'at', v_now_iso,
        'by', v_user_id::text,
        'role', v_actor_role,
        'message', v_trimmed_reason
      )
    )
  );

  UPDATE deposit
  SET status = 'DISPUTED',
      settlement = v_settlement,
      updated_at = NOW()
  WHERE id = p_deposit_id
  RETURNING * INTO v_dep;

  INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
  VALUES (v_user_id, 'SETTLEMENT_DISPUTE', 'deposit', p_deposit_id, v_settlement);

  IF v_actor_role = 'RESIDENT' THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_org_id,
      ur.user_id,
      format('Khiếu nại tất toán cọc căn %s', v_apartment_code),
      format('Cư dân đã gửi ý kiến không đồng ý với bảng kê tất toán cọc: "%s"', v_trimmed_reason),
      'DEPOSIT_DISPUTED',
      jsonb_build_object('deposit_id', p_deposit_id, 'contract_id', v_contract_id)
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    JOIN app_user au ON au.id = ur.user_id
    WHERE ur.building_id = v_building_id
      AND r.code = 'MANAGER'
      AND au.status = 'ACTIVE';
  END IF;

  RETURN v_dep;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_update_deposit_refund_bank_info
CREATE OR REPLACE FUNCTION fn_update_deposit_refund_bank_info(
  p_deposit_id UUID,
  p_bank_info JSONB
)
RETURNS deposit AS $$
DECLARE
  v_user_id UUID;
  v_caller_org UUID;
  v_dep deposit%ROWTYPE;
  v_building_id UUID;
  v_primary_tenant_id UUID;
  v_settlement JSONB;
  v_before_bank JSONB;
  v_now_iso TEXT;
BEGIN
  v_user_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();
  IF v_user_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  SELECT d.*
  INTO v_dep
  FROM deposit d
  JOIN contract c ON c.id = d.contract_id
  JOIN building b ON b.id = c.building_id
  WHERE d.id = p_deposit_id
    AND b.org_id = v_caller_org
  FOR UPDATE OF d;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT c.building_id, c.primary_tenant_id
  INTO v_building_id, v_primary_tenant_id
  FROM contract c
  WHERE c.id = v_dep.contract_id;

  IF NOT (
    (is_manager() AND v_building_id IN (SELECT mb.building_id FROM get_manager_building_ids() mb))
    OR (v_primary_tenant_id IN (SELECT rt.tenant_id FROM get_resident_tenant_ids() rt))
    OR (is_owner() AND v_building_id IN (SELECT ob.building_id FROM get_owner_building_ids() ob))
    OR (is_org_admin() AND NOT building_has_active_owner(v_building_id))
  ) THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  v_settlement := COALESCE(v_dep.settlement, '{}'::jsonb);

  IF v_dep.status NOT IN ('APPROVED_PENDING_PAYOUT', 'RETURNED')
     OR COALESCE((v_settlement->>'refund_amount')::bigint, 0) <= 0 THEN
    RAISE EXCEPTION 'INVALID_STATUS_FOR_BANK_UPDATE' USING ERRCODE = 'P0001';
  END IF;

  v_before_bank := v_settlement->'bank_info';
  v_now_iso := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  v_settlement := v_settlement || jsonb_build_object(
    'bank_info', COALESCE(p_bank_info, '{}'::jsonb),
    'bank_info_updated_at', v_now_iso,
    'bank_info_updated_by', v_user_id::text
  );

  UPDATE deposit
  SET settlement = v_settlement,
      updated_at = NOW()
  WHERE id = p_deposit_id
  RETURNING * INTO v_dep;

  INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
  VALUES (
    v_user_id,
    'UPDATE_BANK_INFO',
    'deposit',
    p_deposit_id,
    jsonb_build_object('bank_info', v_before_bank),
    jsonb_build_object('bank_info', p_bank_info)
  );

  RETURN v_dep;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_notify_deposit_event
CREATE OR REPLACE FUNCTION fn_notify_deposit_event(
  p_deposit_id UUID,
  p_target_audience TEXT,
  p_type TEXT,
  p_title TEXT,
  p_content TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_specific_user_id UUID DEFAULT NULL
)
RETURNS INT AS $$
DECLARE
  v_user_id UUID;
  v_caller_org UUID;
  v_meta RECORD;
  v_cnt INT := 0;
BEGIN
  v_user_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();
  IF v_user_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT
    d.id AS deposit_id,
    c.id AS contract_id,
    c.building_id,
    c.primary_tenant_id,
    b.org_id
  INTO v_meta
  FROM deposit d
  JOIN contract c ON c.id = d.contract_id
  JOIN building b ON b.id = c.building_id
  WHERE d.id = p_deposit_id
    AND b.org_id = v_caller_org;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF NOT (
    is_org_admin()
    OR v_meta.building_id IN (SELECT ub.building_id FROM get_user_assigned_buildings() ub)
    OR v_meta.contract_id IN (SELECT rc.contract_id FROM get_resident_contract_ids() rc)
  ) THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  IF p_target_audience = 'RESIDENT' THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_meta.org_id,
      au.id,
      p_title,
      p_content,
      p_type,
      COALESCE(p_payload, '{}'::jsonb)
    FROM app_user au
    JOIN tenant t ON t.person_id = au.person_id
    WHERE au.status = 'ACTIVE'
      AND t.id = v_meta.primary_tenant_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;

  ELSIF p_target_audience = 'BUILDING_OWNERS' THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_meta.org_id,
      au.id,
      p_title,
      p_content,
      p_type,
      COALESCE(p_payload, '{}'::jsonb)
    FROM building b
    JOIN owner o ON o.id = b.owner_id
    JOIN app_user au ON au.person_id = o.person_id
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    WHERE b.id = v_meta.building_id
      AND au.status = 'ACTIVE'
      AND r.code = 'OWNER';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;

  ELSIF p_target_audience = 'BUILDING_MANAGERS' THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_meta.org_id,
      au.id,
      p_title,
      p_content,
      p_type,
      COALESCE(p_payload, '{}'::jsonb)
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    JOIN app_user au ON au.id = ur.user_id
    WHERE ur.building_id = v_meta.building_id
      AND r.code = 'MANAGER'
      AND au.status = 'ACTIVE';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;

  ELSIF p_target_audience = 'SPECIFIC_USER' AND p_specific_user_id IS NOT NULL THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT
      v_meta.org_id,
      au.id,
      p_title,
      p_content,
      p_type,
      COALESCE(p_payload, '{}'::jsonb)
    FROM app_user au
    JOIN person p ON p.id = au.person_id
    WHERE au.id = p_specific_user_id
      AND p.org_id = v_meta.org_id
      AND au.status = 'ACTIVE';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
  END IF;

  RETURN v_cnt;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_notify_reservation_prospect
CREATE OR REPLACE FUNCTION fn_notify_reservation_prospect(
  p_reservation_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_body TEXT
)
RETURNS INT AS $$
DECLARE
  v_caller_id UUID;
  v_rsv RECORD;
  v_allowed BOOLEAN := FALSE;
  v_cnt INT := 0;
BEGIN
  v_caller_id := get_current_user_id();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  SELECT r.id, r.building_id, r.apartment_id, r.phone, b.org_id
  INTO v_rsv
  FROM reservation r
  JOIN building b ON b.id = r.building_id
  WHERE r.id = p_reservation_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF is_org_admin() AND v_rsv.org_id = get_current_user_org_id() THEN
    v_allowed := TRUE;
  ELSIF (is_manager() OR is_owner()) AND v_rsv.building_id IN (SELECT building_id FROM get_user_assigned_buildings()) THEN
    v_allowed := TRUE;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  IF v_rsv.phone IS NULL OR btrim(v_rsv.phone) = '' THEN
    RETURN 0;
  END IF;

  INSERT INTO notification (org_id, user_id, title, content, type, payload)
  SELECT DISTINCT
    v_rsv.org_id,
    au.id,
    p_title,
    p_body,
    p_type,
    jsonb_build_object(
      'reservation_id', v_rsv.id,
      'apartment_id', v_rsv.apartment_id,
      'building_id', v_rsv.building_id,
      'link', '/resident'
    )
  FROM person p
  JOIN app_user au ON au.person_id = p.id
  WHERE p.org_id = v_rsv.org_id
    AND p.phone = v_rsv.phone
    AND au.status = 'ACTIVE';

  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RETURN v_cnt;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_notify_reservation_staff
CREATE OR REPLACE FUNCTION fn_notify_reservation_staff(
  p_reservation_id UUID,
  p_target_audience TEXT,
  p_type TEXT,
  p_title TEXT,
  p_body TEXT
)
RETURNS INT AS $$
DECLARE
  v_user_id UUID;
  v_caller_org UUID;
  v_rsv RECORD;
  v_allowed BOOLEAN := FALSE;
  v_has_owner BOOLEAN := FALSE;
  v_payload JSONB;
  v_cnt INT := 0;
BEGIN
  v_user_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();
  IF v_user_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT r.id, r.building_id, r.apartment_id, r.phone, b.org_id
  INTO v_rsv
  FROM reservation r
  JOIN building b ON b.id = r.building_id
  WHERE r.id = p_reservation_id
    AND b.org_id = v_caller_org;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF is_org_admin() AND NOT building_has_active_owner(v_rsv.building_id) THEN
    v_allowed := TRUE;
  ELSIF (is_manager() OR is_owner()) AND v_rsv.building_id IN (SELECT building_id FROM get_user_assigned_buildings()) THEN
    v_allowed := TRUE;
  ELSIF is_resident() AND v_rsv.phone = (SELECT p.phone FROM person p WHERE p.id = get_current_user_person_id()) THEN
    v_allowed := TRUE;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  v_payload := jsonb_build_object(
    'reservation_id', v_rsv.id,
    'apartment_id', v_rsv.apartment_id,
    'building_id', v_rsv.building_id,
    'link', '/admin/apartments/' || v_rsv.apartment_id::text
  );

  IF p_target_audience = 'APPROVERS' THEN
    v_has_owner := building_has_active_owner(v_rsv.building_id);
    IF v_has_owner THEN
      INSERT INTO notification (org_id, user_id, title, content, type, payload)
      SELECT DISTINCT
        v_rsv.org_id,
        au.id,
        p_title,
        p_body,
        p_type,
        v_payload
      FROM building b
      JOIN owner o ON o.id = b.owner_id
      JOIN app_user au ON au.person_id = o.person_id
      JOIN user_role ur ON ur.user_id = au.id
      JOIN role r ON r.id = ur.role_id
      WHERE b.id = v_rsv.building_id
        AND au.status = 'ACTIVE'
        AND r.code = 'OWNER'
        AND au.id <> v_user_id;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
    ELSE
      INSERT INTO notification (org_id, user_id, title, content, type, payload)
      SELECT DISTINCT
        v_rsv.org_id,
        au.id,
        p_title,
        p_body,
        p_type,
        v_payload
      FROM user_role ur
      JOIN role r ON r.id = ur.role_id
      JOIN app_user au ON au.id = ur.user_id
      JOIN person p ON p.id = au.person_id
      WHERE p.org_id = v_rsv.org_id
        AND au.status = 'ACTIVE'
        AND au.id <> v_user_id
        AND (
          r.code = 'SYS_ADMIN'
          OR (r.code = 'MANAGER' AND ur.building_id = v_rsv.building_id)
        );
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
    END IF;

  ELSIF p_target_audience = 'BUILDING_MANAGERS' THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_rsv.org_id,
      au.id,
      p_title,
      p_body,
      p_type,
      v_payload
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    JOIN app_user au ON au.id = ur.user_id
    WHERE ur.building_id = v_rsv.building_id
      AND r.code = 'MANAGER'
      AND au.status = 'ACTIVE';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
  END IF;

  RETURN v_cnt;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_update_reservation_refund_bank_info
CREATE OR REPLACE FUNCTION fn_update_reservation_refund_bank_info(
  p_reservation_id UUID,
  p_bank_info JSONB
)
RETURNS reservation AS $$
DECLARE
  v_user_id UUID;
  v_caller_org UUID;
  v_rsv reservation%ROWTYPE;
  v_before_bank JSONB;
  v_now_iso TEXT;
  v_meta JSONB;
BEGIN
  v_user_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();
  IF v_user_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT r.*
  INTO v_rsv
  FROM reservation r
  WHERE r.id = p_reservation_id
    AND r.org_id = v_caller_org
  FOR UPDATE OF r;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    (is_manager() AND v_rsv.building_id IN (SELECT mb.building_id FROM get_manager_building_ids() mb))
    OR (
      is_resident()
      AND v_rsv.phone IS NOT NULL
      AND btrim(v_rsv.phone) <> ''
      AND v_rsv.phone = (SELECT p.phone FROM person p WHERE p.id = get_current_user_person_id())
    )
  ) THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  IF v_rsv.status <> 'APPROVED_PENDING_PAYOUT' OR COALESCE(v_rsv.refunded_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'INVALID_STATUS_FOR_BANK_UPDATE' USING ERRCODE = 'P0001';
  END IF;

  v_before_bank := v_rsv.refund_bank_info;
  v_now_iso := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_meta := COALESCE(v_rsv.cancel_settlement, '{}'::jsonb) || jsonb_build_object(
    'bank_info_updated_at', v_now_iso,
    'bank_info_updated_by', v_user_id::text
  );

  UPDATE reservation
  SET refund_bank_info = COALESCE(p_bank_info, '{}'::jsonb),
      refund_method = 'BANK_TRANSFER',
      cancel_settlement = v_meta,
      updated_at = NOW()
  WHERE id = p_reservation_id
  RETURNING * INTO v_rsv;

  INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
  VALUES (
    v_user_id,
    'UPDATE_BANK_INFO',
    'reservation',
    p_reservation_id,
    jsonb_build_object('refund_bank_info', v_before_bank),
    jsonb_build_object('refund_bank_info', p_bank_info)
  );

  RETURN v_rsv;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_restore_returned_settlement_credits
CREATE OR REPLACE FUNCTION fn_restore_returned_settlement_credits(
  p_deposit_id UUID,
  p_reason TEXT
)
RETURNS INT AS $$
DECLARE
  v_count INT := 0;
BEGIN
  UPDATE credit_balance
  SET status = 'PENDING_SETTLEMENT_PAYOUT',
      refunded_at = NULL,
      refund_meta = COALESCE(refund_meta, '{}'::jsonb) || jsonb_build_object(
        'restore_reason', p_reason,
        'restored_at', NOW()
      ),
      updated_at = NOW()
  WHERE settlement_deposit_id = p_deposit_id
    AND status = 'REFUNDED_IN_SETTLEMENT';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_recommit_returned_settlement_credits
CREATE OR REPLACE FUNCTION fn_recommit_returned_settlement_credits(
  p_deposit_id UUID
)
RETURNS INT AS $$
DECLARE
  v_count INT := 0;
BEGIN
  UPDATE credit_balance
  SET status = 'REFUNDED_IN_SETTLEMENT',
      refunded_at = NOW(),
      updated_at = NOW()
  WHERE settlement_deposit_id = p_deposit_id
    AND status = 'PENDING_SETTLEMENT_PAYOUT';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_get_finance_resource_scope
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

-- Function: fn_lock_invoices_for_authorized_viewer
CREATE OR REPLACE FUNCTION fn_lock_invoices_for_authorized_viewer(
  p_contract_id UUID DEFAULT NULL,
  p_invoice_id UUID DEFAULT NULL
)
RETURNS SETOF invoice AS $$
BEGIN
  IF p_contract_id IS NULL AND p_invoice_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT i.*
  FROM invoice i
  WHERE (
    (p_invoice_id IS NOT NULL AND i.id = p_invoice_id)
    OR (p_invoice_id IS NULL AND p_contract_id IS NOT NULL AND i.contract_id = p_contract_id)
  )
  AND i.status <> 'VOID'
  AND (
    (get_current_user_id() IS NULL AND current_user <> 'resihub_app')
    OR (
      i.org_id = get_current_user_org_id()
      AND (
        is_org_admin()
        OR i.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        OR (
          i.status <> 'DRAFT'
          AND (
            i.contract_id IN (SELECT rc.contract_id FROM get_resident_contract_ids() rc)
            OR i.tenant_id IN (SELECT rt.tenant_id FROM get_resident_tenant_ids() rt)
          )
        )
      )
    )
  )
  ORDER BY i.period ASC, i.created_at ASC
  FOR UPDATE OF i;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_notify_building_finance_actors
CREATE OR REPLACE FUNCTION fn_notify_building_finance_actors(
  p_building_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_message TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_include_resident_user_id UUID DEFAULT NULL
)
RETURNS INT AS $$
DECLARE
  v_org_id UUID;
  v_count INT := 0;
  v_caller_id UUID;
  v_caller_org UUID;
BEGIN
  v_caller_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();

  SELECT b.org_id INTO v_org_id
  FROM building b
  WHERE b.id = p_building_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Nếu gọi từ phiên ứng dụng có user session, kiểm tra quyền truy cập tòa
  IF v_caller_id IS NOT NULL THEN
    IF v_caller_org IS NULL OR v_caller_org <> v_org_id THEN
      RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
    END IF;
    IF NOT (is_org_admin() OR p_building_id IN (SELECT building_id FROM get_user_assigned_buildings())) THEN
      RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO notification (org_id, user_id, title, content, type, payload)
  SELECT DISTINCT
    v_org_id,
    target_users.id,
    p_title,
    p_message,
    p_type,
    COALESCE(p_metadata, '{}'::jsonb)
  FROM (
    -- Quản lý tòa nhà
    SELECT au.id
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    JOIN app_user au ON au.id = ur.user_id
    JOIN person p ON p.id = au.person_id
    WHERE ur.building_id = p_building_id
      AND r.code = 'MANAGER'
      AND au.status = 'ACTIVE'
      AND p.org_id = v_org_id
    UNION
    -- Chủ nhà tòa nhà
    SELECT au.id
    FROM building b
    JOIN owner o ON o.id = b.owner_id
    JOIN app_user au ON au.person_id = o.person_id
    JOIN person p ON p.id = au.person_id
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    WHERE b.id = p_building_id
      AND r.code = 'OWNER'
      AND au.status = 'ACTIVE'
      AND p.org_id = v_org_id
    UNION
    -- Cư dân nếu được chỉ định
    SELECT au.id
    FROM app_user au
    JOIN person p ON p.id = au.person_id
    WHERE p_include_resident_user_id IS NOT NULL
      AND au.id = p_include_resident_user_id
      AND au.status = 'ACTIVE'
      AND p.org_id = v_org_id
  ) target_users;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_resolve_credit_refund
CREATE OR REPLACE FUNCTION fn_resolve_credit_refund(
  p_credit_id UUID,
  p_decision TEXT,
  p_rejection_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_actor_id UUID;
  v_caller_org UUID;
  v_decision_upper TEXT := upper(btrim(COALESCE(p_decision, '')));
  v_rejection_trimmed TEXT := btrim(COALESCE(p_rejection_reason, ''));
  v_cb RECORD;
  v_allow_self_approval BOOLEAN := FALSE;
  v_is_authorized BOOLEAN := FALSE;
  v_creator_id UUID;
  v_parent_id UUID;
BEGIN
  v_actor_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();

  IF v_actor_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_decision_upper IN ('APPROVE', 'APPROVED') THEN
    v_decision_upper := 'APPROVED';
  ELSIF v_decision_upper IN ('REJECT', 'REJECTED') THEN
    v_decision_upper := 'REJECTED';
  ELSE
    RAISE EXCEPTION 'INVALID_DECISION' USING ERRCODE = '22023';
  END IF;

  IF v_decision_upper = 'REJECTED' AND v_rejection_trimmed = '' THEN
    RAISE EXCEPTION 'MISSING_REASON' USING ERRCODE = '22023';
  END IF;

  SELECT cb.*, b.org_id AS bldg_org_id
  INTO v_cb
  FROM credit_balance cb
  JOIN building b ON b.id = cb.building_id
  WHERE cb.id = p_credit_id
  FOR UPDATE OF cb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_cb.bldg_org_id <> v_caller_org THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_cb.status <> 'PENDING_DIRECT_REFUND' THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING ERRCODE = 'P0001';
  END IF;

  IF (is_owner() AND v_cb.building_id IN (SELECT building_id FROM get_owner_building_ids()))
     OR (is_manager() AND v_cb.building_id IN (SELECT building_id FROM get_manager_building_ids()))
     OR (is_org_admin() AND NOT building_has_active_owner(v_cb.building_id)) THEN
    v_is_authorized := TRUE;
  END IF;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_creator_id := COALESCE(
    NULLIF(v_cb.refund_meta->>'requested_by', '')::uuid,
    v_cb.updated_by,
    v_cb.created_by
  );

  SELECT (value->>'allow_self_approval')::boolean
  INTO v_allow_self_approval
  FROM system_setting
  WHERE org_id = v_cb.org_id AND key = 'approval_config';

  IF v_creator_id = v_actor_id THEN
    IF NOT COALESCE(v_allow_self_approval, FALSE) THEN
      RAISE EXCEPTION 'SELF_APPROVAL' USING ERRCODE = '42501';
    ELSE
      INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
      VALUES (
        v_actor_id,
        'SELF_APPROVAL_WARNING',
        'credit_balance',
        v_cb.id,
        jsonb_build_object('credit_id', v_cb.id, 'actor_id', v_actor_id)
      );
    END IF;
  END IF;

  IF v_decision_upper = 'REJECTED' THEN
    v_parent_id := v_cb.parent_credit_id;

    IF v_parent_id IS NOT NULL THEN
      UPDATE credit_balance
      SET applied_amount = GREATEST(0, applied_amount - v_cb.amount),
          status = CASE WHEN applied_amount - v_cb.amount > 0 THEN 'PARTIALLY_APPLIED' ELSE 'AVAILABLE' END,
          updated_at = NOW()
      WHERE id = v_parent_id;

      UPDATE credit_balance
      SET status = 'VOID',
          refund_meta = COALESCE(refund_meta, '{}'::jsonb) || jsonb_build_object('rejection_reason', v_rejection_trimmed),
          updated_by = v_actor_id,
          updated_at = NOW()
      WHERE id = v_cb.id;
    ELSE
      UPDATE credit_balance
      SET status = CASE WHEN applied_amount > 0 THEN 'PARTIALLY_APPLIED' ELSE 'AVAILABLE' END,
          refund_meta = COALESCE(refund_meta, '{}'::jsonb) || jsonb_build_object('rejection_reason', v_rejection_trimmed),
          updated_by = v_actor_id,
          updated_at = NOW()
      WHERE id = v_cb.id;
    END IF;

    INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
    VALUES (
      v_actor_id,
      'REJECT_CREDIT_REFUND',
      'credit_balance',
      v_cb.id,
      jsonb_build_object('status', v_cb.status),
      jsonb_build_object('status', 'REJECTED', 'rejection_reason', v_rejection_trimmed)
    );

    IF v_cb.tenant_id IS NOT NULL THEN
      INSERT INTO notification (org_id, user_id, title, content, type, payload)
      SELECT DISTINCT
        v_cb.org_id,
        au.id,
        'Từ chối hoàn số dư tín dụng',
        format('Yêu cầu hoàn %s ₫ bị từ chối: "%s"', v_cb.amount, v_rejection_trimmed),
        'CREDIT_REFUND_REJECTED',
        jsonb_build_object('credit_id', v_cb.id)
      FROM tenant t
      JOIN person p ON p.id = t.person_id
      JOIN app_user au ON au.person_id = p.id
      WHERE t.id = v_cb.tenant_id AND au.status = 'ACTIVE';
    END IF;

    RETURN jsonb_build_object(
      'status', 'REJECTED',
      'credit_id', v_cb.id,
      'rejection_reason', v_rejection_trimmed
    );
  END IF;

  -- APPROVED:
  UPDATE credit_balance
  SET status = 'REFUNDED_DIRECT',
      applied_amount = amount,
      refunded_at = NOW(),
      updated_by = v_actor_id,
      updated_at = NOW()
  WHERE id = v_cb.id;

  INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
  VALUES (
    v_actor_id,
    'APPROVE_CREDIT_REFUND',
    'credit_balance',
    v_cb.id,
    jsonb_build_object('status', v_cb.status),
    jsonb_build_object('status', 'REFUNDED_DIRECT', 'amount', v_cb.amount)
  );

  IF v_cb.tenant_id IS NOT NULL THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_cb.org_id,
      au.id,
      'Phê duyệt hoàn số dư tín dụng',
      format('Yêu cầu hoàn %s ₫ đã được phê duyệt thành công.', v_cb.amount),
      'CREDIT_REFUNDED',
      jsonb_build_object('credit_id', v_cb.id, 'amount', v_cb.amount)
    FROM tenant t
    JOIN person p ON p.id = t.person_id
    JOIN app_user au ON au.person_id = p.id
    WHERE t.id = v_cb.tenant_id AND au.status = 'ACTIVE';
  END IF;

  RETURN jsonb_build_object(
    'status', 'REFUNDED_DIRECT',
    'credit_id', v_cb.id,
    'amount', v_cb.amount
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_resolve_invoice_adjustment
CREATE OR REPLACE FUNCTION fn_resolve_invoice_adjustment(
  p_adjustment_id UUID,
  p_decision TEXT,
  p_rejection_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_actor_id UUID;
  v_caller_org UUID;
  v_decision_upper TEXT := upper(btrim(COALESCE(p_decision, '')));
  v_rejection_trimmed TEXT := btrim(COALESCE(p_rejection_reason, ''));
  v_adj RECORD;
  v_inv RECORD;
  v_allow_self_approval BOOLEAN := FALSE;
  v_is_authorized BOOLEAN := FALSE;
  v_formula JSONB;
  v_principal BIGINT;
  v_net_late_fee BIGINT;
  v_new_subtotal BIGINT;
  v_new_adjustment BIGINT;
  v_gross_after_adj BIGINT;
  v_new_total BIGINT;
  v_excess_credit BIGINT;
  v_cr RECORD;
  v_rel BIGINT;
  v_new_credit_offset BIGINT;
  v_overpayment BIGINT := 0;
  v_new_paid BIGINT;
  v_new_status TEXT;
  v_target_contract_id UUID;
  v_child_contract_id UUID;
  v_minted_credit_id UUID;
BEGIN
  v_actor_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();

  IF v_actor_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_decision_upper IN ('APPROVE', 'APPROVED') THEN
    v_decision_upper := 'APPROVED';
  ELSIF v_decision_upper IN ('REJECT', 'REJECTED') THEN
    v_decision_upper := 'REJECTED';
  ELSE
    RAISE EXCEPTION 'INVALID_DECISION' USING ERRCODE = '22023';
  END IF;

  IF v_decision_upper = 'REJECTED' AND v_rejection_trimmed = '' THEN
    RAISE EXCEPTION 'MISSING_REASON' USING ERRCODE = '22023';
  END IF;

  SELECT ia.*, b.org_id AS bldg_org_id
  INTO v_adj
  FROM invoice_adjustment ia
  JOIN building b ON b.id = ia.building_id
  WHERE ia.id = p_adjustment_id
  FOR UPDATE OF ia;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_adj.bldg_org_id <> v_caller_org THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_adj.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING ERRCODE = 'P0001';
  END IF;

  -- Kiểm tra vai trò phê duyệt: OWNER tòa, MANAGER được gán, hoặc SYS_ADMIN khi tòa chưa có active owner
  IF (is_owner() AND v_adj.building_id IN (SELECT building_id FROM get_owner_building_ids()))
     OR (is_manager() AND v_adj.building_id IN (SELECT building_id FROM get_manager_building_ids()))
     OR (is_org_admin() AND NOT building_has_active_owner(v_adj.building_id)) THEN
    v_is_authorized := TRUE;
  END IF;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- 4-Eyes Check: đọc system_setting('approval_config')
  SELECT (value->>'allow_self_approval')::boolean
  INTO v_allow_self_approval
  FROM system_setting
  WHERE org_id = v_adj.org_id AND key = 'approval_config';

  IF v_adj.created_by = v_actor_id THEN
    IF NOT COALESCE(v_allow_self_approval, FALSE) THEN
      RAISE EXCEPTION 'SELF_APPROVAL' USING ERRCODE = '42501';
    ELSE
      INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
      VALUES (
        v_actor_id,
        'SELF_APPROVAL_WARNING',
        'invoice_adjustment',
        v_adj.id,
        jsonb_build_object('adjustment_id', v_adj.id, 'actor_id', v_actor_id)
      );
    END IF;
  END IF;

  -- Khóa dòng invoice cha
  SELECT *
  INTO v_inv
  FROM invoice
  WHERE id = v_adj.invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- XỬ LÝ REJECTED
  IF v_decision_upper = 'REJECTED' THEN
    UPDATE invoice_adjustment
    SET status = 'REJECTED',
        rejection_reason = v_rejection_trimmed,
        updated_by = v_actor_id,
        updated_at = NOW()
    WHERE id = v_adj.id;

    INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
    VALUES (
      v_actor_id,
      'REJECT_INVOICE_ADJUSTMENT',
      'invoice_adjustment',
      v_adj.id,
      jsonb_build_object('status', v_adj.status),
      jsonb_build_object('status', 'REJECTED', 'rejection_reason', v_rejection_trimmed)
    );

    RETURN jsonb_build_object(
      'status', 'REJECTED',
      'adjustment_id', v_adj.id,
      'invoice_id', v_inv.id,
      'rejection_reason', v_rejection_trimmed
    );
  END IF;

  -- XỬ LÝ APPROVED:
  UPDATE invoice_adjustment
  SET status = 'APPROVED',
      approved_by = v_actor_id,
      approved_at = NOW(),
      updated_by = v_actor_id,
      updated_at = NOW()
  WHERE id = v_adj.id;

  -- 1) Hành động VOID
  IF v_adj.action_type = 'VOID' THEN
    IF v_inv.paid_amount > 0 THEN
      RAISE EXCEPTION 'ALREADY_PAID' USING ERRCODE = 'P0001';
    END IF;

    -- Nhả credit_offset_amount về credit_balance nếu có
    IF v_inv.credit_offset_amount > 0 THEN
      FOR v_cr IN
        SELECT il.credit_id, ABS(il.amount) AS line_amt
        FROM invoice_line il
        WHERE il.invoice_id = v_inv.id AND il.credit_id IS NOT NULL AND il.amount < 0
      LOOP
        UPDATE credit_balance
        SET applied_amount = GREATEST(0, applied_amount - v_cr.line_amt),
            status = CASE WHEN applied_amount - v_cr.line_amt > 0 THEN 'PARTIALLY_APPLIED' ELSE 'AVAILABLE' END,
            updated_at = NOW()
        WHERE id = v_cr.credit_id;
      END LOOP;
    END IF;

    -- Giải phóng tracker phí phạt đã carry sang hóa đơn này (hợp nhất vào dòng mở nếu đã có)
    FOR v_cr IN
      SELECT id, invoice_id, accrued_total, chargeable_days, as_of_date
      FROM late_fee_accrual_tracker
      WHERE carried_to_invoice_id = v_inv.id
      FOR UPDATE
    LOOP
      IF EXISTS (
        SELECT 1 FROM late_fee_accrual_tracker
        WHERE invoice_id = v_cr.invoice_id
          AND carried_to_invoice_id IS NULL
          AND id <> v_cr.id
      ) THEN
        UPDATE late_fee_accrual_tracker
        SET accrued_total = accrued_total + v_cr.accrued_total,
            chargeable_days = GREATEST(chargeable_days, v_cr.chargeable_days),
            as_of_date = GREATEST(as_of_date, v_cr.as_of_date),
            updated_at = NOW()
        WHERE invoice_id = v_cr.invoice_id
          AND carried_to_invoice_id IS NULL
          AND id <> v_cr.id;

        DELETE FROM late_fee_accrual_tracker WHERE id = v_cr.id;
      ELSE
        UPDATE late_fee_accrual_tracker
        SET carried_to_invoice_id = NULL,
            carried_at = NULL,
            updated_at = NOW()
        WHERE id = v_cr.id;
      END IF;
    END LOOP;

    UPDATE invoice
    SET status = 'VOID',
        credit_offset_amount = 0,
        updated_at = NOW()
    WHERE id = v_inv.id;

    UPDATE receivable
    SET status = 'WRITTEN_OFF',
        updated_at = NOW()
    WHERE invoice_id = v_inv.id AND status IN ('OPEN', 'PARTIALLY_PAID');

    INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
    VALUES (
      v_actor_id,
      'APPROVE_INVOICE_VOID',
      'invoice',
      v_inv.id,
      jsonb_build_object('status', v_inv.status),
      jsonb_build_object('status', 'VOID')
    );

    IF v_inv.tenant_id IS NOT NULL THEN
      INSERT INTO notification (org_id, user_id, title, content, type, payload)
      SELECT DISTINCT
        v_inv.org_id,
        au.id,
        format('Hủy hóa đơn kỳ %s', COALESCE(v_inv.period, 'tất toán')),
        format('Hóa đơn %s đã được phê duyệt hủy bỏ', v_inv.invoice_code),
        'INVOICE_VOIDED',
        jsonb_build_object('invoice_id', v_inv.id, 'adjustment_id', v_adj.id)
      FROM tenant t
      JOIN person p ON p.id = t.person_id
      JOIN app_user au ON au.person_id = p.id
      WHERE t.id = v_inv.tenant_id AND au.status = 'ACTIVE';
    END IF;

    RETURN jsonb_build_object(
      'status', 'APPROVED',
      'action_type', 'VOID',
      'adjustment_id', v_adj.id,
      'invoice_id', v_inv.id
    );
  END IF;

  -- 2) Hành động ADJUST:
  v_formula := CASE
    WHEN v_adj.adjustment_target = 'LATE_FEE' THEN jsonb_build_object('adjusts_item_type', 'LATE_FEE')
    ELSE COALESCE(v_adj.formula_meta, '{}'::jsonb)
  END;

  INSERT INTO invoice_line (
    invoice_id, item_type, description, quantity, unit, unit_price, amount, adjustment_id, formula_meta
  )
  VALUES (
    v_inv.id, 'ADJUSTMENT', v_adj.reason, 1, 'lần', v_adj.delta_amount, v_adj.delta_amount, v_adj.id, v_formula
  );

  -- Triệt tiêu append-only phạt nộp muộn nếu hóa đơn REGULAR chưa thu tiền và nợ gốc về <= 0
  IF v_inv.paid_amount = 0 AND COALESCE(v_inv.invoice_type, 'REGULAR') <> 'LATE_FEE_SETTLEMENT' THEN
    SELECT COALESCE(SUM(il.amount), 0)
    INTO v_principal
    FROM invoice_line il
    WHERE il.invoice_id = v_inv.id
      AND il.credit_id IS NULL
      AND NOT (
        il.item_type = 'LATE_FEE'
        OR (il.item_type = 'ADJUSTMENT' AND COALESCE(il.formula_meta->>'adjusts_item_type', '') = 'LATE_FEE')
      );

    IF v_principal <= 0 THEN
      SELECT COALESCE(SUM(il.amount), 0)
      INTO v_net_late_fee
      FROM invoice_line il
      WHERE il.invoice_id = v_inv.id
        AND (
          il.item_type = 'LATE_FEE'
          OR (il.item_type = 'ADJUSTMENT' AND COALESCE(il.formula_meta->>'adjusts_item_type', '') = 'LATE_FEE')
        );

      IF v_net_late_fee > 0 THEN
        INSERT INTO invoice_line (
          invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta
        )
        VALUES (
          v_inv.id, 'ADJUSTMENT', 'Triệt tiêu phạt nộp muộn khi nợ gốc bằng 0', 1, 'lần',
          -v_net_late_fee, -v_net_late_fee,
          jsonb_build_object('adjusts_item_type', 'LATE_FEE', 'auto_neutralized', true)
        );
      END IF;
    END IF;
  END IF;

  -- Tính toán lại tổng tiền hóa đơn (chỉ cộng các khoản điều chỉnh giá, không tính dòng bù trừ tín dụng credit_id)
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE item_type <> 'ADJUSTMENT'), v_inv.subtotal_amount)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE item_type = 'ADJUSTMENT' AND credit_id IS NULL), 0)::bigint
  INTO v_new_subtotal, v_new_adjustment
  FROM invoice_line
  WHERE invoice_id = v_inv.id;

  v_new_subtotal := COALESCE(v_new_subtotal, v_inv.subtotal_amount);
  v_gross_after_adj := GREATEST(0, v_new_subtotal + v_new_adjustment);

  -- Xử lý hoàn lại credit_offset_amount dư về credit_balance
  IF v_inv.credit_offset_amount > v_gross_after_adj THEN
    v_excess_credit := v_inv.credit_offset_amount - v_gross_after_adj;
    FOR v_cr IN
      SELECT cb.id AS credit_id, cb.applied_amount
      FROM credit_balance cb
      WHERE (cb.source_invoice_id = v_inv.id OR cb.id IN (SELECT il.credit_id FROM invoice_line il WHERE il.invoice_id = v_inv.id AND il.credit_id IS NOT NULL))
        AND cb.status IN ('AVAILABLE', 'PARTIALLY_APPLIED', 'APPLIED')
        AND cb.applied_amount > 0
      ORDER BY cb.updated_at DESC
    LOOP
      EXIT WHEN v_excess_credit <= 0;
      v_rel := LEAST(v_excess_credit, v_cr.applied_amount);
      UPDATE credit_balance
      SET applied_amount = applied_amount - v_rel,
          status = CASE WHEN applied_amount - v_rel > 0 THEN 'PARTIALLY_APPLIED' ELSE 'AVAILABLE' END,
          updated_at = NOW()
      WHERE id = v_cr.credit_id;

      INSERT INTO invoice_line (
        invoice_id, item_type, description, quantity, unit, unit_price, amount, credit_id
      )
      VALUES (
        v_inv.id, 'ADJUSTMENT', 'Hoàn trả số dư bù trừ dư thừa vào sổ tín dụng', 1, 'lần',
        v_rel, v_rel, v_cr.credit_id
      );

      v_excess_credit := v_excess_credit - v_rel;
    END LOOP;
    v_new_credit_offset := v_gross_after_adj;
  ELSE
    v_new_credit_offset := v_inv.credit_offset_amount;
  END IF;

  -- Bug #2 Fix: trừ v_new_credit_offset khỏi tổng tiền sau điều chỉnh
  v_new_total := GREATEST(0, v_gross_after_adj - v_new_credit_offset);

  -- Xử lý sinh credit_balance nếu tiền đã nộp > tổng tiền mới
  IF v_inv.paid_amount > v_new_total THEN
    v_overpayment := v_inv.paid_amount - v_new_total;
    v_new_paid := v_new_total;

    -- Kiểm tra hợp đồng con chuyển phòng (room transfer)
    v_target_contract_id := v_inv.contract_id;
    IF v_inv.contract_id IS NOT NULL THEN
      SELECT c_child.id INTO v_child_contract_id
      FROM contract c_child
      WHERE c_child.parent_contract_id = v_inv.contract_id
        AND c_child.status = 'ACTIVE'
      LIMIT 1;
      IF v_child_contract_id IS NOT NULL THEN
        v_target_contract_id := v_child_contract_id;
      END IF;
    END IF;

    INSERT INTO credit_balance (
      org_id, building_id, contract_id, tenant_id, source_invoice_id, source_adjustment_id,
      reason_type, amount, status, description, created_by, updated_by
    )
    VALUES (
      v_inv.org_id, v_inv.building_id, v_target_contract_id, v_inv.tenant_id, v_inv.id, v_adj.id,
      'INVOICE_ADJUSTMENT', v_overpayment, 'AVAILABLE',
      format('Số dư thừa phát sinh từ điều chỉnh hóa đơn %s', v_inv.invoice_code),
      v_actor_id, v_actor_id
    )
    RETURNING id INTO v_minted_credit_id;
  ELSE
    v_new_paid := v_inv.paid_amount;
  END IF;

  v_new_status := CASE
    WHEN v_new_paid >= v_new_total AND v_new_total > 0 THEN 'PAID'
    WHEN v_new_paid >= v_new_total AND v_new_total = 0 THEN 'PAID'
    WHEN v_new_paid > 0 THEN 'PARTIALLY_PAID'
    WHEN v_inv.status = 'DRAFT' THEN 'DRAFT'
    ELSE 'ISSUED'
  END;

  UPDATE invoice
  SET subtotal_amount = v_new_subtotal,
      adjustment_amount = v_new_adjustment,
      total_amount = v_new_total,
      paid_amount = v_new_paid,
      credit_offset_amount = v_new_credit_offset,
      status = v_new_status,
      updated_at = NOW()
  WHERE id = v_inv.id;

  -- UPSERT receivable
  IF v_new_total > v_new_paid THEN
    UPDATE receivable
    SET amount = v_new_total,
        paid_amount = v_new_paid,
        status = CASE WHEN v_new_paid > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
        updated_at = NOW()
    WHERE invoice_id = v_inv.id AND status IN ('OPEN', 'PARTIALLY_PAID');

    IF NOT FOUND THEN
      INSERT INTO receivable (
        org_id, building_id, contract_id, tenant_id, invoice_id,
        type, amount, paid_amount, due_date, status, description
      )
      VALUES (
        v_inv.org_id, v_inv.building_id, v_inv.contract_id, v_inv.tenant_id, v_inv.id,
        'INVOICE_DEBT', v_new_total, v_new_paid, CURRENT_DATE + 5,
        CASE WHEN v_new_paid > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
        format('Công nợ sau điều chỉnh hóa đơn %s', v_inv.invoice_code)
      );
    END IF;
  ELSE
    UPDATE receivable
    SET paid_amount = CASE WHEN v_new_total = 0 THEN 0 ELSE amount END,
        status = CASE WHEN v_new_total = 0 THEN 'WRITTEN_OFF' ELSE 'PAID' END,
        updated_at = NOW()
    WHERE invoice_id = v_inv.id AND status IN ('OPEN', 'PARTIALLY_PAID');
  END IF;

  -- Audit log & thông báo cư dân
  INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
  VALUES (
    v_actor_id,
    'APPROVE_INVOICE_ADJUSTMENT',
    'invoice_adjustment',
    v_adj.id,
    jsonb_build_object('status', v_adj.status, 'total_amount', v_inv.total_amount, 'paid_amount', v_inv.paid_amount),
    jsonb_build_object('status', 'APPROVED', 'total_amount', v_new_total, 'paid_amount', v_new_paid, 'minted_credit_id', v_minted_credit_id)
  );

  IF v_inv.tenant_id IS NOT NULL THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_inv.org_id,
      au.id,
      format('Điều chỉnh hóa đơn kỳ %s', COALESCE(v_inv.period, 'tất toán')),
      format('Hóa đơn %s đã được phê duyệt điều chỉnh %s ₫', v_inv.invoice_code, v_adj.delta_amount),
      'INVOICE_ADJUSTED',
      jsonb_build_object('invoice_id', v_inv.id, 'adjustment_id', v_adj.id)
    FROM tenant t
    JOIN person p ON p.id = t.person_id
    JOIN app_user au ON au.person_id = p.id
    WHERE t.id = v_inv.tenant_id AND au.status = 'ACTIVE';
  END IF;

  RETURN jsonb_build_object(
    'status', 'APPROVED',
    'action_type', 'ADJUST',
    'adjustment_id', v_adj.id,
    'invoice_id', v_inv.id,
    'total_amount', v_new_total,
    'paid_amount', v_new_paid,
    'overpayment_minted', v_overpayment,
    'minted_credit_id', v_minted_credit_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_apply_deposit_settlement_accounting
CREATE OR REPLACE FUNCTION fn_apply_deposit_settlement_accounting(
  p_deposit_id UUID,
  p_covered_service_debt BIGINT,
  p_uncovered_items_shortfall BIGINT
)
RETURNS VOID AS $$
DECLARE
  v_actor_id UUID;
  v_caller_org UUID;
  v_dep RECORD;
  v_authorized BOOLEAN := FALSE;
  v_remaining_dep_cover BIGINT := GREATEST(0, COALESCE(p_covered_service_debt, 0));
  v_inv RECORD;
  v_paid BIGINT;
  v_total BIGINT;
  v_rem BIGINT;
  v_raw_rent BIGINT;
  v_raw_service BIGINT;
  v_paid_to_rent BIGINT;
  v_rent_unpaid BIGINT;
  v_service_unpaid BIGINT;
  v_cb RECORD;
  v_apply BIGINT;
  v_inv_cur_paid BIGINT;
  v_inv_cur_credit BIGINT;
  v_new_status TEXT;
  v_still_unpaid BIGINT;
BEGIN
  v_actor_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();

  IF v_actor_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN_SETTLEMENT_ACCOUNTING' USING ERRCODE = '42501';
  END IF;

  SELECT d.id, d.status, d.contract_id, c.building_id, c.primary_tenant_id, b.org_id
  INTO v_dep
  FROM deposit d
  JOIN contract c ON c.id = d.contract_id
  JOIN building b ON b.id = c.building_id
  WHERE d.id = p_deposit_id
    AND b.org_id = v_caller_org
  FOR UPDATE OF d;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEPOSIT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_dep.status NOT IN (
    'PENDING_APPROVAL',
    'APPROVED_PENDING_PAYOUT',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'DEDUCTED_FULL'
  ) THEN
    RAISE EXCEPTION 'INVALID_DEPOSIT_STATUS_FOR_ACCOUNTING' USING ERRCODE = 'P0001';
  END IF;

  IF (is_manager() AND v_dep.building_id IN (SELECT building_id FROM get_manager_building_ids()))
     OR (is_owner() AND v_dep.building_id IN (SELECT building_id FROM get_owner_building_ids()))
     OR (is_org_admin() AND NOT building_has_active_owner(v_dep.building_id)) THEN
    v_authorized := TRUE;
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'FORBIDDEN_SETTLEMENT_ACCOUNTING' USING ERRCODE = '42501';
  END IF;

  -- Bảng tạm lưu danh sách hóa đơn mở và nhu cầu công nợ đã qua xử lý tràn âm
  CREATE TEMPORARY TABLE IF NOT EXISTS tmp_settlement_invoices (
    id UUID PRIMARY KEY,
    invoice_code TEXT,
    period TEXT,
    total_amount BIGINT,
    paid_amount BIGINT,
    credit_offset_amount BIGINT,
    status TEXT,
    rent_unpaid BIGINT,
    service_unpaid BIGINT
  ) ON COMMIT DROP;

  DELETE FROM tmp_settlement_invoices;

  FOR v_inv IN
    SELECT i.id, i.invoice_code, i.period, i.total_amount, i.paid_amount, i.credit_offset_amount, i.status
    FROM invoice i
    WHERE i.contract_id = v_dep.contract_id
      AND i.status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED')
      AND (i.total_amount - i.paid_amount) > 0
    ORDER BY i.period ASC, i.created_at ASC
    FOR UPDATE
  LOOP
    v_total := GREATEST(0, COALESCE(v_inv.total_amount, 0));
    v_paid := GREATEST(0, COALESCE(v_inv.paid_amount, 0));
    v_rem := GREATEST(0, v_total - v_paid);

    IF v_rem <= 0 THEN
      CONTINUE;
    END IF;

    -- Tính raw_rent và raw_service qua invoice_line & invoice_adjustment (Bug #1 Fix: bổ sung 'LATE_FEE')
    SELECT
      COALESCE(SUM(il.amount) FILTER (
        WHERE (il.item_type = 'RENT'
           OR (il.item_type = 'ADJUSTMENT' AND (ia.adjustment_target = 'RENT' OR il.formula_meta->>'adjusts_item_type' = 'RENT')))
          AND il.credit_id IS NULL
      ), 0)::bigint,
      COALESCE(SUM(il.amount) FILTER (
        WHERE (il.item_type IN ('SERVICE', 'ELECTRICITY', 'WATER', 'OTHER', 'LATE_FEE')
           OR (il.item_type = 'ADJUSTMENT' AND (ia.adjustment_target IN ('SERVICE', 'LATE_FEE', 'MANUAL') OR il.formula_meta->>'adjusts_item_type' IN ('SERVICE', 'LATE_FEE') OR (ia.adjustment_target IS NULL AND il.formula_meta->>'adjusts_item_type' IS NULL))))
          AND il.credit_id IS NULL
      ), 0)::bigint
    INTO v_raw_rent, v_raw_service
    FROM invoice_line il
    LEFT JOIN invoice_adjustment ia ON ia.id = il.adjustment_id
    WHERE il.invoice_id = v_inv.id;

    -- Xử lý tràn âm liên nhóm: raw_service < 0 tràn sang raw_rent và ngược lại
    IF v_raw_service < 0 THEN
      v_raw_rent := v_raw_rent + v_raw_service;
      v_raw_service := 0;
    ELSIF v_raw_rent < 0 THEN
      v_raw_service := v_raw_service + v_raw_rent;
      v_raw_rent := 0;
    END IF;

    v_raw_rent := GREATEST(0, v_raw_rent);
    v_raw_service := GREATEST(0, v_raw_service);

    -- Khấu trừ tiền đã nộp (ưu tiên RENT trước)
    v_paid_to_rent := LEAST(v_paid, v_raw_rent);
    v_rent_unpaid := GREATEST(0, v_raw_rent - v_paid_to_rent);
    v_service_unpaid := GREATEST(0, v_raw_service - (v_paid - v_paid_to_rent));

    v_rent_unpaid := LEAST(v_rent_unpaid, v_rem);
    v_service_unpaid := LEAST(v_service_unpaid, v_rem - v_rent_unpaid);

    INSERT INTO tmp_settlement_invoices (
      id, invoice_code, period, total_amount, paid_amount, credit_offset_amount, status, rent_unpaid, service_unpaid
    )
    VALUES (
      v_inv.id, v_inv.invoice_code, v_inv.period, v_inv.total_amount, v_inv.paid_amount,
      COALESCE(v_inv.credit_offset_amount, 0), v_inv.status, v_rent_unpaid, v_service_unpaid
    );
  END LOOP;

  -- LƯỢT 1: credit_balance -> toàn bộ nợ RENT
  FOR v_cb IN
    SELECT cb.id, (cb.amount - cb.applied_amount) AS available_amt
    FROM credit_balance cb
    WHERE cb.contract_id = v_dep.contract_id
      AND cb.status IN ('AVAILABLE', 'PARTIALLY_APPLIED')
      AND (cb.amount - cb.applied_amount) > 0
    ORDER BY cb.created_at ASC
    FOR UPDATE OF cb
  LOOP
    FOR v_inv IN
      SELECT * FROM tmp_settlement_invoices
      WHERE rent_unpaid > 0
      ORDER BY period ASC
    LOOP
      EXIT WHEN v_cb.available_amt <= 0;
      v_apply := LEAST(v_cb.available_amt, v_inv.rent_unpaid);

      IF v_apply > 0 THEN
        v_cb.available_amt := v_cb.available_amt - v_apply;
        UPDATE tmp_settlement_invoices
        SET rent_unpaid = rent_unpaid - v_apply,
            paid_amount = paid_amount + v_apply,
            credit_offset_amount = credit_offset_amount + v_apply
        WHERE id = v_inv.id;

        UPDATE credit_balance
        SET applied_amount = applied_amount + v_apply,
            status = CASE WHEN (applied_amount + v_apply) >= amount THEN 'APPLIED' ELSE 'PARTIALLY_APPLIED' END,
            updated_at = NOW()
        WHERE id = v_cb.id;
      END IF;
    END LOOP;
  END LOOP;

  -- LƯỢT 2: credit_balance -> toàn bộ nợ SERVICE
  FOR v_cb IN
    SELECT cb.id, (cb.amount - cb.applied_amount) AS available_amt
    FROM credit_balance cb
    WHERE cb.contract_id = v_dep.contract_id
      AND cb.status IN ('AVAILABLE', 'PARTIALLY_APPLIED')
      AND (cb.amount - cb.applied_amount) > 0
    ORDER BY cb.created_at ASC
    FOR UPDATE OF cb
  LOOP
    FOR v_inv IN
      SELECT * FROM tmp_settlement_invoices
      WHERE service_unpaid > 0
      ORDER BY period ASC
    LOOP
      EXIT WHEN v_cb.available_amt <= 0;
      v_apply := LEAST(v_cb.available_amt, v_inv.service_unpaid);

      IF v_apply > 0 THEN
        v_cb.available_amt := v_cb.available_amt - v_apply;
        UPDATE tmp_settlement_invoices
        SET service_unpaid = service_unpaid - v_apply,
            paid_amount = paid_amount + v_apply,
            credit_offset_amount = credit_offset_amount + v_apply
        WHERE id = v_inv.id;

        UPDATE credit_balance
        SET applied_amount = applied_amount + v_apply,
            status = CASE WHEN (applied_amount + v_apply) >= amount THEN 'APPLIED' ELSE 'PARTIALLY_APPLIED' END,
            updated_at = NOW()
        WHERE id = v_cb.id;
      END IF;
    END LOOP;
  END LOOP;

  -- LƯỢT 3: credit_balance còn dư -> kết chuyển quyết toán cọc
  UPDATE credit_balance
  SET settlement_deposit_id = p_deposit_id,
      settlement_refund_amount = (amount - applied_amount),
      applied_amount = amount,
      status = 'REFUNDED_IN_SETTLEMENT',
      refunded_at = NOW(),
      updated_at = NOW()
  WHERE contract_id = v_dep.contract_id
    AND status IN ('AVAILABLE', 'PARTIALLY_APPLIED');

  -- LƯỢT 4: tiền cọc gốc (p_covered_service_debt) -> nợ SERVICE còn lại sau Lượt 2
  FOR v_inv IN
    SELECT * FROM tmp_settlement_invoices
    WHERE service_unpaid > 0
    ORDER BY period ASC
  LOOP
    EXIT WHEN v_remaining_dep_cover <= 0;
    v_apply := LEAST(v_remaining_dep_cover, v_inv.service_unpaid);

    IF v_apply > 0 THEN
      v_remaining_dep_cover := v_remaining_dep_cover - v_apply;
      UPDATE tmp_settlement_invoices
      SET service_unpaid = service_unpaid - v_apply,
          paid_amount = paid_amount + v_apply
      WHERE id = v_inv.id;
    END IF;
  END LOOP;

  -- ÁP DỤNG KẾT QUẢ CUỐI CÙNG LÊN invoice & receivable
  FOR v_inv IN SELECT * FROM tmp_settlement_invoices LOOP
    v_new_status := CASE
      WHEN v_inv.paid_amount >= v_inv.total_amount THEN 'PAID'
      WHEN v_inv.paid_amount > 0 THEN 'PARTIALLY_PAID'
      ELSE v_inv.status
    END;

    UPDATE invoice
    SET paid_amount = v_inv.paid_amount,
        credit_offset_amount = v_inv.credit_offset_amount,
        status = v_new_status,
        updated_at = NOW()
    WHERE id = v_inv.id;

    v_still_unpaid := GREATEST(0, v_inv.total_amount - v_inv.paid_amount);

    IF v_still_unpaid = 0 THEN
      UPDATE receivable
      SET paid_amount = amount,
          status = 'PAID',
          deposit_id = COALESCE(deposit_id, p_deposit_id),
          updated_at = NOW()
      WHERE invoice_id = v_inv.id
        AND status IN ('OPEN', 'PARTIALLY_PAID');
    ELSE
      UPDATE receivable
      SET amount = GREATEST(paid_amount, v_inv.total_amount),
          paid_amount = LEAST(GREATEST(paid_amount, v_inv.total_amount), v_inv.paid_amount),
          status = CASE WHEN v_inv.paid_amount > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
          type = 'RECEIVABLE_AFTER_MOVE_OUT',
          deposit_id = COALESCE(deposit_id, p_deposit_id),
          updated_at = NOW()
      WHERE invoice_id = v_inv.id
        AND status IN ('OPEN', 'PARTIALLY_PAID');

      IF NOT FOUND THEN
        INSERT INTO receivable (
          org_id,
          building_id,
          contract_id,
          tenant_id,
          invoice_id,
          deposit_id,
          type,
          amount,
          paid_amount,
          due_date,
          status,
          description
        )
        VALUES (
          v_dep.org_id,
          v_dep.building_id,
          v_dep.contract_id,
          v_dep.primary_tenant_id,
          v_inv.id,
          p_deposit_id,
          'RECEIVABLE_AFTER_MOVE_OUT',
          v_inv.total_amount,
          v_inv.paid_amount,
          CURRENT_DATE + 7,
          CASE WHEN v_inv.paid_amount > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
          format('Công nợ hóa đơn %s còn tồn đọng sau trả phòng', v_inv.invoice_code)
        );
      END IF;
    END IF;
  END LOOP;

  -- Xử lý công nợ vượt cọc nếu có
  IF COALESCE(p_uncovered_items_shortfall, 0) > 0 THEN
    INSERT INTO receivable (
      org_id,
      building_id,
      contract_id,
      tenant_id,
      invoice_id,
      deposit_id,
      type,
      amount,
      paid_amount,
      due_date,
      status,
      description
    )
    VALUES (
      v_dep.org_id,
      v_dep.building_id,
      v_dep.contract_id,
      v_dep.primary_tenant_id,
      NULL,
      p_deposit_id,
      'RECEIVABLE_AFTER_MOVE_OUT',
      p_uncovered_items_shortfall,
      0,
      CURRENT_DATE + 7,
      'OPEN',
      'Công nợ phát sinh sau tất toán tiền cọc vượt mức cọc đang giữ (FR-024)'
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- Function: fn_get_ops_resource_scope
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

-- Function: fn_list_building_assignees
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

-- Function: fn_notify_service_request_managers
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

-- Function: fn_get_org_monthly_ai_usage
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

-- Function: fn_record_background_ticket_triage
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

