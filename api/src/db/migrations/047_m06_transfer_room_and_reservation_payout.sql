-- 047_m06_transfer_room_and_reservation_payout.sql
-- Chuẩn hóa M05/M06 bám sát 100% PRD v2.0 (FR-013, FR-014, FR-017, FR-020, FR-025, FR-067, FR-070, AC-009.2, Mục 6.1–6.2, Mục 7.5):
--   1. Mở rộng contract thêm is_room_transfer, transfer_deposit và partial unique index uq_contract_open_room_transfer.
--   2. Mở rộng reservation thêm cancel_settlement JSONB và 2 trạng thái tường minh CANCEL_PENDING_APPROVAL, APPROVED_PENDING_PAYOUT.
--   3. Siết chặt rls_reservation_update: OWNER / fallback SYS_ADMIN chỉ được duyệt sang APPROVED_PENDING_PAYOUT / FORFEITED (hoặc từ chối về HELD / EXPIRED),
--      tuyệt đối không thể nhảy tắt sang REFUNDED / PARTIALLY_REFUNDED khi chưa qua bước MANAGER thực chi đính kèm UNC.
--   4. Cập nhật fn_sync_apartment_status_after_reservation: giữ RESERVED khi CANCEL_PENDING_APPROVAL còn hạn, giải phóng ngay về AVAILABLE khi APPROVED_PENDING_PAYOUT / FORFEITED.
--   5. Thêm fn_notify_reservation_staff và fn_update_reservation_refund_bank_info (SECURITY DEFINER hẹp).

BEGIN;

-- ============================================================================
-- 1. MỞ RỘNG BẢNG CONTRACT CHO LUỒNG ĐỔI PHÒNG 4 BƯỚC (FR-013 / FR-025 / AC-009.2)
-- ============================================================================
ALTER TABLE contract
  ADD COLUMN IF NOT EXISTS is_room_transfer BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS transfer_deposit BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_open_room_transfer
  ON contract (parent_contract_id)
  WHERE is_room_transfer = TRUE
    AND status IN ('DRAFT', 'PENDING_APPROVAL');

-- ============================================================================
-- 2. MỞ RỘNG BẢNG RESERVATION & TRẠNG THÁI DUYỆT — CHI TÁCH BIỆT (FR-067)
-- ============================================================================
ALTER TABLE reservation
  ADD COLUMN IF NOT EXISTS cancel_settlement JSONB;

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
    'CANCEL_PENDING_APPROVAL',
    'APPROVED_PENDING_PAYOUT',
    'CONVERTED',
    'FORFEITED',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
    'EXPIRED',
    'REJECTED'
  ));

-- ============================================================================
-- 3. SIẾT CHẶT RLS RESERVATION UPDATE ĐÚNG VAI TRÒ PRD MỤC 6.2
-- ============================================================================
DROP POLICY IF EXISTS rls_reservation_update ON reservation;
CREATE POLICY rls_reservation_update ON reservation FOR UPDATE
  USING (
    (
      is_manager()
      AND building_id IN (SELECT building_id FROM get_manager_building_ids())
      AND status IN ('PENDING_CONFIRM', 'HELD', 'EXPIRED', 'CANCEL_PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT')
    )
    OR (
      status IN ('HELD', 'EXPIRED', 'CANCEL_PENDING_APPROVAL')
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
      AND status IN (
        'HELD',
        'REJECTED',
        'CONVERTED',
        'CANCEL_PENDING_APPROVAL',
        'APPROVED_PENDING_PAYOUT',
        'FORFEITED',
        'REFUNDED',
        'PARTIALLY_REFUNDED',
        'EXPIRED'
      )
    )
    OR (
      status IN ('HELD', 'EXPIRED', 'APPROVED_PENDING_PAYOUT', 'FORFEITED')
      AND (
        (is_owner() AND building_id IN (SELECT building_id FROM get_owner_building_ids()))
        OR (is_org_admin() AND NOT building_has_active_owner(building_id))
      )
    )
  );

-- ============================================================================
-- 4. CẬP NHẬT ĐỒNG BỘ TRẠNG THÁI CĂN HỘ SAU DUYỆT HỦY GIỮ CHỖ
-- ============================================================================
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
      AND r.status IN ('HELD', 'CANCEL_PENDING_APPROVAL')
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

-- ============================================================================
-- 5. HÀM THÔNG BÁO NỘI BỘ CHO NHÂN SỰ / CHỦ NHÀ VỀ PHIẾU GIỮ CHỖ
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_notify_reservation_staff(
  p_reservation_id UUID,
  p_target_audience TEXT,
  p_type TEXT,
  p_title TEXT,
  p_body TEXT
)
RETURNS INT AS $$
DECLARE
  v_user_id UUID;
  v_caller_org UUID;
  v_rsv RECORD;
  v_allowed BOOLEAN := FALSE;
  v_has_owner BOOLEAN := FALSE;
  v_payload JSONB;
  v_cnt INT := 0;
BEGIN
  v_user_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();
  IF v_user_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT r.id, r.building_id, r.apartment_id, r.phone, b.org_id
  INTO v_rsv
  FROM reservation r
  JOIN building b ON b.id = r.building_id
  WHERE r.id = p_reservation_id
    AND b.org_id = v_caller_org;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF is_org_admin() AND NOT building_has_active_owner(v_rsv.building_id) THEN
    v_allowed := TRUE;
  ELSIF (is_manager() OR is_owner()) AND v_rsv.building_id IN (SELECT building_id FROM get_user_assigned_buildings()) THEN
    v_allowed := TRUE;
  ELSIF is_resident() AND v_rsv.phone = (SELECT p.phone FROM person p WHERE p.id = get_current_user_person_id()) THEN
    v_allowed := TRUE;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  v_payload := jsonb_build_object(
    'reservation_id', v_rsv.id,
    'apartment_id', v_rsv.apartment_id,
    'building_id', v_rsv.building_id,
    'link', '/admin/apartments/' || v_rsv.apartment_id::text
  );

  IF p_target_audience = 'APPROVERS' THEN
    v_has_owner := building_has_active_owner(v_rsv.building_id);
    IF v_has_owner THEN
      INSERT INTO notification (org_id, user_id, title, content, type, payload)
      SELECT DISTINCT
        v_rsv.org_id,
        au.id,
        p_title,
        p_body,
        p_type,
        v_payload
      FROM building b
      JOIN owner o ON o.id = b.owner_id
      JOIN app_user au ON au.person_id = o.person_id
      JOIN user_role ur ON ur.user_id = au.id
      JOIN role r ON r.id = ur.role_id
      WHERE b.id = v_rsv.building_id
        AND au.status = 'ACTIVE'
        AND r.code = 'OWNER'
        AND au.id <> v_user_id;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
    ELSE
      INSERT INTO notification (org_id, user_id, title, content, type, payload)
      SELECT DISTINCT
        v_rsv.org_id,
        au.id,
        p_title,
        p_body,
        p_type,
        v_payload
      FROM user_role ur
      JOIN role r ON r.id = ur.role_id
      JOIN app_user au ON au.id = ur.user_id
      JOIN person p ON p.id = au.person_id
      WHERE p.org_id = v_rsv.org_id
        AND au.status = 'ACTIVE'
        AND au.id <> v_user_id
        AND (
          r.code = 'SYS_ADMIN'
          OR (r.code = 'MANAGER' AND ur.building_id = v_rsv.building_id)
        );
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
    END IF;

  ELSIF p_target_audience = 'BUILDING_MANAGERS' THEN
    INSERT INTO notification (org_id, user_id, title, content, type, payload)
    SELECT DISTINCT
      v_rsv.org_id,
      au.id,
      p_title,
      p_body,
      p_type,
      v_payload
    FROM user_role ur
    JOIN role r ON r.id = ur.role_id
    JOIN app_user au ON au.id = ur.user_id
    WHERE ur.building_id = v_rsv.building_id
      AND r.code = 'MANAGER'
      AND au.status = 'ACTIVE';
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
  END IF;

  RETURN v_cnt;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

-- ============================================================================
-- 6. HÀM SECURITY DEFINER CẬP NHẬT STK NHẬN HOÀN GIỮ CHỖ (MANAGER / RESIDENT)
-- ============================================================================
CREATE OR REPLACE FUNCTION fn_update_reservation_refund_bank_info(
  p_reservation_id UUID,
  p_bank_info JSONB
)
RETURNS reservation AS $$
DECLARE
  v_user_id UUID;
  v_caller_org UUID;
  v_rsv reservation%ROWTYPE;
  v_before_bank JSONB;
  v_now_iso TEXT;
  v_meta JSONB;
BEGIN
  v_user_id := get_current_user_id();
  v_caller_org := get_current_user_org_id();
  IF v_user_id IS NULL OR v_caller_org IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT r.*
  INTO v_rsv
  FROM reservation r
  WHERE r.id = p_reservation_id
    AND r.org_id = v_caller_org
  FOR UPDATE OF r;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    (is_manager() AND v_rsv.building_id IN (SELECT mb.building_id FROM get_manager_building_ids() mb))
    OR (
      is_resident()
      AND v_rsv.phone IS NOT NULL
      AND btrim(v_rsv.phone) <> ''
      AND v_rsv.phone = (SELECT p.phone FROM person p WHERE p.id = get_current_user_person_id())
    )
  ) THEN
    RAISE EXCEPTION 'ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  IF v_rsv.status <> 'APPROVED_PENDING_PAYOUT' OR COALESCE(v_rsv.refunded_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'INVALID_STATUS_FOR_BANK_UPDATE' USING ERRCODE = 'P0001';
  END IF;

  v_before_bank := v_rsv.refund_bank_info;
  v_now_iso := to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_meta := COALESCE(v_rsv.cancel_settlement, '{}'::jsonb) || jsonb_build_object(
    'bank_info_updated_at', v_now_iso,
    'bank_info_updated_by', v_user_id::text
  );

  UPDATE reservation
  SET refund_bank_info = COALESCE(p_bank_info, '{}'::jsonb),
      refund_method = 'BANK_TRANSFER',
      cancel_settlement = v_meta,
      updated_at = NOW()
  WHERE id = p_reservation_id
  RETURNING * INTO v_rsv;

  INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
  VALUES (
    v_user_id,
    'UPDATE_BANK_INFO',
    'reservation',
    p_reservation_id,
    jsonb_build_object('refund_bank_info', v_before_bank),
    jsonb_build_object('refund_bank_info', p_bank_info)
  );

  RETURN v_rsv;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;

GRANT EXECUTE ON FUNCTION fn_sync_apartment_status_after_reservation(UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fn_notify_reservation_staff(UUID, TEXT, TEXT, TEXT, TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION fn_update_reservation_refund_bank_info(UUID, JSONB) TO PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'resihub_app') THEN
    GRANT EXECUTE ON FUNCTION fn_sync_apartment_status_after_reservation(UUID) TO resihub_app;
    GRANT EXECUTE ON FUNCTION fn_notify_reservation_staff(UUID, TEXT, TEXT, TEXT, TEXT) TO resihub_app;
    GRANT EXECUTE ON FUNCTION fn_update_reservation_refund_bank_info(UUID, JSONB) TO resihub_app;
  END IF;
END $$;

COMMIT;

