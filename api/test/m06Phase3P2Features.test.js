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
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Minimal ZIP reader for verifying generated .xlsx entries without external libs
 */
function readZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // Local file header signature PK\x03\x04
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const fileName = buffer.subarray(nameStart, nameStart + fileNameLen).toString('utf8');
    const dataStart = nameStart + fileNameLen + extraLen;
    const rawSlice = buffer.subarray(dataStart, dataStart + compressedSize);
    const content =
      compressionMethod === 8
        ? zlib.inflateRawSync(rawSlice)
        : compressionMethod === 0
          ? Buffer.from(rawSlice)
          : null;
    entries.set(fileName, content);
    offset = dataStart + compressedSize;
  }
  return entries;
}

test('M06 Phase 3 (P2) — RP-07/RP-08 Reports, Deposit Audit Timeline & Public Reservations', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');
  const { default: reservationsRoute } = await import('../src/routes/reservations.js');
  const { default: reportsRoute } = await import('../src/routes/reports.js');
  const { default: auditLogsRoute } = await import('../src/routes/admin/audit-logs.js');
  const { default: residentRoute } = await import('../src/routes/resident.js');
  const { default: attachmentsRoute } = await import('../src/routes/attachments.js');
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
  app.use('/api/v1/reports', reportsRoute);
  app.use('/api/v1/audit-logs', auditLogsRoute);
  app.use('/api/v1/resident', residentRoute);
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
    if (options.rawBuffer) {
      const arrayBuf = await res.arrayBuffer();
      return {
        status: res.status,
        headers: res.headers,
        contentType,
        buffer: Buffer.from(arrayBuf),
      };
    }
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
    return { status: res.status, headers: res.headers, contentType, body, text };
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
    ownerIds: [],
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
      await adminPool.query('DELETE FROM contract_version WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
    }
    for (const rId of cleanup.reservationIds) {
      await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'reservation' AND owner_id = $1", [rId]).catch(() => {});
      await adminPool.query('DELETE FROM reservation WHERE id = $1', [rId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'apartment' AND owner_id = $1", [aId]).catch(() => {});
      await adminPool.query('DELETE FROM reservation WHERE apartment_id = $1', [aId]).catch(() => {});
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

  // Setup isolated test building with dedicated active OWNER and 2 MANAGERs (for Four-Eyes)
  const orgRes = await adminPool.query(`SELECT org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const orgId = orgRes.rows[0].org_id;
  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');

  const pwHash = await bcrypt.hash('Demo@123456', 10);
  const rolesRes = await adminPool.query(
    `SELECT code, id FROM role WHERE org_id = $1 AND code IN ('OWNER', 'MANAGER', 'RESIDENT')`,
    [orgId]
  );
  const roleMap = Object.fromEntries(rolesRes.rows.map((r) => [r.code, r.id]));

  // Dedicated OWNER for isolated building
  const ownerEmail = `p3.owner.${suffix}@resihub.test`;
  const ownerPhone = `0911${suffix}`;
  const ownerPersonRes = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Chủ Tòa P3 ${suffix}`, ownerPhone, ownerEmail, `079901${suffix}`]
  );
  cleanup.personIds.push(ownerPersonRes.rows[0].id);
  const ownerRecRes = await adminPool.query(
    `INSERT INTO owner (org_id, person_id, full_name, phone, email) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, ownerPersonRes.rows[0].id, `Chủ Tòa P3 ${suffix}`, ownerPhone, ownerEmail]
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
     VALUES ($1, $2, $3, $4, '123 P3 Street') RETURNING id`,
    [orgId, ownerRecRes.rows[0].id, `P3B-${suffix}`, `Tòa P3 ${suffix}`]
  );
  const testBuildingId = bldRes.rows[0].id;
  cleanup.buildingIds.push(testBuildingId);

  const flrRes = await adminPool.query(
    `INSERT INTO floor (building_id, level, name) VALUES ($1, 1, 'Tầng 1') RETURNING id`,
    [testBuildingId]
  );
  const testFloorId = flrRes.rows[0].id;
  cleanup.floorIds.push(testFloorId);

  async function createBuildingManager(tag, idx) {
    const email = `p3.mgr.${tag}.${suffix}@resihub.test`;
    const phone = `0912${idx}${suffix.slice(-5)}`;
    const p = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, `Quản lý ${tag} ${suffix}`, phone, email, `07991${idx}${suffix}`]
    );
    cleanup.personIds.push(p.rows[0].id);
    const u = await adminPool.query(
      `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [p.rows[0].id, pwHash]
    );
    cleanup.userIds.push(u.rows[0].id);
    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
      [u.rows[0].id, roleMap.MANAGER, testBuildingId]
    );
    const auth = await loginEmail(email, 'Demo@123456');
    return { ...auth, userId: u.rows[0].id };
  }

  const ownerLogin = await loginEmail(ownerEmail, 'Demo@123456');
  const ownerAuth = { ...ownerLogin, userId: ownerUserRes.rows[0].id };
  const mgr1 = await createBuildingManager('m1', '1');
  const mgr2 = await createBuildingManager('m2', '2');

  async function createApt(codePrefix) {
    const r = await apiFetch('/api/v1/apartments', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: testBuildingId,
        floor_id: testFloorId,
        code: `${codePrefix}-${suffix}`,
        area_m2: 50,
        bedrooms: 1,
        type: '1PN',
        base_rent: 10000000,
      }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    cleanup.apartmentIds.push(r.body.data.id);
    return r.body.data;
  }

  async function createResident(fullName, phone, idx) {
    const email = `p3.res.${idx}.${suffix}@resihub.test`;
    const p = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, fullName, phone, email, `07992${idx}${suffix}`]
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
      roleMap.RESIDENT,
    ]);
    const auth = await loginEmail(email, 'Demo@123456');
    return { ...auth, tenantId: tn.rows[0].id, personId: p.rows[0].id, phone };
  }

  let chainState = {};

  await t.test(
    'Task 1.1 & 1.5: 3-contract chain (HĐ1 -> HĐ2 -> HĐ3) + APPROVED_PENDING_PAYOUT + RETURNED + HELD/PENDING_CONFIRM reservation_summary & JWT scope_key idempotency',
    async () => {
      const apt1 = await createApt('A1');
      const apt2 = await createApt('A2');
      const apt3 = await createApt('A3');
      const apt4 = await createApt('A4');
      const apt5 = await createApt('A5');
      const apt6 = await createApt('A6');

      // Use leading-zero phone '0909123456' (or unique 0909xxxxxx) and formula-injection tenant name for CSV/XLSX verification!
      const leadZeroPhone = `0909${suffix}`;
      const resChain = await createResident(`=CMD|' /C calc'!A0`, leadZeroPhone, '1');
      const resPayout = await createResident(`Cư dân Chờ Chi ${suffix}`, `0931${suffix}`, '2');
      const resReturned = await createResident(`Cư dân Bị Trả Lệnh ${suffix}`, `0932${suffix}`, '3');

      // 1. Reservation -> HĐ1 on apt1
      const rsv1 = await apiFetch('/api/v1/reservations', mgr1.token, {
        method: 'POST',
        body: JSON.stringify({
          apartment_id: apt1.id,
          prospect_name: resChain.phone,
          phone: resChain.phone,
          hold_amount: 2000000,
          hold_from: isoDaysFromToday(0),
          hold_until: isoDaysFromToday(5),
        }),
      });
      assert.equal(rsv1.status, 201, JSON.stringify(rsv1.body));
      cleanup.reservationIds.push(rsv1.body.data.id);

      const hd1Create = await apiFetch('/api/v1/contracts', mgr1.token, {
        method: 'POST',
        body: JSON.stringify({
          apartment_id: apt1.id,
          primary_tenant_id: resChain.tenantId,
          start_date: isoDaysFromToday(-60),
          end_date: isoDaysFromToday(0),
          rent_amount: 10000000,
          deposit_amount: 10000000,
        }),
      });
      assert.equal(hd1Create.status, 201, JSON.stringify(hd1Create.body));
      const hd1Id = hd1Create.body.data.id;
      cleanup.contractIds.push(hd1Id);

      await apiFetch(`/api/v1/contracts/${hd1Id}/scan`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
      });
      const hd1Act = await apiFetch(`/api/v1/contracts/${hd1Id}/activate`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({ reservation_id: rsv1.body.data.id }),
      });
      assert.equal(hd1Act.status, 200, JSON.stringify(hd1Act.body));

      const dep1Lookup = await adminPool.query('SELECT id FROM deposit WHERE contract_id = $1', [hd1Id]);
      const dep1Id = dep1Lookup.rows[0].id;

      // Test Review Focus #5: JWT idempotency replay on uq_idempotency_key_scope ('user:' + actorId) without 42P10
      const collectIdemKey = `p3-jwt-idem-${crypto.randomUUID()}`;
      const collectPayload = JSON.stringify({
        type: 'collect',
        amount: 8000000,
        method: 'BANK_TRANSFER',
        description: 'Thu bổ sung cọc HĐ1',
        evidence: [TINY_PNG_B64],
      });
      const collect1 = await apiFetch(`/api/v1/deposits/${dep1Id}/transactions`, mgr1.token, {
        method: 'POST',
        headers: { 'Idempotency-Key': collectIdemKey },
        body: collectPayload,
      });
      assert.equal(collect1.status, 201, JSON.stringify(collect1.body));

      const collect2 = await apiFetch(`/api/v1/deposits/${dep1Id}/transactions`, mgr1.token, {
        method: 'POST',
        headers: { 'Idempotency-Key': collectIdemKey },
        body: collectPayload,
      });
      assert.equal(collect2.status, 201, JSON.stringify(collect2.body));
      assert.equal(collect2.headers.get('idempotent-replayed'), 'true');

      const idemDbRow = await adminPool.query(
        `SELECT scope_key, actor_id FROM idempotency_key WHERE idem_key = $1`,
        [collectIdemKey]
      );
      assert.equal(idemDbRow.rows.length, 1);
      assert.equal(idemDbRow.rows[0].scope_key, `user:${mgr1.userId}`);

      // 2. Renew HĐ1 -> HĐ2 and activate HĐ2 (dep1 TRANSFER_OUT 10tr, dep2 TRANSFER_IN 10tr)
      const hd2Renew = await apiFetch(`/api/v1/contracts/${hd1Id}/renew`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({
          new_end_date: isoDaysFromToday(180),
          rent_amount: 10000000,
          deposit_amount: 10000000,
        }),
      });
      assert.equal(hd2Renew.status, 201, JSON.stringify(hd2Renew.body));
      const hd2Id = hd2Renew.body.data.id;
      cleanup.contractIds.push(hd2Id);

      await apiFetch(`/api/v1/contracts/${hd2Id}`, mgr1.token, {
        method: 'PATCH',
        body: JSON.stringify({
          start_date: isoDaysFromToday(0),
          end_date: isoDaysFromToday(180),
        }),
      });

      await apiFetch(`/api/v1/contracts/${hd2Id}/scan`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
      });
      const hd2Act = await apiFetch(`/api/v1/contracts/${hd2Id}/activate`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      assert.equal(hd2Act.status, 200, JSON.stringify(hd2Act.body));

      const dep2Lookup = await adminPool.query('SELECT id FROM deposit WHERE contract_id = $1', [hd2Id]);
      const dep2Id = dep2Lookup.rows[0].id;

      // 3. Transfer room HĐ2 -> HĐ3 on apt2 (dep2 TRANSFER_OUT 10tr & status='TRANSFERRED', dep3 TRANSFER_IN 10tr)
      const hd3Transfer = await apiFetch(`/api/v1/contracts/${hd2Id}/transfer-room`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({
          new_apartment_id: apt2.id,
          new_start_date: isoDaysFromToday(0),
          new_end_date: isoDaysFromToday(240),
          new_rent_amount: 10000000,
          new_deposit_amount: 10000000,
          transfer_deposit: true,
        }),
      });
      assert.equal(hd3Transfer.status, 201, JSON.stringify(hd3Transfer.body));
      const hd3Id = hd3Transfer.body.data.new_contract?.id || hd3Transfer.body.data.id;
      cleanup.contractIds.push(hd3Id);

      // 4. Create 1 deposit in APPROVED_PENDING_PAYOUT (apt3)
      const hd4Res = await apiFetch('/api/v1/contracts', mgr1.token, {
        method: 'POST',
        body: JSON.stringify({
          apartment_id: apt3.id,
          primary_tenant_id: resPayout.tenantId,
          start_date: isoDaysFromToday(-40),
          end_date: isoDaysFromToday(20),
          rent_amount: 10000000,
          deposit_amount: 6000000,
        }),
      });
      const hd4Id = hd4Res.body.data.id;
      cleanup.contractIds.push(hd4Id);
      await apiFetch(`/api/v1/contracts/${hd4Id}/scan`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
      });
      await apiFetch(`/api/v1/contracts/${hd4Id}/activate`, mgr1.token, { method: 'POST', body: '{}' });
      const dep4Id = (await adminPool.query('SELECT id FROM deposit WHERE contract_id = $1', [hd4Id])).rows[0].id;
      await apiFetch(`/api/v1/deposits/${dep4Id}/transactions`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({ type: 'collect', amount: 6000000, method: 'BANK_TRANSFER', evidence: [TINY_PNG_B64] }),
      });
      await apiFetch(`/api/v1/contracts/${hd4Id}/terminate`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({ terminated_date: isoDaysFromToday(0), reason: 'Kết thúc sớm HĐ4' }),
      });
      const ho4 = await apiFetch(`/api/v1/apartments/${apt3.id}/handover`, mgr1.token, {
        method: 'PATCH',
        body: JSON.stringify({ note: 'Đã kiểm phòng A3', evidence: [TINY_PNG_B64] }),
      });
      assert.equal(ho4.status, 200, JSON.stringify(ho4.body));
      const set4 = await apiFetch(`/api/v1/deposits/${dep4Id}/settlement`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({
          items: [{ category: 'CLEANING', amount: 1000000, description: 'Vệ sinh', evidence: [TINY_PNG_B64] }],
          inspection_evidence: [TINY_PNG_B64],
          refund_method: 'BANK_TRANSFER',
          bank_info: { bank_name: 'VCB', account_number: '0011223344', account_holder: 'CU DAN CHO CHI' },
        }),
      });
      assert.equal(set4.status, 200, JSON.stringify(set4.body));
      const app4 = await apiFetch(`/api/v1/deposits/${dep4Id}/settlement/approve`, ownerAuth.token, {
        method: 'POST',
        body: '{}',
      });
      assert.equal(app4.status, 200, JSON.stringify(app4.body));
      assert.equal(app4.body.data.status, 'APPROVED_PENDING_PAYOUT');

      // 5. Create 1 deposit in RETURNED (apt4: payout -> payout-returned)
      const hd5Res = await apiFetch('/api/v1/contracts', mgr1.token, {
        method: 'POST',
        body: JSON.stringify({
          apartment_id: apt4.id,
          primary_tenant_id: resReturned.tenantId,
          start_date: isoDaysFromToday(-45),
          end_date: isoDaysFromToday(15),
          rent_amount: 10000000,
          deposit_amount: 5000000,
        }),
      });
      const hd5Id = hd5Res.body.data.id;
      cleanup.contractIds.push(hd5Id);
      await apiFetch(`/api/v1/contracts/${hd5Id}/scan`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
      });
      await apiFetch(`/api/v1/contracts/${hd5Id}/activate`, mgr1.token, { method: 'POST', body: '{}' });
      const dep5Id = (await adminPool.query('SELECT id FROM deposit WHERE contract_id = $1', [hd5Id])).rows[0].id;
      await apiFetch(`/api/v1/deposits/${dep5Id}/transactions`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({ type: 'collect', amount: 5000000, method: 'BANK_TRANSFER', evidence: [TINY_PNG_B64] }),
      });
      await apiFetch(`/api/v1/contracts/${hd5Id}/terminate`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({ terminated_date: isoDaysFromToday(0), reason: 'Kết thúc sớm HĐ5' }),
      });
      const ho5 = await apiFetch(`/api/v1/apartments/${apt4.id}/handover`, mgr1.token, {
        method: 'PATCH',
        body: JSON.stringify({ note: 'Đã kiểm phòng A4', evidence: [TINY_PNG_B64] }),
      });
      assert.equal(ho5.status, 200, JSON.stringify(ho5.body));
      const set5 = await apiFetch(`/api/v1/deposits/${dep5Id}/settlement`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({
          items: [],
          inspection_evidence: [TINY_PNG_B64],
          refund_method: 'BANK_TRANSFER',
          bank_info: { bank_name: 'VCB', account_number: '0099887766', account_holder: 'SAI TEN TK' },
        }),
      });
      assert.equal(set5.status, 200, JSON.stringify(set5.body));
      const app5 = await apiFetch(`/api/v1/deposits/${dep5Id}/settlement/approve`, ownerAuth.token, {
        method: 'POST',
        body: '{}',
      });
      assert.equal(app5.status, 200, JSON.stringify(app5.body));
      const pay5 = await apiFetch(`/api/v1/deposits/${dep5Id}/payout`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({ reference_code: 'UNC-P3-RET-1', evidence: [TINY_PNG_B64] }),
      });
      assert.equal(pay5.status, 200, JSON.stringify(pay5.body));
      const ret5 = await apiFetch(`/api/v1/deposits/${dep5Id}/payout-returned`, mgr1.token, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Ngân hàng trả lệnh do sai tên chủ TK' }),
      });
      assert.equal(ret5.status, 200, JSON.stringify(ret5.body));
      assert.equal(ret5.body.data.status, 'RETURNED');

      // 6. Active HELD reservation (apt5) & unconfirmed PENDING_CONFIRM reservation (apt6)
      const rsvHeld = await apiFetch('/api/v1/reservations', mgr1.token, {
        method: 'POST',
        body: JSON.stringify({
          apartment_id: apt5.id,
          prospect_name: 'Khách Giữ Chỗ Đã Thu',
          phone: `0935${suffix}`,
          hold_amount: 3000000,
          hold_from: isoDaysFromToday(0),
          hold_until: isoDaysFromToday(5),
        }),
      });
      assert.equal(rsvHeld.status, 201, JSON.stringify(rsvHeld.body));
      cleanup.reservationIds.push(rsvHeld.body.data.id);

      const rsvPendingDb = await adminPool.query(
        `INSERT INTO reservation (
           apartment_id, building_id, prospect_name, phone, hold_amount,
           hold_from, hold_until, status, source
         ) VALUES ($1, $2, 'Khách Chờ Sao Kê', $3, 2500000, CURRENT_DATE, CURRENT_DATE + 3, 'PENDING_CONFIRM', 'PUBLIC')
         RETURNING id`,
        [apt6.id, testBuildingId, `0936${suffix}`]
      );
      cleanup.reservationIds.push(rsvPendingDb.rows[0].id);

      // Verify RP-07 JSON Ledger
      const ledgerRes = await apiFetch(
        `/api/v1/reports/deposit-ledger?building_id=${testBuildingId}`,
        ownerAuth.token
      );
      assert.equal(ledgerRes.status, 200, JSON.stringify(ledgerRes.body));
      const { summary, reservation_summary: rsvSummary, items } = ledgerRes.body.data;

      // dep2 (middle of HĐ1 -> HĐ2 -> HĐ3) must have transfer_in === transfer_out === 10,000,000 and closing_held === 0
      const dep2Row = items.find((it) => it.deposit_id === dep2Id);
      assert.ok(dep2Row, 'dep2 must appear in RP-07 items');
      assert.equal(Number(dep2Row.transfer_in), 10000000);
      assert.equal(Number(dep2Row.transfer_out), 10000000);
      assert.equal(Number(dep2Row.closing_held), 0);

      // Every row and building summary must satisfy the accounting equation!
      for (const row of items) {
        const lhs =
          Number(row.opening_held) +
          Number(row.collected) +
          Number(row.transfer_in) +
          Number(row.refund_reversed) -
          Number(row.deducted) -
          Number(row.refunded) -
          Number(row.transfer_out);
        assert.equal(lhs, Number(row.closing_held), `Ledger row equation mismatch on ${row.deposit_id}`);
      }

      const summaryLhs =
        Number(summary.opening_held) +
        Number(summary.collected) +
        Number(summary.transfer_in) +
        Number(summary.refund_reversed) -
        Number(summary.deducted) -
        Number(summary.refunded) -
        Number(summary.transfer_out);
      assert.equal(summaryLhs, Number(summary.closing_held));

      const dbSumRes = await adminPool.query(
        `SELECT COALESCE(SUM(d.amount_held), 0)::bigint AS total_held
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         WHERE c.building_id = $1`,
        [testBuildingId]
      );
      assert.equal(Number(summary.closing_held), Number(dbSumRes.rows[0].total_held));
      assert.equal(Number(summary.pending_payout_count), 1);

      // Reservation reconciliation separates HELD from PENDING_CONFIRM
      assert.equal(Number(rsvSummary.active_held_count), 1);
      assert.equal(Number(rsvSummary.active_held_amount), 3000000);
      assert.equal(Number(rsvSummary.pending_confirm_count), 1);
      assert.equal(Number(rsvSummary.pending_confirm_amount), 2500000);

      chainState = { dep1Id, dep2Id, dep4Id, dep5Id, leadZeroPhone };
    }
  );

  await t.test('Task 1.2: RP-07 CSV (UTF-8 BOM) & XLSX (OpenXML ZIP) formula injection escape & leading-zero phone preservation', async () => {
    const csvRes = await apiFetch(
      `/api/v1/reports/deposit-ledger?building_id=${testBuildingId}&format=csv`,
      ownerAuth.token,
      { rawBuffer: true }
    );
    assert.equal(csvRes.status, 200);
    assert.ok(csvRes.contentType.includes('text/csv'));
    assert.equal(csvRes.buffer[0], 0xef);
    assert.equal(csvRes.buffer[1], 0xbb);
    assert.equal(csvRes.buffer[2], 0xbf);
    const csvText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csvRes.buffer);
    assert.ok(csvText.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM');
    assert.ok(
      csvText.includes(`"'=CMD|' /C calc'!A0"`),
      `CSV must prefix dangerous formula with single quote: ${csvText}`
    );
    assert.ok(
      csvText.includes(`"'${chainState.leadZeroPhone}"`),
      `CSV must preserve leading zero in phone ${chainState.leadZeroPhone}`
    );

    const xlsxRes = await apiFetch(
      `/api/v1/reports/deposit-ledger?building_id=${testBuildingId}&format=xlsx`,
      ownerAuth.token,
      { rawBuffer: true }
    );
    assert.equal(xlsxRes.status, 200);
    assert.ok(
      xlsxRes.contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    );
    // Magic header PK\x03\x04
    assert.equal(xlsxRes.buffer[0], 0x50);
    assert.equal(xlsxRes.buffer[1], 0x4b);
    assert.equal(xlsxRes.buffer[2], 0x03);
    assert.equal(xlsxRes.buffer[3], 0x04);

    const zipEntries = readZipEntries(xlsxRes.buffer);
    assert.ok(zipEntries.has('[Content_Types].xml'));
    assert.ok(zipEntries.has('xl/workbook.xml'));
    assert.ok(zipEntries.has('xl/worksheets/sheet1.xml'));

    const sheet1Xml = zipEntries.get('xl/worksheets/sheet1.xml').toString('utf8');
    // Check leading-zero phone is stored as inlineStr without losing leading 0
    assert.match(
      sheet1Xml,
      new RegExp(`<c[^>]*t="inlineStr"[^>]*><is><t>${chainState.leadZeroPhone}</t></is></c>`)
    );
    // Check formula cell starts with single quote (' or &apos; or &#39;) before =CMD
    assert.match(sheet1Xml, /(&apos;|&#39;|')=CMD\|/);
  });

  await t.test('Task 1.3 & 1.4: Dashboard 5 new KPIs, PENDING_CONFIRM overdue -> REJECTED, and idempotent MONTHLY_DEPOSIT_REPORT', async () => {
    // Insert an overdue PENDING_CONFIRM reservation (hold_until = yesterday)
    const aptOverdue = await createApt('AOV');
    const overduePendingRes = await adminPool.query(
      `INSERT INTO reservation (
         apartment_id, building_id, prospect_name, phone, hold_amount,
         hold_from, hold_until, status, source
       ) VALUES ($1, $2, 'Khách Quá Hạn Sao Kê', $3, 2000000, CURRENT_DATE - 5, CURRENT_DATE - 1, 'PENDING_CONFIRM', 'PUBLIC')
       RETURNING id`,
      [aptOverdue.id, testBuildingId, `0939${suffix}`]
    );
    const overduePendingId = overduePendingRes.rows[0].id;
    cleanup.reservationIds.push(overduePendingId);

    // Check Dashboard KPIs for OWNER of testBuildingId before daily job runs
    const dashOwner = await apiFetch('/api/v1/reports/dashboard', ownerAuth.token);
    assert.equal(dashOwner.status, 200, JSON.stringify(dashOwner.body));
    const kpis = dashOwner.body.data.kpis;
    assert.equal(typeof kpis.pending_deposit_approvals, 'number');
    assert.equal(typeof kpis.pending_deposit_payouts, 'number');
    assert.equal(typeof kpis.overdue_deposit_refunds, 'number');
    assert.equal(typeof kpis.disputed_deposits, 'number');
    assert.equal(typeof kpis.pending_reservation_confirms, 'number');
    assert.ok(kpis.pending_deposit_payouts >= 1);
    assert.ok(kpis.pending_reservation_confirms >= 1);

    // Run daily jobs twice -> overdue PENDING_CONFIRM becomes REJECTED (not EXPIRED), and OWNER gets exactly 1 MONTHLY_DEPOSIT_REPORT
    await dailyModule.runDailyJobs();
    await dailyModule.runDailyJobs();

    const afterRsv = await adminPool.query('SELECT status FROM reservation WHERE id = $1', [overduePendingId]);
    assert.equal(afterRsv.rows[0].status, 'REJECTED');

    const notifRes = await adminPool.query(
      `SELECT id, payload FROM notification
       WHERE user_id = $1 AND type = 'MONTHLY_DEPOSIT_REPORT'`,
      [ownerAuth.userId]
    );
    assert.equal(
      notifRes.rows.length,
      1,
      `Expected exactly 1 MONTHLY_DEPOSIT_REPORT for OWNER, got ${notifRes.rows.length}`
    );
  });
});
