-- 044_m06_p0_deposit_and_reservation_guards.sql
-- Chuẩn hóa Giai đoạn 1 (P0) cho phân hệ Tiền cọc & Đặt giữ chỗ (M06):
--   1. Mở rộng CHECK constraint trên deposit.status thêm 'DEDUCTED_FULL' (BUG-04, FR-024).
--   2. Dọn các dòng reservation lịch sử có status = 'HELD' và hold_amount <= 0 sang 'EXPIRED'
--      (kèm đồng bộ trả apartment đang 'RESERVED' mồ côi về 'AVAILABLE') để cron runDailyJobs()
--      không đụng lỗi 23514 khi gắn CHECK constraint NOT VALID.
--   3. Bỏ DEFAULT 0 trên reservation.hold_amount và gắn chk_reservation_hold_amount_positive NOT VALID (BUG-06, FR-067).

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'deposit'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%SETTLEMENT_DRAFT%'
  LOOP
    EXECUTE format('ALTER TABLE deposit DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE deposit
  DROP CONSTRAINT IF EXISTS chk_deposit_status;

ALTER TABLE deposit
  ADD CONSTRAINT chk_deposit_status
  CHECK (status IN (
    'HELD',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'DEDUCTED_FULL',
    'SETTLEMENT_DRAFT',
    'PENDING_APPROVAL',
    'DISPUTED',
    'TRANSFERRED'
  ));

WITH legacy_zero AS (
  UPDATE reservation
  SET status = 'EXPIRED',
      updated_at = NOW()
  WHERE status = 'HELD'
    AND (hold_amount IS NULL OR hold_amount <= 0)
  RETURNING apartment_id
)
UPDATE apartment a
SET status = 'AVAILABLE',
    updated_at = NOW()
WHERE a.id IN (SELECT DISTINCT apartment_id FROM legacy_zero WHERE apartment_id IS NOT NULL)
  AND a.status = 'RESERVED'
  AND NOT EXISTS (
    SELECT 1 FROM reservation r2
    WHERE r2.apartment_id = a.id
      AND r2.status = 'HELD'
  )
  AND NOT EXISTS (
    SELECT 1 FROM contract c2
    WHERE c2.apartment_id = a.id
      AND c2.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
      AND COALESCE(c2.terminated_at, c2.end_date) > CURRENT_DATE
  );

ALTER TABLE reservation
  ALTER COLUMN hold_amount DROP DEFAULT;

ALTER TABLE reservation
  DROP CONSTRAINT IF EXISTS chk_reservation_hold_amount_positive;

ALTER TABLE reservation
  ADD CONSTRAINT chk_reservation_hold_amount_positive
  CHECK (hold_amount IS NOT NULL AND hold_amount > 0) NOT VALID;

COMMIT;
