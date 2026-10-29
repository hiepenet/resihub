-- 022_prd_rbac_alignment.sql
-- Chuẩn hóa toàn diện Row Level Security (RLS) khớp 100% PRD v2.0 (v0.2)
-- Khắc phục lỗi hồi quy từ 021_owner_building_scope.sql (làm mất quyền MANAGER trên person/tenant),
-- chống đệ quy chéo giữa person ↔ tenant ↔ app_user bằng hàm SECURITY DEFINER SET row_security = off,
-- và siết chặt quyền ghi (INSERT/UPDATE/DELETE) theo đúng Ma trận RBAC Mục 6.2 & NFR-008.

-- ============================================================================
-- 1. HELPER FUNCTIONS (SECURITY DEFINER + SET row_security = off)
-- ============================================================================

-- 1.1 SYS_ADMIN duy nhất có quyền quản trị cấp tổ chức (is_org_admin)
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

-- 1.2 Kiểm tra vai trò OWNER
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

-- 1.3 Kiểm tra vai trò MANAGER
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

-- 1.4 Danh sách tòa nhà do OWNER sở hữu (qua owner.person_id)
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

-- 1.5 Danh sách tòa nhà được phân công cho MANAGER (qua user_role.building_id)
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

-- 1.6 Tập hợp tòa nhà người dùng được phép XEM (SELECT) theo vai trò
CREATE OR REPLACE FUNCTION get_user_assigned_buildings()
RETURNS TABLE (building_id UUID) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- SYS_ADMIN: Toàn bộ tòa thuộc org
  IF is_org_admin() THEN
    RETURN QUERY
    SELECT b.id
    FROM building b
    WHERE b.org_id = get_current_user_org_id();
    RETURN;
  END IF;

  -- OWNER: Chỉ các tòa mình sở hữu
  IF is_owner() THEN
    RETURN QUERY
    SELECT gb.building_id FROM get_owner_building_ids() gb;
    RETURN;
  END IF;

  -- MANAGER: Chỉ các tòa được gán cụ thể trong user_role
  IF is_manager() THEN
    RETURN QUERY
    SELECT mb.building_id FROM get_manager_building_ids() mb;
    RETURN;
  END IF;

  RETURN;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- 1.7 Hàm kiểm tra quyền SELECT trên bảng person (chống đệ quy person ↔ tenant ↔ app_user)
CREATE OR REPLACE FUNCTION can_select_person(p_id UUID, p_org_id UUID, p_phone TEXT)
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

  -- Cho phép OWNER / MANAGER xem tên/email nhân sự quản trị (OWNER/MANAGER/SYS_ADMIN) cùng org khi hiển thị người duyệt
  IF (is_owner() OR is_manager()) AND p_org_id = v_user_org_id AND EXISTS (
    SELECT 1 FROM app_user au
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role rl ON rl.id = ur.role_id
    WHERE au.person_id = p_id
      AND rl.code IN ('OWNER', 'MANAGER', 'SYS_ADMIN')
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

  -- MANAGER xem hồ sơ chưa gắn hợp đồng ở tòa khác để kiểm tra trùng SĐT/CCCD & lập hợp đồng mới (FR-021)
  IF is_manager() AND p_org_id = v_user_org_id AND NOT EXISTS (
    SELECT 1 FROM contract c_other
    JOIN tenant t_other ON t_other.id = c_other.primary_tenant_id
    WHERE t_other.person_id = p_id
      AND c_other.building_id NOT IN (SELECT building_id FROM get_manager_building_ids())
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- 1.8 Hàm kiểm tra quyền SELECT trên bảng tenant (chống đệ quy tenant ↔ person)
CREATE OR REPLACE FUNCTION can_select_tenant(t_id UUID, t_person_id UUID, t_org_id UUID)
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

  IF t_id IN (SELECT tenant_id FROM get_resident_tenant_ids()) THEN
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

  IF is_manager() AND t_org_id = get_current_user_org_id() AND NOT EXISTS (
    SELECT 1 FROM contract c_other
    WHERE c_other.primary_tenant_id = t_id
      AND c_other.building_id NOT IN (SELECT building_id FROM get_manager_building_ids())
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- 1.9 Hàm kiểm tra quyền SELECT trên app_user (chống đệ quy app_user ↔ person)
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

-- 1.10 Hàm kiểm tra quyền SELECT trên attachment (bản scan HĐ + ảnh CCCD)
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
      RETURN EXISTS (
        SELECT 1 FROM person p
        WHERE p.id = p_owner_id
          AND can_select_person(p.id, p.org_id, p.phone)
      );
    ELSIF p_owner_entity = 'tenant' THEN
      RETURN EXISTS (
        SELECT 1 FROM tenant t
        WHERE t.id = p_owner_id
          AND can_select_tenant(t.id, t.person_id, t.org_id)
      );
    ELSIF p_owner_entity = 'deposit' THEN
      RETURN EXISTS (
        SELECT 1 FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        WHERE d.id = p_owner_id
          AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'apartment' THEN
      RETURN EXISTS (
        SELECT 1 FROM apartment a
        WHERE a.id = p_owner_id
          AND a.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
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
    END IF;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- ============================================================================
-- 2. BẤT ĐỘNG SẢN: BUILDING, FLOOR, ZONE, APARTMENT
--    PRD 6.2: SYS_ADMIN = CRUD | MANAGER = CRU (tòa được gán; building không C/D) | OWNER = R | RESIDENT = R (của mình)
-- ============================================================================

-- 2a. BUILDING
DROP POLICY IF EXISTS rls_building_select ON building;
DROP POLICY IF EXISTS rls_building_modify ON building;
DROP POLICY IF EXISTS rls_building_insert ON building;
DROP POLICY IF EXISTS rls_building_update ON building;
DROP POLICY IF EXISTS rls_building_delete ON building;

CREATE POLICY rls_building_select ON building FOR SELECT USING (
  is_org_admin()
  OR id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR id IN (
    SELECT c.building_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
  OR id IN (
    SELECT rsv.building_id FROM reservation rsv
    WHERE rsv.phone = get_current_user_phone()
  )
);

CREATE POLICY rls_building_insert ON building FOR INSERT
  WITH CHECK (is_org_admin());

CREATE POLICY rls_building_update ON building FOR UPDATE
  USING (is_org_admin() OR id IN (SELECT building_id FROM get_manager_building_ids()))
  WITH CHECK (is_org_admin() OR id IN (SELECT building_id FROM get_manager_building_ids()));

CREATE POLICY rls_building_delete ON building FOR DELETE
  USING (is_org_admin());

-- 2b. FLOOR
DROP POLICY IF EXISTS rls_floor_select ON floor;
DROP POLICY IF EXISTS rls_floor_modify ON floor;
DROP POLICY IF EXISTS rls_floor_insert ON floor;
DROP POLICY IF EXISTS rls_floor_update ON floor;
DROP POLICY IF EXISTS rls_floor_delete ON floor;

CREATE POLICY rls_floor_select ON floor FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (
    SELECT c.building_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
  OR building_id IN (
    SELECT rsv.building_id FROM reservation rsv
    WHERE rsv.phone = get_current_user_phone()
  )
);

CREATE POLICY rls_floor_insert ON floor FOR INSERT
  WITH CHECK (is_org_admin() OR building_id IN (SELECT building_id FROM get_manager_building_ids()));

CREATE POLICY rls_floor_update ON floor FOR UPDATE
  USING (is_org_admin() OR building_id IN (SELECT building_id FROM get_manager_building_ids()))
  WITH CHECK (is_org_admin() OR building_id IN (SELECT building_id FROM get_manager_building_ids()));

CREATE POLICY rls_floor_delete ON floor FOR DELETE
  USING (is_org_admin());

-- 2c. ZONE
DROP POLICY IF EXISTS rls_zone_select ON zone;
DROP POLICY IF EXISTS rls_zone_insert ON zone;
DROP POLICY IF EXISTS rls_zone_update ON zone;
DROP POLICY IF EXISTS rls_zone_delete ON zone;

CREATE POLICY rls_zone_select ON zone FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (
    SELECT c.building_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
);

CREATE POLICY rls_zone_insert ON zone FOR INSERT
  WITH CHECK (is_org_admin() OR building_id IN (SELECT building_id FROM get_manager_building_ids()));

CREATE POLICY rls_zone_update ON zone FOR UPDATE
  USING (is_org_admin() OR building_id IN (SELECT building_id FROM get_manager_building_ids()))
  WITH CHECK (is_org_admin() OR building_id IN (SELECT building_id FROM get_manager_building_ids()));

CREATE POLICY rls_zone_delete ON zone FOR DELETE
  USING (is_org_admin());

-- 2d. APARTMENT
DROP POLICY IF EXISTS rls_apartment_select ON apartment;
DROP POLICY IF EXISTS rls_apartment_modify ON apartment;
DROP POLICY IF EXISTS rls_apartment_insert ON apartment;
DROP POLICY IF EXISTS rls_apartment_update ON apartment;
DROP POLICY IF EXISTS rls_apartment_delete ON apartment;

CREATE POLICY rls_apartment_select ON apartment FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR id IN (
    SELECT c.apartment_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
  OR id IN (
    SELECT rsv.apartment_id FROM reservation rsv
    WHERE rsv.phone = get_current_user_phone()
  )
);

CREATE POLICY rls_apartment_insert ON apartment FOR INSERT
  WITH CHECK (is_org_admin() OR building_id IN (SELECT building_id FROM get_manager_building_ids()));

CREATE POLICY rls_apartment_update ON apartment FOR UPDATE
  USING (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (
      -- Cho phép cập nhật trạng thái tự động khi OWNER phê duyệt kích hoạt/chấm dứt hợp đồng trên tòa sở hữu
      is_owner()
      AND building_id IN (SELECT building_id FROM get_owner_building_ids())
      AND EXISTS (
        SELECT 1 FROM contract c
        WHERE c.apartment_id = apartment.id
          AND c.status IN ('PENDING_APPROVAL', 'ACTIVE', 'TERMINATION_PENDING', 'TERMINATED')
      )
    )
  )
  WITH CHECK (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (
      is_owner()
      AND building_id IN (SELECT building_id FROM get_owner_building_ids())
    )
  );

CREATE POLICY rls_apartment_delete ON apartment FOR DELETE
  USING (is_org_admin());

-- ============================================================================
-- 3. CƯ DÂN & HỒ SƠ: PERSON, TENANT
-- ============================================================================

DROP POLICY IF EXISTS rls_person_select ON person;
DROP POLICY IF EXISTS rls_person_modify ON person;
DROP POLICY IF EXISTS rls_person_insert ON person;
DROP POLICY IF EXISTS rls_person_update ON person;
DROP POLICY IF EXISTS rls_person_delete ON person;

CREATE POLICY rls_person_select ON person FOR SELECT
  USING (can_select_person(person.id, person.org_id, person.phone));

CREATE POLICY rls_person_insert ON person FOR INSERT
  WITH CHECK (
    is_org_admin()
    OR (is_manager() AND person.org_id = get_current_user_org_id())
  );

CREATE POLICY rls_person_update ON person FOR UPDATE
  USING (
    is_org_admin()
    OR person.id = get_current_user_person_id()
    OR (is_manager() AND person.org_id = get_current_user_org_id())
  )
  WITH CHECK (
    is_org_admin()
    OR person.id = get_current_user_person_id()
    OR (is_manager() AND person.org_id = get_current_user_org_id())
  );

CREATE POLICY rls_person_delete ON person FOR DELETE
  USING (is_org_admin());

DROP POLICY IF EXISTS rls_tenant_select ON tenant;
DROP POLICY IF EXISTS rls_tenant_modify ON tenant;
DROP POLICY IF EXISTS rls_tenant_insert ON tenant;
DROP POLICY IF EXISTS rls_tenant_update ON tenant;
DROP POLICY IF EXISTS rls_tenant_delete ON tenant;

CREATE POLICY rls_tenant_select ON tenant FOR SELECT
  USING (can_select_tenant(tenant.id, tenant.person_id, tenant.org_id));

CREATE POLICY rls_tenant_insert ON tenant FOR INSERT
  WITH CHECK (
    is_org_admin()
    OR (is_manager() AND tenant.org_id = get_current_user_org_id())
    OR (tenant.org_id = get_current_user_org_id() AND tenant.person_id = get_current_user_person_id())
  );

CREATE POLICY rls_tenant_update ON tenant FOR UPDATE
  USING (
    is_org_admin()
    OR (is_manager() AND tenant.org_id = get_current_user_org_id())
    OR tenant.id IN (SELECT tenant_id FROM get_resident_tenant_ids())
  )
  WITH CHECK (
    is_org_admin()
    OR (is_manager() AND tenant.org_id = get_current_user_org_id())
    OR tenant.id IN (SELECT tenant_id FROM get_resident_tenant_ids())
  );

CREATE POLICY rls_tenant_delete ON tenant FOR DELETE
  USING (is_org_admin());

-- ============================================================================
-- 4. HỢP ĐỒNG: CONTRACT, CONTRACT_VERSION, CONTRACT_OCCUPANT, CONTRACT_SERVICE_PRICE
-- ============================================================================

DROP POLICY IF EXISTS rls_contract_select ON contract;
DROP POLICY IF EXISTS rls_contract_modify ON contract;
DROP POLICY IF EXISTS rls_contract_insert ON contract;
DROP POLICY IF EXISTS rls_contract_update ON contract;
DROP POLICY IF EXISTS rls_contract_delete ON contract;

CREATE POLICY rls_contract_select ON contract FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR id IN (SELECT contract_id FROM get_resident_contract_ids())
);

CREATE POLICY rls_contract_insert ON contract FOR INSERT
  WITH CHECK (building_id IN (SELECT building_id FROM get_manager_building_ids()));

CREATE POLICY rls_contract_update ON contract FOR UPDATE
  USING (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (is_owner() AND building_id IN (SELECT building_id FROM get_owner_building_ids()))
  )
  WITH CHECK (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (is_owner() AND building_id IN (SELECT building_id FROM get_owner_building_ids()))
  );

CREATE POLICY rls_contract_delete ON contract FOR DELETE
  USING (is_org_admin());

DROP POLICY IF EXISTS rls_contract_version_select ON contract_version;
DROP POLICY IF EXISTS rls_contract_version_modify ON contract_version;
DROP POLICY IF EXISTS rls_contract_version_insert ON contract_version;
DROP POLICY IF EXISTS rls_contract_version_update ON contract_version;
DROP POLICY IF EXISTS rls_contract_version_delete ON contract_version;

CREATE POLICY rls_contract_version_select ON contract_version FOR SELECT USING (
  is_org_admin()
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

CREATE POLICY rls_contract_version_insert ON contract_version FOR INSERT
  WITH CHECK (
    contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

CREATE POLICY rls_contract_version_update ON contract_version FOR UPDATE
  USING (
    contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
    )
    AND (is_manager() OR is_owner())
  )
  WITH CHECK (
    contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
    )
    AND (is_manager() OR is_owner())
  );

DROP POLICY IF EXISTS rls_contract_occupant_modify ON contract_occupant;
CREATE POLICY rls_contract_occupant_modify ON contract_occupant FOR ALL
  USING (
    is_org_admin()
    OR contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  )
  WITH CHECK (
    is_org_admin()
    OR contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_contract_service_price_modify ON contract_service_price;
CREATE POLICY rls_contract_service_price_modify ON contract_service_price FOR ALL
  USING (
    is_org_admin()
    OR contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  )
  WITH CHECK (
    is_org_admin()
    OR contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

-- ============================================================================
-- 5. TIỀN CỌC & ĐẶT CỌC GIỮ CHỖ: DEPOSIT, DEPOSIT_TRANSACTION, RESERVATION
-- ============================================================================

DROP POLICY IF EXISTS rls_deposit_select ON deposit;
DROP POLICY IF EXISTS rls_deposit_modify ON deposit;
DROP POLICY IF EXISTS rls_deposit_insert ON deposit;
DROP POLICY IF EXISTS rls_deposit_update ON deposit;
DROP POLICY IF EXISTS rls_deposit_delete ON deposit;

CREATE POLICY rls_deposit_select ON deposit FOR SELECT USING (
  is_org_admin()
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

CREATE POLICY rls_deposit_insert ON deposit FOR INSERT
  WITH CHECK (
    contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR (is_owner() AND building_id IN (SELECT building_id FROM get_owner_building_ids()))
    )
  );

CREATE POLICY rls_deposit_update ON deposit FOR UPDATE
  USING (
    contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR (is_owner() AND building_id IN (SELECT building_id FROM get_owner_building_ids()))
    )
  )
  WITH CHECK (
    contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR (is_owner() AND building_id IN (SELECT building_id FROM get_owner_building_ids()))
    )
  );

CREATE POLICY rls_deposit_delete ON deposit FOR DELETE
  USING (is_org_admin());

DROP POLICY IF EXISTS rls_deposit_txn_select ON deposit_transaction;
DROP POLICY IF EXISTS rls_deposit_txn_modify ON deposit_transaction;
DROP POLICY IF EXISTS rls_deposit_txn_insert ON deposit_transaction;
DROP POLICY IF EXISTS rls_deposit_txn_update ON deposit_transaction;
DROP POLICY IF EXISTS rls_deposit_txn_delete ON deposit_transaction;

CREATE POLICY rls_deposit_txn_select ON deposit_transaction FOR SELECT USING (
  is_org_admin()
  OR deposit_id IN (SELECT id FROM deposit)
);

CREATE POLICY rls_deposit_txn_insert ON deposit_transaction FOR INSERT
  WITH CHECK (
    deposit_id IN (
      SELECT d.id FROM deposit d
      JOIN contract c ON c.id = d.contract_id
      WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR (is_owner() AND c.building_id IN (SELECT building_id FROM get_owner_building_ids()))
    )
  );

CREATE POLICY rls_deposit_txn_update ON deposit_transaction FOR UPDATE
  USING (
    deposit_id IN (
      SELECT d.id FROM deposit d
      JOIN contract c ON c.id = d.contract_id
      WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR (is_owner() AND c.building_id IN (SELECT building_id FROM get_owner_building_ids()))
    )
  )
  WITH CHECK (
    deposit_id IN (
      SELECT d.id FROM deposit d
      JOIN contract c ON c.id = d.contract_id
      WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR (is_owner() AND c.building_id IN (SELECT building_id FROM get_owner_building_ids()))
    )
  );

DROP POLICY IF EXISTS rls_reservation_select ON reservation;
DROP POLICY IF EXISTS rls_reservation_modify ON reservation;
DROP POLICY IF EXISTS rls_reservation_insert ON reservation;
DROP POLICY IF EXISTS rls_reservation_update ON reservation;
DROP POLICY IF EXISTS rls_reservation_delete ON reservation;

CREATE POLICY rls_reservation_select ON reservation FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR phone = get_current_user_phone()
);

CREATE POLICY rls_reservation_insert ON reservation FOR INSERT
  WITH CHECK (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR phone = get_current_user_phone()
  );

CREATE POLICY rls_reservation_update ON reservation FOR UPDATE
  USING (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (
      is_owner()
      AND building_id IN (SELECT building_id FROM get_owner_building_ids())
      AND EXISTS (
        SELECT 1 FROM contract c
        WHERE c.apartment_id = reservation.apartment_id
          AND c.status IN ('PENDING_APPROVAL', 'ACTIVE')
      )
    )
  )
  WITH CHECK (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (
      is_owner()
      AND building_id IN (SELECT building_id FROM get_owner_building_ids())
    )
  );

CREATE POLICY rls_reservation_delete ON reservation FOR DELETE
  USING (is_org_admin());

-- ============================================================================
-- 6. ATTACHMENT, APP_USER, USER_ROLE, NOTIFICATION, AUDIT_LOG
-- ============================================================================

ALTER TABLE attachment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_attachment_select ON attachment;
CREATE POLICY rls_attachment_select ON attachment FOR SELECT
  USING (can_select_attachment(owner_entity, owner_id, uploaded_by));

DROP POLICY IF EXISTS rls_app_user_select ON app_user;
DROP POLICY IF EXISTS rls_app_user_insert ON app_user;
DROP POLICY IF EXISTS rls_app_user_update ON app_user;
DROP POLICY IF EXISTS rls_app_user_delete ON app_user;

CREATE POLICY rls_app_user_select ON app_user FOR SELECT
  USING (can_select_app_user(id, person_id));

CREATE POLICY rls_app_user_insert ON app_user FOR INSERT
  WITH CHECK (is_org_admin());

CREATE POLICY rls_app_user_update ON app_user FOR UPDATE
  USING (is_org_admin() OR id = get_current_user_id())
  WITH CHECK (is_org_admin() OR id = get_current_user_id());

CREATE POLICY rls_app_user_delete ON app_user FOR DELETE
  USING (is_org_admin());

DROP POLICY IF EXISTS rls_user_role_select ON user_role;
DROP POLICY IF EXISTS rls_user_role_insert ON user_role;
DROP POLICY IF EXISTS rls_user_role_update ON user_role;
DROP POLICY IF EXISTS rls_user_role_delete ON user_role;

CREATE POLICY rls_user_role_select ON user_role FOR SELECT USING (
  is_org_admin()
  OR user_id = get_current_user_id()
  OR user_id IN (SELECT manager_user_id FROM get_resident_manager_user_ids(get_current_user_id()))
);

CREATE POLICY rls_user_role_insert ON user_role FOR INSERT
  WITH CHECK (
    is_org_admin()
    OR (
      is_manager()
      AND role_id IN (SELECT id FROM role WHERE code = 'RESIDENT')
      AND user_id != get_current_user_id()
    )
  );

CREATE POLICY rls_user_role_update ON user_role FOR UPDATE
  USING (is_org_admin())
  WITH CHECK (is_org_admin());

CREATE POLICY rls_user_role_delete ON user_role FOR DELETE
  USING (is_org_admin());

DROP POLICY IF EXISTS rls_notification_insert ON notification;
CREATE POLICY rls_notification_insert ON notification FOR INSERT
  WITH CHECK (
    is_org_admin()
    OR is_owner()
    OR is_manager()
    OR user_id = get_current_user_id()
    OR user_id IS NULL
  );

DROP POLICY IF EXISTS rls_audit_log_select ON audit_log;
CREATE POLICY rls_audit_log_select ON audit_log FOR SELECT USING (
  is_org_admin()
  OR actor_id = get_current_user_id()
  OR (
    is_owner()
    AND (
      (entity = 'building' AND entity_id IN (SELECT building_id FROM get_owner_building_ids()))
      OR (entity = 'contract' AND entity_id IN (
        SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())
      ))
      OR (entity = 'deposit' AND entity_id IN (
        SELECT d.id FROM deposit d JOIN contract c ON c.id = d.contract_id
        WHERE c.building_id IN (SELECT building_id FROM get_owner_building_ids())
      ))
    )
  )
);
