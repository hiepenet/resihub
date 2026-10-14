-- 005_contracts.sql
-- Nhóm 4: Hợp đồng (M05)

CREATE TABLE IF NOT EXISTS contract (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  apartment_id        UUID REFERENCES apartment(id) ON DELETE RESTRICT,
  building_id         UUID REFERENCES building(id) ON DELETE CASCADE,
  primary_tenant_id   UUID REFERENCES tenant(id) ON DELETE RESTRICT,
  start_date          DATE NOT NULL,
  end_date            DATE NOT NULL,
  rent_amount         BIGINT NOT NULL,
  billing_cycle       TEXT NOT NULL DEFAULT 'monthly',
  billing_day         INTEGER NOT NULL CHECK (billing_day BETWEEN 1 AND 31),
  payment_due_days    INTEGER NOT NULL DEFAULT 5,
  deposit_amount      BIGINT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN (
                        'DRAFT','PENDING_APPROVAL','ACTIVE',
                        'RENEWAL_PENDING','EXPIRED','TERMINATED','CANCELLED'
                      )),
  parent_contract_id  UUID REFERENCES contract(id) ON DELETE SET NULL,
  note                TEXT,
  created_by          UUID REFERENCES app_user(id) ON DELETE SET NULL,
  approved_by         UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  CHECK (end_date > start_date)
);

CREATE TABLE IF NOT EXISTS contract_version (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID REFERENCES contract(id) ON DELETE CASCADE,
  version_no      INTEGER NOT NULL,
  diff            JSONB,
  effective_from  DATE NOT NULL,
  reason          TEXT,
  approved_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contract_occupant (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id  UUID REFERENCES contract(id) ON DELETE CASCADE,
  tenant_id    UUID REFERENCES tenant(id) ON DELETE CASCADE,
  relationship TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contract_service_price (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID REFERENCES contract(id) ON DELETE CASCADE,
  service_code    TEXT NOT NULL,
  unit_price      BIGINT NOT NULL,
  effective_from  DATE NOT NULL,
  UNIQUE (contract_id, service_code, effective_from)
);
