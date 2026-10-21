-- 017: FR-012 — cư dân tự khai hồ sơ nhận nhà (INSERT tenant PENDING cho chính mình)
-- Bug QA 2026-10-21: POST /resident/rental-application 500 vì:
--   1) rls_tenant_insert chỉ chấp nhận org_admin/manager — thêm nhánh self.
--   2) INSERT...RETURNING đòi dòng mới "nhìn thấy" theo rls_tenant_select; nhánh duy nhất
--      khả thi của resident (id IN get_resident_tenant_ids()) là subquery scan toàn bảng +
--      chiến lược InitPlan chạy trước khi dòng mới tồn tại → FAIL.
-- Fix: thêm nhánh select theo person_id (so sánh trực tiếp trên DÒNG mới, không cần initplan).
DROP POLICY IF EXISTS rls_tenant_insert ON tenant;
CREATE POLICY rls_tenant_insert ON tenant FOR INSERT
WITH CHECK (
  is_org_admin()
  OR (
    is_manager()
    AND tenant.org_id = get_current_user_org_id()
  )
  OR (
    tenant.person_id = (SELECT person_id FROM app_user WHERE id = get_current_user_id())
    AND tenant.org_id = get_current_user_org_id()
  )
);

DROP POLICY IF EXISTS rls_tenant_select ON tenant;
CREATE POLICY rls_tenant_select ON tenant FOR SELECT
USING (
  is_org_admin()
  OR EXISTS (
    SELECT 1 FROM contract c
    WHERE c.primary_tenant_id = tenant.id
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR EXISTS (
    SELECT 1
    FROM contract_occupant co
    JOIN contract c ON c.id = co.contract_id
    WHERE co.tenant_id = tenant.id
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR id IN (SELECT tenant_id FROM get_resident_tenant_ids())
  OR tenant.person_id = get_current_user_person_id()  -- dòng mới của chính mình (FR-012)
  OR (
    is_manager()
    AND tenant.org_id = get_current_user_org_id()
    AND NOT EXISTS (
      SELECT 1 FROM contract c_other
      WHERE c_other.primary_tenant_id = tenant.id
        AND c_other.building_id NOT IN (SELECT building_id FROM get_user_assigned_buildings())
    )
  )
);

-- Cập nhật policy cũ 013 — giữ nguyên logic select cũ, chỉ bổ sung 1 nhánh
