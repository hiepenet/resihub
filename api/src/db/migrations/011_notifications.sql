-- 011_notifications.sql
-- Hệ thống thông báo In-App (PRD mục 13.2 / Module M13 / FR-053)

CREATE TABLE IF NOT EXISTS notification (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID REFERENCES organization(id) ON DELETE CASCADE,
  user_id UUID REFERENCES app_user(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'SYSTEM_NOTICE',
  payload JSONB DEFAULT '{}',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_user_read ON notification(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notification_org ON notification(org_id, created_at DESC);

-- Hạt giống thông báo mẫu phù hợp nghiệp vụ Phase 1
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
)
LIMIT 1;

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
)
LIMIT 1;

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
)
LIMIT 1;
