// test_phase1_compliance.mjs
// Comprehensive test suite for Phase 1 business flows (NV-01 to NV-13)

const API_URL = 'http://localhost:5000/api/v1';

async function run() {
  console.log('====================================================');
  console.log('🧪 BẮT ĐẦU KIỂM THỬ TOÀN DIỆN PHASE 1 COMPLIANCE');
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

  // --- 0. NV-01: ĐĂNG NHẬP OTP QUA SĐT ---
  console.log('--- [TEST 0] ĐĂNG NHẬP OTP QUA SỐ ĐIỆN THOẠI (NV-01) ---');
  try {
    const otpReq = await fetch(`${API_URL}/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '0907778899' }),
    });
    const otpReqData = await otpReq.json();
    assert(otpReq.status === 200, 'Yêu cầu gửi mã OTP thành công (HTTP 200)');
    assert(otpReqData.message === 'OTP đã được gửi thành công.', 'Thông điệp trung lập chống leak SĐT');

    const otpVer = await fetch(`${API_URL}/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '0907778899', otp: '123456' }),
    });
    const otpVerData = await otpVer.json();
    assert(otpVer.status === 200, 'Xác thực OTP thành công (HTTP 200)');
    assert(!!otpVerData.accessToken, 'Cấp JWT Access Token khi xác thực OTP thành công');
  } catch (err) {
    assert(false, `Lỗi test OTP: ${err.message}`);
  }

  // --- 1. AUTHENTICATION & LOGIN ---
  console.log('\n--- [TEST 1] ĐĂNG NHẬP NHÂN SỰ NỘI BỘ (NV-02) ---');
  let token = '';
  let orgId = '';
  try {
    const loginRes = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'manager@resihub.vn', password: 'password123' }),
    });
    const loginData = await loginRes.json();
    assert(loginRes.status === 200, 'Đăng nhập nhân sự quản trị (SYS_ADMIN/OWNER/MANAGER) thành công với HTTP 200');
    assert(!!loginData.accessToken, 'Nhận accessToken hợp lệ');
    token = loginData.accessToken;
    orgId = loginData.user?.org_id;
  } catch (err) {
    assert(false, `Lỗi đăng nhập: ${err.message}`);
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // --- 2. NV-03: TẠO TÒA NHÀ & REAL-TIME CHECK CODE ---
  console.log('\n--- [TEST 2] TẠO TÒA NHÀ & CHECK MÃ TÒA REAL-TIME (NV-03) ---');
  const testCode = `TN-TEST-${Date.now().toString().slice(-4)}`;
  try {
    // 2.1 Check code khi chưa tồn tại
    const check1 = await fetch(`${API_URL}/buildings/check-code?code=${testCode}`, { headers });
    const check1Data = await check1.json();
    assert(check1Data.available === true, `Mã tòa ${testCode} khả dụng`);

    // 2.2 Tạo tòa nhà mới kèm payment_account & lease_terms (FR-070)
    const createRes = await fetch(`${API_URL}/buildings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `Tòa Kiểm Thử ${testCode}`,
        code: testCode,
        address: '123 Đường Số 1, TP. Thủ Đức',
        payment_account: { bank: 'VCB', account_no: '0071009999999', account_name: 'CTY RESIHUB' },
        lease_terms: { notes: 'Hợp đồng thuê 5 năm' },
      }),
    });
    const createData = await createRes.json();
    assert(createRes.status === 201, 'Tạo tòa nhà mới thành công (HTTP 201)');
    const buildingId = createData.data?.id;

    // 2.3 Check code khi đã tồn tại
    const check2 = await fetch(`${API_URL}/buildings/check-code?code=${testCode}`, { headers });
    const check2Data = await check2.json();
    assert(check2Data.available === false, `Mã tòa ${testCode} bị báo trùng sau khi tạo`);

    // --- 3. NV-04: THÊM TẦNG & INTEGER LEVEL (HẦM, TRỆT, LẦU) ---
    console.log('\n--- [TEST 3] THÊM TẦNG HẦM, TRỆT, LẦU & RÀNG BUỘC (NV-04) ---');
    // 3.1 Tầng hầm (level = -1) để trống tên -> auto name "Tầng hầm B1"
    const floorB1 = await fetch(`${API_URL}/buildings/${buildingId}/floors`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ level: -1 }),
    });
    const floorB1Data = await floorB1.json();
    assert(floorB1.status === 201, 'Tạo tầng hầm B1 (level = -1) thành công (HTTP 201)');
    assert(floorB1Data.data?.name === 'Tầng hầm B1', 'Tự động sinh tên: "Tầng hầm B1"');

    // 3.2 Tầng trệt (level = 0) để trống tên -> auto name "Tầng Trệt"
    const floorG = await fetch(`${API_URL}/buildings/${buildingId}/floors`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ level: 0 }),
    });
    const floorGData = await floorG.json();
    assert(floorG.status === 201, 'Tạo tầng trệt (level = 0) thành công (HTTP 201)');
    assert(floorGData.data?.name === 'Tầng Trệt', 'Tự động sinh tên: "Tầng Trệt"');

    // 3.3 Tầng 1 (level = 1)
    const floor1 = await fetch(`${API_URL}/buildings/${buildingId}/floors`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ level: 1 }),
    });
    const floor1Data = await floor1.json();
    assert(floor1.status === 201, 'Tạo tầng 1 (level = 1) thành công (HTTP 201)');
    const floor1Id = floor1Data.data?.id;

    // 3.4 Tạo tầng trùng level -> 409 FLOOR_EXISTS
    const floorDup = await fetch(`${API_URL}/buildings/${buildingId}/floors`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ level: 1 }),
    });
    assert(floorDup.status === 409, 'Chặn tạo tầng trùng level trong cùng tòa (HTTP 409)');

    // 3.5 Lấy danh sách tầng
    const floorsRes = await fetch(`${API_URL}/buildings/${buildingId}/floors`, { headers });
    const floorsData = await floorsRes.json();
    assert(floorsData.data?.length === 3, 'Lấy danh sách đủ 3 tầng vừa tạo');

    // --- 4. NV-05: TẠO CĂN HỘ & SƠ ĐỒ TẦNG ---
    console.log('\n--- [TEST 4] TẠO CĂN HỘ VỚI GIÁ BIGINT & SƠ ĐỒ TẦNG (NV-05) ---');
    const apt1Res = await fetch(`${API_URL}/apartments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        building_id: buildingId,
        floor_id: floor1Id,
        code: `${testCode}-101`,
        area_m2: 40.5,
        type: '1PN',
        bedrooms: 1,
        base_rent: 7500000, // BIGINT VND
      }),
    });
    const apt1Data = await apt1Res.json();
    assert(apt1Res.status === 201, 'Tạo căn hộ thành công với HTTP 201');
    assert(apt1Data.data?.status === 'AVAILABLE', 'Trạng thái căn hộ mới mặc định là AVAILABLE');
    const apt1Id = apt1Data.data?.id;

    // 4.2 Thử xóa tầng đang có căn hộ -> Chặn 400 FLOOR_HAS_APARTMENTS
    const delFloorRes = await fetch(`${API_URL}/buildings/${buildingId}/floors/${floor1Id}`, {
      method: 'DELETE',
      headers,
    });
    assert(delFloorRes.status === 400, 'Chặn xóa tầng khi đang chứa căn hộ (HTTP 400)');

    // --- 5. NV-06: ĐẶT CỌC GIỮ CHỖ (RESERVATION) ---
    console.log('\n--- [TEST 5] ĐẶT CỌC GIỮ CHỖ KHÁCH TIỀM NĂNG (NV-06) ---');
    const reserveRes = await fetch(`${API_URL}/reservations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        apartment_id: apt1Id,
        prospect_name: 'Nguyễn Văn Khách',
        phone: '0908888999',
        hold_amount: 1000000,
        hold_until: '2026-10-30',
        note: 'Hẹn cuối tuần ký hợp đồng',
      }),
    });
    const reserveData = await reserveRes.json();
    assert(reserveRes.status === 201, 'Đặt cọc giữ chỗ thành công (HTTP 201)');
    assert(reserveData.data?.status === 'HELD', 'Trạng thái giữ chỗ là HELD');
    const reservationId = reserveData.data?.id;

    // 5.2 Kiểm tra căn hộ tự động chuyển sang RESERVED
    const aptCheck = await fetch(`${API_URL}/apartments`, { headers });
    const aptCheckData = await aptCheck.json();
    const targetApt = aptCheckData.data?.find((a) => a.id === apt1Id);
    assert(targetApt?.status === 'RESERVED', 'Căn hộ tự động chuyển sang RESERVED');

    // 5.3 Thử đặt cọc lần nữa trên căn đang RESERVED -> 409
    const reserveConflict = await fetch(`${API_URL}/reservations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        apartment_id: apt1Id,
        prospect_name: 'Người Thứ Hai',
        phone: '0901111222',
        hold_amount: 1000000,
      }),
    });
    assert(reserveConflict.status === 409, 'Chặn đặt cọc trên căn đang RESERVED (HTTP 409)');

    // 5.4 Test Hủy giữ chỗ / Hoàn giữ chỗ -> phòng trở lại AVAILABLE
    const forfeitRes = await fetch(`${API_URL}/reservations/${reservationId}/forfeit`, {
      method: 'PATCH',
      headers,
    });
    assert(forfeitRes.status === 200, 'Ghi nhận khách hủy cọc giữ chỗ thành công (HTTP 200)');

    const aptAfterForfeit = await (await fetch(`${API_URL}/apartments`, { headers })).json();
    const aptReleased = aptAfterForfeit.data?.find((a) => a.id === apt1Id);
    assert(aptReleased?.status === 'AVAILABLE', 'Căn hộ đã tự động mở lại trạng thái AVAILABLE');

    // --- 6. NV-07: TẠO HỒ SƠ CƯ DÂN & DUPLICATE CHECK ---
    console.log('\n--- [TEST 6] HỒ SƠ CƯ DÂN & DUPLICATE CHECK (NV-07) ---');
    const testPhone = `091${Date.now().toString().slice(-7)}`;
    const tenantRes = await fetch(`${API_URL}/tenants`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        full_name: 'Trần Thị Thuê Nhà',
        phone: testPhone,
        email: 'tenant_test@gmail.com',
        type: 'primary',
      }),
    });
    const tenantData = await tenantRes.json();
    assert(tenantRes.status === 201, 'Tạo hồ sơ cư dân thành công (HTTP 201)');
    const tenantId = tenantData.data?.id;

    // Duplicate check
    const dupCheck = await fetch(`${API_URL}/tenants/check-dup?phone=${testPhone}`, { headers });
    const dupCheckData = await dupCheck.json();
    assert(dupCheckData.isDuplicate === true, 'Duplicate check phát hiện đúng số điện thoại vừa tạo');

    // --- 7. NV-08: LẬP HỢP ĐỒNG THUÊ & CHỐNG CHỒNG LẤN KỲ ---
    console.log('\n--- [TEST 7] LẬP HỢP ĐỒNG THUÊ & CHỐNG CHỒNG LẤN KỲ (NV-08) ---');
    // 7.1 Kiểm tra date: end_date <= start_date -> 422
    const invalidDateRes = await fetch(`${API_URL}/contracts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        apartment_id: apt1Id,
        building_id: buildingId,
        primary_tenant_id: tenantId,
        start_date: '2026-11-01',
        end_date: '2026-10-01', // Ngày kết thúc trước ngày bắt đầu
        rent_amount: 7500000,
      }),
    });
    assert(invalidDateRes.status === 422, 'Chặn hợp đồng có end_date <= start_date (HTTP 422)');

    // 7.2 Tạo hợp đồng hợp lệ (01/11/2026 -> 31/10/2027)
    const contractRes = await fetch(`${API_URL}/contracts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        apartment_id: apt1Id,
        building_id: buildingId,
        primary_tenant_id: tenantId,
        start_date: '2026-11-01',
        end_date: '2027-10-31',
        rent_amount: 7500000,
        billing_day: 5,
        deposit_amount: 7500000, // Tiền cọc = 1 tháng thuê chuẩn PRD
      }),
    });
    const contractData = await contractRes.json();
    assert(contractRes.status === 201, 'Tạo hợp đồng thuê hợp lệ thành công (HTTP 201)');
    const contractId = contractData.data?.id;

    // Căn hộ phải chuyển sang OCCUPIED
    const aptOccupied = await (await fetch(`${API_URL}/apartments`, { headers })).json();
    const aptOcc = aptOccupied.data?.find((a) => a.id === apt1Id);
    assert(aptOcc?.status === 'OCCUPIED', 'Căn hộ chuyển sang trạng thái OCCUPIED');

    // 7.3 Tạo hợp đồng thứ hai chồng kỳ lên căn này -> 409 OVERLAP_CONTRACT
    const overlapRes = await fetch(`${API_URL}/contracts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        apartment_id: apt1Id,
        building_id: buildingId,
        primary_tenant_id: tenantId,
        start_date: '2027-01-01',
        end_date: '2027-06-30', // Chồng lên kỳ 11/2026-10/2027
        rent_amount: 8000000,
      }),
    });
    assert(overlapRes.status === 409, 'Chặn tạo hợp đồng chồng lấn kỳ hạn cùng căn (HTTP 409 OVERLAP_CONTRACT)');

    // --- 8. NV-11 & NV-12: THU CỌC & KHẤU TRỪ CỌC (CẤM TRỪ TIỀN THUÊ) ---
    console.log('\n--- [TEST 8] SỔ CỌC & CẤM CẤN TRỪ TIỀN THUÊ VÀO CỌC (NV-11, NV-12) ---');
    const depositsList = await (await fetch(`${API_URL}/deposits`, { headers })).json();
    const depositRecord = depositsList.data?.find((d) => d.contract_id === contractId);
    assert(!!depositRecord, 'Sổ cọc tự động khởi tạo ở trạng thái HELD');
    assert(depositRecord && BigInt(depositRecord.amount_held) === 7500000n, 'Số tiền cọc đang giữ chuẩn 7.500.000 ₫');

    // 8.2 Thử khấu trừ cọc với lý do tiền thuê -> Bị CHẶN theo quy tắc PRD
    const deductRentRes = await fetch(`${API_URL}/deposits/${depositRecord.id}/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'deduct',
        amount: 3000000,
        description: 'Trừ nợ tiền thuê tháng 11',
        category: 'rent',
      }),
    });
    assert(deductRentRes.status === 400, 'Chặn cấn trừ tiền thuê vào tiền cọc (HTTP 400 RENT_OFFSET_PROHIBITED)');

    // 8.3 Khấu trừ hợp lệ (hư hỏng tài sản) -> Thành công
    const deductDamageRes = await fetch(`${API_URL}/deposits/${depositRecord.id}/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'deduct',
        amount: 1500000,
        description: 'Thay kính cửa sổ bị nứt vỡ',
        category: 'property_damage',
      }),
    });
    assert(deductDamageRes.status === 201, 'Khấu trừ hư hại tài sản 1.500.000 ₫ thành công (HTTP 201)');

    // Kiểm tra số dư cọc còn lại (7.500.000 - 1.500.000 = 6.000.000)
    const depositsUpdated = await (await fetch(`${API_URL}/deposits`, { headers })).json();
    const depositAfterDeduct = depositsUpdated.data?.find((d) => d.id === depositRecord.id);
    assert(BigInt(depositAfterDeduct?.amount_held) === 6000000n, 'Số dư cọc còn lại chính xác 6.000.000 ₫');

    // --- 9. RÀNG BUỘC TÒA NHÀ KHÔNG CHO INACTIVE KHI CÓ HỢP ĐỒNG ACTIVE ---
    console.log('\n--- [TEST 9] CHẶN INACTIVE TÒA NHÀ KHI CÒN HỢP ĐỒNG ACTIVE ---');
    const deactivateRes = await fetch(`${API_URL}/buildings/${buildingId}/status`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'INACTIVE' }),
    });
    assert(deactivateRes.status === 400, 'Chặn chuyển tòa sang INACTIVE khi còn hợp đồng ACTIVE (HTTP 400)');

    // --- 10. NV-10: CHẤM DỨT HỢP ĐỒNG ---
    console.log('\n--- [TEST 10] CHẤM DỨT HỢP ĐỒNG & MỞ LẠI CĂN HỘ (NV-10) ---');
    const termRes = await fetch(`${API_URL}/contracts/${contractId}/terminate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'Khách hết nhu cầu', note: 'Đã nghiệm thu phòng' }),
    });
    assert(termRes.status === 200, 'Chấm dứt hợp đồng thành công (HTTP 200)');

    const aptAfterTerm = await (await fetch(`${API_URL}/apartments`, { headers })).json();
    const aptFinal = aptAfterTerm.data?.find((a) => a.id === apt1Id);
    assert(aptFinal?.status === 'AVAILABLE', 'Căn hộ đã tự động mở lại trạng thái AVAILABLE sau khi chấm dứt hợp đồng');
  } catch (err) {
    console.error('Lỗi ngoại lệ trong quá trình chạy test:', err);
    failed++;
  }

  console.log('\n====================================================');
  console.log(`📊 KẾT QUẢ KIỂM THỬ: ${passed} PASS, ${failed} FAIL`);
  if (failed === 0) {
    console.log('🎉 100% CÁC TEST CASES ĐÃ VƯỢT QUA VÀ KHỚP VỚI PRD!');
  } else {
    console.log('⚠️ Có bài test bị lỗi, cần kiểm tra lại.');
  }
  console.log('====================================================');
}

run();
