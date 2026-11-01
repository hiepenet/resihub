-- 042_idempotency_and_draft_services_rls.sql
-- 1. Cho phép MANAGER tòa nhà được phân công xóa các gói service_subscription chưa kích hoạt (PENDING_APPROVAL / CANCELLED) khi chỉnh sửa hợp đồng DRAFT
DROP POLICY IF EXISTS rls_service_sub_delete ON service_subscription;
CREATE POLICY rls_service_sub_delete ON service_subscription FOR DELETE USING (
  is_org_admin()
  OR (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
    AND status IN ('PENDING_APPROVAL', 'CANCELLED')
  )
);

-- 2. Bảng lưu khóa chống gửi đúp Idempotency-Key (PRD Mục 14.3)
CREATE TABLE IF NOT EXISTS idempotency_key (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actor_id      UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  idem_key      TEXT NOT NULL,
  method        TEXT NOT NULL,
  route_path    TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  status_code   INTEGER,
  response_body JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  UNIQUE (org_id, actor_id, method, route_path, idem_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_key_expires ON idempotency_key(expires_at);
GRANT ALL PRIVILEGES ON TABLE idempotency_key TO resihub_app;
