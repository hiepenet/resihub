-- 046_m06_p2_audit_rls_reservation_policy_and_public.sql
-- M06 Phase 3 (P2):
--   1. Mở rộng reservation hỗ trợ đặt giữ chỗ công khai PENDING_CONFIRM / REJECTED và thanh lý hủy chia phần PARTIALLY_REFUNDED.
--   2. Backfill cột cấu trúc deposit_transaction.category ('TRANSFER_OUT' | 'TRANSFER_IN') cho các bút toán transfer lịch sử.
--   3. Seed cấu hình mặc định system_setting('reservation_cancel_policy') cho mọi tổ chức (FR-005 / FR-067).
--   4. Bổ sung 'receivable' vào rls_audit_log_select cho cả OWNER và MANAGER.
--   5. Mở rộng rls_reservation_update cho phép OWNER / fallback SYS_ADMIN chuyển sang 'PARTIALLY_REFUNDED'.
--   6. Bổ sung owner_entity = 'reservation' vào can_select_attachment (bảo toàn 100% quy tắc PRD 13.5 từ 040).
--   7. Thêm hàm SECURITY DEFINER hẹp fn_notify_reservation_prospect gửi thông báo cho khách đặt giữ chỗ theo SĐT.
--   8. Chuẩn hóa bảng idempotency_key dùng cột phẳng scope_key (UNIQUE (org_id, scope_key, method, route_path, idem_key)).

BEGIN;

-- ============================================================================
-- 1. MỞ RỘNG BẢNG RESERVATION & TRẠNG THÁI
-- ============================================================================
ALTER TABLE reservation
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'INTERNAL'
    CHECK (source IN ('INTERNAL', 'PUBLIC')),
  ADD COLUMN IF NOT EXISTS method TEXT DEFAULT 'BANK_TRANSFER',
  ADD COLUMN IF NOT EXISTS evidence TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_reason TEXT,
  ADD COLUMN IF NOT EXISTS refunded_amount BIGINT NOT NULL DEFAULT 0
    CHECK (refunded_amount >= 0),
  ADD COLUMN IF NOT EXISTS forfeited_amount BIGINT NOT NULL DEFAULT 0
    CHECK (forfeited_amount >= 0),
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS refund_method TEXT
    CHECK (refund_method IS NULL OR refund_method IN ('BANK_TRANSFER', 'CASH')),
  ADD COLUMN IF NOT EXISTS refund_bank_info JSONB,
  ADD COLUMN IF NOT EXISTS refund_evidence TEXT[] NOT NULL DEFAULT '{}';

DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'reservation'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE reservation DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE reservation
  ADD CONSTRAINT reservation_status_check
  CHECK (status IN (
    'PENDING_CONFIRM',
    'HELD',
    'CONVERTED',
    'FORFEITED',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
    'EXPIRED',
    'REJECTED'
  ));

-- ============================================================================
-- 2. BACKFILL DEPOSIT_TRANSACTION.CATEGORY CHO BÚT TOÁN TRANSFER
-- ============================================================================
ALTER TABLE deposit_transaction DISABLE TRIGGER trg_deposit_txn_immutable;

UPDATE deposit_transaction
SET category = CASE
  WHEN description ILIKE 'Chuyển kết dư%' THEN 'TRANSFER_OUT'
  ELSE 'TRANSFER_IN'
END
WHERE type = 'transfer'
  AND category IS NULL;

ALTER TABLE deposit_transaction ENABLE TRIGGER trg_deposit_txn_immutable;

-- ============================================================================
-- 3. SEED CẤU HÌNH CHÍNH SÁCH HỦY GIỮ CHỖ (FR-005 / FR-067 / PRD 23.A.6)
-- ============================================================================
INSERT INTO system_setting (org_id, key, value, description, updated_at)
SELECT
  o.id,
  'reservation_cancel_policy',
  '{"max_hold_days":30,"public_max_hold_days":7,"full_refund_before_days":3,"partial_refund_pct":50,"default_hold_amount":2000000}'::jsonb,
  'Chính sách đặt cọc và hủy giữ chỗ (FR-005 / FR-067, làm tròn hàng nghìn VND theo PRD 10.3)',
  NOW()
FROM organization o
ON CONFLICT (org_id, key) DO NOTHING;

-- ============================================================================
-- 4. CẬP NHẬT RLS AUDIT_LOG SELECT: THÊM 'receivable' CHO OWNER & MANAGER
-- ============================================================================
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
        OR (entity = 'receivable' AND entity_id IN (SELECT id FROM receivable WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
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
        OR (entity = 'receivable' AND entity_id IN (SELECT id FROM receivable WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
      )
    )
  );

-- ============================================================================
-- 5. CẬP NHẬT RLS RESERVATION UPDATE: MỞ 'PARTIALLY_REFUNDED' CHO OWNER / FALLBACK
-- ============================================================================
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
      status IN ('REFUNDED', 'FORFEITED', 'PARTIALLY_REFUNDED')
      AND (
        (is_owner() AND building_id IN (SELECT building_id FROM get_owner_building_ids()))
        OR (is_org_admin() AND NOT building_has_active_owner(building_id))
      )
    )
  );

-- ============================================================================
-- 6. CẬP NHẬT CAN_SELECT_ATTACHMENT: BỔ SUNG owner_entity = 'reservation'
-- ============================================================================
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
      -- PRD Mục 13.5: Chỉ SYS_ADMIN và MANAGER (trong phạm vi tòa nhà) được đọc ảnh CCCD gốc; OWNER bị chặn
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
    END IF;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- ============================================================================
-- 7. HÀM SECURITY DEFINER HẸP: GỬI THÔNG BÁO CHO KHÁCH GIỮ CHỖ THEO SĐT
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_notify_reservation_prospect(
  p_reservation_id UUID,
  p_type TEXT,
  p_title TEXT,
  p_body TEXT
)
RETURNS INT AS $$
DECLARE
  v_caller_id UUID;
  v_rsv RECORD;
  v_allowed BOOLEAN := FALSE;
  v_cnt INT := 0;
BEGIN
  v_caller_id := get_current_user_id();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  SELECT r.id, r.building_id, r.apartment_id, r.phone, b.org_id
  INTO v_rsv
  FROM reservation r
  JOIN building b ON b.id = r.building_id
  WHERE r.id = p_reservation_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF is_org_admin() AND v_rsv.org_id = get_current_user_org_id() THEN
    v_allowed := TRUE;
  ELSIF (is_manager() OR is_owner()) AND v_rsv.building_id IN (SELECT building_id FROM get_user_assigned_buildings()) THEN
    v_allowed := TRUE;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  IF v_rsv.phone IS NULL OR btrim(v_rsv.phone) = '' THEN
    RETURN 0;
  END IF;

  INSERT INTO notification (org_id, user_id, title, content, type, payload)
  SELECT DISTINCT
    v_rsv.org_id,
    au.id,
    p_title,
    p_body,
    p_type,
    jsonb_build_object(
      'reservation_id', v_rsv.id,
      'apartment_id', v_rsv.apartment_id,
      'building_id', v_rsv.building_id,
      'link', '/resident'
    )
  FROM person p
  JOIN app_user au ON au.person_id = p.id
  WHERE p.org_id = v_rsv.org_id
    AND p.phone = v_rsv.phone
    AND au.status = 'ACTIVE';

  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RETURN v_cnt;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_notify_reservation_prospect(UUID, TEXT, TEXT, TEXT) TO PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'resihub_app') THEN
    GRANT EXECUTE ON FUNCTION fn_notify_reservation_prospect(UUID, TEXT, TEXT, TEXT) TO resihub_app;
  END IF;
END $$;

-- ============================================================================
-- 8. CHUẨN HÓA IDEMPOTENCY_KEY DÙNG CỘT PHẲNG scope_key
-- ============================================================================
ALTER TABLE idempotency_key
  ADD COLUMN IF NOT EXISTS scope_key TEXT;

UPDATE idempotency_key
SET scope_key = 'user:' || actor_id::text
WHERE scope_key IS NULL
  AND actor_id IS NOT NULL;

DELETE FROM idempotency_key WHERE scope_key IS NULL;

ALTER TABLE idempotency_key
  ALTER COLUMN scope_key SET NOT NULL;

ALTER TABLE idempotency_key
  ALTER COLUMN actor_id DROP NOT NULL;

DO $$
DECLARE
  v_con RECORD;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'idempotency_key'::regclass
      AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE idempotency_key DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;
END $$;

ALTER TABLE idempotency_key
  ADD CONSTRAINT uq_idempotency_key_scope
  UNIQUE (org_id, scope_key, method, route_path, idem_key);

COMMIT;
