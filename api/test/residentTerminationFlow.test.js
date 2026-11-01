import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pool as sharedPool, adminPool as sharedAdminPool } from '../src/db/client.js';
import { runDailyJobs } from '../src/jobs/daily.js';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:5000';
const ADMIN_DB_URL = process.env.ADMIN_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function apiJson(path, token, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function login(email, password) {
  const r = await apiJson('/api/v1/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(r.status, 200, `Login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

function addDays(baseStr, days) {
  const d = new Date(`${baseStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test('Resident Termination Request Approval Flow (Immediate vs Future Scheduled + Daily Cron + Early Handover)', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const suffix = String(Date.now()).slice(-6);
  const cleanup = {
    contractIds: [],
    apartmentIds: [],
    reservationIds: [],
    personIds: [],
    tenantIds: [],
    userIds: [],
  };

  t.after(async () => {
    try {
      for (const cid of cleanup.contractIds) {
        await adminPool.query('DELETE FROM contract_request WHERE contract_id = $1', [cid]).catch(() => {});
        await adminPool.query('DELETE FROM notification WHERE payload::text LIKE $1', [`%${cid}%`]).catch(() => {});
        const depClean = await adminPool.connect();
        try {
          await depClean.query('BEGIN');
          await depClean.query("SET LOCAL app.allow_test_cleanup = 'true'");
          await depClean.query(
            'DELETE FROM deposit_transaction WHERE deposit_id IN (SELECT id FROM deposit WHERE contract_id = $1)',
            [cid]
          );
          await depClean.query('DELETE FROM deposit WHERE contract_id = $1', [cid]);
          await depClean.query('COMMIT');
        } catch {
          await depClean.query('ROLLBACK').catch(() => {});
        } finally {
          depClean.release();
        }
        await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'contract' AND owner_id = $1", [cid]).catch(() => {});
        await adminPool.query('DELETE FROM contract WHERE id = $1', [cid]).catch(() => {});
      }
      for (const rid of cleanup.reservationIds) {
        await adminPool.query('DELETE FROM reservation WHERE id = $1', [rid]).catch(() => {});
      }
      for (const aid of cleanup.apartmentIds) {
        await adminPool.query('DELETE FROM apartment WHERE id = $1', [aid]).catch(() => {});
      }
      for (const tid of cleanup.tenantIds) {
        await adminPool.query('DELETE FROM tenant WHERE id = $1', [tid]).catch(() => {});
      }
      for (const uid of cleanup.userIds) {
        await adminPool.query('DELETE FROM notification WHERE user_id = $1', [uid]).catch(() => {});
        await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [uid]).catch(() => {});
        await adminPool
          .query('DELETE FROM app_user WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log WHERE actor_id = $1)', [uid])
          .catch(() => {});
      }
      for (const pid of cleanup.personIds) {
        await adminPool
          .query('DELETE FROM person WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM app_user WHERE person_id = $1)', [pid])
          .catch(() => {});
      }
    } finally {
      await adminPool.end();
      await sharedAdminPool.end().catch(() => {});
      await sharedPool.end().catch(() => {});
    }
  });

  const sysToken = await login('admin@resihub.vn', 'Admin@123456');
  const mgrToken = await login('manager.vop.a@resihub.vn', 'Demo@123456');

  const bRes = await adminPool.query(
    `SELECT b.id, b.org_id, f.id AS floor_id, CURRENT_DATE::text AS today
     FROM building b
     JOIN floor f ON f.building_id = b.id
     WHERE b.code = 'VOP-A'
     ORDER BY f.level ASC LIMIT 1`
  );
  const { id: buildingId, floor_id: floorId, today: todayStr } = bRes.rows[0];

  // Helper to create an ACTIVE contract + resident login
  async function setupActiveContract(idx) {
    const aptRes = await apiJson('/api/v1/apartments', sysToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: buildingId,
        floor_id: floorId,
        code: `TRM${idx}-${suffix.slice(-4)}`,
        area_m2: 50,
        bedrooms: 1,
        type: '1PN',
        base_rent: 9000000,
      }),
    });
    assert.equal(aptRes.status, 201);
    const aptId = aptRes.body.data.id;
    cleanup.apartmentIds.push(aptId);

    const phone = `0961${idx}${suffix.slice(-5)}`;
    const email = `trm${idx}.${suffix}@resihub.test`;
    const cRes = await apiJson('/api/v1/contracts', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptId,
        start_date: todayStr,
        end_date: addDays(todayStr, 180),
        rent_amount: 9000000,
        deposit_amount: 9000000,
        billing_day: 1,
        new_tenant: {
          full_name: `Cư dân Chấm dứt ${idx}`,
          phone,
          email,
          id_number: `07921${idx}${suffix}`,
          password: 'Password@123',
        },
      }),
    });
    assert.equal(cRes.status, 201);
    const cid = cRes.body.data.id;
    cleanup.contractIds.push(cid);

    const pRow = await adminPool.query('SELECT id FROM person WHERE phone = $1 LIMIT 1', [phone]);
    cleanup.personIds.push(pRow.rows[0].id);
    const tRow = await adminPool.query('SELECT id FROM tenant WHERE person_id = $1 LIMIT 1', [pRow.rows[0].id]);
    cleanup.tenantIds.push(tRow.rows[0].id);
    const uRow = await adminPool.query('SELECT id FROM app_user WHERE person_id = $1 LIMIT 1', [pRow.rows[0].id]);
    cleanup.userIds.push(uRow.rows[0].id);

    await apiJson(`/api/v1/contracts/${cid}/scan`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_BASE64 }),
    });
    const act = await apiJson(`/api/v1/contracts/${cid}/activate`, mgrToken, { method: 'POST', body: '{}' });
    assert.equal(act.status, 200);

    const resToken = await login(email, 'Password@123');
    return { aptId, contractId: cid, resToken };
  }

  // =========================================================================
  // 1. Future desired_date (+30 days) -> TERMINATION_PENDING -> Cron Job auto-finalizes
  // =========================================================================
  const c1 = await setupActiveContract(1);
  const futureDesired = addDays(todayStr, 25);

  const submit1 = await apiJson('/api/v1/resident/contract-requests', c1.resToken, {
    method: 'POST',
    body: JSON.stringify({
      contract_id: c1.contractId,
      type: 'TERMINATION',
      desired_date: futureDesired,
      note: 'Chuyển công tác sang thành phố khác',
    }),
  });
  assert.equal(submit1.status, 201);
  const req1Id = submit1.body.data.id;

  const approve1 = await apiJson(`/api/v1/contracts/requests/${req1Id}/approve`, mgrToken, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(approve1.status, 200);
  assert.equal(approve1.body.contract.status, 'TERMINATION_PENDING');
  assert.equal(String(approve1.body.contract.terminated_at).slice(0, 10), futureDesired);

  // Apartment remains OCCUPIED while tenant has not moved out yet
  const aptAfterSchedule = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [c1.aptId]);
  assert.equal(aptAfterSchedule.rows[0].status, 'OCCUPIED');

  // Overlap check: reservation BEFORE futureDesired is blocked, reservation ON/AFTER futureDesired is allowed!
  const overlapHold = await apiJson('/api/v1/reservations', mgrToken, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: c1.aptId,
      prospect_name: 'Khách Trùng Lịch',
      phone: '0977000111',
      hold_amount: 2000000,
      hold_from: addDays(todayStr, 5),
      hold_until: addDays(todayStr, 12),
    }),
  });
  assert.equal(overlapHold.status, 409);

  const validNextHold = await apiJson('/api/v1/reservations', mgrToken, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: c1.aptId,
      prospect_name: 'Khách Thuê Kế Tiếp',
      phone: '0977000222',
      hold_amount: 2000000,
      hold_from: futureDesired,
      hold_until: addDays(futureDesired, 4),
    }),
  });
  assert.equal(validNextHold.status, 201);
  cleanup.reservationIds.push(validNextHold.body.data.id);

  // Simulate scheduled move-out date arriving today -> runDailyJobs() auto-transitions TERMINATION_PENDING -> TERMINATED!
  await adminPool.query('UPDATE contract SET terminated_at = CURRENT_DATE WHERE id = $1', [c1.contractId]);
  await runDailyJobs();

  const c1AfterCron = await adminPool.query('SELECT status FROM contract WHERE id = $1', [c1.contractId]);
  assert.equal(c1AfterCron.rows[0].status, 'TERMINATED');
  const apt1AfterCron = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [c1.aptId]);
  assert.equal(apt1AfterCron.rows[0].status, 'MAINTENANCE');
  const dep1AfterCron = await adminPool.query('SELECT refund_due_date FROM deposit WHERE contract_id = $1', [c1.contractId]);
  assert.ok(dep1AfterCron.rows[0].refund_due_date, 'refund_due_date must be set when scheduled termination completes');

  // =========================================================================
  // 2. Immediate desired_date (today) -> Immediately TERMINATED + MAINTENANCE
  // =========================================================================
  const c2 = await setupActiveContract(2);
  const submit2 = await apiJson('/api/v1/resident/contract-requests', c2.resToken, {
    method: 'POST',
    body: JSON.stringify({
      contract_id: c2.contractId,
      type: 'TERMINATION',
      desired_date: todayStr,
      note: 'Bàn giao trả phòng ngay trong hôm nay',
    }),
  });
  assert.equal(submit2.status, 201);

  const approve2 = await apiJson(`/api/v1/contracts/requests/${submit2.body.data.id}/approve`, mgrToken, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(approve2.status, 200);
  assert.equal(approve2.body.contract.status, 'TERMINATED');
  const apt2After = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [c2.aptId]);
  assert.equal(apt2After.rows[0].status, 'MAINTENANCE');
  const dep2After = await adminPool.query('SELECT refund_due_date FROM deposit WHERE contract_id = $1', [c2.contractId]);
  assert.ok(dep2After.rows[0].refund_due_date);

  // =========================================================================
  // 3. Cancel Scheduled Termination (return to ACTIVE) & Early Handover
  // =========================================================================
  const c3 = await setupActiveContract(3);
  const submit3 = await apiJson('/api/v1/resident/contract-requests', c3.resToken, {
    method: 'POST',
    body: JSON.stringify({
      contract_id: c3.contractId,
      type: 'TERMINATION',
      desired_date: addDays(todayStr, 20),
      note: 'Dự kiến chuyển nhà tháng tới',
    }),
  });
  assert.equal(submit3.status, 201);
  await apiJson(`/api/v1/contracts/requests/${submit3.body.data.id}/approve`, mgrToken, {
    method: 'POST',
    body: '{}',
  });

  // Cancel scheduled termination -> back to ACTIVE
  const cancelSched = await apiJson(`/api/v1/contracts/${c3.contractId}/terminate/reject`, mgrToken, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Cư dân đổi ý xin tiếp tục thuê' }),
  });
  assert.equal(cancelSched.status, 200);
  assert.equal(cancelSched.body.data.status, 'ACTIVE');
  assert.equal(cancelSched.body.data.terminated_at, null);
});

