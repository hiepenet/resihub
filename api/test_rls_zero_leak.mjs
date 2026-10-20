// test_rls_zero_leak.mjs
// Verification of Row Level Security (RLS) and Zero Data Leak (Tuần 2 & PRD v2.0)

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5433,
  database: 'resihub',
  user: 'postgres',
  password: 'postgres',
});

async function runRlsTests() {
  console.log('===============================================================');
  console.log('🔒 BẮT ĐẦU KIỂM THỬ ROW LEVEL SECURITY (RLS) & ZERO DATA LEAK');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      failed++;
    }
  }

  const client = await pool.connect();
  let cleanupData = null;

  try {
    // 0. Setup môi trường kiểm thử RLS
    console.log('--- [BƯỚC 1] THIẾT LẬP DỮ LIỆU CÁCH LY KIỂM THỬ RLS ---');
    const orgRes = await client.query('SELECT id FROM organization LIMIT 1');
    const orgId = orgRes.rows[0].id;

    const suffix = Date.now().toString().slice(-6);
    const codeA = `RLS-A-${suffix}`;
    const codeB = `RLS-B-${suffix}`;
    const phoneA = `0981${suffix}`;
    const phoneB = `0982${suffix}`;
    const phoneMgr = `0983${suffix}`;
    const phoneSys = `0984${suffix}`;
    const phoneMgrUnassigned = `0985${suffix}`;

    // Tòa nhà A và Tòa nhà B
    const bldARes = await client.query(
      `INSERT INTO building (org_id, name, code, address, status)
       VALUES ($1, 'RLS Tòa Nhà Alpha', $2, 'Khu A', 'ACTIVE')
       RETURNING id`,
      [orgId, codeA]
    );
    const bldAId = bldARes.rows[0].id;

    const bldBRes = await client.query(
      `INSERT INTO building (org_id, name, code, address, status)
       VALUES ($1, 'RLS Tòa Nhà Beta', $2, 'Khu B', 'ACTIVE')
       RETURNING id`,
      [orgId, codeB]
    );
    const bldBId = bldBRes.rows[0].id;

    // Tầng & Căn hộ A101 (Tòa Alpha) và B201 (Tòa Beta)
    const flARes = await client.query(
      `INSERT INTO floor (building_id, level, name) VALUES ($1, 1, 'Tầng 1') RETURNING id`,
      [bldAId]
    );
    const aptARes = await client.query(
      `INSERT INTO apartment (building_id, floor_id, code, area_m2, base_rent, status)
       VALUES ($1, $2, 'ALPHA-101', 50, 8000000, 'OCCUPIED') RETURNING id`,
      [bldAId, flARes.rows[0].id]
    );
    const aptAId = aptARes.rows[0].id;

    const flBRes = await client.query(
      `INSERT INTO floor (building_id, level, name) VALUES ($1, 2, 'Tầng 2') RETURNING id`,
      [bldBId]
    );
    const aptBRes = await client.query(
      `INSERT INTO apartment (building_id, floor_id, code, area_m2, base_rent, status)
       VALUES ($1, $2, 'BETA-201', 60, 12000000, 'OCCUPIED') RETURNING id`,
      [bldBId, flBRes.rows[0].id]
    );
    const aptBId = aptBRes.rows[0].id;

    // Người & Cư dân A (Căn ALPHA-101)
    const personARes = await client.query(
      `INSERT INTO person (org_id, full_name, phone, email)
       VALUES ($1, 'Cư Dân Alpha (A101)', $2, 'cudan_a_${suffix}@gmail.com')
       RETURNING id`,
      [orgId, phoneA]
    );
    const personAId = personARes.rows[0].id;

    const tenantARes = await client.query(
      `INSERT INTO tenant (person_id, org_id, type, status)
       VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
      [personAId, orgId]
    );
    const tenantAId = tenantARes.rows[0].id;

    const userARes = await client.query(
      `INSERT INTO app_user (person_id, auth_uid, status)
       VALUES ($1, 'auth-resident-alpha-${suffix}', 'ACTIVE') RETURNING id`,
      [personAId]
    );
    const userAId = userARes.rows[0].id;

    // Người & Cư dân B (Căn BETA-201)
    const personBRes = await client.query(
      `INSERT INTO person (org_id, full_name, phone, email)
       VALUES ($1, 'Cư Dân Beta (B201)', $2, 'cudan_b_${suffix}@gmail.com')
       RETURNING id`,
      [orgId, phoneB]
    );
    const personBId = personBRes.rows[0].id;

    const tenantBRes = await client.query(
      `INSERT INTO tenant (person_id, org_id, type, status)
       VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
      [personBId, orgId]
    );
    const tenantBId = tenantBRes.rows[0].id;

    const userBRes = await client.query(
      `INSERT INTO app_user (person_id, auth_uid, status)
       VALUES ($1, 'auth-resident-beta-${suffix}', 'ACTIVE') RETURNING id`,
      [personBId]
    );
    const userBId = userBRes.rows[0].id;

    // Hợp đồng A (căn A101) và Hợp đồng B (căn B201)
    const cARes = await client.query(
      `INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, status)
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 8000000, 1, 'ACTIVE') RETURNING id`,
      [aptAId, bldAId, tenantAId]
    );
    const contractAId = cARes.rows[0].id;

    const cBRes = await client.query(
      `INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, status)
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 12000000, 1, 'ACTIVE') RETURNING id`,
      [aptBId, bldBId, tenantBId]
    );
    const contractBId = cBRes.rows[0].id;

    // Quản lý Manager Alpha: Chỉ được gán quyền trên Tòa Alpha
    const personMgrRes = await client.query(
      `INSERT INTO person (org_id, full_name, phone, email)
       VALUES ($1, 'Quản Lý Tòa Alpha', $2, 'manager_alpha_${suffix}@resihub.vn') RETURNING id`,
      [orgId, phoneMgr]
    );
    const userMgrRes = await client.query(
      `INSERT INTO app_user (person_id, auth_uid, status)
       VALUES ($1, 'auth-manager-alpha-${suffix}', 'ACTIVE') RETURNING id`,
      [personMgrRes.rows[0].id]
    );
    const userMgrId = userMgrRes.rows[0].id;

    const roleMgrRes = await client.query("SELECT id FROM role WHERE code = 'MANAGER' LIMIT 1");
    await client.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
      [userMgrId, roleMgrRes.rows[0].id, bldAId]
    );

    // Người dùng SYS_ADMIN độc lập (không có vai trò OWNER)
    const personSysRes = await client.query(
      `INSERT INTO person (org_id, full_name, phone, email)
       VALUES ($1, 'Quản Trị Viên SYS_ADMIN', $2, 'sysadmin_${suffix}@resihub.vn') RETURNING id`,
      [orgId, phoneSys]
    );
    const userSysRes = await client.query(
      `INSERT INTO app_user (person_id, auth_uid, status)
       VALUES ($1, 'auth-sysadmin-${suffix}', 'ACTIVE') RETURNING id`,
      [personSysRes.rows[0].id]
    );
    const userSysId = userSysRes.rows[0].id;
    const roleSysRes = await client.query("SELECT id FROM role WHERE code = 'SYS_ADMIN' LIMIT 1");
    await client.query(
      `INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`,
      [userSysId, roleSysRes.rows[0].id]
    );

    // Người dùng MANAGER chưa được gán tòa nào (Default Deny check)
    const personMgrUnassignedRes = await client.query(
      `INSERT INTO person (org_id, full_name, phone, email)
       VALUES ($1, 'Quản Lý Chưa Gán Tòa', $2, 'mgr_unassigned_${suffix}@resihub.vn') RETURNING id`,
      [orgId, phoneMgrUnassigned]
    );
    const userMgrUnassignedRes = await client.query(
      `INSERT INTO app_user (person_id, auth_uid, status)
       VALUES ($1, 'auth-mgr-unassigned-${suffix}', 'ACTIVE') RETURNING id`,
      [personMgrUnassignedRes.rows[0].id]
    );
    const userMgrUnassignedId = userMgrUnassignedRes.rows[0].id;
    await client.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, NULL)`,
      [userMgrUnassignedId, roleMgrRes.rows[0].id]
    );

    cleanupData = {
      contractIds: [contractAId, contractBId],
      apartmentIds: [aptAId, aptBId],
      buildingIds: [bldAId, bldBId],
      userIds: [userAId, userBId, userMgrId, userSysId, userMgrUnassignedId],
      tenantIds: [tenantAId, tenantBId],
      personIds: [personAId, personBId, personMgrRes.rows[0].id, personSysRes.rows[0].id, personMgrUnassignedRes.rows[0].id],
    };

    console.log('  Setup hoàn tất: Cư dân A (A101), Cư dân B (B201), Quản lý Alpha, SYS_ADMIN, Quản lý chưa gán tòa.\n');

    // =========================================================================
    // TEST 1: CƯ DÂN TRUY VẤN HỢP ĐỒNG (TEST NFR-008 BẮT BUỘC)
    // =========================================================================
    console.log('--- [TEST 1] CƯ DÂN A TRUY VẤN HỢP ĐỒNG (YÊU CẦU NFR-008) ---');
    await client.query('BEGIN');
    await client.query('SET ROLE resihub_app');
    await client.query(`SET LOCAL app.current_user_id = '${userAId}'`);

    // 1.1 Cư dân A query danh sách hợp đồng -> Chỉ thấy HĐ của mình
    const resAContracts = await client.query('SELECT id, rent_amount FROM contract');
    assert(
      resAContracts.rows.length === 1 && resAContracts.rows[0].id === contractAId,
      `Cư dân A chỉ nhìn thấy đúng 1 hợp đồng của chính mình (${resAContracts.rows[0]?.id})`
    );

    // 1.2 Cư dân A query đích danh Hợp đồng B -> Trả về 0 dòng
    const resAQueryContractB = await client.query('SELECT * FROM contract WHERE id = $1', [contractBId]);
    assert(
      resAQueryContractB.rows.length === 0,
      'Cư dân A query HĐ của Cư dân B → Trả về EMPTY (0 dòng) đúng chuẩn Zero Data Leak'
    );
    await client.query('ROLLBACK');

    // =========================================================================
    // TEST 2: CƯ DÂN TRUY VẤN CĂN HỘ & TÒA NHÀ
    // =========================================================================
    console.log('\n--- [TEST 2] CƯ DÂN A TRUY VẤN CĂN HỘ & TÒA NHÀ ---');
    await client.query('BEGIN');
    await client.query('SET ROLE resihub_app');
    await client.query(`SET LOCAL app.current_user_id = '${userAId}'`);

    // 2.1 Cư dân A chỉ thấy căn hộ A101 mà mình đang thuê
    const resAApartments = await client.query('SELECT id, code FROM apartment');
    assert(
      resAApartments.rows.length === 1 && resAApartments.rows[0].id === aptAId,
      `Cư dân A chỉ thấy duy nhất căn hộ mình đang thuê (${resAApartments.rows[0]?.code})`
    );

    // 2.2 Cư dân A cố query căn B201 -> Trả về 0 dòng
    const resAQueryAptB = await client.query('SELECT * FROM apartment WHERE id = $1', [aptBId]);
    assert(
      resAQueryAptB.rows.length === 0,
      'Cư dân A query căn B201 của Tòa Beta → Trả về EMPTY (0 dòng)'
    );

    // 2.3 Cư dân A chỉ thấy tòa nhà Alpha mà mình đang sinh sống
    const resABuildings = await client.query('SELECT id, code FROM building');
    assert(
      resABuildings.rows.length === 1 && resABuildings.rows[0].id === bldAId,
      `Cư dân A chỉ thấy tòa nhà mình đang thuê (${resABuildings.rows[0]?.code})`
    );
    await client.query('ROLLBACK');

    // =========================================================================
    // TEST 3: PHÂN QUYỀN QUẢN LÝ TÒA NHÀ (MANAGER BUILDING SCOPE)
    // =========================================================================
    console.log('\n--- [TEST 3] PHÂN QUYỀN QUẢN LÝ TÒA NHÀ (MANAGER BUILDING SCOPE) ---');
    await client.query('BEGIN');
    await client.query('SET ROLE resihub_app');
    await client.query(`SET LOCAL app.current_user_id = '${userMgrId}'`);

    // 3.1 Quản lý Tòa Alpha chỉ thấy Tòa Alpha, KHÔNG thấy Tòa Beta
    const mgrBuildings = await client.query('SELECT id, code FROM building');
    const hasAlpha = mgrBuildings.rows.some((b) => b.id === bldAId);
    const hasBeta = mgrBuildings.rows.some((b) => b.id === bldBId);
    assert(
      hasAlpha && !hasBeta,
      'Quản lý Tòa Alpha nhìn thấy Tòa Alpha và TUYỆT ĐỐI KHÔNG thấy Tòa Beta'
    );

    // 3.2 Quản lý Tòa Alpha chỉ thấy căn hộ thuộc Tòa Alpha
    const mgrApartments = await client.query('SELECT id, code, building_id FROM apartment');
    const allInAlpha = mgrApartments.rows.every((a) => a.building_id === bldAId);
    assert(
      allInAlpha && mgrApartments.rows.some((a) => a.id === aptAId),
      'Quản lý Tòa Alpha chỉ thấy danh sách căn hộ thuộc Tòa Alpha'
    );

    // 3.3 Quản lý Tòa Alpha query trực tiếp căn hộ của Tòa Beta -> 0 dòng
    const mgrQueryAptB = await client.query('SELECT * FROM apartment WHERE id = $1', [aptBId]);
    assert(
      mgrQueryAptB.rows.length === 0,
      'Quản lý Tòa Alpha query căn của Tòa Beta → Trả về EMPTY (0 dòng)'
    );
    await client.query('ROLLBACK');

    // =========================================================================
    // TEST 4: QUYỀN CHỦ ĐẦU TƯ (FULL ORG VISIBILITY)
    // =========================================================================
    console.log('\n--- [TEST 4] QUYỀN CHỦ ĐẦU TƯ / OWNER (FULL ORG VISIBILITY) ---');
    const ownerUserRes = await client.query(
      `SELECT u.id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.id = ur.role_id
       WHERE r.code = 'OWNER' LIMIT 1`
    );
    const ownerUserId = ownerUserRes.rows[0].id;

    await client.query('BEGIN');
    await client.query('SET ROLE resihub_app');
    await client.query(`SET LOCAL app.current_user_id = '${ownerUserId}'`);

    const ownerBuildings = await client.query('SELECT id, code FROM building');
    const ownerSeesAlpha = ownerBuildings.rows.some((b) => b.id === bldAId);
    const ownerSeesBeta = ownerBuildings.rows.some((b) => b.id === bldBId);
    assert(
      ownerSeesAlpha && ownerSeesBeta,
      'Chủ đầu tư (OWNER) nhìn thấy toàn bộ tòa nhà trong tổ chức'
    );
    await client.query('ROLLBACK');

    // =========================================================================
    // TEST 5: VAI TRÒ SYS_ADMIN RIÊNG BIỆT & DEFAULT-DENY CHO MANAGER CHƯA GÁN TÒA
    // =========================================================================
    console.log('\n--- [TEST 5] SYS_ADMIN ĐỘC LẬP & DEFAULT-DENY CHO MANAGER CHƯA GÁN TÒA ---');

    // 5.1 User có DUY NHẤT vai trò SYS_ADMIN nhìn thấy toàn bộ tòa nhà trong tổ chức
    await client.query('BEGIN');
    await client.query('SET ROLE resihub_app');
    await client.query(`SET LOCAL app.current_user_id = '${userSysId}'`);

    const sysBuildings = await client.query('SELECT id, code FROM building');
    const sysSeesAlpha = sysBuildings.rows.some((b) => b.id === bldAId);
    const sysSeesBeta = sysBuildings.rows.some((b) => b.id === bldBId);
    assert(
      sysSeesAlpha && sysSeesBeta,
      'SYS_ADMIN độc lập (không có vai trò OWNER) nhìn thấy toàn bộ tòa nhà trong tổ chức'
    );
    await client.query('ROLLBACK');

    // 5.2 Quản lý chưa được gán tòa nào (building_id IS NULL) -> Không thấy tòa nào (Default-Deny)
    await client.query('BEGIN');
    await client.query('SET ROLE resihub_app');
    await client.query(`SET LOCAL app.current_user_id = '${userMgrUnassignedId}'`);

    const unassignedBuildings = await client.query('SELECT id, code FROM building');
    assert(
      unassignedBuildings.rows.length === 0,
      'MANAGER chưa được gán tòa nào → Không thấy tòa nhà nào (Default-Deny chuẩn xác)'
    );
    await client.query('ROLLBACK');

  } catch (err) {
    console.error('Lỗi ngoại lệ trong quá trình test RLS:', err);
    failed++;
  } finally {
    // Dọn dẹp dữ liệu kiểm thử an toàn ngoài transaction bằng superuser
    if (cleanupData) {
      try {
        await client.query('RESET ROLE');
        await client.query('DELETE FROM contract WHERE id = ANY($1)', [cleanupData.contractIds]);
        await client.query('DELETE FROM apartment WHERE id = ANY($1)', [cleanupData.apartmentIds]);
        await client.query('DELETE FROM floor WHERE building_id = ANY($1)', [cleanupData.buildingIds]);
        await client.query('DELETE FROM building WHERE id = ANY($1)', [cleanupData.buildingIds]);
        await client.query('DELETE FROM user_role WHERE user_id = ANY($1)', [cleanupData.userIds]);
        await client.query('DELETE FROM app_user WHERE id = ANY($1)', [cleanupData.userIds]);
        await client.query('DELETE FROM tenant WHERE id = ANY($1)', [cleanupData.tenantIds]);
        await client.query('DELETE FROM person WHERE id = ANY($1)', [cleanupData.personIds]);
      } catch (cleanErr) {
        console.error('Lỗi dọn dẹp dữ liệu test:', cleanErr);
      }
    }
    client.release();
    await pool.end();
  }

  console.log('\n===============================================================');
  console.log(`📊 KẾT QUẢ KIỂM THỬ RLS: ${passed} PASS, ${failed} FAIL`);
  if (failed === 0) {
    console.log('🎉 100% CÁC CHÍNH SÁCH ROW LEVEL SECURITY ĐÃ ĐẠT CHUẨN ZERO DATA LEAK!');
  } else {
    console.log('⚠️ Có bài test RLS bị lỗi, cần kiểm tra lại.');
  }
  console.log('===============================================================');
}

runRlsTests();
