-- 002_core_tables.sql
-- Consolidated Migration 002: Core Schema DDL
-- Creates all operational tables with their final column definitions and relationships.

-- 1. Organization & Core Identity
CREATE TABLE IF NOT EXISTS organization (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  tax_code        TEXT,
  settings        JSONB DEFAULT '{}',
  payment_account JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS person (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID REFERENCES organization(id) ON DELETE CASCADE,
  full_name    TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  dob          DATE,
  id_number    TEXT,
  id_images    TEXT[] DEFAULT '{}',
  avatar_url   TEXT,
  nationality  TEXT,
  address      TEXT,
  created_by   UUID,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (org_id, phone)
);

CREATE TABLE IF NOT EXISTS app_user (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     UUID REFERENCES person(id) ON DELETE CASCADE,
  auth_uid      TEXT UNIQUE,
  password_hash TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_person_created_by'
  ) THEN
    ALTER TABLE person ADD CONSTRAINT fk_person_created_by
      FOREIGN KEY (created_by) REFERENCES app_user(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS owner (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organization(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  person_id   UUID REFERENCES person(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organization(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('org', 'building')),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS user_role (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES app_user(id) ON DELETE CASCADE,
  role_id     UUID REFERENCES role(id) ON DELETE CASCADE,
  building_id UUID,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, role_id, building_id)
);

-- 2. Real Estate Structure (Building, Floor, Zone, Apartment)
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
  created_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS zone (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (building_id, code)
);

CREATE TABLE IF NOT EXISTS apartment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id    UUID REFERENCES floor(id) ON DELETE SET NULL,
  building_id UUID REFERENCES building(id) ON DELETE CASCADE,
  zone_id     UUID REFERENCES zone(id) ON DELETE SET NULL,
  code        TEXT NOT NULL,
  area_m2     NUMERIC(6,2),
  type        TEXT,
  bedrooms    INTEGER DEFAULT 0,
  base_rent   BIGINT DEFAULT 0,
  amenities   JSONB DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'AVAILABLE'
              CHECK (status IN ('AVAILABLE','RESERVED','OCCUPIED','MAINTENANCE','INACTIVE')),
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (building_id, code)
);

-- 3. Tenants, Reservations & Contracts
CREATE TABLE IF NOT EXISTS tenant (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id           UUID REFERENCES person(id) ON DELETE CASCADE,
  org_id              UUID REFERENCES organization(id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN ('primary', 'occupant')),
  status              TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','APPROVED','REJECTED','MOVED_OUT','MERGED')),
  desired_building_id UUID REFERENCES building(id) ON DELETE SET NULL,
  created_by          UUID REFERENCES app_user(id) ON DELETE SET NULL,
  consent_given       BOOLEAN NOT NULL DEFAULT FALSE,
  consent_given_at    TIMESTAMPTZ,
  onboarding_step     TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservation (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID REFERENCES organization(id) ON DELETE CASCADE,
  building_id      UUID REFERENCES building(id) ON DELETE CASCADE,
  apartment_id     UUID REFERENCES apartment(id) ON DELETE CASCADE,
  prospect_name    TEXT NOT NULL,
  phone            TEXT NOT NULL,
  hold_amount      BIGINT DEFAULT 0,
  hold_from        DATE NOT NULL DEFAULT CURRENT_DATE,
  hold_until       DATE,
  status           TEXT NOT NULL DEFAULT 'HELD'
                   CHECK (status IN (
                     'PENDING_CONFIRM','HELD','CANCEL_PENDING_APPROVAL','APPROVED_PENDING_PAYOUT',
                     'CONVERTED','FORFEITED','REFUNDED','PARTIALLY_REFUNDED','EXPIRED','REJECTED'
                   )),
  source           TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (source IN ('INTERNAL', 'PUBLIC')),
  method           TEXT DEFAULT 'BANK_TRANSFER',
  evidence         TEXT[] NOT NULL DEFAULT '{}',
  confirmed_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
  confirmed_at     TIMESTAMPTZ,
  rejected_reason  TEXT,
  refunded_amount  BIGINT NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  forfeited_amount BIGINT NOT NULL DEFAULT 0 CHECK (forfeited_amount >= 0),
  cancel_reason    TEXT,
  refund_method    TEXT CHECK (refund_method IS NULL OR refund_method IN ('BANK_TRANSFER', 'CASH')),
  refund_bank_info JSONB,
  refund_evidence  TEXT[] NOT NULL DEFAULT '{}',
  cancel_settlement JSONB,
  note             TEXT,
  created_by       UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contract (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  apartment_id       UUID REFERENCES apartment(id) ON DELETE RESTRICT,
  building_id        UUID REFERENCES building(id) ON DELETE CASCADE,
  primary_tenant_id  UUID REFERENCES tenant(id) ON DELETE RESTRICT,
  start_date         DATE NOT NULL,
  end_date           DATE NOT NULL,
  rent_amount        BIGINT NOT NULL,
  billing_cycle      TEXT NOT NULL DEFAULT 'monthly',
  billing_day        INTEGER NOT NULL CHECK (billing_day BETWEEN 1 AND 31),
  payment_due_days   INTEGER NOT NULL DEFAULT 5,
  deposit_amount     BIGINT NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN (
                       'DRAFT','PENDING_APPROVAL','ACTIVE',
                       'RENEWAL_PENDING','EXPIRED','TERMINATED',
                       'CANCELLED','TERMINATION_PENDING'
                     )),
  parent_contract_id UUID REFERENCES contract(id) ON DELETE SET NULL,
  terminated_at      DATE,
  termination_reason TEXT,
  note               TEXT,
  created_by         UUID REFERENCES app_user(id) ON DELETE SET NULL,
  approved_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  CHECK (end_date > start_date)
);

CREATE TABLE IF NOT EXISTS contract_version (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id    UUID REFERENCES contract(id) ON DELETE CASCADE,
  version_no     INTEGER NOT NULL,
  diff           JSONB,
  effective_from DATE NOT NULL,
  reason         TEXT,
  approved_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contract_occupant (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id  UUID REFERENCES contract(id) ON DELETE CASCADE,
  tenant_id    UUID REFERENCES tenant(id) ON DELETE CASCADE,
  relationship TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contract_service_price (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id    UUID REFERENCES contract(id) ON DELETE CASCADE,
  service_code   TEXT NOT NULL,
  unit_price     BIGINT NOT NULL,
  effective_from DATE NOT NULL,
  UNIQUE (contract_id, service_code, effective_from)
);

CREATE TABLE IF NOT EXISTS contract_request (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID REFERENCES organization(id) ON DELETE CASCADE,
  building_id        UUID REFERENCES building(id) ON DELETE CASCADE,
  contract_id        UUID REFERENCES contract(id) ON DELETE CASCADE,
  type               TEXT NOT NULL CHECK (type IN ('TERMINATION','RENEWAL','TRANSFER_ROOM','AMENDMENT','OTHER')),
  reason             TEXT,
  requested_end_date DATE,
  target_apartment_id UUID REFERENCES apartment(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  note               TEXT,
  created_by         UUID REFERENCES app_user(id) ON DELETE SET NULL,
  approved_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
  approved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Deposits
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
                          'APPROVED_PENDING_PAYOUT','RETURNED',
                          'PARTIALLY_REFUNDED','REFUNDED','TRANSFERRED','DISPUTED'
                        )),
  settlement            JSONB DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposit_transaction (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id     UUID REFERENCES deposit(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('collect', 'deduct', 'refund', 'transfer', 'refund_reversal')),
  category       TEXT,
  method         TEXT,
  amount         BIGINT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
  description    TEXT,
  evidence       TEXT[] DEFAULT '{}',
  reference_code TEXT,
  approved_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  approved_at    TIMESTAMPTZ,
  created_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Audit Log & Attachments
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  before      JSONB,
  after       JSONB,
  ip          INET,
  user_agent  TEXT,
  at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attachment (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_entity TEXT NOT NULL,
  owner_id     UUID NOT NULL,
  storage_path TEXT NOT NULL,
  mime         TEXT,
  size_bytes   BIGINT,
  uploaded_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Announcements & Notifications
CREATE TABLE IF NOT EXISTS announcement (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id        UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  target_scope       TEXT NOT NULL CHECK (target_scope IN ('BUILDING', 'FLOOR', 'APARTMENT')),
  floor_id           UUID REFERENCES floor(id) ON DELETE SET NULL,
  apartment_id       UUID REFERENCES apartment(id) ON DELETE SET NULL,
  audience           JSONB NOT NULL DEFAULT '{}'::jsonb,
  type               TEXT NOT NULL DEFAULT 'ANNOUNCEMENT'
                     CHECK (type IN ('ANNOUNCEMENT', 'MAINTENANCE_NOTICE', 'SECURITY_ALERT', 'UTILITY_INTERRUPTION', 'HOUSE_RULES', 'SYSTEM')),
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  zalo_content       TEXT,
  channels           TEXT[] NOT NULL DEFAULT ARRAY['IN_APP', 'ZALO_MANUAL'],
  status             TEXT NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT', 'SCHEDULED', 'SENT', 'CANCELLED')),
  scheduled_at       TIMESTAMPTZ,
  sent_at            TIMESTAMPTZ,
  manual_sent_at     TIMESTAMPTZ,
  manual_sent_by     UUID REFERENCES app_user(id) ON DELETE SET NULL,
  manual_sent_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  recipient_count    INT NOT NULL DEFAULT 0,
  created_by         UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organization(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES app_user(id) ON DELETE CASCADE,
  announcement_id UUID REFERENCES announcement(id) ON DELETE SET NULL,
  title           VARCHAR(255) NOT NULL,
  content         TEXT NOT NULL,
  type            VARCHAR(50) NOT NULL DEFAULT 'SYSTEM_NOTICE',
  payload         JSONB DEFAULT '{}',
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zalo_group (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id  UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  apartment_id UUID REFERENCES apartment(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL CHECK (scope IN ('BUILDING', 'APARTMENT')),
  name         TEXT NOT NULL,
  invite_link  TEXT,
  note         TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_zalo_group_scope_target CHECK (
    (scope = 'BUILDING' AND apartment_id IS NULL)
    OR (scope = 'APARTMENT' AND apartment_id IS NOT NULL)
  )
);

-- 7. AI Suggestions & Gateway
CREATE TABLE IF NOT EXISTS ai_suggestion (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id           UUID REFERENCES building(id) ON DELETE CASCADE,
  task_type             TEXT NOT NULL
                        CHECK (task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT', 'METER_OCR', 'TICKET_TRIAGE')),
  target_entity         TEXT NOT NULL
                        CHECK (target_entity IN ('tenant', 'contract', 'meter_reading', 'service_request')),
  target_entity_id      UUID,
  input_ref             JSONB NOT NULL DEFAULT '{}'::jsonb,
  output                JSONB NOT NULL DEFAULT '{}'::jsonb,
  edited_output         JSONB,
  warnings              JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence            NUMERIC(4,3)
                        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  needs_human_review    BOOLEAN NOT NULL DEFAULT TRUE,
  accepted_fields_count INT NOT NULL DEFAULT 0 CHECK (accepted_fields_count >= 0),
  total_fields_count    INT NOT NULL DEFAULT 0 CHECK (total_fields_count >= 0),
  model                 TEXT NOT NULL,
  prompt_version        TEXT NOT NULL,
  input_tokens          INT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens         INT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  estimated_cost_vnd    BIGINT NOT NULL DEFAULT 0 CHECK (estimated_cost_vnd >= 0),
  latency_ms            INT CHECK (latency_ms IS NULL OR latency_ms >= 0),
  status                TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'ACCEPTED', 'EDITED_ACCEPTED', 'REJECTED', 'EXPIRED', 'FAILED')),
  error_code            TEXT,
  created_by            UUID REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_by           UUID REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at           TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '72 hours'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_suggestion_building_scope CHECK (
    (task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT'))
    OR (building_id IS NOT NULL)
  )
);

-- 8. Service Requests & Operations
CREATE TABLE IF NOT EXISTS service_request (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id              UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  apartment_id             UUID NOT NULL REFERENCES apartment(id) ON DELETE CASCADE,
  tenant_id                UUID REFERENCES tenant(id) ON DELETE SET NULL,
  tracking_code            TEXT NOT NULL UNIQUE,
  title                    TEXT NOT NULL,
  description              TEXT,
  category                 TEXT NOT NULL DEFAULT 'OTHER'
                           CHECK (category IN ('PLUMBING', 'ELECTRICAL', 'APPLIANCE', 'STRUCTURAL', 'OTHER')),
  priority                 TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status                   TEXT NOT NULL DEFAULT 'NEW'
                           CHECK (status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'REOPENED', 'CLOSED', 'CANCELLED')),
  photos                   TEXT[] DEFAULT '{}',
  assigned_to              UUID REFERENCES app_user(id) ON DELETE SET NULL,
  assigned_at              TIMESTAMPTZ,
  resolved_at              TIMESTAMPTZ,
  resolution_notes         TEXT,
  resolution_photos        TEXT[] DEFAULT '{}',
  resident_rating          INTEGER CHECK (resident_rating BETWEEN 1 AND 5),
  resident_feedback        TEXT,
  sla_target_hours         INTEGER DEFAULT 48,
  sla_breached             BOOLEAN DEFAULT FALSE,
  sla_notified_at          TIMESTAMPTZ,
  location_detail          TEXT,
  preferred_slot           TEXT,
  sla_response_due_at      TIMESTAMPTZ,
  sla_due_at               TIMESTAMPTZ,
  first_responded_at       TIMESTAMPTZ,
  sla_breached_at          TIMESTAMPTZ,
  hold_reason              TEXT,
  next_appointment_at      TIMESTAMPTZ,
  resolution_note          TEXT,
  resolution_images        JSONB NOT NULL DEFAULT '[]'::jsonb,
  reopened_at              TIMESTAMPTZ,
  reopen_reason            TEXT,
  reopen_count             INT NOT NULL DEFAULT 0,
  cancelled_reason         TEXT,
  ai_suggestion_id         UUID REFERENCES ai_suggestion(id) ON DELETE SET NULL,
  ai_triage_status         TEXT CHECK (ai_triage_status IS NULL OR ai_triage_status IN ('SUGGESTED', 'ACCEPTED', 'OVERRIDDEN')),
  ai_summary               TEXT,
  ai_suggested_category    TEXT,
  ai_suggested_priority    TEXT,
  ai_suggested_assignee_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
  ai_confidence            NUMERIC(4,3),
  created_by               UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Utility Meters & Meter Readings
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
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id              UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  meter_id                 UUID NOT NULL REFERENCES meter(id) ON DELETE CASCADE,
  apartment_id             UUID NOT NULL REFERENCES apartment(id) ON DELETE CASCADE,
  contract_id              UUID REFERENCES contract(id) ON DELETE SET NULL,
  period                   TEXT NOT NULL,
  previous_reading         NUMERIC(12,2) NOT NULL DEFAULT 0,
  current_reading          NUMERIC(12,2) NOT NULL,
  consumption              NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_abnormal              BOOLEAN NOT NULL DEFAULT FALSE,
  abnormal_note            TEXT,
  image_url                TEXT,
  status                   TEXT NOT NULL DEFAULT 'CONFIRMED'
                           CHECK (status IN ('DRAFT', 'CONFIRMED', 'FLAGGED')),
  confirmed_by             UUID REFERENCES app_user(id) ON DELETE SET NULL,
  confirmed_at             TIMESTAMPTZ,
  baseline_avg_consumption NUMERIC(12,2),
  source                   TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'AI', 'IOT')),
  ai_suggestion_id         UUID REFERENCES ai_suggestion(id) ON DELETE SET NULL,
  recorded_by              UUID REFERENCES app_user(id) ON DELETE SET NULL,
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (current_reading >= previous_reading)
);

-- 10. Services Catalog & Subscriptions
CREATE TABLE IF NOT EXISTS service_catalog (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id  UUID REFERENCES building(id) ON DELETE SET NULL,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,
  billing_type TEXT NOT NULL CHECK (billing_type IN ('FIXED','METERED','QUANTITY','ONE_TIME')),
  unit         TEXT NOT NULL,
  unit_price   BIGINT NOT NULL DEFAULT 0,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_subscription (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id    UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  apartment_id   UUID REFERENCES apartment(id) ON DELETE CASCADE,
  contract_id    UUID REFERENCES contract(id) ON DELETE SET NULL,
  service_id     UUID NOT NULL REFERENCES service_catalog(id) ON DELETE RESTRICT,
  quantity       NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price     BIGINT NOT NULL,
  vehicle_plates  TEXT[] DEFAULT '{}',
  start_date      DATE NOT NULL,
  end_date        DATE,
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'CANCELLATION_PENDING', 'TERMINATED', 'REJECTED')),
  is_price_locked BOOLEAN NOT NULL DEFAULT FALSE,
  note            TEXT,
  requested_by   UUID REFERENCES app_user(id) ON DELETE SET NULL,
  approved_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  approved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Invoicing, Payments, Adjustments & Credits
CREATE TABLE IF NOT EXISTS invoice (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id          UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  apartment_id         UUID NOT NULL REFERENCES apartment(id) ON DELETE RESTRICT,
  contract_id          UUID REFERENCES contract(id) ON DELETE SET NULL,
  tenant_id            UUID REFERENCES tenant(id) ON DELETE SET NULL,
  invoice_code         TEXT NOT NULL UNIQUE,
  period               TEXT,
  issue_date           DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date             DATE NOT NULL,
  subtotal_amount      BIGINT NOT NULL DEFAULT 0,
  adjustment_amount    BIGINT NOT NULL DEFAULT 0,
  credit_offset_amount BIGINT NOT NULL DEFAULT 0,
  late_fee_amount      BIGINT NOT NULL DEFAULT 0,
  carry_forward_amount BIGINT NOT NULL DEFAULT 0,
  total_amount         BIGINT NOT NULL DEFAULT 0,
  paid_amount          BIGINT NOT NULL DEFAULT 0,
  invoice_type         TEXT NOT NULL DEFAULT 'REGULAR'
                       CHECK (invoice_type IN ('REGULAR', 'LATE_FEE_SETTLEMENT')),
  status               TEXT NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED','VOID')),
  immutable_at         TIMESTAMPTZ,
  note                 TEXT,
  created_by           UUID REFERENCES app_user(id) ON DELETE SET NULL,
  issued_by            UUID REFERENCES app_user(id) ON DELETE SET NULL,
  issued_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT invoice_paid_lte_total_check CHECK (paid_amount <= total_amount)
);

CREATE TABLE IF NOT EXISTS invoice_adjustment (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id       UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  invoice_id        UUID NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  subscription_id   UUID REFERENCES service_subscription(id) ON DELETE SET NULL,
  adjustment_target TEXT NOT NULL DEFAULT 'MANUAL'
                    CHECK (adjustment_target IN ('SERVICE', 'RENT', 'LATE_FEE', 'MANUAL')),
  action_type       TEXT NOT NULL CHECK (action_type IN ('ADJUST', 'VOID')),
  delta_amount      BIGINT NOT NULL DEFAULT 0,
  reason            TEXT NOT NULL,
  formula_meta      JSONB,
  status            TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                    CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
  rejection_reason  TEXT,
  created_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
  approved_by       UUID REFERENCES app_user(id) ON DELETE SET NULL,
  approved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (action_type = 'VOID' AND delta_amount = 0)
    OR (action_type = 'ADJUST' AND delta_amount <> 0)
  )
);

CREATE TABLE IF NOT EXISTS payment (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id        UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  invoice_id         UUID REFERENCES invoice(id) ON DELETE SET NULL,
  contract_id        UUID REFERENCES contract(id) ON DELETE SET NULL,
  tenant_id          UUID REFERENCES tenant(id) ON DELETE SET NULL,
  payment_code       TEXT NOT NULL UNIQUE,
  amount             BIGINT NOT NULL CHECK (amount > 0),
  overpayment_amount BIGINT NOT NULL DEFAULT 0,
  method             TEXT NOT NULL DEFAULT 'BANK_TRANSFER'
                     CHECK (method IN ('BANK_TRANSFER','CASH','CARD','EWALLET','E_WALLET','QR_CODE','OTHER')),
  reference_code     TEXT,
  proof_images       TEXT[] DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'CONFIRMED'
                     CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED')),
  paid_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note               TEXT,
  reported_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
  confirmed_by       UUID REFERENCES app_user(id) ON DELETE SET NULL,
  confirmed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_balance (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id              UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  contract_id              UUID NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  tenant_id                UUID REFERENCES tenant(id) ON DELETE SET NULL,
  subscription_id          UUID REFERENCES service_subscription(id) ON DELETE SET NULL,
  source_invoice_id        UUID REFERENCES invoice(id) ON DELETE SET NULL,
  source_adjustment_id     UUID REFERENCES invoice_adjustment(id) ON DELETE SET NULL,
  source_payment_id        UUID REFERENCES payment(id) ON DELETE SET NULL,
  parent_credit_id         UUID REFERENCES credit_balance(id) ON DELETE SET NULL,
  settlement_deposit_id    UUID REFERENCES deposit(id) ON DELETE SET NULL,
  settlement_refund_amount BIGINT NOT NULL DEFAULT 0
                           CHECK (settlement_refund_amount >= 0 AND settlement_refund_amount <= amount),
  refund_meta              JSONB,
  refunded_at              TIMESTAMPTZ,
  reason_type              TEXT NOT NULL CHECK (reason_type IN (
                             'SERVICE_TERMINATION',
                             'CONTRACT_TERMINATION_RENT',
                             'INVOICE_ADJUSTMENT',
                             'OVERPAYMENT',
                             'TRANSFERRED_IN'
                           )),
  amount                   BIGINT NOT NULL CHECK (amount > 0),
  applied_amount           BIGINT NOT NULL DEFAULT 0
                           CHECK (applied_amount >= 0 AND applied_amount <= amount),
  status                   TEXT NOT NULL DEFAULT 'AVAILABLE'
                           CHECK (status IN (
                             'AVAILABLE',
                             'PARTIALLY_APPLIED',
                             'APPLIED',
                             'PENDING_DIRECT_REFUND',
                             'REFUNDED_DIRECT',
                             'PENDING_SETTLEMENT_PAYOUT',
                             'REFUNDED_IN_SETTLEMENT',
                             'TRANSFERRED',
                             'VOID'
                           )),
  description              TEXT NOT NULL,
  created_by               UUID REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by               UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (applied_amount + settlement_refund_amount <= amount)
);

CREATE TABLE IF NOT EXISTS invoice_line (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES service_subscription(id) ON DELETE SET NULL,
  credit_id       UUID REFERENCES credit_balance(id) ON DELETE SET NULL,
  adjustment_id   UUID REFERENCES invoice_adjustment(id) ON DELETE SET NULL,
  item_type       TEXT NOT NULL CHECK (item_type IN ('RENT','ELECTRICITY','WATER','SERVICE','ADJUSTMENT','LATE_FEE','OTHER')),
  description     TEXT NOT NULL,
  quantity        NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit            TEXT NOT NULL DEFAULT 'tháng',
  unit_price      BIGINT NOT NULL DEFAULT 0,
  amount          BIGINT NOT NULL DEFAULT 0,
  formula_meta    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS late_fee_accrual_tracker (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contract_id           UUID NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  invoice_id            UUID NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  accrued_total         BIGINT NOT NULL DEFAULT 0 CHECK (accrued_total >= 0),
  chargeable_days       INT NOT NULL DEFAULT 0 CHECK (chargeable_days >= 0),
  as_of_date            DATE NOT NULL,
  carried_to_invoice_id UUID REFERENCES invoice(id) ON DELETE SET NULL,
  carried_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS receivable (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  contract_id UUID REFERENCES contract(id) ON DELETE SET NULL,
  tenant_id   UUID REFERENCES tenant(id) ON DELETE SET NULL,
  invoice_id  UUID REFERENCES invoice(id) ON DELETE SET NULL,
  deposit_id  UUID REFERENCES deposit(id) ON DELETE SET NULL,
  type        TEXT NOT NULL DEFAULT 'INVOICE_DEBT'
              CHECK (type IN ('INVOICE_DEBT','RECEIVABLE_AFTER_MOVE_OUT','OTHER')),
  amount      BIGINT NOT NULL CHECK (amount > 0),
  paid_amount BIGINT NOT NULL DEFAULT 0,
  due_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  status      TEXT NOT NULL DEFAULT 'OPEN'
              CHECK (status IN ('OPEN','PARTIALLY_PAID','PAID','WRITTEN_OFF')),
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. System Settings & Infrastructure (Cron, Idempotency)
CREATE TABLE IF NOT EXISTS system_setting (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, key)
);

CREATE TABLE IF NOT EXISTS cron_job_run (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name      TEXT NOT NULL,
  run_date      DATE NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  attempt_count INT NOT NULL DEFAULT 1,
  duration_ms   INT,
  summary       JSONB,
  error_message TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS idempotency_key (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  scope_key     TEXT NOT NULL,
  method        TEXT NOT NULL,
  route_path    TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  response_code INT,
  response_body JSONB,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, scope_key, method, route_path, idem_key)
);
