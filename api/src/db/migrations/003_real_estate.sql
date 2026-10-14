-- 003_real_estate.sql
-- Nhóm 2: Bất động sản (M03)

CREATE TABLE IF NOT EXISTS building (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organization(id) ON DELETE CASCADE,
  owner_id    UUID REFERENCES owner(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL,
  address     TEXT,
  timezone    TEXT DEFAULT 'Asia/Ho_Chi_Minh',
  lease_terms JSONB DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS floor (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id UUID REFERENCES building(id) ON DELETE CASCADE,
  level       INTEGER NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (building_id, level)
);

CREATE TABLE IF NOT EXISTS apartment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id    UUID REFERENCES floor(id) ON DELETE SET NULL,
  building_id UUID REFERENCES building(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  area_m2     NUMERIC(6,2),
  type        TEXT,
  bedrooms    INTEGER DEFAULT 0,
  base_rent   BIGINT DEFAULT 0,   -- VND, integer (không dùng float)
  amenities   JSONB DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'AVAILABLE'
              CHECK (status IN ('AVAILABLE','RESERVED','OCCUPIED','MAINTENANCE','INACTIVE')),
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (building_id, code)
);
