import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
}
if (!process.env.APP_DATABASE_URL) {
  process.env.APP_DATABASE_URL =
    'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';
}

const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function isoDaysFromToday(offsetDays) {
  const vnTodayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = vnTodayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

test('M06 Phase 2 (Task 3) — Mandatory Apartment Handover Inspection With Photo Evidence Before Settlement', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');

  const app = express();
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      exposedHeaders: ['Idempotent-Replayed'],
    })
  );
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/v1/auth', authRoute);
  app.use('/api/v1/apartments', apartmentsRoute);
  app.use('/api/v1/contracts', contractsRoute);
  app.use('/api/v1/deposits', depositsRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  async function apiFetch(urlPath, token, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      ...(options.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${urlPath}`, { ...options, headers });
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    let body = null;
    if (contentType.includes('application/json')) {
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text };
      }
    } else {
      body = { raw: text };
    }
    return { status: res.status, headers: res.headers, contentType, body };
  }

  async function loginEmail(email, password) {
    const res = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.body)}`);
    return { token: res.body.accessToken, user: res.body.user };
  }

  const suffix = `${String(Date.now()).slice(-6)}`;
  const cleanup = {
    contractIds: [],
    apartmentIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const cId of cleanup.contractIds) {
      await adminPool.query('DELETE FROM receivable WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM notification WHERE payload::text LIKE $1', [`%${cId}%`]).catch(() => {});
      const depClean = await adminPool.connect();
      try {
        await depClean.query('BEGIN');
        await depClean.query("SET LOCAL app.allow_test_cleanup = 'true'");
        await depClean.query(
          `DELETE FROM attachment WHERE owner_entity = 'deposit' AND owner_id IN (SELECT id FROM deposit WHERE contract_id = $1)`,
          [cId]
        );
        await depClean.query(
          'DELETE FROM deposit_transaction WHERE deposit_id IN (SELECT id FROM deposit WHERE contract_id = $1)',
          [cId]
        );
        await depClean.query('DELETE FROM deposit WHERE contract_id = $1', [cId]);
        await depClean.query('COMMIT');
      } catch {
        await depClean.query('ROLLBACK').catch(() => {});
      } finally {
        depClean.release();
      }
      await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'contract' AND owner_id = $1", [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'apartment' AND owner_id = $1", [aId]).catch(() => {});
      await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
    }
    for (const tId of cleanup.tenantIds) {
      await adminPool.query('DELETE FROM tenant WHERE id = $1', [tId]).catch(() => {});
    }
    for (const uId of cleanup.userIds) {
      await adminPool.query('DELETE FROM notification WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM idempotency_key WHERE actor_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool
        .query(`DELETE FROM app_user WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log WHERE actor_id = $1)`, [uId])
        .catch(() => {});
    }
    for (const pId of cleanup.personIds) {
      await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [pId]).catch(() => {});
      await adminPool.query('DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId]).catch(() => {});
      await adminPool
        .query(`DELETE FROM app_user u WHERE u.person_id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_id = u.id)`, [pId])
        .catch(() => {});
      await adminPool
        .query(`DELETE FROM person WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM app_user WHERE person_id = $1)`, [pId])
        .catch(() => {});
    }
    await appPool.end().catch(() => {});
    await adminPool.end().catch(() => {});
  });

  const bRes = await adminPool.query(
    `SELECT b.id, b.org_id, f.id AS floor_id
     FROM building b
     JOIN floor f ON f.building_id = b.id
     WHERE b.code = 'VOP-A'
     ORDER BY f.level ASC
     LIMIT 1`
  );
  const vopAId = bRes.rows[0].id;
  const orgId = bRes.rows[0].org_id;
  const floorId = bRes.rows[0].floor_id;

  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const mgrA = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');

  const pwHash = await bcrypt.hash('Demo@123456', 10);
  const resRoleRes = await adminPool.query(
    `SELECT id FROM role WHERE org_id = $1 AND code = 'RESIDENT' LIMIT 1`,
    [orgId]
  );
  const resRoleId = resRoleRes.rows[0].id;

  async function createApt(prefix) {
    const r = await apiFetch('/api/v1/apartments', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopAId,
        floor_id: floorId,
        code: `${prefix}-${suffix}`,
        area_m2: 50,
        bedrooms: 1,
        type: '1PN',
        base_rent: 8000000,
      }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    cleanup.apartmentIds.push(r.body.data.id);
    return r.body.data;
  }

  async function createResident(tag, idx) {
    const email = `p2t3.${tag}.${suffix}@resihub.test`;
    const phone = `093${idx}${suffix}`;
    const p = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, `Cư dân ${tag} ${suffix}`, phone, email, `07931${idx}${suffix}`]
    );
    cleanup.personIds.push(p.rows[0].id);
    const tn = await adminPool.query(
      `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
      [orgId, p.rows[0].id]
    );
    cleanup.tenantIds.push(tn.rows[0].id);
    const u = await adminPool.query(
      `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [p.rows[0].id, pwHash]
    );
    cleanup.userIds.push(u.rows[0].id);
    await adminPool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [u.rows[0].id, resRoleId]);
    const auth = await loginEmail(email, 'Demo@123456');
    return { ...auth, tenantId: tn.rows[0].id };
  }

  async function setupContract({ aptId, tenantId, startOffset, endOffset, collectAmount = 5000000 }) {
    const cRes = await apiFetch('/api/v1/contracts', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptId,
        primary_tenant_id: tenantId,
        start_date: isoDaysFromToday(startOffset),
        end_date: isoDaysFromToday(endOffset),
        rent_amount: 8000000,
        deposit_amount: 8000000,
        billing_day: 5,
      }),
    });
    assert.equal(cRes.status, 201);
    const contractId = cRes.body.data.id;
    cleanup.contractIds.push(contractId);
    await apiFetch(`/api/v1/contracts/${contractId}/scan`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    const act = await apiFetch(`/api/v1/contracts/${contractId}/activate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(act.status, 200);
    const depQ = await adminPool.query('SELECT id FROM deposit WHERE contract_id = $1', [contractId]);
    await adminPool.query("UPDATE meter SET status = 'INACTIVE' WHERE apartment_id = $1", [aptId]);
    const depositId = depQ.rows[0].id;
    if (collectAmount > 0) {
      const col = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, mgrA.token, {
        method: 'POST',
        body: JSON.stringify({ type: 'collect', amount: collectAmount, method: 'CASH', description: 'Thu cọc HĐ' }),
      });
      assert.equal(col.status, 201);
    }
    return { contractId, depositId };
  }

  await t.test('P2-T3-1..3: Handover without photos vs photo-backed handover (keep_maintenance: true) precondition', async () => {
    const apt1 = await createApt('P2T3-A1');
    const res1 = await createResident('h1', '1');
    const { contractId, depositId } = await setupContract({
      aptId: apt1.id,
      tenantId: res1.tenantId,
      startOffset: -10,
      endOffset: 120,
    });

    const term = await apiFetch(`/api/v1/contracts/${contractId}/terminate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Trả phòng kiểm thử nghiệm thu ảnh' }),
    });
    assert.equal(term.status, 200);

    // 1. Before handover -> apartment_inspected === false, ready === false, submit fails 409 MISSING_APARTMENT_INSPECTION
    const pre1 = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token);
    assert.equal(pre1.status, 200);
    assert.equal(pre1.body.data.preconditions.apartment_inspected, false);
    assert.equal(pre1.body.data.preconditions.ready, false);

    const blockedSubmit = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ items: [], refund_method: 'CASH' }),
    });
    assert.equal(blockedSubmit.status, 409);
    assert.equal(blockedSubmit.body?.code, 'MISSING_APARTMENT_INSPECTION');

    // 2. Handover with note only (no photos) releases MAINTENANCE -> AVAILABLE (M03 compatible),
    //    but apartment_inspected remains false for M06 settlement (R-12 requires photo evidence).
    const hoNoPhoto = await apiFetch(`/api/v1/apartments/${apt1.id}/handover`, mgrA.token, {
      method: 'PATCH',
      body: JSON.stringify({ note: 'Tường xước nhẹ' }),
    });
    assert.equal(hoNoPhoto.status, 200);
    assert.equal(hoNoPhoto.body.data.status, 'AVAILABLE');

    const preAfterNoPhoto = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token);
    assert.equal(preAfterNoPhoto.body.data.preconditions.apartment_inspected, false);

    // Put apartment back into MAINTENANCE to test keep_maintenance: true with photo evidence
    await adminPool.query(`UPDATE apartment SET status = 'MAINTENANCE' WHERE id = $1`, [apt1.id]);

    // 3. Handover with photo + keep_maintenance: true -> stays MAINTENANCE, apartment_inspected === true for both MANAGER & RESIDENT
    const hoWithPhoto = await apiFetch(`/api/v1/apartments/${apt1.id}/handover`, mgrA.token, {
      method: 'PATCH',
      body: JSON.stringify({
        note: 'Nghiệm thu phòng có ảnh',
        evidence: ['https://example.com/handover-1.jpg'],
        keep_maintenance: true,
      }),
    });
    assert.equal(hoWithPhoto.status, 200);
    assert.equal(hoWithPhoto.body.data.status, 'MAINTENANCE');

    const preMgr = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token);
    assert.equal(preMgr.body.data.preconditions.apartment_inspected, true);
    assert.equal(preMgr.body.data.preconditions.ready, true);

    const preRes = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, res1.token);
    assert.equal(preRes.body.data.preconditions.apartment_inspected, true);

    const okSubmit = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ items: [], refund_method: 'CASH' }),
    });
    assert.equal(okSubmit.status, 200);
  });

  await t.test('P2-T3-4..5: Inline inspection_evidence Base64 upload & pre-move-in (movedIn = false) bypass', async () => {
    // 4. Second terminated contract without prior /handover, passing inspection_evidence: [TINY_PNG_B64] directly
    const apt2 = await createApt('P2T3-A2');
    const res2 = await createResident('h2', '2');
    const c2 = await setupContract({
      aptId: apt2.id,
      tenantId: res2.tenantId,
      startOffset: -5,
      endOffset: 90,
    });
    await apiFetch(`/api/v1/contracts/${c2.contractId}/terminate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Trả phòng đính kèm ảnh trực tiếp ở settlement' }),
    });

    const inlineSubmit = await apiFetch(`/api/v1/deposits/${c2.depositId}/settlement`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        inspection_evidence: [TINY_PNG_B64],
        refund_method: 'CASH',
      }),
    });
    assert.equal(inlineSubmit.status, 200, JSON.stringify(inlineSubmit.body));
    const savedEv = inlineSubmit.body.data.settlement.inspection_evidence;
    assert.ok(Array.isArray(savedEv) && savedEv.length === 1);
    assert.match(savedEv[0], /^\/api\/v1\/attachments\/[0-9a-f-]+\/view$/i);

    const attCount = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM attachment WHERE owner_entity = 'deposit' AND owner_id = $1`,
      [c2.depositId]
    );
    assert.ok(attCount.rows[0].cnt >= 1);

    // 5. Early-terminated future contract before start_date (movedIn === false) -> apartment_inspected === true without photos
    const apt3 = await createApt('P2T3-A3');
    const res3 = await createResident('h3', '3');
    const c3 = await setupContract({
      aptId: apt3.id,
      tenantId: res3.tenantId,
      startOffset: 10,
      endOffset: 100,
    });
    const earlyTerm = await apiFetch(`/api/v1/contracts/${c3.contractId}/terminate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Thanh lý sớm trước ngày nhận phòng' }),
    });
    assert.equal(earlyTerm.status, 200);

    const preEarly = await apiFetch(`/api/v1/deposits/${c3.depositId}/settlement`, mgrA.token);
    assert.equal(preEarly.status, 200);
    assert.equal(preEarly.body.data.preconditions.apartment_inspected, true);
    assert.equal(preEarly.body.data.preconditions.ready, true);

    const earlySubmit = await apiFetch(`/api/v1/deposits/${c3.depositId}/settlement`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ items: [], refund_method: 'CASH' }),
    });
    assert.equal(earlySubmit.status, 200);
  });
});
