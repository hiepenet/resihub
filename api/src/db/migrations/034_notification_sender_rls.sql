-- 034_notification_sender_rls.sql
-- Khắc phục lỗi 42501 khi MANAGER / ACCOUNTANT gửi thông báo tới cư dân qua INSERT ... RETURNING * (M13, FR-051):
--   1. Cho phép người gửi (MANAGER / ACCOUNTANT trong cùng org có payload->>'sent_by' = get_current_user_id()::text)
--      đọc lại bản ghi thông báo do chính mình phát hành.
--   2. Đảm bảo default-deny tuyệt đối khi chưa thiết lập app.current_user_id (NFR-008).

DROP POLICY IF EXISTS rls_notification_select ON notification;
CREATE POLICY rls_notification_select ON notification FOR SELECT
USING (
  is_org_admin()
  OR user_id = get_current_user_id()
  OR (
    user_id IS NULL
    AND get_current_user_id() IS NOT NULL
    AND org_id = get_current_user_org_id()
  )
  OR (
    (is_manager() OR is_accountant())
    AND org_id = get_current_user_org_id()
    AND (payload->>'sent_by') = get_current_user_id()::text
  )
);

