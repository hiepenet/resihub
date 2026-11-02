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

test('M05/M06 Task 3 — 4-Step Room Transfer & Deposit Carry-Over (DRAFT -> scan -> PENDING_APPROVAL -> approve -> ACTIVE)', async (t) => {
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
  const cleanup = {
    contractIds: [],
    apartmentIds: [],
    tenantIds: [],
    userRoleIds: [],
    userIds: [],
    personIds: [],
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const cId of [...cleanup.contractIds].reverse()) {
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
      await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'apartment' AND owner_id = $1", [aId]).catch(() => {});
      await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
    }
    for (const tId of cleanup.tenantIds) {
      await adminPool.query('DELETE FROM tenant WHERE id = $1', [tId]).catch(() => {});
    }
    for (const urId of cleanup.userRoleIds) {
      await adminPool.query('DELETE FROM user_role WHERE id = $1', [urId]).catch(() => {});
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

  const vopRes = await adminPool.query(
    `SELECT b.id, b.org_id, f.id AS floor_id
     FROM building b
     JOIN floor f ON f.building_id = b.id
     WHERE b.code = 'VOP-A'
     ORDER BY f.level ASC
     LIMIT 1`
  );
  const vopAId = vopRes.rows[0].id;
  const orgId = vopRes.rows[0].org_id;
  const vopFloorId = vopRes.rows[0].floor_id;

  const vscRes = await adminPool.query(
    `SELECT b.id, f.id AS floor_id
     FROM building b
     JOIN floor f ON f.building_id = b.id
     WHERE b.code = 'VSC-A'
     ORDER BY f.level ASC
     LIMIT 1`
  );
  const vscAId = vscRes.rows[0].id;
  const vscFloorId = vscRes.rows[0].floor_id;

  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const mgrA = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');
  const ownerVop = await loginEmail('owner.vop@resihub.vn', 'Demo@123456');

  // Grant mgrA temporary MANAGER assignment on VSC-A as well so we specifically hit CROSS_BUILDING_TRANSFER_NOT_ALLOWED (422) rather than 403 unassigned building
  const mgrRoleRes = await adminPool.query(`SELECT id FROM role WHERE org_id = $1 AND code = 'MANAGER' LIMIT 1`, [orgId]);
  const mgrRoleId = mgrRoleRes.rows[0].id;
  await adminPool.query(
    `DELETE FROM user_role WHERE user_id = $1 AND role_id = $2 AND building_id = $3`,
    [mgrA.user.sub, mgrRoleId, vscAId]
  );
  const tempUr = await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3) RETURNING id`,
    [mgrA.user.sub, mgrRoleId, vscAId]
  );
  cleanup.userRoleIds.push(tempUr.rows[0].id);

  const pwHash = await bcrypt.hash('Demo@123456', 4);
  const resRoleRes = await adminPool.query(`SELECT id FROM role WHERE org_id = $1 AND code = 'RESIDENT' LIMIT 1`, [orgId]);
  const pIns = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Cu Dan Chuyen Phong ${suffix}`, `0968${suffix}`, `tr.${suffix}@resihub.test`, `079388${suffix}`]
  );
  cleanup.personIds.push(pIns.rows[0].id);
  const tIns = await adminPool.query(
    `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
    [orgId, pIns.rows[0].id]
  );
  cleanup.tenantIds.push(tIns.rows[0].id);
  const uIns = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [pIns.rows[0].id, pwHash]
  );
  cleanup.userIds.push(uIns.rows[0].id);
  await adminPool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [
    uIns.rows[0].id,
    resRoleRes.rows[0].id,
  ]);

  const pIns2 = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Cu Dan Khac ${suffix}`, `0967${suffix}`, `tr2.${suffix}@resihub.test`, `079389${suffix}`]
  );
  cleanup.personIds.push(pIns2.rows[0].id);
  const tIns2 = await adminPool.query(
    `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
    [orgId, pIns2.rows[0].id]
  );
  cleanup.tenantIds.push(tIns2.rows[0].id);

  async function makeApt(buildingId, floorId, code, baseRent = 9000000) {
    const r = await apiFetch('/api/v1/apartments', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: buildingId,
        floor_id: floorId,
        code,
        area_m2: 45,
        bedrooms: 1,
        base_rent: baseRent,
      }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    cleanup.apartmentIds.push(r.body.data.id);
    return r.body.data;
  }

  const aptOld = await makeApt(vopAId, vopFloorId, `TR-OLD-${suffix}`, 9000000);
  const aptNew = await makeApt(vopAId, vopFloorId, `TR-NEW-${suffix}`, 10000000);
  const aptRace = await makeApt(vopAId, vopFloorId, `TR-RACE-${suffix}`, 9000000);
  const aptOtherBld = await makeApt(vscAId, vscFloorId, `TR-VSC-${suffix}`, 9000000);

  const todayStr = isoDaysFromToday(0);

  // Create & activate old contract with 9,000,000 VND deposit held
  const cOldCreate = await apiFetch('/api/v1/contracts', mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: aptOld.id,
      primary_tenant_id: tIns.rows[0].id,
      start_date: isoDaysFromToday(-15),
      end_date: isoDaysFromToday(180),
      rent_amount: 9000000,
      deposit_amount: 9000000,
      billing_day: 1,
    }),
  });
  assert.equal(cOldCreate.status, 201, JSON.stringify(cOldCreate.body));
  const oldContractId = cOldCreate.body.data.id;
  cleanup.contractIds.push(oldContractId);

  await apiFetch(`/api/v1/contracts/${oldContractId}/scan`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
  });
  const actOld = await apiFetch(`/api/v1/contracts/${oldContractId}/activate`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(actOld.status, 200, JSON.stringify(actOld.body));

  const oldDepLookup = await adminPool.query('SELECT id FROM deposit WHERE contract_id = $1', [oldContractId]);
  const oldDepId = oldDepLookup.rows[0].id;
  const colRes = await apiFetch(`/api/v1/deposits/${oldDepId}/transactions`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      type: 'collect',
      amount: 9000000,
      method: 'BANK_TRANSFER',
      description: 'Thu đủ 9tr cọc căn cũ',
    }),
  });
  assert.equal(colRes.status, 201, JSON.stringify(colRes.body));

  // 1. Cross-building transfer -> 422 CROSS_BUILDING_TRANSFER_NOT_ALLOWED
  const crossBld = await apiFetch(`/api/v1/contracts/${oldContractId}/transfer-room`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      new_apartment_id: aptOtherBld.id,
      new_start_date: todayStr,
      new_end_date: isoDaysFromToday(180),
      new_rent_amount: 9000000,
      transfer_deposit: true,
    }),
  });
  if (crossBld.body?.data?.new_contract?.id) {
    cleanup.contractIds.push(crossBld.body.data.new_contract.id);
  }
  assert.equal(crossBld.status, 422, JSON.stringify(crossBld.body));
  assert.equal(crossBld.body?.code, 'CROSS_BUILDING_TRANSFER_NOT_ALLOWED');

  // 1b. Out-of-range transfer date (> oldContract.end_date) -> 422 INVALID_TRANSFER_DATE
  const afterEndTr = await apiFetch(`/api/v1/contracts/${oldContractId}/transfer-room`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      new_apartment_id: aptNew.id,
      new_start_date: isoDaysFromToday(195),
      new_end_date: isoDaysFromToday(365),
      new_rent_amount: 9000000,
      transfer_deposit: true,
    }),
  });
  if (afterEndTr.body?.data?.new_contract?.id) {
    cleanup.contractIds.push(afterEndTr.body.data.new_contract.id);
  }
  assert.equal(afterEndTr.status, 422, JSON.stringify(afterEndTr.body));
  assert.equal(afterEndTr.body?.code, 'INVALID_TRANSFER_DATE');

  // 2. Valid transfer-room with >10% rent discount (8M on 10M base_rent) + 6M new deposit -> 201 DRAFT, oldContract stays ACTIVE!
  const trDraft = await apiFetch(`/api/v1/contracts/${oldContractId}/transfer-room`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      new_apartment_id: aptNew.id,
      new_start_date: todayStr,
      new_end_date: isoDaysFromToday(180),
      new_rent_amount: 8000000,
      new_deposit_amount: 6000000,
      transfer_deposit: true,
      note: 'Chuyển sang phòng ưu đãi giá 8tr cọc 6tr',
    }),
  });
  assert.equal(trDraft.status, 201, JSON.stringify(trDraft.body));
  const newContractId = trDraft.body.data.new_contract.id;
  cleanup.contractIds.push(newContractId);
  assert.equal(trDraft.body.data.new_contract.status, 'DRAFT');
  assert.equal(trDraft.body.data.new_contract.is_room_transfer, true);

  const oldStillActive = await adminPool.query('SELECT status FROM contract WHERE id = $1', [oldContractId]);
  assert.equal(oldStillActive.rows[0].status, 'ACTIVE', 'Old contract MUST remain ACTIVE while transfer is in DRAFT');

  const oldDepStillFull = await adminPool.query('SELECT amount_held, status FROM deposit WHERE id = $1', [oldDepId]);
  assert.equal(Number(oldDepStillFull.rows[0].amount_held), 9000000);
  assert.equal(oldDepStillFull.rows[0].status, 'HELD');

  // 3. Duplicate transfer-room while DRAFT open -> 409 PENDING_TRANSFER_EXISTS
  const dupTr = await apiFetch(`/api/v1/contracts/${oldContractId}/transfer-room`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      new_apartment_id: aptRace.id,
      new_start_date: todayStr,
      new_end_date: isoDaysFromToday(180),
      new_rent_amount: 9000000,
      transfer_deposit: true,
    }),
  });
  assert.equal(dupTr.status, 409, JSON.stringify(dupTr.body));
  assert.equal(dupTr.body?.code, 'PENDING_TRANSFER_EXISTS');

  // PATCH draft attempting cross-building or same-apartment must be blocked
  const badPatchCross = await apiFetch(`/api/v1/contracts/${newContractId}`, mgrA.token, {
    method: 'PATCH',
    body: JSON.stringify({ apartment_id: aptOtherBld.id }),
  });
  assert.equal(badPatchCross.status, 422);
  assert.equal(badPatchCross.body?.code, 'CROSS_BUILDING_TRANSFER_NOT_ALLOWED');

  const badPatchSame = await apiFetch(`/api/v1/contracts/${newContractId}`, mgrA.token, {
    method: 'PATCH',
    body: JSON.stringify({ apartment_id: aptOld.id }),
  });
  assert.equal(badPatchSame.status, 400);
  assert.equal(badPatchSame.body?.code, 'SAME_APARTMENT');

  // PATCH draft attempting to swap primary_tenant_id on a room transfer must fail 422 CANNOT_CHANGE_TRANSFER_TENANT
  const badPatchTenant = await apiFetch(`/api/v1/contracts/${newContractId}`, mgrA.token, {
    method: 'PATCH',
    body: JSON.stringify({ primary_tenant_id: tIns2.rows[0].id }),
  });
  assert.equal(badPatchTenant.status, 422, JSON.stringify(badPatchTenant.body));
  assert.equal(badPatchTenant.body?.code, 'CANNOT_CHANGE_TRANSFER_TENANT');

  // GET /api/v1/contracts/:id must expose apartment_base_rent for UI discount guard
  const detailNew = await apiFetch(`/api/v1/contracts/${newContractId}`, mgrA.token, { method: 'GET' });
  assert.equal(detailNew.status, 200);
  assert.equal(Number(detailNew.body?.data?.apartment_base_rent), 10000000);

  // 4. Activate without signed scan -> 409 MISSING_SIGNED_SCAN (AC-009.2)
  const actNoScan = await apiFetch(`/api/v1/contracts/${newContractId}/activate`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(actNoScan.status, 409);
  assert.equal(actNoScan.body?.code, 'MISSING_SIGNED_SCAN');

  // 5. Upload signed scan -> activate -> transitions to PENDING_APPROVAL (409 PRICE_NEEDS_APPROVAL)
  const scanNew = await apiFetch(`/api/v1/contracts/${newContractId}/scan`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
  });
  assert.equal(scanNew.status, 201);

  const actPending = await apiFetch(`/api/v1/contracts/${newContractId}/activate`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(actPending.status, 409, JSON.stringify(actPending.body));
  assert.equal(actPending.body?.code, 'PRICE_NEEDS_APPROVAL');
  assert.equal(actPending.body?.data?.status, 'PENDING_APPROVAL');

  // MANAGER attempting to approve on building with active OWNER -> 403 FORBIDDEN_NOT_BUILDING_OWNER
  const mgrApprove = await apiFetch(`/api/v1/contracts/${newContractId}/approve`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(mgrApprove.status, 403);
  assert.equal(mgrApprove.body?.code, 'FORBIDDEN_NOT_BUILDING_OWNER');

  // 6. OWNER rejects -> returns newContract to DRAFT, oldContract still ACTIVE!
  const ownReject = await apiFetch(`/api/v1/contracts/${newContractId}/reject`, ownerVop.token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Cần điều chỉnh giá thuê về đúng 9.5 triệu' }),
  });
  assert.equal(ownReject.status, 200, JSON.stringify(ownReject.body));
  assert.equal(ownReject.body.data.status, 'DRAFT');

  // Reject note on room transfer uses [Từ chối duyệt đổi phòng: ...]
  assert.match(ownReject.body.data.note || '', /\[Từ chối duyệt đổi phòng:/);

  const oldAfterReject = await adminPool.query('SELECT status FROM contract WHERE id = $1', [oldContractId]);
  assert.equal(oldAfterReject.rows[0].status, 'ACTIVE');

  // Update rent to standard frame (9.5M >= 90% of 10M) -> re-activate -> 409 TRANSFER_NEEDS_APPROVAL
  const patchStandardRent = await apiFetch(`/api/v1/contracts/${newContractId}`, mgrA.token, {
    method: 'PATCH',
    body: JSON.stringify({ rent_amount: 9500000 }),
  });
  assert.equal(patchStandardRent.status, 200, JSON.stringify(patchStandardRent.body));

  const actTransferPending = await apiFetch(`/api/v1/contracts/${newContractId}/activate`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(actTransferPending.status, 409, JSON.stringify(actTransferPending.body));
  assert.equal(actTransferPending.body?.code, 'TRANSFER_NEEDS_APPROVAL');
  assert.equal(actTransferPending.body?.data?.status, 'PENDING_APPROVAL');

  // 7. OWNER approves -> 200 ACTIVE + atomic termination of oldContract + old apt MAINTENANCE + 6M transferred (approved_by = OWNER) + 3M surplus HELD
  const ownApprove = await apiFetch(`/api/v1/contracts/${newContractId}/approve`, ownerVop.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(ownApprove.status, 200, JSON.stringify(ownApprove.body));
  assert.equal(ownApprove.body.data.status, 'ACTIVE');
  assert.equal(ownApprove.body.data.approved_by, ownerVop.user.sub);
  assert.equal(ownApprove.body.surplus_deposit_amount, 3000000);

  const oldAfterApprove = await adminPool.query('SELECT status, terminated_at FROM contract WHERE id = $1', [oldContractId]);
  assert.equal(oldAfterApprove.rows[0].status, 'TERMINATED');

  const oldAptAfter = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [aptOld.id]);
  assert.equal(oldAptAfter.rows[0].status, 'MAINTENANCE');

  const newAptAfter = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [aptNew.id]);
  assert.equal(newAptAfter.rows[0].status, 'OCCUPIED');

  const oldDepFinal = await adminPool.query('SELECT amount_held, status, refund_due_date FROM deposit WHERE id = $1', [oldDepId]);
  assert.equal(Number(oldDepFinal.rows[0].amount_held), 3000000);
  assert.equal(oldDepFinal.rows[0].status, 'HELD');
  assert.ok(oldDepFinal.rows[0].refund_due_date);

  const newDepFinal = await adminPool.query('SELECT id, amount_held, status FROM deposit WHERE contract_id = $1', [newContractId]);
  assert.equal(Number(newDepFinal.rows[0].amount_held), 6000000);
  assert.equal(newDepFinal.rows[0].status, 'HELD');

  const transferTxns = await adminPool.query(
    `SELECT category, amount, approved_by
     FROM deposit_transaction
     WHERE deposit_id IN ($1, $2) AND type = 'transfer'
     ORDER BY category ASC`,
    [oldDepId, newDepFinal.rows[0].id]
  );
  assert.equal(transferTxns.rows.length, 2);
  for (const row of transferTxns.rows) {
    assert.equal(Number(row.amount), 6000000);
    assert.equal(row.approved_by, ownerVop.user.sub, 'TRANSFER_IN / TRANSFER_OUT must record OWNER as approved_by (FR-025)');
  }

  // TRANSFER_ROOM audit_log must be anchored on oldContractId (Spec 5.2.B.4)
  const trAudit = await adminPool.query(
    `SELECT entity_id FROM audit_log WHERE entity = 'contract' AND action = 'TRANSFER_ROOM' AND entity_id = $1`,
    [oldContractId]
  );
  assert.equal(trAudit.rows.length, 1, 'TRANSFER_ROOM audit_log must record oldContractId as entity_id');

  // 8. Target apartment RESERVED race + Parent-terminated race:
  const trRace = await apiFetch(`/api/v1/contracts/${newContractId}/transfer-room`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      new_apartment_id: aptRace.id,
      new_start_date: todayStr,
      new_end_date: isoDaysFromToday(180),
      new_rent_amount: 9000000,
      transfer_deposit: true,
    }),
  });
  assert.equal(trRace.status, 201, JSON.stringify(trRace.body));
  const raceContractId = trRace.body.data.new_contract.id;
  cleanup.contractIds.push(raceContractId);

  await apiFetch(`/api/v1/contracts/${raceContractId}/scan`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
  });
  const actRace = await apiFetch(`/api/v1/contracts/${raceContractId}/activate`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(actRace.status, 409);
  assert.equal(actRace.body?.code, 'TRANSFER_NEEDS_APPROVAL');

  // 8a. Simulate target apartment becoming RESERVED while room transfer sits in PENDING_APPROVAL -> 409 APARTMENT_NOT_AVAILABLE
  await adminPool.query(`UPDATE apartment SET status = 'RESERVED' WHERE id = $1`, [aptRace.id]);
  const approveReservedApt = await apiFetch(`/api/v1/contracts/${raceContractId}/approve`, ownerVop.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(approveReservedApt.status, 409, JSON.stringify(approveReservedApt.body));
  assert.equal(approveReservedApt.body?.code, 'APARTMENT_NOT_AVAILABLE');
  const parentStillActive = await adminPool.query('SELECT status FROM contract WHERE id = $1', [newContractId]);
  assert.equal(parentStillActive.rows[0].status, 'ACTIVE');
  await adminPool.query(`UPDATE apartment SET status = 'AVAILABLE' WHERE id = $1`, [aptRace.id]);

  // 8b. Simulate parent contract terminated before OWNER approves -> 409 PARENT_CONTRACT_NOT_ACTIVE
  await adminPool.query(`UPDATE contract SET status = 'TERMINATED', terminated_at = CURRENT_DATE WHERE id = $1`, [newContractId]);

  const approveRace = await apiFetch(`/api/v1/contracts/${raceContractId}/approve`, ownerVop.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(approveRace.status, 409, JSON.stringify(approveRace.body));
  assert.equal(approveRace.body?.code, 'PARENT_CONTRACT_NOT_ACTIVE');

  const raceCheck = await adminPool.query('SELECT status FROM contract WHERE id = $1', [raceContractId]);
  assert.equal(raceCheck.rows[0].status, 'PENDING_APPROVAL');
});
