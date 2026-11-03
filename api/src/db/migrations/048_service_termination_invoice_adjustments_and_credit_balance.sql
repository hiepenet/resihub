-- 048_service_termination_invoice_adjustments_and_credit_balance.sql
-- Module M07/M09/M10/M06:
--   1. Chuẩn hóa service_catalog partial unique indexes (bỏ UNIQUE (org_id, code) cũ).
--   2. Chuẩn hóa service_subscription.status -> 'TERMINATED', cờ is_price_locked (trigger auto-lock).
--   3. Tạo bảng invoice_adjustment & partial unique indexes chống sinh trùng đề nghị chờ duyệt.
--   4. Tạo bảng credit_balance & partial unique indexes chống nhân đôi.
--   5. Backfill tiền nộp thừa CONFIRMED lịch sử vào credit_balance trước khi kẹp invoice.paid_amount.
--   6. Bổ sung invoice.credit_offset_amount, kẹp paid_amount, thêm invoice_paid_lte_total_check.
--   7. Chuẩn hóa invoice.status -> 'ADJUSTED', 'VOID', khử trùng DRAFT, thêm idx_invoice_unique_active_period.
--   8. Bổ sung cột invoice_line (subscription_id, credit_id, adjustment_id, formula_meta).
--   9. Bật ENABLE & FORCE ROW LEVEL SECURITY trên invoice_adjustment, credit_balance, contract_service_price.
--  10. Cập nhật ma trận chính sách RLS 2 lớp (PRD Mục 6.2, can_select_attachment, 12-entity rls_audit_log_select).
--  11. Bộ 9 hàm SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off + GRANT TO resihub_app.
--
-- ============================================================================
-- ROLLBACK SQL INSTRUCTIONS (PRD Mục 14.5):
-- Để rollback migration 048 về trạng thái migration 047:
--   DROP FUNCTION IF EXISTS fn_recommit_returned_settlement_credits(UUID);
--   DROP FUNCTION IF EXISTS fn_restore_returned_settlement_credits(UUID, TEXT);
--   DROP FUNCTION IF EXISTS fn_update_deposit_refund_bank_info(UUID, JSONB);
--   -- Khôi phục fn_apply_deposit_settlement_accounting từ 045_m06_owner_approval_and_returned_rls.sql
--   DROP FUNCTION IF EXISTS fn_resolve_credit_refund(UUID, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS fn_resolve_invoice_adjustment(UUID, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS fn_notify_building_finance_actors(UUID, TEXT, TEXT, TEXT, JSONB, UUID);
--   DROP FUNCTION IF EXISTS fn_lock_invoices_for_authorized_viewer(UUID, UUID);
--   DROP FUNCTION IF EXISTS fn_get_finance_resource_scope(TEXT, UUID);
--   DROP TABLE IF EXISTS invoice_adjustment CASCADE;
--   DROP TABLE IF EXISTS credit_balance CASCADE;
--   ALTER TABLE invoice DROP COLUMN IF EXISTS credit_offset_amount;
--   ALTER TABLE invoice DROP CONSTRAINT IF EXISTS invoice_paid_lte_total_check;
--   ALTER TABLE service_subscription DROP COLUMN IF EXISTS is_price_locked;
--   ALTER TABLE invoice_line DROP COLUMN IF EXISTS subscription_id, DROP COLUMN IF EXISTS credit_id, DROP COLUMN IF EXISTS adjustment_id, DROP COLUMN IF EXISTS formula_meta;
--   DROP INDEX IF EXISTS idx_service_catalog_org_default_code;
--   DROP INDEX IF EXISTS idx_service_catalog_building_code;
--   ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_org_id_code_key UNIQUE (org_id, code);
--   DROP INDEX IF EXISTS idx_invoice_unique_active_period;
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. CHUẨN HÓA BẢNG GIÁ DỊCH VỤ TRÊN service_catalog (FR-065)
-- ============================================================================
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'service_catalog'::regclass
      AND contype = 'u'
      AND conname = 'service_catalog_org_id_code_key'
  LOOP
    EXECUTE format('ALTER TABLE service_catalog DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_catalog_org_default_code
  ON service_catalog(org_id, code)
  WHERE building_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_catalog_building_code
  ON service_catalog(org_id, building_id, code)
  WHERE building_id IS NOT NULL;

-- ============================================================================
-- 2. CHUẨN HÓA service_subscription.status -> 'TERMINATED' & is_price_locked
-- ============================================================================
ALTER TABLE service_subscription
  ADD COLUMN IF NOT EXISTS is_price_locked BOOLEAN;

DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'service_subscription'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE service_subscription DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

UPDATE service_subscription
SET status = 'TERMINATED'
WHERE status = 'CANCELLED';

UPDATE service_subscription ss
SET is_price_locked = CASE
  WHEN ss.status = 'TERMINATED' AND ss.end_date IS NOT NULL THEN TRUE
  ELSE COALESCE((SELECT sc.unit_price <> ss.unit_price FROM service_catalog sc WHERE sc.id = ss.service_id), FALSE)
END
WHERE ss.is_price_locked IS NULL;

ALTER TABLE service_subscription
  ALTER COLUMN is_price_locked SET NOT NULL;

CREATE OR REPLACE FUNCTION trg_normalize_legacy_subscription_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'CANCELLED' THEN
    NEW.status := 'TERMINATED';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.is_price_locked IS NULL THEN
    NEW.is_price_locked := CASE
      WHEN NEW.status = 'TERMINATED' AND NEW.end_date IS NOT NULL THEN TRUE
      ELSE COALESCE((SELECT sc.unit_price <> NEW.unit_price FROM service_catalog sc WHERE sc.id = NEW.service_id), FALSE)
    END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normalize_subscription_status ON service_subscription;
CREATE TRIGGER trg_normalize_subscription_status
  BEFORE INSERT OR UPDATE ON service_subscription
  FOR EACH ROW
  EXECUTE FUNCTION trg_normalize_legacy_subscription_status();

ALTER TABLE service_subscription
  ADD CONSTRAINT service_subscription_status_check
  CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'CANCELLATION_PENDING', 'TERMINATED', 'REJECTED'));

-- ============================================================================
-- 3. TẠO BẢNG invoice_adjustment (FR-034, FR-035, FR-064)
-- ============================================================================
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

-- ============================================================================
-- 4. TẠO BẢNG credit_balance (FR-033, FR-040)
-- ============================================================================
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
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_balance_unique_adj
  ON credit_balance(source_adjustment_id)
  WHERE source_adjustment_id IS NOT NULL AND status <> 'VOID';

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_balance_unique_payment
  ON credit_balance(source_payment_id)
  WHERE source_payment_id IS NOT NULL AND status <> 'VOID';

CREATE INDEX IF NOT EXISTS idx_credit_balance_contract_avail
  ON credit_balance(contract_id, created_at)
  WHERE status IN ('AVAILABLE', 'PARTIALLY_APPLIED');

-- ============================================================================
-- 5. BACKFILL THANH TOÁN THỪA LỊCH SỬ SANG credit_balance (TRƯỚC KHI KẸP PAID)
-- ============================================================================
INSERT INTO credit_balance (
  org_id,
  building_id,
  contract_id,
  tenant_id,
  source_invoice_id,
  source_payment_id,
  reason_type,
  amount,
  status,
  description,
  created_at,
  updated_at
)
SELECT
  p.org_id,
  p.building_id,
  p.contract_id,
  p.tenant_id,
  p.invoice_id,
  p.id AS source_payment_id,
  'OVERPAYMENT',
  p.overpayment_amount,
  'AVAILABLE',
  'Backfill tiền nộp thừa từ thanh toán ' || p.payment_code,
  p.paid_at,
  p.paid_at
FROM payment p
JOIN invoice i ON i.id = p.invoice_id
WHERE p.status = 'CONFIRMED'
  AND p.overpayment_amount > 0
  AND i.contract_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO credit_balance (
  org_id,
  building_id,
  contract_id,
  tenant_id,
  source_invoice_id,
  reason_type,
  amount,
  status,
  description,
  created_at,
  updated_at
)
SELECT
  i.org_id,
  i.building_id,
  i.contract_id,
  i.tenant_id,
  i.id,
  'OVERPAYMENT',
  (i.paid_amount - i.total_amount),
  'AVAILABLE',
  'Backfill tiền nộp thừa từ hóa đơn ' || i.invoice_code,
  i.updated_at,
  i.updated_at
FROM invoice i
WHERE i.contract_id IS NOT NULL
  AND i.paid_amount > i.total_amount
  AND NOT EXISTS (
    SELECT 1 FROM credit_balance cb
    WHERE cb.source_invoice_id = i.id
      AND cb.reason_type = 'OVERPAYMENT'
  )
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 6. KẸP invoice.paid_amount, THÊM credit_offset_amount & RÀNG BUỘC TOÀN VẸN
-- ============================================================================
ALTER TABLE invoice
  ADD COLUMN IF NOT EXISTS credit_offset_amount BIGINT NOT NULL DEFAULT 0
  CHECK (credit_offset_amount >= 0);

UPDATE invoice
SET paid_amount = LEAST(GREATEST(0, paid_amount), GREATEST(0, total_amount))
WHERE paid_amount > total_amount OR paid_amount < 0;

DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'invoice'::regclass
      AND contype = 'c'
      AND conname = 'invoice_paid_lte_total_check'
  LOOP
    EXECUTE format('ALTER TABLE invoice DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE invoice
  ADD CONSTRAINT invoice_paid_lte_total_check
  CHECK (paid_amount >= 0 AND total_amount >= 0 AND paid_amount <= total_amount);

-- ============================================================================
-- 7. CHUẨN HÓA invoice.status -> 'ADJUSTED', 'VOID' & idx_invoice_unique_active_period
-- ============================================================================
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'invoice'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE invoice DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

UPDATE invoice
SET status = 'VOID'
WHERE status = 'CANCELLED';

CREATE OR REPLACE FUNCTION trg_normalize_legacy_invoice_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'CANCELLED' THEN
    NEW.status := 'VOID';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normalize_invoice_status ON invoice;
CREATE TRIGGER trg_normalize_invoice_status
  BEFORE INSERT OR UPDATE OF status ON invoice
  FOR EACH ROW
  EXECUTE FUNCTION trg_normalize_legacy_invoice_status();

ALTER TABLE invoice
  ADD CONSTRAINT invoice_status_check
  CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'ADJUSTED', 'VOID'));

-- Khử trùng an toàn các bản nháp DRAFT chưa thu tiền bị trùng (contract_id, period)
WITH ranked_drafts AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY contract_id, period
           ORDER BY created_at DESC
         ) AS rn
  FROM invoice
  WHERE contract_id IS NOT NULL
    AND status <> 'VOID'
)
UPDATE invoice
SET status = 'VOID', updated_at = NOW()
WHERE id IN (
  SELECT id FROM ranked_drafts WHERE rn > 1
)
AND status = 'DRAFT' AND paid_amount = 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_unique_active_period
  ON invoice(contract_id, period)
  WHERE contract_id IS NOT NULL AND status <> 'VOID';

-- ============================================================================
-- 8. BỔ SUNG CỘT CHO invoice_line
-- ============================================================================
ALTER TABLE invoice_line
  ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES service_subscription(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS credit_id UUID REFERENCES credit_balance(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS adjustment_id UUID REFERENCES invoice_adjustment(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS formula_meta JSONB;

-- ============================================================================
-- 9. ENABLE & FORCE RLS + GRANTS
-- ============================================================================
GRANT ALL PRIVILEGES ON TABLE invoice_adjustment TO resihub_app;
GRANT ALL PRIVILEGES ON TABLE credit_balance TO resihub_app;

ALTER TABLE invoice_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_adjustment FORCE ROW LEVEL SECURITY;

ALTER TABLE credit_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_balance FORCE ROW LEVEL SECURITY;

ALTER TABLE contract_service_price FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- 10. MA TRẬN PHÂN QUYỀN RLS 2 LỚP (PRD Mục 6.2)
-- ============================================================================

-- 10a. service_catalog
DROP POLICY IF EXISTS rls_service_catalog_select ON service_catalog;
CREATE POLICY rls_service_catalog_select ON service_catalog FOR SELECT USING (
  org_id = get_current_user_org_id()
  AND (
    is_org_admin()
    OR building_id IS NULL
    OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
    OR building_id IN (
      SELECT c.building_id FROM contract c
      WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
    )
  )
);

DROP POLICY IF EXISTS rls_service_catalog_modify ON service_catalog;
CREATE POLICY rls_service_catalog_modify ON service_catalog FOR ALL
USING (
  is_manager()
  AND org_id = get_current_user_org_id()
  AND (building_id IS NULL OR building_id IN (SELECT building_id FROM get_manager_building_ids()))
)
WITH CHECK (
  is_manager()
  AND org_id = get_current_user_org_id()
  AND (building_id IS NULL OR building_id IN (SELECT building_id FROM get_manager_building_ids()))
);

-- 10b. service_subscription
DROP POLICY IF EXISTS rls_service_sub_insert ON service_subscription;
CREATE POLICY rls_service_sub_insert ON service_subscription FOR INSERT WITH CHECK (
  building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR requested_by = get_current_user_id()
);

DROP POLICY IF EXISTS rls_service_sub_update ON service_subscription;
CREATE POLICY rls_service_sub_update ON service_subscription FOR UPDATE USING (
  building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
) WITH CHECK (
  building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_service_sub_delete ON service_subscription;
CREATE POLICY rls_service_sub_delete ON service_subscription FOR DELETE USING (
  building_id IN (SELECT building_id FROM get_manager_building_ids())
  AND status IN ('PENDING_APPROVAL', 'TERMINATED')
);

-- 10c. contract_service_price
DROP POLICY IF EXISTS rls_contract_service_price_modify ON contract_service_price;
CREATE POLICY rls_contract_service_price_modify ON contract_service_price FOR ALL
USING (
  is_manager()
  AND contract_id IN (
    SELECT id FROM contract
    WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
)
WITH CHECK (
  is_manager()
  AND contract_id IN (
    SELECT id FROM contract
    WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);

-- 10d. invoice
DROP POLICY IF EXISTS rls_invoice_select ON invoice;
CREATE POLICY rls_invoice_select ON invoice FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR (
    status <> 'DRAFT'
    AND (
      contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
      OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
    )
  )
);

DROP POLICY IF EXISTS rls_invoice_modify ON invoice;
DROP POLICY IF EXISTS rls_invoice_insert ON invoice;
DROP POLICY IF EXISTS rls_invoice_update ON invoice;

CREATE POLICY rls_invoice_insert ON invoice FOR INSERT WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

CREATE POLICY rls_invoice_update ON invoice FOR UPDATE USING (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
) WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

-- 10e. invoice_line
DROP POLICY IF EXISTS rls_invoice_line_modify ON invoice_line;
DROP POLICY IF EXISTS rls_invoice_line_insert ON invoice_line;
DROP POLICY IF EXISTS rls_invoice_line_update ON invoice_line;
DROP POLICY IF EXISTS rls_invoice_line_delete ON invoice_line;

CREATE POLICY rls_invoice_line_insert ON invoice_line FOR INSERT WITH CHECK (
  is_manager()
  AND invoice_id IN (
    SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);

CREATE POLICY rls_invoice_line_update ON invoice_line FOR UPDATE USING (
  is_manager()
  AND invoice_id IN (
    SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
) WITH CHECK (
  is_manager()
  AND invoice_id IN (
    SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);

CREATE POLICY rls_invoice_line_delete ON invoice_line FOR DELETE USING (
  is_manager()
  AND EXISTS (
    SELECT 1 FROM invoice i
    WHERE i.id = invoice_line.invoice_id
      AND i.status = 'DRAFT'
      AND i.building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);

-- 10f. invoice_adjustment
DROP POLICY IF EXISTS rls_invoice_adjustment_select ON invoice_adjustment;
CREATE POLICY rls_invoice_adjustment_select ON invoice_adjustment FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR (
    status = 'APPROVED'
    AND invoice_id IN (
      SELECT id FROM invoice
      WHERE contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
         OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
    )
  )
);

DROP POLICY IF EXISTS rls_invoice_adjustment_insert ON invoice_adjustment;
CREATE POLICY rls_invoice_adjustment_insert ON invoice_adjustment FOR INSERT WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

DROP POLICY IF EXISTS rls_invoice_adjustment_update ON invoice_adjustment;
CREATE POLICY rls_invoice_adjustment_update ON invoice_adjustment FOR UPDATE USING (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
) WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

-- 10g. credit_balance
DROP POLICY IF EXISTS rls_credit_balance_select ON credit_balance;
CREATE POLICY rls_credit_balance_select ON credit_balance FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

DROP POLICY IF EXISTS rls_credit_balance_insert ON credit_balance;
CREATE POLICY rls_credit_balance_insert ON credit_balance FOR INSERT WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

DROP POLICY IF EXISTS rls_credit_balance_update ON credit_balance;
CREATE POLICY rls_credit_balance_update ON credit_balance FOR UPDATE USING (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
) WITH CHECK (
  is_manager()
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

-- 10h. payment
DROP POLICY IF EXISTS rls_payment_insert ON payment;
CREATE POLICY rls_payment_insert ON payment FOR INSERT WITH CHECK (
  (is_manager() AND building_id IN (SELECT building_id FROM get_manager_building_ids()))
  OR (
    is_resident()
    AND reported_by = get_current_user_id()
    AND invoice_id IN (
      SELECT id FROM invoice
      WHERE status <> 'DRAFT'
        AND (
          contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
        )
    )
  )
);

DROP POLICY IF EXISTS rls_payment_update ON payment;
CREATE POLICY rls_payment_update ON payment FOR UPDATE USING (
  is_manager() AND building_id IN (SELECT building_id FROM get_manager_building_ids())
) WITH CHECK (
  is_manager() AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

-- 10i. receivable
DROP POLICY IF EXISTS rls_receivable_modify ON receivable;
DROP POLICY IF EXISTS rls_receivable_insert ON receivable;
DROP POLICY IF EXISTS rls_receivable_update ON receivable;

CREATE POLICY rls_receivable_insert ON receivable FOR INSERT WITH CHECK (
  is_manager() AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

CREATE POLICY rls_receivable_update ON receivable FOR UPDATE USING (
  is_manager() AND building_id IN (SELECT building_id FROM get_manager_building_ids())
) WITH CHECK (
  is_manager() AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

-- 10j. deposit (mở rộng RETURNED cho nhánh OWNER / SYS_ADMIN fallback)
DROP POLICY IF EXISTS rls_deposit_update ON deposit;
CREATE POLICY rls_deposit_update ON deposit FOR UPDATE
  USING (
    (
      is_manager()
      AND contract_id IN (
        SELECT id FROM contract
        WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
      )
    )
    OR (
      status IN ('PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'DISPUTED')
      AND contract_id IN (
        SELECT c.id FROM contract c
        WHERE (is_owner() AND c.building_id IN (SELECT building_id FROM get_owner_building_ids()))
           OR (is_org_admin() AND NOT building_has_active_owner(c.building_id))
      )
    )
  )
  WITH CHECK (
    (
      is_manager()
      AND contract_id IN (
        SELECT id FROM contract
        WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
      )
    )
    OR (
      status IN (
        'SETTLEMENT_DRAFT',
        'PENDING_APPROVAL',
        'APPROVED_PENDING_PAYOUT',
        'PARTIALLY_REFUNDED',
        'REFUNDED',
        'DEDUCTED_FULL',
        'RETURNED'
      )
      AND contract_id IN (
        SELECT c.id FROM contract c
        WHERE (is_owner() AND c.building_id IN (SELECT building_id FROM get_owner_building_ids()))
           OR (is_org_admin() AND NOT building_has_active_owner(c.building_id))
      )
    )
  );

-- 10k. can_select_attachment (bổ sung credit_balance, invoice, invoice_adjustment & bảo toàn PII person)
CREATE OR REPLACE FUNCTION can_select_attachment(p_owner_entity TEXT, p_owner_id UUID, p_uploaded_by UUID)
RETURNS BOOLEAN AS $$
BEGIN
  IF is_org_admin() OR p_uploaded_by = get_current_user_id() THEN
    RETURN TRUE;
  END IF;

  IF is_manager() OR is_owner() THEN
    IF p_owner_entity = 'contract' THEN
      RETURN EXISTS (
        SELECT 1 FROM contract c
        WHERE c.id = p_owner_id
          AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'person' THEN
      RETURN is_manager() AND EXISTS (
        SELECT 1 FROM person p
        WHERE p.id = p_owner_id
          AND can_select_person(p.id, p.org_id, p.phone, p.created_by)
      );
    ELSIF p_owner_entity = 'tenant' THEN
      RETURN is_manager() AND EXISTS (
        SELECT 1 FROM tenant t
        WHERE t.id = p_owner_id
          AND can_select_tenant(t.id, t.person_id, t.org_id, t.created_by, t.desired_building_id)
      );
    ELSIF p_owner_entity = 'deposit' THEN
      RETURN EXISTS (
        SELECT 1 FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        WHERE d.id = p_owner_id
          AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'reservation' THEN
      RETURN EXISTS (
        SELECT 1 FROM reservation r
        WHERE r.id = p_owner_id
          AND r.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'apartment' THEN
      RETURN EXISTS (
        SELECT 1 FROM apartment a
        WHERE a.id = p_owner_id
          AND a.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'service_request' THEN
      RETURN EXISTS (
        SELECT 1 FROM service_request sr
        WHERE sr.id = p_owner_id
          AND sr.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'payment' THEN
      RETURN EXISTS (
        SELECT 1 FROM payment pay
        WHERE pay.id = p_owner_id
          AND pay.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'meter_reading' THEN
      RETURN EXISTS (
        SELECT 1 FROM meter_reading mr
        WHERE mr.id = p_owner_id
          AND mr.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'credit_balance' THEN
      RETURN EXISTS (
        SELECT 1 FROM credit_balance cb
        WHERE cb.id = p_owner_id
          AND cb.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'invoice' THEN
      RETURN EXISTS (
        SELECT 1 FROM invoice i
        WHERE i.id = p_owner_id
          AND i.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'invoice_adjustment' THEN
      RETURN EXISTS (
        SELECT 1 FROM invoice_adjustment ia
        WHERE ia.id = p_owner_id
          AND ia.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    END IF;
  END IF;

  IF is_resident() THEN
    IF p_owner_entity = 'person' AND p_owner_id = get_current_user_person_id() THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'tenant' AND p_owner_id IN (SELECT tenant_id FROM get_resident_tenant_ids()) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'contract' AND p_owner_id IN (SELECT contract_id FROM get_resident_contract_ids()) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'deposit' AND EXISTS (
      SELECT 1 FROM deposit d
      WHERE d.id = p_owner_id
        AND d.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'reservation' AND EXISTS (
      SELECT 1 FROM reservation r
      WHERE r.id = p_owner_id
        AND r.phone = (SELECT phone FROM person WHERE id = get_current_user_person_id())
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'service_request' AND EXISTS (
      SELECT 1 FROM service_request sr
      WHERE sr.id = p_owner_id
        AND (sr.created_by = get_current_user_id() OR sr.apartment_id IN (
          SELECT c.apartment_id FROM contract c WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
        ))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'payment' AND EXISTS (
      SELECT 1 FROM payment pay
      WHERE pay.id = p_owner_id
        AND (pay.reported_by = get_current_user_id() OR pay.contract_id IN (SELECT contract_id FROM get_resident_contract_ids()))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'credit_balance' AND EXISTS (
      SELECT 1 FROM credit_balance cb
      WHERE cb.id = p_owner_id
        AND (cb.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          OR cb.tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids()))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'invoice' AND EXISTS (
      SELECT 1 FROM invoice i
      WHERE i.id = p_owner_id
        AND i.status <> 'DRAFT'
        AND (i.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          OR i.tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids()))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'invoice_adjustment' AND EXISTS (
      SELECT 1 FROM invoice_adjustment ia
      JOIN invoice i ON i.id = ia.invoice_id
      WHERE ia.id = p_owner_id
        AND ia.status = 'APPROVED'
        AND (i.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          OR i.tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids()))
    ) THEN
      RETURN TRUE;
    END IF;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- 10l. rls_audit_log_select (12 thực thể tài chính + building, apartment, contract)
DROP POLICY IF EXISTS rls_audit_log_select ON audit_log;
CREATE POLICY rls_audit_log_select ON audit_log FOR SELECT
  USING (
    is_org_admin()
    OR actor_id = get_current_user_id()
    OR (
      is_owner() AND (
        (entity = 'building' AND entity_id IN (SELECT building_id FROM get_owner_building_ids()))
        OR (entity = 'apartment' AND entity_id IN (SELECT id FROM apartment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'reservation' AND entity_id IN (SELECT id FROM reservation WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'contract' AND entity_id IN (SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'deposit' AND entity_id IN (SELECT d.id FROM deposit d JOIN contract c ON c.id = d.contract_id WHERE c.building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'deposit_transaction' AND entity_id IN (
          SELECT dt.id
          FROM deposit_transaction dt
          JOIN deposit d ON d.id = dt.deposit_id
          JOIN contract c ON c.id = d.contract_id
          WHERE c.building_id IN (SELECT building_id FROM get_owner_building_ids())
        ))
        OR (entity = 'invoice' AND entity_id IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'invoice_line' AND (
          entity_id IN (SELECT il.id FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id WHERE i.building_id IN (SELECT building_id FROM get_owner_building_ids()))
          OR (before->>'invoice_id')::uuid IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_owner_building_ids()))
        ))
        OR (entity = 'invoice_adjustment' AND entity_id IN (SELECT id FROM invoice_adjustment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'payment' AND entity_id IN (SELECT id FROM payment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'receivable' AND entity_id IN (SELECT id FROM receivable WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'credit_balance' AND entity_id IN (SELECT id FROM credit_balance WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'service_subscription' AND entity_id IN (SELECT id FROM service_subscription WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'service_catalog' AND (
          entity_id IN (SELECT id FROM service_catalog WHERE building_id IN (SELECT building_id FROM get_owner_building_ids()))
          OR entity_id IN (SELECT id FROM service_catalog WHERE building_id IS NULL AND org_id = get_current_user_org_id())
        ))
        OR (entity = 'contract_service_price' AND entity_id IN (
          SELECT csp.id FROM contract_service_price csp JOIN contract c ON c.id = csp.contract_id WHERE c.building_id IN (SELECT building_id FROM get_owner_building_ids())
        ))
      )
    )
    OR (
      is_manager() AND (
        (entity = 'building' AND entity_id IN (SELECT building_id FROM get_manager_building_ids()))
        OR (entity = 'apartment' AND entity_id IN (SELECT id FROM apartment WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'reservation' AND entity_id IN (SELECT id FROM reservation WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'contract' AND entity_id IN (SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'deposit' AND entity_id IN (SELECT d.id FROM deposit d JOIN contract c ON c.id = d.contract_id WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'deposit_transaction' AND entity_id IN (
          SELECT dt.id
          FROM deposit_transaction dt
          JOIN deposit d ON d.id = dt.deposit_id
          JOIN contract c ON c.id = d.contract_id
          WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
        ))
        OR (entity = 'invoice' AND entity_id IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'invoice_line' AND (
          entity_id IN (SELECT il.id FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id WHERE i.building_id IN (SELECT building_id FROM get_manager_building_ids()))
          OR (before->>'invoice_id')::uuid IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids()))
        ))
        OR (entity = 'invoice_adjustment' AND entity_id IN (SELECT id FROM invoice_adjustment WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'payment' AND entity_id IN (SELECT id FROM payment WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'receivable' AND entity_id IN (SELECT id FROM receivable WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'credit_balance' AND entity_id IN (SELECT id FROM credit_balance WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'service_subscription' AND entity_id IN (SELECT id FROM service_subscription WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'service_catalog' AND (
          entity_id IN (SELECT id FROM service_catalog WHERE building_id IN (SELECT building_id FROM get_manager_building_ids()))
          OR entity_id IN (SELECT id FROM service_catalog WHERE building_id IS NULL AND org_id = get_current_user_org_id())
        ))
        OR (entity = 'contract_service_price' AND entity_id IN (
          SELECT csp.id FROM contract_service_price csp JOIN contract c ON c.id = csp.contract_id WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
        ))
      )
    )
  );

-- Cho phép dọn dẹp test trong môi trường test (tương tự 037_deposit_txn_immutable.sql)
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user <> 'resihub_app' AND current_setting('app.allow_test_cleanup', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Audit log is append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 11. BỘ 9 HÀM RPC SECURITY DEFINER HẸP (SET row_security = off)
-- ============================================================================

-- 11.1 fn_get_finance_resource_scope
CREATE OR REPLACE FUNCTION fn_get_finance_resource_scope(
  p_entity TEXT,
  p_id UUID
)
RETURNS TABLE (
  resource_id UUID,
  org_id UUID,
  building_id UUID
) AS $$
DECLARE
  v_caller_org UUID;
  v_entity_norm TEXT;
BEGIN
  v_caller_org := get_current_user_org_id();
  IF v_caller_org IS NULL OR p_id IS NULL THEN
    RETURN;
  END IF;

  v_entity_norm := lower(btrim(p_entity));

  IF v_entity_norm = 'service_catalog' THEN
    RETURN QUERY
    SELECT sc.id, sc.org_id, sc.building_id
    FROM service_catalog sc
    WHERE sc.id = p_id AND sc.org_id = v_caller_org;

  ELSIF v_entity_norm = 'service_subscription' THEN
    RETURN QUERY
    SELECT ss.id, ss.org_id, ss.building_id
    FROM service_subscription ss
    WHERE ss.id = p_id AND ss.org_id = v_caller_org;

  ELSIF v_entity_norm = 'contract_service_price' THEN
    RETURN QUERY
    SELECT csp.id, b.org_id, c.building_id
    FROM contract_service_price csp
    JOIN contract c ON c.id = csp.contract_id
    JOIN building b ON b.id = c.building_id
    WHERE csp.id = p_id AND b.org_id = v_caller_org;

  ELSIF v_entity_norm = 'invoice' THEN
    RETURN QUERY
    SELECT i.id, i.org_id, i.building_id
    FROM invoice i
    WHERE i.id = p_id AND i.org_id = v_caller_org;

  ELSIF v_entity_norm = 'invoice_adjustment' THEN
    RETURN QUERY
    SELECT ia.id, ia.org_id, ia.building_id
    FROM invoice_adjustment ia
    WHERE ia.id = p_id AND ia.org_id = v_caller_org;

  ELSIF v_entity_norm = 'payment' THEN
    RETURN QUERY
    SELECT p.id, p.org_id, p.building_id
    FROM payment p
    WHERE p.id = p_id AND p.org_id = v_caller_org;

  ELSIF v_entity_norm = 'receivable' THEN
    RETURN QUERY
    SELECT r.id, r.org_id, r.building_id
    FROM receivable r
    WHERE r.id = p_id AND r.org_id = v_caller_org;

  ELSIF v_entity_norm = 'credit_balance' THEN
    RETURN QUERY
    SELECT cb.id, cb.org_id, cb.building_id
    FROM credit_balance cb
    WHERE cb.id = p_id AND cb.org_id = v_caller_org;

  ELSIF v_entity_norm = 'contract' THEN
    RETURN QUERY
    SELECT c.id, b.org_id, c.building_id
    FROM contract c
    JOIN building b ON b.id = c.building_id
    WHERE c.id = p_id AND b.org_id = v_caller_org;

  ELSIF v_entity_norm = 'deposit' THEN
    RETURN QUERY
    SELECT d.id, b.org_id, c.building_id
    FROM deposit d
    JOIN contract c ON c.id = d.contract_id
    JOIN building b ON b.id = c.building_id
    WHERE d.id = p_id AND b.org_id = v_caller_org;

  ELSIF v_entity_norm = 'building' THEN
    RETURN QUERY
    SELECT b.id, b.org_id, b.id AS building_id
    FROM building b
    WHERE b.id = p_id AND b.org_id = v_caller_org;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_get_finance_resource_scope(TEXT, UUID) TO resihub_app;

-- 11.2 fn_lock_invoices_for_authorized_viewer
CREATE OR REPLACE FUNCTION fn_lock_invoices_for_authorized_viewer(
  p_contract_id UUID DEFAULT NULL,
  p_invoice_id UUID DEFAULT NULL
)
RETURNS SETOF invoice AS $$
BEGIN
  IF p_contract_id IS NULL AND p_invoice_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT i.*
  FROM invoice i
  WHERE (
    (p_invoice_id IS NOT NULL AND i.id = p_invoice_id)
    OR (p_invoice_id IS NULL AND p_contract_id IS NOT NULL AND i.contract_id = p_contract_id)
  )
  AND i.status <> 'VOID'
  AND (
    (get_current_user_id() IS NULL AND current_user <> 'resihub_app')
    OR (
      i.org_id = get_current_user_org_id()
      AND (
        is_org_admin()
        OR i.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        OR (
          i.status <> 'DRAFT'
          AND (
            i.contract_id IN (SELECT rc.contract_id FROM get_resident_contract_ids() rc)
            OR i.tenant_id IN (SELECT rt.tenant_id FROM get_resident_tenant_ids() rt)
          )
        )
      )
    )
  )
  ORDER BY i.period ASC, i.created_at ASC
  FOR UPDATE OF i;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_lock_invoices_for_authorized_viewer(UUID, UUID) TO resihub_app;

-- 11.3 fn_notify_building_finance_actors
CREATE OR REPLACE FUNCTION fn_notify_building_finance_actors(
  p_building_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_message TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_include_resident_user_id UUID DEFAULT NULL
)
RETURNS INT AS $$
DECLARE
  v_org_id UUID;
  v_count INT := 0;
  v_caller_id UUID;
  v_caller_org UUID;
BEGIN
  v_caller_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();

  SELECT b.org_id INTO v_org_id
  FROM building b
  WHERE b.id = p_building_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Nếu gọi từ phiên ứng dụng có user session, kiểm tra quyền truy cập tòa
  IF v_caller_id IS NOT NULL THEN
    IF v_caller_org IS NULL OR v_caller_org <> v_org_id THEN
      RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
    END IF;
    IF NOT (is_org_admin() OR p_building_id IN (SELECT building_id FROM get_user_assigned_buildings())) THEN
      RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO notification (org_id, user_id, title, content, type, payload)
  SELECT DISTINCT
    v_org_id,
    target_users.id,
    p_title,
    p_message,
    p_type,
    COALESCE(p_metadata, '{}'::jsonb)
  FROM (
    -- Quản lý tòa nhà
    SELECT au.id
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    JOIN app_user au ON au.id = ur.user_id
    JOIN person p ON p.id = au.person_id
    WHERE ur.building_id = p_building_id
      AND r.code = 'MANAGER'
      AND au.status = 'ACTIVE'
      AND p.org_id = v_org_id
    UNION
    -- Chủ nhà tòa nhà
    SELECT au.id
    FROM building b
    JOIN owner o ON o.id = b.owner_id
    JOIN app_user au ON au.person_id = o.person_id
    JOIN person p ON p.id = au.person_id
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    WHERE b.id = p_building_id
      AND r.code = 'OWNER'
      AND au.status = 'ACTIVE'
      AND p.org_id = v_org_id
    UNION
    -- Cư dân nếu được chỉ định
    SELECT au.id
    FROM app_user au
    JOIN person p ON p.id = au.person_id
    WHERE p_include_resident_user_id IS NOT NULL
      AND au.id = p_include_resident_user_id
      AND au.status = 'ACTIVE'
      AND p.org_id = v_org_id
  ) target_users;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_notify_building_finance_actors(UUID, TEXT, TEXT, TEXT, JSONB, UUID) TO resihub_app;

-- 11.4 fn_resolve_invoice_adjustment
CREATE OR REPLACE FUNCTION fn_resolve_invoice_adjustment(
  p_adjustment_id UUID,
  p_decision TEXT,
  p_rejection_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_actor_id UUID;
  v_caller_org UUID;
  v_decision_upper TEXT := upper(btrim(COALESCE(p_decision, '')));
  v_rejection_trimmed TEXT := btrim(COALESCE(p_rejection_reason, ''));
  v_adj RECORD;
  v_inv RECORD;
  v_allow_self_approval BOOLEAN := FALSE;
  v_is_authorized BOOLEAN := FALSE;
  v_formula JSONB;
  v_principal BIGINT;
  v_net_late_fee BIGINT;
  v_new_subtotal BIGINT;
  v_new_adjustment BIGINT;
  v_new_total BIGINT;
  v_excess_credit BIGINT;
  v_cr RECORD;
  v_rel BIGINT;
  v_new_credit_offset BIGINT;
  v_overpayment BIGINT := 0;
  v_new_paid BIGINT;
  v_new_status TEXT;
  v_target_contract_id UUID;
  v_child_contract_id UUID;
  v_minted_credit_id UUID;
BEGIN
  v_actor_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();

  IF v_actor_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_decision_upper IN ('APPROVE', 'APPROVED') THEN
    v_decision_upper := 'APPROVED';
  ELSIF v_decision_upper IN ('REJECT', 'REJECTED') THEN
    v_decision_upper := 'REJECTED';
  ELSE
    RAISE EXCEPTION 'INVALID_DECISION' USING ERRCODE = '22023';
  END IF;

  IF v_decision_upper = 'REJECTED' AND v_rejection_trimmed = '' THEN
    RAISE EXCEPTION 'MISSING_REASON' USING ERRCODE = '22023';
  END IF;

  SELECT ia.*, b.org_id AS bldg_org_id
  INTO v_adj
  FROM invoice_adjustment ia
  JOIN building b ON b.id = ia.building_id
  WHERE ia.id = p_adjustment_id
  FOR UPDATE OF ia;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_adj.bldg_org_id <> v_caller_org THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_adj.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING ERRCODE = 'P0001';
  END IF;

  -- Kiểm tra vai trò phê duyệt: OWNER tòa, MANAGER được gán, hoặc SYS_ADMIN khi tòa chưa có active owner
  IF (is_owner() AND v_adj.building_id IN (SELECT building_id FROM get_owner_building_ids()))
     OR (is_manager() AND v_adj.building_id IN (SELECT building_id FROM get_manager_building_ids()))
     OR (is_org_admin() AND NOT building_has_active_owner(v_adj.building_id)) THEN
    v_is_authorized := TRUE;
  END IF;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- 4-Eyes Check: đọc system_setting('approval_config')
  SELECT (value->>'allow_self_approval')::boolean
  INTO v_allow_self_approval
  FROM system_setting
  WHERE org_id = v_adj.org_id AND key = 'approval_config';

  IF v_adj.created_by = v_actor_id THEN
    IF NOT COALESCE(v_allow_self_approval, FALSE) THEN
      RAISE EXCEPTION 'SELF_APPROVAL' USING ERRCODE = '42501';
    ELSE
      INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
      VALUES (
        v_actor_id,
        'SELF_APPROVAL_WARNING',
        'invoice_adjustment',
        v_adj.id,
        jsonb_build_object('adjustment_id', v_adj.id, 'actor_id', v_actor_id)
      );
    END IF;
  END IF;

  -- Khóa dòng invoice cha
  SELECT *
  INTO v_inv
  FROM invoice
  WHERE id = v_adj.invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- XỬ LÝ REJECTED
  IF v_decision_upper = 'REJECTED' THEN
    UPDATE invoice_adjustment
    SET status = 'REJECTED',
        rejection_reason = v_rejection_trimmed,
        updated_by = v_actor_id,
        updated_at = NOW()
    WHERE id = v_adj.id;

    INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
    VALUES (
      v_actor_id,
      'REJECT_INVOICE_ADJUSTMENT',
      'invoice_adjustment',
      v_adj.id,
      jsonb_build_object('status', v_adj.status),
      jsonb_build_object('status', 'REJECTED', 'rejection_reason', v_rejection_trimmed)
    );

    RETURN jsonb_build_object(
      'status', 'REJECTED',
      'adjustment_id', v_adj.id,
      'invoice_id', v_inv.id,
      'rejection_reason', v_rejection_trimmed
    );
  END IF;

  -- XỬ LÝ APPROVED:
  UPDATE invoice_adjustment
  SET status = 'APPROVED',
      approved_by = v_actor_id,
      approved_at = NOW(),
      updated_by = v_actor_id,
      updated_at = NOW()
  WHERE id = v_adj.id;

  -- 1) Hành động VOID
  IF v_adj.action_type = 'VOID' THEN
    IF v_inv.paid_amount > 0 THEN
      RAISE EXCEPTION 'ALREADY_PAID' USING ERRCODE = 'P0001';
    END IF;

    -- Nhả credit_offset_amount về credit_balance nếu có
    IF v_inv.credit_offset_amount > 0 THEN
      FOR v_cr IN
        SELECT il.credit_id, ABS(il.amount) AS line_amt
        FROM invoice_line il
        WHERE il.invoice_id = v_inv.id AND il.credit_id IS NOT NULL AND il.amount < 0
      LOOP
        UPDATE credit_balance
        SET applied_amount = GREATEST(0, applied_amount - v_cr.line_amt),
            status = CASE WHEN applied_amount - v_cr.line_amt > 0 THEN 'PARTIALLY_APPLIED' ELSE 'AVAILABLE' END,
            updated_at = NOW()
        WHERE id = v_cr.credit_id;
      END LOOP;
    END IF;

    UPDATE invoice
    SET status = 'VOID',
        credit_offset_amount = 0,
        updated_at = NOW()
    WHERE id = v_inv.id;

    UPDATE receivable
    SET status = 'WRITTEN_OFF',
        updated_at = NOW()
    WHERE invoice_id = v_inv.id AND status IN ('OPEN', 'PARTIALLY_PAID');

    INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
    VALUES (
      v_actor_id,
      'APPROVE_INVOICE_VOID',
      'invoice',
      v_inv.id,
      jsonb_build_object('status', v_inv.status),
      jsonb_build_object('status', 'VOID')
    );

    IF v_inv.tenant_id IS NOT NULL THEN
      INSERT INTO notification (org_id, user_id, title, content, type, payload)
      SELECT DISTINCT
        v_inv.org_id,
        au.id,
        format('Hủy hóa đơn kỳ %s', v_inv.period),
        format('Hóa đơn %s đã được phê duyệt hủy bỏ', v_inv.invoice_code),
        'INVOICE_VOIDED',
        jsonb_build_object('invoice_id', v_inv.id, 'adjustment_id', v_adj.id)
      FROM tenant t
      JOIN person p ON p.id = t.person_id
      JOIN app_user au ON au.person_id = p.id
      WHERE t.id = v_inv.tenant_id AND au.status = 'ACTIVE';
    END IF;

    RETURN jsonb_build_object(
      'status', 'APPROVED',
      'action_type', 'VOID',
      'adjustment_id', v_adj.id,
      'invoice_id', v_inv.id
    );
  END IF;

  -- 2) Hành động ADJUST:
  v_formula := CASE
    WHEN v_adj.adjustment_target = 'LATE_FEE' THEN jsonb_build_object('adjusts_item_type', 'LATE_FEE')
    ELSE COALESCE(v_adj.formula_meta, '{}'::jsonb)
  END;

  INSERT INTO invoice_line (
    invoice_id, item_type, description, quantity, unit, unit_price, amount, adjustment_id, formula_meta
  )
  VALUES (
    v_inv.id, 'ADJUSTMENT', v_adj.reason, 1, 'lần', v_adj.delta_amount, v_adj.delta_amount, v_adj.id, v_formula
  );

  -- Triệt tiêu append-only phạt nộp muộn nếu hóa đơn chưa thu tiền và nợ gốc về <= 0
  IF v_inv.paid_amount = 0 THEN
    SELECT COALESCE(SUM(il.amount), 0)
    INTO v_principal
    FROM invoice_line il
    WHERE il.invoice_id = v_inv.id
      AND NOT (
        il.item_type = 'LATE_FEE'
        OR (il.item_type = 'ADJUSTMENT' AND COALESCE(il.formula_meta->>'adjusts_item_type', '') = 'LATE_FEE')
      );

    IF v_principal <= 0 THEN
      SELECT COALESCE(SUM(il.amount), 0)
      INTO v_net_late_fee
      FROM invoice_line il
      WHERE il.invoice_id = v_inv.id
        AND (
          il.item_type = 'LATE_FEE'
          OR (il.item_type = 'ADJUSTMENT' AND COALESCE(il.formula_meta->>'adjusts_item_type', '') = 'LATE_FEE')
        );

      IF v_net_late_fee > 0 THEN
        INSERT INTO invoice_line (
          invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta
        )
        VALUES (
          v_inv.id, 'ADJUSTMENT', 'Triệt tiêu phạt nộp muộn khi nợ gốc bằng 0', 1, 'lần',
          -v_net_late_fee, -v_net_late_fee,
          jsonb_build_object('adjusts_item_type', 'LATE_FEE', 'auto_neutralized', true)
        );
      END IF;
    END IF;
  END IF;

  -- Tính toán lại tổng tiền hóa đơn (chỉ cộng các khoản điều chỉnh giá, không tính dòng bù trừ tín dụng credit_id)
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE item_type <> 'ADJUSTMENT'), v_inv.subtotal_amount)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE item_type = 'ADJUSTMENT' AND credit_id IS NULL), 0)::bigint
  INTO v_new_subtotal, v_new_adjustment
  FROM invoice_line
  WHERE invoice_id = v_inv.id;

  v_new_subtotal := COALESCE(v_new_subtotal, v_inv.subtotal_amount);
  v_new_total := GREATEST(0, v_new_subtotal + v_new_adjustment);

  -- Xử lý hoàn lại credit_offset_amount dư về credit_balance
  IF v_inv.credit_offset_amount > v_new_total THEN
    v_excess_credit := v_inv.credit_offset_amount - v_new_total;
    FOR v_cr IN
      SELECT cb.id AS credit_id, cb.applied_amount
      FROM credit_balance cb
      WHERE (cb.source_invoice_id = v_inv.id OR cb.id IN (SELECT il.credit_id FROM invoice_line il WHERE il.invoice_id = v_inv.id AND il.credit_id IS NOT NULL))
        AND cb.status IN ('AVAILABLE', 'PARTIALLY_APPLIED', 'APPLIED')
        AND cb.applied_amount > 0
      ORDER BY cb.updated_at DESC
    LOOP
      EXIT WHEN v_excess_credit <= 0;
      v_rel := LEAST(v_excess_credit, v_cr.applied_amount);
      UPDATE credit_balance
      SET applied_amount = applied_amount - v_rel,
          status = CASE WHEN applied_amount - v_rel > 0 THEN 'PARTIALLY_APPLIED' ELSE 'AVAILABLE' END,
          updated_at = NOW()
      WHERE id = v_cr.credit_id;

      INSERT INTO invoice_line (
        invoice_id, item_type, description, quantity, unit, unit_price, amount, credit_id
      )
      VALUES (
        v_inv.id, 'ADJUSTMENT', 'Hoàn trả số dư bù trừ dư thừa vào sổ tín dụng', 1, 'lần',
        v_rel, v_rel, v_cr.credit_id
      );

      v_excess_credit := v_excess_credit - v_rel;
    END LOOP;
    v_new_credit_offset := v_new_total;
  ELSE
    v_new_credit_offset := v_inv.credit_offset_amount;
  END IF;

  -- Xử lý sinh credit_balance nếu tiền đã nộp > tổng tiền mới
  IF v_inv.paid_amount > v_new_total THEN
    v_overpayment := v_inv.paid_amount - v_new_total;
    v_new_paid := v_new_total;

    -- Kiểm tra hợp đồng con chuyển phòng (room transfer)
    v_target_contract_id := v_inv.contract_id;
    IF v_inv.contract_id IS NOT NULL THEN
      SELECT c_child.id INTO v_child_contract_id
      FROM contract c_child
      WHERE c_child.parent_contract_id = v_inv.contract_id
        AND c_child.status = 'ACTIVE'
      LIMIT 1;
      IF v_child_contract_id IS NOT NULL THEN
        v_target_contract_id := v_child_contract_id;
      END IF;
    END IF;

    INSERT INTO credit_balance (
      org_id, building_id, contract_id, tenant_id, source_invoice_id, source_adjustment_id,
      reason_type, amount, status, description, created_by, updated_by
    )
    VALUES (
      v_inv.org_id, v_inv.building_id, v_target_contract_id, v_inv.tenant_id, v_inv.id, v_adj.id,
      'INVOICE_ADJUSTMENT', v_overpayment, 'AVAILABLE',
      format('Số dư thừa phát sinh từ điều chỉnh hóa đơn %s', v_inv.invoice_code),
      v_actor_id, v_actor_id
    )
    RETURNING id INTO v_minted_credit_id;
  ELSE
    v_new_paid := v_inv.paid_amount;
  END IF;

  v_new_status := CASE
    WHEN v_new_paid >= v_new_total AND v_new_total > 0 THEN 'PAID'
    WHEN v_new_paid >= v_new_total AND v_new_total = 0 THEN 'PAID'
    WHEN v_new_paid > 0 THEN 'PARTIALLY_PAID'
    WHEN v_inv.status = 'DRAFT' THEN 'DRAFT'
    ELSE 'ISSUED'
  END;

  UPDATE invoice
  SET subtotal_amount = v_new_subtotal,
      adjustment_amount = v_new_adjustment,
      total_amount = v_new_total,
      paid_amount = v_new_paid,
      credit_offset_amount = v_new_credit_offset,
      status = v_new_status,
      updated_at = NOW()
  WHERE id = v_inv.id;

  -- UPSERT receivable
  IF v_new_total > v_new_paid THEN
    UPDATE receivable
    SET amount = v_new_total,
        paid_amount = v_new_paid,
        status = CASE WHEN v_new_paid > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
        updated_at = NOW()
    WHERE invoice_id = v_inv.id AND status IN ('OPEN', 'PARTIALLY_PAID');

    IF NOT FOUND THEN
      INSERT INTO receivable (
        org_id, building_id, contract_id, tenant_id, invoice_id,
        type, amount, paid_amount, due_date, status, description
      )
      VALUES (
        v_inv.org_id, v_inv.building_id, v_inv.contract_id, v_inv.tenant_id, v_inv.id,
        'INVOICE_DEBT', v_new_total, v_new_paid, CURRENT_DATE + 5,
        CASE WHEN v_new_paid > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
        format('Công nợ sau điều chỉnh hóa đơn %s', v_inv.invoice_code)
      );
    END IF;
  ELSE
    UPDATE receivable
    SET paid_amount = CASE WHEN v_new_total = 0 THEN 0 ELSE amount END,
        status = CASE WHEN v_new_total = 0 THEN 'WRITTEN_OFF' ELSE 'PAID' END,
        updated_at = NOW()
    WHERE invoice_id = v_inv.id AND status IN ('OPEN', 'PARTIALLY_PAID');
  END IF;

  -- Audit log & thông báo cư dân
  INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
  VALUES (
    v_actor_id,
    'APPROVE_INVOICE_ADJUSTMENT',
    'invoice_adjustment',
    v_adj.id,
    jsonb_build_object('status', v_adj.status, 'total_amount', v_inv.total_amount, 'paid_amount', v_inv.paid_amount),
    jsonb_build_object('status', 'APPROVED', 'total_amount', v_new_total, 'paid_amount', v_new_paid, 'minted_credit_id', v_minted_credit_id)
  );

  IF v_inv.tenant_id IS NOT NULL THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_inv.org_id,
      au.id,
      format('Điều chỉnh hóa đơn kỳ %s', v_inv.period),
      format('Hóa đơn %s đã được phê duyệt điều chỉnh %s ₫', v_inv.invoice_code, v_adj.delta_amount),
      'INVOICE_ADJUSTED',
      jsonb_build_object('invoice_id', v_inv.id, 'adjustment_id', v_adj.id)
    FROM tenant t
    JOIN person p ON p.id = t.person_id
    JOIN app_user au ON au.person_id = p.id
    WHERE t.id = v_inv.tenant_id AND au.status = 'ACTIVE';
  END IF;

  RETURN jsonb_build_object(
    'status', 'APPROVED',
    'action_type', 'ADJUST',
    'adjustment_id', v_adj.id,
    'invoice_id', v_inv.id,
    'total_amount', v_new_total,
    'paid_amount', v_new_paid,
    'overpayment_minted', v_overpayment,
    'minted_credit_id', v_minted_credit_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_resolve_invoice_adjustment(UUID, TEXT, TEXT) TO resihub_app;

-- 11.5 fn_resolve_credit_refund
CREATE OR REPLACE FUNCTION fn_resolve_credit_refund(
  p_credit_id UUID,
  p_decision TEXT,
  p_rejection_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_actor_id UUID;
  v_caller_org UUID;
  v_decision_upper TEXT := upper(btrim(COALESCE(p_decision, '')));
  v_rejection_trimmed TEXT := btrim(COALESCE(p_rejection_reason, ''));
  v_cb RECORD;
  v_allow_self_approval BOOLEAN := FALSE;
  v_is_authorized BOOLEAN := FALSE;
  v_creator_id UUID;
  v_parent_id UUID;
BEGIN
  v_actor_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();

  IF v_actor_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_decision_upper IN ('APPROVE', 'APPROVED') THEN
    v_decision_upper := 'APPROVED';
  ELSIF v_decision_upper IN ('REJECT', 'REJECTED') THEN
    v_decision_upper := 'REJECTED';
  ELSE
    RAISE EXCEPTION 'INVALID_DECISION' USING ERRCODE = '22023';
  END IF;

  IF v_decision_upper = 'REJECTED' AND v_rejection_trimmed = '' THEN
    RAISE EXCEPTION 'MISSING_REASON' USING ERRCODE = '22023';
  END IF;

  SELECT cb.*, b.org_id AS bldg_org_id
  INTO v_cb
  FROM credit_balance cb
  JOIN building b ON b.id = cb.building_id
  WHERE cb.id = p_credit_id
  FOR UPDATE OF cb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_cb.bldg_org_id <> v_caller_org THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF v_cb.status <> 'PENDING_DIRECT_REFUND' THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING ERRCODE = 'P0001';
  END IF;

  IF (is_owner() AND v_cb.building_id IN (SELECT building_id FROM get_owner_building_ids()))
     OR (is_manager() AND v_cb.building_id IN (SELECT building_id FROM get_manager_building_ids()))
     OR (is_org_admin() AND NOT building_has_active_owner(v_cb.building_id)) THEN
    v_is_authorized := TRUE;
  END IF;

  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_creator_id := COALESCE(
    NULLIF(v_cb.refund_meta->>'requested_by', '')::uuid,
    v_cb.updated_by,
    v_cb.created_by
  );

  SELECT (value->>'allow_self_approval')::boolean
  INTO v_allow_self_approval
  FROM system_setting
  WHERE org_id = v_cb.org_id AND key = 'approval_config';

  IF v_creator_id = v_actor_id THEN
    IF NOT COALESCE(v_allow_self_approval, FALSE) THEN
      RAISE EXCEPTION 'SELF_APPROVAL' USING ERRCODE = '42501';
    ELSE
      INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
      VALUES (
        v_actor_id,
        'SELF_APPROVAL_WARNING',
        'credit_balance',
        v_cb.id,
        jsonb_build_object('credit_id', v_cb.id, 'actor_id', v_actor_id)
      );
    END IF;
  END IF;

  IF v_decision_upper = 'REJECTED' THEN
    v_parent_id := v_cb.parent_credit_id;

    IF v_parent_id IS NOT NULL THEN
      UPDATE credit_balance
      SET applied_amount = GREATEST(0, applied_amount - v_cb.amount),
          status = CASE WHEN applied_amount - v_cb.amount > 0 THEN 'PARTIALLY_APPLIED' ELSE 'AVAILABLE' END,
          updated_at = NOW()
      WHERE id = v_parent_id;

      UPDATE credit_balance
      SET status = 'VOID',
          refund_meta = COALESCE(refund_meta, '{}'::jsonb) || jsonb_build_object('rejection_reason', v_rejection_trimmed),
          updated_by = v_actor_id,
          updated_at = NOW()
      WHERE id = v_cb.id;
    ELSE
      UPDATE credit_balance
      SET status = CASE WHEN applied_amount > 0 THEN 'PARTIALLY_APPLIED' ELSE 'AVAILABLE' END,
          refund_meta = COALESCE(refund_meta, '{}'::jsonb) || jsonb_build_object('rejection_reason', v_rejection_trimmed),
          updated_by = v_actor_id,
          updated_at = NOW()
      WHERE id = v_cb.id;
    END IF;

    INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
    VALUES (
      v_actor_id,
      'REJECT_CREDIT_REFUND',
      'credit_balance',
      v_cb.id,
      jsonb_build_object('status', v_cb.status),
      jsonb_build_object('status', 'REJECTED', 'rejection_reason', v_rejection_trimmed)
    );

    IF v_cb.tenant_id IS NOT NULL THEN
      INSERT INTO notification (org_id, user_id, title, content, type, payload)
      SELECT DISTINCT
        v_cb.org_id,
        au.id,
        'Từ chối hoàn số dư tín dụng',
        format('Yêu cầu hoàn %s ₫ bị từ chối: "%s"', v_cb.amount, v_rejection_trimmed),
        'CREDIT_REFUND_REJECTED',
        jsonb_build_object('credit_id', v_cb.id)
      FROM tenant t
      JOIN person p ON p.id = t.person_id
      JOIN app_user au ON au.person_id = p.id
      WHERE t.id = v_cb.tenant_id AND au.status = 'ACTIVE';
    END IF;

    RETURN jsonb_build_object(
      'status', 'REJECTED',
      'credit_id', v_cb.id,
      'rejection_reason', v_rejection_trimmed
    );
  END IF;

  -- APPROVED:
  UPDATE credit_balance
  SET status = 'REFUNDED_DIRECT',
      applied_amount = amount,
      refunded_at = NOW(),
      updated_by = v_actor_id,
      updated_at = NOW()
  WHERE id = v_cb.id;

  INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
  VALUES (
    v_actor_id,
    'APPROVE_CREDIT_REFUND',
    'credit_balance',
    v_cb.id,
    jsonb_build_object('status', v_cb.status),
    jsonb_build_object('status', 'REFUNDED_DIRECT', 'amount', v_cb.amount)
  );

  IF v_cb.tenant_id IS NOT NULL THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_cb.org_id,
      au.id,
      'Phê duyệt hoàn số dư tín dụng',
      format('Yêu cầu hoàn %s ₫ đã được phê duyệt thành công.', v_cb.amount),
      'CREDIT_REFUNDED',
      jsonb_build_object('credit_id', v_cb.id, 'amount', v_cb.amount)
    FROM tenant t
    JOIN person p ON p.id = t.person_id
    JOIN app_user au ON au.person_id = p.id
    WHERE t.id = v_cb.tenant_id AND au.status = 'ACTIVE';
  END IF;

  RETURN jsonb_build_object(
    'status', 'REFUNDED_DIRECT',
    'credit_id', v_cb.id,
    'amount', v_cb.amount
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_resolve_credit_refund(UUID, TEXT, TEXT) TO resihub_app;

-- 11.6 fn_apply_deposit_settlement_accounting (4-pass sequential accounting)
CREATE OR REPLACE FUNCTION fn_apply_deposit_settlement_accounting(
  p_deposit_id UUID,
  p_covered_service_debt BIGINT,
  p_uncovered_items_shortfall BIGINT
)
RETURNS VOID AS $$
DECLARE
  v_actor_id UUID;
  v_caller_org UUID;
  v_dep RECORD;
  v_authorized BOOLEAN := FALSE;
  v_remaining_dep_cover BIGINT := GREATEST(0, COALESCE(p_covered_service_debt, 0));
  v_inv RECORD;
  v_paid BIGINT;
  v_total BIGINT;
  v_rem BIGINT;
  v_raw_rent BIGINT;
  v_raw_service BIGINT;
  v_paid_to_rent BIGINT;
  v_rent_unpaid BIGINT;
  v_service_unpaid BIGINT;
  v_cb RECORD;
  v_apply BIGINT;
  v_inv_cur_paid BIGINT;
  v_inv_cur_credit BIGINT;
  v_new_status TEXT;
  v_still_unpaid BIGINT;
BEGIN
  v_actor_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();

  IF v_actor_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN_SETTLEMENT_ACCOUNTING' USING ERRCODE = '42501';
  END IF;

  SELECT d.id, d.status, d.contract_id, c.building_id, c.primary_tenant_id, b.org_id
  INTO v_dep
  FROM deposit d
  JOIN contract c ON c.id = d.contract_id
  JOIN building b ON b.id = c.building_id
  WHERE d.id = p_deposit_id
    AND b.org_id = v_caller_org
  FOR UPDATE OF d;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEPOSIT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_dep.status NOT IN (
    'PENDING_APPROVAL',
    'APPROVED_PENDING_PAYOUT',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'DEDUCTED_FULL'
  ) THEN
    RAISE EXCEPTION 'INVALID_DEPOSIT_STATUS_FOR_ACCOUNTING' USING ERRCODE = 'P0001';
  END IF;

  IF (is_manager() AND v_dep.building_id IN (SELECT building_id FROM get_manager_building_ids()))
     OR (is_owner() AND v_dep.building_id IN (SELECT building_id FROM get_owner_building_ids()))
     OR (is_org_admin() AND NOT building_has_active_owner(v_dep.building_id)) THEN
    v_authorized := TRUE;
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'FORBIDDEN_SETTLEMENT_ACCOUNTING' USING ERRCODE = '42501';
  END IF;

  -- Bảng tạm lưu danh sách hóa đơn mở và nhu cầu công nợ đã qua xử lý tràn âm
  CREATE TEMPORARY TABLE IF NOT EXISTS tmp_settlement_invoices (
    id UUID PRIMARY KEY,
    invoice_code TEXT,
    period TEXT,
    total_amount BIGINT,
    paid_amount BIGINT,
    credit_offset_amount BIGINT,
    status TEXT,
    rent_unpaid BIGINT,
    service_unpaid BIGINT
  ) ON COMMIT DROP;

  DELETE FROM tmp_settlement_invoices;

  FOR v_inv IN
    SELECT i.id, i.invoice_code, i.period, i.total_amount, i.paid_amount, i.credit_offset_amount, i.status
    FROM invoice i
    WHERE i.contract_id = v_dep.contract_id
      AND i.status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED')
      AND (i.total_amount - i.paid_amount) > 0
    ORDER BY i.period ASC, i.created_at ASC
    FOR UPDATE
  LOOP
    v_total := GREATEST(0, COALESCE(v_inv.total_amount, 0));
    v_paid := GREATEST(0, COALESCE(v_inv.paid_amount, 0));
    v_rem := GREATEST(0, v_total - v_paid);

    IF v_rem <= 0 THEN
      CONTINUE;
    END IF;

    -- Tính raw_rent và raw_service qua invoice_line & invoice_adjustment
    SELECT
      COALESCE(SUM(il.amount) FILTER (
        WHERE (il.item_type = 'RENT'
           OR (il.item_type = 'ADJUSTMENT' AND (ia.adjustment_target = 'RENT' OR il.formula_meta->>'adjusts_item_type' = 'RENT')))
          AND il.credit_id IS NULL
      ), 0)::bigint,
      COALESCE(SUM(il.amount) FILTER (
        WHERE (il.item_type IN ('SERVICE', 'ELECTRICITY', 'WATER', 'OTHER')
           OR (il.item_type = 'ADJUSTMENT' AND (ia.adjustment_target IN ('SERVICE', 'LATE_FEE', 'MANUAL') OR il.formula_meta->>'adjusts_item_type' IN ('SERVICE', 'LATE_FEE') OR (ia.adjustment_target IS NULL AND il.formula_meta->>'adjusts_item_type' IS NULL))))
          AND il.credit_id IS NULL
      ), 0)::bigint
    INTO v_raw_rent, v_raw_service
    FROM invoice_line il
    LEFT JOIN invoice_adjustment ia ON ia.id = il.adjustment_id
    WHERE il.invoice_id = v_inv.id;

    -- Xử lý tràn âm liên nhóm: raw_service < 0 tràn sang raw_rent và ngược lại
    IF v_raw_service < 0 THEN
      v_raw_rent := v_raw_rent + v_raw_service;
      v_raw_service := 0;
    ELSIF v_raw_rent < 0 THEN
      v_raw_service := v_raw_service + v_raw_rent;
      v_raw_rent := 0;
    END IF;

    v_raw_rent := GREATEST(0, v_raw_rent);
    v_raw_service := GREATEST(0, v_raw_service);

    -- Khấu trừ tiền đã nộp (ưu tiên RENT trước)
    v_paid_to_rent := LEAST(v_paid, v_raw_rent);
    v_rent_unpaid := GREATEST(0, v_raw_rent - v_paid_to_rent);
    v_service_unpaid := GREATEST(0, v_raw_service - (v_paid - v_paid_to_rent));

    v_rent_unpaid := LEAST(v_rent_unpaid, v_rem);
    v_service_unpaid := LEAST(v_service_unpaid, v_rem - v_rent_unpaid);

    INSERT INTO tmp_settlement_invoices (
      id, invoice_code, period, total_amount, paid_amount, credit_offset_amount, status, rent_unpaid, service_unpaid
    )
    VALUES (
      v_inv.id, v_inv.invoice_code, v_inv.period, v_inv.total_amount, v_inv.paid_amount,
      COALESCE(v_inv.credit_offset_amount, 0), v_inv.status, v_rent_unpaid, v_service_unpaid
    );
  END LOOP;

  -- LƯỢT 1: credit_balance -> toàn bộ nợ RENT
  FOR v_cb IN
    SELECT cb.id, (cb.amount - cb.applied_amount) AS available_amt
    FROM credit_balance cb
    WHERE cb.contract_id = v_dep.contract_id
      AND cb.status IN ('AVAILABLE', 'PARTIALLY_APPLIED')
      AND (cb.amount - cb.applied_amount) > 0
    ORDER BY cb.created_at ASC
    FOR UPDATE OF cb
  LOOP
    FOR v_inv IN
      SELECT * FROM tmp_settlement_invoices
      WHERE rent_unpaid > 0
      ORDER BY period ASC
    LOOP
      EXIT WHEN v_cb.available_amt <= 0;
      v_apply := LEAST(v_cb.available_amt, v_inv.rent_unpaid);

      IF v_apply > 0 THEN
        v_cb.available_amt := v_cb.available_amt - v_apply;
        UPDATE tmp_settlement_invoices
        SET rent_unpaid = rent_unpaid - v_apply,
            paid_amount = paid_amount + v_apply,
            credit_offset_amount = credit_offset_amount + v_apply
        WHERE id = v_inv.id;

        UPDATE credit_balance
        SET applied_amount = applied_amount + v_apply,
            status = CASE WHEN (applied_amount + v_apply) >= amount THEN 'APPLIED' ELSE 'PARTIALLY_APPLIED' END,
            updated_at = NOW()
        WHERE id = v_cb.id;
      END IF;
    END LOOP;
  END LOOP;

  -- LƯỢT 2: credit_balance -> toàn bộ nợ SERVICE
  FOR v_cb IN
    SELECT cb.id, (cb.amount - cb.applied_amount) AS available_amt
    FROM credit_balance cb
    WHERE cb.contract_id = v_dep.contract_id
      AND cb.status IN ('AVAILABLE', 'PARTIALLY_APPLIED')
      AND (cb.amount - cb.applied_amount) > 0
    ORDER BY cb.created_at ASC
    FOR UPDATE OF cb
  LOOP
    FOR v_inv IN
      SELECT * FROM tmp_settlement_invoices
      WHERE service_unpaid > 0
      ORDER BY period ASC
    LOOP
      EXIT WHEN v_cb.available_amt <= 0;
      v_apply := LEAST(v_cb.available_amt, v_inv.service_unpaid);

      IF v_apply > 0 THEN
        v_cb.available_amt := v_cb.available_amt - v_apply;
        UPDATE tmp_settlement_invoices
        SET service_unpaid = service_unpaid - v_apply,
            paid_amount = paid_amount + v_apply,
            credit_offset_amount = credit_offset_amount + v_apply
        WHERE id = v_inv.id;

        UPDATE credit_balance
        SET applied_amount = applied_amount + v_apply,
            status = CASE WHEN (applied_amount + v_apply) >= amount THEN 'APPLIED' ELSE 'PARTIALLY_APPLIED' END,
            updated_at = NOW()
        WHERE id = v_cb.id;
      END IF;
    END LOOP;
  END LOOP;

  -- LƯỢT 3: credit_balance còn dư -> kết chuyển quyết toán cọc
  UPDATE credit_balance
  SET settlement_deposit_id = p_deposit_id,
      settlement_refund_amount = (amount - applied_amount),
      applied_amount = amount,
      status = 'REFUNDED_IN_SETTLEMENT',
      refunded_at = NOW(),
      updated_at = NOW()
  WHERE contract_id = v_dep.contract_id
    AND status IN ('AVAILABLE', 'PARTIALLY_APPLIED');

  -- LƯỢT 4: tiền cọc gốc (p_covered_service_debt) -> nợ SERVICE còn lại sau Lượt 2
  FOR v_inv IN
    SELECT * FROM tmp_settlement_invoices
    WHERE service_unpaid > 0
    ORDER BY period ASC
  LOOP
    EXIT WHEN v_remaining_dep_cover <= 0;
    v_apply := LEAST(v_remaining_dep_cover, v_inv.service_unpaid);

    IF v_apply > 0 THEN
      v_remaining_dep_cover := v_remaining_dep_cover - v_apply;
      UPDATE tmp_settlement_invoices
      SET service_unpaid = service_unpaid - v_apply,
          paid_amount = paid_amount + v_apply
      WHERE id = v_inv.id;
    END IF;
  END LOOP;

  -- ÁP DỤNG KẾT QUẢ CUỐI CÙNG LÊN invoice & receivable
  FOR v_inv IN SELECT * FROM tmp_settlement_invoices LOOP
    v_new_status := CASE
      WHEN v_inv.paid_amount >= v_inv.total_amount THEN 'PAID'
      WHEN v_inv.paid_amount > 0 THEN 'PARTIALLY_PAID'
      ELSE v_inv.status
    END;

    UPDATE invoice
    SET paid_amount = v_inv.paid_amount,
        credit_offset_amount = v_inv.credit_offset_amount,
        status = v_new_status,
        updated_at = NOW()
    WHERE id = v_inv.id;

    v_still_unpaid := GREATEST(0, v_inv.total_amount - v_inv.paid_amount);

    IF v_still_unpaid = 0 THEN
      UPDATE receivable
      SET paid_amount = amount,
          status = 'PAID',
          deposit_id = COALESCE(deposit_id, p_deposit_id),
          updated_at = NOW()
      WHERE invoice_id = v_inv.id
        AND status IN ('OPEN', 'PARTIALLY_PAID');
    ELSE
      UPDATE receivable
      SET amount = GREATEST(paid_amount, v_inv.total_amount),
          paid_amount = LEAST(GREATEST(paid_amount, v_inv.total_amount), v_inv.paid_amount),
          status = CASE WHEN v_inv.paid_amount > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
          type = 'RECEIVABLE_AFTER_MOVE_OUT',
          deposit_id = COALESCE(deposit_id, p_deposit_id),
          updated_at = NOW()
      WHERE invoice_id = v_inv.id
        AND status IN ('OPEN', 'PARTIALLY_PAID');

      IF NOT FOUND THEN
        INSERT INTO receivable (
          org_id,
          building_id,
          contract_id,
          tenant_id,
          invoice_id,
          deposit_id,
          type,
          amount,
          paid_amount,
          due_date,
          status,
          description
        )
        VALUES (
          v_dep.org_id,
          v_dep.building_id,
          v_dep.contract_id,
          v_dep.primary_tenant_id,
          v_inv.id,
          p_deposit_id,
          'RECEIVABLE_AFTER_MOVE_OUT',
          v_inv.total_amount,
          v_inv.paid_amount,
          CURRENT_DATE + 7,
          CASE WHEN v_inv.paid_amount > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
          format('Công nợ hóa đơn %s còn tồn đọng sau trả phòng', v_inv.invoice_code)
        );
      END IF;
    END IF;
  END LOOP;

  -- Xử lý công nợ vượt cọc nếu có
  IF COALESCE(p_uncovered_items_shortfall, 0) > 0 THEN
    INSERT INTO receivable (
      org_id,
      building_id,
      contract_id,
      tenant_id,
      invoice_id,
      deposit_id,
      type,
      amount,
      paid_amount,
      due_date,
      status,
      description
    )
    VALUES (
      v_dep.org_id,
      v_dep.building_id,
      v_dep.contract_id,
      v_dep.primary_tenant_id,
      NULL,
      p_deposit_id,
      'RECEIVABLE_AFTER_MOVE_OUT',
      p_uncovered_items_shortfall,
      0,
      CURRENT_DATE + 7,
      'OPEN',
      'Công nợ phát sinh sau tất toán tiền cọc vượt mức cọc đang giữ (FR-024)'
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_apply_deposit_settlement_accounting(UUID, BIGINT, BIGINT) TO resihub_app;

-- 11.7 fn_update_deposit_refund_bank_info
CREATE OR REPLACE FUNCTION fn_update_deposit_refund_bank_info(
  p_deposit_id UUID,
  p_bank_info JSONB
)
RETURNS deposit AS $$
DECLARE
  v_user_id UUID;
  v_caller_org UUID;
  v_dep deposit%ROWTYPE;
  v_building_id UUID;
  v_primary_tenant_id UUID;
  v_settlement JSONB;
  v_before_bank JSONB;
  v_now_iso TEXT;
BEGIN
  v_user_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();
  IF v_user_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  SELECT d.*
  INTO v_dep
  FROM deposit d
  JOIN contract c ON c.id = d.contract_id
  JOIN building b ON b.id = c.building_id
  WHERE d.id = p_deposit_id
    AND b.org_id = v_caller_org
  FOR UPDATE OF d;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT c.building_id, c.primary_tenant_id
  INTO v_building_id, v_primary_tenant_id
  FROM contract c
  WHERE c.id = v_dep.contract_id;

  IF NOT (
    (is_manager() AND v_building_id IN (SELECT mb.building_id FROM get_manager_building_ids() mb))
    OR (v_primary_tenant_id IN (SELECT rt.tenant_id FROM get_resident_tenant_ids() rt))
    OR (is_owner() AND v_building_id IN (SELECT ob.building_id FROM get_owner_building_ids() ob))
    OR (is_org_admin() AND NOT building_has_active_owner(v_building_id))
  ) THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  v_settlement := COALESCE(v_dep.settlement, '{}'::jsonb);

  IF v_dep.status NOT IN ('APPROVED_PENDING_PAYOUT', 'RETURNED')
     OR COALESCE((v_settlement->>'refund_amount')::bigint, 0) <= 0 THEN
    RAISE EXCEPTION 'INVALID_STATUS_FOR_BANK_UPDATE' USING ERRCODE = 'P0001';
  END IF;

  v_before_bank := v_settlement->'bank_info';
  v_now_iso := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  v_settlement := v_settlement || jsonb_build_object(
    'bank_info', COALESCE(p_bank_info, '{}'::jsonb),
    'bank_info_updated_at', v_now_iso,
    'bank_info_updated_by', v_user_id::text
  );

  UPDATE deposit
  SET settlement = v_settlement,
      updated_at = NOW()
  WHERE id = p_deposit_id
  RETURNING * INTO v_dep;

  INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
  VALUES (
    v_user_id,
    'UPDATE_BANK_INFO',
    'deposit',
    p_deposit_id,
    jsonb_build_object('bank_info', v_before_bank),
    jsonb_build_object('bank_info', p_bank_info)
  );

  RETURN v_dep;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_update_deposit_refund_bank_info(UUID, JSONB) TO resihub_app;

-- 11.8 fn_restore_returned_settlement_credits
CREATE OR REPLACE FUNCTION fn_restore_returned_settlement_credits(
  p_deposit_id UUID,
  p_reason TEXT
)
RETURNS INT AS $$
DECLARE
  v_count INT := 0;
BEGIN
  UPDATE credit_balance
  SET status = 'PENDING_SETTLEMENT_PAYOUT',
      refunded_at = NULL,
      refund_meta = COALESCE(refund_meta, '{}'::jsonb) || jsonb_build_object(
        'restore_reason', p_reason,
        'restored_at', NOW()
      ),
      updated_at = NOW()
  WHERE settlement_deposit_id = p_deposit_id
    AND status = 'REFUNDED_IN_SETTLEMENT';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_restore_returned_settlement_credits(UUID, TEXT) TO resihub_app;

-- 11.9 fn_recommit_returned_settlement_credits
CREATE OR REPLACE FUNCTION fn_recommit_returned_settlement_credits(
  p_deposit_id UUID
)
RETURNS INT AS $$
DECLARE
  v_count INT := 0;
BEGIN
  UPDATE credit_balance
  SET status = 'REFUNDED_IN_SETTLEMENT',
      refunded_at = NOW(),
      updated_at = NOW()
  WHERE settlement_deposit_id = p_deposit_id
    AND status = 'PENDING_SETTLEMENT_PAYOUT';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_recommit_returned_settlement_credits(UUID) TO resihub_app;

COMMIT;
