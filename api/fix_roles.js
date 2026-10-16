import { pool } from './src/db/client.js';
import bcrypt from 'bcryptjs';

async function fixRoles() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get organization
    const orgRes = await client.query('SELECT id FROM organization LIMIT 1');
    if (orgRes.rows.length === 0) {
      throw new Error('No organization found');
    }
    const orgId = orgRes.rows[0].id;

    // 2. Ensure all 6 roles exist
    const standardRoles = [
      { code: 'SYS_ADMIN', name: 'Quản trị viên hệ thống', scope: 'org' },
      { code: 'MANAGER', name: 'Quản lý tòa nhà', scope: 'building' },
      { code: 'OWNER', name: 'Chủ đầu tư / Chủ nhà', scope: 'org' },
      { code: 'ACCOUNTANT', name: 'Kế toán', scope: 'org' },
      { code: 'STAFF', name: 'Nhân viên kỹ thuật / lễ tân', scope: 'building' },
      { code: 'RESIDENT', name: 'Cư dân', scope: 'building' },
    ];

    const roleMap = {};
    for (const r of standardRoles) {
      const rRes = await client.query(
        `INSERT INTO role (org_id, code, name, scope)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, code`,
        [orgId, r.code, r.name, r.scope]
      );
      roleMap[r.code] = rRes.rows[0].id;
    }

    const passwordHash = await bcrypt.hash('password123', 10);

    // 3. Define the dedicated personas with EXACTLY 1 fixed role each
    const personas = [
      {
        fullName: 'Nguyễn Quản Trị (SYS_ADMIN)',
        phone: '0900000001',
        email: 'admin@resihub.vn',
        roleCode: 'SYS_ADMIN',
      },
      {
        fullName: 'Nguyễn Văn Quản Lý (MANAGER)',
        phone: '0901234567',
        email: 'manager@resihub.vn',
        roleCode: 'MANAGER',
      },
      {
        fullName: 'Trần Chủ Đầu Tư (OWNER)',
        phone: '0900000002',
        email: 'owner@resihub.vn',
        roleCode: 'OWNER',
      },
      {
        fullName: 'Lê Kế Toán (ACCOUNTANT)',
        phone: '0900000003',
        email: 'accountant@resihub.vn',
        roleCode: 'ACCOUNTANT',
      },
      {
        fullName: 'Phạm Kỹ Thuật (STAFF)',
        phone: '0900000004',
        email: 'staff@resihub.vn',
        roleCode: 'STAFF',
      },
      {
        fullName: 'Vũ Cư Dân (RESIDENT)',
        phone: '0900000005',
        email: 'resident@resihub.vn',
        roleCode: 'RESIDENT',
      },
    ];

    console.log('--- ĐANG THIẾT LẬP VAI TRÒ CỐ ĐỊNH TỪ CSDL ---');

    for (const p of personas) {
      // 3.1 Find or create person
      let pRes = await client.query('SELECT id FROM person WHERE phone = $1', [p.phone]);
      let personId;
      if (pRes.rows.length === 0) {
        const newPerson = await client.query(
          `INSERT INTO person (org_id, full_name, phone, email)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [orgId, p.fullName, p.phone, p.email]
        );
        personId = newPerson.rows[0].id;
      } else {
        personId = pRes.rows[0].id;
        await client.query(
          `UPDATE person SET full_name = $1, email = $2 WHERE id = $3`,
          [p.fullName, p.email, personId]
        );
      }

      // 3.2 Find or create app_user
      let uRes = await client.query('SELECT id FROM app_user WHERE person_id = $1', [personId]);
      let userId;
      if (uRes.rows.length === 0) {
        const newUser = await client.query(
          `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
           VALUES ($1, $2, $3, 'ACTIVE')
           RETURNING id`,
          [personId, `auth_${p.phone}`, passwordHash]
        );
        userId = newUser.rows[0].id;
      } else {
        userId = uRes.rows[0].id;
        await client.query(
          `UPDATE app_user SET password_hash = $1, status = 'ACTIVE' WHERE id = $2`,
          [passwordHash, userId]
        );
      }

      // 3.3 Delete all previous roles for this user to guarantee NO multiple roles
      await client.query('DELETE FROM user_role WHERE user_id = $1', [userId]);

      // 3.4 Assign ONLY the ONE fixed role
      const roleId = roleMap[p.roleCode];
      await client.query(
        `INSERT INTO user_role (user_id, role_id, building_id)
         VALUES ($1, $2, NULL)`,
        [userId, roleId]
      );

      console.log(`✓ Đã fix cứng vai trò: [${p.roleCode}] cho tài khoản ${p.fullName} (${p.phone} / ${p.email})`);
    }

    // Also clean up any other user who has more than 1 role, keeping only their first role
    const allUsers = await client.query('SELECT id FROM app_user');
    for (const u of allUsers.rows) {
      const userRoles = await client.query(
        'SELECT id, role_id FROM user_role WHERE user_id = $1 ORDER BY created_at ASC',
        [u.id]
      );
      if (userRoles.rows.length > 1) {
        // Keep the first one, delete the rest
        const keepId = userRoles.rows[0].id;
        await client.query('DELETE FROM user_role WHERE user_id = $1 AND id != $2', [u.id, keepId]);
        console.log(`! Đã xóa các role thừa cho user ${u.id}, chỉ giữ lại 1 role duy nhất.`);
      }
    }

    await client.query('COMMIT');
    console.log('=== HOÀN TẤT THIẾT LẬP VAI TRÒ CỐ ĐỊNH 100% ===');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lỗi khi fix roles:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

fixRoles();
