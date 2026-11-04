import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

process.env.APP_DATABASE_URL = APP_DB_URL;

const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('1. Frontend JSX static guard: zero undefined JSX identifiers (react/jsx-no-undef) across frontend/src', () => {
  let output = '';
  let exitCode = 0;
  try {
    output = execSync('npx oxlint -A all -D react/jsx-no-undef src', {
      cwd: FRONTEND_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    exitCode = err.status || 1;
    output = `${err.stdout || ''}\n${err.stderr || ''}`;
  }
  assert.equal(
    exitCode,
    0,
    `Expected zero undefined JSX components in frontend/src, but oxlint reported:\n${output}`
  );
});

test('2. Week 5 Review Remediation API & RLS Suite (FR-032 Resident Photo, Dynamic Meter Config & Price, SYS_ADMIN Cron Monitor)', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });

  const { adminPool: appAdminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: metersRoute } = await import('../src/routes/meters.js');
  const { default: invoicesRoute } = await import('../src/routes/invoices.js');
  const { default: residentRoute } = await import('../src/routes/resident.js');
  const { default: settingsRoute } = await import('../src/routes/settings.js');
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
  app.use('/api/v1/invoices', invoicesRoute);
  app.use('/api/v1/resident', residentRoute);
  app.use('/api/v1/settings', settingsRoute);
  app.use('/api/v1/attachments', attachmentsRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  async function apiFetch(urlPath, token, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
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
      body = { raw: text, contentType };
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

  const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const testPeriod = '2029-04';
  const cleanup = {
    invoiceIds: [],
    meterIds: [],
    contractIds: [],
    apartmentIds: [],
    buildingIds: [],
    ownerIds: [],
    userIds: [],
    tenantIds: [],
    personIds: [],
    cronRunDates: ['2029-02-28'],
    origBillingConfig: null,
    testStartedAt: new Date().toISOString(),
  };

  try {
    const bldgRes = await adminPool.query(
      `SELECT id, org_id FROM building WHERE code = 'VOP-A' LIMIT 1`
    );
    assert.ok(bldgRes.rows.length > 0, 'Building VOP-A must exist');
    const vopAId = bldgRes.rows[0].id;
    const orgId = bldgRes.rows[0].org_id;

    const origSetting = await adminPool.query(
      `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'billing_config' LIMIT 1`,
      [orgId]
    );
    cleanup.origBillingConfig = origSetting.rows[0]?.value || null;

    const floorRes = await adminPool.query(
      `SELECT id FROM floor WHERE building_id = $1 LIMIT 1`,
      [vopAId]
    );
    const floorId = floorRes.rows[0].id;

    // Create dedicated test apartment + resident + contract in VOP-A
    const aptIns = await adminPool.query(
      `INSERT INTO apartment (building_id, floor_id, code, area_m2, type, bedrooms, base_rent, status)
       VALUES ($1, $2, $3, 50, '1PN', 1, 9000000, 'OCCUPIED')
       RETURNING id`,
      [vopAId, floorId, `W5FIX-${suffix}`]
    );
    const aptId = aptIns.rows[0].id;
    cleanup.apartmentIds.push(aptId);

    const residentEmail = `res.w5fix.${suffix}@resihub.vn`;
    const personIns = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [orgId, `Cư dân W5Fix ${suffix}`, `097${suffix.slice(0, 7)}`, residentEmail, `0799${suffix}`]
    );
    const personId = personIns.rows[0].id;
    cleanup.personIds.push(personId);

    const tenantIns = await adminPool.query(
      `INSERT INTO tenant (person_id, org_id, type, status)
       VALUES ($1, $2, 'primary', 'APPROVED')
       RETURNING id`,
      [personId, orgId]
    );
    const tenantId = tenantIns.rows[0].id;
    cleanup.tenantIds.push(tenantId);

    const pwdHash = await bcrypt.hash('Demo@123456', 10);
    const userIns = await adminPool.query(
      `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE')
       RETURNING id`,
      [personId, `w5fix-res-${suffix}`, pwdHash]
    );
    const resUserId = userIns.rows[0].id;
    cleanup.userIds.push(resUserId);

    const roleRes = await adminPool.query(`SELECT id FROM role WHERE code = 'RESIDENT' LIMIT 1`);
    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
      [resUserId, roleRes.rows[0].id, vopAId]
    );

    const contractIns = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, billing_cycle, billing_day, payment_due_days,
         deposit_amount, status
       )
       VALUES ($1, $2, $3, '2029-01-01', '2029-12-31', 9000000, 'monthly', 5, 5, 9000000, 'ACTIVE')
       RETURNING id`,
      [aptId, vopAId, tenantId]
    );
    const contractId = contractIns.rows[0].id;
    cleanup.contractIds.push(contractId);

    // Override ELECTRICITY price on contract: 3500 ₫/kWh (lower than meter unit_price 3800 ₫)
    await adminPool.query(
      `INSERT INTO contract_service_price (contract_id, service_code, unit_price, effective_from)
       VALUES ($1, 'ELECTRICITY', 3500, '2029-01-01')`,
      [contractId]
    );

    const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
    const mgrA = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');
    const resident = await loginEmail(residentEmail, 'Demo@123456');
    const otherResident = await loginEmail('tenant1@resihub.vn', 'Demo@123456');

    // Create ELECTRICITY meter with unit_price = 3800
    const createMeterRes = await apiFetch('/api/v1/meters', mgrA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-m-w5fix-${suffix}` },
      body: JSON.stringify({
        apartment_id: aptId,
        meter_type: 'ELECTRICITY',
        meter_code: `EL-W5FIX-${suffix}`,
        unit_price: 3800,
        initial_reading: 100,
      }),
    });
    assert.equal(createMeterRes.status, 201, JSON.stringify(createMeterRes.body));
    const meterId = createMeterRes.body.data.id;
    cleanup.meterIds.push(meterId);

    await t.test('2a. GET /api/v1/meters exposes dynamic anomaly_threshold_pct and 3-tier effective_unit_price', async () => {
      const putSettingRes = await apiFetch('/api/v1/settings', sysAdmin.token, {
        method: 'PUT',
        body: JSON.stringify({
          billing_config: {
            meter_anomaly_threshold_pct: 20,
          },
        }),
      });
      assert.equal(putSettingRes.status, 200, JSON.stringify(putSettingRes.body));

      const listMetersRes = await apiFetch(
        `/api/v1/meters?building_id=${vopAId}&period=${testPeriod}&search=EL-W5FIX-${suffix}`,
        mgrA.token
      );
      assert.equal(listMetersRes.status, 200, JSON.stringify(listMetersRes.body));
      assert.equal(listMetersRes.body.anomaly_threshold_pct, 20);
      assert.equal(listMetersRes.body.data.length, 1);

      const row = listMetersRes.body.data[0];
      assert.equal(Number(row.unit_price), 3800);
      assert.equal(Number(row.effective_unit_price), 3500);
      assert.equal(row.effective_price_source, 'CONTRACT_OVERRIDE');
    });

    await t.test('2b. Resident Portal GET /api/v1/resident/invoices returns meter_image_url for CONFIRMED reading (FR-032)', async () => {
      const recRes = await apiFetch(`/api/v1/meters/${meterId}/readings`, mgrA.token, {
        method: 'POST',
        headers: { 'Idempotency-Key': `idem-r-w5fix-${suffix}` },
        body: JSON.stringify({
          period: testPeriod,
          current_reading: 223.3, // consumption = 123.3 kWh * 3500 = 431,550 -> roundVND = 432,000 ₫
          status: 'CONFIRMED',
          image_base64: TINY_PNG_B64,
        }),
      });
      assert.equal(recRes.status, 201, JSON.stringify(recRes.body));
      const savedImageUrl = recRes.body.data.image_url;
      assert.ok(savedImageUrl && savedImageUrl.startsWith('/api/v1/attachments/'));

      const genRes = await apiFetch('/api/v1/invoices/generate-batch', mgrA.token, {
        method: 'POST',
        headers: { 'Idempotency-Key': `idem-inv-w5fix-${suffix}` },
        body: JSON.stringify({
          contract_id: contractId,
          period: testPeriod,
          auto_issue: true,
        }),
      });
      assert.equal(genRes.status, 201, JSON.stringify(genRes.body));
      assert.equal(genRes.body.created_count, 1);
      const invId = genRes.body.data[0].id;
      cleanup.invoiceIds.push(invId);

      const resInv = await apiFetch('/api/v1/resident/invoices', resident.token);
      assert.equal(resInv.status, 200, JSON.stringify(resInv.body));
      const inv = resInv.body.data.find((i) => i.id === invId);
      assert.ok(inv, 'Issued invoice must be visible to owning resident');

      const elecLine = inv.lines.find((l) => l.item_type === 'ELECTRICITY');
      assert.ok(elecLine, 'ELECTRICITY line must exist on resident invoice');
      assert.equal(Number(elecLine.amount), 432000);
      assert.equal(elecLine.meter_image_url, savedImageUrl);
      assert.equal(elecLine.formula_meta?.image_url, savedImageUrl);

      // Owning resident can view the attachment image; cross-apartment resident gets 403
      const ownImgRes = await apiFetch(savedImageUrl, resident.token);
      assert.equal(ownImgRes.status, 200);
      const crossImgRes = await apiFetch(savedImageUrl, otherResident.token);
      assert.equal(crossImgRes.status, 403);
    });

    await t.test('2c. SYS_ADMIN Cron Monitor & Trigger endpoints enforce RBAC, FORCE RLS & production date guard (FR-066)', async () => {
      // Create isolated empty building so future-date QA cron trigger never touches VOP-A demo data
      const ownP = await adminPool.query(
        `INSERT INTO person (org_id, full_name, phone, email)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [orgId, `Owner W5Fix ${suffix}`, `0961${suffix.slice(0, 6)}`, `own.w5fix.${suffix}@resihub.vn`]
      );
      cleanup.personIds.push(ownP.rows[0].id);
      const ownRec = await adminPool.query(
        `INSERT INTO owner (org_id, person_id, full_name, phone, email)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orgId, ownP.rows[0].id, `Owner W5Fix ${suffix}`, `0961${suffix.slice(0, 6)}`, `own.w5fix.${suffix}@resihub.vn`]
      );
      cleanup.ownerIds.push(ownRec.rows[0].id);
      const bldRes = await adminPool.query(
        `INSERT INTO building (org_id, owner_id, code, name, address)
         VALUES ($1, $2, $3, $4, 'W5Fix Cron Street') RETURNING id`,
        [orgId, ownRec.rows[0].id, `W5C-${suffix.slice(-4)}`, `Tòa W5Fix ${suffix}`]
      );
      const cronTestBuildingId = bldRes.rows[0].id;
      cleanup.buildingIds.push(cronTestBuildingId);

      // MANAGER is forbidden
      const mgrListRes = await apiFetch('/api/v1/settings/cron-runs', mgrA.token);
      assert.equal(mgrListRes.status, 403);
      const mgrTriggerRes = await apiFetch('/api/v1/settings/cron-runs/trigger', mgrA.token, {
        method: 'POST',
        headers: { 'Idempotency-Key': `idem-cron-mgr-${suffix}` },
        body: JSON.stringify({}),
      });
      assert.equal(mgrTriggerRes.status, 403);

      // SYS_ADMIN triggers a QA run for 2029-02-28 scoped to isolated building
      const triggerRes = await apiFetch('/api/v1/settings/cron-runs/trigger', sysAdmin.token, {
        method: 'POST',
        headers: { 'Idempotency-Key': `idem-cron-adm-${suffix}` },
        body: JSON.stringify({ as_of_date: '2029-02-28', building_id: cronTestBuildingId }),
      });
      assert.equal(triggerRes.status, 200, JSON.stringify(triggerRes.body));
      assert.equal(triggerRes.body.data.runDate, '2029-02-28');
      assert.equal(triggerRes.body.data.skipped, false);

      // SYS_ADMIN reads cron_job_run via FORCE RLS
      const listRes = await apiFetch('/api/v1/settings/cron-runs?limit=10', sysAdmin.token);
      assert.equal(listRes.status, 200, JSON.stringify(listRes.body));
      assert.ok(Array.isArray(listRes.body.data));
      assert.ok(
        listRes.body.data.some((r) => String(r.run_date).slice(0, 10) === '2029-02-28' && r.status === 'SUCCEEDED'),
        'cron-runs list must contain the SUCCEEDED run for 2029-02-28'
      );

      // Production guard rejects custom as_of_date != today
      const prevNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const prodGuardRes = await apiFetch('/api/v1/settings/cron-runs/trigger', sysAdmin.token, {
          method: 'POST',
          headers: { 'Idempotency-Key': `idem-cron-prod-${suffix}` },
          body: JSON.stringify({ as_of_date: '2099-01-01', building_id: cronTestBuildingId }),
        });
        assert.equal(prodGuardRes.status, 403);
        assert.equal(prodGuardRes.body.code, 'CUSTOM_DATE_FORBIDDEN_IN_PROD');
      } finally {
        process.env.NODE_ENV = prevNodeEnv;
      }
    });
  } finally {
    const cleanClient = await adminPool.connect();
    try {
      await cleanClient.query('BEGIN');
      await cleanClient.query(`SELECT set_config('app.allow_test_cleanup', 'true', true)`);

      const bldgRes = await cleanClient.query(`SELECT org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
      if (bldgRes.rows[0]?.org_id && cleanup.origBillingConfig !== null) {
        await cleanClient.query(
          `UPDATE system_setting SET value = $1::jsonb WHERE org_id = $2 AND key = 'billing_config'`,
          [JSON.stringify(cleanup.origBillingConfig), bldgRes.rows[0].org_id]
        );
      }
      if (cleanup.cronRunDates.length > 0) {
        await cleanClient.query(`DELETE FROM cron_job_run WHERE run_date = ANY($1::date[])`, [cleanup.cronRunDates]);
      }
      await cleanClient.query(
        `DELETE FROM notification WHERE type = 'MONTHLY_DEPOSIT_REPORT' AND created_at >= $1::timestamptz`,
        [cleanup.testStartedAt]
      );
      if (cleanup.invoiceIds.length > 0) {
        await cleanClient.query(`DELETE FROM audit_log WHERE entity = 'invoice' AND entity_id = ANY($1::uuid[])`, [cleanup.invoiceIds]);
        await cleanClient.query(`DELETE FROM receivable WHERE invoice_id = ANY($1::uuid[])`, [cleanup.invoiceIds]);
        await cleanClient.query(`DELETE FROM invoice_line WHERE invoice_id = ANY($1::uuid[])`, [cleanup.invoiceIds]);
        await cleanClient.query(`DELETE FROM invoice WHERE id = ANY($1::uuid[])`, [cleanup.invoiceIds]);
      }
      if (cleanup.meterIds.length > 0) {
        await cleanClient.query(
          `DELETE FROM attachment WHERE owner_entity = 'meter_reading' AND owner_id IN (SELECT id FROM meter_reading WHERE meter_id = ANY($1::uuid[]))`,
          [cleanup.meterIds]
        );
        await cleanClient.query(`DELETE FROM meter_reading WHERE meter_id = ANY($1::uuid[])`, [cleanup.meterIds]);
        await cleanClient.query(`DELETE FROM meter WHERE id = ANY($1::uuid[])`, [cleanup.meterIds]);
      }
      if (cleanup.contractIds.length > 0) {
        await cleanClient.query(`DELETE FROM contract_service_price WHERE contract_id = ANY($1::uuid[])`, [cleanup.contractIds]);
        await cleanClient.query(`DELETE FROM contract WHERE id = ANY($1::uuid[])`, [cleanup.contractIds]);
      }
      if (cleanup.apartmentIds.length > 0) {
        await cleanClient.query(`DELETE FROM apartment WHERE id = ANY($1::uuid[])`, [cleanup.apartmentIds]);
      }
      if (cleanup.buildingIds.length > 0) {
        await cleanClient.query(`DELETE FROM building WHERE id = ANY($1::uuid[])`, [cleanup.buildingIds]);
      }
      if (cleanup.ownerIds.length > 0) {
        await cleanClient.query(`DELETE FROM owner WHERE id = ANY($1::uuid[])`, [cleanup.ownerIds]);
      }
      if (cleanup.userIds.length > 0) {
        await cleanClient.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await cleanClient.query(`DELETE FROM notification WHERE user_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await cleanClient.query(`DELETE FROM user_role WHERE user_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await cleanClient.query(`DELETE FROM app_user WHERE id = ANY($1::uuid[])`, [cleanup.userIds]);
      }
      if (cleanup.tenantIds.length > 0) {
        await cleanClient.query(`DELETE FROM tenant WHERE id = ANY($1::uuid[])`, [cleanup.tenantIds]);
      }
      if (cleanup.personIds.length > 0) {
        await cleanClient.query(`DELETE FROM person WHERE id = ANY($1::uuid[])`, [cleanup.personIds]);
      }

      await cleanClient.query('COMMIT');
    } catch (cleanErr) {
      await cleanClient.query('ROLLBACK').catch(() => {});
      console.error('[Cleanup Warning]:', cleanErr.message);
    } finally {
      cleanClient.release();
    }
    await new Promise((resolve) => server.close(resolve));
    await adminPool.end();
    await appAdminPool.end().catch(() => {});
    await appPool.end().catch(() => {});
  }
});
