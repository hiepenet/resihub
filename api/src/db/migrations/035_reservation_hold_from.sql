-- 035_reservation_hold_from.sql
-- Bổ sung ngày bắt đầu giữ chỗ (hold_from) để hiển thị rõ khoảng thời gian giữ chỗ và hỗ trợ nhiều phiếu giữ chỗ không chồng lấn

ALTER TABLE reservation
  ADD COLUMN IF NOT EXISTS hold_from DATE;

UPDATE reservation
SET hold_from = COALESCE(created_at::date, CURRENT_DATE)
WHERE hold_from IS NULL;

ALTER TABLE reservation
  ALTER COLUMN hold_from SET DEFAULT CURRENT_DATE,
  ALTER COLUMN hold_from SET NOT NULL;

