// test_crud_scoping.mjs
// Kiểm thử CRUD Tòa nhà, Tầng, Căn hộ theo phân quyền:
// - Manager: CRU (tòa của mình quản lý)
// - Owner: R (toàn bộ tòa thuộc sở hữu)
// - Resident: R (căn của mình)
// - Đã xóa: ACCOUNTANT, STAFF, SYS_ADMIN
import { pool } from './src/db/client.js';

const API_URL = 'http://localhost:5000/api/v1';

async function login(email, password = 'password123') {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Login failed for ${email}: ${res.status} - ${JSON.stringify(err)}`);
  }
  const data = await res.json();
  return data.accessToken;
}

async function runTests() {
  console.log('===============================================================');
  console.log('🏢 BẮT ĐẦU KIỂM THỬ CRUD TÒA NHÀ, TẦNG, CĂN HỘ & PHÂN QUYỀN MỚI');
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

  // 1. Kiểm tra CSDL đã xóa sạch ACCOUNTANT, STAFF, SYS_ADMIN
  console.log('--- [1. KIỂM TRA CƠ SỞ DỮ LIỆU ĐÃ XÓA DEPRECATED ROLES] ---');
  const rolesInDb = await pool.query('SELECT code, name FROM role ORDER BY code');
  const roleCodes = rolesInDb.rows.map((r) => r.code);
  assert(
    !roleCodes.includes('SYS_ADMIN') && !roleCodes.includes('STAFF') && !roleCodes.includes('ACCOUNTANT'),
    'Không còn tồn tại role SYS_ADMIN, STAFF, ACCOUNTANT trong bảng role'
  );
  assert(
    roleCodes.length === 3 && roleCodes.includes('MANAGER') && roleCodes.includes('OWNER') && roleCodes.includes('RESIDENT'),
    `CSDL chỉ còn đúng 3 roles: [${roleCodes.join(', ')}]`
  );

  // 2. Kiểm thử MANAGER (CRU tòa nhà, tầng, căn hộ thuộc quyền quản lý)
  console.log('\n--- [2. KIỂM THỬ MANAGER: CRU TÒA NHÀ CỦA MÌNH QUẢN LÝ] ---');
  const mgrToken = await login('manager@resihub.vn');

  // 2.1 Xem danh sách tòa nhà: Chỉ xem tòa được gán quản lý
  const mgrBuildingsRes = await fetch(`${API_URL}/buildings`, {
    headers: { Authorization: `Bearer ${mgrToken}` },
  });
  assert(mgrBuildingsRes.status === 200, 'Manager xem danh sách tòa nhà (HTTP 200)');
  const mgrBuildingsData = await mgrBuildingsRes.json();
  const initialMgrCount = mgrBuildingsData.data.length;
  console.log(`     Manager đang quản lý: ${initialMgrCount} tòa nhà`);

  // 2.2 Manager tạo tòa nhà mới (C)
  const newCode = `MGR-${Date.now().toString().slice(-4)}`;
  const createBldRes = await fetch(`${API_URL}/buildings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({
      name: `Tòa Nhà Manager Mới ${newCode}`,
      code: newCode,
      address: '100 Đường Mới, Quận 2, TP.HCM',
    }),
  });
  assert(createBldRes.status === 201, `Manager tạo mới tòa nhà ${newCode} thành công (HTTP 201)`);
  const createdBld = (await createBldRes.json()).data;

  // 2.3 Tòa mới tự động được gán quyền quản lý cho Manager
  const mgrBuildingsAfter = await fetch(`${API_URL}/buildings`, {
    headers: { Authorization: `Bearer ${mgrToken}` },
  });
  const mgrBuildingsAfterData = await mgrBuildingsAfter.json();
  const hasNewBld = mgrBuildingsAfterData.data.some((b) => b.id === createdBld.id);
  assert(hasNewBld, 'Tòa nhà mới tạo tự động được gán quyền cho Manager quản lý');

  // 2.4 Manager tạo tầng trong tòa nhà của mình (C)
  const createFloorRes = await fetch(`${API_URL}/buildings/${createdBld.id}/floors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({ level: 1, name: 'Tầng 1' }),
  });
  assert(createFloorRes.status === 201, 'Manager tạo tầng 1 trong tòa nhà của mình (HTTP 201)');
  const createdFloor = (await createFloorRes.json()).data;

  // 2.5 Manager tạo căn hộ trong tòa nhà của mình (C)
  const createAptRes = await fetch(`${API_URL}/apartments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({
      building_id: createdBld.id,
      floor_id: createdFloor.id,
      code: `${newCode}-101`,
      area_m2: 50,
      base_rent: 8500000,
    }),
  });
  assert(createAptRes.status === 201, 'Manager tạo căn hộ trong tòa nhà của mình (HTTP 201)');
  const createdApt = (await createAptRes.json()).data;

  // 2.6 Manager cập nhật thông tin căn hộ (U)
  const updateAptRes = await fetch(`${API_URL}/apartments/${createdApt.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({ base_rent: 9000000, note: 'Đã nâng cấp nội thất cao cấp' }),
  });
  assert(updateAptRes.status === 200, 'Manager cập nhật giá thuê/ghi chú căn hộ của mình (HTTP 200)');

  // 2.7 Manager cập nhật trạng thái tòa nhà (U)
  const updateBldRes = await fetch(`${API_URL}/buildings/${createdBld.id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({ status: 'ACTIVE' }),
  });
  assert(updateBldRes.status === 200, 'Manager cập nhật trạng thái tòa nhà của mình (HTTP 200)');

  // 2.8 Manager cố xóa tầng hoặc căn hộ -> BỊ CHẶN (CRU không có D)
  // Tạo thêm tầng trống để kiểm tra bị chặn 403 khi xóa
  const emptyFloorRes = await fetch(`${API_URL}/buildings/${createdBld.id}/floors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({ level: 99, name: 'Tầng 99' }),
  });
  const emptyFloor = (await emptyFloorRes.json()).data;

  const delFloorRes = await fetch(`${API_URL}/buildings/${createdBld.id}/floors/${emptyFloor.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${mgrToken}` },
  });
  assert(delFloorRes.status === 403, 'Manager bị CHẶN xóa tầng (HTTP 403 - CRU không có quyền Delete)');

  // 3. Kiểm thử OWNER (R toàn bộ tòa thuộc sở hữu, KHÔNG ĐƯỢC TẠO/SỬA)
  console.log('\n--- [3. KIỂM THỬ OWNER: R TOÀN BỘ TÒA THUỘC SỞ HỮU (READ-ONLY)] ---');
  const ownerToken = await login('owner@resihub.vn');

  // 3.1 Owner xem toàn bộ danh mục tòa nhà trong tổ chức
  const ownerBuildingsRes = await fetch(`${API_URL}/buildings`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert(ownerBuildingsRes.status === 200, 'Owner xem danh sách toàn bộ tòa nhà (HTTP 200)');
  const ownerBuildingsData = await ownerBuildingsRes.json();
  assert(
    ownerBuildingsData.data.length >= mgrBuildingsAfterData.data.length,
    `Owner xem được toàn bộ ${ownerBuildingsData.data.length} tòa nhà trong tổ chức`
  );

  // 3.2 Owner cố tạo tòa nhà mới -> BỊ CHẶN (Owner là Read-only)
  const ownerCreateBldRes = await fetch(`${API_URL}/buildings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: 'Tòa Nhà Owner', code: 'OWN-FAIL', address: 'Quận 1' }),
  });
  assert(ownerCreateBldRes.status === 403, 'Owner bị CHẶN tạo mới tòa nhà (HTTP 403 - Owner chỉ có quyền R)');

  // 3.3 Owner cố tạo tầng -> BỊ CHẶN
  const ownerCreateFloorRes = await fetch(`${API_URL}/buildings/${createdBld.id}/floors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ level: 2, name: 'Tầng 2' }),
  });
  assert(ownerCreateFloorRes.status === 403, 'Owner bị CHẶN tạo tầng mới (HTTP 403 - Owner chỉ có quyền R)');

  // 3.4 Owner cố tạo căn hộ -> BỊ CHẶN
  const ownerCreateAptRes = await fetch(`${API_URL}/apartments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ building_id: createdBld.id, code: 'OWN-APT', base_rent: 5000000 }),
  });
  assert(ownerCreateAptRes.status === 403, 'Owner bị CHẶN tạo căn hộ mới (HTTP 403 - Owner chỉ có quyền R)');

  // 3.5 Owner cố sửa căn hộ -> BỊ CHẶN
  const ownerUpdateAptRes = await fetch(`${API_URL}/apartments/${createdApt.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ base_rent: 10000000 }),
  });
  assert(ownerUpdateAptRes.status === 403, 'Owner bị CHẶN sửa căn hộ (HTTP 403 - Owner chỉ có quyền R)');

  // 4. Kiểm thử RESIDENT (R căn hộ của mình)
  console.log('\n--- [4. KIỂM THỬ RESIDENT: R CĂN HỘ CỦA MÌNH] ---');
  const resToken = await login('resident@resihub.vn');

  // 4.1 Resident xem danh sách tòa nhà -> Chỉ thấy tòa có căn hộ của mình
  const resBldRes = await fetch(`${API_URL}/buildings`, {
    headers: { Authorization: `Bearer ${resToken}` },
  });
  const resBldData = await resBldRes.json();
  assert(resBldRes.status === 200, 'Resident truy vấn tòa nhà thành công (HTTP 200)');
  assert(resBldData.data.length <= 1, 'Resident chỉ nhìn thấy tối đa 1 tòa nhà mà mình đang thuê');

  // 4.2 Resident xem căn hộ -> Chỉ thấy căn hộ của mình
  const resAptRes = await fetch(`${API_URL}/apartments`, {
    headers: { Authorization: `Bearer ${resToken}` },
  });
  assert(resAptRes.status === 200, 'Resident truy vấn căn hộ thành công (HTTP 200)');

  // 4.3 Resident cố tạo tòa hoặc căn hộ -> BỊ CHẶN
  const resPostBld = await fetch(`${API_URL}/buildings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resToken}` },
    body: JSON.stringify({ name: 'Tòa Test', code: 'RES-FAIL' }),
  });
  assert(resPostBld.status === 403, 'Resident bị CHẶN tạo tòa nhà (HTTP 403)');

  const resPostApt = await fetch(`${API_URL}/apartments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resToken}` },
    body: JSON.stringify({ code: 'RES-APT' }),
  });
  assert(resPostApt.status === 403, 'Resident bị CHẶN tạo căn hộ (HTTP 403)');

  console.log('\n===============================================================');
  console.log(`📊 KẾT QUẢ KIỂM THỬ: ${passed} PASS, ${failed} FAIL`);
  if (failed === 0) {
    console.log('🎉 100% CÁC TEST CASES ĐÃ ĐẠT CHUẨN THEO YÊU CẦU MỚI!');
  }
  console.log('===============================================================');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
