-- 025_services_catalog.sql
-- Module M07: Dịch vụ & Tiện ích (FR-026 -> FR-029)

CREATE TABLE IF NOT EXISTS service_catalog (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id   UUID REFERENCES building(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'UTILITY'
                CHECK (category IN ('ELECTRICITY','WATER','INTERNET','PARKING','CLEANING','MANAGEMENT','UTILITY','OTHER')),
  billing_type  TEXT NOT NULL DEFAULT 'FIXED'
                CHECK (billing_type IN ('FIXED','METERED','QUANTITY')),
  unit          TEXT NOT NULL DEFAULT 'tháng',
  unit_price    BIGINT NOT NULL DEFAULT 0,
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS service_subscription (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id     UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  apartment_id    UUID NOT NULL REFERENCES apartment(id) ON DELETE CASCADE,
  contract_id     UUID REFERENCES contract(id) ON DELETE CASCADE,
  service_id      UUID NOT NULL REFERENCES service_catalog(id) ON DELETE RESTRICT,
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price      BIGINT NOT NULL DEFAULT 0,
  start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date        DATE,
  prorata_amount  BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                  CHECK (status IN ('PENDING_APPROVAL','ACTIVE','CANCELLATION_PENDING','CANCELLED','REJECTED')),
  note            TEXT,
  requested_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  approved_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_sub_building ON service_subscription(building_id, status);
CREATE INDEX IF NOT EXISTS idx_service_sub_contract ON service_subscription(contract_id, status);

GRANT ALL PRIVILEGES ON TABLE service_catalog TO resihub_app;
GRANT ALL PRIVILEGES ON TABLE service_subscription TO resihub_app;

ALTER TABLE service_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_catalog FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_service_catalog_select ON service_catalog;
CREATE POLICY rls_service_catalog_select ON service_catalog FOR SELECT USING (
  org_id = get_current_user_org_id()
  OR is_org_admin()
);

DROP POLICY IF EXISTS rls_service_catalog_modify ON service_catalog;
CREATE POLICY rls_service_catalog_modify ON service_catalog FOR ALL
USING (
  is_org_admin()
  OR is_manager()
)
WITH CHECK (
  is_org_admin()
  OR is_manager()
);

ALTER TABLE service_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_subscription FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_service_sub_select ON service_subscription;
CREATE POLICY rls_service_sub_select ON service_subscription FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR requested_by = get_current_user_id()
);

DROP POLICY IF EXISTS rls_service_sub_insert ON service_subscription;
CREATE POLICY rls_service_sub_insert ON service_subscription FOR INSERT WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR requested_by = get_current_user_id()
);

DROP POLICY IF EXISTS rls_service_sub_update ON service_subscription;
CREATE POLICY rls_service_sub_update ON service_subscription FOR UPDATE
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_service_sub_delete ON service_subscription;
CREATE POLICY rls_service_sub_delete ON service_subscription FOR DELETE USING (
  is_org_admin()
);

-- Seed danh mục dịch vụ chuẩn
INSERT INTO service_catalog (org_id, code, name, category, billing_type, unit, unit_price, description)
SELECT o.id, v.code, v.name, v.category, v.billing_type, v.unit, v.unit_price, v.description
FROM organization o
CROSS JOIN (VALUES
  ('ELECTRICITY',       'Điện sinh hoạt',         'ELECTRICITY', 'METERED',  'kWh',      3800,    'Tính theo chỉ số công tơ điện hàng tháng'),
  ('WATER',             'Nước sạch sinh hoạt',    'WATER',       'METERED',  'm³',       22000,   'Tính theo đồng hồ nước từng căn hộ'),
  ('INTERNET_FIBER',    'Internet Cáp quang 300M','INTERNET',    'FIXED',    'tháng',    220000,  'Đường truyền tốc độ cao ổn định riêng cho căn hộ'),
  ('MOTORBIKE_PARKING', 'Gửi xe máy hầm B1',      'PARKING',     'QUANTITY', 'xe/tháng', 120000,  'Thẻ từ gửi xe máy định danh tại tầng hầm'),
  ('CAR_PARKING',       'Đỗ xe ô tô hầm B2',      'PARKING',     'QUANTITY', 'xe/tháng', 1250000, 'Vị trí đỗ ô tô có mái che tại hầm B2'),
  ('CLEANING_WEEKLY',   'Dọn vệ sinh căn hộ',     'CLEANING',    'QUANTITY', 'lần/tháng',150000,  'Dịch vụ dọn phòng định kỳ theo yêu cầu cư dân'),
  ('MANAGEMENT_FEE',    'Phí quản lý vận hành',   'MANAGEMENT',  'FIXED',    'tháng',    350000,  'An ninh 24/7, lễ tân, chiếu sáng và vệ sinh khu chung')
) AS v(code, name, category, billing_type, unit, unit_price, description)
ON CONFLICT (org_id, code) DO NOTHING;

-- Seed đăng ký dịch vụ mẫu cho các hợp đồng đang hiệu lực
INSERT INTO service_subscription (org_id, building_id, apartment_id, contract_id, service_id, quantity, unit_price, start_date, status)
SELECT
  b.org_id,
  c.building_id,
  c.apartment_id,
  c.id,
  sc.id,
  1,
  sc.unit_price,
  c.start_date,
  CASE WHEN (ROW_NUMBER() OVER (ORDER BY c.id)) % 10 = 0 THEN 'PENDING_APPROVAL' ELSE 'ACTIVE' END
FROM contract c
JOIN building b ON b.id = c.building_id
JOIN service_catalog sc ON sc.org_id = b.org_id AND sc.code IN ('INTERNET_FIBER', 'MANAGEMENT_FEE')
WHERE c.status = 'ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM service_subscription LIMIT 1)
LIMIT 80;

