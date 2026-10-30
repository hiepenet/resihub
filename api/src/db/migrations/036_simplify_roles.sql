-- 036_simplify_roles.sql
-- 1. Giản lược 2 vai trò ACCOUNTANT & STAFF -> Hệ thống chuẩn hóa còn 4 vai trò:
--    SYS_ADMIN, OWNER, MANAGER, RESIDENT (mọi nghiệp vụ kế toán/kỹ thuật tòa nhà gộp về MANAGER).
-- 2. Mở rộng CHECK constraint cho invoice_line ('LATE_FEE') và payment ('E_WALLET', 'QR_CODE').
-- 3. Khởi tạo cấu hình approval_config (allow_self_approval = false) trong system_setting.
-- 4. Mở rộng rls_audit_log_select cho OWNER theo phạm vi tòa nhà sở hữu.

BEGIN;

-- ============================================================================
-- 1. CHUYỂN ĐỔI DỮ LIỆU USER_ROLE & XÓA ROLE ACCOUNTANT / STAFF
-- ============================================================================

-- 1a. Với nhân sự ACCOUNTANT / STAFF trước đây gán toàn tổ chức (building_id IS NULL),
--     gán quyền MANAGER trên toàn bộ tòa nhà hiện có thuộc cùng org_id
INSERT INTO user_role (user_id, role_id, building_id)
SELECT DISTINCT
  ur.user_id,
  r_mgr.id,
  b.id
FROM user_role ur
JOIN role r_old ON r_old.id = ur.role_id
JOIN app_user au ON au.id = ur.user_id
JOIN person p ON p.id = au.person_id
JOIN role r_mgr ON r_mgr.org_id = p.org_id AND r_mgr.code = 'MANAGER'
JOIN building b ON b.org_id = p.org_id
WHERE r_old.code IN ('ACCOUNTANT', 'STAFF')
  AND ur.building_id IS NULL
ON CONFLICT (user_id, role_id, building_id) DO NOTHING;

-- 1b. Với nhân sự ACCOUNTANT / STAFF gán theo tòa cụ thể (building_id IS NOT NULL),
--     chuyển sang vai trò MANAGER trên đúng tòa nhà đó
INSERT INTO user_role (user_id, role_id, building_id)
SELECT DISTINCT
  ur.user_id,
  r_mgr.id,
  ur.building_id
FROM user_role ur
JOIN role r_old ON r_old.id = ur.role_id
JOIN app_user au ON au.id = ur.user_id
JOIN person p ON p.id = au.person_id
JOIN role r_mgr ON r_mgr.org_id = p.org_id AND r_mgr.code = 'MANAGER'
WHERE r_old.code IN ('ACCOUNTANT', 'STAFF')
  AND ur.building_id IS NOT NULL
ON CONFLICT (user_id, role_id, building_id) DO NOTHING;

-- 1c. Xóa các bản ghi user_role & role của ACCOUNTANT / STAFF
DELETE FROM user_role
WHERE role_id IN (SELECT id FROM role WHERE code IN ('ACCOUNTANT', 'STAFF'));

DELETE FROM role
WHERE code IN ('ACCOUNTANT', 'STAFF');

-- ============================================================================
-- 2. ĐỒNG BỘ CÁC HÀM HELPER RLS VỀ MÔ HÌNH 4 VAI TRÒ
-- ============================================================================

CREATE OR REPLACE FUNCTION is_accountant()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE OR REPLACE FUNCTION get_accountant_building_ids()
RETURNS TABLE (building_id UUID) AS $$
BEGIN
  RETURN;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

CREATE OR REPLACE FUNCTION get_staff_building_ids()
RETURNS TABLE (building_id UUID) AS $$
BEGIN
  RETURN QUERY SELECT gb.building_id FROM get_manager_building_ids() gb;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

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

CREATE OR REPLACE FUNCTION get_non_staff_assigned_buildings()
RETURNS TABLE (building_id UUID) AS $$
BEGIN
  RETURN QUERY SELECT ub.building_id FROM get_user_assigned_buildings() ub;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

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
    JOIN apartment a ON a.id = r.apartment_id
    WHERE r.phone = p_phone
      AND a.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  ) THEN
    RETURN TRUE;
  END IF;

  IF (is_owner() OR is_manager()) AND p_org_id = v_user_org_id AND (
    EXISTS (
      SELECT 1 FROM app_user au
      JOIN user_role ur ON ur.user_id = au.id
      JOIN role rl ON rl.id = ur.role_id
      WHERE au.person_id = p_id
        AND (
          rl.code = 'SYS_ADMIN'
          OR (
            rl.code = 'MANAGER'
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

  IF EXISTS (
    SELECT 1 FROM app_user au
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role rl ON rl.id = ur.role_id
    WHERE au.person_id = p_id
      AND rl.code = 'MANAGER'
      AND ur.building_id IN (
        SELECT c.building_id FROM contract c
        WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
      )
  ) THEN
    RETURN TRUE;
  END IF;

  IF p_created_by IS NOT NULL AND p_created_by = v_user_id THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Dọn các policy cô lập riêng STAFF nếu có
DROP POLICY IF EXISTS rls_contract_staff_deny ON contract;
DROP POLICY IF EXISTS rls_deposit_staff_deny ON deposit;
DROP POLICY IF EXISTS rls_invoice_staff_deny ON invoice;
DROP POLICY IF EXISTS rls_payment_staff_deny ON payment;
DROP POLICY IF EXISTS rls_receivable_staff_deny ON receivable;

-- Gọn lại các policy từng tham chiếu is_accountant / get_accountant_building_ids
DROP POLICY IF EXISTS rls_service_catalog_modify ON service_catalog;
CREATE POLICY rls_service_catalog_modify ON service_catalog FOR ALL
  USING (is_org_admin() OR is_manager())
  WITH CHECK (is_org_admin() OR is_manager());

DROP POLICY IF EXISTS rls_contract_service_price_modify ON contract_service_price;
CREATE POLICY rls_contract_service_price_modify ON contract_service_price FOR ALL
  USING (
    is_org_admin()
    OR contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  )
  WITH CHECK (
    is_org_admin()
    OR contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

-- ============================================================================
-- 3. MỞ RỘNG CHECK CONSTRAINTS (LATE_FEE & PHƯƠNG THỨC THANH TOÁN)
-- ============================================================================
ALTER TABLE invoice_line DROP CONSTRAINT IF EXISTS invoice_line_item_type_check;
ALTER TABLE invoice_line ADD CONSTRAINT invoice_line_item_type_check
  CHECK (item_type IN ('RENT', 'ELECTRICITY', 'WATER', 'SERVICE', 'LATE_FEE', 'ADJUSTMENT', 'OTHER'));

ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_method_check;
ALTER TABLE payment ADD CONSTRAINT payment_method_check
  CHECK (method IN ('BANK_TRANSFER', 'CASH', 'CARD', 'EWALLET', 'E_WALLET', 'QR_CODE', 'OTHER'));

-- ============================================================================
-- 4. CẤU HÌNH MẶC ĐỊNH allow_self_approval CHO FOUR-EYES (R-23)
-- ============================================================================
INSERT INTO system_setting (org_id, key, value, description)
SELECT
  o.id,
  'approval_config',
  '{"allow_self_approval": false}'::jsonb,
  'Cấu hình quy tắc phê duyệt 4 mắt (Four-eyes)'
FROM organization o
ON CONFLICT (org_id, key) DO NOTHING;

-- ============================================================================
-- 5. CẬP NHẬT RLS ĐỌC AUDIT_LOG CHO SYS_ADMIN & OWNER (R-24)
-- ============================================================================
DROP POLICY IF EXISTS rls_audit_log_select ON audit_log;
CREATE POLICY rls_audit_log_select ON audit_log FOR SELECT
  USING (
    is_org_admin()
    OR actor_id = get_current_user_id()
    OR (
      is_owner() AND (
        (entity = 'building' AND entity_id IN (SELECT building_id FROM get_owner_building_ids()))
        OR (entity = 'apartment' AND entity_id IN (SELECT id FROM apartment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'contract' AND entity_id IN (SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'deposit' AND entity_id IN (SELECT d.id FROM deposit d JOIN contract c ON c.id = d.contract_id WHERE c.building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'invoice' AND entity_id IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'payment' AND entity_id IN (SELECT id FROM payment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
      )
    )
  );

COMMIT;

