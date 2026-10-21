-- 019_rls_security_audit.sql
-- Khắc phục các lỗ hổng RLS từ Báo cáo Audit Giai đoạn 1:
-- 1. Sửa policy rls_user_role_insert: Chống lỗ hổng MANAGER tự nâng quyền thành OWNER
-- 2. Kích hoạt RLS & bổ sung chính sách bảo vệ cho 7 bảng: attachment, contract_version,
--    contract_occupant, contract_service_price, organization, owner, role
-- 3. Bổ sung cột token_version vào bảng app_user hỗ trợ thu hồi token khi đăng xuất (Task 8)

-- =========================================================================
-- 1. BỔ SUNG CỘT TOKEN_VERSION (Hỗ trợ Revoke Token)
-- =========================================================================
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS token_version INT DEFAULT 1;

-- =========================================================================
-- 2. HÀM TIỆN ÍCH CHO RESIDENT
-- =========================================================================
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

-- =========================================================================
-- 3. VÁ LỖ HỔNG USER_ROLE (CHỐNG SELF-ESCALATE ROLE)
-- =========================================================================
DROP POLICY IF EXISTS rls_user_role_insert ON user_role;

CREATE POLICY rls_user_role_insert ON user_role FOR INSERT
WITH CHECK (
  is_org_admin()
  OR (
    is_manager()
    AND role_id IN (SELECT id FROM role WHERE code = 'RESIDENT')
    AND user_id != get_current_user_id()
  )
);

-- =========================================================================
-- 4. BẬT RLS & POLICY CHO 7 BẢNG CÒN THIẾU
-- =========================================================================

-- 📎 BẢNG ATTACHMENT (NFR-008: Bảo mật ảnh CCCD, tệp đính kèm)
ALTER TABLE attachment ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_attachment_select ON attachment;
DROP POLICY IF EXISTS rls_attachment_insert ON attachment;
DROP POLICY IF EXISTS rls_attachment_delete ON attachment;

CREATE POLICY rls_attachment_select ON attachment FOR SELECT
USING (
  is_org_admin()
  OR uploaded_by = get_current_user_id()
  OR (
    is_manager() AND (
      (owner_entity = 'contract' AND owner_id IN (
        SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      ))
      OR (owner_entity = 'tenant' AND owner_id IN (
        SELECT t.id FROM tenant t
        JOIN contract c ON c.primary_tenant_id = t.id
        WHERE c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      ))
      OR (owner_entity = 'deposit' AND owner_id IN (
        SELECT d.id FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        WHERE c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      ))
      OR (owner_entity = 'apartment' AND owner_id IN (
        SELECT id FROM apartment WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      ))
    )
  )
  OR (
    is_resident() AND (
      (owner_entity = 'tenant' AND owner_id IN (SELECT tenant_id FROM get_resident_tenant_ids()))
      OR (owner_entity = 'contract' AND owner_id IN (SELECT contract_id FROM get_resident_contract_ids()))
      OR (owner_entity = 'deposit' AND owner_id IN (
        SELECT d.id FROM deposit d
        WHERE d.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
      ))
    )
  )
);

CREATE POLICY rls_attachment_insert ON attachment FOR INSERT
WITH CHECK (
  is_org_admin()
  OR is_manager()
  OR uploaded_by = get_current_user_id()
);

CREATE POLICY rls_attachment_delete ON attachment FOR DELETE
USING (
  is_org_admin()
  OR uploaded_by = get_current_user_id()
);

-- 📜 BẢNG CONTRACT_VERSION
ALTER TABLE contract_version ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_contract_version_select ON contract_version;
DROP POLICY IF EXISTS rls_contract_version_modify ON contract_version;

CREATE POLICY rls_contract_version_select ON contract_version FOR SELECT
USING (
  is_org_admin()
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

CREATE POLICY rls_contract_version_modify ON contract_version FOR ALL
USING (
  is_org_admin()
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
);

-- 👥 BẢNG CONTRACT_OCCUPANT (Người ở cùng)
ALTER TABLE contract_occupant ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_contract_occupant_select ON contract_occupant;
DROP POLICY IF EXISTS rls_contract_occupant_modify ON contract_occupant;

CREATE POLICY rls_contract_occupant_select ON contract_occupant FOR SELECT
USING (
  is_org_admin()
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

CREATE POLICY rls_contract_occupant_modify ON contract_occupant FOR ALL
USING (
  is_org_admin()
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR (
    is_resident() AND contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
);

-- 💰 BẢNG CONTRACT_SERVICE_PRICE
ALTER TABLE contract_service_price ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_contract_service_price_select ON contract_service_price;
DROP POLICY IF EXISTS rls_contract_service_price_modify ON contract_service_price;

CREATE POLICY rls_contract_service_price_select ON contract_service_price FOR SELECT
USING (
  is_org_admin()
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

CREATE POLICY rls_contract_service_price_modify ON contract_service_price FOR ALL
USING (
  is_org_admin()
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
);

-- 🏢 BẢNG ORGANIZATION
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_organization_select ON organization;
DROP POLICY IF EXISTS rls_organization_modify ON organization;

CREATE POLICY rls_organization_select ON organization FOR SELECT
USING (
  id = get_current_user_org_id()
  OR is_org_admin()
);

CREATE POLICY rls_organization_modify ON organization FOR ALL
USING (
  is_org_admin()
);

-- 👑 BẢNG OWNER
ALTER TABLE owner ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_owner_select ON owner;
DROP POLICY IF EXISTS rls_owner_modify ON owner;

CREATE POLICY rls_owner_select ON owner FOR SELECT
USING (
  org_id = get_current_user_org_id()
  OR is_org_admin()
);

CREATE POLICY rls_owner_modify ON owner FOR ALL
USING (
  is_org_admin()
);

-- 🛡️ BẢNG ROLE
ALTER TABLE role ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_role_select ON role;
DROP POLICY IF EXISTS rls_role_modify ON role;

CREATE POLICY rls_role_select ON role FOR SELECT
USING (
  org_id = get_current_user_org_id()
  OR org_id IS NULL
  OR is_org_admin()
);

CREATE POLICY rls_role_modify ON role FOR ALL
USING (
  is_org_admin()
);

-- Bổ sung trạng thái MERGED cho bảng tenant hỗ trợ gộp hồ sơ FR-021
ALTER TABLE tenant DROP CONSTRAINT IF EXISTS tenant_status_check;
ALTER TABLE tenant ADD CONSTRAINT tenant_status_check CHECK (status IN ('PENDING','APPROVED','REJECTED','MOVED_OUT','MERGED'));

