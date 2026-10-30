-- 032_prd_full_audit_fixes.sql
-- Đồng bộ hóa RLS theo PRD v2.0 Mục 6.2, FR-026, FR-032 & FR-065:
--   1. service_catalog (Biểu phí & Danh mục dịch vụ): ACCOUNTANT được CRU cùng SYS_ADMIN & MANAGER.
--   2. contract_service_price (Bảng giá dịch vụ ghi đè theo hợp đồng - FR-065):
--      ACCOUNTANT & MANAGER được cập nhật trên tòa được phân công; OWNER giữ nguyên 100% Read-Only.

DROP POLICY IF EXISTS rls_service_catalog_modify ON service_catalog;
CREATE POLICY rls_service_catalog_modify ON service_catalog FOR ALL
  USING (
    is_org_admin()
    OR is_manager()
    OR is_accountant()
  )
  WITH CHECK (
    is_org_admin()
    OR is_manager()
    OR is_accountant()
  );

DROP POLICY IF EXISTS rls_contract_service_price_modify ON contract_service_price;
CREATE POLICY rls_contract_service_price_modify ON contract_service_price FOR ALL
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

