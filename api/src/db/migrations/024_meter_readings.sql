-- 024_meter_readings.sql
-- Module M08: Chỉ số Điện / Nước (FR-030, FR-031)

CREATE TABLE IF NOT EXISTS meter (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id     UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  apartment_id    UUID NOT NULL REFERENCES apartment(id) ON DELETE CASCADE,
  meter_type      TEXT NOT NULL CHECK (meter_type IN ('ELECTRICITY', 'WATER')),
  meter_code      TEXT NOT NULL,
  unit            TEXT NOT NULL DEFAULT 'kWh',
  unit_price      BIGINT NOT NULL DEFAULT 3500,
  initial_reading NUMERIC(12,2) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (building_id, meter_code),
  UNIQUE (apartment_id, meter_type)
);

CREATE TABLE IF NOT EXISTS meter_reading (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id       UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  meter_id          UUID NOT NULL REFERENCES meter(id) ON DELETE CASCADE,
  apartment_id      UUID NOT NULL REFERENCES apartment(id) ON DELETE CASCADE,
  period            TEXT NOT NULL, -- YYYY-MM
  previous_reading  NUMERIC(12,2) NOT NULL DEFAULT 0,
  current_reading   NUMERIC(12,2) NOT NULL,
  consumption       NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_abnormal       BOOLEAN NOT NULL DEFAULT FALSE,
  abnormal_note     TEXT,
  image_url         TEXT,
  recorded_by       UUID REFERENCES app_user(id) ON DELETE SET NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (current_reading >= previous_reading),
  UNIQUE (meter_id, period)
);

CREATE INDEX IF NOT EXISTS idx_meter_building ON meter(building_id, meter_type);
CREATE INDEX IF NOT EXISTS idx_meter_reading_period ON meter_reading(building_id, period);

GRANT ALL PRIVILEGES ON TABLE meter TO resihub_app;
GRANT ALL PRIVILEGES ON TABLE meter_reading TO resihub_app;

ALTER TABLE meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_meter_select ON meter;
CREATE POLICY rls_meter_select ON meter FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR apartment_id IN (
    SELECT c.apartment_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
);

DROP POLICY IF EXISTS rls_meter_modify ON meter;
CREATE POLICY rls_meter_modify ON meter FOR ALL
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
);

ALTER TABLE meter_reading ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_reading FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_meter_reading_select ON meter_reading;
CREATE POLICY rls_meter_reading_select ON meter_reading FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR apartment_id IN (
    SELECT c.apartment_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
);

DROP POLICY IF EXISTS rls_meter_reading_modify ON meter_reading;
CREATE POLICY rls_meter_reading_modify ON meter_reading FOR ALL
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
);

-- Seed đồng hồ điện & nước cho các căn hộ đang thuê (OCCUPIED)
INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading)
SELECT
  b.org_id,
  a.building_id,
  a.id,
  'ELECTRICITY',
  'EL-' || b.code || '-' || a.code,
  'kWh',
  3800,
  1000
FROM apartment a
JOIN building b ON b.id = a.building_id
WHERE a.status = 'OCCUPIED'
ON CONFLICT DO NOTHING;

INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading)
SELECT
  b.org_id,
  a.building_id,
  a.id,
  'WATER',
  'WT-' || b.code || '-' || a.code,
  'm³',
  22000,
  100
FROM apartment a
JOIN building b ON b.id = a.building_id
WHERE a.status = 'OCCUPIED'
ON CONFLICT DO NOTHING;

-- Seed chỉ số mẫu cho kỳ trước và kỳ hiện tại
INSERT INTO meter_reading (org_id, building_id, meter_id, apartment_id, period, previous_reading, current_reading, consumption, is_abnormal)
SELECT
  m.org_id,
  m.building_id,
  m.id,
  m.apartment_id,
  TO_CHAR(NOW() - INTERVAL '1 month', 'YYYY-MM'),
  m.initial_reading,
  CASE WHEN m.meter_type = 'ELECTRICITY' THEN m.initial_reading + 180 ELSE m.initial_reading + 12 END,
  CASE WHEN m.meter_type = 'ELECTRICITY' THEN 180 ELSE 12 END,
  FALSE
FROM meter m
ON CONFLICT DO NOTHING;

INSERT INTO meter_reading (org_id, building_id, meter_id, apartment_id, period, previous_reading, current_reading, consumption, is_abnormal, abnormal_note)
SELECT
  m.org_id,
  m.building_id,
  m.id,
  m.apartment_id,
  TO_CHAR(NOW(), 'YYYY-MM'),
  CASE WHEN m.meter_type = 'ELECTRICITY' THEN m.initial_reading + 180 ELSE m.initial_reading + 12 END,
  CASE
    WHEN m.meter_type = 'ELECTRICITY' AND (ROW_NUMBER() OVER (ORDER BY m.id)) % 12 = 0 THEN m.initial_reading + 180 + 295
    WHEN m.meter_type = 'ELECTRICITY' THEN m.initial_reading + 180 + 195
    ELSE m.initial_reading + 12 + 13
  END,
  CASE
    WHEN m.meter_type = 'ELECTRICITY' AND (ROW_NUMBER() OVER (ORDER BY m.id)) % 12 = 0 THEN 295
    WHEN m.meter_type = 'ELECTRICITY' THEN 195
    ELSE 13
  END,
  CASE WHEN m.meter_type = 'ELECTRICITY' AND (ROW_NUMBER() OVER (ORDER BY m.id)) % 12 = 0 THEN TRUE ELSE FALSE END,
  CASE WHEN m.meter_type = 'ELECTRICITY' AND (ROW_NUMBER() OVER (ORDER BY m.id)) % 12 = 0 THEN 'Sản lượng tăng đột biến > 30% so với kỳ trước' ELSE NULL END
FROM meter m
ON CONFLICT DO NOTHING;

