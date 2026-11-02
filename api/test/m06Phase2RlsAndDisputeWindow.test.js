import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

test('M06 Phase 2 (Task 1) — Strict PRD 6.2 RLS, Zero adminPool in deposits.js & 7-Day Single-Cycle Dispute Guard', async (t) => {
  await t.test('P2-T1-1: Static check — deposits.js contains zero adminPool references', () => {
    const depositsPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/routes/deposits.js'
    );
    const src = fs.readFileSync(depositsPath, 'utf8');
    const matches = src.match(/\badminPool\b/g) || [];
    assert.equal(
      matches.length,
      0,
      `Expected zero adminPool references in deposits.js, found ${matches.length}`
    );
  });

  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');
  const { default: attachmentsRoute } = await import('../src/routes/attachments.js');

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
  app.use('/api/v1/attachments', attachmentsRoute);

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

  async function withRlsUser(userId, fn) {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(userId)]);
      const result = await fn(client);
      await client.query('ROLLBACK');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const suffix = `${String(Date.now()).slice(-6)}`;
  const cleanup = {
    contractIds: [],
    apartmentIds: [],
    invoiceIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const invId of cleanup.invoiceIds) {
      await adminPool.query('DELETE FROM receivable WHERE invoice_id = $1', [invId]).catch(() => {});
      await adminPool.query('DELETE FROM invoice_line WHERE invoice_id = $1', [invId]).catch(() => {});
      await adminPool.query('DELETE FROM invoice WHERE id = $1', [invId]).catch(() => {});
    }
    for (const cId of cleanup.contractIds) {
      await adminPool.query('DELETE FROM receivable WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool
        .query('DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)', [cId])
        .catch(() => {});
      await adminPool.query('DELETE FROM invoice WHERE contract_id = $1', [cId]).catch(() => {});
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
      await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'apartment' AND owner_id = $1", [aId]).catch(() => {});
      await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
    }
    for (const tId of cleanup.tenantIds) {
      await adminPool.query('DELETE FROM contract_occupant WHERE tenant_id = $1', [tId]).catch(() => {});
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
  const ownerVop = await loginEmail('owner.vop@resihub.vn', 'Demo@123456');

  const otherMgrRow = await adminPool.query(
    `SELECT p.email
     FROM app_user au
     JOIN person p ON p.id = au.person_id
     JOIN user_role ur ON ur.user_id = au.id
     JOIN role r ON r.id = ur.role_id
     JOIN building b ON b.id = ur.building_id
     WHERE r.code = 'MANAGER' AND b.code = 'VSC-A'
     LIMIT 1`
  );
  const mgrOther = await loginEmail(otherMgrRow.rows[0].email, 'Demo@123456');

  // Create apartment, primary resident, co-occupant resident, active contract & deposit on VOP-A
  const aptRes = await apiFetch('/api/v1/apartments', sysAdmin.token, {
    method: 'POST',
    body: JSON.stringify({
      building_id: vopAId,
      floor_id: floorId,
      code: `P2T1-${suffix}`,
      area_m2: 50,
      bedrooms: 1,
      type: '1PN',
      base_rent: 8000000,
    }),
  });
  assert.equal(aptRes.status, 201);
  const apt = aptRes.body.data;
  cleanup.apartmentIds.push(apt.id);

  const resRoleRes = await adminPool.query(
    `SELECT id FROM role WHERE org_id = $1 AND code = 'RESIDENT' LIMIT 1`,
    [orgId]
  );
  const resRoleId = resRoleRes.rows[0].id;
  const pwHash = await bcrypt.hash('Demo@123456', 10);

  async function createResidentAccount(tag, idx, tenantType = 'primary') {
    const email = `p2t1.${tag}.${suffix}@resihub.test`;
    const phone = `096${idx}${suffix}`;
    const p = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, `Cư dân ${tag} ${suffix}`, phone, email, `07920${idx}${suffix}`]
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
    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`,
      [u.rows[0].id, resRoleId]
    );
    const auth = await loginEmail(email, 'Demo@123456');
    return { ...auth, personId: p.rows[0].id, tenantId: tn.rows[0].id, email, phone };
  }

  const primaryRes = await createResidentAccount('pri', '1', 'primary');
  const coOccRes = await createResidentAccount('occ', '2', 'occupant');

  const draftContract = await apiFetch('/api/v1/contracts', mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: apt.id,
      primary_tenant_id: primaryRes.tenantId,
      start_date: isoDaysFromToday(-20),
      end_date: isoDaysFromToday(180),
      rent_amount: 8000000,
      deposit_amount: 8000000,
      billing_day: 5,
    }),
  });
  assert.equal(draftContract.status, 201, JSON.stringify(draftContract.body));
  const contractId = draftContract.body.data.id;
  cleanup.contractIds.push(contractId);

  // Attach co-occupant to contract
  await adminPool.query(
    `INSERT INTO contract_occupant (contract_id, tenant_id, relationship) VALUES ($1, $2, 'SPOUSE')`,
    [contractId, coOccRes.tenantId]
  );

  // Upload scan & activate contract with initial 5M deposit (so 3M can be collected with Base64 evidence)
  const scanRes = await apiFetch(`/api/v1/contracts/${contractId}/scan`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
  });
  assert.equal(scanRes.status, 201, JSON.stringify(scanRes.body));

  const actRes = await apiFetch(`/api/v1/contracts/${contractId}/activate`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(actRes.status, 200, JSON.stringify(actRes.body));

  const depRowRes = await adminPool.query(`SELECT * FROM deposit WHERE contract_id = $1`, [contractId]);
  const depositId = depRowRes.rows[0].id;

  const initCollectRes = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      type: 'collect',
      amount: 5000000,
      method: 'BANK_TRANSFER',
      description: 'Thu đợt 1 tiền cọc hợp đồng',
    }),
  });
  assert.equal(initCollectRes.status, 201, JSON.stringify(initCollectRes.body));

  // Create an open invoice for RLS test
  const invIns = await adminPool.query(
    `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_code, period, due_date, subtotal_amount, total_amount, paid_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-10', CURRENT_DATE + 5, 500000, 500000, 0, 'ISSUED')
     RETURNING id`,
    [orgId, vopAId, apt.id, contractId, primaryRes.tenantId, `INV-P2T1-${suffix}`]
  );
  const invoiceId = invIns.rows[0].id;
  cleanup.invoiceIds.push(invoiceId);
  await adminPool.query(
    `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
     VALUES ($1, 'ELECTRICITY', 'Điện kỳ cuối', 100, 'kWh', 5000, 500000)`,
    [invoiceId]
  );

  await t.test('P2-T1-2: Direct appPool RLS + co-occupant 200 + unassigned MANAGER 403 ACCESS_DENIED + Base64 evidence', async () => {
    // Active owner check on VOP-A
    const activeOwnerCheck = await adminPool.query(
      `SELECT building_has_active_owner($1) AS has_owner`,
      [vopAId]
    );
    assert.equal(activeOwnerCheck.rows[0].has_owner, true);

    // 2a. OWNER of VOP-A cannot directly UPDATE invoice, INSERT INTO receivable, UPDATE apartment, or UPDATE HELD deposit
    await withRlsUser(ownerVop.user.sub, async (client) => {
      const updInv = await client.query(
        `UPDATE invoice SET paid_amount = 100 WHERE id = $1`,
        [invoiceId]
      );
      assert.equal(updInv.rowCount, 0, 'OWNER must not directly UPDATE invoice');

      await client.query('SAVEPOINT sp_rec');
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO receivable (org_id, building_id, contract_id, tenant_id, deposit_id, type, amount, status)
             VALUES ($1, $2, $3, $4, $5, 'OTHER', 100000, 'OPEN')`,
            [orgId, vopAId, contractId, primaryRes.tenantId, depositId]
          ),
        (err) => err.code === '42501',
        'OWNER must not directly INSERT INTO receivable'
      );
      await client.query('ROLLBACK TO SAVEPOINT sp_rec');

      const updApt = await client.query(
        `UPDATE apartment SET status = 'MAINTENANCE' WHERE id = $1`,
        [apt.id]
      );
      assert.equal(updApt.rowCount, 0, 'OWNER must not directly UPDATE apartment');

      const updHeldDep = await client.query(
        `UPDATE deposit SET amount_held = 999999 WHERE id = $1`,
        [depositId]
      );
      assert.equal(updHeldDep.rowCount, 0, 'OWNER must not directly UPDATE deposit when status = HELD');
    });

    // 2b. SYS_ADMIN cannot directly INSERT INTO deposit_transaction or UPDATE deposit on VOP-A (which has active OWNER)
    await withRlsUser(sysAdmin.user.sub, async (client) => {
      await client.query('SAVEPOINT sp_sys_txn');
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO deposit_transaction (deposit_id, type, amount, description, method, status, created_by)
             VALUES ($1, 'collect', 100000, 'SYS_ADMIN direct write test', 'CASH', 'APPROVED', $2)`,
            [depositId, sysAdmin.user.sub]
          ),
        (err) => err.code === '42501',
        'SYS_ADMIN must not directly INSERT INTO deposit_transaction on building with active OWNER'
      );
      await client.query('ROLLBACK TO SAVEPOINT sp_sys_txn');

      const sysUpdDep = await client.query(
        `UPDATE deposit SET amount_held = 777777 WHERE id = $1`,
        [depositId]
      );
      assert.equal(sysUpdDep.rowCount, 0, 'SYS_ADMIN must not directly UPDATE deposit on building with active OWNER');
    });

    // 2c. Base64 evidence upload on collect normalizes to /api/v1/attachments/<id>/view
    const collectRes = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        type: 'collect',
        amount: 3000000,
        method: 'BANK_TRANSFER',
        description: 'Thu đủ cọc kèm ảnh UNC base64',
        evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(collectRes.status, 201, JSON.stringify(collectRes.body));
    assert.equal(Array.isArray(collectRes.body.data.evidence), true);
    assert.match(collectRes.body.data.evidence[0], /^\/api\/v1\/attachments\/[0-9a-f-]+\/view$/i);

    // 2d. Co-occupant RESIDENT receives 200 on transactions, settlement, and settlement/pdf
    const occTx = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, coOccRes.token);
    assert.equal(occTx.status, 200, JSON.stringify(occTx.body));
    assert.ok(occTx.body.data.length >= 2);

    const occSettle = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, coOccRes.token);
    assert.equal(occSettle.status, 200, JSON.stringify(occSettle.body));

    const occPdf = await apiFetch(`/api/v1/deposits/${depositId}/settlement/pdf`, coOccRes.token);
    assert.equal(occPdf.status, 200);
    assert.match(occPdf.body.raw || '', /BIÊN BẢN TẤT TOÁN/);

    // 2e. Unassigned MANAGER (VSC-A) receives 403 ACCESS_DENIED and logs ACCESS_DENIED in audit_log
    const denyTx = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, mgrOther.token);
    assert.equal(denyTx.status, 403);
    assert.equal(denyTx.body?.code, 'ACCESS_DENIED');

    const auditDeny = await adminPool.query(
      `SELECT id FROM audit_log
       WHERE actor_id = $1 AND action = 'ACCESS_DENIED' AND entity = 'deposit' AND entity_id = $2`,
      [mgrOther.user.sub, depositId]
    );
    assert.ok(auditDeny.rows.length >= 1, 'Expected ACCESS_DENIED audit_log entry');
  });

  await t.test('P2-T1-3: 7-day dispute window, ALREADY_PAID_OUT on ADJUST, Four-Eyes CONFIRM & single-cycle lock', async () => {
    // Terminate contract & submit DEDUCTED_FULL settlement (8M damages + 500k service debt > 8M deposit -> refund = 0)
    const termRes = await apiFetch(`/api/v1/contracts/${contractId}/terminate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Hết nhu cầu thuê P2-T1' }),
    });
    assert.equal(termRes.status, 200, JSON.stringify(termRes.body));

    const subSettle = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            category: 'DAMAGE',
            amount: 8000000,
            description: 'Hư hỏng sàn gỗ toàn bộ căn hộ',
            evidence: [TINY_PNG_B64],
          },
        ],
        inspection_evidence: [TINY_PNG_B64],
        refund_method: 'CASH',
      }),
    });
    assert.equal(subSettle.status, 200, JSON.stringify(subSettle.body));

    // Backdate finalized settlement > 7 days first to verify DISPUTE_WINDOW_EXPIRED
    const eightDaysAgoIso = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    await adminPool.query(
      `UPDATE deposit
       SET status = 'DEDUCTED_FULL',
           amount_held = 0,
           settlement = settlement || jsonb_build_object(
             'approved_by', $2::text,
             'approved_at', $3::text,
             'accounting_committed_at', $3::text
           )
       WHERE id = $1`,
      [depositId, ownerVop.user.sub, eightDaysAgoIso]
    );

    const expiredDispute = await apiFetch(`/api/v1/deposits/${depositId}/dispute`, primaryRes.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Khiếu nại sau 8 ngày' }),
    });
    assert.equal(expiredDispute.status, 409, JSON.stringify(expiredDispute.body));
    assert.equal(expiredDispute.body?.code, 'DISPUTE_WINDOW_EXPIRED');

    // Now set finalized timestamp within 7 days (2 days ago)
    const twoDaysAgoIso = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    await adminPool.query(
      `UPDATE deposit
       SET settlement = settlement || jsonb_build_object(
             'approved_at', $2::text,
             'payout_at', $2::text,
             'accounting_committed_at', $2::text
           )
       WHERE id = $1`,
      [depositId, twoDaysAgoIso]
    );

    // Within 7 days -> RESIDENT dispute succeeds -> DISPUTED + SETTLEMENT_DISPUTE audit_log
    const okDispute = await apiFetch(`/api/v1/deposits/${depositId}/dispute`, primaryRes.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Đề nghị xem lại mức khấu trừ sàn gỗ' }),
    });
    assert.equal(okDispute.status, 200, JSON.stringify(okDispute.body));
    assert.equal(okDispute.body?.data?.status, 'DISPUTED');
    assert.ok(
      Array.isArray(okDispute.body?.data?.settlement?.dispute_thread) &&
        okDispute.body.data.settlement.dispute_thread.some((e) => e.type === 'DISPUTE')
    );

    const disputeAudit = await adminPool.query(
      `SELECT id FROM audit_log WHERE entity = 'deposit' AND entity_id = $1 AND action = 'SETTLEMENT_DISPUTE'`,
      [depositId]
    );
    assert.ok(disputeAudit.rows.length >= 1, 'Expected SETTLEMENT_DISPUTE audit log');

    // Post-accounting ADJUST must fail 409 ALREADY_PAID_OUT
    const adjustAfterCommit = await apiFetch(
      `/api/v1/deposits/${depositId}/resolve-dispute`,
      ownerVop.token,
      {
        method: 'POST',
        body: JSON.stringify({ resolution: 'ADJUST', notes: 'Thử mở lại sau khi đã chốt sổ' }),
      }
    );
    assert.equal(adjustAfterCommit.status, 409, JSON.stringify(adjustAfterCommit.body));
    assert.equal(adjustAfterCommit.body?.code, 'ALREADY_PAID_OUT');

    // Creator MANAGER_A attempting CONFIRM must fail 403 SELF_APPROVAL
    const creatorConfirm = await apiFetch(
      `/api/v1/deposits/${depositId}/resolve-dispute`,
      mgrA.token,
      {
        method: 'POST',
        body: JSON.stringify({ resolution: 'CONFIRM', notes: 'Tự đóng khiếu nại bảng kê của mình' }),
      }
    );
    assert.equal(creatorConfirm.status, 403, JSON.stringify(creatorConfirm.body));
    assert.equal(creatorConfirm.body?.code, 'SELF_APPROVAL');

    // OWNER resolving CONFIRM succeeds (200), restores DEDUCTED_FULL, sets post_settlement_dispute_closed = true
    const ownerConfirm = await apiFetch(
      `/api/v1/deposits/${depositId}/resolve-dispute`,
      ownerVop.token,
      {
        method: 'POST',
        body: JSON.stringify({ resolution: 'CONFIRM', notes: 'Đã đối chiếu biên bản và giữ nguyên kết quả' }),
      }
    );
    assert.equal(ownerConfirm.status, 200, JSON.stringify(ownerConfirm.body));
    assert.equal(ownerConfirm.body?.data?.status, 'DEDUCTED_FULL');
    assert.equal(ownerConfirm.body?.data?.settlement?.post_settlement_dispute_closed, true);

    // Re-submitting dispute even within 7 days must fail 409 DISPUTE_ALREADY_FINALIZED
    const secondDispute = await apiFetch(`/api/v1/deposits/${depositId}/dispute`, primaryRes.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Khiếu nại lần 2 sau khi đã chốt cuối cùng' }),
    });
    assert.equal(secondDispute.status, 409, JSON.stringify(secondDispute.body));
    assert.equal(secondDispute.body?.code, 'DISPUTE_ALREADY_FINALIZED');
  });
});
