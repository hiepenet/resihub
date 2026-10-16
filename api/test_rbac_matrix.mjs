// test_rbac_matrix.mjs
// Kiểm thử phân quyền RBAC theo ma trận mục 6.2 PRD v2.0
const API_URL = 'http://localhost:5000/api/v1';

async function login(email, password = 'password123') {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Login failed for ${email}: ${res.status}`);
  }
  const data = await res.json();
  return data.accessToken;
}

async function runRbacTests() {
  console.log('====================================================');
  console.log('🛡️  BẮT ĐẦU KIỂM THỬ MA TRẬN PHÂN QUYỀN RBAC (MỤC 6.2 PRD)');
  console.log('====================================================\n');

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

  // 1. SYS_ADMIN
  console.log('--- [ROLE 1: SYS_ADMIN (admin@resihub.vn)] ---');
  const adminToken = await login('admin@resihub.vn');
  const bAdmin = await fetch(`${API_URL}/buildings`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert(bAdmin.status === 200, 'SYS_ADMIN xem danh sách tòa nhà thành công (HTTP 200)');
  const cAdmin = await fetch(`${API_URL}/contracts`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert(cAdmin.status === 200, 'SYS_ADMIN xem danh sách hợp đồng thành công (HTTP 200)');
  const dAdmin = await fetch(`${API_URL}/deposits`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert(dAdmin.status === 200, 'SYS_ADMIN xem danh sách sổ cọc thành công (HTTP 200)');
  const tAdmin = await fetch(`${API_URL}/tenants`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const tAdminData = await tAdmin.json();
  assert(tAdmin.status === 200 && tAdminData.data?.some((t) => t.id_number !== null), 'SYS_ADMIN xem hồ sơ cư dân đầy đủ PII (CCCD rõ ràng)');

  // 2. MANAGER
  console.log('\n--- [ROLE 2: MANAGER (manager@resihub.vn)] ---');
  const mgrToken = await login('manager@resihub.vn');
  const bMgr = await fetch(`${API_URL}/buildings`, { headers: { Authorization: `Bearer ${mgrToken}` } });
  assert(bMgr.status === 200, 'MANAGER xem tòa nhà thành công (HTTP 200)');
  const cMgr = await fetch(`${API_URL}/contracts`, { headers: { Authorization: `Bearer ${mgrToken}` } });
  assert(cMgr.status === 200, 'MANAGER xem hợp đồng thành công (HTTP 200)');
  const dMgr = await fetch(`${API_URL}/deposits`, { headers: { Authorization: `Bearer ${mgrToken}` } });
  assert(dMgr.status === 200, 'MANAGER xem sổ cọc thành công (HTTP 200)');
  const tMgr = await fetch(`${API_URL}/tenants`, { headers: { Authorization: `Bearer ${mgrToken}` } });
  const tMgrData = await tMgr.json();
  assert(tMgr.status === 200 && tMgrData.data?.some((t) => t.id_number !== null), 'MANAGER xem hồ sơ cư dân đầy đủ PII (CCCD rõ ràng)');

  // 3. OWNER
  console.log('\n--- [ROLE 3: OWNER (owner@resihub.vn)] ---');
  const ownerToken = await login('owner@resihub.vn');
  const bOwner = await fetch(`${API_URL}/buildings`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert(bOwner.status === 200, 'OWNER xem toàn bộ danh mục tòa nhà (HTTP 200)');
  const cOwner = await fetch(`${API_URL}/contracts`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert(cOwner.status === 200, 'OWNER xem danh sách hợp đồng (HTTP 200)');
  const dOwner = await fetch(`${API_URL}/deposits`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert(dOwner.status === 200, 'OWNER xem danh sách sổ cọc để duyệt hoàn cọc (HTTP 200)');
  const cPostOwner = await fetch(`${API_URL}/contracts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({}),
  });
  assert(cPostOwner.status === 403, 'OWNER bị CHẶN tạo mới hợp đồng (HTTP 403) - Chỉ MANAGER/SYS_ADMIN được lập HĐ');

  // 4. ACCOUNTANT
  console.log('\n--- [ROLE 4: ACCOUNTANT (accountant@resihub.vn)] ---');
  const accToken = await login('accountant@resihub.vn');
  const bAcc = await fetch(`${API_URL}/buildings`, { headers: { Authorization: `Bearer ${accToken}` } });
  assert(bAcc.status === 200, 'ACCOUNTANT xem danh mục tòa nhà để đối soát (HTTP 200)');
  const cAcc = await fetch(`${API_URL}/contracts`, { headers: { Authorization: `Bearer ${accToken}` } });
  assert(cAcc.status === 200, 'ACCOUNTANT xem hợp đồng để lập hóa đơn/thu tiền (HTTP 200)');
  const dAcc = await fetch(`${API_URL}/deposits`, { headers: { Authorization: `Bearer ${accToken}` } });
  assert(dAcc.status === 200, 'ACCOUNTANT quản lý CRU sổ cọc thành công (HTTP 200)');
  const cPostAcc = await fetch(`${API_URL}/contracts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accToken}` },
    body: JSON.stringify({}),
  });
  assert(cPostAcc.status === 403, 'ACCOUNTANT bị CHẶN tạo mới hợp đồng (HTTP 403)');

  // 5. STAFF
  console.log('\n--- [ROLE 5: STAFF (staff@resihub.vn)] ---');
  const staffToken = await login('staff@resihub.vn');
  const bStaff = await fetch(`${API_URL}/buildings`, { headers: { Authorization: `Bearer ${staffToken}` } });
  assert(bStaff.status === 200, 'STAFF xem danh sách tòa nhà/căn hộ để vận hành (HTTP 200)');
  
  const cStaff = await fetch(`${API_URL}/contracts`, { headers: { Authorization: `Bearer ${staffToken}` } });
  assert(cStaff.status === 403, 'STAFF bị CHẶN HOÀN TOÀN xem hợp đồng thuê (HTTP 403 theo PRD)');
  
  const dStaff = await fetch(`${API_URL}/deposits`, { headers: { Authorization: `Bearer ${staffToken}` } });
  assert(dStaff.status === 403, 'STAFF bị CHẶN HOÀN TOÀN xem sổ cọc (HTTP 403 theo PRD)');
  
  const tStaff = await fetch(`${API_URL}/tenants`, { headers: { Authorization: `Bearer ${staffToken}` } });
  const tStaffData = await tStaff.json();
  const allPiiMasked = tStaffData.data?.every((t) => t.id_number === null);
  assert(tStaff.status === 200 && allPiiMasked, 'STAFF xem cư dân bị ẨN HOÀN TOÀN CCCD/PII (id_number = null)');

  // 6. RESIDENT
  console.log('\n--- [ROLE 6: RESIDENT (resident@resihub.vn)] ---');
  const resToken = await login('resident@resihub.vn');
  const cRes = await fetch(`${API_URL}/contracts`, { headers: { Authorization: `Bearer ${resToken}` } });
  const cResData = await cRes.json();
  const isSelfOnly = cResData.data.every((c) => c.tenant_phone === '0900000005');
  assert(cRes.status === 200 && isSelfOnly, 'RESIDENT chỉ xem được hợp đồng của chính mình (Zero Data Leak)');

  const dRes = await fetch(`${API_URL}/deposits`, { headers: { Authorization: `Bearer ${resToken}` } });
  const dResData = await dRes.json();
  if (!dResData.data) console.log('dRes response:', dRes.status, dResData);
  assert(dRes.status === 200 && dResData.data?.length === 0, 'RESIDENT chỉ xem được sổ cọc của chính mình (không thấy cọc của căn khác)');

  const cPostRes = await fetch(`${API_URL}/contracts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resToken}` },
    body: JSON.stringify({}),
  });
  assert(cPostRes.status === 403, 'RESIDENT bị CHẶN tạo mới hợp đồng (HTTP 403)');

  console.log('\n====================================================');
  console.log(`📊 KẾT QUẢ KIỂM THỬ RBAC: ${passed} PASS, ${failed} FAIL`);
  if (failed === 0) {
    console.log('🎉 100% CÁC ROLE TUÂN THỦ HOÀN TOÀN MA TRẬN PHÂN QUYỀN PRD 6.2!');
  }
  console.log('====================================================');
}

runRbacTests().catch(console.error);
