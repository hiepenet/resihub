-- 007_audit_attachments.sql
-- Nhóm 6: Audit Log (Chỉ-ghi-thêm / append-only) & Tệp đính kèm

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  before      JSONB,
  after       JSONB,
  ip          INET,
  user_agent  TEXT,
  at          TIMESTAMPTZ DEFAULT NOW()
);

-- Không cho phép UPDATE hoặc DELETE trên audit_log (Bất biến)
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log is append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_update_delete ON audit_log;
CREATE TRIGGER trg_audit_log_no_update_delete
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

CREATE TABLE IF NOT EXISTS attachment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_entity  TEXT NOT NULL,
  owner_id      UUID NOT NULL,
  storage_path  TEXT NOT NULL,
  mime          TEXT,
  size_bytes    BIGINT,
  uploaded_by   UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
