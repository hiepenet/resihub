import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5000';
const ADMIN_DB_URL =
  process.env.ADMIN_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/resihub';

const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });

async function apiFetch(path, token, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function addDaysStr(days) {
  const vnTodayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = vnTodayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

test('VietQR Bank List API & Multi-Reservation / Occupied Schedule on Apartments', async (t) => {
  const loginRes = await apiFetch('/api/v1/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email: 'manager.vop.a@resihub.vn', password: 'Demo@123456' }),
  });
  assert.equal(loginRes.status, 200);
  const mgrToken = loginRes.body.accessToken;

  const cleanup = {
    reservationIds: [],
    aptId: null,
    origAptStatus: null,
  };

  t.after(async () => {
    for (const rId of cleanup.reservationIds) {
      await adminPool.query('DELETE FROM reservation WHERE id = $1', [rId]).catch(() => {});
    }
    if (cleanup.aptId && cleanup.origAptStatus) {
      await adminPool
        .query('UPDATE apartment SET status = $2 WHERE id = $1', [cleanup.aptId, cleanup.origAptStatus])
        .catch(() => {});
    }
    await adminPool.end().catch(() => {});
  });

  await t.test('1. GET /api/v1/buildings/banks returns VietQR bank catalog with VCB & ICB', async () => {
    const unauth = await apiFetch('/api/v1/buildings/banks', null);
    assert.equal(unauth.status, 401);

    const res = await apiFetch('/api/v1/buildings/banks', mgrToken);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data), 'banks data must be an array');
    assert.ok(res.body.data.length >= 10, 'must return VietQR bank catalog');

    const vcb = res.body.data.find((b) => b.code === 'VCB' || b.bin === '970436');
    assert.ok(vcb, 'Vietcombank (VCB / 970436) must exist in bank list');
    assert.ok(vcb.shortName, 'shortName must be present');
    assert.ok(vcb.name, 'full name must be present');
  });

  await t.test('2. Apartment supports 2 non-overlapping HELD reservations & blocks overlapping ranges', async () => {
    const freeAptRes = await adminPool.query(`
      SELECT a.id, a.status, a.building_id
      FROM apartment a
      JOIN building b ON b.id = a.building_id
      WHERE b.code = 'VOP-A'
        AND a.status = 'AVAILABLE'
        AND NOT EXISTS (
          SELECT 1 FROM contract c
          WHERE c.apartment_id = a.id
            AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING', 'PENDING_APPROVAL', 'DRAFT')
        )
        AND NOT EXISTS (
          SELECT 1 FROM reservation r
          WHERE r.apartment_id = a.id AND r.status = 'HELD'
        )
      ORDER BY a.code ASC
      LIMIT 1
    `);
    assert.equal(freeAptRes.rows.length, 1);
    cleanup.aptId = freeAptRes.rows[0].id;
    cleanup.origAptStatus = freeAptRes.rows[0].status;

    // Người giữ chỗ #1: từ ngày mai -> +8 ngày
    const rsv1 = await apiFetch('/api/v1/reservations', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: cleanup.aptId,
        prospect_name: 'Khách Giữ Chỗ Số 1',
        phone: '0918000111',
        hold_amount: 2000000,
        hold_from: addDaysStr(1),
        hold_until: addDaysStr(8),
      }),
    });
    assert.equal(rsv1.status, 201);
    cleanup.reservationIds.push(rsv1.body.data.id);

    // Chồng lấn khoảng giữ chỗ (+5 -> +12) -> phải bị chặn 409 APARTMENT_NOT_AVAILABLE
    const rsvOverlap = await apiFetch('/api/v1/reservations', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: cleanup.aptId,
        prospect_name: 'Khách Chồng Lịch',
        phone: '0918000222',
        hold_amount: 2000000,
        hold_from: addDaysStr(5),
        hold_until: addDaysStr(12),
      }),
    });
    assert.equal(rsvOverlap.status, 409);
    assert.equal(rsvOverlap.body.code, 'APARTMENT_NOT_AVAILABLE');

    // Người giữ chỗ #2: khoảng thời gian nối tiếp không chồng lấn (+10 -> +22) -> THÀNH CÔNG
    const rsv2 = await apiFetch('/api/v1/reservations', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: cleanup.aptId,
        prospect_name: 'Khách Giữ Chỗ Số 2',
        phone: '0918000333',
        hold_amount: 2500000,
        hold_from: addDaysStr(10),
        hold_until: addDaysStr(22),
      }),
    });
    assert.equal(rsv2.status, 201);
    cleanup.reservationIds.push(rsv2.body.data.id);

    // GET /api/v1/apartments/:id trả về đầy đủ cả 2 phiếu giữ chỗ kèm khoảng thời gian hold_from -> hold_until
    const aptDetail = await apiFetch(`/api/v1/apartments/${cleanup.aptId}`, mgrToken);
    assert.equal(aptDetail.status, 200);
    const heldList = (aptDetail.body.data.reservations || []).filter((r) => r.status === 'HELD');
    assert.equal(heldList.length, 2, 'Phải trả về đầy đủ cả 2 người đang giữ chỗ');
    assert.equal(heldList[0].prospect_name, 'Khách Giữ Chỗ Số 1');
    assert.equal(heldList[1].prospect_name, 'Khách Giữ Chỗ Số 2');
    assert.ok(heldList[0].hold_from && heldList[0].hold_until);
    assert.ok(heldList[1].hold_from && heldList[1].hold_until);
  });
});

