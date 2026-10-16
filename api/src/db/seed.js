import { pool } from './client.js';

async function seedData() {
  const client = await pool.connect();
  try {
    console.log('[Seed] Seeding initial data...');
    await client.query('BEGIN');

    // 1. Organization
    let { rows: orgRows } = await client.query('SELECT id FROM organization LIMIT 1');
    let orgId;
    if (orgRows.length === 0) {
      const res = await client.query(`
        INSERT INTO organization (name, tax_code, settings, payment_account)
        VALUES (
          'Tập đoàn Quản lý Bất động sản ResiHub',
          '0312345678',
          '{"currency": "VND", "timezone": "Asia/Ho_Chi_Minh"}',
          '{"bank": "Vietcombank", "account_no": "99988877766", "account_name": "RESIHUB CORP", "type": "corporate"}'
        )
        RETURNING id;
      `);
      orgId = res.rows[0].id;
      console.log(`[Seed] Created Organization: ${orgId}`);
    } else {
      orgId = orgRows[0].id;
      console.log(`[Seed] Using existing Organization: ${orgId}`);
    }

    // 2. Roles
    const roles = [
      { code: 'OWNER', name: 'Chủ đầu tư / Chủ nhà', scope: 'org' },
      { code: 'MANAGER', name: 'Quản lý tòa nhà', scope: 'building' },
      { code: 'ACCOUNTANT', name: 'Kế toán', scope: 'org' },
      { code: 'STAFF', name: 'Nhân viên kỹ thuật / lễ tân', scope: 'building' },
      { code: 'RESIDENT', name: 'Cư dân', scope: 'building' },
      { code: 'SYS_ADMIN', name: 'Quản trị viên hệ thống', scope: 'org' },
    ];

    for (const r of roles) {
      await client.query(`
        INSERT INTO role (org_id, code, name, scope)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name;
      `, [orgId, r.code, r.name, r.scope]);
    }
    console.log('[Seed] Roles created/updated.');

    // 3. Demo Person & App User (Admin / Manager)
    let { rows: personRows } = await client.query('SELECT id FROM person WHERE phone = $1', ['0901234567']);
    let personId;
    if (personRows.length === 0) {
      const pRes = await client.query(`
        INSERT INTO person (org_id, full_name, phone, email, id_number)
        VALUES ($1, 'Nguyễn Văn Quản Lý', '0901234567', 'manager@resihub.vn', '079090001122')
        RETURNING id;
      `, [orgId]);
      personId = pRes.rows[0].id;
    } else {
      personId = personRows[0].id;
    }

    const passwordHash = '$2a$10$wTqgI7Xk9BqL/x.7X4XG8O2Psm14cQyYp1R9X60r3e8D7D6g3jM9m'; // bcrypt of 'password123'

    let { rows: userRows } = await client.query('SELECT id FROM app_user WHERE person_id = $1', [personId]);
    let userId;
    if (userRows.length === 0) {
      const uRes = await client.query(`
        INSERT INTO app_user (person_id, auth_uid, password_hash, status)
        VALUES ($1, 'mock-auth-uid-0901234567', $2, 'ACTIVE')
        RETURNING id;
      `, [personId, passwordHash]);
      userId = uRes.rows[0].id;
    } else {
      userId = userRows[0].id;
      await client.query('UPDATE app_user SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    }

    // Assign exactly 1 fixed role: MANAGER
    const { rows: roleRows } = await client.query("SELECT id FROM role WHERE org_id = $1 AND code = 'MANAGER'", [orgId]);
    if (roleRows.length > 0) {
      await client.query('DELETE FROM user_role WHERE user_id = $1', [userId]);
      await client.query(`
        INSERT INTO user_role (user_id, role_id, building_id)
        VALUES ($1, $2, NULL)
        ON CONFLICT (user_id, role_id, building_id) DO NOTHING;
      `, [userId, roleRows[0].id]);
    }
    console.log('[Seed] Manager user seeded with fixed role MANAGER: phone 0901234567');

    // 4. Demo Building
    let { rows: bRows } = await client.query('SELECT id FROM building WHERE code = $1', ['RH-THAODIEN']);
    let buildingId;
    if (bRows.length === 0) {
      const bRes = await client.query(`
        INSERT INTO building (org_id, name, code, address, status)
        VALUES ($1, 'Tòa nhà ResiHub Thảo Điền', 'RH-THAODIEN', '12 Quốc Hương, P. Thảo Điền, TP. Thủ Đức, TP.HCM', 'ACTIVE')
        RETURNING id;
      `, [orgId]);
      buildingId = bRes.rows[0].id;
    } else {
      buildingId = bRows[0].id;
    }
    console.log(`[Seed] Demo Building: ${buildingId}`);

    // 5. Floors
    const floorLevels = [
      { level: 1, name: 'Tầng 1 (Trệt)' },
      { level: 2, name: 'Tầng 2' },
      { level: 3, name: 'Tầng 3' },
    ];
    const floorMap = {};
    for (const fl of floorLevels) {
      const flRes = await client.query(`
        INSERT INTO floor (building_id, level, name)
        VALUES ($1, $2, $3)
        ON CONFLICT (building_id, level) DO UPDATE SET name = EXCLUDED.name
        RETURNING id;
      `, [buildingId, fl.level, fl.name]);
      floorMap[fl.level] = flRes.rows[0].id;
    }
    console.log('[Seed] Floors created.');

    // 6. Apartments
    const apartments = [
      { code: 'A101', floor: 1, area: 45, bedrooms: 1, rent: 7500000, status: 'AVAILABLE', type: '1PN' },
      { code: 'A102', floor: 1, area: 55, bedrooms: 2, rent: 9000000, status: 'OCCUPIED', type: '2PN' },
      { code: 'A201', floor: 2, area: 45, bedrooms: 1, rent: 7500000, status: 'AVAILABLE', type: '1PN' },
      { code: 'A202', floor: 2, area: 60, bedrooms: 2, rent: 10000000, status: 'RESERVED', type: '2PN' },
      { code: 'A203', floor: 2, area: 45, bedrooms: 1, rent: 7500000, status: 'AVAILABLE', type: '1PN' },
      { code: 'A301', floor: 3, area: 50, bedrooms: 1, rent: 8500000, status: 'AVAILABLE', type: '1PN' },
      { code: 'A302', floor: 3, area: 50, bedrooms: 1, rent: 8500000, status: 'OCCUPIED', type: '1PN' },
      { code: 'A303', floor: 3, area: 65, bedrooms: 2, rent: 11000000, status: 'MAINTENANCE', type: '2PN' },
    ];

    for (const apt of apartments) {
      await client.query(`
        INSERT INTO apartment (building_id, floor_id, code, area_m2, type, bedrooms, base_rent, status, amenities)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{"wifi": true, "air_conditioner": true, "water_heater": true}')
        ON CONFLICT (building_id, code) DO UPDATE SET
          area_m2 = EXCLUDED.area_m2,
          base_rent = EXCLUDED.base_rent,
          status = EXCLUDED.status;
      `, [buildingId, floorMap[apt.floor], apt.code, apt.area, apt.type, apt.bedrooms, apt.rent, apt.status]);
    }
    console.log('[Seed] 8 sample apartments created.');

    await client.query('COMMIT');
    console.log('[Seed] Seeding completed successfully!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Seed] Error during seeding:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seedData().catch((err) => {
  console.error('[Seed] Fatal error:', err.message);
  process.exit(1);
});
