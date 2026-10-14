-- 009_rls.sql
-- Nhóm 8: Bật Row Level Security (RLS)

-- Bật RLS cho các bảng nghiệp vụ nhạy cảm
ALTER TABLE building ENABLE ROW LEVEL SECURITY;
ALTER TABLE apartment ENABLE ROW LEVEL SECURITY;
ALTER TABLE person ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_transaction ENABLE ROW LEVEL SECURITY;

-- Hàm trợ giúp lấy ID người dùng hiện tại (hỗ trợ cả Supabase auth.uid() lẫn session setting 'app.current_user_id')
CREATE OR REPLACE FUNCTION get_current_user_id()
RETURNS TEXT AS $$
DECLARE
  v_uid TEXT;
BEGIN
  BEGIN
    v_uid := current_setting('request.jwt.claim.sub', true);
    IF v_uid IS NOT NULL AND v_uid <> '' THEN
      RETURN v_uid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    v_uid := current_setting('app.current_user_id', true);
    IF v_uid IS NOT NULL AND v_uid <> '' THEN
      RETURN v_uid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Policy mẫu ban đầu (cho phép bypass khi chưa gán policy ngặt nghèo trong Week 1, hoặc theo admin)
CREATE POLICY allow_all_internal_service ON building FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY allow_all_internal_service ON apartment FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY allow_all_internal_service ON person FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY allow_all_internal_service ON tenant FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY allow_all_internal_service ON contract FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY allow_all_internal_service ON deposit FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY allow_all_internal_service ON deposit_transaction FOR ALL USING (true) WITH CHECK (true);
