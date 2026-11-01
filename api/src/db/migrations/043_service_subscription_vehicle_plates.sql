-- 043_service_subscription_vehicle_plates.sql
-- Tách mảng biển số xe (vehicle_plates) riêng khỏi cột ghi chú (note) cho dịch vụ gửi/đỗ xe
ALTER TABLE service_subscription
  ADD COLUMN IF NOT EXISTS vehicle_plates TEXT[] NOT NULL DEFAULT '{}';
