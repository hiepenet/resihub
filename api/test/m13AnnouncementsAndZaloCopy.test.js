import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
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

test('M13 Announcements, Zalo Group Directory, 2-Step Broadcast & Manual-Zalo-Sent Tracking', async (t) => {
  const localAdminPool = new pg.Pool({
    connectionString: ADMIN_DB_URL,
    options: '-c timezone=Asia/Ho_Chi_Minh',
  });
  const localAppPool = new pg.Pool({
    connectionString: APP_DB_URL,
    options: '-c timezone=Asia/Ho_Chi_Minh',
  });

  const { JWT_SECRET } = await import('../src/config/env.js');
  const { adminPool: appAdminPool, appPool } = await import('../src/db/client.js');
  const { default: notificationsRoute } = await import('../src/routes/notifications.js');
  const zaloGroupsMod = await import('../src/routes/zalo-groups.js').catch(() => null);
  const announcementsMod = await import('../src/routes/announcements.js').catch(() => null);
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
  app.use('/api/v1/notifications', notificationsRoute);
  if (zaloGroupsMod?.default) {
    app.use('/api/v1/zalo-groups', zaloGroupsMod.default);
  }
  if (announcementsMod?.default) {
    app.use('/api/v1/announcements', announcementsMod.default);
  }
  app.use((req, res) => {
    res.status(404).json({ code: 'ROUTE_NOT_FOUND', message: `Not found: ${req.originalUrl}` });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  const cleanup = {
    announcementIds: [],
    zaloGroupIds: [],
    contractOccupantIds: [],
    contractIds: [],
    apartmentIds: [],
    userRoleIds: [],
    userIds: [],
    tenantIds: [],
    personIds: [],
  };

  t.after(async () => {
    for (const annId of cleanup.announcementIds) {
      await localAdminPool
        .query('DELETE FROM notification WHERE announcement_id = $1', [annId])
        .catch(() => {});
      await localAdminPool.query('DELETE FROM announcement WHERE id = $1', [annId]).catch(() => {});
    }
    for (const zgId of cleanup.zaloGroupIds) {
      await localAdminPool.query('DELETE FROM zalo_group WHERE id = $1', [zgId]).catch(() => {});
    }
    for (const id of cleanup.contractOccupantIds) {
      await localAdminPool.query('DELETE FROM contract_occupant WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.contractIds) {
      await localAdminPool.query('DELETE FROM contract WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.apartmentIds) {
      await localAdminPool
        .query('DELETE FROM zalo_group WHERE apartment_id = $1', [id])
        .catch(() => {});
      await localAdminPool
        .query('DELETE FROM announcement WHERE apartment_id = $1', [id])
        .catch(() => {});
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
    await localAppPool.end().catch(() => {});
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

  // Isolated apartment + ACTIVE contract + primary resident + household occupant in VOP-A
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const floorRow = (
    await localAdminPool.query(`SELECT id FROM floor WHERE building_id = $1 ORDER BY level LIMIT 1`, [
      vopA.id,
    ])
  ).rows[0];
  const aptRes = await localAdminPool.query(
    `INSERT INTO apartment (building_id, floor_id, code, area_m2, type, bedrooms, base_rent, status)
     VALUES ($1, $2, $3, 40, 'STUDIO', 1, 8200000, 'OCCUPIED') RETURNING id`,
    [vopA.id, floorRow.id, `M13-${suffix}`]
  );
  const aptId = aptRes.rows[0].id;
  cleanup.apartmentIds.push(aptId);

  const resRoleId = (
    await localAdminPool.query(`SELECT id FROM role WHERE org_id = $1 AND code = 'RESIDENT' LIMIT 1`, [
      orgId,
    ])
  ).rows[0].id;

  async function createResidentAccount(label, tenantType) {
    const phone = `096${Math.floor(1000000 + Math.random() * 8999999)}`;
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

  const primaryRes = await createResidentAccount('PrimaryM13', 'primary');
  const occupantRes = await createResidentAccount('OccupantM13', 'occupant');

  const ctrRes = await localAdminPool.query(
    `INSERT INTO contract (
       building_id, apartment_id, primary_tenant_id, start_date, end_date,
       rent_amount, deposit_amount, billing_day, status
     )
     VALUES ($1, $2, $3, CURRENT_DATE - INTERVAL '5 days', CURRENT_DATE + INTERVAL '350 days', 8200000, 8200000, 5, 'ACTIVE')
     RETURNING id`,
    [vopA.id, aptId, primaryRes.tenantId]
  );
  const contractId = ctrRes.rows[0].id;
  cleanup.contractIds.push(contractId);

  const coRes = await localAdminPool.query(
    `INSERT INTO contract_occupant (contract_id, tenant_id, relationship)
     VALUES ($1, $2, 'SPOUSE') RETURNING id`,
    [contractId, occupantRes.tenantId]
  );
  cleanup.contractOccupantIds.push(coRes.rows[0].id);

  let bldgGroupId;
  let aptGroupId;
  let draftAnnouncementId;

  await t.test('1. Zalo Group Directory, Link Validation, Cross-Building 403 & RBAC', async () => {
    const createBldgGrp = await apiFetch('/api/v1/zalo-groups', mgrVopAToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopA.id,
        scope: 'BUILDING',
        name: `Nhóm Cư dân Tòa VOP-A (${suffix})`,
        invite_link: `https://zalo.me/g/vopa_main_${suffix.toLowerCase()}`,
        note: 'Nhóm thông báo chung tòa VOP-A',
      }),
    });
    assert.equal(createBldgGrp.status, 201, `Create BUILDING group failed: ${JSON.stringify(createBldgGrp.body)}`);
    bldgGroupId = createBldgGrp.body.data.id;
    cleanup.zaloGroupIds.push(bldgGroupId);

    const createAptGrp = await apiFetch('/api/v1/zalo-groups', mgrVopAToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopA.id,
        scope: 'APARTMENT',
        apartment_id: aptId,
        name: `Zalo Phòng M13-${suffix}`,
        invite_link: `https://zalo.me/g/vopa_apt_${suffix.toLowerCase()}`,
      }),
    });
    assert.equal(createAptGrp.status, 201);
    aptGroupId = createAptGrp.body.data.id;
    cleanup.zaloGroupIds.push(aptGroupId);

    const badLink = await apiFetch('/api/v1/zalo-groups', mgrVopAToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopA.id,
        scope: 'BUILDING',
        name: `Bad Link ${suffix}`,
        invite_link: 'javascript:alert(1)',
      }),
    });
    assert.equal(badLink.status, 422);
    assert.equal(badLink.body.code, 'INVALID_ZALO_LINK');

    // Cross-building GET & POST -> 403 ACCESS_DENIED
    const crossGet = await apiFetch(`/api/v1/zalo-groups?building_id=${vopB.id}`, mgrVopAToken);
    assert.equal(crossGet.status, 403);
    assert.equal(crossGet.body.code, 'ACCESS_DENIED');

    const crossPost = await apiFetch('/api/v1/zalo-groups', mgrVopAToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopB.id,
        scope: 'BUILDING',
        name: `Cross Bldg ${suffix}`,
        invite_link: 'https://zalo.me/g/vopb_test',
      }),
    });
    assert.equal(crossPost.status, 403);
    assert.equal(crossPost.body.code, 'ACCESS_DENIED');

    // OWNER & SYS_ADMIN Read-Only: GET 200, POST/PUT 403
    for (const roToken of [ownerVopToken, sysAdminToken]) {
      const getRes = await apiFetch(`/api/v1/zalo-groups?building_id=${vopA.id}`, roToken);
      assert.equal(getRes.status, 200);
      assert.equal(getRes.body.data.some((g) => g.id === bldgGroupId), true);

      const postRes = await apiFetch('/api/v1/zalo-groups', roToken, {
        method: 'POST',
        body: JSON.stringify({
          building_id: vopA.id,
          scope: 'BUILDING',
          name: `RO Group ${suffix}`,
          invite_link: 'https://zalo.me/g/ro_test',
        }),
      });
      assert.equal(postRes.status, 403);

      const putRes = await apiFetch(`/api/v1/zalo-groups/${bldgGroupId}`, roToken, {
        method: 'PUT',
        body: JSON.stringify({ note: 'Should fail' }),
      });
      assert.equal(putRes.status, 403);
    }

    // MANAGER PUT /:id succeeds
    const mgrUpdate = await apiFetch(`/api/v1/zalo-groups/${bldgGroupId}`, mgrVopAToken, {
      method: 'PUT',
      body: JSON.stringify({ note: 'Đã cập nhật ghi chú nhóm tòa' }),
    });
    assert.equal(mgrUpdate.status, 200);
    assert.equal(mgrUpdate.body.data.note, 'Đã cập nhật ghi chú nhóm tòa');
  });

  await t.test('2. Draft -> 2-Step Send Confirmation -> Primary + Occupant Fan-Out & Read Counter', async () => {
    const tplRes = await apiFetch('/api/v1/announcements/templates', mgrVopAToken);
    assert.equal(tplRes.status, 200);
    assert.equal(Array.isArray(tplRes.body.data), true);
    assert.ok(tplRes.body.data.length >= 4);

    const createDraft = await apiFetch('/api/v1/announcements', mgrVopAToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopA.id,
        target_scope: 'APARTMENT',
        apartment_id: aptId,
        type: 'MAINTENANCE',
        title: `Kiểm tra đồng hồ nước phòng M13-${suffix}`,
        body: 'Kỹ thuật tòa nhà xin phép ghé kiểm tra lúc 15:00 chiều nay.',
      }),
    });
    assert.equal(createDraft.status, 201, `Create draft failed: ${JSON.stringify(createDraft.body)}`);
    draftAnnouncementId = createDraft.body.data.id;
    cleanup.announcementIds.push(draftAnnouncementId);
    assert.equal(createDraft.body.data.status, 'DRAFT');
    assert.ok(createDraft.body.data.zalo_content?.includes(`M13-${suffix}`));
    assert.equal(Array.isArray(createDraft.body.data.target_zalo_groups), true);
    assert.equal(
      createDraft.body.data.target_zalo_groups.some((g) => g.id === aptGroupId),
      true,
      'target_zalo_groups must include room Zalo group'
    );

    // Missing confirm_send: true -> 422 CONFIRMATION_REQUIRED
    const unconfirmedSend = await apiFetch(
      `/api/v1/announcements/${draftAnnouncementId}/send`,
      mgrVopAToken,
      {
        method: 'POST',
        body: JSON.stringify({}),
      }
    );
    assert.equal(unconfirmedSend.status, 422);
    assert.equal(unconfirmedSend.body.code, 'CONFIRMATION_REQUIRED');

    // Confirmed send -> 200 SENT, delivers to BOTH primary + occupant (deduplicated)
    const confirmedSend = await apiFetch(
      `/api/v1/announcements/${draftAnnouncementId}/send`,
      mgrVopAToken,
      {
        method: 'POST',
        body: JSON.stringify({ confirm_send: true }),
      }
    );
    assert.equal(confirmedSend.status, 200, `Confirmed send failed: ${JSON.stringify(confirmedSend.body)}`);
    assert.equal(confirmedSend.body.data.status, 'SENT');
    assert.equal(confirmedSend.body.data.recipient_count, 2);

    const notifRows = await localAdminPool.query(
      `SELECT id, user_id, read_at FROM notification WHERE announcement_id = $1`,
      [draftAnnouncementId]
    );
    assert.equal(notifRows.rows.length, 2);
    const recipientSet = new Set(notifRows.rows.map((r) => r.user_id));
    assert.equal(recipientSet.has(primaryRes.userId), true);
    assert.equal(recipientSet.has(occupantRes.userId), true);

    // Primary resident marks notification read -> GET /api/v1/announcements read_count === 1
    const primaryNotif = notifRows.rows.find((r) => r.user_id === primaryRes.userId);
    const markRead = await apiFetch(`/api/v1/notifications/${primaryNotif.id}/read`, primaryRes.token, {
      method: 'PATCH',
    });
    assert.equal(markRead.status, 200);

    const annList = await apiFetch(`/api/v1/announcements?building_id=${vopA.id}`, mgrVopAToken);
    assert.equal(annList.status, 200);
    const sentRow = annList.body.data.find((a) => a.id === draftAnnouncementId);
    assert.ok(sentRow);
    assert.equal(Number(sentRow.read_count), 1);

    // Calling /send again -> 409 ALREADY_SENT
    const resend = await apiFetch(
      `/api/v1/announcements/${draftAnnouncementId}/send`,
      mgrVopAToken,
      {
        method: 'POST',
        body: JSON.stringify({ confirm_send: true }),
      }
    );
    assert.equal(resend.status, 409);
    assert.equal(resend.body.code, 'ALREADY_SENT');
  });

  await t.test('3. Manual Zalo Copy Tracking stamps manual_sent_at & audit_log visible to OWNER', async () => {
    const markZalo = await apiFetch(
      `/api/v1/announcements/${draftAnnouncementId}/mark-zalo-sent`,
      mgrVopAToken,
      {
        method: 'POST',
        body: JSON.stringify({
          zalo_group_ids: [aptGroupId, bldgGroupId],
          note: 'Đã copy dán vào nhóm Zalo phòng và nhóm tòa',
        }),
      }
    );
    assert.equal(markZalo.status, 200, `mark-zalo-sent failed: ${JSON.stringify(markZalo.body)}`);
    assert.ok(markZalo.body.data.manual_sent_at);
    assert.equal(Array.isArray(markZalo.body.data.manual_sent_groups), true);
    assert.equal(markZalo.body.data.manual_sent_groups.length, 2);

    // Verify building OWNER can read announcement manual_sent_at AND audit_log MARK_ANNOUNCEMENT_ZALO_SENT under RLS
    const ownerAnnList = await apiFetch(`/api/v1/announcements?building_id=${vopA.id}`, ownerVopToken);
    assert.equal(ownerAnnList.status, 200);
    const ownerRow = ownerAnnList.body.data.find((a) => a.id === draftAnnouncementId);
    assert.ok(ownerRow?.manual_sent_at);

    const rlsClient = await localAppPool.connect();
    try {
      await rlsClient.query(`SELECT set_config('app.current_user_id', $1, false)`, [ownerVopRow.id]);
      const auditRes = await rlsClient.query(
        `SELECT action FROM audit_log
         WHERE entity = 'announcement' AND entity_id = $1 AND action = 'MARK_ANNOUNCEMENT_ZALO_SENT'`,
        [draftAnnouncementId]
      );
      assert.equal(auditRes.rows.length, 1, 'OWNER must see MARK_ANNOUNCEMENT_ZALO_SENT audit under RLS');
    } finally {
      await rlsClient.query('RESET app.current_user_id').catch(() => {});
      rlsClient.release();
    }
  });

  await t.test('4. Scheduled Dispatch transitions SCHEDULED -> SENT idempotently', async () => {
    const pastSched = await apiFetch('/api/v1/announcements', mgrVopAToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopA.id,
        target_scope: 'APARTMENT',
        apartment_id: aptId,
        type: 'BILLING_REMINDER',
        title: 'Past schedule test',
        body: 'Should fail',
        scheduled_at: new Date(Date.now() - 3600000).toISOString(),
      }),
    });
    assert.equal(pastSched.status, 422);
    assert.equal(pastSched.body.code, 'INVALID_SCHEDULE_TIME');

    const futureTime = new Date(Date.now() + 2 * 3600000).toISOString();
    const createSched = await apiFetch('/api/v1/announcements', mgrVopAToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopA.id,
        target_scope: 'APARTMENT',
        apartment_id: aptId,
        type: 'BILLING_REMINDER',
        title: `Lịch nhắc thanh toán định kỳ (${suffix})`,
        body: 'Kính mời cư dân kiểm tra hóa đơn tháng này trên ResiHub.',
        scheduled_at: futureTime,
      }),
    });
    assert.equal(createSched.status, 201);
    assert.equal(createSched.body.data.status, 'SCHEDULED');
    const schedId = createSched.body.data.id;
    cleanup.announcementIds.push(schedId);

    await localAdminPool.query(
      `UPDATE announcement SET scheduled_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`,
      [schedId]
    );

    assert.equal(typeof dailyModule.dispatchDueScheduledAnnouncements, 'function');
    const run1 = await dailyModule.dispatchDueScheduledAnnouncements(localAdminPool, {
      buildingId: vopA.id,
    });
    assert.ok(run1.dispatchedCount >= 1);

    const afterSched = (
      await localAdminPool.query(`SELECT status, recipient_count FROM announcement WHERE id = $1`, [
        schedId,
      ])
    ).rows[0];
    assert.equal(afterSched.status, 'SENT');
    assert.equal(Number(afterSched.recipient_count), 2);

    const run2 = await dailyModule.dispatchDueScheduledAnnouncements(localAdminPool, {
      buildingId: vopA.id,
    });
    assert.equal(run2.dispatchedCount, 0);
  });

  await t.test('5. Legacy POST /api/v1/notifications compatibility & SYS_ADMIN/OWNER Read-Only + server.js mount check', async () => {
    const legacyPost = await apiFetch('/api/v1/notifications', mgrVopAToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopA.id,
        target_scope: 'APARTMENT',
        apartment_id: aptId,
        type: 'GENERAL',
        title: `Nhắc đóng cửa sổ khi mưa (${suffix})`,
        content: 'Chiều nay dự báo mưa lớn kèm gió giật, cư dân lưu ý đóng kín cửa ban công.',
      }),
    });
    assert.equal(legacyPost.status, 201, `Legacy POST failed: ${JSON.stringify(legacyPost.body)}`);
    assert.ok(legacyPost.body.announcement_id);
    cleanup.announcementIds.push(legacyPost.body.announcement_id);
    assert.ok(legacyPost.body.zalo_content);
    assert.equal(Array.isArray(legacyPost.body.target_zalo_groups), true);
    assert.equal(legacyPost.body.recipient_count, 2);

    for (const roToken of [sysAdminToken, ownerVopToken]) {
      const roNotif = await apiFetch('/api/v1/notifications', roToken, {
        method: 'POST',
        body: JSON.stringify({
          building_id: vopA.id,
          target_scope: 'BUILDING',
          title: 'RO Broadcast',
          content: 'Should return 403',
        }),
      });
      assert.equal(roNotif.status, 403);
    }

    const serverSource = fs.readFileSync(
      fileURLToPath(new URL('../src/server.js', import.meta.url)),
      'utf8'
    );
    assert.equal(serverSource.includes("'/api/v1/zalo-groups'"), true, 'server.js must mount /api/v1/zalo-groups');
    assert.equal(serverSource.includes("'/api/v1/announcements'"), true, 'server.js must mount /api/v1/announcements');
  });
});
