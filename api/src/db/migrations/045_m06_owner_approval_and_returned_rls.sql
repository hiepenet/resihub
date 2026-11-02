-- 045_m06_owner_approval_and_returned_rls.sql
-- M06 Phase 2 (P1):
--   1. Mở rộng trạng thái deposit ('APPROVED_PENDING_PAYOUT', 'RETURNED') và deposit_transaction ('refund_reversal', reference_code).
--   2. Siết chặt RLS trên deposit, deposit_transaction, reservation, audit_log theo PRD v2.0 Mục 6.2:
--      - MANAGER: CRU trên tòa được phân công (get_manager_building_ids).
--      - OWNER: R + A (phê duyệt hoàn cọc / xử lý cọc giữ chỗ) trên tòa sở hữu (get_owner_building_ids);
--        KHÔNG mở quyền ghi trực tiếp lên invoice, receivable, apartment.
--      - SYS_ADMIN: R toàn tổ chức; chỉ dự phòng A khi tòa nhà chưa có OWNER hoạt động (NOT building_has_active_owner).
--      - RESIDENT: R trên hợp đồng của mình + gửi khiếu nại / cập nhật TK nhận hoàn qua hàm SECURITY DEFINER hẹp.
--   3. Khởi tạo 6 hàm SECURITY DEFINER hẹp phục vụ truy vấn metadata không lộ PII, hạch toán đối trừ cọc,
--      đồng bộ trạng thái căn hộ sau hủy giữ chỗ, khiếu nại 1 chu kỳ 7 ngày, cập nhật TK hoàn cọc và gửi thông báo.

BEGIN;

-- ============================================================================
-- 1. MỞ RỘNG CHECK CONSTRAINTS & CỘT CHỨNG TỪ GIAO DỊCH CỌC
-- ============================================================================
DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'deposit'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE deposit DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE deposit
  ADD CONSTRAINT deposit_status_check
  CHECK (status IN (
    'HELD',
    'SETTLEMENT_DRAFT',
    'PENDING_APPROVAL',
    'APPROVED_PENDING_PAYOUT',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'DEDUCTED_FULL',
    'TRANSFERRED',
    'DISPUTED',
    'RETURNED'
  ));

ALTER TABLE deposit_transaction
  ADD COLUMN IF NOT EXISTS reference_code TEXT;

DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'deposit_transaction'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%type%'
  LOOP
    EXECUTE format('ALTER TABLE deposit_transaction DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE deposit_transaction
  ADD CONSTRAINT deposit_transaction_type_check
  CHECK (type IN ('collect', 'deduct', 'refund', 'transfer', 'refund_reversal'));

-- ============================================================================
-- 2. SIẾT CHẶT RLS THEO MA TRẬN RBAC PRD MỤC 6.2
-- ============================================================================

-- 2a. DEPOSIT: MANAGER = CRU; OWNER / fallback SYS_ADMIN = A (chỉ duyệt/từ chối/giải quyết tranh chấp)
DROP POLICY IF EXISTS rls_deposit_insert ON deposit;
CREATE POLICY rls_deposit_insert ON deposit FOR INSERT
  WITH CHECK (
    is_manager()
    AND contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

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
        'DEDUCTED_FULL'
      )
      AND contract_id IN (
        SELECT c.id FROM contract c
        WHERE (is_owner() AND c.building_id IN (SELECT building_id FROM get_owner_building_ids()))
           OR (is_org_admin() AND NOT building_has_active_owner(c.building_id))
      )
    )
  );

-- 2b. DEPOSIT_TRANSACTION: MANAGER = CRU; OWNER / fallback SYS_ADMIN chỉ được ghi bút toán 'deduct' khi duyệt DEDUCTED_FULL (refund = 0)
DROP POLICY IF EXISTS rls_deposit_txn_insert ON deposit_transaction;
CREATE POLICY rls_deposit_txn_insert ON deposit_transaction FOR INSERT
  WITH CHECK (
    (
      is_manager()
      AND deposit_id IN (
        SELECT d.id FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
      )
    )
    OR (
      type = 'deduct'
      AND deposit_id IN (
        SELECT d.id FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        WHERE (is_owner() AND c.building_id IN (SELECT building_id FROM get_owner_building_ids()))
           OR (is_org_admin() AND NOT building_has_active_owner(c.building_id))
      )
    )
  );

DROP POLICY IF EXISTS rls_deposit_txn_update ON deposit_transaction;
CREATE POLICY rls_deposit_txn_update ON deposit_transaction FOR UPDATE
  USING (
    status <> 'APPROVED'
    AND is_manager()
    AND deposit_id IN (
      SELECT d.id FROM deposit d
      JOIN contract c ON c.id = d.contract_id
      WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  )
  WITH CHECK (
    is_manager()
    AND deposit_id IN (
      SELECT d.id FROM deposit d
      JOIN contract c ON c.id = d.contract_id
      WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

-- 2c. RESERVATION: MANAGER = CRU; OWNER / fallback SYS_ADMIN = A (hoàn / tịch thu cọc giữ chỗ từ HELD/EXPIRED)
DROP POLICY IF EXISTS rls_reservation_insert ON reservation;
CREATE POLICY rls_reservation_insert ON reservation FOR INSERT
  WITH CHECK (
    is_manager()
    AND building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_reservation_update ON reservation;
CREATE POLICY rls_reservation_update ON reservation FOR UPDATE
  USING (
    (
      is_manager()
      AND building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
    OR (
      status IN ('HELD', 'EXPIRED')
      AND (
        (is_owner() AND building_id IN (SELECT building_id FROM get_owner_building_ids()))
        OR (is_org_admin() AND NOT building_has_active_owner(building_id))
      )
    )
  )
  WITH CHECK (
    (
      is_manager()
      AND building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
    OR (
      status IN ('REFUNDED', 'FORFEITED')
      AND (
        (is_owner() AND building_id IN (SELECT building_id FROM get_owner_building_ids()))
        OR (is_org_admin() AND NOT building_has_active_owner(building_id))
      )
    )
  );

-- 2d. AUDIT_LOG SELECT: giữ nguyên SYS_ADMIN + OWNER (038) và bổ sung MANAGER trên các thực thể căn hộ/cọc/giữ chỗ thuộc tòa được gán
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
        OR (entity = 'payment' AND entity_id IN (SELECT id FROM payment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
      )
    )
    OR (
      is_manager() AND (
        (entity = 'apartment' AND entity_id IN (SELECT id FROM apartment WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'reservation' AND entity_id IN (SELECT id FROM reservation WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'deposit' AND entity_id IN (SELECT d.id FROM deposit d JOIN contract c ON c.id = d.contract_id WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'deposit_transaction' AND entity_id IN (
          SELECT dt.id
          FROM deposit_transaction dt
          JOIN deposit d ON d.id = dt.deposit_id
          JOIN contract c ON c.id = d.contract_id
          WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
        ))
      )
    )
  );

-- ============================================================================
-- 3. NARROW SECURITY DEFINER HELPERS (SET search_path = public, pg_temp)
-- ============================================================================

-- 3.1 Metadata kiểm tra quyền truy cập sổ cọc & nghiệm thu bàn giao (không lộ PII/số tiền)
CREATE OR REPLACE FUNCTION fn_get_deposit_access_meta(p_deposit_id UUID)
RETURNS TABLE (
  deposit_id UUID,
  contract_id UUID,
  apartment_id UUID,
  building_id UUID,
  org_id UUID,
  building_has_active_owner BOOLEAN,
  is_contract_resident BOOLEAN,
  is_primary_resident BOOLEAN,
  latest_photo_handover_at TIMESTAMPTZ
) AS $$
DECLARE
  v_caller_org UUID;
BEGIN
  v_caller_org := get_current_user_org_id();
  IF v_caller_org IS NULL OR p_deposit_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    d.id AS deposit_id,
    c.id AS contract_id,
    c.apartment_id,
    c.building_id,
    b.org_id,
    building_has_active_owner(c.building_id) AS building_has_active_owner,
    (c.id IN (SELECT rc.contract_id FROM get_resident_contract_ids() rc)) AS is_contract_resident,
    (c.primary_tenant_id IN (SELECT rt.tenant_id FROM get_resident_tenant_ids() rt)) AS is_primary_resident,
    (
      SELECT MAX(al.at)
      FROM audit_log al
      WHERE al.entity = 'apartment'
        AND al.action = 'HANDOVER'
        AND al.entity_id = c.apartment_id
        AND (
          (al.at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= COALESCE(c.terminated_at, c.end_date)
          OR al.at::date >= COALESCE(c.terminated_at, c.end_date)
        )
        AND jsonb_typeof(COALESCE(al.after->'evidence', '[]'::jsonb)) = 'array'
        AND jsonb_array_length(COALESCE(al.after->'evidence', '[]'::jsonb)) >= 1
    ) AS latest_photo_handover_at
  FROM deposit d
  JOIN contract c ON c.id = d.contract_id
  JOIN building b ON b.id = c.building_id
  WHERE d.id = p_deposit_id
    AND b.org_id = v_caller_org;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- 3.2 Hạch toán đối trừ công nợ dịch vụ vào hóa đơn mở & sinh công nợ sau trả phòng (R-06, FR-024)
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
  v_remaining_cover BIGINT := GREATEST(0, COALESCE(p_covered_service_debt, 0));
  v_inv RECORD;
  v_total BIGINT;
  v_paid BIGINT;
  v_remaining BIGINT;
  v_rent_gross BIGINT;
  v_non_rent_gross BIGINT;
  v_paid_to_rent BIGINT;
  v_inv_rent_unpaid BIGINT;
  v_inv_service_unpaid BIGINT;
  v_apply_amt BIGINT;
  v_new_paid BIGINT;
  v_new_status TEXT;
  v_still_unpaid BIGINT;
BEGIN
  v_actor_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();
  IF v_actor_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
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

  FOR v_inv IN
    SELECT i.id, i.invoice_code, i.period, i.total_amount, i.paid_amount, i.status
    FROM invoice i
    WHERE i.contract_id = v_dep.contract_id
      AND i.status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
    ORDER BY i.period ASC, i.created_at ASC
    FOR UPDATE
  LOOP
    v_total := GREATEST(0, COALESCE(v_inv.total_amount, 0));
    v_paid := GREATEST(0, COALESCE(v_inv.paid_amount, 0));
    v_remaining := GREATEST(0, v_total - v_paid);
    IF v_remaining <= 0 THEN
      CONTINUE;
    END IF;

    SELECT
      GREATEST(0, COALESCE(SUM(il.amount) FILTER (WHERE il.item_type = 'RENT'), 0))::bigint,
      GREATEST(0, COALESCE(SUM(il.amount) FILTER (WHERE il.item_type <> 'RENT'), 0))::bigint
    INTO v_rent_gross, v_non_rent_gross
    FROM invoice_line il
    WHERE il.invoice_id = v_inv.id;

    IF v_rent_gross = 0 AND v_non_rent_gross = 0 THEN
      v_inv_rent_unpaid := 0;
      v_inv_service_unpaid := v_remaining;
    ELSIF v_non_rent_gross = 0 THEN
      v_inv_rent_unpaid := v_remaining;
      v_inv_service_unpaid := 0;
    ELSIF v_rent_gross = 0 THEN
      v_inv_rent_unpaid := 0;
      v_inv_service_unpaid := v_remaining;
    ELSE
      v_paid_to_rent := LEAST(v_paid, v_rent_gross);
      v_inv_rent_unpaid := GREATEST(0, LEAST(v_remaining, v_rent_gross - v_paid_to_rent));
      v_inv_service_unpaid := GREATEST(0, v_remaining - v_inv_rent_unpaid);
    END IF;

    v_apply_amt := 0;
    IF v_remaining_cover > 0 AND v_inv_service_unpaid > 0 THEN
      v_apply_amt := LEAST(v_remaining_cover, v_inv_service_unpaid);
      v_remaining_cover := v_remaining_cover - v_apply_amt;
    END IF;

    v_new_paid := v_paid + v_apply_amt;
    v_new_status := CASE
      WHEN v_new_paid >= v_total THEN 'PAID'
      WHEN v_new_paid > 0 THEN 'PARTIALLY_PAID'
      ELSE v_inv.status
    END;

    IF v_apply_amt > 0 THEN
      UPDATE invoice
      SET paid_amount = v_new_paid,
          status = v_new_status,
          updated_at = NOW()
      WHERE id = v_inv.id;

      INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
      VALUES (
        v_actor_id,
        'SETTLEMENT_OFFSET',
        'invoice',
        v_inv.id,
        jsonb_build_object(
          'deposit_id', p_deposit_id,
          'applied_service_offset', v_apply_amt,
          'paid_amount', v_new_paid,
          'status', v_new_status
        )
      );
    END IF;

    v_still_unpaid := GREATEST(0, v_total - v_new_paid);
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
      SET amount = GREATEST(paid_amount, v_total),
          paid_amount = LEAST(GREATEST(paid_amount, v_total), v_new_paid),
          status = CASE WHEN v_new_paid > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
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
          v_total,
          v_new_paid,
          CURRENT_DATE + 7,
          CASE WHEN v_new_paid > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
          format(
            'Công nợ hóa đơn %s còn tồn đọng sau trả phòng (gồm tiền thuê không cấn trừ cọc / dịch vụ vượt cọc)',
            v_inv.invoice_code
          )
        );
      END IF;
    END IF;
  END LOOP;

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

-- 3.3 Đồng bộ trạng thái căn hộ sau khi hoàn / tịch thu phiếu giữ chỗ (cho phép OWNER / fallback SYS_ADMIN qua hàm hẹp)
CREATE OR REPLACE FUNCTION fn_sync_apartment_status_after_reservation(p_apartment_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_caller_org UUID;
  v_apt RECORD;
  v_today_vn DATE := (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  v_target TEXT;
BEGIN
  v_caller_org := get_current_user_org_id();
  IF v_caller_org IS NULL OR p_apartment_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT a.id, a.status, a.building_id, b.org_id
  INTO v_apt
  FROM apartment a
  JOIN building b ON b.id = a.building_id
  WHERE a.id = p_apartment_id
    AND b.org_id = v_caller_org
  FOR UPDATE OF a;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT (
    (is_manager() AND v_apt.building_id IN (SELECT building_id FROM get_manager_building_ids()))
    OR (is_owner() AND v_apt.building_id IN (SELECT building_id FROM get_owner_building_ids()))
    OR (is_org_admin() AND NOT building_has_active_owner(v_apt.building_id))
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN_APARTMENT_SYNC' USING ERRCODE = '42501';
  END IF;

  IF v_apt.status IN ('INACTIVE', 'BLOCKED') THEN
    RETURN v_apt.status;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM contract c
    WHERE c.apartment_id = p_apartment_id
      AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
      AND c.start_date <= v_today_vn
      AND COALESCE(c.terminated_at, c.end_date) > v_today_vn
  ) THEN
    v_target := 'OCCUPIED';
  ELSIF v_apt.status = 'MAINTENANCE' THEN
    v_target := 'MAINTENANCE';
  ELSIF EXISTS (
    SELECT 1
    FROM contract c
    WHERE c.apartment_id = p_apartment_id
      AND c.status IN ('ACTIVE', 'RENEWAL_PENDING')
      AND c.start_date > v_today_vn
    UNION ALL
    SELECT 1
    FROM reservation r
    WHERE r.apartment_id = p_apartment_id
      AND r.status = 'HELD'
      AND (r.hold_until IS NULL OR r.hold_until >= v_today_vn)
  ) THEN
    v_target := 'RESERVED';
  ELSE
    v_target := 'AVAILABLE';
  END IF;

  IF v_target <> v_apt.status THEN
    UPDATE apartment
    SET status = v_target,
        updated_at = NOW()
    WHERE id = p_apartment_id;
  END IF;

  RETURN v_target;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- 3.4 Gửi khiếu nại bảng kê tất toán cọc (giới hạn 7 ngày sau tất toán & tối đa 1 chu kỳ hậu tất toán)
CREATE OR REPLACE FUNCTION fn_submit_deposit_dispute(
  p_deposit_id UUID,
  p_reason TEXT
)
RETURNS deposit AS $$
DECLARE
  v_user_id UUID;
  v_caller_org UUID;
  v_dep deposit%ROWTYPE;
  v_contract_id UUID;
  v_building_id UUID;
  v_apartment_code TEXT;
  v_org_id UUID;
  v_actor_role TEXT;
  v_trimmed_reason TEXT := BTRIM(COALESCE(p_reason, ''));
  v_settlement JSONB;
  v_thread JSONB;
  v_anchor_ts TIMESTAMPTZ;
  v_now_iso TEXT;
BEGIN
  v_user_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();
  IF v_user_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  IF v_trimmed_reason = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
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

  SELECT c.id, c.building_id, a.code, b.org_id
  INTO v_contract_id, v_building_id, v_apartment_code, v_org_id
  FROM contract c
  JOIN apartment a ON a.id = c.apartment_id
  JOIN building b ON b.id = c.building_id
  WHERE c.id = v_dep.contract_id;

  IF v_contract_id IN (SELECT rc.contract_id FROM get_resident_contract_ids() rc) THEN
    v_actor_role := 'RESIDENT';
  ELSIF is_manager() AND v_building_id IN (SELECT mb.building_id FROM get_manager_building_ids() mb) THEN
    v_actor_role := 'MANAGER';
  ELSE
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  v_settlement := COALESCE(v_dep.settlement, '{}'::jsonb);

  IF COALESCE(v_settlement->>'post_settlement_dispute_closed', 'false') = 'true' THEN
    RAISE EXCEPTION 'DISPUTE_ALREADY_FINALIZED' USING ERRCODE = 'P0001';
  END IF;

  IF v_dep.status NOT IN (
    'PENDING_APPROVAL',
    'APPROVED_PENDING_PAYOUT',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'DEDUCTED_FULL'
  ) THEN
    RAISE EXCEPTION 'DISPUTE_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(v_settlement->>'accounting_committed_at', '') <> ''
     OR v_dep.status IN ('PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL') THEN
    v_anchor_ts := COALESCE(
      NULLIF(v_settlement->>'payout_at', '')::timestamptz,
      NULLIF(v_settlement->>'approved_at', '')::timestamptz,
      v_dep.updated_at
    );
    IF NOW() > v_anchor_ts + INTERVAL '7 days' THEN
      RAISE EXCEPTION 'DISPUTE_WINDOW_EXPIRED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_thread := CASE
    WHEN jsonb_typeof(v_settlement->'dispute_thread') = 'array' THEN v_settlement->'dispute_thread'
    ELSE '[]'::jsonb
  END;
  v_now_iso := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  v_settlement := v_settlement || jsonb_build_object(
    'previous_status_before_dispute', v_dep.status,
    'disputed_by', v_user_id::text,
    'disputed_by_role', v_actor_role,
    'disputed_at', v_now_iso,
    'dispute_reason', v_trimmed_reason,
    'dispute_thread', v_thread || jsonb_build_array(
      jsonb_build_object(
        'type', 'DISPUTE',
        'at', v_now_iso,
        'by', v_user_id::text,
        'role', v_actor_role,
        'message', v_trimmed_reason
      )
    )
  );

  UPDATE deposit
  SET status = 'DISPUTED',
      settlement = v_settlement,
      updated_at = NOW()
  WHERE id = p_deposit_id
  RETURNING * INTO v_dep;

  INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
  VALUES (v_user_id, 'SETTLEMENT_DISPUTE', 'deposit', p_deposit_id, v_settlement);

  IF v_actor_role = 'RESIDENT' THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_org_id,
      ur.user_id,
      format('Khiếu nại tất toán cọc căn %s', v_apartment_code),
      format('Cư dân đã gửi ý kiến không đồng ý với bảng kê tất toán cọc: "%s"', v_trimmed_reason),
      'DEPOSIT_DISPUTED',
      jsonb_build_object('deposit_id', p_deposit_id, 'contract_id', v_contract_id)
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    JOIN app_user au ON au.id = ur.user_id
    WHERE ur.building_id = v_building_id
      AND r.code = 'MANAGER'
      AND au.status = 'ACTIVE';
  END IF;

  RETURN v_dep;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- 3.5 Cập nhật tài khoản ngân hàng nhận hoàn cọc (cho MANAGER tòa nhà hoặc cư dân đứng tên HĐ chính)
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

-- 3.6 Gửi thông báo nghiệp vụ cọc (RESIDENT / BUILDING_OWNERS / BUILDING_MANAGERS / SPECIFIC_USER) không cần adminPool
CREATE OR REPLACE FUNCTION fn_notify_deposit_event(
  p_deposit_id UUID,
  p_target_audience TEXT,
  p_type TEXT,
  p_title TEXT,
  p_content TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_specific_user_id UUID DEFAULT NULL
)
RETURNS INT AS $$
DECLARE
  v_user_id UUID;
  v_caller_org UUID;
  v_meta RECORD;
  v_cnt INT := 0;
BEGIN
  v_user_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();
  IF v_user_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT
    d.id AS deposit_id,
    c.id AS contract_id,
    c.building_id,
    c.primary_tenant_id,
    b.org_id
  INTO v_meta
  FROM deposit d
  JOIN contract c ON c.id = d.contract_id
  JOIN building b ON b.id = c.building_id
  WHERE d.id = p_deposit_id
    AND b.org_id = v_caller_org;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF NOT (
    is_org_admin()
    OR v_meta.building_id IN (SELECT ub.building_id FROM get_user_assigned_buildings() ub)
    OR v_meta.contract_id IN (SELECT rc.contract_id FROM get_resident_contract_ids() rc)
  ) THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  IF p_target_audience = 'RESIDENT' THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_meta.org_id,
      au.id,
      p_title,
      p_content,
      p_type,
      COALESCE(p_payload, '{}'::jsonb)
    FROM app_user au
    JOIN tenant t ON t.person_id = au.person_id
    WHERE au.status = 'ACTIVE'
      AND t.id = v_meta.primary_tenant_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;

  ELSIF p_target_audience = 'BUILDING_OWNERS' THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_meta.org_id,
      au.id,
      p_title,
      p_content,
      p_type,
      COALESCE(p_payload, '{}'::jsonb)
    FROM building b
    JOIN owner o ON o.id = b.owner_id
    JOIN app_user au ON au.person_id = o.person_id
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    WHERE b.id = v_meta.building_id
      AND au.status = 'ACTIVE'
      AND r.code = 'OWNER';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;

  ELSIF p_target_audience = 'BUILDING_MANAGERS' THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_meta.org_id,
      au.id,
      p_title,
      p_content,
      p_type,
      COALESCE(p_payload, '{}'::jsonb)
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    JOIN app_user au ON au.id = ur.user_id
    WHERE ur.building_id = v_meta.building_id
      AND r.code = 'MANAGER'
      AND au.status = 'ACTIVE';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;

  ELSIF p_target_audience = 'SPECIFIC_USER' AND p_specific_user_id IS NOT NULL THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT
      v_meta.org_id,
      au.id,
      p_title,
      p_content,
      p_type,
      COALESCE(p_payload, '{}'::jsonb)
    FROM app_user au
    JOIN person p ON p.id = au.person_id
    WHERE au.id = p_specific_user_id
      AND p.org_id = v_meta.org_id
      AND au.status = 'ACTIVE';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
  END IF;

  RETURN v_cnt;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_get_deposit_access_meta(UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fn_apply_deposit_settlement_accounting(UUID, BIGINT, BIGINT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fn_sync_apartment_status_after_reservation(UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fn_submit_deposit_dispute(UUID, TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fn_update_deposit_refund_bank_info(UUID, JSONB) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fn_notify_deposit_event(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) TO PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'resihub_app') THEN
    GRANT EXECUTE ON FUNCTION fn_get_deposit_access_meta(UUID) TO resihub_app;
    GRANT EXECUTE ON FUNCTION fn_apply_deposit_settlement_accounting(UUID, BIGINT, BIGINT) TO resihub_app;
    GRANT EXECUTE ON FUNCTION fn_sync_apartment_status_after_reservation(UUID) TO resihub_app;
    GRANT EXECUTE ON FUNCTION fn_submit_deposit_dispute(UUID, TEXT) TO resihub_app;
    GRANT EXECUTE ON FUNCTION fn_update_deposit_refund_bank_info(UUID, JSONB) TO resihub_app;
    GRANT EXECUTE ON FUNCTION fn_notify_deposit_event(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID) TO resihub_app;
  END IF;
END $$;

COMMIT;
