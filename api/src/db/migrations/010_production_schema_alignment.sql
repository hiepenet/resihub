-- ============================================================================
-- 010_production_schema_alignment.sql
-- Idempotent Schema Alignment for Both Clean Production Installs & Existing DBs
-- ============================================================================

-- 1. Core Identity & Real Estate Columns
ALTER TABLE person
  ADD COLUMN IF NOT EXISTS privacy_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS privacy_policy_version TEXT;

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 1;

ALTER TABLE zone
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'zone'::regclass AND conname = 'zone_status_check'
  ) THEN
    ALTER TABLE zone ADD CONSTRAINT zone_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'));
  END IF;
END $$;

-- 2. Tenants, Contracts & Deposits
ALTER TABLE tenant
  ADD COLUMN IF NOT EXISTS desired_apartment_id UUID REFERENCES apartment(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS application_note TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

ALTER TABLE contract
  ADD COLUMN IF NOT EXISTS is_room_transfer BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS transfer_deposit BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE contract_request
  ADD COLUMN IF NOT EXISTS desired_date DATE;

ALTER TABLE contract_request ALTER COLUMN status SET DEFAULT 'SUBMITTED';
ALTER TABLE contract_request DROP CONSTRAINT IF EXISTS contract_request_status_check;
ALTER TABLE contract_request ADD CONSTRAINT contract_request_status_check
  CHECK (status IN ('SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'));

ALTER TABLE deposit DROP CONSTRAINT IF EXISTS deposit_status_check;
ALTER TABLE deposit ADD CONSTRAINT deposit_status_check
  CHECK (status IN (
    'HELD', 'SETTLEMENT_DRAFT', 'PENDING_APPROVAL',
    'APPROVED_PENDING_PAYOUT', 'RETURNED',
    'PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED', 'DISPUTED'
  ));

-- 3. Service Requests & Operations
ALTER TABLE service_request
  ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS internal_note TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rating INTEGER,
  ADD COLUMN IF NOT EXISTS rating_note TEXT;

ALTER TABLE service_request DROP CONSTRAINT IF EXISTS service_request_rating_check;
ALTER TABLE service_request ADD CONSTRAINT service_request_rating_check
  CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5));

ALTER TABLE service_request DROP CONSTRAINT IF EXISTS service_request_category_check;
ALTER TABLE service_request ADD CONSTRAINT service_request_category_check
  CHECK (category IN ('ELECTRICAL', 'PLUMBING', 'HVAC', 'FURNITURE', 'APPLIANCE', 'STRUCTURAL', 'CLEANING', 'SECURITY', 'OTHER'));

ALTER TABLE service_request DROP CONSTRAINT IF EXISTS service_request_ai_triage_status_check;
ALTER TABLE service_request ADD CONSTRAINT service_request_ai_triage_status_check
  CHECK (ai_triage_status IS NULL OR ai_triage_status IN (
    'PENDING', 'SUGGESTED', 'NEEDS_MANUAL_REVIEW', 'ACCEPTED', 'OVERRIDDEN', 'FAILED', 'SKIPPED'
  ));

-- 4. Services, Subscriptions & Invoices
ALTER TABLE service_catalog
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE service_subscription
  ADD COLUMN IF NOT EXISTS prorata_amount BIGINT NOT NULL DEFAULT 0;

ALTER TABLE invoice DROP CONSTRAINT IF EXISTS invoice_status_check;
ALTER TABLE invoice ADD CONSTRAINT invoice_status_check
  CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'ADJUSTED', 'CANCELLED', 'VOID'));

ALTER TABLE invoice DROP CONSTRAINT IF EXISTS invoice_paid_lte_total_check;
ALTER TABLE invoice ADD CONSTRAINT invoice_paid_lte_total_check
  CHECK (paid_amount >= 0 AND total_amount >= 0 AND paid_amount <= total_amount);

-- 5. System Settings & Idempotency Key
ALTER TABLE system_setting
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES app_user(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'idempotency_key' AND column_name = 'request_hash'
  ) THEN
    DROP TABLE IF EXISTS idempotency_key CASCADE;
    CREATE TABLE idempotency_key (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id        UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      actor_id      UUID REFERENCES app_user(id) ON DELETE CASCADE,
      scope_key     TEXT NOT NULL,
      method        TEXT NOT NULL,
      route_path    TEXT NOT NULL,
      idem_key      TEXT NOT NULL,
      request_hash  TEXT NOT NULL,
      state         TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
      status_code   INTEGER,
      response_body JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
      UNIQUE (org_id, scope_key, method, route_path, idem_key)
    );
  END IF;
END $$;

ALTER TABLE idempotency_key ALTER COLUMN actor_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_idempotency_key_expires ON idempotency_key(expires_at);
GRANT ALL PRIVILEGES ON TABLE idempotency_key TO resihub_app;

-- 6. Partial Unique Indexes Alignment
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class i
    JOIN pg_index ix ON ix.indexrelid = i.oid
    JOIN pg_class t ON t.oid = ix.indrelid
    WHERE i.relname = 'uq_contract_open_room_transfer' AND t.relname <> 'contract'
  ) THEN
    DROP INDEX IF EXISTS uq_contract_open_room_transfer;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_open_room_transfer
  ON contract (parent_contract_id)
  WHERE is_room_transfer = TRUE AND status IN ('DRAFT', 'PENDING_APPROVAL');

DROP INDEX IF EXISTS idx_invoice_unique_active_period;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_unique_active_period
  ON invoice (contract_id, period)
  WHERE status NOT IN ('CANCELLED', 'VOID')
    AND COALESCE(invoice_type, 'REGULAR') <> 'LATE_FEE_SETTLEMENT';
