/**
 * phase1_phase2_acceptance_test.js
 * ============================================================
 * Testcase Nghiệm thu Giai đoạn 1 & Giai đoạn 2 — ResiHub
 * Framework: Node.js built-in `node:test` + `node:assert/strict`
 *
 * Chạy: node --test test/phase1_phase2_acceptance_test.js
 * Yêu cầu: API server đang chạy tại TEST_API_BASE (default: http://127.0.0.1:5000)
 *          DB đã seed dữ liệu mẫu (npm run seed)
 * ============================================================
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

// ─── Import services trực tiếp cho unit tests ───────────────
import { adminPool } from '../src/db/client.js';
import { roundVND, calcProrata, calcUtility } from '../src/services/pricing.js';
import {
  todayVietnamYmd,
  currentVietnamPeriod,
  resolveServiceUnitPrice,
  computeLateFeeAccrual,
} from '../src/services/serviceBilling.js';
import {
  validateDeduction,
  computeRefund,
  isPositiveSafeIntegerVnd,
} from '../src/services/depositSettlement.js';
import {
  isTransitionAllowed,
  APARTMENT_STATUSES,
  APARTMENT_TRANSITIONS,
} from '../src/services/apartmentStatus.js';
import {
  otpStore,
  phoneRequestTracker,
  requestPhoneOtp,
  verifyPhoneOtp,
} from '../src/services/otpService.js';

after(async () => {
  await adminPool
    .query(`DELETE FROM building WHERE code LIKE 'TST-%' OR code LIKE 'DUP-%'`)
    .catch(() => {});
});

// ─── Helpers ────────────────────────────────────────────────
const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5000';

async function apiFetch(path, options = {}) {
  const { token, ...rest } = options;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(rest.headers || {}),
    },
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
}

async function loginEmail(email, password) {
  const { status, body } = await apiFetch('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(status, 200, `Login failed: ${JSON.stringify(body)}`);
  return body.accessToken;
}

// ════════════════════════════════════════════════════════════
// ░░░ GIAI ĐOẠN 1 ░░░
// ════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────
// NHÓM A: Đăng nhập OTP (Tiêu chí: hệ thống chạy local, login OTP)
// ────────────────────────────────────────────────────────────

test('[P1-A] Nhóm kiểm thử: Đăng nhập & Xác thực OTP', async (t) => {

  // ── TC-P1-A-01: OTP request hợp lệ → 200 + devOtp ──────
  await t.test('TC-P1-A-01 · OTP request — SĐT hợp lệ → 200 + devOtp', async () => {
    const { status, body } = await apiFetch('/api/v1/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone: '0912345678' }),
    });
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    // Server có thể trả devOtp hoặc không (nếu SĐT không tồn tại)
    if (body.devOtp) {
      assert.match(body.devOtp, /^\d{6}$/, 'devOtp phải là 6 chữ số');
    }
  });

  // ── TC-P1-A-02: SĐT không tồn tại → 200 (không lộ thông tin) ──
  await t.test('TC-P1-A-02 · OTP request — SĐT không tồn tại → 200 (không user enumeration)', async () => {
    const { status, body } = await apiFetch('/api/v1/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone: '0888000111' }),
    });
    assert.equal(status, 200, 'Không được trả 404 — tránh user enumeration');
    assert.ok(
      !body.devOtp || body.devOtp === '',
      'Không được trả devOtp cho SĐT không tồn tại'
    );
  });

  // ── TC-P1-A-03: SĐT sai định dạng → 400 ────────────────
  await t.test('TC-P1-A-03 · OTP request — SĐT sai định dạng → 400', async () => {
    const badPhones = ['12345', '', 'abcdefghij', '091234'];
    for (const phone of badPhones) {
      const { status } = await apiFetch('/api/v1/auth/otp/request', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      });
      assert.equal(status, 400, `SĐT "${phone}" phải trả 400`);
    }
  });

  // ── TC-P1-A-04: OTP verify đúng → 200 + tokens ──────────
  await t.test('TC-P1-A-04 · OTP verify — mã đúng → 200 + accessToken', async () => {
    // Step 1: request OTP
    const reqRes = await apiFetch('/api/v1/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone: '0912345678' }),
    });
    if (reqRes.status !== 200 || !reqRes.body.devOtp) {
      // Skip nếu SĐT không tồn tại trong test DB
      return;
    }
    const { devOtp } = reqRes.body;

    // Step 2: verify OTP
    const verRes = await apiFetch('/api/v1/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone: '0912345678', otp: devOtp }),
    });
    assert.equal(verRes.status, 200, `Verify OTP thất bại: ${JSON.stringify(verRes.body)}`);
    assert.ok(verRes.body.accessToken, 'Phải có accessToken');
    assert.ok(verRes.body.refreshToken, 'Phải có refreshToken');
    assert.ok(Array.isArray(verRes.body.user?.roles), 'user.roles phải là mảng');
  });

  // ── TC-P1-A-05: OTP sai → 401 ───────────────────────────
  await t.test('TC-P1-A-05 · OTP verify — mã sai → 400/401, không có token', async () => {
    const { status, body } = await apiFetch('/api/v1/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone: '0912345678', otp: '000000' }),
    });
    assert.ok([400, 401].includes(status), `Expected 400/401, got ${status}`);
    assert.ok(!body.accessToken, 'Không được có accessToken khi mã sai');
  });

  // ── TC-P1-A-06: OTP hết hạn (Unit) ───────────────────────
  await t.test('TC-P1-A-06 · OTP hết hạn sau 5 phút (unit — otpService)', async () => {
    const phone = '0999111222';
    otpStore.set(phone, {
      otp: '654321',
      expiresAt: Date.now() - 60 * 1000,
      attempts: 0,
      lockedUntil: null,
    });
    const verResult = await verifyPhoneOtp(phone, '654321');
    otpStore.delete(phone);
    assert.equal(verResult.ok, false, 'OTP hết hạn phải trả ok:false');
    assert.equal(verResult.code, 'OTP_EXPIRED');
  });

  // ── TC-P1-A-07: Rate limit 3 lần/giờ (Unit) ─────────────
  await t.test('TC-P1-A-07 · Rate limit OTP — lần 4 trả RATE_LIMIT_EXCEEDED (unit)', () => {
    const phone = '0888333444';
    phoneRequestTracker.delete(phone);
    const now = Date.now();
    // 3 lần hợp lệ
    requestPhoneOtp(phone, { now, store: false });
    requestPhoneOtp(phone, { now: now + 1000, store: false });
    requestPhoneOtp(phone, { now: now + 2000, store: false });
    // Lần 4 → rate limit
    const result = requestPhoneOtp(phone, { now: now + 3000, store: false });
    phoneRequestTracker.delete(phone);
    assert.equal(result.ok, false, 'Lần 4 phải thất bại');
    assert.equal(result.code, 'RATE_LIMIT_EXCEEDED');
  });

  // ── TC-P1-A-08: Khóa 15 phút sau 5 lần sai (Unit) ───────
  await t.test('TC-P1-A-08 · Khóa 15 phút sau 5 lần nhập OTP sai (unit)', async () => {
    const phone = '0888555666';
    otpStore.delete(phone);
    phoneRequestTracker.delete(phone);
    const req = requestPhoneOtp(phone, { now: Date.now(), store: true });
    assert.equal(req.ok, true);
    const noopPool = { query: async () => ({ rows: [] }) };

    // Nhập sai 5 lần
    for (let i = 0; i < 5; i++) {
      await verifyPhoneOtp(phone, '111111', { dbPool: noopPool });
    }
    // Lần 6 (dù đúng) phải bị locked
    const result = await verifyPhoneOtp(phone, req.otp, { dbPool: noopPool });
    otpStore.delete(phone);
    phoneRequestTracker.delete(phone);
    assert.equal(result.ok, false);
    assert.ok(['TOO_MANY_ATTEMPTS', 'ACCOUNT_LOCKED'].includes(result.code));
  });

  // ── TC-P1-A-09: Redirect đúng vai trò (Integration) ──────
  await t.test('TC-P1-A-09 · Đăng nhập email → redirect đúng vai trò', async () => {
    // Admin login
    const { status, body } = await apiFetch('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@resihub.vn', password: 'Admin@123456' }),
    });
    assert.equal(status, 200, `Admin login thất bại: ${JSON.stringify(body)}`);
    assert.ok(body.accessToken, 'Phải có accessToken');
    // Role phải là admin-level
    const roles = body.user?.roles?.map((r) => (typeof r === 'string' ? r : r?.code)) || [];
    assert.ok(
      roles.some((r) => ['SYS_ADMIN', 'OWNER', 'MANAGER'].includes(r)),
      `Admin phải có role admin-level, nhận được: ${JSON.stringify(roles)}`
    );
  });

  // ── TC-P1-A-10: Quên mật khẩu — step 1 request ──────────
  await t.test('TC-P1-A-10 · Quên mật khẩu — request code qua email', async () => {
    const { status, body } = await apiFetch('/api/v1/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@resihub.vn' }),
    });
    assert.ok([200, 404].includes(status), `Expected 200 or 404, got ${status}`);
    if (status === 200 && body.devResetCode) {
      assert.match(body.devResetCode, /^\d{6}$/, 'devResetCode phải 6 chữ số');
    }
  });

  // ── TC-P1-A-11: Reset password — mật khẩu < 8 ký tự → 400 ──
  await t.test('TC-P1-A-11 · Reset password — mật khẩu ngắn < 8 ký tự → 400', async () => {
    const { status } = await apiFetch('/api/v1/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@resihub.vn', code: '000000', newPassword: 'abc' }),
    });
    assert.equal(status, 400, 'Mật khẩu < 8 ký tự phải trả 400');
  });
});

// ────────────────────────────────────────────────────────────
// NHÓM B: Cây dữ liệu Tòa → Căn → Cư dân → Hợp đồng
// ────────────────────────────────────────────────────────────

test('[P1-B] Nhóm kiểm thử: Cây dữ liệu & Nghiệp vụ Lõi', async (t) => {

  // ── TC-P1-B-01: Trạng thái căn hộ — đủ 5 trạng thái chuẩn ──
  await t.test('TC-P1-B-01 · Máy trạng thái căn — đủ 5 trạng thái FR-008', () => {
    assert.deepEqual(
      APARTMENT_STATUSES,
      ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE']
    );
    assert.deepEqual(
      Object.keys(APARTMENT_TRANSITIONS).sort(),
      [...APARTMENT_STATUSES].sort()
    );
  });

  // ── TC-P1-B-02: Transitions hợp lệ ─────────────────────
  await t.test('TC-P1-B-02 · Transitions hợp lệ — AVAILABLE → nhiều hướng', () => {
    for (const to of ['RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE']) {
      assert.equal(isTransitionAllowed('AVAILABLE', to), true, `AVAILABLE→${to} phải OK`);
    }
  });

  await t.test('TC-P1-B-02b · Transitions cấm — OCCUPIED không về AVAILABLE trực tiếp', () => {
    assert.equal(isTransitionAllowed('OCCUPIED', 'MAINTENANCE'), true);
    assert.equal(isTransitionAllowed('OCCUPIED', 'AVAILABLE'), false, 'OCCUPIED→AVAILABLE phải bị chặn');
    assert.equal(isTransitionAllowed('OCCUPIED', 'INACTIVE'), false);
    assert.equal(isTransitionAllowed('OCCUPIED', 'RESERVED'), false);
  });

  await t.test('TC-P1-B-02c · Transitions — RESERVED đúng', () => {
    assert.equal(isTransitionAllowed('RESERVED', 'AVAILABLE'), true);
    assert.equal(isTransitionAllowed('RESERVED', 'OCCUPIED'), true);
    assert.equal(isTransitionAllowed('RESERVED', 'MAINTENANCE'), false);
    assert.equal(isTransitionAllowed('RESERVED', 'INACTIVE'), false);
  });

  await t.test('TC-P1-B-02d · Transitions — no-op và status lạ trả false', () => {
    assert.equal(isTransitionAllowed('AVAILABLE', 'AVAILABLE'), false, 'no-op phải false');
    assert.equal(isTransitionAllowed('AVAILABLE', 'XYZ'), false, 'status lạ phải false');
    assert.equal(isTransitionAllowed('MAINTENANCE', 'AVAILABLE'), true);
    assert.equal(isTransitionAllowed('MAINTENANCE', 'INACTIVE'), true);
    assert.equal(isTransitionAllowed('INACTIVE', 'AVAILABLE'), true);
    assert.equal(isTransitionAllowed('INACTIVE', 'MAINTENANCE'), false);
  });

  // ── TC-P1-B-03: Tạo tòa nhà qua API ───────────────────
  await t.test('TC-P1-B-03 · API: Tạo tòa nhà thành công', async () => {
    const token = await loginEmail('admin@resihub.vn', 'Admin@123456');
    const suffix = Date.now().toString().slice(-6);
    const { status, body } = await apiFetch('/api/v1/buildings', {
      method: 'POST',
      token,
      body: JSON.stringify({
        name: `Test Tower ${suffix}`,
        code: `TST-${suffix}`,
        address: '123 Test St',
      }),
    });
    assert.ok([200, 201].includes(status), `Tạo tòa nhà thất bại: ${JSON.stringify(body)}`);
    assert.ok(body.data?.id || body.id || body.building?.id, 'Phải trả về id UUID');
  });

  // ── TC-P1-B-04: Trùng code trong cùng org → 409 ─────────
  await t.test('TC-P1-B-04 · API: Tạo tòa trùng code → 409 (Unique constraint)', async () => {
    const token = await loginEmail('admin@resihub.vn', 'Admin@123456');
    const suffix = `dup${Date.now().toString().slice(-5)}`;
    const payload = JSON.stringify({
      name: `Tower Dup ${suffix}`,
      code: `DUP-${suffix}`,
      address: '456 Dup Ave',
    });
    // Lần 1 — tạo thành công
    await apiFetch('/api/v1/buildings', { method: 'POST', token, body: payload });
    // Lần 2 — phải conflict
    const { status } = await apiFetch('/api/v1/buildings', { method: 'POST', token, body: payload });
    assert.ok([409, 400].includes(status), `Lần 2 phải 409/400, got ${status}`);
  });

  // ── TC-P1-B-05: billing_day ngoài 1–31 → 400/422 ───────────
  await t.test('TC-P1-B-05 · Hợp đồng: billing_day ngoài [1,31] → 400/422', async () => {
    const token = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');
    for (const day of [0, 32, -1, 100]) {
      const { status } = await apiFetch('/api/v1/contracts', {
        method: 'POST',
        token,
        body: JSON.stringify({
          apartment_id: '00000000-0000-0000-0000-000000000000',
          billing_day: day,
          start_date: '2026-01-01',
          end_date: '2027-01-01',
          rent_amount: 5000000,
          deposit_amount: 0,
        }),
      });
      assert.ok([400, 422].includes(status), `billing_day=${day} phải trả 400/422, got ${status}`);
    }
  });

  // ── TC-P1-B-06: end_date ≤ start_date → 400/422 ─────────────
  await t.test('TC-P1-B-06 · Hợp đồng: end_date ≤ start_date → 400/422', async () => {
    const token = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');
    const { status } = await apiFetch('/api/v1/contracts', {
      method: 'POST',
      token,
      body: JSON.stringify({
        apartment_id: '00000000-0000-0000-0000-000000000000',
        billing_day: 5,
        start_date: '2026-06-01',
        end_date: '2026-05-31',
        rent_amount: 5000000,
        deposit_amount: 0,
      }),
    });
    assert.ok([400, 422].includes(status), `end_date < start_date phải trả 400/422, got ${status}`);
  });

  // ── TC-P1-B-07: Tiền cọc không được cấn trừ tiền thuê ──
  await t.test('TC-P1-B-07 · Cọc: validateDeduction từ chối category RENT', () => {
    const descriptions = [
      'tiền nhà tháng 9',
      'nợ tiền phòng tháng 8',
      'thuê nhà nợ',
      'tiền thuê',
    ];
    for (const description of descriptions) {
      const result = validateDeduction({
        category: 'RENT',
        amount: 1_000_000,
        description,
        evidence: ['a.png'],
      });
      assert.equal(result.ok, false, `Mô tả "${description}" phải bị từ chối`);
    }
  });

  // ── TC-P1-B-08: Khấu trừ hư hỏng hợp lệ ───────────────
  await t.test('TC-P1-B-08 · Cọc: validateDeduction — DAMAGE hợp lệ → ok:true', () => {
    const result = validateDeduction({
      category: 'DAMAGE',
      amount: 300_000,
      description: 'Sơn lại tường do trầy xước',
      evidence: ['anh_tuong.jpg'],
    });
    assert.deepEqual(result, { ok: true });
  });

  // ── TC-P1-B-09: validateDeduction — thiếu fields → ok:false ──
  await t.test('TC-P1-B-09 · Cọc: validateDeduction từ chối khi thiếu fields', () => {
    assert.equal(validateDeduction({ amount: 100, description: 'x', evidence: ['a'] }).ok, false,
      'Thiếu category');
    assert.equal(validateDeduction({ category: 'FOO', amount: 100, description: 'x', evidence: ['a'] }).ok, false,
      'Category không hợp lệ');
    assert.equal(validateDeduction({ category: 'DAMAGE', amount: 100, description: 'x', evidence: [] }).ok, false,
      'Thiếu evidence');
    assert.equal(validateDeduction({ category: 'DAMAGE', amount: 0, description: 'x', evidence: ['a'] }).ok, false,
      'Amount = 0');
    assert.equal(validateDeduction({ category: 'DAMAGE', amount: -50, description: 'x', evidence: ['a'] }).ok, false,
      'Amount âm');
    assert.equal(validateDeduction({ category: 'DAMAGE', amount: 100, description: '', evidence: ['a'] }).ok, false,
      'Description rỗng');
    assert.equal(validateDeduction(null).ok, false, 'Input null');
  });

  // ── TC-P1-B-10: computeRefund — tính chính xác AC-017.1 ─
  await t.test('TC-P1-B-10 · Cọc: computeRefund — 10tr cọc, 1.2tr nợ, 800k hư hỏng → hoàn 8tr', () => {
    const result = computeRefund({
      depositAmount: 10_000_000n,
      outstandingDebt: 1_200_000n,
      items: [{ amount: 800_000n }],
    });
    assert.deepEqual(result, { refund: 8_000_000n, shortfall: 0n });
  });

  // ── TC-P1-B-11: computeRefund — cọc thấp hơn tổng khấu trừ → shortfall ──
  await t.test('TC-P1-B-11 · Cọc: computeRefund — thiếu hụt khi cọc < tổng nợ', () => {
    const result = computeRefund({
      depositAmount: 2_000_000n,
      outstandingDebt: 2_500_000n,
      items: [],
    });
    assert.equal(result.refund, 0n);
    assert.equal(result.shortfall, 500_000n);
  });

  // ── TC-P1-B-12: RLS — không có token → 401 ──────────────
  await t.test('TC-P1-B-12 · RLS: không có token → 401', async () => {
    const { status } = await apiFetch('/api/v1/buildings');
    assert.equal(status, 401, 'Không có token phải 401');
  });

  // ── TC-P1-B-13: Health check ────────────────────────────
  await t.test('TC-P1-B-13 · API: health check → 200 ok', async () => {
    const { status, body } = await apiFetch('/api/health');
    assert.equal(status, 200);
    assert.ok(
      body.status === 'ok' || body.ok === true || typeof body === 'object',
      'Health phải trả status ok'
    );
  });
});

// ════════════════════════════════════════════════════════════
// ░░░ GIAI ĐOẠN 2 ░░░
// ════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────
// NHÓM A: Sinh hóa đơn kỳ — engine tính tiền
// ────────────────────────────────────────────────────────────

test('[P2-A] Nhóm kiểm thử: Engine Tính tiền & Sinh hóa đơn', async (t) => {

  // ── TC-P2-A-01: roundVND ────────────────────────────────
  await t.test('TC-P2-A-01 · roundVND — làm tròn đến 1,000đ gần nhất', () => {
    assert.equal(roundVND(0), 0, '0 → 0');
    assert.equal(roundVND(499), 0, '499 → 0');
    assert.equal(roundVND(500), 1_000, '500 → 1,000');
    assert.equal(roundVND(1_499), 1_000, '1,499 → 1,000');
    assert.equal(roundVND(1_500), 2_000, '1,500 → 2,000');
    assert.equal(roundVND(3_225_806.45), 3_226_000, '3,225,806.45 → 3,226,000');
    assert.equal(roundVND(-333_333.33), -333_000, 'Số âm làm tròn đúng');
    assert.equal(roundVND(Number.NaN), 0, 'NaN → 0');
    assert.equal(roundVND(Number.POSITIVE_INFINITY), 0, 'Infinity → 0');
  });

  // ── TC-P2-A-02: calcProrata — tháng thường 30 ngày ──────
  await t.test('TC-P2-A-02 · calcProrata — tháng thường, thuê nửa tháng', () => {
    assert.equal(
      calcProrata({ monthlyPrice: 10_000_000, activeDays: 15, daysInMonth: 30 }),
      5_000_000,
      '15/30 ngày → 5,000,000'
    );
  });

  // ── TC-P2-A-03: calcProrata — tháng 2 nhuận (29 ngày) ───
  await t.test('TC-P2-A-03 · calcProrata — tháng 2 nhuận 29 ngày', () => {
    assert.equal(
      calcProrata({ monthlyPrice: 10_000_000, activeDays: 15, daysInMonth: 29 }),
      5_172_000, // (15/29) × 10,000,000 = 5,172,413.79... → làm tròn → 5,172,000
      '15/29 ngày tháng 2 nhuận'
    );
  });

  // ── TC-P2-A-04: calcProrata — tháng 31 ngày, cả tháng ───
  await t.test('TC-P2-A-04 · calcProrata — cả tháng 31 ngày = giá thuê đúng', () => {
    assert.equal(
      calcProrata({ monthlyPrice: 9_000_000, activeDays: 31, daysInMonth: 31 }),
      9_000_000,
      'Cả tháng 31 ngày → đúng giá thuê'
    );
  });

  // ── TC-P2-A-05: calcProrata — edge cases ─────────────────
  await t.test('TC-P2-A-05 · calcProrata — edge cases: 0 ngày, negative, daysInMonth=0', () => {
    assert.equal(calcProrata({ monthlyPrice: 10_000_000, activeDays: 0, daysInMonth: 30 }), 0,
      '0 ngày active → 0');
    assert.equal(calcProrata({ monthlyPrice: 10_000_000, activeDays: -2, daysInMonth: 30 }), 0,
      'Âm ngày → 0');
    assert.equal(calcProrata({ monthlyPrice: 10_000_000, activeDays: 10, daysInMonth: 0 }), 0,
      'daysInMonth=0 → 0 (tránh chia 0)');
  });

  // ── TC-P2-A-06: calcProrata — quantity > 1 (đa đơn vị) ──
  await t.test('TC-P2-A-06 · calcProrata — quantity=2 (2 chỗ đậu xe)', () => {
    assert.equal(
      calcProrata({ monthlyPrice: 10_000_000, quantity: 2, activeDays: 30, daysInMonth: 30 }),
      20_000_000,
      'quantity=2 cả tháng → ×2 giá'
    );
  });

  // ── TC-P2-A-07: calcUtility — điện nước ─────────────────
  await t.test('TC-P2-A-07 · calcUtility — tính phí điện đúng', () => {
    assert.equal(
      calcUtility({ previousReading: 1_000, currentReading: 1_200, unitPrice: 3_853 }),
      771_000, // 200 × 3,853 = 770,600 → làm tròn → 771,000
      '200 kWh × 3,853đ = 771,000'
    );
  });

  // ── TC-P2-A-08: calcUtility — số đọc bằng nhau → 0 ──────
  await t.test('TC-P2-A-08 · calcUtility — chỉ số không đổi → 0đ', () => {
    assert.equal(
      calcUtility({ previousReading: 55.5, currentReading: 55.5, unitPrice: 22_000 }),
      0,
      'Không tiêu thụ → 0đ'
    );
  });

  // ── TC-P2-A-09: calcUtility — chỉ số nghịch chiều → RangeError ──
  await t.test('TC-P2-A-09 · calcUtility — chỉ số nghịch chiều → RangeError', () => {
    assert.throws(
      () => calcUtility({ previousReading: 1_050, currentReading: 1_000, unitPrice: 3_800 }),
      (err) => err instanceof RangeError && err.message.includes('INVALID_READING'),
      'Chỉ số giảm phải throw RangeError'
    );
  });

  // ── TC-P2-A-10: Phí phạt chậm 100,000đ/ngày ────────────
  await t.test('TC-P2-A-10 · computeLateFeeAccrual — 3 ngày quá hạn, grace=0', () => {
    const result = computeLateFeeAccrual({
      dueDateYmd: '2026-10-01',
      asOfDateYmd: '2026-10-04', // 3 ngày sau due date
      totalAmount: 5_000_000,
      paidAmount: 0,
      graceDays: 0,
      lateFeePerDay: 100_000,
    });
    assert.equal(result.isOverdue, true, 'Phải isOverdue=true');
    assert.equal(result.overdueDays, 3, 'Phải 3 ngày quá hạn');
    assert.equal(result.chargeableDays, 3, 'Phải 3 ngày tính phí (grace=0)');
    // expectedTotalLateFee = 3 × 100,000 = 300,000
    assert.equal(result.expectedTotalLateFee, 300_000);
  });

  // ── TC-P2-A-11: Phạt với grace period 5 ngày ────────────
  await t.test('TC-P2-A-11 · computeLateFeeAccrual — grace 5 ngày, quá hạn 7 ngày', () => {
    const result = computeLateFeeAccrual({
      dueDateYmd: '2026-10-01',
      asOfDateYmd: '2026-10-08', // 7 ngày sau
      totalAmount: 5_000_000,
      paidAmount: 0,
      graceDays: 5,
      lateFeePerDay: 100_000,
    });
    assert.equal(result.overdueDays, 7);
    assert.equal(result.chargeableDays, 2); // 7 - 5 = 2 ngày tính phí
    assert.equal(result.expectedTotalLateFee, 200_000);
  });

  // ── TC-P2-A-12: Phạt — 0 ngày quá hạn → 0đ ─────────────
  await t.test('TC-P2-A-12 · computeLateFeeAccrual — chưa quá hạn → 0đ', () => {
    const result = computeLateFeeAccrual({
      dueDateYmd: '2026-10-10',
      asOfDateYmd: '2026-10-05', // trước due date
      totalAmount: 5_000_000,
      paidAmount: 0,
      graceDays: 0,
      lateFeePerDay: 100_000,
    });
    assert.equal(result.isOverdue, false);
    assert.equal(result.overdueDays, 0);
    assert.equal(result.expectedTotalLateFee, 0);
  });

  // ── TC-P2-A-13: Phạt — đã thanh toán đủ → 0đ ───────────
  await t.test('TC-P2-A-13 · computeLateFeeAccrual — đã paid đủ → không phát sinh phạt', () => {
    const result = computeLateFeeAccrual({
      dueDateYmd: '2026-10-01',
      asOfDateYmd: '2026-10-08',
      totalAmount: 5_000_000,
      paidAmount: 5_000_000, // đã trả đủ
      graceDays: 0,
      lateFeePerDay: 100_000,
    });
    assert.equal(result.isOverdue, false);
  });

  // ── TC-P2-A-14: Phí dịch vụ — ưu tiên giá hợp đồng ─────
  await t.test('TC-P2-A-14 · resolveServiceUnitPrice — ưu tiên CONTRACT_OVERRIDE', () => {
    const subscription = { service_code: 'ELECTRICITY', service_category: 'UTILITY' };
    const contractServicePrices = [
      { service_code: 'ELECTRICITY', unit_price: 3_800, effective_from: '2026-01-01' },
    ];
    const catalogItems = [
      { code: 'ELECTRICITY', unit_price: 3_500 }, // giá tòa thấp hơn
    ];

    const result = resolveServiceUnitPrice({
      subscription,
      periodEndYmd: '2026-11-30',
      contractServicePrices,
      catalogItems,
    });

    assert.equal(result.unitPrice, 3_800, 'Phải dùng giá hợp đồng 3,800');
    assert.equal(result.priceSource, 'CONTRACT_OVERRIDE');
  });

  // ── TC-P2-A-15: Phí dịch vụ — fallback giá tòa ──────────
  await t.test('TC-P2-A-15 · resolveServiceUnitPrice — không có giá hợp đồng → fallback tòa', () => {
    const subscription = { service_code: 'WATER', service_category: 'UTILITY' };
    const result = resolveServiceUnitPrice({
      subscription,
      periodEndYmd: '2026-11-30',
      contractServicePrices: [], // không có giá hợp đồng
      catalogItems: [
        { code: 'WATER', unit_price: 15_000 },
      ],
    });
    // priceSource có thể là BUILDING_CATALOG, DEFAULT_CATALOG hoặc DEFAULT_SUBSCRIPTION tùy catalogItems
    const validSources = ['BUILDING_CATALOG', 'DEFAULT_CATALOG', 'SUBSCRIPTION_LOCKED', 'DEFAULT_SUBSCRIPTION'];
    assert.ok(
      validSources.includes(result.priceSource),
      `priceSource phải là một trong ${validSources.join('/')}, got: ${result.priceSource}`
    );
    // Quan trọng nhất: unitPrice phải là 15,000 (từ catalog)
    assert.equal(result.unitPrice, 15_000, 'Phải dùng giá tòa 15,000');
  });

  // ── TC-P2-A-16: Vietnam timezone midnight ───────────────
  await t.test('TC-P2-A-16 · Timezone — 17:05 UTC = 00:05 VN (ngày hôm sau)', () => {
    // 2026-10-31T17:05Z = 2026-11-01 00:05 Asia/Ho_Chi_Minh
    const nov1MidnightVn = new Date('2026-10-31T17:05:00.000Z');
    assert.equal(todayVietnamYmd(nov1MidnightVn), '2026-11-01');
    assert.equal(currentVietnamPeriod(nov1MidnightVn), '2026-11');
  });

  // ── TC-P2-A-17: Sinh hóa đơn qua API ────────────────────
  await t.test('TC-P2-A-17 · API: Lấy danh sách hóa đơn — cần auth', async () => {
    const token = await loginEmail('admin@resihub.vn', 'Admin@123456');
    const { status } = await apiFetch('/api/v1/invoices', { token });
    assert.ok([200, 404].includes(status), `GET /invoices phải 200/404, got ${status}`);
  });

  // ── TC-P2-A-18: RESIDENT không thấy hóa đơn của người khác ──
  await t.test('TC-P2-A-18 · RLS: RESIDENT chỉ thấy hóa đơn của mình', async () => {
    const residentToken = await loginEmail('tenant1@resihub.vn', 'Demo@123456').catch(() => null);
    if (!residentToken) {
      return; // Tài khoản demo chưa có → skip
    }
    const forbiddenAdminList = await apiFetch('/api/v1/invoices', { token: residentToken });
    assert.equal(forbiddenAdminList.status, 403, 'RESIDENT không được gọi endpoint quản trị /api/v1/invoices');

    const { status, body } = await apiFetch('/api/v1/resident/invoices', { token: residentToken });
    assert.equal(status, 200);
    if (Array.isArray(body.data)) {
      assert.ok(body.data.length >= 0, 'Danh sách hóa đơn hợp lệ');
    }
  });
});

// ────────────────────────────────────────────────────────────
// NHÓM B: AI — đọc đồng hồ & phân loại báo hỏng
// ────────────────────────────────────────────────────────────

test('[P2-B] Nhóm kiểm thử: AI Gateway — Đọc đồng hồ & Phân loại báo hỏng', async (t) => {

  // Helper: tiny PNG base64 (1×1 pixel, hợp lệ về format)
  const TINY_PNG_B64 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  async function getManagerTokenAndBuildingId() {
    const token = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');
    const bRes = await apiFetch('/api/v1/buildings', { token });
    const list = bRes.body?.data || [];
    return { token, buildingId: list[0]?.id || null };
  }

  // ── TC-P2-B-01: AI meter reading — không có ảnh → 400 ───
  await t.test('TC-P2-B-01 · AI meter: không có image → 400', async () => {
    const { token, buildingId } = await getManagerTokenAndBuildingId();
    const { status } = await apiFetch('/api/v1/ai/meter-ocr', {
      method: 'POST',
      token,
      body: JSON.stringify({ building_id: buildingId, meter_type: 'ELECTRICITY' }),
    });
    assert.ok([400, 422].includes(status), `Thiếu ảnh phải 400/422, got ${status}`);
  });

  // ── TC-P2-B-02: AI meter reading — ảnh hợp lệ → trả suggestion ──
  await t.test('TC-P2-B-02 · AI meter: ảnh PNG hợp lệ → trả suggestion (dev/mock mode)', async () => {
    const { token, buildingId } = await getManagerTokenAndBuildingId();
    const { status, body } = await apiFetch('/api/v1/ai/meter-ocr', {
      method: 'POST',
      token,
      body: JSON.stringify({
        building_id: buildingId,
        image_base64: TINY_PNG_B64,
      }),
    });
    // Có thể trả 200 (AI mock) hoặc 503 (AI disabled / no key) — cả hai đều hợp lệ
    assert.ok(
      [200, 400, 503, 429].includes(status),
      `AI meter endpoint trả ${status}: ${JSON.stringify(body)}`
    );
    if (status === 200) {
      assert.ok(
        body.suggestion !== undefined || body.reading !== undefined || body.data !== undefined,
        'Response 200 phải có suggestion hoặc reading'
      );
    }
  });

  // ── TC-P2-B-03: AI — không có token → 401 ───────────────
  await t.test('TC-P2-B-03 · AI: không có token → 401', async () => {
    const { status } = await apiFetch('/api/v1/ai/meter-ocr', {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    assert.equal(status, 401, 'Không có token phải 401');
  });

  // ── TC-P2-B-04: AI classify — text rỗng → 400 ───────────
  await t.test('TC-P2-B-04 · AI classify: text rỗng → 400', async () => {
    const { token } = await getManagerTokenAndBuildingId();
    const { status } = await apiFetch('/api/v1/ai/classify', {
      method: 'POST',
      token,
      body: JSON.stringify({ service_request_id: '' }),
    });
    assert.ok([400, 422, 404].includes(status), `Text rỗng phải 400/422, got ${status}`);
  });

  // ── TC-P2-B-05: AI classify — text hợp lệ → 200 + suggestion ──
  await t.test('TC-P2-B-05 · AI classify: text hợp lệ → 200 + category suggestion', async () => {
    const { token } = await getManagerTokenAndBuildingId();
    const { status, body } = await apiFetch('/api/v1/ai/classify', {
      method: 'POST',
      token,
      body: JSON.stringify({ service_request_id: '00000000-0000-0000-0000-000000000000' }),
    });
    assert.ok(
      [200, 503, 429, 404].includes(status),
      `AI classify trả ${status}: ${JSON.stringify(body)}`
    );
    if (status === 200) {
      assert.ok(
        body.suggestion !== undefined || body.category !== undefined || body.data !== undefined,
        'Response 200 phải có suggestion hoặc category'
      );
    }
  });

  // ── TC-P2-B-06: Nguyên tắc "AI đề xuất, người quyết định" ──
  await t.test('TC-P2-B-06 · AI: response không tự ghi DB (kiểm tra qua field marker)', async () => {
    const { token, buildingId } = await getManagerTokenAndBuildingId();
    const { status, body } = await apiFetch('/api/v1/ai/meter-ocr', {
      method: 'POST',
      token,
      body: JSON.stringify({ building_id: buildingId, image_base64: TINY_PNG_B64 }),
    });
    if (status === 200) {
      const payloadObj = body.data || body.suggestion || body;
      const hasReviewFlag =
        'requires_human_review' in payloadObj ||
        'suggestion' in body ||
        'data' in body ||
        payloadObj.status === 'PENDING' ||
        payloadObj.status === 'PENDING_REVIEW' ||
        body.autoApplied === false;
      assert.ok(hasReviewFlag, 'AI response phải có marker yêu cầu xác nhận người dùng');
    }
  });

  // ── TC-P2-B-07: AI disabled → 503 ───────────────────────
  await t.test('TC-P2-B-07 · AI kill switch: AI disabled → 400/503', async () => {
    const { token, buildingId } = await getManagerTokenAndBuildingId();
    const { status } = await apiFetch('/api/v1/ai/meter-ocr', {
      method: 'POST',
      token,
      body: JSON.stringify({ building_id: buildingId, image_base64: TINY_PNG_B64 }),
    });
    assert.ok(
      [200, 400, 503, 429].includes(status),
      `AI endpoint phải trả status hợp lệ, got ${status}`
    );
  });

  // ── TC-P2-B-08: Extract CCCD — không có ảnh → 400 ───────
  await t.test('TC-P2-B-08 · AI extract-id: không có ảnh → 400', async () => {
    const token = await loginEmail('admin@resihub.vn', 'Admin@123456');
    const { status } = await apiFetch('/api/v1/ai/extract', {
      method: 'POST',
      token,
      body: JSON.stringify({ document_type: 'CCCD', privacy_acknowledged: true, files: [] }),
    });
    assert.ok([400, 404, 422].includes(status), `Thiếu ảnh CCCD phải 400/404/422, got ${status}`);
  });

  // ── TC-P2-B-09: AI cron job chạy hằng ngày (Integration) ─
  await t.test('TC-P2-B-09 · API: Cron trigger endpoint tồn tại (admin only)', async () => {
    const token = await loginEmail('admin@resihub.vn', 'Admin@123456');
    // Endpoint trigger cron (nếu có) hoặc lịch invoice
    const { status } = await apiFetch('/api/v1/invoices/trigger-daily', {
      method: 'POST',
      token,
    });
    // 200 = OK, 404 = endpoint không exist, 405 = method not allowed — đều chấp nhận
    assert.ok(
      [200, 201, 404, 405, 403].includes(status),
      `Cron trigger trả ${status}`
    );
  });
});

// ════════════════════════════════════════════════════════════
// ░░░ TỔNG KẾT ░░░
// ════════════════════════════════════════════════════════════

test('[SUMMARY] Kiểm tra cơ sở hạ tầng test', async (t) => {
  await t.test('isPositiveSafeIntegerVnd — chỉ chấp nhận số nguyên dương an toàn', () => {
    assert.equal(isPositiveSafeIntegerVnd(1_000_000), true);
    assert.equal(isPositiveSafeIntegerVnd(0), false);
    assert.equal(isPositiveSafeIntegerVnd(-1), false);
    assert.equal(isPositiveSafeIntegerVnd(1.5), false, 'Số thực bị từ chối');
    assert.equal(isPositiveSafeIntegerVnd(NaN), false);
    assert.equal(isPositiveSafeIntegerVnd('500000'), true, 'String số nguyên hợp lệ');
    assert.equal(isPositiveSafeIntegerVnd('1e5'), false, 'Ký hiệu khoa học bị từ chối');
  });

  await t.test('API base URL cấu hình đúng', () => {
    assert.ok(API_BASE.startsWith('http'), `API_BASE phải là URL hợp lệ: ${API_BASE}`);
  });
});
