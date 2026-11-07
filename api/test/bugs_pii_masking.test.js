/**
 * BUG-HUNT Tests: piiMask.js
 * Mục đích: TÌM LỖI trong logic masking, không verify happy path.
 * Chạy: node --test api/test/bugs_pii_masking.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  maskName,
  maskEmail,
  maskPhone,
  maskIdNumber,
  buildOwnerPreview,
  checkLookupRateLimit,
} from '../src/utils/piiMask.js';

// ─────────────────────────────────────────────
// BUG-HUNT P1 — maskPhone
// ─────────────────────────────────────────────

test('P1-01: SĐT 10 số "0901234567" → "090****567"', () => {
  assert.equal(maskPhone('0901234567'), '090****567');
});

test('P1-02: SĐT 11 số "+84901234567" → "+84****567"', () => {
  // clean = '+84901234567' (11 chars) > 6 → slice(0,3)='​+84', slice(-3)='567'
  assert.equal(maskPhone('+84901234567'), '+84****567');
});

test('P1-03: SĐT đúng 6 ký tự "123456" → boundary <= 6 → "12***"', () => {
  // BUG TIỀM NĂNG: điều kiện <= 6 bao gồm 6 ký tự
  // 6 chars → clean.slice(0,2)+'***' = '12***'
  assert.equal(maskPhone('123456'), '12***');
});

test('P1-04: SĐT 5 ký tự "12345" (<= 6) → "12***"', () => {
  // BUG: 5 chars <= 6 → branch short → '12***'
  assert.equal(maskPhone('12345'), '12***');
});

test('P1-05: SĐT rỗng "" → null', () => {
  assert.equal(maskPhone(''), null);
});

test('P1-06: SĐT null → null', () => {
  // String(null) = 'null' → trim = 'null' (4 ký tự, <= 6) → 'nu***' ???
  // BUG TIỀM NĂNG: null không được trả về null vì String(null) = 'null'
  // Source: const clean = String(phone || '').trim() → phone || '' → null || '' = '' → clean='' → return null ✓
  assert.equal(maskPhone(null), null);
});

test('P1-07: SĐT undefined → null', () => {
  assert.equal(maskPhone(undefined), null);
});

test('P1-08: BUG boundary — SĐT "12345" (5 ký tự, < 6) → "12***" (2 ký tự + "***")', () => {
  // Xác nhận: 5 <= 6 đúng → slice(0,2)='12' + '***' = '12***'
  const result = maskPhone('12345');
  assert.equal(result.length, 5, 'Độ dài kết quả phải là 5 (2 + 3)');
  assert.equal(result, '12***');
});

test('P1-09: BUG boundary — SĐT "123456" (đúng 6 ký tự) → "12***" hay "123****456"?', () => {
  // Điều kiện: clean.length <= 6 → true vì 6 <= 6
  // → branch ngắn: '12***' (KHÔNG phải '123****456')
  const result = maskPhone('123456');
  assert.equal(result, '12***', 'BUG: 6 ký tự phải dùng branch ngắn <= 6');
  // Nếu bị lỗi off-by-one (< 6 thay vì <= 6), sẽ ra '123****456'
  assert.notEqual(result, '123****456', 'BUG OFF-BY-ONE: không được dùng branch dài cho 6 ký tự');
});

test('P1-10: SĐT 7 ký tự "1234567" → "123****567"', () => {
  // 7 > 6 → branch dài: slice(0,3)+'****'+slice(-3) = '123****567'
  assert.equal(maskPhone('1234567'), '123****567');
});

// ─────────────────────────────────────────────
// BUG-HUNT P2 — maskIdNumber
// ─────────────────────────────────────────────

test('P2-01: CCCD 12 số "123456789012" → "********9012" (8 dấu * + 4 cuối)', () => {
  // max(4, 12-4) = max(4,8) = 8 → '********' + '9012'
  assert.equal(maskIdNumber('123456789012'), '********9012');
});

test('P2-02: CMND 9 số "123456789" → "*****6789" (5 dấu * + 4 cuối)', () => {
  // max(4, 9-4) = max(4,5) = 5 → '*****' + '6789'
  assert.equal(maskIdNumber('123456789'), '*****6789');
});

test('P2-03: CCCD đúng 4 ký tự "1234" (boundary <= 4) → "****1234"', () => {
  // <= 4 → '****' + clean = '****1234'
  assert.equal(maskIdNumber('1234'), '****1234');
});

test('P2-04: CCCD 3 ký tự "123" (<= 4) → "****123"', () => {
  // <= 4 → '****' + '123' = '****123'
  assert.equal(maskIdNumber('123'), '****123');
});

test('P2-05: CCCD rỗng "" → null', () => {
  assert.equal(maskIdNumber(''), null);
});

test('P2-06: CCCD null → null', () => {
  // String(null || '') = '' → clean='' → return null ✓
  assert.equal(maskIdNumber(null), null);
});

test('P2-07: BUG — CCCD "12345" (5 ký tự) → "****2345" (max(4,1)=4 dấu *)', () => {
  // 5 > 4 → branch dài: max(4, 5-4)=max(4,1)=4 → '****' + slice(-4)='2345'
  // → '****2345'
  const result = maskIdNumber('12345');
  assert.equal(result, '****2345', 'BUG: 5 ký tự → 4 dấu * + 4 cuối = "****2345"');
  // Kiểm tra không bị lẫn với branch <= 4 (sẽ ra '****12345')
  assert.notEqual(result, '****12345', 'BUG: không được dùng branch <= 4 cho 5 ký tự');
});

test('P2-08: BUG — số dấu * cho "12345" phải là 4 (không phải 1)', () => {
  // max(4, 5-4) = max(4,1) = 4 → đúng là 4 dấu *
  const result = maskIdNumber('12345');
  const stars = result.match(/^\*+/)?.[0].length ?? 0;
  assert.equal(stars, 4, `BUG: phải có 4 dấu *, thực tế: ${stars}`);
});

// ─────────────────────────────────────────────
// BUG-HUNT P3 — maskName
// ─────────────────────────────────────────────

test('P3-01: 1 từ "Minh" → "M***"', () => {
  // parts.length=1 → parts[0].slice(0,1)+'***' = 'M***'
  assert.equal(maskName('Minh'), 'M***');
});

test('P3-02: 2 từ "Nguyen Minh" → "Nguyen M***"', () => {
  // parts.length=2 → parts[0]+' '+parts[1].slice(0,1)+'***'
  assert.equal(maskName('Nguyen Minh'), 'Nguyen M***');
});

test('P3-03: 3 từ "Nguyen Van Minh" → "Nguyen *** Minh"', () => {
  // parts.length=3 → parts[0]+' *** '+parts[last]
  assert.equal(maskName('Nguyen Van Minh'), 'Nguyen *** Minh');
});

test('P3-04: 4 từ "Nguyen Van Thanh Minh" → "Nguyen *** Minh"', () => {
  // parts.length=4 >= 3 → parts[0]+' *** '+parts[3]='Minh'
  assert.equal(maskName('Nguyen Van Thanh Minh'), 'Nguyen *** Minh');
});

test('P3-05: Tên rỗng "" → "***"', () => {
  assert.equal(maskName(''), '***');
});

test('P3-06: Tên null → "***"', () => {
  assert.equal(maskName(null), '***');
});

test('P3-07: Tên có nhiều khoảng trắng "A  B" → xử lý đúng → "A B***"', () => {
  // replace(/\s+/g, ' ') → 'A B' → 2 từ → 'A B***'
  assert.equal(maskName('A  B'), 'A B***');
});

test('P3-08: BUG — 1 từ: chỉ lấy 1 ký tự đầu (không phải X)', () => {
  // 'Nguyen' → 'N***' không phải 'X***' (spec mô tả X*** nhưng code lấy parts[0].slice(0,1))
  const result = maskName('Nguyen');
  assert.equal(result, 'N***', 'BUG: 1 từ phải dùng ký tự đầu thực, không phải literal "X"');
});

// ─────────────────────────────────────────────
// BUG-HUNT P4 — maskEmail
// ─────────────────────────────────────────────

test('P4-01: local 2 ký tự "ab@gmail.com" → "a***@gmail.com" (1 ký tự vì < 3)', () => {
  // local='ab' (len=2 < 3) → prefix=local.slice(0,1)='a'
  assert.equal(maskEmail('ab@gmail.com'), 'a***@gmail.com');
});

test('P4-02: local 3 ký tự "abc@gmail.com" → "ab***@gmail.com" (2 ký tự vì >= 3)', () => {
  // local='abc' (len=3 >= 3) → prefix=local.slice(0,2)='ab'
  assert.equal(maskEmail('abc@gmail.com'), 'ab***@gmail.com');
});

test('P4-03: local 1 ký tự "a@gmail.com" → "a***@gmail.com"', () => {
  // local='a' (len=1 < 3) → prefix=local.slice(0,1)='a'
  assert.equal(maskEmail('a@gmail.com'), 'a***@gmail.com');
});

test('P4-04: Không có "@" → null', () => {
  // atIdx = -1 → atIdx <= 0 → trả null... nhưng -1 <= 0 là true
  // BUG TIỀM NĂNG: điều kiện atIdx <= 0 sẽ catch cả atIdx=-1 (không có @) lẫn atIdx=0 (@ ở đầu)
  assert.equal(maskEmail('nodomain'), null);
});

test('P4-05: "@" ở đầu (atIdx=0) → null', () => {
  // atIdx=0 → atIdx <= 0 → true → return null ✓
  assert.equal(maskEmail('@gmail.com'), null);
});

test('P4-06: email rỗng "" → null', () => {
  // clean='' → !clean → return null ✓
  assert.equal(maskEmail(''), null);
});

test('P4-07: email null → null', () => {
  // String(null || '') = '' → clean='' → null ✓
  assert.equal(maskEmail(null), null);
});

test('P4-08: local dài "abcdef@test.vn" → "ab***@test.vn"', () => {
  // local='abcdef' (6 >= 3) → prefix=slice(0,2)='ab'
  assert.equal(maskEmail('abcdef@test.vn'), 'ab***@test.vn');
});

// ─────────────────────────────────────────────
// BUG-HUNT P5 — checkLookupRateLimit
// ─────────────────────────────────────────────

test('P5-01: Lần đầu gọi → allowed=true', () => {
  const map = new Map();
  const result = checkLookupRateLimit(map, 'user-1');
  assert.equal(result.allowed, true);
  assert.equal(result.retryAfterSec, 0);
});

test('P5-02: Gọi 19 lần liên tiếp → vẫn allowed=true (< maxHits=20)', () => {
  const map = new Map();
  let result;
  for (let i = 0; i < 19; i++) {
    result = checkLookupRateLimit(map, 'user-19', 20);
  }
  assert.equal(result.allowed, true, 'BUG: 19 lần phải còn allowed');
});

test('P5-03: Gọi 20 lần → lần thứ 20 vẫn allowed=true (ghi trước khi block)', () => {
  // Source: recent.length >= maxHits → block
  // Lần 1-20: recent.length=0..19 < 20 → allowed=true (ghi thêm)
  // Lần 21: recent.length=20 >= 20 → block
  const map = new Map();
  let result;
  for (let i = 0; i < 20; i++) {
    result = checkLookupRateLimit(map, 'user-20', 20);
  }
  assert.equal(result.allowed, true, 'Lần thứ 20 phải còn allowed (block từ lần 21)');
});

test('P5-04: Gọi 21 lần → lần 21 bị block (allowed=false)', () => {
  const map = new Map();
  let result;
  for (let i = 0; i < 21; i++) {
    result = checkLookupRateLimit(map, 'user-21', 20);
  }
  assert.equal(result.allowed, false, 'BUG: lần thứ 21 phải bị block');
  assert.ok(result.retryAfterSec > 0, 'BUG: retryAfterSec phải > 0 khi bị block');
});

test('P5-05: Sau window (timestamp cũ) → entries expire → allowed lại', () => {
  const map = new Map();
  const windowMs = 300_000; // 5 phút
  const now = Date.now();

  // Chèn 20 timestamp đã cũ hơn window
  const oldTimestamps = Array.from({ length: 20 }, (_, i) => now - windowMs - 1000 - i);
  map.set('user-expire', oldTimestamps);

  // Gọi mới → recent filter loại hết timestamp cũ → recent.length=0 < 20 → allowed=true
  const result = checkLookupRateLimit(map, 'user-expire', 20, windowMs);
  assert.equal(result.allowed, true, 'BUG: Sau window, entries cũ phải expire và cho phép lại');
});

test('P5-06: retryAfterSec > 0 khi bị block', () => {
  const map = new Map();
  for (let i = 0; i < 21; i++) {
    checkLookupRateLimit(map, 'retry-check', 20);
  }
  const result = checkLookupRateLimit(map, 'retry-check', 20);
  assert.equal(result.allowed, false);
  assert.ok(typeof result.retryAfterSec === 'number', 'retryAfterSec phải là number');
  assert.ok(result.retryAfterSec >= 1, `BUG: retryAfterSec=${result.retryAfterSec} phải >= 1`);
});

test('P5-07: BUG — key khác nhau không ảnh hưởng nhau', () => {
  const map = new Map();
  for (let i = 0; i < 21; i++) {
    checkLookupRateLimit(map, 'key-A', 20);
  }
  // key-B vẫn clean
  const resultB = checkLookupRateLimit(map, 'key-B', 20);
  assert.equal(resultB.allowed, true, 'BUG: key-B không được bị ảnh hưởng bởi key-A');
});

// ─────────────────────────────────────────────
// BUG-HUNT P6 — buildOwnerPreview
// ─────────────────────────────────────────────

test('P6-01: ownerRow=null → null', () => {
  assert.equal(buildOwnerPreview(null), null);
});

test('P6-02: ownerRow=undefined → null', () => {
  assert.equal(buildOwnerPreview(undefined), null);
});

test('P6-03: ownerRow không có id → null', () => {
  assert.equal(buildOwnerPreview({ full_name: 'Minh', email: 'a@b.com' }), null);
});

test('P6-04: ownerRow có id=0 (falsy) → trả object [FIXED: dùng != null]', () => {
  // FIX BP-009: code giờ dùng ownerRow.id == null (không phải !ownerRow.id)
  // id=0 → 0 != null = true → trả object bình thường
  const result = buildOwnerPreview({ id: 0, full_name: 'Minh' });
  assert.notEqual(result, null, 'FIXED: id=0 không còn bị coi là không có id');
  assert.equal(result.id, 0, 'FIXED: id=0 được giữ nguyên trong result');
});

test('P6-05: ownerRow đầy đủ → object với masked_name, masked_email, masked_phone', () => {
  const row = {
    id: 'owner-1',
    full_name: 'Nguyen Van A',
    email: 'nguyen@example.com',
    phone: '0901234567',
  };
  const result = buildOwnerPreview(row);
  assert.ok(result !== null, 'Phải trả object');
  assert.equal(result.id, 'owner-1');
  assert.ok('masked_name' in result, 'Phải có masked_name');
  assert.ok('masked_email' in result, 'Phải có masked_email');
  assert.ok('masked_phone' in result, 'Phải có masked_phone');
  assert.equal(result.masked_name, 'Nguyen *** A');
  assert.equal(result.masked_email, 'ng***@example.com');
  assert.equal(result.masked_phone, '090****567');
});

test('P6-06: ownerRow thiếu phone → masked_phone=null', () => {
  const result = buildOwnerPreview({ id: '1', full_name: 'An', email: 'an@x.vn' });
  assert.equal(result.masked_phone, null, 'Phone thiếu → maskPhone(undefined) → null');
});

test('P6-07: ownerRow thiếu email → masked_email=null', () => {
  const result = buildOwnerPreview({ id: '1', full_name: 'An', phone: '0901234567' });
  assert.equal(result.masked_email, null, 'Email thiếu → maskEmail(undefined) → null');
});
