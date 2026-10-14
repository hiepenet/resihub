-- 004_tenants_reservations.sql
-- Nhóm 3: Cư dân & Đặt cọc giữ chỗ (M04)

CREATE TABLE IF NOT EXISTS tenant (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   UUID REFERENCES person(id) ON DELETE CASCADE,
  org_id      UUID REFERENCES organization(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('primary', 'occupant')),
  status      TEXT NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING','APPROVED','REJECTED','MOVED_OUT')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservation (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID REFERENCES organization(id) ON DELETE CASCADE,
  building_id   UUID REFERENCES building(id) ON DELETE CASCADE,
  apartment_id  UUID REFERENCES apartment(id) ON DELETE CASCADE,
  prospect_name TEXT NOT NULL,
  phone         TEXT NOT NULL,
  hold_amount   BIGINT DEFAULT 0,
  hold_until    DATE,
  status        TEXT NOT NULL DEFAULT 'HELD'
                CHECK (status IN ('HELD','CONVERTED','FORFEITED','REFUNDED','EXPIRED')),
  note          TEXT,
  created_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
