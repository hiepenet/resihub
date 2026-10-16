// api/remove_deprecated_roles.js
// Xóa triệt để các role: ACCOUNTANT, STAFF, SYS_ADMIN khỏi hệ thống và CSDL PostgreSQL
import { pool } from './src/db/client.js';

async function removeDeprecatedRoles() {
  const client = await pool.connect();
  try {
    console.log('=== BẮT ĐẦU XÓA CÁC ROLE ACCOUNTANT, STAFF, SYS_ADMIN KHỎI CSDL ===\n');
    await client.query('BEGIN');

    // 1. Tìm các role ID cần xóa
    const deprecatedRolesRes = await client.query(
      `SELECT id, code, name FROM role WHERE code IN ('ACCOUNTANT', 'STAFF', 'SYS_ADMIN')`
    );
    console.log(`Tìm thấy ${deprecatedRolesRes.rows.length} role cần xóa:`, deprecatedRolesRes.rows.map(r => r.code));
    const roleIds = deprecatedRolesRes.rows.map(r => r.id);

    if (roleIds.length > 0) {
      // 2. Xóa các phân quyền user_role liên quan
      const delUserRoles = await client.query(
        `DELETE FROM user_role WHERE role_id = ANY($1::uuid[]) RETURNING id`,
        [roleIds]
      );
      console.log(`✓ Đã xóa ${delUserRoles.rowCount} bản ghi trong user_role.`);

      // 3. Xóa các tài khoản app_user & person chỉ dùng cho các role cũ (admin@resihub.vn, accountant@resihub.vn, staff@resihub.vn)
      const targetPhones = ['0900000001', '0900000003', '0900000004'];
      const targetEmails = ['admin@resihub.vn', 'accountant@resihub.vn', 'staff@resihub.vn'];
      
      const personsRes = await client.query(
        `SELECT id, full_name, phone, email FROM person WHERE phone = ANY($1::text[]) OR email = ANY($2::text[])`,
        [targetPhones, targetEmails]
      );
      
      for (const p of personsRes.rows) {
        // Xóa app_user trước
        await client.query('DELETE FROM app_user WHERE person_id = $1', [p.id]);
        // Xóa person
        await client.query('DELETE FROM person WHERE id = $1', [p.id]);
        console.log(`✓ Đã xóa tài khoản nhân sự cũ: ${p.full_name} (${p.email})`);
      }

      // 4. Xóa các role khỏi bảng role
      const delRoles = await client.query(
        `DELETE FROM role WHERE id = ANY($1::uuid[]) RETURNING id, code`,
        [roleIds]
      );
      console.log(`✓ Đã xóa ${delRoles.rowCount} roles khỏi bảng role:`, delRoles.rows.map(r => r.code));
    }

    // 5. Đảm bảo chỉ còn lại 3 role chuẩn
    const remainingRolesRes = await client.query('SELECT id, code, name, scope FROM role ORDER BY code');
    console.log('\n--- DANH SÁCH ROLE CÒN LẠI TRONG CSDL ---');
    console.table(remainingRolesRes.rows);

    // 6. Cập nhật gán tòa nhà cụ thể cho Manager (manager@resihub.vn)
    // Lấy 2 tòa nhà đầu tiên để gán cho Manager
    const bldsRes = await client.query('SELECT id, name, code FROM building ORDER BY created_at ASC LIMIT 2');
    const mgrRes = await client.query(`
      SELECT au.id as user_id, r.id as role_id 
      FROM app_user au
      JOIN person p ON p.id = au.person_id
      JOIN role r ON r.code = 'MANAGER'
      WHERE p.email = 'manager@resihub.vn'
      LIMIT 1
    `);

    if (mgrRes.rows.length > 0 && bldsRes.rows.length > 0) {
      const { user_id, role_id } = mgrRes.rows[0];
      // Xóa các gán tòa cũ của manager
      await client.query('DELETE FROM user_role WHERE user_id = $1', [user_id]);
      
      // Gán tòa nhà thứ 1 cho Manager
      const primaryBld = bldsRes.rows[0];
      await client.query(
        `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
        [user_id, role_id, primaryBld.id]
      );
      console.log(`✓ Đã gán tòa nhà [${primaryBld.code} - ${primaryBld.name}] cho Quản lý (manager@resihub.vn)`);
    }

    // 7. Cập nhật hàm RLS PostgreSQL để loại bỏ hoàn toàn SYS_ADMIN
    await client.query(`
      CREATE OR REPLACE FUNCTION is_org_admin()
      RETURNS BOOLEAN AS $$
      DECLARE
        v_user_id UUID;
      BEGIN
        v_user_id := get_current_user_id();
        IF v_user_id IS NULL THEN
          RETURN TRUE;
        END IF;

        RETURN EXISTS (
          SELECT 1 
          FROM user_role ur
          JOIN role r ON r.id = ur.role_id
          WHERE ur.user_id = v_user_id 
            AND r.code = 'OWNER'
        );
      END;
      $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION get_user_assigned_buildings()
      RETURNS TABLE (building_id UUID) AS $$
      DECLARE
        v_user_id UUID;
      BEGIN
        v_user_id := get_current_user_id();
        IF v_user_id IS NULL THEN
          RETURN QUERY SELECT id FROM building;
          RETURN;
        END IF;

        -- Nếu là OWNER (toàn quyền xem toàn tổ chức)
        IF EXISTS (
          SELECT 1 FROM user_role ur
          JOIN role r ON r.id = ur.role_id
          WHERE ur.user_id = v_user_id AND r.code = 'OWNER'
        ) THEN
          RETURN QUERY 
          SELECT b.id 
          FROM building b
          JOIN app_user u ON u.id = v_user_id
          JOIN person p ON p.id = u.person_id
          WHERE b.org_id = p.org_id;
          RETURN;
        END IF;

        -- Nếu là MANAGER (trả về các tòa nhà được gán cụ thể)
        RETURN QUERY
        SELECT ur.building_id
        FROM user_role ur
        WHERE ur.user_id = v_user_id AND ur.building_id IS NOT NULL;
      END;
      $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
    `);
    console.log('✓ Đã cập nhật các hàm RLS PostgreSQL (is_org_admin, get_user_assigned_buildings) loại bỏ SYS_ADMIN.');

    await client.query('COMMIT');
    console.log('\n=== HOÀN TẤT DỌN DẸP ROLE THÀNH CÔNG 100% ===');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lỗi khi xóa deprecated roles:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

removeDeprecatedRoles();
