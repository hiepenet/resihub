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

test('M06 Phase 2 (Task 4) — Separated Payout Execution, UNC Voucher, Pre-Payout ADJUST/CONFIRM & RETURNED Reissue', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');
  const { default: residentRoute } = await import('../src/routes/resident.js');

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
  app.use('/api/v1/resident', residentRoute);

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
      await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
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
  const ownerVop = await loginEmail('owner.vop@resihub.vn', 'Demo@123456');
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
        area_m2: 55,
        bedrooms: 2,
        type: '2PN',
        base_rent: 10000000,
      }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    cleanup.apartmentIds.push(r.body.data.id);
    return r.body.data;
  }

  async function createResident(tag, idx, tenantType = 'primary') {
    const email = `p2t4.${tag}.${suffix}@resihub.test`;
    const phone = `094${idx}${suffix}`;
    const p = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, `Cư dân ${tag} ${suffix}`, phone, email, `07941${idx}${suffix}`]
    );
    cleanup.personIds.push(p.rows[0].id);
    const tn = await adminPool.query(
      `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, $3, 'APPROVED') RETURNING id`,
      [orgId, p.rows[0].id, tenantType]
    );
    cleanup.tenantIds.push(tn.rows[0].id);
    const u = await adminPool.query(
      `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [p.rows[0].id, pwHash]
    );
    cleanup.userIds.push(u.rows[0].id);
    await adminPool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [u.rows[0].id, resRoleId]);
    const auth = await loginEmail(email, 'Demo@123456');
    return { ...auth, tenantId: tn.rows[0].id, personId: p.rows[0].id };
  }

  async function setupTerminatedContract({ aptId, primaryTenantId, occupantTenantId = null, heldAmount = 10000000 }) {
    const cRes = await apiFetch('/api/v1/contracts', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptId,
        primary_tenant_id: primaryTenantId,
        start_date: isoDaysFromToday(-30),
        end_date: isoDaysFromToday(120),
        rent_amount: 10000000,
        deposit_amount: heldAmount,
        billing_day: 5,
      }),
    });
    assert.equal(cRes.status, 201);
    const contractId = cRes.body.data.id;
    cleanup.contractIds.push(contractId);
    if (occupantTenantId) {
      await adminPool.query(
        `INSERT INTO contract_occupant (contract_id, tenant_id, relationship) VALUES ($1, $2, 'SPOUSE')`,
        [contractId, occupantTenantId]
      );
    }
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
    const col = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: heldAmount, method: 'BANK_TRANSFER', description: 'Thu cọc HĐ' }),
    });
    assert.equal(col.status, 201);
    const term = await apiFetch(`/api/v1/contracts/${contractId}/terminate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Thanh lý kiểm thử tách payout & RETURNED' }),
    });
    assert.equal(term.status, 200);
    const ho = await apiFetch(`/api/v1/apartments/${aptId}/handover`, mgrA.token, {
      method: 'PATCH',
      body: JSON.stringify({
        note: 'Nghiệm thu bàn giao phòng có ảnh',
        evidence: ['https://example.com/handover-p2t4.jpg'],
        keep_maintenance: true,
      }),
    });
    assert.equal(ho.status, 200);
    return { contractId, depositId };
  }

  // =========================================================================
  // 1..3. Separated approve -> APPROVED_PENDING_PAYOUT, pre-payout dispute ADJUST/CONFIRM, payout & idempotency
  // =========================================================================
  const apt1 = await createApt('P2T4-A1');
  const primaryRes = await createResident('pri1', '1', 'primary');
  const occupantRes = await createResident('occ1', '2', 'occupant');
  const { depositId } = await setupTerminatedContract({
    aptId: apt1.id,
    primaryTenantId: primaryRes.tenantId,
    occupantTenantId: occupantRes.tenantId,
    heldAmount: 10000000,
  });

  const sub1 = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      items: [
        {
          category: 'CLEANING',
          amount: 2500000,
          description: 'Tổng vệ sinh & sơn dặm',
          evidence: ['https://example.com/clean-25m.png'],
        },
      ],
      refund_method: 'BANK_TRANSFER',
      bank_info: {
        bank_name: 'Vietcombank',
        account_number: '0011001234567',
        account_holder: 'CU DAN P2T4',
      },
    }),
  });
  assert.equal(sub1.status, 200);

  // 1. OWNER approves -> APPROVED_PENDING_PAYOUT, amount_held stays 10_000_000, zero deduct/refund txns yet
  const app1 = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, ownerVop.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(app1.status, 200, JSON.stringify(app1.body));
  assert.equal(app1.body.data.status, 'APPROVED_PENDING_PAYOUT');

  const depRowBeforePayout = await adminPool.query('SELECT status, amount_held FROM deposit WHERE id = $1', [depositId]);
  assert.equal(depRowBeforePayout.rows[0].status, 'APPROVED_PENDING_PAYOUT');
  assert.equal(String(depRowBeforePayout.rows[0].amount_held), '10000000');

  const txBeforePayout = await adminPool.query(
    `SELECT COUNT(*)::int AS cnt FROM deposit_transaction WHERE deposit_id = $1 AND type IN ('deduct', 'refund')`,
    [depositId]
  );
  assert.equal(txBeforePayout.rows[0].cnt, 0, 'Zero deduct/refund rows before payout');

  // OWNER or SYS_ADMIN attempting POST /:id/payout -> 403
  const ownerPayout = await apiFetch(`/api/v1/deposits/${depositId}/payout`, ownerVop.token, {
    method: 'POST',
    body: JSON.stringify({ evidence: ['https://example.com/unc.png'], reference_code: 'FT-OWN' }),
  });
  assert.equal(ownerPayout.status, 403);

  const sysPayout = await apiFetch(`/api/v1/deposits/${depositId}/payout`, sysAdmin.token, {
    method: 'POST',
    body: JSON.stringify({ evidence: ['https://example.com/unc.png'], reference_code: 'FT-SYS' }),
  });
  assert.equal(sysPayout.status, 403);

  // MANAGER calling POST /:id/payout with empty evidence: [] -> 422 PAYOUT_EVIDENCE_REQUIRED
  const emptyUnc = await apiFetch(`/api/v1/deposits/${depositId}/payout`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ evidence: [], reference_code: 'FT-EMPTY' }),
  });
  assert.equal(emptyUnc.status, 422);
  assert.equal(emptyUnc.body?.code, 'PAYOUT_EVIDENCE_REQUIRED');

  // 2. Pre-payout dispute lock & ADJUST / CONFIRM
  const dispPre1 = await apiFetch(`/api/v1/deposits/${depositId}/dispute`, primaryRes.token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Phí vệ sinh & sơn dặm hơi cao' }),
  });
  assert.equal(dispPre1.status, 200);
  assert.equal(dispPre1.body.data.status, 'DISPUTED');

  const payoutWhileDisputed = await apiFetch(`/api/v1/deposits/${depositId}/payout`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ evidence: ['https://example.com/unc.png'], reference_code: 'FT-DISP' }),
  });
  assert.equal(payoutWhileDisputed.status, 409);
  assert.equal(payoutWhileDisputed.body?.code, 'SETTLEMENT_DISPUTED');

  // Pre-payout ADJUST succeeds -> SETTLEMENT_DRAFT, clearing approved_by/approved_at
  const adjustPre = await apiFetch(`/api/v1/deposits/${depositId}/resolve-dispute`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ resolution: 'ADJUST', notes: 'Điều chỉnh giảm phí vệ sinh xuống 2.2M' }),
  });
  assert.equal(adjustPre.status, 200, JSON.stringify(adjustPre.body));
  assert.equal(adjustPre.body.data.status, 'SETTLEMENT_DRAFT');

  const checkDraft = await adminPool.query('SELECT settlement FROM deposit WHERE id = $1', [depositId]);
  assert.equal(checkDraft.rows[0].settlement.approved_by, null);
  assert.equal(checkDraft.rows[0].settlement.approved_at, null);

  // Resubmit with deduct = 2_200_000 -> refund_amount = 7_800_000 -> OWNER re-approves -> APPROVED_PENDING_PAYOUT
  const sub2 = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      items: [
        {
          category: 'CLEANING',
          amount: 2200000,
          description: 'Tổng vệ sinh & sơn dặm sau điều chỉnh',
          evidence: ['https://example.com/clean-22m.png'],
        },
      ],
      refund_method: 'BANK_TRANSFER',
      bank_info: {
        bank_name: 'Vietcombank',
        account_number: '0011001234567',
        account_holder: 'CU DAN P2T4',
      },
    }),
  });
  assert.equal(sub2.status, 200);
  assert.equal(sub2.body.data.settlement.refund_amount, 7800000);

  const app2 = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, ownerVop.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(app2.status, 200);
  assert.equal(app2.body.data.status, 'APPROVED_PENDING_PAYOUT');

  // Resident disputes a second time at APPROVED_PENDING_PAYOUT -> creator MANAGER CONFIRM fails 403 SELF_APPROVAL -> OWNER CONFIRM restores APPROVED_PENDING_PAYOUT
  const dispPre2 = await apiFetch(`/api/v1/deposits/${depositId}/dispute`, primaryRes.token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Xin kiểm tra lại lần 2 trước khi chi hoàn' }),
  });
  assert.equal(dispPre2.status, 200);

  const mgrConfirmSelf = await apiFetch(`/api/v1/deposits/${depositId}/resolve-dispute`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ resolution: 'CONFIRM', notes: 'Tự xác nhận' }),
  });
  assert.equal(mgrConfirmSelf.status, 403);
  assert.equal(mgrConfirmSelf.body?.code, 'SELF_APPROVAL');

  const ownerConfirm = await apiFetch(`/api/v1/deposits/${depositId}/resolve-dispute`, ownerVop.token, {
    method: 'POST',
    body: JSON.stringify({ resolution: 'CONFIRM', notes: 'Đã đối chiếu biên bản bàn giao' }),
  });
  assert.equal(ownerConfirm.status, 200);
  assert.equal(ownerConfirm.body.data.status, 'APPROVED_PENDING_PAYOUT');

  // 3. Payout execution, accounting commit & idempotency
  const payoutIdemKey = `payout-${crypto.randomUUID()}`;
  const payoutPayload = JSON.stringify({
    evidence: [TINY_PNG_B64],
    reference_code: 'FT26306001',
  });
  const payout1 = await apiFetch(`/api/v1/deposits/${depositId}/payout`, mgrA.token, {
    method: 'POST',
    headers: { 'Idempotency-Key': payoutIdemKey },
    body: payoutPayload,
  });
  assert.equal(payout1.status, 200, JSON.stringify(payout1.body));
  assert.equal(payout1.body.data.status, 'PARTIALLY_REFUNDED');
  assert.equal(String(payout1.body.data.amount_held), '0');

  const payoutReplay = await apiFetch(`/api/v1/deposits/${depositId}/payout`, mgrA.token, {
    method: 'POST',
    headers: { 'Idempotency-Key': payoutIdemKey },
    body: payoutPayload,
  });
  assert.equal(payoutReplay.status, 200);
  assert.equal(payoutReplay.headers.get('idempotent-replayed'), 'true');

  const txAfterPayout = await adminPool.query(
    `SELECT type, amount, reference_code, status
     FROM deposit_transaction
     WHERE deposit_id = $1
     ORDER BY created_at ASC`,
    [depositId]
  );
  assert.equal(txAfterPayout.rows.length, 3, 'Must have collect, deduct, refund (not duplicated by replay)');
  const deductRow = txAfterPayout.rows.find((r) => r.type === 'deduct');
  const refundRow = txAfterPayout.rows.find((r) => r.type === 'refund');
  assert.equal(Number(deductRow.amount), 2200000);
  assert.equal(deductRow.status, 'APPROVED');
  assert.equal(Number(refundRow.amount), 7800000);
  assert.equal(refundRow.reference_code, 'FT26306001');
  assert.equal(refundRow.status, 'APPROVED');

  const uncAttQ = await adminPool.query(
    `SELECT COUNT(*)::int AS cnt FROM attachment WHERE owner_entity = 'deposit' AND owner_id = $1 AND storage_path NOT LIKE 'http%'`,
    [depositId]
  );
  assert.ok(uncAttQ.rows[0].cnt >= 1, 'UNC Base64 attachment must be persisted');

  const ovRes = await apiFetch('/api/v1/resident/overview', primaryRes.token);
  assert.equal(ovRes.status, 200);
  assert.ok(
    ovRes.body.data.deposit_settlements.some((s) => s.deposit_id === depositId),
    'Resident overview must surface settled deposit'
  );

  // Post-payout dispute + ADJUST fails 409 ALREADY_PAID_OUT
  const dispPost = await apiFetch(`/api/v1/deposits/${depositId}/dispute`, primaryRes.token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Thắc mắc sau chi trả' }),
  });
  assert.equal(dispPost.status, 200);

  const adjustPost = await apiFetch(`/api/v1/deposits/${depositId}/resolve-dispute`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ resolution: 'ADJUST', notes: 'Thử mở lại sau khi đã chi tiền' }),
  });
  assert.equal(adjustPost.status, 409);
  assert.equal(adjustPost.body?.code, 'ALREADY_PAID_OUT');

  const confirmPost = await apiFetch(`/api/v1/deposits/${depositId}/resolve-dispute`, ownerVop.token, {
    method: 'POST',
    body: JSON.stringify({ resolution: 'CONFIRM', notes: 'Xác nhận giữ nguyên sau chi trả' }),
  });
  assert.equal(confirmPost.status, 200);
  assert.equal(confirmPost.body.data.status, 'PARTIALLY_REFUNDED');

  // =========================================================================
  // 4. RETURNED bank-bounce & reissue lifecycle
  // =========================================================================
  // Dedicated DEDUCTED_FULL deposit (refund_amount = 0) -> payout-returned fails 409 INVALID_DEPOSIT_STATUS_FOR_RETURN
  const aptDed = await createApt('P2T4-A2');
  const resDed = await createResident('ded2', '3', 'primary');
  const { depositId: dedDepId } = await setupTerminatedContract({
    aptId: aptDed.id,
    primaryTenantId: resDed.tenantId,
    heldAmount: 5000000,
  });
  const subDed = await apiFetch(`/api/v1/deposits/${dedDepId}/settlement`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      items: [
        {
          category: 'DAMAGE',
          amount: 5000000,
          description: 'Hư hỏng toàn bộ 5M',
          evidence: ['https://example.com/dmg-5m.png'],
        },
      ],
      refund_method: 'CASH',
    }),
  });
  assert.equal(subDed.status, 200);
  const appDed = await apiFetch(`/api/v1/deposits/${dedDepId}/settlement/approve`, ownerVop.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(appDed.status, 200);
  assert.equal(appDed.body.data.status, 'DEDUCTED_FULL');

  const retOnZero = await apiFetch(`/api/v1/deposits/${dedDepId}/payout-returned`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Thử báo hoàn trả trên sổ refund = 0' }),
  });
  assert.equal(retOnZero.status, 409);
  assert.equal(retOnZero.body?.code, 'INVALID_DEPOSIT_STATUS_FOR_RETURN');

  // MANAGER marks PARTIALLY_REFUNDED deposit as RETURNED
  const retOk = await apiFetch(`/api/v1/deposits/${depositId}/payout-returned`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Sai tên chủ tài khoản thụ hưởng', reference_code: 'RET-26306001' }),
  });
  assert.equal(retOk.status, 200, JSON.stringify(retOk.body));
  assert.equal(retOk.body.data.status, 'RETURNED');
  assert.equal(String(retOk.body.data.amount_held), '7800000');

  const retNotif = await adminPool.query(
    `SELECT 1 FROM notification WHERE user_id = $1 AND type = 'DEPOSIT_PAYOUT_RETURNED'`,
    [primaryRes.user.sub]
  );
  assert.ok(retNotif.rows.length >= 1, 'Must notify RESIDENT with DEPOSIT_PAYOUT_RETURNED');

  // Non-primary occupant gets 403 on PATCH /:id/bank-info
  const occBankAttempt = await apiFetch(`/api/v1/deposits/${depositId}/bank-info`, occupantRes.token, {
    method: 'PATCH',
    body: JSON.stringify({
      bank_name: 'Techcombank',
      account_number: '1903888999',
      account_holder: 'OCCUPANT TEST',
    }),
  });
  assert.equal(occBankAttempt.status, 403);

  // Malformed account ('12-34' or '< 4' chars '123') fails 422 INVALID_ACCOUNT_NUMBER
  const badBankDash = await apiFetch(`/api/v1/deposits/${depositId}/bank-info`, primaryRes.token, {
    method: 'PATCH',
    body: JSON.stringify({
      bank_name: 'Techcombank',
      account_number: '12-34',
      account_holder: 'CU DAN P2T4',
    }),
  });
  assert.equal(badBankDash.status, 422);
  assert.equal(badBankDash.body?.code, 'INVALID_ACCOUNT_NUMBER');

  const badBankShort = await apiFetch(`/api/v1/deposits/${depositId}/bank-info`, primaryRes.token, {
    method: 'PATCH',
    body: JSON.stringify({
      bank_name: 'Techcombank',
      account_number: '123',
      account_holder: 'CU DAN P2T4',
    }),
  });
  assert.equal(badBankShort.status, 422);
  assert.equal(badBankShort.body?.code, 'INVALID_ACCOUNT_NUMBER');

  const badBankArray = await apiFetch(`/api/v1/deposits/${depositId}/bank-info`, primaryRes.token, {
    method: 'PATCH',
    body: JSON.stringify({ bank_info: [] }),
  });
  assert.equal(badBankArray.status, 422);
  assert.equal(badBankArray.body?.code, 'BANK_INFO_REQUIRED');

  const badBankNull = await apiFetch(`/api/v1/deposits/${depositId}/bank-info`, primaryRes.token, {
    method: 'PATCH',
    body: JSON.stringify({ bank_info: null }),
  });
  assert.equal(badBankNull.status, 422);
  assert.equal(badBankNull.body?.code, 'BANK_INFO_REQUIRED');

  // Primary RESIDENT updates bank account using nested { bank_info } UI payload -> 200 + preserves bank_logo + notifies BUILDING_MANAGERS
  const okBankUpdate = await apiFetch(`/api/v1/deposits/${depositId}/bank-info`, primaryRes.token, {
    method: 'PATCH',
    body: JSON.stringify({
      bank_info: {
        bank_name: 'Techcombank',
        bank_code: 'TCB',
        bank_bin: '970407',
        bank_logo: 'https://api.vietqr.io/img/TCB.png',
        account_number: '190366688899',
        account_holder: 'CU DAN P2T4 MOI',
      },
    }),
  });
  assert.equal(okBankUpdate.status, 200, JSON.stringify(okBankUpdate.body));
  assert.equal(okBankUpdate.body.data.settlement.bank_info.account_number, '190366688899');
  assert.equal(okBankUpdate.body.data.settlement.bank_info.bank_bin, '970407');
  assert.equal(
    okBankUpdate.body.data.settlement.bank_info.bank_logo,
    'https://api.vietqr.io/img/TCB.png'
  );

  // MANAGER updates bank account using legacy flat payload -> 200 backward-compatible
  const okFlatBankUpdate = await apiFetch(`/api/v1/deposits/${depositId}/bank-info`, mgrA.token, {
    method: 'PATCH',
    body: JSON.stringify({
      bank_name: 'MBBank',
      bank_code: 'MB',
      account_number: '0987654321',
      account_holder: 'CU DAN P2T4 MOI',
    }),
  });
  assert.equal(okFlatBankUpdate.status, 200, JSON.stringify(okFlatBankUpdate.body));
  assert.equal(okFlatBankUpdate.body.data.settlement.bank_info.account_number, '0987654321');

  const mgrBankNotif = await adminPool.query(
    `SELECT 1 FROM notification
     WHERE user_id = $1
       AND type = 'DEPOSIT_BANK_INFO_UPDATED'
       AND payload->>'deposit_id' = $2`,
    [mgrA.user.sub, depositId]
  );
  assert.ok(mgrBankNotif.rows.length >= 1, 'Must notify BUILDING_MANAGERS when resident updates bank info');

  // MANAGER executes reissue via POST /:id/payout -> PARTIALLY_REFUNDED, amount_held = '0', immutable ledger intact
  const reissueRes = await apiFetch(`/api/v1/deposits/${depositId}/payout`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      evidence: ['https://example.com/unc-2.png'],
      reference_code: 'FT26306002',
    }),
  });
  assert.equal(reissueRes.status, 200, JSON.stringify(reissueRes.body));
  assert.equal(reissueRes.body.data.status, 'PARTIALLY_REFUNDED');
  assert.equal(String(reissueRes.body.data.amount_held), '0');

  const finalLedger = await adminPool.query(
    `SELECT type, amount, reference_code
     FROM deposit_transaction
     WHERE deposit_id = $1
     ORDER BY created_at ASC`,
    [depositId]
  );
  assert.deepEqual(
    finalLedger.rows.map((r) => ({ type: r.type, amount: Number(r.amount) })),
    [
      { type: 'collect', amount: 10000000 },
      { type: 'deduct', amount: 2200000 },
      { type: 'refund', amount: 7800000 },
      { type: 'refund_reversal', amount: 7800000 },
      { type: 'refund', amount: 7800000 },
    ]
  );
});
