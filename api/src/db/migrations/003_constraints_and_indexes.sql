-- ============================================================================
-- 003_constraints_and_indexes.sql
-- Consolidated Constraints and Indexes for ResiHub
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Exclusion Constraints
-- ----------------------------------------------------------------------------
-- Contract overlap guard (using btree_gist extension enabled in 001)
-- Covers ACTIVE, RENEWAL_PENDING, and TERMINATION_PENDING states (migration 039)
ALTER TABLE contract DROP CONSTRAINT IF EXISTS contract_no_overlap;

ALTER TABLE contract ADD CONSTRAINT contract_no_overlap
  EXCLUDE USING gist (
    apartment_id WITH =,
    daterange(start_date, COALESCE(terminated_at, end_date), '[)') WITH &&
  )
  WHERE (
    status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
    AND COALESCE(terminated_at, end_date) > start_date
  );

-- ----------------------------------------------------------------------------
-- 2. Domain & Partial Unique Indexes
-- ----------------------------------------------------------------------------
-- Person national ID uniqueness per organization (CCCD / Passport) (migration 015)
CREATE UNIQUE INDEX IF NOT EXISTS uq_person_id_number_per_org
  ON person (org_id, id_number)
  WHERE id_number IS NOT NULL AND id_number <> '';

-- Contract room transfer request uniqueness (only one open request per contract) (migration 047)
CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_open_room_transfer
  ON contract_request(contract_id)
  WHERE type = 'TRANSFER_ROOM' AND status IN ('PENDING', 'APPROVED');

-- Service catalog code uniqueness (org default vs building override) (migration 048)
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_catalog_org_default_code
  ON service_catalog (org_id, lower(code))
  WHERE building_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_catalog_building_code
  ON service_catalog (org_id, building_id, lower(code))
  WHERE building_id IS NOT NULL;

-- Pending adjustment unique guards (migration 048)
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_adj_pending_sub
  ON invoice_adjustment(invoice_id, subscription_id)
  WHERE subscription_id IS NOT NULL AND status = 'PENDING_APPROVAL';

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_adj_pending_rent
  ON invoice_adjustment(invoice_id)
  WHERE adjustment_target = 'RENT' AND status = 'PENDING_APPROVAL';

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_adj_pending_late_fee
  ON invoice_adjustment(invoice_id)
  WHERE adjustment_target = 'LATE_FEE' AND status = 'PENDING_APPROVAL';

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_adj_pending_void
  ON invoice_adjustment(invoice_id)
  WHERE action_type = 'VOID' AND status = 'PENDING_APPROVAL';

-- Credit balance unique source guards (migration 048)
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_balance_unique_adj
  ON credit_balance(source_adjustment_id)
  WHERE source_adjustment_id IS NOT NULL AND status <> 'VOID';

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_balance_unique_payment
  ON credit_balance(source_payment_id)
  WHERE source_payment_id IS NOT NULL AND status <> 'VOID';

-- Invoice unique active period guards (migration 048 & 055)
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_unique_active_period
  ON invoice (contract_id, period)
  WHERE status NOT IN ('CANCELLED', 'VOID', 'LATE_FEE_SETTLEMENT');

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_unique_active_lf_settlement
  ON invoice(contract_id)
  WHERE contract_id IS NOT NULL
    AND invoice_type = 'LATE_FEE_SETTLEMENT'
    AND status <> 'VOID';

-- Service request tracking code index (migration 050)
CREATE UNIQUE INDEX IF NOT EXISTS ux_service_request_tracking_code
  ON service_request(tracking_code);

-- Zalo group target name unique index (migration 050)
CREATE UNIQUE INDEX IF NOT EXISTS ux_zalo_group_target_name
  ON zalo_group (
    building_id,
    COALESCE(apartment_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(name))
  );

-- Meter reading per-contract turnover guards (migration 052)
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_reading_period_contract
  ON meter_reading (meter_id, period, contract_id)
  WHERE contract_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_reading_period_null_contract
  ON meter_reading (meter_id, period)
  WHERE contract_id IS NULL;

-- Late fee tracker open invoice uniqueness (migration 055)
CREATE UNIQUE INDEX IF NOT EXISTS uq_lf_tracker_open_invoice
  ON late_fee_accrual_tracker(invoice_id)
  WHERE carried_to_invoice_id IS NULL;

-- ----------------------------------------------------------------------------
-- 3. Performance & Foreign Key Secondary Indexes
-- ----------------------------------------------------------------------------

-- Person & Users
CREATE INDEX IF NOT EXISTS idx_person_org_phone ON person(org_id, phone);
CREATE INDEX IF NOT EXISTS idx_person_created_by ON person(created_by);
CREATE INDEX IF NOT EXISTS idx_app_user_person_id ON app_user(person_id);
CREATE INDEX IF NOT EXISTS idx_user_role_user ON user_role(user_id);
CREATE INDEX IF NOT EXISTS idx_user_role_user_building ON user_role(user_id, building_id);

-- Owner
CREATE INDEX IF NOT EXISTS idx_owner_person_id ON owner(person_id);
CREATE INDEX IF NOT EXISTS idx_owner_org_person ON owner(org_id, person_id);

-- Building, Floor, Zone & Apartment
CREATE INDEX IF NOT EXISTS idx_building_org_id ON building(org_id);
CREATE INDEX IF NOT EXISTS idx_building_owner_id ON building(owner_id);
CREATE INDEX IF NOT EXISTS idx_floor_building ON floor(building_id, level);
CREATE INDEX IF NOT EXISTS idx_apartment_building_id ON apartment(building_id);
CREATE INDEX IF NOT EXISTS idx_apartment_building_status ON apartment(building_id, status);

-- Tenant
CREATE INDEX IF NOT EXISTS idx_tenant_person_id ON tenant(person_id);
CREATE INDEX IF NOT EXISTS idx_tenant_org_id ON tenant(org_id);
CREATE INDEX IF NOT EXISTS idx_tenant_created_at ON tenant(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_created_by ON tenant(created_by);
CREATE INDEX IF NOT EXISTS idx_tenant_desired_building_id ON tenant(desired_building_id);
CREATE INDEX IF NOT EXISTS idx_tenant_desired_building_status ON tenant(desired_building_id, status);

-- Reservation
CREATE INDEX IF NOT EXISTS idx_reservation_apartment ON reservation(apartment_id, status);
CREATE INDEX IF NOT EXISTS idx_reservation_phone ON reservation(phone);
CREATE INDEX IF NOT EXISTS idx_reservation_building_status ON reservation(building_id, status);
CREATE INDEX IF NOT EXISTS idx_reservation_phone_building ON reservation(phone, building_id);

-- Contract, Versions, Occupants & Requests
CREATE INDEX IF NOT EXISTS idx_contract_building_id ON contract(building_id);
CREATE INDEX IF NOT EXISTS idx_contract_apartment_status ON contract(apartment_id, status);
CREATE INDEX IF NOT EXISTS idx_contract_status_dates ON contract(status, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_contract_primary_tenant_id ON contract(primary_tenant_id);
CREATE INDEX IF NOT EXISTS idx_contract_created_at ON contract(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contract_parent_contract_id ON contract(parent_contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_occupant_contract_id ON contract_occupant(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_occupant_tenant_id ON contract_occupant(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contract_request_status ON contract_request(status, building_id);

-- Deposit & Transactions
CREATE INDEX IF NOT EXISTS idx_deposit_contract ON deposit(contract_id, status);
CREATE INDEX IF NOT EXISTS idx_deposit_contract_id ON deposit(contract_id);
CREATE INDEX IF NOT EXISTS idx_deposit_created_at ON deposit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposit_txn_deposit_id ON deposit_transaction(deposit_id, created_at DESC);

-- Audit Log
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_at_desc ON audit_log(at DESC);

-- Notification & Announcements
CREATE INDEX IF NOT EXISTS idx_notification_user_read ON notification(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notification_org ON notification(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_announcement_id ON notification(announcement_id);
CREATE INDEX IF NOT EXISTS idx_announcement_building_status ON announcement(building_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_announcement_scheduled_due ON announcement(status, scheduled_at) WHERE status = 'SCHEDULED';

-- Service Request
CREATE INDEX IF NOT EXISTS idx_service_request_org_status ON service_request(org_id, status);
CREATE INDEX IF NOT EXISTS idx_service_request_building_status ON service_request(building_id, status);
CREATE INDEX IF NOT EXISTS idx_service_request_apartment ON service_request(apartment_id, status);
CREATE INDEX IF NOT EXISTS idx_service_request_created_by ON service_request(created_by);
CREATE INDEX IF NOT EXISTS idx_service_request_sla_due ON service_request(status, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_service_request_ai_triage_status ON service_request(building_id, ai_triage_status) WHERE ai_triage_status IS NOT NULL;

-- Meters & Readings
CREATE INDEX IF NOT EXISTS idx_meter_building ON meter(building_id, meter_type);
CREATE INDEX IF NOT EXISTS idx_meter_apartment ON meter(apartment_id, meter_type);
CREATE INDEX IF NOT EXISTS idx_meter_reading_period ON meter_reading(building_id, period);
CREATE INDEX IF NOT EXISTS idx_meter_reading_status_period ON meter_reading (building_id, period, status);
CREATE INDEX IF NOT EXISTS idx_meter_reading_contract_period ON meter_reading (contract_id, period);
CREATE INDEX IF NOT EXISTS idx_meter_reading_meter_period_desc ON meter_reading(meter_id, period DESC, current_reading DESC, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_meter_reading_ai_suggestion ON meter_reading(ai_suggestion_id) WHERE ai_suggestion_id IS NOT NULL;

-- Service Subscriptions & Finance
CREATE INDEX IF NOT EXISTS idx_csp_contract_effective ON contract_service_price(contract_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_service_sub_building ON service_subscription(building_id, status);
CREATE INDEX IF NOT EXISTS idx_service_sub_contract ON service_subscription(contract_id, status);
CREATE INDEX IF NOT EXISTS idx_invoice_building_period ON invoice(building_id, period, status);
CREATE INDEX IF NOT EXISTS idx_invoice_org_period_status ON invoice(org_id, period, status);
CREATE INDEX IF NOT EXISTS idx_invoice_apartment_period ON invoice(apartment_id, period);
CREATE INDEX IF NOT EXISTS idx_invoice_contract ON invoice(contract_id, period);
CREATE INDEX IF NOT EXISTS idx_invoice_line_invoice_id ON invoice_line(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_invoice_type ON invoice_line(invoice_id, item_type);
CREATE INDEX IF NOT EXISTS idx_invoice_line_subscription_id ON invoice_line(subscription_id) WHERE subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_line_reading_id ON invoice_line((formula_meta->>'reading_id')) WHERE (formula_meta->>'reading_id') IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_adjustment_invoice_id ON invoice_adjustment(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_building ON payment(building_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_org_status_paid_at ON payment(org_id, status, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_invoice_id ON payment(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_contract_id ON payment(contract_id);
CREATE INDEX IF NOT EXISTS idx_receivable_building ON receivable(building_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_receivable_org_status_due ON receivable(org_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_receivable_invoice_id ON receivable(invoice_id);
CREATE INDEX IF NOT EXISTS idx_receivable_contract_id ON receivable(contract_id);
CREATE INDEX IF NOT EXISTS idx_credit_balance_contract_avail ON credit_balance(contract_id, created_at) WHERE status IN ('AVAILABLE', 'PARTIALLY_APPLIED');

-- Late fee tracker
CREATE INDEX IF NOT EXISTS idx_lf_tracker_contract ON late_fee_accrual_tracker (contract_id);
CREATE INDEX IF NOT EXISTS idx_lf_tracker_invoice ON late_fee_accrual_tracker (invoice_id);
CREATE INDEX IF NOT EXISTS idx_lf_tracker_pending ON late_fee_accrual_tracker (contract_id, invoice_id) WHERE carried_to_invoice_id IS NULL;

-- System & AI
CREATE INDEX IF NOT EXISTS idx_idempotency_key_expires ON idempotency_key(expires_at);
CREATE INDEX IF NOT EXISTS idx_cron_job_run_date ON cron_job_run (job_name, run_date);
CREATE INDEX IF NOT EXISTS idx_zalo_group_building_scope ON zalo_group(building_id, scope, is_active);
CREATE INDEX IF NOT EXISTS idx_zalo_group_apartment ON zalo_group(apartment_id) WHERE apartment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_org_created ON ai_suggestion(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_building_task ON ai_suggestion(building_id, task_type, status);
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_target ON ai_suggestion(target_entity, target_entity_id) WHERE target_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_pending_exp ON ai_suggestion(status, expires_at) WHERE status = 'PENDING';
