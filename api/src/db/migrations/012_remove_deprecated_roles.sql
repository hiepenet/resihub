-- Migration 012: Xóa hoàn toàn các role deprecated (ACCOUNTANT, STAFF, SYS_ADMIN) và tài khoản tương ứng
DELETE FROM user_role WHERE role_id IN (SELECT id FROM role WHERE code IN ('ACCOUNTANT', 'STAFF', 'SYS_ADMIN'));
DELETE FROM app_user WHERE person_id IN (SELECT id FROM person WHERE email IN ('admin@resihub.vn', 'accountant@resihub.vn', 'staff@resihub.vn'));
DELETE FROM person WHERE email IN ('admin@resihub.vn', 'accountant@resihub.vn', 'staff@resihub.vn');
DELETE FROM role WHERE code IN ('ACCOUNTANT', 'STAFF', 'SYS_ADMIN');
