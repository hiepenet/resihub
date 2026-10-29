-- 027_system_settings.sql
-- Module M01: Cấu hình hệ thống & Bổ sung danh mục Role chuẩn PRD (FR-004, FR-005)

CREATE TABLE IF NOT EXISTS system_setting (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  updated_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, key)
);

GRANT ALL PRIVILEGES ON TABLE system_setting TO resihub_app;

ALTER TABLE system_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_setting FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_system_setting_select ON system_setting;
CREATE POLICY rls_system_setting_select ON system_setting FOR SELECT USING (
  org_id = get_current_user_org_id()
  OR is_org_admin()
);

DROP POLICY IF EXISTS rls_system_setting_modify ON system_setting;
CREATE POLICY rls_system_setting_modify ON system_setting FOR ALL
USING (is_org_admin())
WITH CHECK (is_org_admin());

-- Đảm bảo đủ 6 vai trò chuẩn PRD (SYS_ADMIN, OWNER, MANAGER, STAFF, ACCOUNTANT, RESIDENT)
INSERT INTO role (org_id, code, name, scope)
SELECT o.id, r.code, r.name, r.scope
FROM organization o
CROSS JOIN (VALUES
  ('STAFF',      'Nhân viên kỹ thuật / Vận hành', 'building'),
  ('ACCOUNTANT', 'Kế toán tòa nhà',               'building')
) AS r(code, name, scope)
ON CONFLICT (org_id, code) DO NOTHING;

-- Seed cấu hình hệ thống mặc định (FR-005 & P7 Danh bạ)
INSERT INTO system_setting (org_id, key, value, description)
SELECT
  o.id,
  s.key,
  s.val::jsonb,
  s.descr
FROM organization o
CROSS JOIN (VALUES
  ('billing_config', '{"billing_day": 1, "payment_due_days": 5, "reminder_days": [3, 7, 15], "late_fee_percent": 0, "electricity_default_price": 3800, "water_default_price": 22000}', 'Cấu hình chu kỳ chốt chỉ số, phát hành hóa đơn và nhắc nợ'),
  ('sla_config',     '{"response_hours": 2, "normal_resolve_hours": 24, "urgent_resolve_hours": 4, "deposit_refund_days": 5}', 'Cam kết thời gian xử lý sự cố (SLA) và tất toán cọc'),
  ('contact_config', '{"working_hours": "08:00 – 18:00 (Thứ 2 – Thứ 7)", "technical_hotline": "1900 6868", "security_hotline": "1900 9119", "emergency_phone": "0909 113 114", "support_email": "support@resihub.vn"}', 'Thông tin liên hệ Ban quản lý, kỹ thuật và khẩn cấp hiển thị trên Cổng cư dân')
) AS s(key, val, descr)
ON CONFLICT (org_id, key) DO NOTHING;

