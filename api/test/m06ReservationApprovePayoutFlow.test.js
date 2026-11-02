import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
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

test('M06 Task 4 — Separated Reservation Cancel-Settlement (Propose -> Approve/Reject -> Payout with UNC), Direct-Refund Alignment, RP-07 Conservation & Resident Overview', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');
  const { default: reservationsRoute } = await import('../src/routes/reservations.js');
  const { default: reportsRoute } = await import('../src/routes/reports.js');
  const { default: publicRoute } = await import('../src/routes/public.js');
  const { default: residentRoute } = await import('../src/routes/resident.js');
  const { runDailyJobs } = await import('../src/jobs/daily.js');

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
  app.use('/api/v1/reservations', reservationsRoute);
  app.use('/api/v1/reports', reportsRoute);
  app.use('/api/v1/public', publicRoute);
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
    if (options.rawBuffer) {
      const arrayBuf = await res.arrayBuffer();
      return { status: res.status, headers: res.headers, contentType, buffer: Buffer.from(arrayBuf) };
    }
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
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
    reservationIds: [],
    apartmentIds: [],
    floorIds: [],
    buildingIds: [],
    ownerIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const rId of cleanup.reservationIds) {
      await adminPool.query('DELETE FROM notification WHERE payload::text LIKE $1', [`%${rId}%`]).catch(() => {});
      await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'reservation' AND owner_id = $1", [rId]).catch(() => {});
      await adminPool.query('DELETE FROM reservation WHERE id = $1', [rId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
    }
    for (const fId of cleanup.floorIds) {
      await adminPool.query('DELETE FROM floor WHERE id = $1', [fId]).catch(() => {});
    }
    for (const bId of cleanup.buildingIds) {
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
      await adminPool.query('DELETE FROM app_user WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log WHERE actor_id = $1)', [uId]).catch(() => {});
    }
    for (const pId of cleanup.personIds) {
      await adminPool.query('DELETE FROM person WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM app_user WHERE person_id = $1)', [pId]).catch(() => {});
    }
    await appPool.end().catch(() => {});
    await adminPool.end().catch(() => {});
  });

  const orgRes = await adminPool.query(`SELECT org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const orgId = orgRes.rows[0].org_id;
  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');

  const rolesRes = await adminPool.query(
    `SELECT code, id FROM role WHERE org_id = $1 AND code IN ('OWNER', 'MANAGER', 'RESIDENT')`,
    [orgId]
  );
  const roleMap = Object.fromEntries(rolesRes.rows.map((r) => [r.code, r.id]));
  const pwHash = await bcrypt.hash('Demo@123456', 4);

  // Isolated building with EXACTLY 1 OWNER + 1 MANAGER (PRD FR-067 + Mục 6.2 core case!)
  const ownerEmail = `rsv4.owner.${suffix}@resihub.test`;
  const ownerPerson = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Chu Toa T4 ${suffix}`, `0941${suffix}`, ownerEmail, `079410${suffix}`]
  );
  cleanup.personIds.push(ownerPerson.rows[0].id);
  const ownerRec = await adminPool.query(
    `INSERT INTO owner (org_id, person_id, full_name, phone, email) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, ownerPerson.rows[0].id, `Chu Toa T4 ${suffix}`, `0941${suffix}`, ownerEmail]
  );
  cleanup.ownerIds.push(ownerRec.rows[0].id);
  const ownerUser = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [ownerPerson.rows[0].id, pwHash]
  );
  cleanup.userIds.push(ownerUser.rows[0].id);
  await adminPool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [
    ownerUser.rows[0].id,
    roleMap.OWNER,
  ]);

  const bldIns = await adminPool.query(
    `INSERT INTO building (org_id, owner_id, code, name, address)
     VALUES ($1, $2, $3, $4, '789 T4 Street') RETURNING id`,
    [orgId, ownerRec.rows[0].id, `T4B-${suffix}`, `Tòa T4 ${suffix}`]
  );
  const bldId = bldIns.rows[0].id;
  cleanup.buildingIds.push(bldId);

  const flrIns = await adminPool.query(
    `INSERT INTO floor (building_id, level, name) VALUES ($1, 1, 'Tầng 1') RETURNING id`,
    [bldId]
  );
  const floorId = flrIns.rows[0].id;
  cleanup.floorIds.push(floorId);

  const mgrEmail = `rsv4.mgr.${suffix}@resihub.test`;
  const mgrPerson = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Quan Ly T4 ${suffix}`, `0942${suffix}`, mgrEmail, `079420${suffix}`]
  );
  cleanup.personIds.push(mgrPerson.rows[0].id);
  const mgrUser = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [mgrPerson.rows[0].id, pwHash]
  );
  cleanup.userIds.push(mgrUser.rows[0].id);
  await adminPool.query(`INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`, [
    mgrUser.rows[0].id,
    roleMap.MANAGER,
    bldId,
  ]);

  const resPhone = `0943${suffix}`;
  const resEmail = `rsv4.res.${suffix}@resihub.test`;
  const resPerson = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Khach Giu Cho T4 ${suffix}`, resPhone, resEmail, `079430${suffix}`]
  );
  cleanup.personIds.push(resPerson.rows[0].id);
  const resTenant = await adminPool.query(
    `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
    [orgId, resPerson.rows[0].id]
  );
  cleanup.tenantIds.push(resTenant.rows[0].id);
  const resUser = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [resPerson.rows[0].id, pwHash]
  );
  cleanup.userIds.push(resUser.rows[0].id);
  await adminPool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [
    resUser.rows[0].id,
    roleMap.RESIDENT,
  ]);

  const ownerAuth = await loginEmail(ownerEmail, 'Demo@123456');
  const mgrAuth = await loginEmail(mgrEmail, 'Demo@123456');
  const resAuth = await loginEmail(resEmail, 'Demo@123456');

  async function createApt(codePrefix) {
    const r = await apiFetch('/api/v1/apartments', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldId,
        floor_id: floorId,
        code: `${codePrefix}-${suffix}`,
        area_m2: 48,
        bedrooms: 1,
        base_rent: 10000000,
      }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    cleanup.apartmentIds.push(r.body.data.id);
    return r.body.data;
  }

  // =========================================================================
  // 1. Core 1 MANAGER + 1 OWNER building: Propose -> Approve -> RP-07 -> Resident Bank Info -> Payout with UNC -> RP-07
  // =========================================================================
  await t.test('1. 1 MANAGER + 1 OWNER building: separated cancel-settle -> cancel-approve -> RP-07 conservation -> resident bank-info -> cancel-payout with UNC', async () => {
    const apt1 = await createApt('RSV-P1');
    const cr = await apiFetch('/api/v1/reservations', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt1.id,
        prospect_name: `Khach Giu Cho T4 ${suffix}`,
        phone: resPhone,
        hold_amount: 2000000,
        hold_from: todayStr,
        hold_until: isoDaysFromToday(5),
      }),
    });
    assert.equal(cr.status, 201, JSON.stringify(cr.body));
    const rsvId = cr.body.data.id;
    cleanup.reservationIds.push(rsvId);

    // OWNER attempting to propose cancel-settle must fail 403 (MANAGER proposes)
    const ownerPropose = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-settle`, ownerAuth.token, {
      method: 'PATCH',
      body: JSON.stringify({
        refunded_amount: 1200000,
        forfeited_amount: 800000,
        refund_method: 'BANK_TRANSFER',
        refund_bank_info: {
          bank_name: 'Vietcombank',
          bank_code: 'VCB',
          account_number: '0011223344',
          account_holder: 'KHACH GIU CHO T4',
        },
        reason: 'Khách báo dời lịch nhận nhà',
      }),
    });
    assert.equal(ownerPropose.status, 403);

    // MANAGER proposes partial refund WITHOUT UNC -> 200 CANCEL_PENDING_APPROVAL
    const mgrPropose = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-settle`, mgrAuth.token, {
      method: 'PATCH',
      body: JSON.stringify({
        refunded_amount: 1200000,
        forfeited_amount: 800000,
        refund_method: 'BANK_TRANSFER',
        refund_bank_info: {
          bank_name: 'Vietcombank',
          bank_code: 'VCB',
          account_number: '0011223344',
          account_holder: 'KHACH GIU CHO T4',
        },
        reason: 'Khách báo hủy thỏa thuận hoàn 60%',
      }),
    });
    assert.equal(mgrPropose.status, 200, JSON.stringify(mgrPropose.body));
    assert.equal(mgrPropose.body.data.status, 'CANCEL_PENDING_APPROVAL');

    const aptWhilePending = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [apt1.id]);
    assert.equal(aptWhilePending.rows[0].status, 'RESERVED');

    // Public spam guard blocks duplicate booking on same phone while CANCEL_PENDING_APPROVAL
    const aptFree = await createApt('RSV-FREE');
    const otpSpam = await apiFetch('/api/v1/public/reservations/otp/request', null, {
      method: 'POST',
      body: JSON.stringify({ phone: resPhone }),
    });
    assert.equal(otpSpam.status, 200);
    const pubDup = await apiFetch('/api/v1/public/reservations', null, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptFree.id,
        prospect_name: 'Dup Prospect',
        phone: resPhone,
        otp: otpSpam.body.devOtp,
        hold_amount: 2000000,
        hold_from: todayStr,
        hold_until: isoDaysFromToday(3),
        privacy_consent: true,
        evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(pubDup.status, 409, JSON.stringify(pubDup.body));
    assert.equal(pubDup.body.code, 'PHONE_ALREADY_HAS_ACTIVE_RESERVATION');

    // Midnight cron must NOT overwrite CANCEL_PENDING_APPROVAL to EXPIRED
    await adminPool.query(`UPDATE reservation SET hold_until = $2 WHERE id = $1`, [rsvId, isoDaysFromToday(-1)]);
    await runDailyJobs();
    const stillPending = await adminPool.query(`SELECT status FROM reservation WHERE id = $1`, [rsvId]);
    assert.equal(stillPending.rows[0].status, 'CANCEL_PENDING_APPROVAL');
    await adminPool.query(`UPDATE reservation SET hold_until = $2 WHERE id = $1`, [rsvId, isoDaysFromToday(5)]);
    await adminPool.query(`UPDATE apartment SET status = 'RESERVED' WHERE id = $1`, [apt1.id]);

    // Same MANAGER self-approving fails 403 FOUR_EYES_VIOLATION (or FORBIDDEN)
    const selfApp = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-approve`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(selfApp.status, 403);
    assert.equal(selfApp.body.code, 'FOUR_EYES_VIOLATION');

    // SYS_ADMIN on owned building fails 403 SYS_ADMIN_READ_ONLY_ON_OWNED_BUILDING
    const sysApp = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-approve`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(sysApp.status, 403);
    assert.equal(sysApp.body.code, 'SYS_ADMIN_READ_ONLY_ON_OWNED_BUILDING');

    // OWNER approves WITHOUT UNC (with optional approval note) -> 200 APPROVED_PENDING_PAYOUT + apartment immediately AVAILABLE!
    const ownApp = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-approve`, ownerAuth.token, {
      method: 'POST',
      body: JSON.stringify({ note: 'Duyệt hoàn 60% theo chính sách giữ chỗ' }),
    });
    assert.equal(ownApp.status, 200, JSON.stringify(ownApp.body));
    assert.equal(ownApp.body.data.status, 'APPROVED_PENDING_PAYOUT');
    assert.equal(ownApp.body.data.cancel_settlement?.approval_note, 'Duyệt hoàn 60% theo chính sách giữ chỗ');
    assert.match(ownApp.body.data.note || '', /Duyệt hoàn 60% theo chính sách giữ chỗ/);

    const aptAfterApprove = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [apt1.id]);
    assert.equal(aptAfterApprove.rows[0].status, 'AVAILABLE', 'Apartment MUST immediately become AVAILABLE on APPROVED_PENDING_PAYOUT');

    // Intermediate RP-07 exact VND conservation check: 0 active_held + 1,200,000 pending_payout + 800,000 forfeited + 0 refunded = 2,000,000!
    const rpMid = await apiFetch(
      `/api/v1/reports/deposit-ledger?building_id=${bldId}&from_date=${currentPeriod}-01&to_date=${isoDaysFromToday(1)}`,
      ownerAuth.token,
      { method: 'GET' }
    );
    assert.equal(rpMid.status, 200, JSON.stringify(rpMid.body));
    const rsMid = rpMid.body.data.reservation_summary;
    assert.equal(Number(rsMid.active_held_amount), 0);
    assert.equal(Number(rsMid.pending_payout_amount), 1200000);
    assert.equal(Number(rsMid.pending_payout_count), 1);
    assert.equal(Number(rsMid.forfeited_in_period), 800000);
    assert.equal(Number(rsMid.refunded_in_period), 0);

    // RP-07 .xlsx export Sheet 2 (Doi soat giu cho) must also include APPROVED_PENDING_PAYOUT (1,200,000)
    const rpXlsx = await apiFetch(
      `/api/v1/reports/deposit-ledger?building_id=${bldId}&from_date=${currentPeriod}-01&to_date=${isoDaysFromToday(1)}&format=xlsx`,
      ownerAuth.token,
      { rawBuffer: true }
    );
    assert.equal(rpXlsx.status, 200);
    const zipEntries = new Map();
    let offset = 0;
    while (offset + 30 <= rpXlsx.buffer.length && rpXlsx.buffer.readUInt32LE(offset) === 0x04034b50) {
      const method = rpXlsx.buffer.readUInt16LE(offset + 8);
      const compSize = rpXlsx.buffer.readUInt32LE(offset + 18);
      const fnLen = rpXlsx.buffer.readUInt16LE(offset + 26);
      const exLen = rpXlsx.buffer.readUInt16LE(offset + 28);
      const fn = rpXlsx.buffer.subarray(offset + 30, offset + 30 + fnLen).toString('utf8');
      const dataStart = offset + 30 + fnLen + exLen;
      const slice = rpXlsx.buffer.subarray(dataStart, dataStart + compSize);
      zipEntries.set(fn, method === 8 ? zlib.inflateRawSync(slice) : Buffer.from(slice));
      offset = dataStart + compSize;
    }
    const sheet2Xml = zipEntries.get('xl/worksheets/sheet2.xml').toString('utf8');
    assert.match(sheet2Xml, /APPROVED_PENDING_PAYOUT/);
    assert.match(sheet2Xml, /1200000/);

    // RESIDENT updates bank info with nested { bank_info: { ..., bank_logo } }
    const resBank = await apiFetch(`/api/v1/reservations/${rsvId}/bank-info`, resAuth.token, {
      method: 'PATCH',
      body: JSON.stringify({
        bank_info: {
          bank_name: 'Techcombank',
          bank_code: 'TCB',
          bank_bin: '970407',
          bank_logo: 'https://api.vietqr.io/img/TCB.png',
          account_number: '190377788899',
          account_holder: 'KHACH GIU CHO T4',
        },
      }),
    });
    assert.equal(resBank.status, 200, JSON.stringify(resBank.body));
    assert.equal(resBank.body.data.refund_bank_info.account_number, '190377788899');
    assert.equal(resBank.body.data.refund_bank_info.bank_logo, 'https://api.vietqr.io/img/TCB.png');

    // Manager receives notification about bank update
    const mgrNotif = await adminPool.query(
      `SELECT type FROM notification WHERE user_id = $1 AND type = 'RESERVATION_BANK_INFO_UPDATED'`,
      [mgrUser.rows[0].id]
    );
    assert.ok(mgrNotif.rows.length >= 1);

    // Resident overview exposes APPROVED_PENDING_PAYOUT reservation & refund_bank_info
    const ovRes = await apiFetch('/api/v1/resident/overview', resAuth.token, { method: 'GET' });
    assert.equal(ovRes.status, 200, JSON.stringify(ovRes.body));
    const foundRsv = (ovRes.body.data?.reservations || []).find((r) => r.reservation_id === rsvId || r.id === rsvId);
    assert.ok(foundRsv, 'Resident overview must surface APPROVED_PENDING_PAYOUT reservation');
    assert.equal(foundRsv.refund_bank_info?.account_number, '190377788899');

    // OWNER attempting cancel-payout fails 403
    const ownPayout = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-payout`, ownerAuth.token, {
      method: 'POST',
      body: JSON.stringify({ refund_evidence: [TINY_PNG_B64] }),
    });
    assert.equal(ownPayout.status, 403);

    // MANAGER attempting cancel-payout WITHOUT UNC fails 422 REFUND_EVIDENCE_REQUIRED
    const mgrPayoutNoUnc = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-payout`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ refund_evidence: [] }),
    });
    assert.equal(mgrPayoutNoUnc.status, 422);
    assert.equal(mgrPayoutNoUnc.body.code, 'REFUND_EVIDENCE_REQUIRED');

    // MANAGER executes cancel-payout WITH UNC -> 200 PARTIALLY_REFUNDED
    const mgrPayoutOk = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-payout`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        refund_evidence: [TINY_PNG_B64],
        reference_code: 'UNC-TCB-001',
        note: 'Đã chuyển khoản hoàn 1.2tr giữ chỗ',
      }),
    });
    assert.equal(mgrPayoutOk.status, 200, JSON.stringify(mgrPayoutOk.body));
    assert.equal(mgrPayoutOk.body.data.status, 'PARTIALLY_REFUNDED');

    // Post-payout RP-07 conservation check: 0 pending_payout + 800,000 forfeited + 1,200,000 refunded = 2,000,000!
    const rpEnd = await apiFetch(
      `/api/v1/reports/deposit-ledger?building_id=${bldId}&from_date=${currentPeriod}-01&to_date=${isoDaysFromToday(1)}`,
      ownerAuth.token,
      { method: 'GET' }
    );
    assert.equal(rpEnd.status, 200);
    const rsEnd = rpEnd.body.data.reservation_summary;
    assert.equal(Number(rsEnd.pending_payout_amount), 0);
    assert.equal(Number(rsEnd.forfeited_in_period), 800000);
    assert.equal(Number(rsEnd.refunded_in_period), 1200000);
  });

  // =========================================================================
  // 2. Zero-refund (100% forfeit) proposal finalizes directly on OWNER cancel-approve
  // =========================================================================
  await t.test('2. Zero-refund proposal finalizes directly to FORFEITED on OWNER cancel-approve', async () => {
    const apt2 = await createApt('RSV-P2');
    const cr = await apiFetch('/api/v1/reservations', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt2.id,
        prospect_name: `Khach Forfeit ${suffix}`,
        phone: `0945${suffix}`,
        hold_amount: 2000000,
        hold_from: todayStr,
        hold_until: isoDaysFromToday(5),
      }),
    });
    const rsvId = cr.body.data.id;
    cleanup.reservationIds.push(rsvId);

    const prop = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-settle`, mgrAuth.token, {
      method: 'PATCH',
      body: JSON.stringify({
        refunded_amount: 0,
        forfeited_amount: 2000000,
        reason: 'Khách bỏ cọc sát giờ nhận phòng',
      }),
    });
    assert.equal(prop.status, 200);
    assert.equal(prop.body.data.status, 'CANCEL_PENDING_APPROVAL');

    const appRes = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-approve`, ownerAuth.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(appRes.status, 200, JSON.stringify(appRes.body));
    assert.equal(appRes.body.data.status, 'FORFEITED');

    const aptAfter = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [apt2.id]);
    assert.equal(aptAfter.rows[0].status, 'AVAILABLE');
  });

  // =========================================================================
  // 3. Rejection on expired hold_until restores EXPIRED (not HELD) & keeps apartment AVAILABLE
  // =========================================================================
  await t.test('3. cancel-reject after hold_until < today restores EXPIRED and keeps apartment AVAILABLE', async () => {
    const apt3 = await createApt('RSV-P3');
    const cr = await apiFetch('/api/v1/reservations', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt3.id,
        prospect_name: `Khach Reject ${suffix}`,
        phone: `0946${suffix}`,
        hold_amount: 2000000,
        hold_from: todayStr,
        hold_until: isoDaysFromToday(3),
      }),
    });
    const rsvId = cr.body.data.id;
    cleanup.reservationIds.push(rsvId);

    // Simulate expired hold
    await adminPool.query(
      `UPDATE reservation SET status = 'EXPIRED', hold_until = $2 WHERE id = $1`,
      [rsvId, isoDaysFromToday(-2)]
    );
    await adminPool.query(`UPDATE apartment SET status = 'AVAILABLE' WHERE id = $1`, [apt3.id]);

    const prop = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-settle`, mgrAuth.token, {
      method: 'PATCH',
      body: JSON.stringify({
        refunded_amount: 1000000,
        forfeited_amount: 1000000,
        refund_method: 'CASH',
        reason: 'Đề xuất hỗ trợ hoàn 50% cho phiếu quá hạn',
      }),
    });
    assert.equal(prop.status, 200);
    assert.equal(prop.body.data.status, 'CANCEL_PENDING_APPROVAL');

    const rej = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-reject`, ownerAuth.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Phiếu đã quá hạn nên phạt 100%, không hoàn 50%' }),
    });
    assert.equal(rej.status, 200, JSON.stringify(rej.body));
    assert.equal(rej.body.data.status, 'EXPIRED');
    assert.equal(Number(rej.body.data.refunded_amount), 0);
    assert.equal(Number(rej.body.data.forfeited_amount), 0);

    const aptAfter = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [apt3.id]);
    assert.equal(aptAfter.rows[0].status, 'AVAILABLE');
  });

  // =========================================================================
  // 4. Direct PATCH /:id/refund aligns to APPROVED_PENDING_PAYOUT -> requires STK + UNC on cancel-payout
  // =========================================================================
  await t.test('4. Direct PATCH /:id/refund transitions to APPROVED_PENDING_PAYOUT and requires STK + UNC on cancel-payout', async () => {
    const apt4 = await createApt('RSV-P4');
    const cr = await apiFetch('/api/v1/reservations', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt4.id,
        prospect_name: `Khach Direct Refund ${suffix}`,
        phone: resPhone,
        hold_amount: 2000000,
        hold_from: todayStr,
        hold_until: isoDaysFromToday(5),
      }),
    });
    const rsvId = cr.body.data.id;
    cleanup.reservationIds.push(rsvId);

    const directRef = await apiFetch(`/api/v1/reservations/${rsvId}/refund`, ownerAuth.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Lỗi kỹ thuật căn hộ, duyệt hoàn 100%' }),
    });
    assert.equal(directRef.status, 200, JSON.stringify(directRef.body));
    assert.equal(directRef.body.data.status, 'APPROVED_PENDING_PAYOUT');

    const aptAfter = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [apt4.id]);
    assert.equal(aptAfter.rows[0].status, 'AVAILABLE');

    // Payout before STK is provided fails 422 BANK_INFO_REQUIRED
    const payoutNoBank = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-payout`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ refund_evidence: [TINY_PNG_B64] }),
    });
    assert.equal(payoutNoBank.status, 422);
    assert.equal(payoutNoBank.body.code, 'BANK_INFO_REQUIRED');

    // Resident updates STK
    const addBank = await apiFetch(`/api/v1/reservations/${rsvId}/bank-info`, resAuth.token, {
      method: 'PATCH',
      body: JSON.stringify({
        bank_info: {
          bank_name: 'MBBank',
          bank_code: 'MB',
          account_number: '0987654321',
          account_holder: 'KHACH GIU CHO T4',
        },
      }),
    });
    assert.equal(addBank.status, 200);

    // Manager completes payout with UNC -> REFUNDED
    const payoutOk = await apiFetch(`/api/v1/reservations/${rsvId}/cancel-payout`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ refund_evidence: [TINY_PNG_B64], reference_code: 'UNC-MB-999' }),
    });
    assert.equal(payoutOk.status, 200, JSON.stringify(payoutOk.body));
    assert.equal(payoutOk.body.data.status, 'REFUNDED');
  });
});
