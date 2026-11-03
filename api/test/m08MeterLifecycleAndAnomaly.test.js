import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';

dotenv.config();

const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

process.env.APP_DATABASE_URL = APP_DB_URL;

const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('M08 Meter Reading Lifecycle, 3-Period Anomaly, RBAC/RLS Hardening & Deposit Sync', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const rlsPool = new pg.Pool({ connectionString: APP_DB_URL });

  const { adminPool: appAdminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: metersRoute } = await import('../src/routes/meters.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');
  const { default: settingsRoute } = await import('../src/routes/settings.js');
  const { default: auditLogsRoute } = await import('../src/routes/admin/audit-logs.js');
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
  app.use('/api/v1/meters', metersRoute);
  app.use('/api/v1/deposits', depositsRoute);
  app.use('/api/v1/settings', settingsRoute);
  app.use('/api/v1/audit-logs', auditLogsRoute);
  app.use('/api/v1/attachments', attachmentsRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  async function apiFetch(path, token, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
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
    return { status: res.status, headers: res.headers, body };
  }

  async function loginEmail(email, password) {
    const res = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.body)}`);
    return { token: res.body.accessToken, user: res.body.user };
  }

  async function queryAsUser(userId, sql, params = []) {
    const client = await rlsPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      const res = await client.query(sql, params);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const cleanup = {
    meterIds: [],
    depositIds: [],
    contractIds: [],
    apartmentIds: [],
    buildingIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
    origBillingConfig: null,
  };

  const bldgRes = await adminPool.query(
    `SELECT b.id, b.org_id, b.owner_id FROM building b WHERE b.code = 'VOP-A' LIMIT 1`
  );
  assert.ok(bldgRes.rows.length > 0, 'Building VOP-A must exist');
  const vopAId = bldgRes.rows[0].id;
  const orgId = bldgRes.rows[0].org_id;
  const ownerId = bldgRes.rows[0].owner_id;

  const origSettingRes = await adminPool.query(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'billing_config'`,
    [orgId]
  );
  cleanup.origBillingConfig = origSettingRes.rows[0]?.value || null;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.allow_test_cleanup', 'true', true)`);
      if (cleanup.origBillingConfig) {
        await c.query(
          `UPDATE system_setting SET value = $1::jsonb WHERE org_id = $2 AND key = 'billing_config'`,
          [JSON.stringify(cleanup.origBillingConfig), orgId]
        );
      }
      if (cleanup.meterIds.length > 0) {
        await c.query(
          `DELETE FROM audit_log WHERE entity IN ('meter', 'meter_reading', 'attachment')
             AND (entity_id = ANY($1::uuid[])
               OR entity_id IN (SELECT id FROM meter_reading WHERE meter_id = ANY($1::uuid[])))`,
          [cleanup.meterIds]
        );
        await c.query(
          `DELETE FROM attachment WHERE owner_entity = 'meter_reading'
             AND owner_id IN (SELECT id FROM meter_reading WHERE meter_id = ANY($1::uuid[]))`,
          [cleanup.meterIds]
        );
        await c.query(`DELETE FROM meter_reading WHERE meter_id = ANY($1::uuid[])`, [cleanup.meterIds]);
        await c.query(`DELETE FROM meter WHERE id = ANY($1::uuid[])`, [cleanup.meterIds]);
      }
      if (cleanup.depositIds.length > 0) {
        await c.query(`DELETE FROM deposit_transaction WHERE deposit_id = ANY($1::uuid[])`, [cleanup.depositIds]);
        await c.query(`DELETE FROM deposit WHERE id = ANY($1::uuid[])`, [cleanup.depositIds]);
      }
      if (cleanup.contractIds.length > 0) {
        await c.query(`DELETE FROM contract WHERE id = ANY($1::uuid[])`, [cleanup.contractIds]);
      }
      if (cleanup.apartmentIds.length > 0) {
        await c.query(`DELETE FROM apartment WHERE id = ANY($1::uuid[])`, [cleanup.apartmentIds]);
      }
      if (cleanup.buildingIds.length > 0) {
        await c.query(`DELETE FROM building WHERE id = ANY($1::uuid[])`, [cleanup.buildingIds]);
      }
      if (cleanup.tenantIds.length > 0) {
        await c.query(`DELETE FROM tenant WHERE id = ANY($1::uuid[])`, [cleanup.tenantIds]);
      }
      if (cleanup.userIds.length > 0) {
        await c.query(`DELETE FROM idempotency_key WHERE actor_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await c.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await c.query(`DELETE FROM user_role WHERE user_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await c.query(`DELETE FROM app_user WHERE id = ANY($1::uuid[])`, [cleanup.userIds]);
      }
      if (cleanup.personIds.length > 0) {
        await c.query(`DELETE FROM person WHERE id = ANY($1::uuid[])`, [cleanup.personIds]);
      }
      await c.query('COMMIT');
    } catch (cleanupErr) {
      await c.query('ROLLBACK');
      console.error('[M08 Test Cleanup Error]:', cleanupErr.message);
    } finally {
      c.release();
      await rlsPool.end().catch(() => {});
      await adminPool.end().catch(() => {});
      await appPool.end().catch(() => {});
      await appAdminPool.end().catch(() => {});
    }
  });

  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const ownerVop = await loginEmail('owner.vop@resihub.vn', 'Demo@123456');
  const mgrVopA = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');

  // Create isolated other building + cross-building MANAGER + temp VOP-A apartment + RESIDENT
  const pwdHash = await bcrypt.hash('Demo@123456', 10);
  const otherBldgRes = await adminPool.query(
    `INSERT INTO building (org_id, owner_id, code, name, address)
     VALUES ($1, $2, $3, $4, 'Test Address')
     RETURNING id`,
    [orgId, ownerId, `M08B-${suffix.slice(-4)}`, `M08 Test Building B ${suffix}`]
  );
  const otherBldgId = otherBldgRes.rows[0].id;
  cleanup.buildingIds.push(otherBldgId);

  const mgrOtherPerson = await adminPool.query(
    `INSERT INTO person (org_id, full_name, email, phone)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, `Mgr Other ${suffix}`, `mgr.other.${suffix}@resihub.vn`, `097${suffix.slice(0, 7)}`]
  );
  cleanup.personIds.push(mgrOtherPerson.rows[0].id);
  const mgrOtherUser = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status)
     VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [mgrOtherPerson.rows[0].id, pwdHash]
  );
  cleanup.userIds.push(mgrOtherUser.rows[0].id);
  const roleMgr = await adminPool.query(`SELECT id FROM role WHERE org_id = $1 AND code = 'MANAGER' LIMIT 1`, [orgId]);
  await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
    [mgrOtherUser.rows[0].id, roleMgr.rows[0].id, otherBldgId]
  );
  const mgrOther = await loginEmail(`mgr.other.${suffix}@resihub.vn`, 'Demo@123456');

  // Create temp apartment in VOP-A + RESIDENT + ACTIVE contract + HELD deposit
  const floorRes = await adminPool.query(`SELECT id FROM floor WHERE building_id = $1 LIMIT 1`, [vopAId]);
  const aptRes = await adminPool.query(
    `INSERT INTO apartment (building_id, floor_id, code, area_m2, base_rent, status)
     VALUES ($1, $2, $3, 45, 9000000, 'OCCUPIED')
     RETURNING id, code`,
    [vopAId, floorRes.rows[0]?.id || null, `M08-${suffix.slice(-4)}`]
  );
  const aptId = aptRes.rows[0].id;
  cleanup.apartmentIds.push(aptId);

  const resPerson = await adminPool.query(
    `INSERT INTO person (org_id, full_name, email, phone)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, `Resident M08 ${suffix}`, `res.m08.${suffix}@resihub.vn`, `096${suffix.slice(0, 7)}`]
  );
  cleanup.personIds.push(resPerson.rows[0].id);
  const resUser = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status)
     VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [resPerson.rows[0].id, pwdHash]
  );
  const resUserId = resUser.rows[0].id;
  cleanup.userIds.push(resUserId);
  const roleRes = await adminPool.query(`SELECT id FROM role WHERE org_id = $1 AND code = 'RESIDENT' LIMIT 1`, [orgId]);
  await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
    [resUserId, roleRes.rows[0].id, vopAId]
  );
  const tenantRes = await adminPool.query(
    `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
    [orgId, resPerson.rows[0].id]
  );
  const tenantId = tenantRes.rows[0].id;
  cleanup.tenantIds.push(tenantId);

  const ctrRes = await adminPool.query(
    `INSERT INTO contract (
       building_id, apartment_id, primary_tenant_id,
       start_date, end_date, rent_amount, deposit_amount, billing_day, status
     )
     VALUES ($1, $2, $3, '2026-01-01', '2028-12-31', 9000000, 9000000, 1, 'ACTIVE')
     RETURNING id`,
    [vopAId, aptId, tenantId]
  );
  const contractId = ctrRes.rows[0].id;
  cleanup.contractIds.push(contractId);

  const depRes = await adminPool.query(
    `INSERT INTO deposit (contract_id, amount_held, status)
     VALUES ($1, 9000000, 'HELD')
     RETURNING id`,
    [contractId]
  );
  const depositId = depRes.rows[0].id;
  cleanup.depositIds.push(depositId);

  const resident = await loginEmail(`res.m08.${suffix}@resihub.vn`, 'Demo@123456');

  let elMeterId = null;
  let wtMeterId = null;
  let period5ReadingId = null;
  let period5AttachmentId = null;

  await t.test('1. 3-period rolling baseline (FR-031): [100, 110, 90] -> 125 kWh (+25% vs mean 100) is NOT abnormal', async () => {
    const createEl = await apiFetch('/api/v1/meters', mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `m08-el-${suffix}` },
      body: JSON.stringify({
        apartment_id: aptId,
        meter_type: 'ELECTRICITY',
        unit_price: 3800,
        initial_reading: 1000,
      }),
    });
    assert.equal(createEl.status, 201, JSON.stringify(createEl.body));
    elMeterId = createEl.body.data.id;
    cleanup.meterIds.push(elMeterId);

    const p1 = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-01', current_reading: 1100 }),
    });
    assert.equal(p1.status, 201);
    assert.equal(p1.body.data.status, 'CONFIRMED');
    assert.equal(Number(p1.body.data.consumption), 100);

    const p2 = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-02', current_reading: 1210 }),
    });
    assert.equal(p2.status, 201);
    assert.equal(Number(p2.body.data.consumption), 110);

    const p3 = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-03', current_reading: 1300 }),
    });
    assert.equal(p3.status, 201);
    assert.equal(Number(p3.body.data.consumption), 90);

    // Period 4: 1425 -> consumption = 125 kWh (+38.89% vs 90, but +25% vs 3-period mean 100) -> NOT abnormal!
    const p4 = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-04', current_reading: 1425 }),
    });
    assert.equal(p4.status, 201, JSON.stringify(p4.body));
    assert.equal(p4.body.data.is_abnormal, false, '125 kWh vs 3-period mean 100 kWh (+25%) must NOT be abnormal');
    assert.equal(Number(p4.body.data.baseline_avg_consumption), 100);
    assert.equal(p4.body.data.status, 'CONFIRMED');
  });

  await t.test('2. DRAFT/FLAGGED lifecycle & resident RLS isolation (Review Focus #5)', async () => {
    // Prior 3 CONFIRMED periods: 2028-04 (125), 2028-03 (90), 2028-02 (110) -> mean = 108.33
    // Record period 5 (2028-05) with status: 'DRAFT' & current_reading = 1588 (+163 kWh = +50.46% > 30%)
    const p5 = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        period: '2028-05',
        current_reading: 1588,
        status: 'DRAFT',
        image_base64: TINY_PNG_B64,
      }),
    });
    assert.equal(p5.status, 201, JSON.stringify(p5.body));
    assert.equal(p5.body.data.status, 'FLAGGED');
    assert.equal(p5.body.data.is_abnormal, true);
    assert.equal(p5.body.data.confirmed_by, null);
    assert.equal(p5.body.data.confirmed_at, null);
    assert.equal(Number(p5.body.data.baseline_avg_consumption), 108.33);
    period5ReadingId = p5.body.data.id;

    const imgMatch = String(p5.body.data.image_url || '').match(/\/attachments\/([0-9a-f-]+)\/view/i);
    assert.ok(imgMatch, 'Expected uploaded attachment URL');
    period5AttachmentId = imgMatch[1];

    // Resident RLS check: sees 2028-04 CONFIRMED, sees 0 rows for 2028-05 FLAGGED
    const resP4 = await queryAsUser(
      resUserId,
      `SELECT id, status FROM meter_reading WHERE meter_id = $1 AND period = '2028-04'`,
      [elMeterId]
    );
    assert.equal(resP4.rows.length, 1);
    const resP5 = await queryAsUser(
      resUserId,
      `SELECT id, status FROM meter_reading WHERE meter_id = $1 AND period = '2028-05'`,
      [elMeterId]
    );
    assert.equal(resP5.rows.length, 0, 'Unconfirmed FLAGGED reading must be hidden from RESIDENT RLS');

    // Resident cannot view unconfirmed meter reading attachment
    const attUnconfirmed = await apiFetch(`/api/v1/attachments/${period5AttachmentId}/view`, resident.token);
    assert.ok([403, 404].includes(attUnconfirmed.status), `Expected 403/404, got ${attUnconfirmed.status}`);

    // Manager GET /meters & GET /meters/readings?status=FLAGGED exposes period_reading_status & baseline_avg_consumption
    const listMeters = await apiFetch(`/api/v1/meters?building_id=${vopAId}&period=2028-05`, mgrVopA.token);
    assert.equal(listMeters.status, 200);
    const mRow = listMeters.body.data.find((m) => m.id === elMeterId);
    assert.ok(mRow);
    assert.equal(mRow.period_reading_status, 'FLAGGED');

    const listFlagged = await apiFetch(
      `/api/v1/meters/readings?building_id=${vopAId}&period=2028-05&status=FLAGGED`,
      mgrVopA.token
    );
    assert.equal(listFlagged.status, 200);
    assert.ok(listFlagged.body.data.some((r) => r.id === period5ReadingId));
  });

  await t.test('3. Abnormal note enforcement (PRD 13.2) & audit_log visibility to OWNER and MANAGER', async () => {
    const confirmNoNote = await apiFetch(
      `/api/v1/meters/readings/${period5ReadingId}/confirm`,
      mgrVopA.token,
      { method: 'POST', body: JSON.stringify({}) }
    );
    assert.equal(confirmNoNote.status, 422, JSON.stringify(confirmNoNote.body));
    assert.equal(confirmNoNote.body.code, 'ABNORMAL_NOTE_REQUIRED');

    const confirmWithNote = await apiFetch(
      `/api/v1/meters/readings/${period5ReadingId}/confirm`,
      mgrVopA.token,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `m08-confirm-${suffix}` },
        body: JSON.stringify({ abnormal_note: 'Khách lắp thêm máy lạnh' }),
      }
    );
    assert.equal(confirmWithNote.status, 200, JSON.stringify(confirmWithNote.body));
    assert.equal(confirmWithNote.body.data.status, 'CONFIRMED');
    assert.equal(confirmWithNote.body.data.confirmed_by, mgrVopA.user.sub);
    assert.ok(confirmWithNote.body.data.confirmed_at);
    assert.equal(confirmWithNote.body.data.abnormal_note, 'Khách lắp thêm máy lạnh');

    // Now resident RLS CAN see period 5 AND view its photo (FR-032)
    const resP5After = await queryAsUser(
      resUserId,
      `SELECT id, status FROM meter_reading WHERE meter_id = $1 AND period = '2028-05'`,
      [elMeterId]
    );
    assert.equal(resP5After.rows.length, 1);
    const attConfirmed = await apiFetch(`/api/v1/attachments/${period5AttachmentId}/view`, resident.token);
    assert.equal(attConfirmed.status, 200);

    // CONFIRM_METER_READING visible in audit_log to building OWNER and MANAGER under RLS
    const ownerAudit = await apiFetch(
      `/api/v1/audit-logs?entity=meter_reading&action=CONFIRM_METER_READING&limit=20`,
      ownerVop.token
    );
    assert.equal(ownerAudit.status, 200);
    assert.ok(
      ownerAudit.body.data.some((a) => a.entity_id === period5ReadingId),
      'OWNER must see CONFIRM_METER_READING in audit-logs'
    );

    const mgrAuditRls = await queryAsUser(
      mgrVopA.user.sub,
      `SELECT id, action FROM audit_log WHERE entity = 'meter_reading' AND entity_id = $1 AND action = 'CONFIRM_METER_READING'`,
      [period5ReadingId]
    );
    assert.equal(mgrAuditRls.rows.length, 1, 'MANAGER must see CONFIRM_METER_READING via rls_audit_log_select');
  });

  await t.test('4. Batch confirm & M06 deposit settlement precondition sync', async () => {
    const createWt = await apiFetch('/api/v1/meters', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptId,
        meter_type: 'WATER',
        unit_price: 22000,
        initial_reading: 50,
      }),
    });
    assert.equal(createWt.status, 201);
    wtMeterId = createWt.body.data.id;
    cleanup.meterIds.push(wtMeterId);

    // Record WATER 2028-06 as normal DRAFT (+10 m3), and ELECTRICITY 2028-06 as abnormal DRAFT (+400 kWh, no note)
    const batchDraft = await apiFetch('/api/v1/meters/readings/batch', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        period: '2028-06',
        status: 'DRAFT',
        readings: [
          { meter_id: wtMeterId, current_reading: 60 },
          { meter_id: elMeterId, current_reading: 1988 },
        ],
      }),
    });
    assert.equal(batchDraft.status, 201, JSON.stringify(batchDraft.body));
    const wtDraft = batchDraft.body.data.find((r) => r.meter_id === wtMeterId);
    const elFlagged = batchDraft.body.data.find((r) => r.meter_id === elMeterId);
    assert.equal(wtDraft.status, 'DRAFT');
    assert.equal(elFlagged.status, 'FLAGGED');

    // Confirm batch: confirms normal WATER DRAFT (1), skips abnormal ELECTRICITY FLAGGED without note (1)
    const confirmBatch = await apiFetch('/api/v1/meters/readings/confirm-batch', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        period: '2028-06',
        reading_ids: [wtDraft.id, elFlagged.id],
      }),
    });
    assert.equal(confirmBatch.status, 200, JSON.stringify(confirmBatch.body));
    assert.equal(confirmBatch.body.confirmed_count, 1);
    assert.equal(confirmBatch.body.skipped_abnormal_without_note, 1);

    // Terminate contract in 2028-06 while ELECTRICITY 2028-06 is still FLAGGED (unconfirmed) -> deposit settlement blocked with 409 MISSING_FINAL_METER_READING
    await adminPool.query(
      `UPDATE contract SET status = 'TERMINATED', terminated_at = '2028-06-15' WHERE id = $1`,
      [contractId]
    );
    const blockedSettle = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        inspection_evidence: [TINY_PNG_B64],
        refund_method: 'CASH',
      }),
    });
    assert.equal(blockedSettle.status, 409, JSON.stringify(blockedSettle.body));
    assert.equal(blockedSettle.body.code, 'MISSING_FINAL_METER_READING');

    // Confirm ELECTRICITY 2028-06 with note -> missing_meter_types clears (moves to UNBILLED_FINAL_METER_READING since consumption > 0)
    const confirmEl6 = await apiFetch(
      `/api/v1/meters/readings/${elFlagged.id}/confirm`,
      mgrVopA.token,
      {
        method: 'POST',
        body: JSON.stringify({ abnormal_note: 'Chốt chỉ số cuối kỳ thanh lý' }),
      }
    );
    assert.equal(confirmEl6.status, 200);

    const preAfterConfirm = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrVopA.token);
    assert.equal(preAfterConfirm.status, 200);
    assert.equal(preAfterConfirm.body.data.preconditions.final_meters_recorded, true);
  });

  await t.test('5. RBAC SYS_ADMIN Read-Only (PRD 6.2) & Cross-Building MANAGER 403 ACCESS_DENIED (AC-019.1)', async () => {
    const sysGet = await apiFetch(`/api/v1/meters/readings?building_id=${vopAId}`, sysAdmin.token);
    assert.equal(sysGet.status, 200);

    const sysPostMeter = await apiFetch('/api/v1/meters', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({ apartment_id: aptId, meter_type: 'ELECTRICITY' }),
    });
    assert.equal(sysPostMeter.status, 403, 'SYS_ADMIN must be Read-Only on POST /meters');

    const sysPostReading = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-07', current_reading: 2000 }),
    });
    assert.equal(sysPostReading.status, 403, 'SYS_ADMIN must be Read-Only on POST /meters/:id/readings');

    // Also verify DB-level RLS blocks SYS_ADMIN INSERT into meter_reading
    await assert.rejects(
      () =>
        queryAsUser(
          sysAdmin.user.sub,
          `INSERT INTO meter_reading (org_id, building_id, meter_id, apartment_id, period, previous_reading, current_reading, consumption)
           VALUES ($1, $2, $3, $4, '2028-09', 2000, 2050, 50)`,
          [orgId, vopAId, elMeterId, aptId]
        ),
      /row-level security/i
    );

    // Cross-building MANAGER gets 403 ACCESS_DENIED (NOT 404) on POST /:id/readings and POST /readings/:readingId/confirm
    const crossRead = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrOther.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-07', current_reading: 2000 }),
    });
    assert.equal(crossRead.status, 403, `Expected 403 ACCESS_DENIED, got ${crossRead.status}: ${JSON.stringify(crossRead.body)}`);
    assert.equal(crossRead.body.code, 'ACCESS_DENIED');

    const crossConfirm = await apiFetch(`/api/v1/meters/readings/${period5ReadingId}/confirm`, mgrOther.token, {
      method: 'POST',
      body: JSON.stringify({ abnormal_note: 'Unauthorized' }),
    });
    assert.equal(crossConfirm.status, 403, `Expected 403 ACCESS_DENIED, got ${crossConfirm.status}: ${JSON.stringify(crossConfirm.body)}`);
    assert.equal(crossConfirm.body.code, 'ACCESS_DENIED');
  });

  await t.test('6. Settings persistence: billing_day = 31 and Week 5 billing_config keys', async () => {
    const putRes = await apiFetch('/api/v1/settings', sysAdmin.token, {
      method: 'PUT',
      body: JSON.stringify({
        settings: {
          billing_config: {
            billing_day: 31,
            due_date_offset_days: 7,
            late_fee_grace_days: 5,
            late_fee_per_day: 100000,
            late_fee_cap: 1500000,
            meter_anomaly_threshold_pct: 35,
          },
        },
      }),
    });
    assert.equal(putRes.status, 200, JSON.stringify(putRes.body));

    const getRes = await apiFetch('/api/v1/settings', sysAdmin.token);
    assert.equal(getRes.status, 200);
    const bc = getRes.body.data.billing_config;
    assert.equal(bc.billing_day, 31);
    assert.equal(bc.due_date_offset_days, 7);
    assert.equal(bc.late_fee_grace_days, 5);
    assert.equal(bc.late_fee_per_day, 100000);
    assert.equal(bc.late_fee_cap, 1500000);
    assert.equal(bc.meter_anomaly_threshold_pct, 35);
  });
});
