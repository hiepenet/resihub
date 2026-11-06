-- ============================================================================
-- Consolidated Migration: 008_seeds.sql
-- Description: Standard seed data, service catalog, and system settings
-- ============================================================================

-- 1. Standard 4-Role Model Enforcement (FR-036: SYS_ADMIN, OWNER, MANAGER, RESIDENT)
DELETE FROM user_role
WHERE role_id IN (SELECT id FROM role WHERE code IN ('ACCOUNTANT', 'STAFF'));

DELETE FROM role
WHERE code IN ('ACCOUNTANT', 'STAFF');

-- 2. Standard Service Catalog
INSERT INTO service_catalog (org_id, code, name, category, billing_type, unit, unit_price, description)
SELECT o.id, v.code, v.name, v.category, v.billing_type, v.unit, v.unit_price, v.description
FROM organization o
CROSS JOIN (VALUES
  ('ELECTRICITY',       'Điện sinh hoạt',         'ELECTRICITY', 'METERED',  'kWh',      3800,    'Tính theo chỉ số công tơ điện hàng tháng'),
  ('WATER',             'Nước sạch sinh hoạt',    'WATER',       'METERED',  'm³',       22000,   'Tính theo đồng hồ nước từng căn hộ'),
  ('INTERNET_FIBER',    'Internet Cáp quang 300M','INTERNET',    'FIXED',    'tháng',    220000,  'Đường truyền tốc độ cao ổn định riêng cho căn hộ'),
  ('MOTORBIKE_PARKING', 'Gửi xe máy hầm B1',      'PARKING',     'QUANTITY', 'xe/tháng', 120000,  'Thẻ từ gửi xe máy định danh tại tầng hầm'),
  ('CAR_PARKING',       'Đỗ xe ô tô hầm B2',      'PARKING',     'QUANTITY', 'xe/tháng', 1250000, 'Vị trí đỗ ô tô có mái che tại hầm B2'),
  ('CLEANING_WEEKLY',   'Dọn vệ sinh căn hộ',     'CLEANING',    'QUANTITY', 'lần/tháng',150000,  'Dịch vụ dọn phòng định kỳ theo yêu cầu cư dân'),
  ('MANAGEMENT_FEE',    'Phí quản lý vận hành',   'MANAGEMENT',  'FIXED',    'tháng',    350000,  'An ninh 24/7, lễ tân, chiếu sáng và vệ sinh khu chung')
) AS v(code, name, category, billing_type, unit, unit_price, description)
WHERE NOT EXISTS (
  SELECT 1 FROM service_catalog sc
  WHERE sc.org_id = o.id AND sc.building_id IS NULL AND sc.code = v.code
);

-- 3. System Settings Configuration
INSERT INTO system_setting (org_id, key, value, description)
SELECT
  o.id,
  s.key,
  s.val::jsonb,
  s.descr
FROM organization o
CROSS JOIN (VALUES
  ('billing_config', '{"billing_day": 1, "payment_due_days": 5, "due_date_offset_days": 5, "late_fee_grace_days": 5, "late_fee_per_day": 100000, "late_fee_cap": null, "meter_anomaly_threshold_pct": 30, "reminder_days": [3, 7, 15], "late_fee_percent": 0, "electricity_default_price": 3800, "water_default_price": 22000}', 'Cấu hình chu kỳ chốt chỉ số, phát hành hóa đơn và nhắc nợ (FR-005, FR-030..FR-036)'),
  ('sla_config', '{"response_hours": 2, "normal_resolve_hours": 24, "urgent_resolve_hours": 4, "deposit_refund_days": 5, "reopen_window_days": 3}', 'Cam kết thời gian xử lý sự cố (SLA) và tất toán cọc'),
  ('contact_config', '{"working_hours": "08:00 – 18:00 (Thứ 2 – Thứ 7)", "technical_hotline": "1900 6868", "security_hotline": "1900 9119", "emergency_phone": "0909 113 114", "support_email": "support@resihub.vn"}', 'Thông tin liên hệ Ban quản lý, kỹ thuật và khẩn cấp hiển thị trên Cổng cư dân'),
  ('approval_config', '{"allow_self_approval": false}', 'Cấu hình quy tắc phê duyệt 4 mắt (Four-eyes)'),
  ('reservation_cancel_policy', '{"max_hold_days":30,"public_max_hold_days":7,"full_refund_before_days":3,"partial_refund_pct":50,"default_hold_amount":2000000}', 'Chính sách đặt cọc và hủy giữ chỗ (FR-005 / FR-067, làm tròn hàng nghìn VND theo PRD 10.3)'),
  ('ai_config', '{"enabled": true, "cccd_extract_enabled": true, "contract_extract_enabled": true, "meter_ocr_enabled": true, "ticket_triage_enabled": true, "model": "gemini-2.5-flash", "confidence_threshold": 0.75, "meter_ocr_threshold": 0.8, "triage_threshold": 0.7, "monthly_budget_vnd": 500000, "monthly_token_limit": 2000000, "warn_percent": 80, "suggestion_ttl_hours": 72}', 'Cấu hình AI Gateway (Kill switch, ngưỡng độ tin cậy, trần ngân sách tháng — M15)')
) AS s(key, val, descr)
ON CONFLICT (org_id, key) DO UPDATE
SET value = EXCLUDED.value || COALESCE(system_setting.value, '{}'::jsonb);

-- Merge reopen_window_days into sla_config if missing
UPDATE system_setting
SET value = jsonb_build_object('reopen_window_days', 3) || value
WHERE key = 'sla_config' AND NOT (value ? 'reopen_window_days');

-- 4. Initial System Notifications
INSERT INTO notification (org_id, title, content, type, payload, created_at)
SELECT 
  o.id,
  'Nhắc gia hạn: Hợp đồng thuê sắp hết hạn',
  'Có hợp đồng thuê căn hộ sắp hết hạn trong 30 ngày tới. Vui lòng liên hệ cư dân để thỏa thuận gia hạn (FR-018).',
  'CONTRACT_EXPIRING',
  '{"link": "/admin/contracts"}'::jsonb,
  NOW() - INTERVAL '15 minutes'
FROM organization o
WHERE NOT EXISTS (
  SELECT 1 FROM notification n WHERE n.org_id = o.id AND n.type = 'CONTRACT_EXPIRING'
);

INSERT INTO notification (org_id, title, content, type, payload, created_at)
SELECT 
  o.id,
  'Đặt cọc giữ chỗ mới',
  'Căn hộ vừa nhận tiền đặt cọc giữ chỗ từ khách tiềm năng. Trạng thái căn hộ đã chuyển sang RESERVED (NV-06).',
  'RESERVATION_NEW',
  '{"link": "/admin/buildings"}'::jsonb,
  NOW() - INTERVAL '2 hours'
FROM organization o
WHERE NOT EXISTS (
  SELECT 1 FROM notification n WHERE n.org_id = o.id AND n.type = 'RESERVATION_NEW'
);

INSERT INTO notification (org_id, title, content, type, payload, created_at)
SELECT 
  o.id,
  'An toàn Sổ cọc: Đã kích hoạt bảo vệ',
  'Quy tắc cấm cấn trừ tiền thuê vào cọc bảo đảm đã được thực thi nghiêm ngặt trên toàn hệ thống (NV-11).',
  'DEPOSIT_SECURE',
  '{"link": "/admin/deposits"}'::jsonb,
  NOW() - INTERVAL '1 day'
FROM organization o
WHERE NOT EXISTS (
  SELECT 1 FROM notification n WHERE n.org_id = o.id AND n.type = 'DEPOSIT_SECURE'
);

-- 5. Auto-provision Electricity & Water Meters for Active Contracts
INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading, status)
SELECT
  b.org_id,
  a.building_id,
  a.id,
  'ELECTRICITY',
  CASE
    WHEN EXISTS (
      SELECT 1 FROM meter m_col
      WHERE m_col.building_id = a.building_id
        AND m_col.meter_code = ('EL-' || b.code || '-' || a.code)
        AND m_col.apartment_id <> a.id
    )
    THEN 'EL-' || b.code || '-' || a.code || '-' || UPPER(SUBSTRING(REPLACE(a.id::text, '-', ''), 1, 6))
    ELSE 'EL-' || b.code || '-' || a.code
  END,
  'kWh',
  COALESCE(
    NULLIF((ss.value->>'electricity_default_price')::numeric, NULL)::bigint,
    3800
  ),
  0,
  'ACTIVE'
FROM apartment a
JOIN building b ON b.id = a.building_id
LEFT JOIN system_setting ss ON ss.org_id = b.org_id AND ss.key = 'billing_config'
WHERE EXISTS (
  SELECT 1 FROM contract c
  WHERE c.apartment_id = a.id
    AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
)
AND NOT EXISTS (
  SELECT 1 FROM meter m
  WHERE m.apartment_id = a.id AND m.meter_type = 'ELECTRICITY'
)
ON CONFLICT (apartment_id, meter_type) DO NOTHING;

INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading, status)
SELECT
  b.org_id,
  a.building_id,
  a.id,
  'WATER',
  CASE
    WHEN EXISTS (
      SELECT 1 FROM meter m_col
      WHERE m_col.building_id = a.building_id
        AND m_col.meter_code = ('WT-' || b.code || '-' || a.code)
        AND m_col.apartment_id <> a.id
    )
    THEN 'WT-' || b.code || '-' || a.code || '-' || UPPER(SUBSTRING(REPLACE(a.id::text, '-', ''), 1, 6))
    ELSE 'WT-' || b.code || '-' || a.code
  END,
  'm³',
  COALESCE(
    NULLIF((ss.value->>'water_default_price')::numeric, NULL)::bigint,
    22000
  ),
  0,
  'ACTIVE'
FROM apartment a
JOIN building b ON b.id = a.building_id
LEFT JOIN system_setting ss ON ss.org_id = b.org_id AND ss.key = 'billing_config'
WHERE EXISTS (
  SELECT 1 FROM contract c
  WHERE c.apartment_id = a.id
    AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
)
AND NOT EXISTS (
  SELECT 1 FROM meter m
  WHERE m.apartment_id = a.id AND m.meter_type = 'WATER'
)
ON CONFLICT (apartment_id, meter_type) DO NOTHING;
