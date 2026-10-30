-- 031_owner_readonly_and_internal_approvals.sql
-- Đồng bộ hóa phân quyền theo PRD v2.0 Mục 6.1 & 6.2 (Phương án 2):
--   1. Vai trò OWNER (Chủ sở hữu tòa nhà ủy thác vận hành) thuần túy 100% Read-Only (SELECT):
--      Gỡ toàn bộ quyền INSERT / UPDATE của is_owner() & get_owner_building_ids() trên
--      apartment, contract, contract_version, contract_request, deposit, deposit_transaction,
--      receivable, reservation và notification.
--   2. Chuẩn hóa quyền phê duyệt & vận hành nội bộ:
--      - Hợp đồng, Phụ lục, Đề nghị cư dân: MANAGER (trên tòa được gán) & SYS_ADMIN (is_org_admin()).
--      - Sổ cọc & Tất toán cọc (PRD 6.2: MANAGER = CRU, ACCOUNTANT = CRU):
--        ACCOUNTANT & MANAGER được lập/cập nhật trên tòa được gán; SYS_ADMIN & MANAGER phê duyệt Four-eyes.

-- ============================================================================
-- 1. HELPER FUNCTIONS BỔ SUNG CHO ACCOUNTANT & CẬP NHẬT BUILDING READ SCOPE
-- ============================================================================
CREATE OR REPLACE FUNCTION is_accountant()
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
    WHERE ur.user_id = v_user_id AND r.code = 'ACCOUNTANT'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE OR REPLACE FUNCTION get_accountant_building_ids()
RETURNS TABLE (building_id UUID) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.user_id = v_user_id
      AND r.code = 'ACCOUNTANT'
      AND ur.building_id IS NULL
  ) THEN
    RETURN QUERY
    SELECT b.id
    FROM building b
    WHERE b.org_id = get_current_user_org_id();
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT ur.building_id
  FROM user_role ur
  JOIN role r ON r.id = ur.role_id
  WHERE ur.user_id = v_user_id
    AND r.code = 'ACCOUNTANT'
    AND ur.building_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE OR REPLACE FUNCTION get_staff_building_ids()
RETURNS TABLE (building_id UUID) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.user_id = v_user_id
      AND r.code IN ('STAFF', 'ACCOUNTANT')
      AND ur.building_id IS NULL
  ) THEN
    RETURN QUERY
    SELECT b.id
    FROM building b
    WHERE b.org_id = get_current_user_org_id();
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT ur.building_id
  FROM user_role ur
  JOIN role r ON r.id = ur.role_id
  WHERE ur.user_id = v_user_id
    AND r.code IN ('MANAGER', 'STAFF', 'ACCOUNTANT')
    AND ur.building_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Mở rộng tập tòa nhà được phép SELECT (chỉ dùng cho các policy SELECT) để bao gồm ACCOUNTANT & STAFF,
-- đồng thời hỗ trợ tài khoản có nhiều vai trò mà không bị RETURN sớm.
CREATE OR REPLACE FUNCTION get_user_assigned_buildings()
RETURNS TABLE (building_id UUID) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  IF is_org_admin() OR EXISTS (
    SELECT 1
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.user_id = v_user_id
      AND r.code IN ('ACCOUNTANT', 'STAFF')
      AND ur.building_id IS NULL
  ) THEN
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
    SELECT ur.building_id
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.user_id = v_user_id
      AND r.code IN ('MANAGER', 'ACCOUNTANT', 'STAFF')
      AND ur.building_id IS NOT NULL
  ) sub
  WHERE sub.building_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Cập nhật can_select_person để ACCOUNTANT / MANAGER / OWNER xem được tên nhân sự lập/duyệt cùng tòa nhà
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

  -- Xem person đang có hợp đồng chính, người ở cùng hoặc đặt cọc giữ chỗ trong tòa được gán
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

  -- Cho phép OWNER / MANAGER / ACCOUNTANT xem tên nhân sự vận hành (SYS_ADMIN, MANAGER, ACCOUNTANT) thuộc đúng tòa mình
  IF (is_owner() OR is_manager() OR is_accountant()) AND p_org_id = v_user_org_id AND (
    EXISTS (
      SELECT 1 FROM app_user au
      JOIN user_role ur ON ur.user_id = au.id
      JOIN role rl ON rl.id = ur.role_id
      WHERE au.person_id = p_id
        AND (
          rl.code = 'SYS_ADMIN'
          OR (
            rl.code IN ('MANAGER', 'ACCOUNTANT')
            AND ur.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
          )
        )
    )
    OR (
      is_manager() AND EXISTS (
        SELECT 1 FROM owner o
        JOIN building b ON b.owner_id = o.id
        WHERE o.person_id = p_id
          AND b.id IN (SELECT building_id FROM get_manager_building_ids())
      )
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

  -- MANAGER chỉ xem được hồ sơ chưa lên hợp đồng do chính mình tạo và chưa gắn với tòa khác
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

-- ============================================================================
-- 2. GỠ QUYỀN GHI CỦA OWNER TRÊN APARTMENT & RESERVATION (CHỈ SYS_ADMIN + MANAGER)
-- ============================================================================
DROP POLICY IF EXISTS rls_apartment_update ON apartment;
CREATE POLICY rls_apartment_update ON apartment FOR UPDATE
  USING (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  WITH CHECK (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_reservation_update ON reservation;
CREATE POLICY rls_reservation_update ON reservation FOR UPDATE
  USING (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  WITH CHECK (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

-- ============================================================================
-- 3. HỢP ĐỒNG, PHỤ LỤC & ĐỀ NGHỊ CƯ DÂN: GỠ OWNER, CẤP SYS_ADMIN + MANAGER
-- ============================================================================
DROP POLICY IF EXISTS rls_contract_insert ON contract;
CREATE POLICY rls_contract_insert ON contract FOR INSERT
  WITH CHECK (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_contract_update ON contract;
CREATE POLICY rls_contract_update ON contract FOR UPDATE
  USING (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  WITH CHECK (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_contract_version_insert ON contract_version;
CREATE POLICY rls_contract_version_insert ON contract_version FOR INSERT
  WITH CHECK (
    is_org_admin()
    OR contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_contract_version_update ON contract_version;
CREATE POLICY rls_contract_version_update ON contract_version FOR UPDATE
  USING (
    is_org_admin()
    OR (
      is_manager()
      AND contract_id IN (
        SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
      )
    )
  )
  WITH CHECK (
    is_org_admin()
    OR (
      is_manager()
      AND contract_id IN (
        SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
      )
    )
  );

DROP POLICY IF EXISTS rls_contract_request_insert ON contract_request;
CREATE POLICY rls_contract_request_insert ON contract_request FOR INSERT
  WITH CHECK (
    created_by = get_current_user_id()
    OR is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_contract_request_update ON contract_request;
CREATE POLICY rls_contract_request_update ON contract_request FOR UPDATE
  USING (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  WITH CHECK (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

-- ============================================================================
-- 4. TIỀN CỌC & CÔNG NỢ: GỠ OWNER, CẤP SYS_ADMIN + MANAGER + ACCOUNTANT (PRD 6.2)
-- ============================================================================
DROP POLICY IF EXISTS rls_deposit_insert ON deposit;
CREATE POLICY rls_deposit_insert ON deposit FOR INSERT
  WITH CHECK (
    is_org_admin()
    OR contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR building_id IN (SELECT building_id FROM get_accountant_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_deposit_update ON deposit;
CREATE POLICY rls_deposit_update ON deposit FOR UPDATE
  USING (
    is_org_admin()
    OR contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR building_id IN (SELECT building_id FROM get_accountant_building_ids())
    )
  )
  WITH CHECK (
    is_org_admin()
    OR contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR building_id IN (SELECT building_id FROM get_accountant_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_deposit_txn_insert ON deposit_transaction;
CREATE POLICY rls_deposit_txn_insert ON deposit_transaction FOR INSERT
  WITH CHECK (
    is_org_admin()
    OR deposit_id IN (
      SELECT d.id FROM deposit d
      JOIN contract c ON c.id = d.contract_id
      WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR c.building_id IN (SELECT building_id FROM get_accountant_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_deposit_txn_update ON deposit_transaction;
CREATE POLICY rls_deposit_txn_update ON deposit_transaction FOR UPDATE
  USING (
    is_org_admin()
    OR deposit_id IN (
      SELECT d.id FROM deposit d
      JOIN contract c ON c.id = d.contract_id
      WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR c.building_id IN (SELECT building_id FROM get_accountant_building_ids())
    )
  )
  WITH CHECK (
    is_org_admin()
    OR deposit_id IN (
      SELECT d.id FROM deposit d
      JOIN contract c ON c.id = d.contract_id
      WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
         OR c.building_id IN (SELECT building_id FROM get_accountant_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_receivable_modify ON receivable;
CREATE POLICY rls_receivable_modify ON receivable FOR ALL
  USING (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR building_id IN (SELECT building_id FROM get_accountant_building_ids())
  )
  WITH CHECK (
    is_org_admin()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR building_id IN (SELECT building_id FROM get_accountant_building_ids())
  );

-- ============================================================================
-- 5. NOTIFICATION: GỠ QUYỀN GỬI THÔNG BÁO CỦA OWNER (PRD 6.2: OWNER = R)
-- ============================================================================
DROP POLICY IF EXISTS rls_notification_insert ON notification;
CREATE POLICY rls_notification_insert ON notification FOR INSERT
  WITH CHECK (
    is_org_admin()
    OR (
      (is_manager() OR is_accountant())
      AND org_id = get_current_user_org_id()
      AND user_id IS NOT NULL
    )
    OR (
      user_id = get_current_user_id()
      AND org_id = get_current_user_org_id()
    )
  );

