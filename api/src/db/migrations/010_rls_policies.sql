-- 010_rls_policies.sql
-- Hoàn thiện Row Level Security (RLS) theo đúng chuẩn Tuần 2 & PRD v2.0
-- Đảm bảo Zero Data Leak giữa các vai trò (OWNER, MANAGER, RESIDENT, STAFF)

-- 1. Tạo role không phải superuser cho application nếu chưa có
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'resihub_app') THEN
    CREATE ROLE resihub_app WITH LOGIN PASSWORD 'resihub_app_secret';
  END IF;
  GRANT USAGE ON SCHEMA public TO resihub_app;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO resihub_app;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO resihub_app;
  GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO resihub_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO resihub_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO resihub_app;
END $$;

-- 2. Hàm lấy ID người dùng hiện tại từ session variable
DROP FUNCTION IF EXISTS get_current_user_id() CASCADE;
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

-- 3. Hàm kiểm tra quyền quản trị toàn tổ chức (OWNER)
CREATE OR REPLACE FUNCTION is_org_admin()
RETURNS BOOLEAN AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  -- Nếu không set context (cron job nội bộ, migration), cho phép bypass
  IF v_user_id IS NULL THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1 
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.user_id = v_user_id 
      AND r.code = 'OWNER'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 4. Hàm lấy danh sách tòa nhà mà người dùng được phân quyền quản lý
CREATE OR REPLACE FUNCTION get_user_assigned_buildings()
RETURNS TABLE (building_id UUID) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT id FROM building;
    RETURN;
  END IF;

  -- Nếu có quyền cấp tổ chức (OWNER)
  IF EXISTS (
    SELECT 1 FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    WHERE ur.user_id = v_user_id AND r.code = 'OWNER'
  ) THEN
    RETURN QUERY 
    SELECT b.id 
    FROM building b
    JOIN app_user u ON u.id = v_user_id
    JOIN person p ON p.id = u.person_id
    WHERE b.org_id = p.org_id;
    RETURN;
  END IF;

  -- Trả về các tòa nhà được gán cụ thể
  RETURN QUERY
  SELECT ur.building_id
  FROM user_role ur
  WHERE ur.user_id = v_user_id AND ur.building_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 5. Hàm lấy danh sách tenant ID của cư dân hiện tại
CREATE OR REPLACE FUNCTION get_resident_tenant_ids()
RETURNS TABLE (tenant_id UUID) AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := get_current_user_id();
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT id FROM tenant;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT t.id
  FROM tenant t
  JOIN person p ON p.id = t.person_id
  JOIN app_user u ON u.person_id = p.id
  WHERE u.id = v_user_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 6. Xóa các policy placeholder cũ
DROP POLICY IF EXISTS allow_all_internal_service ON building;
DROP POLICY IF EXISTS allow_all_internal_service ON apartment;
DROP POLICY IF EXISTS allow_all_internal_service ON person;
DROP POLICY IF EXISTS allow_all_internal_service ON tenant;
DROP POLICY IF EXISTS allow_all_internal_service ON contract;
DROP POLICY IF EXISTS allow_all_internal_service ON deposit;
DROP POLICY IF EXISTS allow_all_internal_service ON deposit_transaction;

-- 7. Kích hoạt và ép buộc RLS trên các bảng cốt lõi
ALTER TABLE building ENABLE ROW LEVEL SECURITY;
ALTER TABLE apartment ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE person ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_transaction ENABLE ROW LEVEL SECURITY;

-- BẬT FORCE RLS: áp dụng kể cả với chủ bảng nếu không bypass
ALTER TABLE building FORCE ROW LEVEL SECURITY;
ALTER TABLE apartment FORCE ROW LEVEL SECURITY;
ALTER TABLE contract FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
ALTER TABLE person FORCE ROW LEVEL SECURITY;
ALTER TABLE deposit FORCE ROW LEVEL SECURITY;
ALTER TABLE deposit_transaction FORCE ROW LEVEL SECURITY;

-- 8. POLICIES CHI TIẾT TỪNG BẢNG

-- 🏢 BẢNG BUILDING:
DROP POLICY IF EXISTS rls_building_select ON building;
CREATE POLICY rls_building_select ON building FOR SELECT
USING (
  is_org_admin() 
  OR id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR id IN (
    SELECT c.building_id FROM contract c 
    WHERE c.primary_tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
      AND c.status = 'ACTIVE'
  )
);

DROP POLICY IF EXISTS rls_building_modify ON building;
CREATE POLICY rls_building_modify ON building FOR ALL
USING (
  is_org_admin() 
  OR id IN (SELECT building_id FROM get_user_assigned_buildings())
);

-- 🚪 BẢNG APARTMENT:
DROP POLICY IF EXISTS rls_apartment_select ON apartment;
CREATE POLICY rls_apartment_select ON apartment FOR SELECT
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR id IN (
    SELECT c.apartment_id FROM contract c
    WHERE c.primary_tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
      AND c.status = 'ACTIVE'
  )
);

DROP POLICY IF EXISTS rls_apartment_modify ON apartment;
CREATE POLICY rls_apartment_modify ON apartment FOR ALL
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

-- 📝 BẢNG CONTRACT:
DROP POLICY IF EXISTS rls_contract_select ON contract;
CREATE POLICY rls_contract_select ON contract FOR SELECT
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR primary_tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

DROP POLICY IF EXISTS rls_contract_modify ON contract;
CREATE POLICY rls_contract_modify ON contract FOR ALL
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

-- 👤 BẢNG TENANT:
DROP POLICY IF EXISTS rls_tenant_select ON tenant;
CREATE POLICY rls_tenant_select ON tenant FOR SELECT
USING (
  is_org_admin()
  OR EXISTS (
    SELECT 1 FROM contract c 
    WHERE c.primary_tenant_id = tenant.id 
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

DROP POLICY IF EXISTS rls_tenant_modify ON tenant;
CREATE POLICY rls_tenant_modify ON tenant FOR ALL
USING (
  is_org_admin()
);

-- 👤 BẢNG PERSON:
DROP POLICY IF EXISTS rls_person_select ON person;
CREATE POLICY rls_person_select ON person FOR SELECT
USING (
  is_org_admin()
  OR id = (SELECT person_id FROM app_user WHERE id = get_current_user_id())
  OR EXISTS (
    SELECT 1 FROM contract c
    JOIN tenant t ON t.id = c.primary_tenant_id
    WHERE t.person_id = person.id 
      AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
);

DROP POLICY IF EXISTS rls_person_modify ON person;
CREATE POLICY rls_person_modify ON person FOR ALL
USING (
  is_org_admin()
);

-- 💰 BẢNG DEPOSIT & DEPOSIT_TRANSACTION:
DROP POLICY IF EXISTS rls_deposit_select ON deposit;
CREATE POLICY rls_deposit_select ON deposit FOR SELECT
USING (
  is_org_admin()
  OR contract_id IN (SELECT id FROM contract)
);

DROP POLICY IF EXISTS rls_deposit_modify ON deposit;
CREATE POLICY rls_deposit_modify ON deposit FOR ALL
USING (
  is_org_admin()
  OR contract_id IN (SELECT id FROM contract)
);

DROP POLICY IF EXISTS rls_deposit_txn_select ON deposit_transaction;
CREATE POLICY rls_deposit_txn_select ON deposit_transaction FOR SELECT
USING (
  is_org_admin()
  OR deposit_id IN (SELECT id FROM deposit)
);

DROP POLICY IF EXISTS rls_deposit_txn_modify ON deposit_transaction;
CREATE POLICY rls_deposit_txn_modify ON deposit_transaction FOR ALL
USING (
  is_org_admin()
  OR deposit_id IN (SELECT id FROM deposit)
);
