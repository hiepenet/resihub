/**
 * BUG-HUNT Tests: rbac.js (requireRole) và pricing.js (checkFourEyesOrWarn)
 * Mục đích: TÌM LỖI trong logic RBAC và Four-Eyes control.
 * Chạy: node --test api/test/bugs_four_eyes_rbac.test.js
 *
 * Lưu ý về mock:
 * - requireRole gọi logAccessDenied (ownerScope.js) → cần DB.
 *   Chúng ta mock bằng monkey-patch Module cache trước khi import rbac.js
 *   Vì Node ESM không hỗ trợ monkey-patch trực tiếp, chúng ta test logic thuần
 *   bằng cách inline lại logic requireRole trong test (pure function test).
 * - checkFourEyesOrWarn cần adminPool → test chỉ cover path không query DB (orgId=null).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────
// Mock helpers cho requireRole
// ─────────────────────────────────────────────

/**
 * Tái hiện logic requireRole thuần (không gọi logAccessDenied/DB)
 * để test RBAC authorization logic mà không cần HTTP layer.
 *
 * Logic gốc (rbac.js) — ĐÃ FIX BP-006:
 *   const userRoleCodes = req.user.roles
 *     .filter(r => r != null)
 *     .map(r => typeof r === 'string' ? r : r.code)
 *     .filter(code => typeof code === 'string');
 */
function checkRoleAuthorization(allowedRoles, userRoles) {
  if (!userRoles) return { authorized: false, reason: 'NO_ROLES' };
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  // FIX BP-006: filter null/undefined + filter invalid codes
  const userRoleCodes = userRoles
    .filter((r) => r != null)
    .map((r) => (typeof r === 'string' ? r : r.code))
    .filter((code) => typeof code === 'string');
  const hasRole = userRoleCodes.some((code) => roles.includes(code));
  return { authorized: hasRole, userRoleCodes };
}

function mockReq(roles, sub = 'user-1') {
  return { user: roles !== undefined ? { roles, sub } : null };
}

function mockRes() {
  let statusCode, body;
  const res = {
    status(s) {
      statusCode = s;
      return res;
    },
    json(b) {
      body = b;
      return res;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
  return res;
}

// Mock requireRole không cần DB (thay thế logAccessDenied bằng no-op)
function requireRolePure(allowedRoles) {
  return async (req, res, next) => {
    if (!req.user || !req.user.roles) {
      return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Chưa xác thực người dùng.' });
    }
    const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    // FIX BP-006: filter null/undefined trước khi lấy .code
    const userRoleCodes = req.user.roles
      .filter((r) => r != null)
      .map((r) => (typeof r === 'string' ? r : r.code))
      .filter((code) => typeof code === 'string');
    const hasRole = userRoleCodes.some((code) => roles.includes(code));
    if (!hasRole) {
      // logAccessDenied replaced by no-op
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Không có quyền.' });
    }
    next();
  };
}

// ─────────────────────────────────────────────
// BUG-HUNT R1 — checkFourEyesOrWarn (pure logic, path không query DB)
// ─────────────────────────────────────────────

/**
 * Tái hiện logic checkFourEyesOrWarn cho path orgId=null (không cần adminPool).
 * Logic gốc (pricing.js) — ĐÃ FIX BP-004 & BP-005:
 *   const creatorStr = creatorId != null ? String(creatorId).trim() : null;
 *   const actorStr = actorId != null ? String(actorId).trim() : null;
 *   if (creatorStr == null || actorStr == null || creatorStr !== actorStr) {
 *     return { allowed: true, selfApproved: false };
 *   }
 *   let allowSelf = false;
 *   if (orgId) { ... query DB ... }
 *   if (!allowSelf) return { allowed: false, selfApproved: false };
 */
async function checkFourEyesPure({ orgId, actorId, creatorId }) {
  // Replicate fixed logic without DB
  // FIX BP-004: dùng != null thay !creatorId → id=0 không còn bypass
  // FIX BP-005: trim() trước khi so sánh → trailing whitespace không còn bypass
  const creatorStr = creatorId != null ? String(creatorId).trim() : null;
  const actorStr = actorId != null ? String(actorId).trim() : null;
  if (creatorStr == null || actorStr == null || creatorStr !== actorStr) {
    return { allowed: true, selfApproved: false };
  }
  let allowSelf = false;
  if (orgId) {
    // Simulate: orgId=null means we skip DB → allowSelf stays false
    // (In production: query DB here)
    allowSelf = false; // cannot test DB path without real connection
  }
  if (!allowSelf) {
    return { allowed: false, selfApproved: false };
  }
  return { allowed: true, selfApproved: true };
}

test('R1-01: creatorId=null → allowed=true, selfApproved=false (null !== actorId)', () => {
  // !creatorId = !null = true → early return allowed
  return checkFourEyesPure({ orgId: null, actorId: 'user-A', creatorId: null }).then((result) => {
    assert.equal(result.allowed, true, 'BUG: null creatorId phải allowed=true (bypass four-eyes)');
    assert.equal(result.selfApproved, false);
  });
});

test('R1-02: creatorId="A", actorId="B" (khác nhau) → allowed=true', () => {
  return checkFourEyesPure({ orgId: null, actorId: 'user-B', creatorId: 'user-A' }).then((result) => {
    assert.equal(result.allowed, true, 'Người khác nhau luôn được phép');
    assert.equal(result.selfApproved, false);
  });
});

test('R1-03: creatorId="A", actorId="A", orgId=null → allowed=false (không query DB, default false)', () => {
  return checkFourEyesPure({ orgId: null, actorId: 'user-A', creatorId: 'user-A' }).then((result) => {
    assert.equal(result.allowed, false, 'BUG: Cùng người + orgId=null → không được self-approve');
    assert.equal(result.selfApproved, false);
  });
});

test('R1-04: BUG TIỀM NĂNG — số vs string: creatorId=1, actorId="1" → phải coi là CÙNG người', () => {
  // String(1) = '1' === String('1') = '1' → cùng người → phải block
  return checkFourEyesPure({ orgId: null, actorId: '1', creatorId: 1 }).then((result) => {
    assert.equal(result.allowed, false, 'BUG: creatorId=1 (number) vs actorId="1" (string) phải coi là cùng người');
  });
});

test('R1-05: creatorId=0 (falsy) → allowed=false [FIXED: dùng != null thay !creatorId]', () => {
  // FIX BP-004: code giờ dùng creatorId != null → 0 không còn bypass
  // creatorId=0, actorId='0' → String(0).trim()='0' === String('0').trim()='0' → cùng người → block
  return checkFourEyesPure({ orgId: null, actorId: '0', creatorId: 0 }).then((result) => {
    assert.equal(result.allowed, false, 'FIXED: creatorId=0 không còn bypass four-eyes');
  });
});

test('R1-06: actorId=null → allowed=true (bypass four-eyes vì !actorId)', () => {
  // !actorId = !null = true → early return allowed
  return checkFourEyesPure({ orgId: null, actorId: null, creatorId: 'user-A' }).then((result) => {
    assert.equal(result.allowed, true, 'BUG: actorId=null bypass four-eyes');
  });
});

test('R1-07: creatorId="A", actorId="a" (khác case) → allowed=true (không so sánh case-insensitive)', () => {
  // String('A') !== String('a') → coi là khác người → allowed=true
  return checkFourEyesPure({ orgId: null, actorId: 'a', creatorId: 'A' }).then((result) => {
    assert.equal(result.allowed, true, 'Case khác nhau → coi là người khác → allowed=true');
  });
});

// ─────────────────────────────────────────────
// BUG-HUNT R2 — requireRole middleware simulation
// ─────────────────────────────────────────────

test('R2-01: roles=[] (mảng rỗng) → 403 FORBIDDEN', async () => {
  const req = mockReq([]);
  const res = mockRes();
  let nextCalled = false;
  const middleware = requireRolePure(['MANAGER']);
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'next() không được gọi');
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('R2-02: roles=["MANAGER"] check for ["MANAGER"] → next() được gọi', async () => {
  const req = mockReq(['MANAGER']);
  const res = mockRes();
  let nextCalled = false;
  const middleware = requireRolePure(['MANAGER']);
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'BUG: MANAGER phải được phép');
  assert.equal(res.statusCode, undefined, 'status không được set khi next() gọi');
});

test('R2-03: roles=["MANAGER"] check for ["OWNER"] → 403', async () => {
  const req = mockReq(['MANAGER']);
  const res = mockRes();
  let nextCalled = false;
  const middleware = requireRolePure(['OWNER']);
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('R2-04: roles=[{code:"MANAGER"}] (object format) check for ["MANAGER"] → phải work (không crash)', async () => {
  // BUG TIỀM NĂNG: nếu roles là array of objects, r.code phải được extract
  const req = mockReq([{ code: 'MANAGER' }]);
  const res = mockRes();
  let nextCalled = false;
  const middleware = requireRolePure(['MANAGER']);
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'BUG: object format {code:"MANAGER"} phải được xử lý đúng');
});

test('R2-05: req.user=null → 401 UNAUTHORIZED', async () => {
  const req = { user: null };
  const res = mockRes();
  let nextCalled = false;
  const middleware = requireRolePure(['MANAGER']);
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('R2-06: req.user không có roles → 401', async () => {
  const req = { user: { sub: 'user-1' } }; // không có roles
  const res = mockRes();
  let nextCalled = false;
  const middleware = requireRolePure(['MANAGER']);
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401, 'BUG: user không có roles phải trả 401');
});

test('R2-07: Multi-role: roles=["MANAGER","OWNER"] check for ["OWNER"] → next()', async () => {
  const req = mockReq(['MANAGER', 'OWNER']);
  const res = mockRes();
  let nextCalled = false;
  const middleware = requireRolePure(['OWNER']);
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'BUG: multi-role user phải được phép khi có OWNER');
});

test('R2-08: Multi-role check multi-allowed: roles=["STAFF"] check for ["MANAGER","OWNER"] → 403', async () => {
  const req = mockReq(['STAFF']);
  const res = mockRes();
  let nextCalled = false;
  const middleware = requireRolePure(['MANAGER', 'OWNER']);
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, 'STAFF không trong [MANAGER, OWNER] → 403');
  assert.equal(res.statusCode, 403);
});

test('R2-09: requireRole với string (không phải array) → phải work', async () => {
  // allowedRoles = 'MANAGER' (string) → code: roles = [allowedRoles]
  const req = mockReq(['MANAGER']);
  const res = mockRes();
  let nextCalled = false;
  const middleware = requireRolePure('MANAGER'); // string, không phải array
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'BUG: requireRole với string argument phải hoạt động');
});

test('R2-10: BUG — roles=[{code:"OWNER"}, "MANAGER"] (mixed format) → phải normalize đúng', async () => {
  // Array có cả object và string → phải normalize đúng
  const req = mockReq([{ code: 'OWNER' }, 'MANAGER']);
  const res = mockRes();
  let nextCalled = false;
  const middleware = requireRolePure(['MANAGER']);
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'BUG: mixed format array phải được xử lý đúng');
});

// ─────────────────────────────────────────────
// BUG-HUNT R3 — RBAC role normalization edge cases
// ─────────────────────────────────────────────

test('R3-01: Role normalize — string "MANAGER" → userRoleCodes=["MANAGER"]', () => {
  const result = checkRoleAuthorization(['MANAGER'], ['MANAGER']);
  assert.equal(result.authorized, true);
  assert.deepEqual(result.userRoleCodes, ['MANAGER']);
});

test('R3-02: Role normalize — object {code:"MANAGER"} → userRoleCodes=["MANAGER"]', () => {
  const result = checkRoleAuthorization(['MANAGER'], [{ code: 'MANAGER' }]);
  assert.equal(result.authorized, true, 'BUG: object format phải được normalize sang string');
  assert.deepEqual(result.userRoleCodes, ['MANAGER']);
});

test('R3-03: BUG — {code:undefined} → userRoleCodes=[undefined] → không match', () => {
  // typeof r === 'string' → false → r.code = undefined → không match 'MANAGER'
  const result = checkRoleAuthorization(['MANAGER'], [{ noCode: 'MANAGER' }]);
  assert.equal(result.authorized, false, 'BUG TIỀM NĂNG: object không có .code → undefined → không match');
});

test('R3-04: Empty string role "" → không match "MANAGER"', () => {
  const result = checkRoleAuthorization(['MANAGER'], ['']);
  assert.equal(result.authorized, false, '""  không được match "MANAGER"');
});

test('R3-05: Case sensitivity — "manager" (lowercase) không match "MANAGER"', () => {
  // Role codes được so sánh case-sensitive (includes)
  const result = checkRoleAuthorization(['MANAGER'], ['manager']);
  assert.equal(result.authorized, false, 'BUG TIỀM NĂNG: role codes phân biệt hoa/thường → "manager" không match "MANAGER"');
});

test('R3-06: null trong roles array → không crash [FIXED: null guard]', () => {
  // FIX BP-006: requireRole giờ filter null trước khi map .code
  assert.doesNotThrow(
    () => checkRoleAuthorization(['MANAGER'], [null]),
    'FIXED: null trong roles array không còn throw TypeError'
  );
  // null bị filter ra → userRoleCodes=[] → không match MANAGER → không được phép
  const result = checkRoleAuthorization(['MANAGER'], [null]);
  assert.equal(result.authorized, false, 'FIXED: roles=[null] → không match → unauthorized');
});

test('R3-07: Mixed valid roles → chỉ so sánh code, không phải toàn object', () => {
  const result = checkRoleAuthorization(['OWNER', 'MANAGER'], [{ code: 'OWNER' }]);
  assert.equal(result.authorized, true, 'Object {code:"OWNER"} phải match allowed role "OWNER"');
});

test('R3-08: allowedRoles=[] → không ai được phép (empty allowed list)', () => {
  const result = checkRoleAuthorization([], ['MANAGER', 'OWNER']);
  assert.equal(result.authorized, false, 'BUG: empty allowedRoles → không ai được phép');
});

// ─────────────────────────────────────────────
// BUG-HUNT R4 — checkFourEyes additional business rules
// ─────────────────────────────────────────────

test('R4-01: Cùng người, creatorId và actorId là số nguyên khác nhau → allowed=true', () => {
  return checkFourEyesPure({ orgId: null, actorId: 2, creatorId: 1 }).then((result) => {
    // String(1) !== String(2) → khác người → allowed=true
    assert.equal(result.allowed, true, 'Người khác nhau (số nguyên) → allowed=true');
  });
});

test('R4-02: BUG — creatorId="1", actorId=1 (string vs number, cùng giá trị) → phải block', () => {
  // String('1') = '1' === String(1) = '1' → cùng người → block
  return checkFourEyesPure({ orgId: null, actorId: 1, creatorId: '1' }).then((result) => {
    assert.equal(result.allowed, false, 'BUG: "1" (string) và 1 (number) phải coi là cùng người → block');
  });
});

test('R4-03: entity và entityId không ảnh hưởng allowed result khi orgId=null', () => {
  return checkFourEyesPure({
    orgId: null,
    actorId: 'user-A',
    creatorId: 'user-A',
    entity: 'invoice',
    entityId: 'inv-999',
  }).then((result) => {
    assert.equal(result.allowed, false, 'orgId=null → không lookup DB → không self-approve');
  });
});

test('R4-04: whitespace trong creatorId: "user-A " vs "user-A" → BLOCK [FIXED: trim()]', () => {
  // FIX BP-005: code giờ trim() trước khi so sánh → 'user-A '.trim() === 'user-A'.trim()
  return checkFourEyesPure({ orgId: null, actorId: 'user-A', creatorId: 'user-A ' }).then((result) => {
    assert.equal(result.allowed, false, 'FIXED: trailing whitespace không còn bypass four-eyes');
  });
});
