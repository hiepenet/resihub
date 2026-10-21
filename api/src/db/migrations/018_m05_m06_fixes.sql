-- 018_m05_m06_fixes.sql
-- C8/D4: mốc ngày chấm dứt + luồng chấm dứt cần duyệt
ALTER TABLE contract ADD COLUMN IF NOT EXISTS terminated_at DATE;
ALTER TABLE contract DROP CONSTRAINT IF EXISTS contract_status_check;
ALTER TABLE contract ADD CONSTRAINT contract_status_check
  CHECK (status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','RENEWAL_PENDING',
                    'TERMINATION_PENDING','EXPIRED','TERMINATED','CANCELLED'));

-- D2/D5/D8: tất toán 2 bước — chi tiết hồ sơ (items + công nợ + số hoàn) lưu 1 cột jsonb
ALTER TABLE deposit ADD COLUMN IF NOT EXISTS settlement JSONB;

-- D1/D5: danh mục khấu trừ đóng + phương thức + trạng thái duyệt từng dòng giao dịch
ALTER TABLE deposit_transaction ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE deposit_transaction ADD COLUMN IF NOT EXISTS method TEXT;
ALTER TABLE deposit_transaction ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'APPROVED'
  CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED'));

-- C9: đề nghị gia hạn / chấm dứt từ cổng cư dân (FR-019)
CREATE TABLE IF NOT EXISTS contract_request (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID REFERENCES organization(id) ON DELETE CASCADE,
  contract_id   UUID REFERENCES contract(id) ON DELETE CASCADE,
  building_id   UUID REFERENCES building(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('RENEWAL','TERMINATION')),
  desired_date  DATE,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'SUBMITTED'
                CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
  created_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contract_request_status ON contract_request(status, building_id);

-- RLS: bảo vệ bảng contract_request tuân thủ NFR-008
ALTER TABLE contract_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_request FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_contract_request_select ON contract_request;
CREATE POLICY rls_contract_request_select ON contract_request FOR SELECT
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR created_by = get_current_user_id()
);

DROP POLICY IF EXISTS rls_contract_request_insert ON contract_request;
CREATE POLICY rls_contract_request_insert ON contract_request FOR INSERT
WITH CHECK (
  created_by = get_current_user_id()
  OR is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

DROP POLICY IF EXISTS rls_contract_request_update ON contract_request;
CREATE POLICY rls_contract_request_update ON contract_request FOR UPDATE
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);
