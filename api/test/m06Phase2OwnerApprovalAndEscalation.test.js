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
  const vnTodayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = vnTodayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

test('M06 Phase 2 (Task 2) — PRD 6.2 Role Matrix (OWNER R+A, MANAGER CRU, SYS_ADMIN R+Fallback), Pre-Payout Notice & 5D Escalation', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');
  const { default: reservationsRoute } = await import('../src/routes/reservations.js');
  const dailyModule = await import('../src/jobs/daily.js');

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
  app.use('/api/v1/reservations', reservationsRoute);

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
    reservationIds: [],
    floorIds: [],
    buildingIds: [],
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
          `DELETE FROM notification WHERE payload::text IN (
             SELECT '%' || id::text || '%' FROM deposit WHERE contract_id = $1
           )`,
          [cId]
        ).catch(() => {});
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
    for (const rId of cleanup.reservationIds) {
      await adminPool.query('DELETE FROM reservation WHERE id = $1', [rId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query('DELETE FROM reservation WHERE apartment_id = $1', [aId]).catch(() => {});
      await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
    }
    for (const fId of cleanup.floorIds) {
      await adminPool.query('DELETE FROM floor WHERE id = $1', [fId]).catch(() => {});
    }
    for (const bId of cleanup.buildingIds) {
      await adminPool.query('DELETE FROM user_role WHERE building_id = $1', [bId]).catch(() => {});
      await adminPool.query('DELETE FROM building WHERE id = $1', [bId]).catch(() => {});
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
  const vopAFloorId = bRes.rows[0].floor_id;

  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const mgrA = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');
  const ownerVop = await loginEmail('owner.vop@resihub.vn', 'Demo@123456');

  // Resolve an unrelated OWNER (owning VSC-A, not VOP-A)
  const otherOwnerRow = await adminPool.query(
    `SELECT p.email
     FROM building b
     JOIN owner o ON o.id = b.owner_id
     JOIN person p ON p.id = o.person_id
     JOIN app_user au ON au.person_id = p.id
     WHERE b.code = 'VSC-A' AND au.status = 'ACTIVE'
     LIMIT 1`
  );
  const ownerOther = await loginEmail(otherOwnerRow.rows[0].email, 'Demo@123456');

  const pwHash = await bcrypt.hash('Demo@123456', 10);
  const resRoleRes = await adminPool.query(
    `SELECT id FROM role WHERE org_id = $1 AND code = 'RESIDENT' LIMIT 1`,
    [orgId]
  );
  const resRoleId = resRoleRes.rows[0].id;
  const mgrRoleRes = await adminPool.query(
    `SELECT id FROM role WHERE org_id = $1 AND code = 'MANAGER' LIMIT 1`,
    [orgId]
  );
  const mgrRoleId = mgrRoleRes.rows[0].id;

  async function createResidentAccount(tag, idx) {
    const email = `p2t2.${tag}.${suffix}@resihub.test`;
    const phone = `095${idx}${suffix}`;
    const p = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, `Cư dân ${tag} ${suffix}`, phone, email, `07921${idx}${suffix}`]
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
    await adminPool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [
      u.rows[0].id,
      resRoleId,
    ]);
    const auth = await loginEmail(email, 'Demo@123456');
    return { ...auth, personId: p.rows[0].id, tenantId: tn.rows[0].id, email, phone };
  }

  async function createApt(bId, flId, prefix, baseRent = 8000000) {
    const r = await apiFetch('/api/v1/apartments', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bId,
        floor_id: flId,
        code: `${prefix}-${suffix}`,
        area_m2: 45,
        bedrooms: 1,
        type: '1PN',
        base_rent: baseRent,
      }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    cleanup.apartmentIds.push(r.body.data.id);
    return r.body.data;
  }

  await t.test('P2-T2-1: Owned building (VOP-A) — SYS_ADMIN 403 on CRU+A, OWNER 403 on CRU & 200 on A, pre-payout notices', async () => {
    const aptContract = await createApt(vopAId, vopAFloorId, 'P2T2-C');
    const aptRsv1 = await createApt(vopAId, vopAFloorId, 'P2T2-R1');
    const aptRsv2 = await createApt(vopAId, vopAFloorId, 'P2T2-R2');
    const resident = await createResidentAccount('vop', '1');

    // SYS_ADMIN & OWNER get 403 on POST /api/v1/reservations
    const sysRsv = await apiFetch('/api/v1/reservations', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptRsv1.id,
        prospect_name: 'Khách SYS',
        phone: `0941${suffix}`,
        hold_amount: 2000000,
        hold_until: isoDaysFromToday(5),
      }),
    });
    assert.equal(sysRsv.status, 403);

    const ownRsv = await apiFetch('/api/v1/reservations', ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptRsv1.id,
        prospect_name: 'Khách OWN',
        phone: `0942${suffix}`,
        hold_amount: 2000000,
        hold_until: isoDaysFromToday(5),
      }),
    });
    assert.equal(ownRsv.status, 403);

    // MANAGER creates two reservations on VOP-A
    const rsv1 = await apiFetch('/api/v1/reservations', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptRsv1.id,
        prospect_name: 'Khách Hoàn Cọc',
        phone: `0943${suffix}`,
        hold_amount: 2000000,
        hold_until: isoDaysFromToday(5),
      }),
    });
    assert.equal(rsv1.status, 201, JSON.stringify(rsv1.body));
    cleanup.reservationIds.push(rsv1.body.data.id);
    const p1 = await adminPool.query('SELECT id FROM person WHERE phone = $1', [`0943${suffix}`]);
    if (p1.rows[0]) cleanup.personIds.push(p1.rows[0].id);

    const rsv2 = await apiFetch('/api/v1/reservations', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptRsv2.id,
        prospect_name: 'Khách Tịch Thu Cọc',
        phone: `0944${suffix}`,
        hold_amount: 2500000,
        hold_until: isoDaysFromToday(5),
      }),
    });
    assert.equal(rsv2.status, 201, JSON.stringify(rsv2.body));
    cleanup.reservationIds.push(rsv2.body.data.id);
    const p2 = await adminPool.query('SELECT id FROM person WHERE phone = $1', [`0944${suffix}`]);
    if (p2.rows[0]) cleanup.personIds.push(p2.rows[0].id);

    // SYS_ADMIN gets 403 on refund & forfeit when building_has_active_owner = true
    const sysRefRsv = await apiFetch(`/api/v1/reservations/${rsv1.body.data.id}/refund`, sysAdmin.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'SYS_ADMIN thử duyệt hoàn giữ chỗ' }),
    });
    assert.equal(sysRefRsv.status, 403, JSON.stringify(sysRefRsv.body));

    const sysForfRsv = await apiFetch(`/api/v1/reservations/${rsv2.body.data.id}/forfeit`, sysAdmin.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'SYS_ADMIN thử duyệt tịch thu giữ chỗ' }),
    });
    assert.equal(sysForfRsv.status, 403, JSON.stringify(sysForfRsv.body));

    // Creator MANAGER gets 403 FOUR_EYES_VIOLATION on refund & forfeit
    const mgrSelfRef = await apiFetch(`/api/v1/reservations/${rsv1.body.data.id}/refund`, mgrA.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Tự duyệt hoàn giữ chỗ' }),
    });
    assert.equal(mgrSelfRef.status, 403);
    assert.equal(mgrSelfRef.body?.code, 'FOUR_EYES_VIOLATION');

    const mgrSelfForf = await apiFetch(`/api/v1/reservations/${rsv2.body.data.id}/forfeit`, mgrA.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Tự duyệt tịch thu giữ chỗ' }),
    });
    assert.equal(mgrSelfForf.status, 403);
    assert.equal(mgrSelfForf.body?.code, 'FOUR_EYES_VIOLATION');

    // VOP-A OWNER succeeds (200) on refund (APPROVED_PENDING_PAYOUT) & forfeit, and apartment transitions RESERVED -> AVAILABLE
    const ownRefRsv = await apiFetch(`/api/v1/reservations/${rsv1.body.data.id}/refund`, ownerVop.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Chủ nhà duyệt hoàn cọc giữ chỗ khách hủy đúng hạn' }),
    });
    assert.equal(ownRefRsv.status, 200, JSON.stringify(ownRefRsv.body));
    assert.equal(ownRefRsv.body.data.status, 'APPROVED_PENDING_PAYOUT');
    const apt1After = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [aptRsv1.id]);
    assert.equal(apt1After.rows[0].status, 'AVAILABLE');

    const ownForfRsv = await apiFetch(`/api/v1/reservations/${rsv2.body.data.id}/forfeit`, ownerVop.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Chủ nhà duyệt tịch thu cọc giữ chỗ khách bỏ cọc' }),
    });
    assert.equal(ownForfRsv.status, 200, JSON.stringify(ownForfRsv.body));
    const apt2After = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [aptRsv2.id]);
    assert.equal(apt2After.rows[0].status, 'AVAILABLE');

    // Create & activate contract on VOP-A with partial deposit (5M / 8M)
    const cRes = await apiFetch('/api/v1/contracts', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptContract.id,
        primary_tenant_id: resident.tenantId,
        start_date: isoDaysFromToday(-15),
        end_date: isoDaysFromToday(180),
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
    const actRes = await apiFetch(`/api/v1/contracts/${contractId}/activate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(actRes.status, 200);
    await adminPool.query("UPDATE meter SET status = 'INACTIVE' WHERE apartment_id = $1", [aptContract.id]);

    const depQ = await adminPool.query('SELECT id FROM deposit WHERE contract_id = $1', [contractId]);
    const depositId = depQ.rows[0].id;

    const mgrCollect = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 5000000, method: 'BANK_TRANSFER', description: 'Thu cọc đợt 1' }),
    });
    assert.equal(mgrCollect.status, 201);

    // SYS_ADMIN & OWNER get 403 on POST /:id/transactions (collect)
    const sysCollect = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 1000000, method: 'CASH' }),
    });
    assert.equal(sysCollect.status, 403);

    const ownCollect = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 1000000, method: 'CASH' }),
    });
    assert.equal(ownCollect.status, 403);

    // Terminate contract so settlement is eligible
    const term = await apiFetch(`/api/v1/contracts/${contractId}/terminate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Thanh lý kiểm thử P2-T2' }),
    });
    assert.equal(term.status, 200);

    // SYS_ADMIN & OWNER get 403 on POST /:id/settlement
    const sysSettle = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({ items: [], refund_method: 'CASH', inspection_evidence: [TINY_PNG_B64] }),
    });
    assert.equal(sysSettle.status, 403);

    const ownSettle = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({ items: [], refund_method: 'CASH', inspection_evidence: [TINY_PNG_B64] }),
    });
    assert.equal(ownSettle.status, 403);

    // MANAGER submits settlement -> notifies RESIDENT (SETTLEMENT_STATEMENT_READY) + VOP-A OWNER (SETTLEMENT_PENDING_APPROVAL)
    const sub1 = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            category: 'DAMAGE',
            amount: 5000000,
            description: 'Khấu trừ hết cọc hư hỏng nội thất',
            evidence: [TINY_PNG_B64],
          },
        ],
        inspection_evidence: [TINY_PNG_B64],
        refund_method: 'CASH',
      }),
    });
    assert.equal(sub1.status, 200, JSON.stringify(sub1.body));

    const resNotif = await adminPool.query(
      `SELECT id FROM notification
       WHERE user_id = $1 AND type = 'SETTLEMENT_STATEMENT_READY' AND (payload->>'deposit_id') = $2`,
      [resident.user.sub, depositId]
    );
    assert.ok(resNotif.rows.length >= 1, 'Expected SETTLEMENT_STATEMENT_READY notification for RESIDENT');

    const ownNotif = await adminPool.query(
      `SELECT id FROM notification
       WHERE user_id = $1 AND type = 'SETTLEMENT_PENDING_APPROVAL' AND (payload->>'deposit_id') = $2`,
      [ownerVop.user.sub, depositId]
    );
    assert.ok(ownNotif.rows.length >= 1, 'Expected SETTLEMENT_PENDING_APPROVAL notification for VOP-A OWNER');

    // SYS_ADMIN gets 403 on approve & reject on owned building
    const sysApprove = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(sysApprove.status, 403);

    const sysReject = await apiFetch(`/api/v1/deposits/${depositId}/settlement/reject`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'SYS_ADMIN thử từ chối' }),
    });
    assert.equal(sysReject.status, 403);

    // Unrelated OWNER gets 403 ACCESS_DENIED on approve/reject
    const wrongOwnApprove = await apiFetch(
      `/api/v1/deposits/${depositId}/settlement/approve`,
      ownerOther.token,
      { method: 'POST', body: JSON.stringify({}) }
    );
    assert.equal(wrongOwnApprove.status, 403);
    assert.equal(wrongOwnApprove.body?.code, 'ACCESS_DENIED');

    // VOP-A OWNER rejects -> 200 SETTLEMENT_DRAFT + SETTLEMENT_REJECTED notification to creator MANAGER
    const ownReject = await apiFetch(`/api/v1/deposits/${depositId}/settlement/reject`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Cần ghi rõ biên bản khấu trừ chi tiết hơn' }),
    });
    assert.equal(ownReject.status, 200, JSON.stringify(ownReject.body));
    assert.equal(ownReject.body?.data?.status, 'SETTLEMENT_DRAFT');

    const mgrRejNotif = await adminPool.query(
      `SELECT id FROM notification
       WHERE user_id = $1 AND type = 'SETTLEMENT_REJECTED' AND (payload->>'deposit_id') = $2`,
      [mgrA.user.sub, depositId]
    );
    assert.ok(mgrRejNotif.rows.length >= 1, 'Expected SETTLEMENT_REJECTED notification for creator MANAGER');

    // MANAGER resubmits -> VOP-A OWNER approves -> 200
    const sub2 = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            category: 'DAMAGE',
            amount: 5000000,
            description: 'Khấu trừ hư hỏng nội thất kèm biên bản chi tiết',
            evidence: [TINY_PNG_B64],
          },
        ],
        inspection_evidence: [TINY_PNG_B64],
        refund_method: 'CASH',
      }),
    });
    assert.equal(sub2.status, 200);

    const ownApprove = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(ownApprove.status, 200, JSON.stringify(ownApprove.body));
  });

  await t.test('P2-T2-2: Unowned building (owner_id = NULL) — SYS_ADMIN 403 on CRU, 200 as fallback approver', async () => {
    const bIns = await adminPool.query(
      `INSERT INTO building (org_id, owner_id, code, name, address)
       VALUES ($1, NULL, $2, $3, 'Số 1 Đường Thử Nghiệm')
       RETURNING id`,
      [orgId, `NOOWN-${suffix}`, `Tòa Chưa Gắn Chủ ${suffix}`]
    );
    const noOwnerBldId = bIns.rows[0].id;
    cleanup.buildingIds.push(noOwnerBldId);

    const fIns = await adminPool.query(
      `INSERT INTO floor (building_id, level, name) VALUES ($1, 1, 'Tầng 1') RETURNING id`,
      [noOwnerBldId]
    );
    const noOwnerFloorId = fIns.rows[0].id;
    cleanup.floorIds.push(noOwnerFloorId);

    // Assign mgrA to this building so mgrA can perform CRU
    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
      [mgrA.user.sub, mgrRoleId, noOwnerBldId]
    );

    const aptRsv = await createApt(noOwnerBldId, noOwnerFloorId, 'NOOWN-R');
    const aptDep = await createApt(noOwnerBldId, noOwnerFloorId, 'NOOWN-D', 6000000);
    const resident = await createResidentAccount('noown', '2');

    // Reservation created by mgrA -> SYS_ADMIN fallback refund succeeds (200)
    const rsv = await apiFetch('/api/v1/reservations', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptRsv.id,
        prospect_name: 'Khách Không Chủ',
        phone: `0945${suffix}`,
        hold_amount: 1500000,
        hold_until: isoDaysFromToday(5),
      }),
    });
    assert.equal(rsv.status, 201);
    cleanup.reservationIds.push(rsv.body.data.id);
    const pRsv = await adminPool.query('SELECT id FROM person WHERE phone = $1', [`0945${suffix}`]);
    if (pRsv.rows[0]) cleanup.personIds.push(pRsv.rows[0].id);

    const sysFallbackRsvRefund = await apiFetch(
      `/api/v1/reservations/${rsv.body.data.id}/refund`,
      sysAdmin.token,
      {
        method: 'PATCH',
        body: JSON.stringify({ reason: 'SYS_ADMIN duyệt dự phòng do tòa chưa gắn OWNER' }),
      }
    );
    assert.equal(sysFallbackRsvRefund.status, 200, JSON.stringify(sysFallbackRsvRefund.body));

    // Contract & deposit on unowned building
    const cRes = await apiFetch('/api/v1/contracts', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptDep.id,
        primary_tenant_id: resident.tenantId,
        start_date: isoDaysFromToday(-10),
        end_date: isoDaysFromToday(120),
        rent_amount: 6000000,
        deposit_amount: 6000000,
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
    await apiFetch(`/api/v1/contracts/${contractId}/activate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const depQ = await adminPool.query('SELECT id FROM deposit WHERE contract_id = $1', [contractId]);
    const depositId = depQ.rows[0].id;

    await adminPool.query("UPDATE meter SET status = 'INACTIVE' WHERE apartment_id = $1", [aptDep.id]);
    const mgrNoOwnCollect = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 3000000, method: 'CASH', description: 'Thu cọc tòa chưa gắn chủ' }),
    });
    assert.equal(mgrNoOwnCollect.status, 201);

    // SYS_ADMIN still gets 403 on CRU (collect & settlement)
    const sysCollect = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 1000000, method: 'CASH' }),
    });
    assert.equal(sysCollect.status, 403);

    await apiFetch(`/api/v1/contracts/${contractId}/terminate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Thanh lý tòa chưa gắn chủ' }),
    });

    const sysSettle = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({ items: [], refund_method: 'CASH', inspection_evidence: [TINY_PNG_B64] }),
    });
    assert.equal(sysSettle.status, 403);

    // mgrA submits -> SYS_ADMIN fallback approve succeeds (200)
    const mgrSettle = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            category: 'CLEANING',
            amount: 3000000,
            description: 'Vệ sinh công nghiệp toàn căn',
            evidence: [TINY_PNG_B64],
          },
        ],
        inspection_evidence: [TINY_PNG_B64],
        refund_method: 'CASH',
      }),
    });
    assert.equal(mgrSettle.status, 200);

    const sysFallbackApprove = await apiFetch(
      `/api/v1/deposits/${depositId}/settlement/approve`,
      sysAdmin.token,
      { method: 'POST', body: JSON.stringify({}) }
    );
    assert.equal(sysFallbackApprove.status, 200, JSON.stringify(sysFallbackApprove.body));
  });

  await t.test('P2-T2-3: runOverdueDepositSettlementAlerts notifies active building OWNER on >= 5D and skips DEDUCTED_FULL', async () => {
    assert.equal(
      typeof dailyModule.runOverdueDepositSettlementAlerts,
      'function',
      'runOverdueDepositSettlementAlerts must be exported from daily.js'
    );

    const aptOverdue = await createApt(vopAId, vopAFloorId, 'P2T2-OD1');
    const aptDeducted = await createApt(vopAId, vopAFloorId, 'P2T2-OD2');
    const res1 = await createResidentAccount('od1', '3');
    const res2 = await createResidentAccount('od2', '4');

    async function setupTerminatedDeposit(aptId, tenantId, targetStatus, amountHeld) {
      const c = await adminPool.query(
        `INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, terminated_at, rent_amount, billing_day, deposit_amount, status, created_by)
         VALUES ($1, $2, $3, CURRENT_DATE - 60, CURRENT_DATE + 60, CURRENT_DATE - 6, 8000000, 5, 8000000, 'TERMINATED', $4)
         RETURNING id`,
        [aptId, vopAId, tenantId, mgrA.user.sub]
      );
      cleanup.contractIds.push(c.rows[0].id);
      const d = await adminPool.query(
        `INSERT INTO deposit (contract_id, amount_held, status, refund_due_date)
         VALUES ($1, $2, $3, CURRENT_DATE - 1)
         RETURNING id`,
        [c.rows[0].id, amountHeld, targetStatus]
      );
      return d.rows[0].id;
    }

    const overdueDepId = await setupTerminatedDeposit(aptOverdue.id, res1.tenantId, 'HELD', 8000000);
    const deductedDepId = await setupTerminatedDeposit(aptDeducted.id, res2.tenantId, 'DEDUCTED_FULL', 0);

    await dailyModule.runOverdueDepositSettlementAlerts();

    const ownerOdNotif = await adminPool.query(
      `SELECT id FROM notification
       WHERE user_id = $1 AND type = 'DEPOSIT_OVERDUE_5D' AND (payload->>'deposit_id') = $2`,
      [ownerVop.user.sub, overdueDepId]
    );
    assert.ok(
      ownerOdNotif.rows.length >= 1,
      'Expected DEPOSIT_OVERDUE_5D notification for VOP-A active OWNER'
    );

    const deductedNotifs = await adminPool.query(
      `SELECT id FROM notification WHERE (payload->>'deposit_id') = $1`,
      [deductedDepId]
    );
    assert.equal(deductedNotifs.rows.length, 0, 'DEDUCTED_FULL must produce zero overdue notifications');

    // Clean up notification created on seeded ownerVop
    await adminPool.query(
      `DELETE FROM notification WHERE (payload->>'deposit_id') = $1`,
      [overdueDepId]
    );
  });
});
