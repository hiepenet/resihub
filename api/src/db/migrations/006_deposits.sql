-- 006_deposits.sql
-- Nhóm 5: Cọc (M06)

CREATE TABLE IF NOT EXISTS deposit (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id           UUID REFERENCES contract(id) ON DELETE CASCADE,
  source_reservation_id UUID REFERENCES reservation(id) ON DELETE SET NULL,
  amount_held           BIGINT NOT NULL,
  currency              TEXT DEFAULT 'VND',
  refund_due_date       DATE,
  status                TEXT NOT NULL DEFAULT 'HELD'
                        CHECK (status IN (
                          'HELD','SETTLEMENT_DRAFT','PENDING_APPROVAL',
                          'PARTIALLY_REFUNDED','REFUNDED','TRANSFERRED','DISPUTED'
                        )),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposit_transaction (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id  UUID REFERENCES deposit(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('collect','deduct','refund','transfer')),
  amount      BIGINT NOT NULL,
  description TEXT,
  evidence    TEXT[] DEFAULT '{}',
  approved_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
