-- 017_remove_zone_status.sql
-- Chuẩn hóa Khu/Block: Bỏ cột status (không còn khái niệm chặn/bật/tắt khu)
ALTER TABLE zone DROP COLUMN IF EXISTS status;
