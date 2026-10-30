-- 033_rls_staff_financial_isolation.sql
-- Đồng bộ hóa RLS tầng PostgreSQL theo PRD v2.0 Mục 6.2 & NFR-008:
--   STAFF (Nhân viên kỹ thuật/vệ sinh) có quyền '–' (không đọc, không ghi) đối với:
--     contract, contract_version, contract_request, deposit, deposit_transaction,
--     invoice, invoice_line, payment, receivable.
--   Tách helper get_non_staff_assigned_buildings() khỏi get_user_assigned_buildings()
--   để STAFF vẫn đọc được tòa/căn/đồng hồ/yêu cầu bảo trì nhưng tuyệt đối không đọc/ghi
--   được hợp đồng, tiền cọc, hóa đơn, thanh toán và công nợ ngay cả khi truy vấn SQL trực tiếp.

CREATE OR REPLACE FUNCTION get_non_staff_assigned_buildings()
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
  SELECT DISTINCT sub.building_id
  FROM (
    SELECT gb.building_id FROM get_owner_building_ids() gb
    UNION
    SELECT ur.building_id
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.user_id = v_user_id
      AND r.code IN ('MANAGER', 'ACCOUNTANT')
      AND ur.building_id IS NOT NULL
  ) sub
  WHERE sub.building_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- 1. CONTRACT, CONTRACT_VERSION, CONTRACT_REQUEST (STAFF = –)
DROP POLICY IF EXISTS rls_contract_select ON contract;
CREATE POLICY rls_contract_select ON contract FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  OR id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_contract_version_select ON contract_version;
CREATE POLICY rls_contract_version_select ON contract_version FOR SELECT USING (
  is_org_admin()
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_contract_request_select ON contract_request;
CREATE POLICY rls_contract_request_select ON contract_request FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR created_by = get_current_user_id()
);

-- 2. DEPOSIT (deposit_transaction kế thừa qua deposit_id IN (SELECT id FROM deposit))
DROP POLICY IF EXISTS rls_deposit_select ON deposit;
CREATE POLICY rls_deposit_select ON deposit FOR SELECT USING (
  is_org_admin()
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

-- 3. INVOICE & INVOICE_LINE (STAFF = –; gỡ get_staff_building_ids() khỏi cả SELECT & MODIFY)
DROP POLICY IF EXISTS rls_invoice_select ON invoice;
CREATE POLICY rls_invoice_select ON invoice FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

DROP POLICY IF EXISTS rls_invoice_modify ON invoice;
CREATE POLICY rls_invoice_modify ON invoice FOR ALL
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_accountant_building_ids())
  OR (is_resident() AND contract_id IN (SELECT contract_id FROM get_resident_contract_ids()))
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_accountant_building_ids())
  OR (is_resident() AND contract_id IN (SELECT contract_id FROM get_resident_contract_ids()))
);

DROP POLICY IF EXISTS rls_invoice_line_modify ON invoice_line;
CREATE POLICY rls_invoice_line_modify ON invoice_line FOR ALL
USING (
  is_org_admin()
  OR invoice_id IN (
    SELECT id FROM invoice
    WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
       OR building_id IN (SELECT building_id FROM get_accountant_building_ids())
  )
)
WITH CHECK (
  is_org_admin()
  OR invoice_id IN (
    SELECT id FROM invoice
    WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
       OR building_id IN (SELECT building_id FROM get_accountant_building_ids())
  )
);

-- 4. PAYMENT & RECEIVABLE (STAFF = –; gỡ get_staff_building_ids() khỏi SELECT, INSERT, UPDATE)
DROP POLICY IF EXISTS rls_payment_select ON payment;
CREATE POLICY rls_payment_select ON payment FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR reported_by = get_current_user_id()
);

DROP POLICY IF EXISTS rls_payment_insert ON payment;
CREATE POLICY rls_payment_insert ON payment FOR INSERT WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_accountant_building_ids())
  OR (
    is_resident()
    AND reported_by = get_current_user_id()
    AND contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
);

DROP POLICY IF EXISTS rls_payment_update ON payment;
CREATE POLICY rls_payment_update ON payment FOR UPDATE
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

DROP POLICY IF EXISTS rls_receivable_select ON receivable;
CREATE POLICY rls_receivable_select ON receivable FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

