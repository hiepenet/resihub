-- 055_late_fee_carry_forward_and_immutable_invoices.sql
-- Refactor FR-064 & PRD §13.2/§13.5:
--   1. Bổ sung cột invoice.invoice_type ('REGULAR' | 'LATE_FEE_SETTLEMENT') và cho phép period = NULL cho hóa đơn tất toán phí phạt kỳ cuối.
--   2. Tạo bảng late_fee_accrual_tracker lưu lũy kế phí phạt chậm hằng ngày mà không sửa subtotal_amount / total_amount trên hóa đơn đã ISSUED.
--   3. Cấu hình GRANT & FORCE RLS cho late_fee_accrual_tracker.
--   4. Vá Bug #2 trong fn_resolve_invoice_adjustment: trừ v_new_credit_offset khỏi v_new_total sau bước hoàn trả credit dư, và giải phóng carried_to_invoice_id khi hóa đơn đích bị VOID.
--   5. Vá Bug #1 trong fn_apply_deposit_settlement_accounting: bổ sung 'LATE_FEE' vào nhóm v_raw_service để khấu trừ đúng vào tiền cọc khi tất toán (FR-024, FR-068).

BEGIN;

-- ============================================================================
-- 1. CẬP NHẬT BẢNG invoice CHO HÓA ĐƠN TẤT TOÁN PHÍ PHẠT KỲ CUỐI (SPEC §4.4)
-- ============================================================================
ALTER TABLE invoice
  ALTER COLUMN period DROP NOT NULL;

ALTER TABLE invoice
  ADD COLUMN IF NOT EXISTS invoice_type TEXT NOT NULL DEFAULT 'REGULAR';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'invoice'::regclass
      AND conname = 'invoice_invoice_type_check'
  ) THEN
    ALTER TABLE invoice
      ADD CONSTRAINT invoice_invoice_type_check
      CHECK (invoice_type IN ('REGULAR', 'LATE_FEE_SETTLEMENT'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_unique_active_lf_settlement
  ON invoice(contract_id)
  WHERE contract_id IS NOT NULL
    AND invoice_type = 'LATE_FEE_SETTLEMENT'
    AND status <> 'VOID';

-- ============================================================================
-- 2. BẢNG late_fee_accrual_tracker & INDEXES (SPEC §4.2, §4.3)
-- ============================================================================
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

-- Mỗi hóa đơn nguồn chỉ có tối đa 1 dòng tích lũy mở (chưa carry forward) tại một thời điểm (Spec §4.3)
CREATE UNIQUE INDEX IF NOT EXISTS uq_lf_tracker_open_invoice
  ON late_fee_accrual_tracker(invoice_id)
  WHERE carried_to_invoice_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_lf_tracker_contract
  ON late_fee_accrual_tracker(contract_id);

CREATE INDEX IF NOT EXISTS idx_lf_tracker_invoice
  ON late_fee_accrual_tracker(invoice_id);

CREATE INDEX IF NOT EXISTS idx_lf_tracker_pending
  ON late_fee_accrual_tracker(contract_id)
  WHERE carried_to_invoice_id IS NULL;

-- ============================================================================
-- 3. GRANTS & FORCE ROW LEVEL SECURITY TRÊN late_fee_accrual_tracker
-- ============================================================================
GRANT SELECT, UPDATE ON late_fee_accrual_tracker TO resihub_app;

ALTER TABLE late_fee_accrual_tracker ENABLE ROW LEVEL SECURITY;
ALTER TABLE late_fee_accrual_tracker FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_lf_tracker_select ON late_fee_accrual_tracker;
CREATE POLICY rls_lf_tracker_select ON late_fee_accrual_tracker FOR SELECT USING (
  is_org_admin()
  OR contract_id IN (
    SELECT c.id FROM contract c
    WHERE c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_lf_tracker_update ON late_fee_accrual_tracker;
CREATE POLICY rls_lf_tracker_update ON late_fee_accrual_tracker FOR UPDATE USING (
  is_manager()
  AND contract_id IN (
    SELECT c.id FROM contract c
    WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
) WITH CHECK (
  is_manager()
  AND contract_id IN (
    SELECT c.id FROM contract c
    WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);

-- ============================================================================
-- 4. VÁ BUG #2 TRONG fn_resolve_invoice_adjustment (SPEC §6)
-- ============================================================================
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
  v_gross_after_adj BIGINT;
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

    -- Giải phóng tracker phí phạt đã carry sang hóa đơn này (hợp nhất vào dòng mở nếu đã có)
    FOR v_cr IN
      SELECT id, invoice_id, accrued_total, chargeable_days, as_of_date
      FROM late_fee_accrual_tracker
      WHERE carried_to_invoice_id = v_inv.id
      FOR UPDATE
    LOOP
      IF EXISTS (
        SELECT 1 FROM late_fee_accrual_tracker
        WHERE invoice_id = v_cr.invoice_id
          AND carried_to_invoice_id IS NULL
          AND id <> v_cr.id
      ) THEN
        UPDATE late_fee_accrual_tracker
        SET accrued_total = accrued_total + v_cr.accrued_total,
            chargeable_days = GREATEST(chargeable_days, v_cr.chargeable_days),
            as_of_date = GREATEST(as_of_date, v_cr.as_of_date),
            updated_at = NOW()
        WHERE invoice_id = v_cr.invoice_id
          AND carried_to_invoice_id IS NULL
          AND id <> v_cr.id;

        DELETE FROM late_fee_accrual_tracker WHERE id = v_cr.id;
      ELSE
        UPDATE late_fee_accrual_tracker
        SET carried_to_invoice_id = NULL,
            carried_at = NULL,
            updated_at = NOW()
        WHERE id = v_cr.id;
      END IF;
    END LOOP;

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
        format('Hủy hóa đơn kỳ %s', COALESCE(v_inv.period, 'tất toán')),
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

  -- Triệt tiêu append-only phạt nộp muộn nếu hóa đơn REGULAR chưa thu tiền và nợ gốc về <= 0
  IF v_inv.paid_amount = 0 AND COALESCE(v_inv.invoice_type, 'REGULAR') <> 'LATE_FEE_SETTLEMENT' THEN
    SELECT COALESCE(SUM(il.amount), 0)
    INTO v_principal
    FROM invoice_line il
    WHERE il.invoice_id = v_inv.id
      AND il.credit_id IS NULL
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
  v_gross_after_adj := GREATEST(0, v_new_subtotal + v_new_adjustment);

  -- Xử lý hoàn lại credit_offset_amount dư về credit_balance
  IF v_inv.credit_offset_amount > v_gross_after_adj THEN
    v_excess_credit := v_inv.credit_offset_amount - v_gross_after_adj;
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
    v_new_credit_offset := v_gross_after_adj;
  ELSE
    v_new_credit_offset := v_inv.credit_offset_amount;
  END IF;

  -- Bug #2 Fix: trừ v_new_credit_offset khỏi tổng tiền sau điều chỉnh
  v_new_total := GREATEST(0, v_gross_after_adj - v_new_credit_offset);

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
      format('Điều chỉnh hóa đơn kỳ %s', COALESCE(v_inv.period, 'tất toán')),
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

-- ============================================================================
-- 5. VÁ BUG #1 TRONG fn_apply_deposit_settlement_accounting (SPEC §5)
-- ============================================================================
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

    -- Tính raw_rent và raw_service qua invoice_line & invoice_adjustment (Bug #1 Fix: bổ sung 'LATE_FEE')
    SELECT
      COALESCE(SUM(il.amount) FILTER (
        WHERE (il.item_type = 'RENT'
           OR (il.item_type = 'ADJUSTMENT' AND (ia.adjustment_target = 'RENT' OR il.formula_meta->>'adjusts_item_type' = 'RENT')))
          AND il.credit_id IS NULL
      ), 0)::bigint,
      COALESCE(SUM(il.amount) FILTER (
        WHERE (il.item_type IN ('SERVICE', 'ELECTRICITY', 'WATER', 'OTHER', 'LATE_FEE')
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

COMMIT;
