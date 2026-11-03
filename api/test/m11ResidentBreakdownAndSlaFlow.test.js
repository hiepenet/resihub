import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();

const ADMIN_DB_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

process.env.DATABASE_URL = ADMIN_DB_URL;
process.env.APP_DATABASE_URL = APP_DB_URL;

const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('M11 Resident Breakdown Lifecycle, 24h Duplicate Check, Confidentiality & SLA Escalation', async (t) => {
  const localAdminPool = new pg.Pool({
    connectionString: ADMIN_DB_URL,
    options: '-c timezone=Asia/Ho_Chi_Minh',
  });

  const { JWT_SECRET } = await import('../src/config/env.js');
  const { adminPool: appAdminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: residentRoute } = await import('../src/routes/resident.js');
  const { default: serviceRequestsRoute } = await import('../src/routes/service-requests.js');
  const { default: reportsRoute } = await import('../src/routes/reports.js');
  const { default: settingsRoute } = await import('../src/routes/settings.js');
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
  app.use('/api/v1/resident', residentRoute);
  app.use('/api/v1/service-requests', serviceRequestsRoute);
  app.use('/api/v1/reports', reportsRoute);
  app.use('/api/v1/settings', settingsRoute);
  app.use('/api/v1/attachments', attachmentsRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  const cleanup = {
    srIds: [],
    contractOccupantIds: [],
    contractIds: [],
    apartmentIds: [],
    userRoleIds: [],
    userIds: [],
    tenantIds: [],
    personIds: [],
  };

  t.after(async () => {
    for (const srId of cleanup.srIds) {
      await localAdminPool
        .query("DELETE FROM notification WHERE (payload->>'service_request_id') = $1", [srId])
        .catch(() => {});
      await localAdminPool
        .query("DELETE FROM attachment WHERE owner_entity = 'service_request' AND owner_id = $1", [srId])
        .catch(() => {});
      await localAdminPool
        .query("DELETE FROM audit_log WHERE entity = 'service_request' AND entity_id = $1", [srId])
        .catch(() => {});
      await localAdminPool.query('DELETE FROM service_request WHERE id = $1', [srId]).catch(() => {});
    }
    for (const aptId of cleanup.apartmentIds) {
      await localAdminPool
        .query('DELETE FROM service_request WHERE apartment_id = $1', [aptId])
        .catch(() => {});
    }
    for (const id of cleanup.contractOccupantIds) {
      await localAdminPool.query('DELETE FROM contract_occupant WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.contractIds) {
      await localAdminPool.query('DELETE FROM contract WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.apartmentIds) {
      await localAdminPool.query('DELETE FROM apartment WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.userRoleIds) {
      await localAdminPool.query('DELETE FROM user_role WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.userIds) {
      await localAdminPool
        .query('DELETE FROM idempotency_key WHERE user_id = $1', [id])
        .catch(() => {});
      await localAdminPool.query('DELETE FROM notification WHERE user_id = $1', [id]).catch(() => {});
      await localAdminPool.query('DELETE FROM app_user WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.tenantIds) {
      await localAdminPool.query('DELETE FROM tenant WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.personIds) {
      await localAdminPool.query('DELETE FROM person WHERE id = $1', [id]).catch(() => {});
    }
    await new Promise((resolve) => server.close(resolve));
    await localAdminPool.end().catch(() => {});
    await appPool.end().catch(() => {});
    await appAdminPool.end().catch(() => {});
  });

  async function apiFetch(path, token, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const idemHeader =
      ['POST', 'PUT', 'PATCH'].includes(method) && !options.headers?.['Idempotency-Key']
        ? { 'Idempotency-Key': crypto.randomUUID() }
        : {};
    const headers = {
      'Content-Type': 'application/json',
      ...idemHeader,
      ...(options.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  }

  function signToken({ sub, person_id, org_id, roles }) {
    return jwt.sign({ sub, person_id, org_id, roles }, JWT_SECRET, { expiresIn: '1h' });
  }

  // Resolve seeded buildings & staff accounts
  const bldgRes = await localAdminPool.query(
    `SELECT id, code, org_id FROM building WHERE code IN ('VOP-A', 'VOP-B') ORDER BY code`
  );
  const vopA = bldgRes.rows.find((r) => r.code === 'VOP-A');
  const vopB = bldgRes.rows.find((r) => r.code === 'VOP-B');
  const orgId = vopA.org_id;

  const sysAdminRow = (
    await localAdminPool.query(`
      SELECT au.id, au.person_id FROM app_user au
      JOIN user_role ur ON ur.user_id = au.id
      JOIN role r ON r.id = ur.role_id
      WHERE r.code = 'SYS_ADMIN' AND au.status = 'ACTIVE' LIMIT 1
    `)
  ).rows[0];
  const sysAdminToken = signToken({
    sub: sysAdminRow.id,
    person_id: sysAdminRow.person_id,
    org_id: orgId,
    roles: ['SYS_ADMIN'],
  });

  const mgrVopARow = (
    await localAdminPool.query(`
      SELECT au.id, au.person_id FROM app_user au
      JOIN person p ON p.id = au.person_id
      WHERE p.email = 'manager.vop.a@resihub.vn' AND au.status = 'ACTIVE' LIMIT 1
    `)
  ).rows[0];
  const mgrVopAToken = signToken({
    sub: mgrVopARow.id,
    person_id: mgrVopARow.person_id,
    org_id: orgId,
    roles: ['MANAGER'],
  });

  const ownerVopRow = (
    await localAdminPool.query(
      `SELECT au.id, au.person_id
       FROM building b
       JOIN owner o ON o.id = b.owner_id
       JOIN app_user au ON au.person_id = o.person_id
       WHERE b.id = $1 AND au.status = 'ACTIVE' LIMIT 1`,
      [vopA.id]
    )
  ).rows[0];
  const ownerVopToken = signToken({
    sub: ownerVopRow.id,
    person_id: ownerVopRow.person_id,
    org_id: orgId,
    roles: ['OWNER'],
  });

  // Create isolated apartment + ACTIVE contract + primary resident + household occupant in VOP-A
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const floorRow = (
    await localAdminPool.query(`SELECT id FROM floor WHERE building_id = $1 ORDER BY level LIMIT 1`, [
      vopA.id,
    ])
  ).rows[0];
  const aptRes = await localAdminPool.query(
    `INSERT INTO apartment (building_id, floor_id, code, area_m2, type, bedrooms, base_rent, status)
     VALUES ($1, $2, $3, 35, 'STUDIO', 1, 8000000, 'OCCUPIED') RETURNING id`,
    [vopA.id, floorRow.id, `M11-${suffix}`]
  );
  const aptId = aptRes.rows[0].id;
  cleanup.apartmentIds.push(aptId);

  const vopBFloor = (
    await localAdminPool.query(`SELECT id FROM floor WHERE building_id = $1 ORDER BY level LIMIT 1`, [
      vopB.id,
    ])
  ).rows[0];
  const vopBApt = (
    await localAdminPool.query(
      `INSERT INTO apartment (building_id, floor_id, code, area_m2, type, bedrooms, base_rent, status)
       VALUES ($1, $2, $3, 35, 'STUDIO', 1, 7500000, 'OCCUPIED') RETURNING id`,
      [vopB.id, vopBFloor.id, `M11B-${suffix}`]
    )
  ).rows[0];
  cleanup.apartmentIds.push(vopBApt.id);

  const resRoleId = (
    await localAdminPool.query(`SELECT id FROM role WHERE org_id = $1 AND code = 'RESIDENT' LIMIT 1`, [
      orgId,
    ])
  ).rows[0].id;

  async function createResidentAccount(label, tenantType) {
    const phone = `097${Math.floor(1000000 + Math.random() * 8999999)}`;
    const p = (
      await localAdminPool.query(
        `INSERT INTO person (org_id, full_name, phone, email) VALUES ($1, $2, $3, $4) RETURNING id`,
        [orgId, `${label} ${suffix}`, phone, `${label.toLowerCase()}.${suffix}@resihub.test`]
      )
    ).rows[0];
    cleanup.personIds.push(p.id);

    const ten = (
      await localAdminPool.query(
        `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, $3, 'APPROVED') RETURNING id`,
        [orgId, p.id, tenantType]
      )
    ).rows[0];
    cleanup.tenantIds.push(ten.id);

    const u = (
      await localAdminPool.query(
        `INSERT INTO app_user (person_id, status) VALUES ($1, 'ACTIVE') RETURNING id`,
        [p.id]
      )
    ).rows[0];
    cleanup.userIds.push(u.id);

    const ur = (
      await localAdminPool.query(
        `INSERT INTO user_role (user_id, role_id) VALUES ($1, $2) RETURNING id`,
        [u.id, resRoleId]
      )
    ).rows[0];
    cleanup.userRoleIds.push(ur.id);

    return {
      personId: p.id,
      tenantId: ten.id,
      userId: u.id,
      token: signToken({ sub: u.id, person_id: p.id, org_id: orgId, roles: ['RESIDENT'] }),
    };
  }

  const primaryRes = await createResidentAccount('PrimaryM11', 'primary');
  const occupantRes = await createResidentAccount('OccupantM11', 'occupant');

  const ctrRes = await localAdminPool.query(
    `INSERT INTO contract (
       building_id, apartment_id, primary_tenant_id, start_date, end_date,
       rent_amount, deposit_amount, billing_day, status
     )
     VALUES ($1, $2, $3, CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '350 days', 8000000, 8000000, 5, 'ACTIVE')
     RETURNING id`,
    [vopA.id, aptId, primaryRes.tenantId]
  );
  const contractId = ctrRes.rows[0].id;
  cleanup.contractIds.push(contractId);

  const coRes = await localAdminPool.query(
    `INSERT INTO contract_occupant (contract_id, tenant_id, relationship)
     VALUES ($1, $2, 'SIBLING') RETURNING id`,
    [contractId, occupantRes.tenantId]
  );
  cleanup.contractOccupantIds.push(coRes.rows[0].id);

  let primarySrId;
  let occupantUrgentSrId;

  await t.test('1. Resident + Occupant intake, Vietnam SLA deadlines & Manager notifications', async () => {
    const srNormal = await apiFetch('/api/v1/resident/service-requests', primaryRes.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: contractId,
        category: 'PLUMBING',
        title: 'Rỉ nước vòi xịt vệ sinh',
        description: 'Đầu nối dây xịt rò nước nhỏ giọt liên tục.',
        location_detail: 'Nhà vệ sinh chính',
        preferred_slot: 'MORNING_08_12',
        priority: 'NORMAL',
        images: [TINY_PNG_BASE64],
      }),
    });
    assert.equal(srNormal.status, 201, `Primary create failed: ${JSON.stringify(srNormal.body)}`);
    primarySrId = srNormal.body.data.id;
    cleanup.srIds.push(primarySrId);
    assert.match(srNormal.body.data.tracking_code, /^SR-\d{8}-\d+$/);
    assert.equal(srNormal.body.data.location_detail, 'Nhà vệ sinh chính');
    assert.equal(srNormal.body.data.preferred_slot, 'MORNING_08_12');
    assert.ok(srNormal.body.data.sla_response_due_at, 'sla_response_due_at must be set');
    assert.ok(srNormal.body.data.sla_due_at, 'sla_due_at must be set');

    const createdMs = new Date(srNormal.body.data.created_at).getTime();
    const dueMs = new Date(srNormal.body.data.sla_due_at).getTime();
    const diffHoursNormal = Math.round((dueMs - createdMs) / 3600000);
    assert.equal(diffHoursNormal, 24);

    // Household occupant submits URGENT request on same contract apartment
    const srUrgent = await apiFetch('/api/v1/resident/service-requests', occupantRes.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: contractId,
        category: 'ELECTRICAL',
        title: 'Chập ổ điện bếp có mùi khét',
        description: 'Ổ cắm bếp từ tóe tia lửa, đã ngắt aptomat.',
        location_detail: 'Bếp nấu',
        preferred_slot: 'ANYTIME',
        priority: 'URGENT',
      }),
    });
    assert.equal(srUrgent.status, 201, `Occupant create failed: ${JSON.stringify(srUrgent.body)}`);
    occupantUrgentSrId = srUrgent.body.data.id;
    cleanup.srIds.push(occupantUrgentSrId);

    const diffHoursUrgent = Math.round(
      (new Date(srUrgent.body.data.sla_due_at).getTime() -
        new Date(srUrgent.body.data.created_at).getTime()) /
        3600000
    );
    assert.equal(diffHoursUrgent, 4);

    // Manager notification check
    const mgrNotifRes = await localAdminPool.query(
      `SELECT type FROM notification
       WHERE user_id = $1 AND (payload->>'service_request_id') = ANY($2::text[])`,
      [mgrVopARow.id, [primarySrId, occupantUrgentSrId]]
    );
    const notifTypes = new Set(mgrNotifRes.rows.map((r) => r.type));
    assert.equal(notifTypes.has('SERVICE_REQUEST_CREATED'), true);
    assert.equal(notifTypes.has('SERVICE_REQUEST_URGENT'), true);
  });

  await t.test('2. 24h Duplicate Window: blocks within 24h unless ignore_duplicate_warning, allows > 24h', async () => {
    const dupRes = await apiFetch('/api/v1/resident/service-requests', occupantRes.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: contractId,
        category: 'PLUMBING',
        description: 'Báo lại vòi xịt rỉ nước',
      }),
    });
    assert.equal(dupRes.status, 409);
    assert.equal(dupRes.body.code, 'DUPLICATE_SERVICE_REQUEST');
    assert.ok(dupRes.body.existing_request?.tracking_code);

    const forcedRes = await apiFetch('/api/v1/resident/service-requests', occupantRes.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: contractId,
        category: 'PLUMBING',
        description: 'Vị trí khác ở bồn rửa mặt cũng rò',
        ignore_duplicate_warning: true,
      }),
    });
    assert.equal(forcedRes.status, 201);
    cleanup.srIds.push(forcedRes.body.data.id);

    // Backdate open HVAC request to 25h ago -> must NOT block new HVAC request
    const oldHvac = await localAdminPool.query(
      `INSERT INTO service_request (org_id, building_id, apartment_id, created_by, title, category, description, status, tracking_code, created_at)
       VALUES ($1, $2, $3, $4, 'Old HVAC', 'HVAC', 'Điều hòa kêu', 'IN_PROGRESS', $5, NOW() - INTERVAL '25 hours')
       RETURNING id`,
      [orgId, vopA.id, aptId, primaryRes.userId, `SR-25H-${suffix}`]
    );
    cleanup.srIds.push(oldHvac.rows[0].id);

    const after25h = await apiFetch('/api/v1/resident/service-requests', primaryRes.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: contractId,
        category: 'HVAC',
        description: 'Điều hòa phòng khách chảy nước dàn lạnh',
      }),
    });
    assert.equal(after25h.status, 201, `>24h open request must not block: ${JSON.stringify(after25h.body)}`);
    cleanup.srIds.push(after25h.body.data.id);

    // Self-cancel that NEW HVAC request right away
    const cancelNew = await apiFetch(
      `/api/v1/resident/service-requests/${after25h.body.data.id}/cancel`,
      primaryRes.token,
      {
        method: 'POST',
        body: JSON.stringify({ cancel_reason: 'Đã tự thông ống thoát nước ngưng' }),
      }
    );
    assert.equal(cancelNew.status, 200);
    assert.equal(cancelNew.body.data.status, 'CANCELLED');
  });

  await t.test('3. Confidentiality, ON_HOLD, Resolution Photos, Reopen & Self-Cancel Guard', async () => {
    // Manager assigns occupantUrgentSrId -> resident cancel must fail 409
    const assignUrg = await apiFetch(
      `/api/v1/service-requests/${occupantUrgentSrId}/status`,
      mgrVopAToken,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'ASSIGNED', assigned_to: mgrVopARow.id }),
      }
    );
    assert.equal(assignUrg.status, 200);
    assert.ok(assignUrg.body.data.first_responded_at, 'first_responded_at stamped on leaving NEW');

    const cancelAssigned = await apiFetch(
      `/api/v1/resident/service-requests/${occupantUrgentSrId}/cancel`,
      occupantRes.token,
      {
        method: 'POST',
        body: JSON.stringify({ cancel_reason: 'Muốn hủy' }),
      }
    );
    assert.equal(cancelAssigned.status, 409);
    assert.equal(cancelAssigned.body.code, 'INVALID_STATUS_TRANSITION');

    // Manager transitions primarySrId NEW -> ON_HOLD without hold_reason -> fails
    const badHold = await apiFetch(`/api/v1/service-requests/${primarySrId}/status`, mgrVopAToken, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ON_HOLD' }),
    });
    assert.equal([400, 422].includes(badHold.status), true);
    assert.equal(badHold.body.code, 'HOLD_REASON_REQUIRED');

    const nextAppt = new Date(Date.now() + 6 * 3600000).toISOString();
    const okHold = await apiFetch(`/api/v1/service-requests/${primarySrId}/status`, mgrVopAToken, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'ON_HOLD',
        hold_reason: 'Chờ nhập van khóa đồng phi 21',
        next_appointment_at: nextAppt,
      }),
    });
    assert.equal(okHold.status, 200);
    assert.equal(okHold.body.data.status, 'ON_HOLD');
    assert.ok(okHold.body.data.first_responded_at);

    // Manager transitions ON_HOLD -> RESOLVED with confidential internal_note + resolution_note + resolution_images
    const resolveRes = await apiFetch(`/api/v1/service-requests/${primarySrId}/status`, mgrVopAToken, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'RESOLVED',
        internal_note: 'Bí mật nhà thầu 500k',
        resolution_note: 'Đã thay phao bồn cầu mới',
        resolution_images: [TINY_PNG_BASE64],
      }),
    });
    assert.equal(resolveRes.status, 200);
    assert.equal(resolveRes.body.data.status, 'RESOLVED');
    const origTrackingCode = resolveRes.body.data.tracking_code;
    const origSlaDueAt = resolveRes.body.data.sla_due_at;

    // Review Focus #1: Resident GET list must include resolution_note & resolution_images and NEVER internal_note
    const resList = await apiFetch('/api/v1/resident/service-requests', occupantRes.token);
    assert.equal(resList.status, 200);
    const targetRow = resList.body.data.find((r) => r.id === primarySrId);
    assert.ok(targetRow, 'Occupant must see apartment service request');
    assert.equal(targetRow.resolution_note, 'Đã thay phao bồn cầu mới');
    assert.equal(Array.isArray(targetRow.resolution_images), true);
    assert.equal(targetRow.resolution_images.length, 1);
    assert.equal(targetRow.internal_note, undefined, 'internal_note MUST NOT leak to resident API');

    // Resident reopens within window
    const reopenRes = await apiFetch(
      `/api/v1/resident/service-requests/${primarySrId}/reopen`,
      primaryRes.token,
      {
        method: 'POST',
        body: JSON.stringify({ reopen_reason: 'Vẫn còn rỉ nước ở khớp nối ren trong' }),
      }
    );
    assert.equal(reopenRes.status, 200, `Reopen failed: ${JSON.stringify(reopenRes.body)}`);
    assert.equal(reopenRes.body.data.status, 'REOPENED');
    assert.equal(reopenRes.body.data.reopen_count, 1);
    assert.equal(reopenRes.body.data.tracking_code, origTrackingCode);
    assert.equal(
      new Date(reopenRes.body.data.sla_due_at).toISOString(),
      new Date(origSlaDueAt).toISOString()
    );
    assert.equal(reopenRes.body.data.internal_note, undefined, 'internal_note must not leak on reopen');

    // Resolve again, backdate resolved_at by 4 days -> reopen blocked with 409 REOPEN_WINDOW_EXPIRED
    await apiFetch(`/api/v1/service-requests/${primarySrId}/status`, mgrVopAToken, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'RESOLVED', resolution_note: 'Đã quấn thêm băng tan kỹ' }),
    });
    await localAdminPool.query(
      `UPDATE service_request SET resolved_at = NOW() - INTERVAL '4 days' WHERE id = $1`,
      [primarySrId]
    );
    const expiredReopen = await apiFetch(
      `/api/v1/resident/service-requests/${primarySrId}/reopen`,
      primaryRes.token,
      {
        method: 'POST',
        body: JSON.stringify({ reopen_reason: 'Muốn mở lại sau 4 ngày' }),
      }
    );
    assert.equal(expiredReopen.status, 409);
    assert.equal(expiredReopen.body.code, 'REOPEN_WINDOW_EXPIRED');
  });

  await t.test('4. SLA Escalation stamps sla_breached_at & notifies MANAGER + OWNER idempotently', async () => {
    assert.equal(typeof dailyModule.escalateOverdueServiceRequests, 'function');

    await localAdminPool.query(
      `UPDATE service_request SET sla_due_at = NOW() - INTERVAL '1 hour', sla_breached_at = NULL WHERE id = $1`,
      [occupantUrgentSrId]
    );

    const run1 = await dailyModule.escalateOverdueServiceRequests(localAdminPool, {
      buildingId: vopA.id,
    });
    assert.ok(run1.escalatedCount >= 1);

    const srAfter = (
      await localAdminPool.query(`SELECT sla_breached_at FROM service_request WHERE id = $1`, [
        occupantUrgentSrId,
      ])
    ).rows[0];
    assert.ok(srAfter.sla_breached_at, 'sla_breached_at must be stamped');

    const breachNotifs = await localAdminPool.query(
      `SELECT user_id FROM notification
       WHERE type = 'SERVICE_REQUEST_SLA_BREACH' AND (payload->>'service_request_id') = $1`,
      [occupantUrgentSrId]
    );
    const notifiedUsers = new Set(breachNotifs.rows.map((r) => r.user_id));
    assert.equal(notifiedUsers.has(mgrVopARow.id), true, 'Building MANAGER must receive SLA breach alert');
    assert.equal(notifiedUsers.has(ownerVopRow.id), true, 'Building OWNER must receive SLA breach alert');

    // Overdue filter in GET /api/v1/service-requests?overdue_sla=true
    const overdueList = await apiFetch(
      `/api/v1/service-requests?building_id=${vopA.id}&overdue_sla=true`,
      mgrVopAToken
    );
    assert.equal(overdueList.status, 200);
    assert.equal(
      overdueList.body.data.some((r) => r.id === occupantUrgentSrId && r.is_sla_overdue === true),
      true
    );

    // Detail endpoint includes audit_timeline & zalo_room_message_preview
    const detail = await apiFetch(`/api/v1/service-requests/${primarySrId}`, mgrVopAToken);
    assert.equal(detail.status, 200);
    assert.equal(Array.isArray(detail.body.data.audit_timeline), true);
    assert.ok(detail.body.data.zalo_room_message_preview);

    // Re-running escalation is idempotent
    const run2 = await dailyModule.escalateOverdueServiceRequests(localAdminPool, {
      buildingId: vopA.id,
    });
    assert.equal(run2.escalatedCount, 0);
  });

  await t.test('5. RBAC & Cross-Building 403 ACCESS_DENIED + Audit Log', async () => {
    for (const roToken of [sysAdminToken, ownerVopToken]) {
      const postRes = await apiFetch('/api/v1/service-requests', roToken, {
        method: 'POST',
        body: JSON.stringify({
          apartment_id: aptId,
          title: 'RO Write',
          category: 'OTHER',
          description: 'Test',
        }),
      });
      assert.equal(postRes.status, 403);

      const patchRes = await apiFetch(
        `/api/v1/service-requests/${occupantUrgentSrId}/status`,
        roToken,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: 'IN_PROGRESS' }),
        }
      );
      assert.equal(patchRes.status, 403);
    }

    // Seed a service request in VOP-B and verify VOP-A manager gets 403 ACCESS_DENIED + audit_log
    const vopBSr = (
      await localAdminPool.query(
        `INSERT INTO service_request (org_id, building_id, apartment_id, title, category, description, status, tracking_code)
         VALUES ($1, $2, $3, 'VOP-B SR', 'OTHER', 'Desc', 'NEW', $4) RETURNING id`,
        [orgId, vopB.id, vopBApt.id, `SR-VOPB-${suffix}`]
      )
    ).rows[0];
    cleanup.srIds.push(vopBSr.id);

    const crossPatch = await apiFetch(`/api/v1/service-requests/${vopBSr.id}/status`, mgrVopAToken, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'IN_PROGRESS' }),
    });
    assert.equal(crossPatch.status, 403);
    assert.equal(crossPatch.body.code, 'ACCESS_DENIED');

    const deniedAudit = await localAdminPool.query(
      `SELECT id FROM audit_log
       WHERE actor_id = $1 AND action = 'ACCESS_DENIED' AND entity = 'service_request'
       ORDER BY id DESC LIMIT 1`,
      [mgrVopARow.id]
    );
    assert.ok(deniedAudit.rows.length > 0, 'Must log ACCESS_DENIED on cross-building service_request write');
  });

  await t.test('6. Legacy /service-requests/:id/rating writes audit_log + manager notification & resolution_images use unified service_request folder', async () => {
    const rateRes = await apiFetch(`/api/v1/service-requests/${primarySrId}/rating`, primaryRes.token, {
      method: 'POST',
      body: JSON.stringify({ rating: 5, rating_note: 'Xử lý triệt để, rất hài lòng' }),
    });
    assert.equal(rateRes.status, 200, `Rating failed: ${JSON.stringify(rateRes.body)}`);
    assert.equal(rateRes.body.data.status, 'CLOSED');
    assert.equal(rateRes.body.data.internal_note, undefined, 'internal_note must not leak on legacy rating');

    const rateAudit = await localAdminPool.query(
      `SELECT id FROM audit_log
       WHERE action = 'RATE_SERVICE_REQUEST' AND entity = 'service_request' AND entity_id = $1`,
      [primarySrId]
    );
    assert.equal(rateAudit.rows.length, 1, 'Legacy /service-requests/:id/rating must write RATE_SERVICE_REQUEST audit_log');

    const rateNotifs = await localAdminPool.query(
      `SELECT user_id FROM notification
       WHERE type = 'SERVICE_REQUEST_RATED' AND (payload->>'service_request_id') = $1`,
      [primarySrId]
    );
    assert.equal(
      rateNotifs.rows.some((r) => r.user_id === mgrVopARow.id),
      true,
      'Legacy /service-requests/:id/rating must notify building MANAGER'
    );

    const attRows = await localAdminPool.query(
      `SELECT storage_path FROM attachment WHERE owner_entity = 'service_request' AND owner_id = $1`,
      [primarySrId]
    );
    assert.ok(attRows.rows.length >= 1, 'Expected at least 1 attachment on primarySrId');
    for (const row of attRows.rows) {
      assert.equal(
        row.storage_path.startsWith('uploads/service_request/'),
        true,
        `Expected unified uploads/service_request/ folder, got: ${row.storage_path}`
      );
    }
  });
});
