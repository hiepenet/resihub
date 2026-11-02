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

test('M06 Post-Review Fixes (3.2, 3.3, 3.4, 3.5.1, 3.5.2)', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');
  const { default: reservationsRoute } = await import('../src/routes/reservations.js');
  const { default: metersRoute } = await import('../src/routes/meters.js');
  const { default: invoicesRoute } = await import('../src/routes/invoices.js');
  const { default: settingsRoute } = await import('../src/routes/settings.js');
  const { refundDeadline } = await import('../src/services/deadlines.js');
  const {
    runOverdueDepositSettlementAlerts,
    sendMonthlyOwnerDepositReports,
  } = await import('../src/jobs/daily.js');

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
  app.use('/api/v1/meters', metersRoute);
  app.use('/api/v1/invoices', invoicesRoute);
  app.use('/api/v1/settings', settingsRoute);

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
  const todayStr = isoDaysFromToday(0);
  const currentPeriod = todayStr.slice(0, 7);

  const cleanup = {
    invoiceIds: [],
    meterIds: [],
    reservationIds: [],
    contractIds: [],
    apartmentIds: [],
    floorIds: [],
    buildingIds: [],
    ownerIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
  };

  const orgRes = await adminPool.query(`SELECT org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const orgId = orgRes.rows[0].org_id;
  const origSlaRes = await adminPool.query(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'sla_config' LIMIT 1`,
    [orgId]
  );
  const origSlaExisted = origSlaRes.rows.length > 0;
  const origSlaValue = origSlaRes.rows[0]?.value || null;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));

    await adminPool
      .query(
        `DELETE FROM notification WHERE type = 'MONTHLY_DEPOSIT_REPORT' AND (payload->>'period') = '2026-08'`
      )
      .catch(() => {});

    if (origSlaExisted) {
      await adminPool
        .query(`UPDATE system_setting SET value = $2, updated_at = NOW() WHERE org_id = $1 AND key = 'sla_config'`, [
          orgId,
          JSON.stringify(origSlaValue),
        ])
        .catch(() => {});
    } else {
      await adminPool
        .query(`DELETE FROM system_setting WHERE org_id = $1 AND key = 'sla_config'`, [orgId])
        .catch(() => {});
    }

    for (const invId of cleanup.invoiceIds) {
      await adminPool.query('DELETE FROM receivable WHERE invoice_id = $1', [invId]).catch(() => {});
      await adminPool.query('DELETE FROM invoice_line WHERE invoice_id = $1', [invId]).catch(() => {});
      await adminPool.query('DELETE FROM invoice WHERE id = $1', [invId]).catch(() => {});
    }
    for (const mId of cleanup.meterIds) {
      await adminPool.query('DELETE FROM meter_reading WHERE meter_id = $1', [mId]).catch(() => {});
      await adminPool.query('DELETE FROM meter WHERE id = $1', [mId]).catch(() => {});
    }
    for (const rId of cleanup.reservationIds) {
      await adminPool
        .query(`DELETE FROM attachment WHERE owner_entity = 'reservation' AND owner_id = $1`, [rId])
        .catch(() => {});
      await adminPool.query('DELETE FROM reservation WHERE id = $1', [rId]).catch(() => {});
    }
    for (const cId of cleanup.contractIds) {
      await adminPool.query('DELETE FROM receivable WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM invoice WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
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
      await adminPool
        .query("DELETE FROM attachment WHERE owner_entity = 'contract' AND owner_id = $1", [cId])
        .catch(() => {});
      await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query('DELETE FROM meter_reading WHERE meter_id IN (SELECT id FROM meter WHERE apartment_id = $1)', [aId]).catch(() => {});
      await adminPool.query('DELETE FROM meter WHERE apartment_id = $1', [aId]).catch(() => {});
      await adminPool
        .query("DELETE FROM attachment WHERE owner_entity = 'apartment' AND owner_id = $1", [aId])
        .catch(() => {});
      await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
    }
    for (const fId of cleanup.floorIds) {
      await adminPool.query('DELETE FROM floor WHERE id = $1', [fId]).catch(() => {});
    }
    for (const bId of cleanup.buildingIds) {
      await adminPool.query('DELETE FROM notification WHERE payload::text LIKE $1', [`%${bId}%`]).catch(() => {});
      await adminPool.query('DELETE FROM user_role WHERE building_id = $1', [bId]).catch(() => {});
      await adminPool.query('DELETE FROM building WHERE id = $1', [bId]).catch(() => {});
    }
    for (const oId of cleanup.ownerIds) {
      await adminPool.query('DELETE FROM owner WHERE id = $1', [oId]).catch(() => {});
    }
    for (const tId of cleanup.tenantIds) {
      await adminPool.query('DELETE FROM tenant WHERE id = $1', [tId]).catch(() => {});
    }
    for (const uId of cleanup.userIds) {
      await adminPool.query('DELETE FROM notification WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM idempotency_key WHERE actor_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool
        .query(
          `DELETE FROM app_user WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log WHERE actor_id = $1)`,
          [uId]
        )
        .catch(() => {});
    }
    for (const pId of cleanup.personIds) {
      await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [pId]).catch(() => {});
      await adminPool
        .query('DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId])
        .catch(() => {});
      await adminPool
        .query(
          `DELETE FROM app_user u WHERE u.person_id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_id = u.id)`,
          [pId]
        )
        .catch(() => {});
      await adminPool
        .query(
          `DELETE FROM person WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM app_user WHERE person_id = $1)`,
          [pId]
        )
        .catch(() => {});
    }
    await appPool.end().catch(() => {});
    await adminPool.end().catch(() => {});
  });

  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const pwHash = await bcrypt.hash('Demo@123456', 10);
  const rolesRes = await adminPool.query(
    `SELECT code, id FROM role WHERE org_id = $1 AND code IN ('OWNER', 'MANAGER', 'RESIDENT')`,
    [orgId]
  );
  const roleMap = Object.fromEntries(rolesRes.rows.map((r) => [r.code, r.id]));

  // Isolated building with dedicated OWNER & MANAGER
  const ownerEmail = `pr.owner.${suffix}@resihub.test`;
  const ownerPhone = `0931${suffix}`;
  const ownerPersonRes = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Chủ Tòa PR ${suffix}`, ownerPhone, ownerEmail, `079801${suffix}`]
  );
  cleanup.personIds.push(ownerPersonRes.rows[0].id);
  const ownerRecRes = await adminPool.query(
    `INSERT INTO owner (org_id, person_id, full_name, phone, email) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, ownerPersonRes.rows[0].id, `Chủ Tòa PR ${suffix}`, ownerPhone, ownerEmail]
  );
  cleanup.ownerIds.push(ownerRecRes.rows[0].id);
  const ownerUserRes = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [ownerPersonRes.rows[0].id, pwHash]
  );
  cleanup.userIds.push(ownerUserRes.rows[0].id);
  await adminPool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [
    ownerUserRes.rows[0].id,
    roleMap.OWNER,
  ]);

  const bldRes = await adminPool.query(
    `INSERT INTO building (org_id, owner_id, code, name, address)
     VALUES ($1, $2, $3, $4, '456 PR Street') RETURNING id`,
    [orgId, ownerRecRes.rows[0].id, `PRB-${suffix}`, `Tòa PR ${suffix}`]
  );
  const testBuildingId = bldRes.rows[0].id;
  cleanup.buildingIds.push(testBuildingId);

  const flrRes = await adminPool.query(
    `INSERT INTO floor (building_id, level, name) VALUES ($1, 1, 'Tầng 1') RETURNING id`,
    [testBuildingId]
  );
  const testFloorId = flrRes.rows[0].id;
  cleanup.floorIds.push(testFloorId);

  const mgrEmail = `pr.mgr.${suffix}@resihub.test`;
  const mgrPhone = `0932${suffix}`;
  const mgrPersonRes = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Quản lý PR ${suffix}`, mgrPhone, mgrEmail, `079802${suffix}`]
  );
  cleanup.personIds.push(mgrPersonRes.rows[0].id);
  const mgrUserRes = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [mgrPersonRes.rows[0].id, pwHash]
  );
  cleanup.userIds.push(mgrUserRes.rows[0].id);
  await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
    [mgrUserRes.rows[0].id, roleMap.MANAGER, testBuildingId]
  );

  const ownerAuth = { ...(await loginEmail(ownerEmail, 'Demo@123456')), userId: ownerUserRes.rows[0].id };
  const mgrAuth = { ...(await loginEmail(mgrEmail, 'Demo@123456')), userId: mgrUserRes.rows[0].id };

  async function createApt(prefix, baseRent = 10000000) {
    const r = await apiFetch('/api/v1/apartments', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: testBuildingId,
        floor_id: testFloorId,
        code: `${prefix}-${suffix}`,
        area_m2: 50,
        bedrooms: 1,
        type: '1PN',
        base_rent: baseRent,
      }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    cleanup.apartmentIds.push(r.body.data.id);
    return r.body.data;
  }

  async function trackResidentByPhone(phone) {
    const pRes = await adminPool.query(`SELECT id FROM person WHERE phone = $1`, [phone]);
    for (const row of pRes.rows) {
      cleanup.personIds.push(row.id);
      const tRes = await adminPool.query(`SELECT id FROM tenant WHERE person_id = $1`, [row.id]);
      for (const tr of tRes.rows) cleanup.tenantIds.push(tr.id);
      const uRes = await adminPool.query(`SELECT id FROM app_user WHERE person_id = $1`, [row.id]);
      for (const ur of uRes.rows) cleanup.userIds.push(ur.id);
    }
  }

  async function createActiveContractWithDeposit({ aptId, rentAmount, depositAmount, phoneTag }) {
    const phone = `0933${phoneTag}${suffix.slice(-5)}`;
    const cRes = await apiFetch('/api/v1/contracts', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptId,
        start_date: todayStr,
        end_date: isoDaysFromToday(120),
        rent_amount: rentAmount,
        deposit_amount: depositAmount,
        billing_day: 1,
        new_tenant: {
          full_name: `Cư dân PR ${phoneTag} ${suffix}`,
          phone,
          email: `pr.res.${phoneTag}.${suffix}@resihub.test`,
          id_number: `07981${phoneTag}${suffix}`,
          password: 'Password@123',
        },
      }),
    });
    assert.equal(cRes.status, 201, JSON.stringify(cRes.body));
    const cId = cRes.body.data.id;
    cleanup.contractIds.push(cId);
    await trackResidentByPhone(phone);

    await apiFetch(`/api/v1/contracts/${cId}/scan`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    const actRes = await apiFetch(`/api/v1/contracts/${cId}/activate`, mgrAuth.token, { method: 'POST' });
    assert.equal(actRes.status, 200, JSON.stringify(actRes.body));

    const depRes = await adminPool.query(`SELECT * FROM deposit WHERE contract_id = $1`, [cId]);
    const dep = depRes.rows[0];
    if (depositAmount > 0) {
      const colRes = await apiFetch(`/api/v1/deposits/${dep.id}/transactions`, mgrAuth.token, {
        method: 'POST',
        body: JSON.stringify({
          type: 'collect',
          amount: depositAmount,
          method: 'CASH',
          description: 'Thu cọc hợp đồng kiểm thử',
        }),
      });
      assert.equal(colRes.status, 201, JSON.stringify(colRes.body));
    }
    return { contractId: cId, depositId: dep?.id || null };
  }

  // =========================================================================
  // 1. Item 3.2 (FR-024): Block settlement when final meter reading has consumption > 0 but no final invoice is issued
  // =========================================================================
  await t.test('3.2: Settlement blocked by 409 UNBILLED_FINAL_METER_READING until final invoice is issued', async () => {
    const apt1 = await createApt('MTR', 10000000);
    const { contractId, depositId } = await createActiveContractWithDeposit({
      aptId: apt1.id,
      rentAmount: 10000000,
      depositAmount: 10000000,
      phoneTag: '1',
    });

    const mRes = await apiFetch('/api/v1/meters', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt1.id,
        meter_type: 'ELECTRICITY',
        unit_price: 4000,
        initial_reading: 100,
      }),
    });
    assert.equal(mReadStatus(mRes), 201, JSON.stringify(mRes.body));
    const meterId = mRes.body.data.id;
    cleanup.meterIds.push(meterId);

    const termRes = await apiFetch(`/api/v1/contracts/${contractId}/terminate`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Thanh lý kiểm thử FR-024 công tơ chưa lên hóa đơn' }),
    });
    assert.equal(termRes.status, 200, JSON.stringify(termRes.body));

    // Record final meter reading with consumption = 50 kWh (> 0), NO invoice generated yet
    const readRes = await apiFetch(`/api/v1/meters/${meterId}/readings`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ period: currentPeriod, current_reading: 150, image_base64: TINY_PNG_B64 }),
    });
    assert.equal(readRes.status, 201, JSON.stringify(readRes.body));

    const getSettlePre = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrAuth.token);
    assert.equal(getSettlePre.status, 200);
    assert.equal(getSettlePre.body.data.preconditions.final_meters_recorded, true);
    assert.equal(getSettlePre.body.data.preconditions.final_invoice_issued, false);
    assert.equal(getSettlePre.body.data.preconditions.ready, false);
    assert.deepEqual(getSettlePre.body.data.preconditions.unbilled_meter_types, ['ELECTRICITY']);

    const blockedUnbilled = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        inspection_evidence: [TINY_PNG_B64],
        refund_method: 'CASH',
      }),
    });
    assert.equal(blockedUnbilled.status, 409, JSON.stringify(blockedUnbilled.body));
    assert.equal(blockedUnbilled.body.code, 'UNBILLED_FINAL_METER_READING');

    // Generate batch invoice (DRAFT) -> should now hit 409 UNPUBLISHED_INVOICE
    const genInv = await apiFetch('/api/v1/invoices/generate-batch', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ building_id: testBuildingId, period: currentPeriod, auto_issue: false }),
    });
    assert.equal(genInv.status, 201, JSON.stringify(genInv.body));
    for (const inv of genInv.body.data || []) cleanup.invoiceIds.push(inv.id);
    const finalInv = (genInv.body.data || []).find((i) => i.contract_id === contractId);
    assert.ok(finalInv, 'Phải sinh được hóa đơn kỳ cuối');

    const blockedDraft = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        inspection_evidence: [TINY_PNG_B64],
        refund_method: 'CASH',
      }),
    });
    assert.equal(blockedDraft.status, 409);
    assert.equal(blockedDraft.body.code, 'UNPUBLISHED_INVOICE');

    // Issue invoice -> settlement succeeds & deducts electricity service debt!
    const issueRes = await apiFetch(`/api/v1/invoices/${finalInv.id}/status`, mgrAuth.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ISSUED' }),
    });
    assert.equal(issueRes.status, 200, JSON.stringify(issueRes.body));

    const okSettle = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        inspection_evidence: [TINY_PNG_B64],
        refund_method: 'CASH',
      }),
    });
    assert.equal(okSettle.status, 200, JSON.stringify(okSettle.body));
    assert.ok(Number(okSettle.body.data.settlement.service_debt) >= 200000);
  });

  // =========================================================================
  // 2. Item 3.3 (FR-025 & FR-013): Room transfer routes >10% rent discount through DRAFT -> scan -> PENDING_APPROVAL -> OWNER approve & surfaces surplus_deposit_amount
  // =========================================================================
  await t.test('3.3: transfer-room routes >10% rent discount through PENDING_APPROVAL and surfaces surplus_deposit_amount on OWNER approve', async () => {
    const aptFrom = await createApt('TF1', 12000000);
    const aptTo = await createApt('TF2', 10000000);
    const { contractId: oldContractId, depositId: oldDepositId } = await createActiveContractWithDeposit({
      aptId: aptFrom.id,
      rentAmount: 12000000,
      depositAmount: 12000000,
      phoneTag: '2',
    });

    // Discounted transfer (8,500,000 < 90% of 10,000,000) with lower deposit (8,000,000 vs 12,000,000 held -> surplus 4,000,000) creates DRAFT
    const discountedTransfer = await apiFetch(`/api/v1/contracts/${oldContractId}/transfer-room`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        new_apartment_id: aptTo.id,
        new_start_date: todayStr,
        new_end_date: isoDaysFromToday(150),
        new_rent_amount: 8500000,
        new_deposit_amount: 8000000,
        transfer_deposit: true,
      }),
    });
    assert.equal(discountedTransfer.status, 201, JSON.stringify(discountedTransfer.body));
    const trContractId = discountedTransfer.body.data.new_contract.id;
    cleanup.contractIds.push(trContractId);
    assert.equal(discountedTransfer.body.data.new_contract.status, 'DRAFT');

    // Old contract MUST remain ACTIVE while in DRAFT
    const oldCheck = await adminPool.query(`SELECT status FROM contract WHERE id = $1`, [oldContractId]);
    assert.equal(oldCheck.rows[0].status, 'ACTIVE');

    // Upload signed scan & submit activate -> 409 PRICE_NEEDS_APPROVAL (PENDING_APPROVAL)
    await apiFetch(`/api/v1/contracts/${trContractId}/scan`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    const actTr = await apiFetch(`/api/v1/contracts/${trContractId}/activate`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(actTr.status, 409, JSON.stringify(actTr.body));
    assert.equal(actTr.body.code, 'PRICE_NEEDS_APPROVAL');

    // OWNER approves -> 200 ACTIVE + surplus 4,000,000
    const appTr = await apiFetch(`/api/v1/contracts/${trContractId}/approve`, ownerAuth.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(appTr.status, 200, JSON.stringify(appTr.body));
    assert.equal(appTr.body.surplus_deposit_amount, 4000000);
    assert.equal(appTr.body.old_deposit_id, oldDepositId);
    assert.match(appTr.body.message, /4\.000\.000/);
  });

  // =========================================================================
  // 3. Item 3.4 (PRD 7.5): Reservation cancel-settle requires UNC evidence when BANK_TRANSFER & refunded_amount > 0
  // =========================================================================
  await t.test('3.4: separated cancel-settle -> cancel-approve -> cancel-payout requires refund_evidence for BANK_TRANSFER refund > 0', async () => {
    const aptRsv = await createApt('RSV', 9000000);
    const createRsv = await apiFetch('/api/v1/reservations', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptRsv.id,
        prospect_name: `Khách Giữ Chỗ PR ${suffix}`,
        phone: `0935${suffix}`,
        hold_amount: 2000000,
        method: 'CASH',
        hold_from: todayStr,
        hold_until: isoDaysFromToday(5),
      }),
    });
    assert.equal(createRsv.status, 201, JSON.stringify(createRsv.body));
    const rsvId = createRsv.body.data.id;
    cleanup.reservationIds.push(rsvId);

    const propRsv = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-settle`, mgrAuth.token, {
      method: 'PATCH',
      body: JSON.stringify({
        refunded_amount: 1000000,
        forfeited_amount: 1000000,
        reason: 'Khách hủy giữ chỗ hoàn 50% chuyển khoản',
        refund_method: 'BANK_TRANSFER',
        refund_bank_info: {
          bank_name: 'Vietcombank',
          account_number: '0123456789',
          account_holder: 'KHACH GIU CHO PR',
        },
      }),
    });
    assert.equal(propRsv.status, 200, JSON.stringify(propRsv.body));
    assert.equal(propRsv.body.data.status, 'CANCEL_PENDING_APPROVAL');

    const appRsv = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-approve`, ownerAuth.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(appRsv.status, 200, JSON.stringify(appRsv.body));
    assert.equal(appRsv.body.data.status, 'APPROVED_PENDING_PAYOUT');

    const noUnc = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-payout`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        refund_evidence: [],
      }),
    });
    assert.equal(noUnc.status, 422, JSON.stringify(noUnc.body));
    assert.equal(noUnc.body.code, 'REFUND_EVIDENCE_REQUIRED');

    const withUnc = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-payout`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        refund_evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(withUnc.status, 200, JSON.stringify(withUnc.body));
    assert.equal(withUnc.body.data.status, 'PARTIALLY_REFUNDED');
  });

  // =========================================================================
  // 4. Item 3.5.1 (FR-005 & FR-068): sla_config.deposit_refund_days wired into refundDeadline, terminate, and overdue alerts
  // =========================================================================
  await t.test('3.5.1: sla_config.deposit_refund_days dynamically controls refund_due_date and overdue alert thresholds', async () => {
    assert.deepEqual(refundDeadline('2026-10-01'), { warnAt: '2026-10-04', dueAt: '2026-10-06' });
    assert.deepEqual(refundDeadline('2026-10-01', 7), { warnAt: '2026-10-06', dueAt: '2026-10-08' });

    const putSla = await apiFetch('/api/v1/settings', sysAdmin.token, {
      method: 'PUT',
      body: JSON.stringify({
        sla_config: {
          ...(origSlaValue || {}),
          deposit_refund_days: 7,
        },
      }),
    });
    assert.equal(putSla.status, 200, JSON.stringify(putSla.body));

    const aptSla = await createApt('SLA', 8000000);
    const { contractId, depositId } = await createActiveContractWithDeposit({
      aptId: aptSla.id,
      rentAmount: 8000000,
      depositAmount: 8000000,
      phoneTag: '4',
    });

    const termRes = await apiFetch(`/api/v1/contracts/${contractId}/terminate`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Kiểm thử SLA hoàn cọc 7 ngày' }),
    });
    assert.equal(termRes.status, 200, JSON.stringify(termRes.body));

    const depCheck = await adminPool.query(
      `SELECT refund_due_date::text AS due_str FROM deposit WHERE id = $1`,
      [depositId]
    );
    assert.equal(depCheck.rows[0].due_str, isoDaysFromToday(7));

    // Simulate 5 days elapsed under 7-day SLA (2 days left -> WARNING, NOT OVERDUE!)
    await adminPool.query(
      `UPDATE contract SET start_date = $2::date, terminated_at = $3::date WHERE id = $1`,
      [contractId, isoDaysFromToday(-30), isoDaysFromToday(-5)]
    );
    await adminPool.query(`UPDATE deposit SET refund_due_date = $2::date WHERE id = $1`, [
      depositId,
      isoDaysFromToday(2),
    ]);

    await runOverdueDepositSettlementAlerts();

    const notifRes = await adminPool.query(
      `SELECT type, title FROM notification WHERE user_id = $1 AND (payload->>'deposit_id') = $2`,
      [mgrAuth.userId, depositId]
    );
    assert.equal(notifRes.rows.length, 1);
    assert.equal(notifRes.rows[0].type, 'DEPOSIT_WARNING_3D');
  });

  // =========================================================================
  // 5. Item 3.5.2 (GAP-05 / RP-07): sendMonthlyOwnerDepositReports subtracts refund_reversal from refund
  // =========================================================================
  await t.test('3.5.2: sendMonthlyOwnerDepositReports nets out refund_reversal transactions', async () => {
    const aptRep = await createApt('REP', 8000000);
    const { contractId: repContractId } = await createActiveContractWithDeposit({
      aptId: aptRep.id,
      rentAmount: 8000000,
      depositAmount: 0,
      phoneTag: '5',
    });
    const depIns = await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status) VALUES ($1, 8000000, 'HELD') RETURNING id`,
      [repContractId]
    );
    const depositId = depIns.rows[0].id;

    // Insert collect + refund + refund_reversal in 2026-08 so net refunded in 2026-08 is 0
    await adminPool.query(
      `INSERT INTO deposit_transaction (deposit_id, type, category, amount, description, method, status, approved_by, approved_at, created_by, created_at)
       VALUES
         ($1, 'collect', 'DEPOSIT_IN', 8000000, 'Thu cọc kỳ 08/2026', 'CASH', 'APPROVED', $2, '2026-08-10T09:00:00+07:00', $2, '2026-08-10T09:00:00+07:00'),
         ($1, 'refund', 'REFUND', 5000000, 'Chi hoàn UNC kỳ 08/2026', 'BANK_TRANSFER', 'APPROVED', $2, '2026-08-20T10:00:00+07:00', $2, '2026-08-20T10:00:00+07:00'),
         ($1, 'refund_reversal', 'REFUND_REVERSAL', 5000000, 'Ngân hàng trả lại lệnh chi kỳ 08/2026', 'BANK_TRANSFER', 'APPROVED', $2, '2026-08-21T10:00:00+07:00', $2, '2026-08-21T10:00:00+07:00')`,
      [depositId, mgrAuth.userId]
    );

    await sendMonthlyOwnerDepositReports(adminPool, new Date('2026-09-02T09:00:00+07:00'));

    const digestRes = await adminPool.query(
      `SELECT payload FROM notification
       WHERE user_id = $1
         AND type = 'MONTHLY_DEPOSIT_REPORT'
         AND (payload->>'building_id') = $2
         AND (payload->>'period') = '2026-08'`,
      [ownerAuth.userId, testBuildingId]
    );
    assert.equal(digestRes.rows.length, 1);
    assert.equal(Number(digestRes.rows[0].payload.collected), 8000000);
    assert.equal(Number(digestRes.rows[0].payload.refunded), 0);
  });
});

function mReadStatus(r) {
  return r.status;
}
