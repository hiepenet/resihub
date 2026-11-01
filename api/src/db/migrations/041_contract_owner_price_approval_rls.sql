-- 041_contract_owner_price_approval_rls.sql
-- Chuẩn hóa phân quyền Hợp đồng (M05) theo PRD v2.0 Mục 6.2 & FR-014:
--   1. SYS_ADMIN chỉ có quyền Xem (R) trên Hợp đồng: gỡ quyền ghi thường trực của is_org_admin()
--      khỏi contract, contract_version, contract_request, contract_service_price.
--   2. OWNER của tòa nhà sở hữu là người phê duyệt / từ chối hợp đồng lệch khung giá (PENDING_APPROVAL -> ACTIVE | DRAFT).
--      Khi hợp đồng đã sang ACTIVE hoặc DRAFT, OWNER tiếp tục không có quyền UPDATE trực tiếp.
--   3. Nhánh dự phòng duy nhất cho SYS_ADMIN: chỉ khi tòa nhà chưa gắn chủ sở hữu hoặc chủ nhà chưa có tài khoản ACTIVE.

BEGIN;

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
    WHERE b.id = p_building_id
      AND au.status = 'ACTIVE'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

DROP POLICY IF EXISTS rls_contract_insert ON contract;
CREATE POLICY rls_contract_insert ON contract FOR INSERT
  WITH CHECK (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_contract_update ON contract;
CREATE POLICY rls_contract_update ON contract FOR UPDATE
  USING (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (
      status = 'PENDING_APPROVAL'
      AND building_id IN (SELECT building_id FROM get_owner_building_ids())
    )
    OR (
      is_org_admin()
      AND status = 'PENDING_APPROVAL'
      AND NOT building_has_active_owner(building_id)
    )
  )
  WITH CHECK (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (
      status IN ('ACTIVE', 'DRAFT')
      AND building_id IN (SELECT building_id FROM get_owner_building_ids())
    )
    OR (
      is_org_admin()
      AND status IN ('ACTIVE', 'DRAFT')
      AND NOT building_has_active_owner(building_id)
    )
  );

DROP POLICY IF EXISTS rls_contract_version_insert ON contract_version;
CREATE POLICY rls_contract_version_insert ON contract_version FOR INSERT
  WITH CHECK (
    contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_contract_version_update ON contract_version;
CREATE POLICY rls_contract_version_update ON contract_version FOR UPDATE
  USING (
    is_manager()
    AND contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  )
  WITH CHECK (
    is_manager()
    AND contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_contract_request_insert ON contract_request;
CREATE POLICY rls_contract_request_insert ON contract_request FOR INSERT
  WITH CHECK (
    created_by = get_current_user_id()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_contract_request_update ON contract_request;
CREATE POLICY rls_contract_request_update ON contract_request FOR UPDATE
  USING (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  WITH CHECK (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_contract_service_price_modify ON contract_service_price;
CREATE POLICY rls_contract_service_price_modify ON contract_service_price FOR ALL
  USING (
    contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  )
  WITH CHECK (
    contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

COMMIT;
