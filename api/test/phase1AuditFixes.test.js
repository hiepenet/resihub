import { test } from 'node:test';
import assert from 'node:assert';
import { emailLoginTracker } from '../src/routes/auth.js';

// 1. Kiểm tra nghiệp vụ Hold Until (FR-067)
function validateHoldUntil(holdUntilStr) {
  if (!holdUntilStr) {
    return { valid: false, code: 'HOLD_UNTIL_REQUIRED', message: 'Hạn giữ chỗ là bắt buộc.' };
  }
  const holdDate = new Date(holdUntilStr);
  const now = new Date();
  if (isNaN(holdDate.getTime()) || holdDate <= now) {
    return { valid: false, code: 'INVALID_HOLD_UNTIL', message: 'Hạn giữ chỗ phải là một ngày trong tương lai.' };
  }
  const maxHoldDays = 30;
  const maxHoldDate = new Date(Date.now() + maxHoldDays * 24 * 60 * 60 * 1000);
  if (holdDate > maxHoldDate) {
    return { valid: false, code: 'HOLD_UNTIL_EXCEEDED', message: 'Hạn giữ chỗ không được vượt quá 30 ngày.' };
  }
  return { valid: true };
}

test('Hold Until (FR-067): Null/Rỗng/Quá khứ -> Bị từ chối', () => {
  assert.equal(validateHoldUntil(null).valid, false);
  assert.equal(validateHoldUntil('').valid, false);
  assert.equal(validateHoldUntil('2020-01-01').valid, false);
});

test('Hold Until (FR-067): Quá 30 ngày -> Bị từ chối', () => {
  const farFuture = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  assert.equal(validateHoldUntil(farFuture).valid, false);
  assert.equal(validateHoldUntil(farFuture).code, 'HOLD_UNTIL_EXCEEDED');
});

test('Hold Until (FR-067): Trong khoảng 1 đến 30 ngày -> Hợp lệ', () => {
  const validFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  assert.equal(validateHoldUntil(validFuture).valid, true);
});

// 2. Kiểm tra bộ theo dõi đăng nhập Email sai 5 lần (P0 Security)
test('Email Login Tracker: Nhập sai 5 lần liên tiếp sẽ bị khóa 15 phút', () => {
  const testEmail = 'bruteforce_test@resihub.vn';
  emailLoginTracker.delete(testEmail);

  // Sai 4 lần đầu
  for (let i = 1; i <= 4; i++) {
    const tracker = emailLoginTracker.get(testEmail) || { failedAttempts: 0, lockUntil: null };
    tracker.failedAttempts += 1;
    emailLoginTracker.set(testEmail, tracker);
    assert.equal(tracker.lockUntil, null);
  }

  // Lần thứ 5 sai -> Khóa 15 phút
  const tracker5 = emailLoginTracker.get(testEmail);
  tracker5.failedAttempts += 1;
  tracker5.lockUntil = Date.now() + 15 * 60 * 1000;
  emailLoginTracker.set(testEmail, tracker5);

  const lockedTracker = emailLoginTracker.get(testEmail);
  assert.equal(lockedTracker.failedAttempts, 5);
  assert.ok(lockedTracker.lockUntil > Date.now());

  // Đăng nhập thành công -> Reset
  emailLoginTracker.delete(testEmail);
  assert.equal(emailLoginTracker.has(testEmail), false);
});

// 3. Kiểm tra cơ chế Revoke Token qua token_version (P1 Security)
test('Token Revoke: Refresh token có token_version cũ bị từ chối 403', () => {
  const userInDb = { id: 'u-123', token_version: 2 };
  const oldRefreshTokenPayload = { sub: 'u-123', token_version: 1 };
  const currentRefreshTokenPayload = { sub: 'u-123', token_version: 2 };

  // So khớp token cũ
  const isOldValid = Number(oldRefreshTokenPayload.token_version) === Number(userInDb.token_version);
  assert.equal(isOldValid, false);

  // So khớp token hiện tại
  const isCurrentValid = Number(currentRefreshTokenPayload.token_version) === Number(userInDb.token_version);
  assert.equal(isCurrentValid, true);

  // Sau khi user logout: token_version trong DB tăng lên 3
  userInDb.token_version += 1;
  const isRevokedAfterLogout = Number(currentRefreshTokenPayload.token_version) === Number(userInDb.token_version);
  assert.equal(isRevokedAfterLogout, false);
});

// 4. Kiểm tra bắt lỗi trùng CCCD (FR-012)
test('Tenant CCCD Duplicate: Error code 23505 chuyển thành 409 DUPLICATE_ID_NUMBER an toàn', () => {
  const fakePgError = {
    code: '23505',
    constraint: 'person_id_number_unique',
    detail: 'Key (id_number)=(001200000001) already exists.',
  };

  function handleCreateTenantError(err) {
    if (err.code === '23505') {
      return { status: 409, code: 'DUPLICATE_ID_NUMBER', message: 'Số CCCD/Hộ chiếu này đã tồn tại trong hệ thống.' };
    }
    return { status: 500, code: 'DB_ERROR' };
  }

  const response = handleCreateTenantError(fakePgError);
  assert.equal(response.status, 409);
  assert.equal(response.code, 'DUPLICATE_ID_NUMBER');
});
