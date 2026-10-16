import { pool } from './src/db/client.js';

async function setup() {
  const orgRes = await pool.query('SELECT id FROM organization LIMIT 1');
  const orgId = orgRes.rows[0].id;

  const roleRes = await pool.query("SELECT id FROM role WHERE code = 'RESIDENT' AND org_id = $1", [orgId]);
  const roleId = roleRes.rows[0].id;

  const bRes = await pool.query("SELECT id FROM building WHERE code = 'RH-THAODIEN'");
  const bId = bRes.rows[0].id;

  const aptRes = await pool.query("SELECT id FROM apartment WHERE building_id = $1 AND code = 'A102'", [bId]);
  const aptId = aptRes.rows[0].id;

  const passwordHash = '$2a$10$wTqgI7Xk9BqL/x.7X4XG8O2Psm14cQyYp1R9X60r3e8D7D6g3jM9m'; // password123

  // 1. Uncontracted Resident: resident@resihub.vn (phone: 0900000005)
  let p1Res = await pool.query("SELECT id FROM person WHERE email = 'resident@resihub.vn'");
  let p1Id;
  if (p1Res.rows.length === 0) {
    const p1 = await pool.query(
      "INSERT INTO person (org_id, full_name, phone, email) VALUES ($1, 'Vũ Cư Dân (Chưa có HĐ)', '0900000005', 'resident@resihub.vn') RETURNING id",
      [orgId]
    );
    p1Id = p1.rows[0].id;
  } else {
    p1Id = p1Res.rows[0].id;
    await pool.query("UPDATE person SET full_name = 'Vũ Cư Dân (Chưa có HĐ)', phone = '0900000005' WHERE id = $1", [p1Id]);
  }
  let u1Res = await pool.query('SELECT id FROM app_user WHERE person_id = $1', [p1Id]);
  let u1Id;
  if (u1Res.rows.length === 0) {
    const u1 = await pool.query(
      "INSERT INTO app_user (person_id, auth_uid, password_hash, status) VALUES ($1, 'user_resident_uncontracted', $2, 'ACTIVE') RETURNING id",
      [p1Id, passwordHash]
    );
    u1Id = u1.rows[0].id;
  } else {
    u1Id = u1Res.rows[0].id;
    await pool.query('UPDATE app_user SET password_hash = $1 WHERE id = $2', [passwordHash, u1Id]);
  }
  await pool.query(
    'INSERT INTO user_role (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [u1Id, roleId]
  );

  // 2. Contracted Resident: resident_active@resihub.vn (phone: 0907778899)
  let p2Res = await pool.query("SELECT id FROM person WHERE email = 'resident_active@resihub.vn'");
  let p2Id;
  if (p2Res.rows.length === 0) {
    const p2 = await pool.query(
      "INSERT INTO person (org_id, full_name, phone, email, id_number) VALUES ($1, 'Nguyễn Cư Dân (Đã ký HĐ)', '0907778899', 'resident_active@resihub.vn', '001099887766') RETURNING id",
      [orgId]
    );
    p2Id = p2.rows[0].id;
  } else {
    p2Id = p2Res.rows[0].id;
    await pool.query("UPDATE person SET full_name = 'Nguyễn Cư Dân (Đã ký HĐ)', phone = '0907778899' WHERE id = $1", [p2Id]);
  }
  let u2Res = await pool.query('SELECT id FROM app_user WHERE person_id = $1', [p2Id]);
  let u2Id;
  if (u2Res.rows.length === 0) {
    const u2 = await pool.query(
      "INSERT INTO app_user (person_id, auth_uid, password_hash, status) VALUES ($1, 'user_resident_active', $2, 'ACTIVE') RETURNING id",
      [p2Id, passwordHash]
    );
    u2Id = u2.rows[0].id;
  } else {
    u2Id = u2Res.rows[0].id;
    await pool.query('UPDATE app_user SET password_hash = $1 WHERE id = $2', [passwordHash, u2Id]);
  }
  await pool.query(
    'INSERT INTO user_role (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [u2Id, roleId]
  );

  // Tenant for p2
  let t2Res = await pool.query('SELECT id FROM tenant WHERE person_id = $1', [p2Id]);
  let t2Id;
  if (t2Res.rows.length === 0) {
    const t2 = await pool.query(
      "INSERT INTO tenant (person_id, org_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id",
      [p2Id, orgId]
    );
    t2Id = t2.rows[0].id;
  } else {
    t2Id = t2Res.rows[0].id;
  }

  // Active contract for p2 on A102
  let cRes = await pool.query("SELECT id FROM contract WHERE apartment_id = $1 AND status = 'ACTIVE'", [aptId]);
  let cId;
  if (cRes.rows.length === 0) {
    const c = await pool.query(
      `INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, deposit_amount, status, billing_cycle, billing_day)
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 9000000, 18000000, 'ACTIVE', 'monthly', 5)
       RETURNING id`,
      [aptId, bId, t2Id]
    );
    cId = c.rows[0].id;
  } else {
    cId = cRes.rows[0].id;
    await pool.query('UPDATE contract SET primary_tenant_id = $1 WHERE id = $2', [t2Id, cId]);
  }

  // Deposit record
  await pool.query(
    `INSERT INTO deposit (contract_id, amount_held, status)
     VALUES ($1, 18000000, 'HELD')
     ON CONFLICT DO NOTHING`,
    [cId]
  );

  // Reservation test data for Vũ Cư Dân (phone: 0900000005) on A202
  const a202Res = await pool.query("SELECT id FROM apartment WHERE building_id = $1 AND code = 'A202'", [bId]);
  if (a202Res.rows.length > 0) {
    await pool.query("DELETE FROM reservation WHERE phone = '0900000005'");
    await pool.query(
      `INSERT INTO reservation (org_id, building_id, apartment_id, prospect_name, phone, hold_amount, hold_until, status, note)
       VALUES ($1, $2, $3, 'Vũ Cư Dân', '0900000005', 2000000, '2026-10-31', 'HELD', 'Khách cọc giữ chỗ 2.000.000 ₫, hẹn ký HĐ tuần tới.')`,
      [orgId, bId, a202Res.rows[0].id]
    );
  }

  console.log('✓ Successfully configured resident test accounts:');
  console.log('  1. Chưa có HĐ: resident@resihub.vn / password123 (SĐT: 0900000005) - Có cọc giữ chỗ căn A202');
  console.log('  2. Đã có HĐ: resident_active@resihub.vn / password123 (SĐT: 0907778899) - Đang thuê căn A102');
  process.exit(0);
}

setup().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
