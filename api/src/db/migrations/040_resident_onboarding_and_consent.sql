-- 040_resident_onboarding_and_consent.sql
-- Hoàn thiện chức năng Tạo hồ sơ cư dân (Module M04) theo PRD v2.0:
--   1. Bổ sung cột ghi nhận sự đồng ý xử lý dữ liệu cá nhân trên bảng person (PRD Mục 17.1).
--   2. Bổ sung cột nguyện vọng thuê (desired_apartment_id, desired_building_id, application_note)
--      và lý do từ chối hồ sơ (rejection_reason) trên bảng tenant (FR-012).
--   3. Cập nhật hàm RLS can_select_person, can_select_tenant và can_select_attachment:
--      - Cho phép MANAGER (và OWNER trên phạm vi đọc danh sách) thấy hồ sơ tự khai nhắm tới tòa nhà mình quản lý.
--      - Chặn vai trò OWNER đọc trực tiếp tệp đính kèm giấy tờ định danh gốc (owner_entity = 'person') theo PRD Mục 13.5.

-- ============================================================================
-- 1. MỞ RỘNG BẢNG PERSON (CONSENT DỮ LIỆU CÁ NHÂN - PRD 17.1)
-- ============================================================================
ALTER TABLE person ADD COLUMN IF NOT EXISTS privacy_consent_at TIMESTAMPTZ NULL;
ALTER TABLE person ADD COLUMN IF NOT EXISTS privacy_policy_version TEXT NULL;

-- ============================================================================
-- 2. MỞ RỘNG BẢNG TENANT (NGUYỆN VỌNG ĐĂNG KÝ THUÊ & LÝ DO TỪ CHỐI - FR-012)
-- ============================================================================
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS desired_apartment_id UUID NULL REFERENCES apartment(id) ON DELETE SET NULL;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS desired_building_id UUID NULL REFERENCES building(id) ON DELETE SET NULL;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS application_note TEXT NULL;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS rejection_reason TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_desired_building_status
  ON tenant(org_id, desired_building_id, status);

-- ============================================================================
-- 3. CẬP NHẬT RLS CAN_SELECT_PERSON & CAN_SELECT_TENANT
-- ============================================================================
DROP POLICY IF EXISTS rls_person_select ON person;
DROP POLICY IF EXISTS rls_tenant_select ON tenant;

DROP FUNCTION IF EXISTS can_select_person(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS can_select_person(UUID, UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS can_select_tenant(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS can_select_tenant(UUID, UUID, UUID, UUID);
DROP FUNCTION IF EXISTS can_select_tenant(UUID, UUID, UUID, UUID, UUID);

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

  -- OWNER (tòa sở hữu) & MANAGER (tòa được gán): xem person có HĐ chính, ở cùng, giữ chỗ hoặc đơn tự khai vào tòa của mình
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

  IF EXISTS (
    SELECT 1 FROM tenant td
    WHERE td.person_id = p_id
      AND td.desired_building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  ) THEN
    RETURN TRUE;
  END IF;

  -- Cho phép OWNER xem thông tin MANAGER phụ trách tòa mình
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

  -- Cho phép MANAGER chỉ xem tên người duyệt thuộc đúng tòa mình quản lý (OWNER của tòa đó hoặc SYS_ADMIN)
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

  IF (
    t_desired_building_id IS NOT NULL
    AND t_desired_building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  ) OR EXISTS (
    SELECT 1 FROM tenant td
    WHERE td.id = t_id
      AND td.desired_building_id IN (SELECT building_id FROM get_user_assigned_buildings())
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
  USING (can_select_tenant(tenant.id, tenant.person_id, tenant.org_id, tenant.created_by, tenant.desired_building_id));

-- ============================================================================
-- 4. CẬP NHẬT CAN_SELECT_ATTACHMENT (PRD 13.5: CHẶN OWNER ĐỌC GIẤY TỜ GỐC PERSON)
-- ============================================================================
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
      -- PRD Mục 13.5: Chỉ SYS_ADMIN và MANAGER (trong phạm vi tòa nhà) được đọc ảnh CCCD gốc; OWNER bị chặn
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
    END IF;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

