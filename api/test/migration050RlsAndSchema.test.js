import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
}
if (!process.env.APP_DATABASE_URL) {
  process.env.APP_DATABASE_URL =
    'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';
}

const adminPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c timezone=Asia/Ho_Chi_Minh',
});

const appPool = new pg.Pool({
  connectionString: process.env.APP_DATABASE_URL,
  options: '-c timezone=Asia/Ho_Chi_Minh',
});

async function asUserTx(userId, fn) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    if (userId) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(userId)]);
    } else {
      await client.query("SELECT set_config('app.current_user_id', '', true)");
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

test('Migration 050: M11 SLA/Reopen Schema, M13 announcement + zalo_group Tables & 2-Layer RLS', async (t) => {
  const cleanup = {
    notificationIds: [],
    auditIds: [],
    srIds: [],
    annIds: [],
    zaloGroupIds: [],
    contractOccupantIds: [],
    userRoleIds: [],
    userIds: [],
    tenantIds: [],
    personIds: [],
  };

  t.after(async () => {
    for (const id of cleanup.notificationIds) {
      await adminPool.query('DELETE FROM notification WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.auditIds) {
      await adminPool.query('DELETE FROM audit_log WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.srIds) {
      await adminPool.query('DELETE FROM notification WHERE (payload->>\'service_request_id\') = $1', [id]).catch(() => {});
      await adminPool.query('DELETE FROM service_request WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.annIds) {
      await adminPool.query('DELETE FROM notification WHERE announcement_id = $1', [id]).catch(() => {});
      await adminPool.query('DELETE FROM announcement WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.zaloGroupIds) {
      await adminPool.query('DELETE FROM zalo_group WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.contractOccupantIds) {
      await adminPool.query('DELETE FROM contract_occupant WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.userRoleIds) {
      await adminPool.query('DELETE FROM user_role WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.userIds) {
      await adminPool.query('DELETE FROM app_user WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.tenantIds) {
      await adminPool.query('DELETE FROM tenant WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.personIds) {
      await adminPool.query('DELETE FROM person WHERE id = $1', [id]).catch(() => {});
    }
    await appPool.end().catch(() => {});
    await adminPool.end().catch(() => {});
  });

  // Resolve seeded buildings & actors
  const vopARes = await adminPool.query(`SELECT id, org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const vopBRes = await adminPool.query(`SELECT id, org_id FROM building WHERE code = 'VOP-B' LIMIT 1`);
  const vscARes = await adminPool.query(`SELECT id, org_id FROM building WHERE code = 'VSC-A' LIMIT 1`);
  assert.ok(vopARes.rows.length > 0 && vopBRes.rows.length > 0 && vscARes.rows.length > 0);

  const vopAId = vopARes.rows[0].id;
  const vopBId = vopBRes.rows[0].id;
  const vscAId = vscARes.rows[0].id;
  const orgId = vopARes.rows[0].org_id;

  const sysAdminRes = await adminPool.query(`
    SELECT au.id FROM app_user au
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    WHERE r.code = 'SYS_ADMIN' AND au.status = 'ACTIVE'
    LIMIT 1
  `);
  const sysAdminId = sysAdminRes.rows[0].id;

  const mgrVopARes = await adminPool.query(`
    SELECT au.id FROM app_user au
    JOIN person p ON p.id = au.person_id
    WHERE p.email = 'manager.vop.a@resihub.vn' AND au.status = 'ACTIVE'
    LIMIT 1
  `);
  const mgrVopAId = mgrVopARes.rows[0].id;

  const ownerVopRes = await adminPool.query(`
    SELECT au.id
    FROM building b
    JOIN owner o ON o.id = b.owner_id
    JOIN app_user au ON au.person_id = o.person_id
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    WHERE b.id = $1 AND r.code = 'OWNER' AND au.status = 'ACTIVE'
    LIMIT 1
  `, [vopAId]);
  const ownerVopId = ownerVopRes.rows[0].id;

  const activeCtrRes = await adminPool.query(`
    SELECT c.id AS contract_id, c.apartment_id, c.primary_tenant_id, au.id AS primary_user_id
    FROM contract c
    JOIN tenant t ON t.id = c.primary_tenant_id
    JOIN app_user au ON au.person_id = t.person_id
    WHERE c.building_id = $1 AND c.status = 'ACTIVE' AND au.status = 'ACTIVE'
    LIMIT 1
  `, [vopAId]);
  assert.ok(activeCtrRes.rows.length > 0, 'Must have an active contract in VOP-A with resident user');
  const activeContractId = activeCtrRes.rows[0].contract_id;
  const activeAptId = activeCtrRes.rows[0].apartment_id;
  const primaryResidentUserId = activeCtrRes.rows[0].primary_user_id;

  const otherAptRes = await adminPool.query(`
    SELECT id FROM apartment WHERE building_id = $1 AND id <> $2 LIMIT 1
  `, [vopAId, activeAptId]);
  const otherAptId = otherAptRes.rows[0].id;

  // Create a temp household occupant user on activeContractId
  const suffix = crypto.randomBytes(4).toString('hex');
  const occPhone = `098${Math.floor(1000000 + Math.random() * 8999999)}`;
  const occPersonRes = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, `Occupant Test ${suffix}`, occPhone, `occ.${suffix}@resihub.test`]
  );
  const occPersonId = occPersonRes.rows[0].id;
  cleanup.personIds.push(occPersonId);

  const occTenantRes = await adminPool.query(
    `INSERT INTO tenant (org_id, person_id, type, status)
     VALUES ($1, $2, 'occupant', 'APPROVED') RETURNING id`,
    [orgId, occPersonId]
  );
  const occTenantId = occTenantRes.rows[0].id;
  cleanup.tenantIds.push(occTenantId);

  const occUserRes = await adminPool.query(
    `INSERT INTO app_user (person_id, status)
     VALUES ($1, 'ACTIVE') RETURNING id`,
    [occPersonId]
  );
  const occUserId = occUserRes.rows[0].id;
  cleanup.userIds.push(occUserId);

  const resRoleRes = await adminPool.query(
    `SELECT id FROM role WHERE org_id = $1 AND code = 'RESIDENT' LIMIT 1`,
    [orgId]
  );
  const occRoleRes = await adminPool.query(
    `INSERT INTO user_role (user_id, role_id) VALUES ($1, $2) RETURNING id`,
    [occUserId, resRoleRes.rows[0].id]
  );
  cleanup.userRoleIds.push(occRoleRes.rows[0].id);

  const coRes = await adminPool.query(
    `INSERT INTO contract_occupant (contract_id, tenant_id, relationship)
     VALUES ($1, $2, 'SPOUSE') RETURNING id`,
    [activeContractId, occTenantId]
  );
  cleanup.contractOccupantIds.push(coRes.rows[0].id);

  await t.test('1. Schema & constraints: ON_HOLD/REOPENED, chk_zalo_group_scope_target, sla_config.reopen_window_days', async () => {
    const slaSetting = await adminPool.query(`SELECT value FROM system_setting WHERE key = 'sla_config' LIMIT 1`);
    assert.ok(slaSetting.rows.length > 0);
    assert.equal(typeof slaSetting.rows[0].value.reopen_window_days, 'number');

    const srHold = await adminPool.query(
      `INSERT INTO service_request (org_id, building_id, apartment_id, created_by, title, category, description, status, tracking_code, hold_reason)
       VALUES ($1, $2, $3, $4, 'Test Hold', 'PLUMBING', 'Desc', 'ON_HOLD', $5, 'Wait part')
       RETURNING id, status, resolution_images, reopen_count`,
      [orgId, vopAId, activeAptId, mgrVopAId, `SR-M050-H-${suffix}`]
    );
    cleanup.srIds.push(srHold.rows[0].id);
    assert.equal(srHold.rows[0].status, 'ON_HOLD');
    assert.deepEqual(srHold.rows[0].resolution_images, []);
    assert.equal(srHold.rows[0].reopen_count, 0);

    const srReopen = await adminPool.query(
      `UPDATE service_request SET status = 'REOPENED', reopen_count = 1 WHERE id = $1 RETURNING status, reopen_count`,
      [srHold.rows[0].id]
    );
    assert.equal(srReopen.rows[0].status, 'REOPENED');
    assert.equal(srReopen.rows[0].reopen_count, 1);

    // Invalid BUILDING scope with non-null apartment_id
    await assert.rejects(
      () =>
        adminPool.query(
          `INSERT INTO zalo_group (org_id, building_id, apartment_id, scope, name)
           VALUES ($1, $2, $3, 'BUILDING', $4)`,
          [orgId, vopAId, activeAptId, `Bad Bldg Group ${suffix}`]
        ),
      /chk_zalo_group_scope_target/
    );

    // Invalid APARTMENT scope with null apartment_id
    await assert.rejects(
      () =>
        adminPool.query(
          `INSERT INTO zalo_group (org_id, building_id, apartment_id, scope, name)
           VALUES ($1, $2, NULL, 'APARTMENT', $3)`,
          [orgId, vopAId, `Bad Apt Group ${suffix}`]
        ),
      /chk_zalo_group_scope_target/
    );
  });

  await t.test('2. SYS_ADMIN & OWNER Read-Only at RLS layer + default-deny when unset', async () => {
    // Seed 1 zalo_group & 1 announcement in VOP-A and 1 announcement in VSC-A
    const zgVop = await adminPool.query(
      `INSERT INTO zalo_group (org_id, building_id, scope, name, invite_link, created_by)
       VALUES ($1, $2, 'BUILDING', $3, 'https://zalo.me/g/vopa_test', $4) RETURNING id`,
      [orgId, vopAId, `Zalo VOP-A ${suffix}`, mgrVopAId]
    );
    cleanup.zaloGroupIds.push(zgVop.rows[0].id);

    const annVopSent = await adminPool.query(
      `INSERT INTO announcement (org_id, building_id, target_scope, title, body, status, sent_at, created_by)
       VALUES ($1, $2, 'BUILDING', $3, 'Body VOP-A', 'SENT', NOW(), $4) RETURNING id`,
      [orgId, vopAId, `Ann VOP-A Sent ${suffix}`, mgrVopAId]
    );
    cleanup.annIds.push(annVopSent.rows[0].id);

    const annVopDraft = await adminPool.query(
      `INSERT INTO announcement (org_id, building_id, target_scope, title, body, status, created_by)
       VALUES ($1, $2, 'BUILDING', $3, 'Draft VOP-A', 'DRAFT', $4) RETURNING id`,
      [orgId, vopAId, `Ann VOP-A Draft ${suffix}`, mgrVopAId]
    );
    cleanup.annIds.push(annVopDraft.rows[0].id);

    const annVsc = await adminPool.query(
      `INSERT INTO announcement (org_id, building_id, target_scope, title, body, status, sent_at)
       VALUES ($1, $2, 'BUILDING', $3, 'Body VSC-A', 'SENT', NOW()) RETURNING id`,
      [orgId, vscAId, `Ann VSC-A ${suffix}`]
    );
    cleanup.annIds.push(annVsc.rows[0].id);

    // Default-deny when app.current_user_id is unset
    await asUserTx('', async (client) => {
      for (const tbl of ['service_request', 'zalo_group', 'announcement']) {
        const res = await client.query(`SELECT COUNT(*)::int AS cnt FROM ${tbl}`);
        assert.equal(res.rows[0].cnt, 0, `Default-deny failed on ${tbl}`);
      }
    });

    // SYS_ADMIN: can SELECT all org rows, blocked from INSERT/UPDATE
    await asUserTx(sysAdminId, async (client) => {
      const selAnn = await client.query(`SELECT id FROM announcement WHERE id = ANY($1::uuid[])`, [
        [annVopSent.rows[0].id, annVsc.rows[0].id],
      ]);
      assert.equal(selAnn.rows.length, 2);

      const updSr = await client.query(
        `UPDATE service_request SET internal_note = 'SysAdminHack' WHERE id = $1 RETURNING id`,
        [cleanup.srIds[0]]
      );
      assert.equal(updSr.rowCount, 0, 'SYS_ADMIN must not UPDATE service_request');
    });

    await assert.rejects(
      () =>
        asUserTx(sysAdminId, (client) =>
          client.query(
            `INSERT INTO announcement (org_id, building_id, target_scope, title, body)
             VALUES ($1, $2, 'BUILDING', 'Hack', 'Body')`,
            [orgId, vopAId]
          )
        ),
      /row-level security/i
    );

    await assert.rejects(
      () =>
        asUserTx(sysAdminId, (client) =>
          client.query(
            `INSERT INTO zalo_group (org_id, building_id, scope, name)
             VALUES ($1, $2, 'BUILDING', $3)`,
            [orgId, vopAId, `SysAdmin ZG ${suffix}`]
          )
        ),
      /row-level security/i
    );

    // OWNER of VOP: sees VOP-A rows, isolated from VSC-A, blocked from INSERT/UPDATE
    await asUserTx(ownerVopId, async (client) => {
      const selAnn = await client.query(`SELECT id FROM announcement WHERE id = ANY($1::uuid[])`, [
        [annVopSent.rows[0].id, annVsc.rows[0].id],
      ]);
      assert.deepEqual(
        selAnn.rows.map((r) => r.id),
        [annVopSent.rows[0].id]
      );

      const updAnn = await client.query(
        `UPDATE announcement SET title = 'OwnerHack' WHERE id = $1 RETURNING id`,
        [annVopDraft.rows[0].id]
      );
      assert.equal(updAnn.rowCount, 0, 'OWNER must not UPDATE announcement');

      const updZg = await client.query(
        `UPDATE zalo_group SET note = 'OwnerHack' WHERE id = $1 RETURNING id`,
        [zgVop.rows[0].id]
      );
      assert.equal(updZg.rowCount, 0, 'OWNER must not UPDATE zalo_group');
    });

    await assert.rejects(
      () =>
        asUserTx(ownerVopId, (client) =>
          client.query(
            `INSERT INTO service_request (org_id, building_id, apartment_id, title, category, description, tracking_code)
             VALUES ($1, $2, $3, 'Owner SR', 'OTHER', 'Desc', $4)`,
            [orgId, vopAId, activeAptId, `SR-OWN-${suffix}`]
          )
        ),
      /row-level security/i
    );
  });

  await t.test('3. MANAGER building isolation & fn_get_ops_resource_scope across org buildings', async () => {
    let mgrZgId;
    let mgrAnnId;
    await asUserTx(mgrVopAId, async (client) => {
      const insZg = await client.query(
        `INSERT INTO zalo_group (org_id, building_id, apartment_id, scope, name, invite_link, created_by)
         VALUES ($1, $2, $3, 'APARTMENT', $4, 'https://zalo.me/g/room_a', $5) RETURNING id`,
        [orgId, vopAId, activeAptId, `Room Group ${suffix}`, mgrVopAId]
      );
      mgrZgId = insZg.rows[0].id;
      cleanup.zaloGroupIds.push(mgrZgId);

      const insAnn = await client.query(
        `INSERT INTO announcement (org_id, building_id, target_scope, title, body, created_by)
         VALUES ($1, $2, 'BUILDING', $3, 'Body', $4) RETURNING id`,
        [orgId, vopAId, `Mgr Ann ${suffix}`, mgrVopAId]
      );
      mgrAnnId = insAnn.rows[0].id;
      cleanup.annIds.push(mgrAnnId);

      // fn_get_ops_resource_scope resolves building_id even for VSC-A announcement (for 403 vs 404 check)
      const scopeRes = await client.query(
        `SELECT * FROM fn_get_ops_resource_scope('announcement', $1)`,
        [cleanup.annIds[2]]
      );
      assert.equal(scopeRes.rows.length, 1);
      assert.equal(scopeRes.rows[0].building_id, vscAId);
    });

    // Manager of VOP-A blocked from inserting into VOP-B
    await assert.rejects(
      () =>
        asUserTx(mgrVopAId, (client) =>
          client.query(
            `INSERT INTO announcement (org_id, building_id, target_scope, title, body, created_by)
             VALUES ($1, $2, 'BUILDING', 'CrossBldg', 'Body', $3)`,
            [orgId, vopBId, mgrVopAId]
          )
        ),
      /row-level security/i
    );
  });

  await t.test('4. RESIDENT primary tenant & contract_occupant RLS + fn_notify_service_request_managers', async () => {
    // Seed an SR on another apartment in VOP-A
    const otherSr = await adminPool.query(
      `INSERT INTO service_request (org_id, building_id, apartment_id, title, category, description, tracking_code)
       VALUES ($1, $2, $3, 'Other Apt SR', 'OTHER', 'Desc', $4) RETURNING id`,
      [orgId, vopAId, otherAptId, `SR-OTH-${suffix}`]
    );
    cleanup.srIds.push(otherSr.rows[0].id);

    // Primary resident creates SR & notifies managers via RPC
    let resSrId;
    await asUserTx(primaryResidentUserId, async (client) => {
      const ins = await client.query(
        `INSERT INTO service_request (org_id, building_id, apartment_id, created_by, title, category, description, tracking_code)
         VALUES ($1, $2, $3, $4, 'Primary SR', 'PLUMBING', 'Rò nước', $5) RETURNING id`,
        [orgId, vopAId, activeAptId, primaryResidentUserId, `SR-PRI-${suffix}`]
      );
      resSrId = ins.rows[0].id;
      cleanup.srIds.push(resSrId);

      const notifCnt = await client.query(
        `SELECT fn_notify_service_request_managers($1, 'SERVICE_REQUEST_CREATED', 'Phiếu mới', 'Nội dung', $2::jsonb) AS cnt`,
        [resSrId, JSON.stringify({ service_request_id: resSrId })]
      );
      assert.ok(Number(notifCnt.rows[0].cnt) >= 1, 'At least 1 manager must be notified');
    });

    // Occupant can SELECT primary resident's SR, INSERT own SR on activeAptId, see SENT VOP-A announcement, NOT see DRAFT or otherAptId SR
    await asUserTx(occUserId, async (client) => {
      const selSr = await client.query(`SELECT id FROM service_request WHERE id = ANY($1::uuid[])`, [
        [resSrId, otherSr.rows[0].id],
      ]);
      assert.deepEqual(
        selSr.rows.map((r) => r.id),
        [resSrId]
      );

      const occIns = await client.query(
        `INSERT INTO service_request (org_id, building_id, apartment_id, created_by, title, category, description, tracking_code)
         VALUES ($1, $2, $3, $4, 'Occupant SR', 'ELECTRICAL', 'Mất điện ổ cắm', $5) RETURNING id`,
        [orgId, vopAId, activeAptId, occUserId, `SR-OCC-${suffix}`]
      );
      cleanup.srIds.push(occIns.rows[0].id);

      const selAnn = await client.query(`SELECT id, status FROM announcement WHERE id = ANY($1::uuid[])`, [
        cleanup.annIds.slice(0, 3),
      ]);
      assert.deepEqual(
        selAnn.rows.map((r) => r.id),
        [cleanup.annIds[0]],
        'Resident/occupant must only see SENT announcement for their building'
      );
    });

    // Occupant blocked from inserting SR on otherAptId
    await assert.rejects(
      () =>
        asUserTx(occUserId, (client) =>
          client.query(
            `INSERT INTO service_request (org_id, building_id, apartment_id, created_by, title, category, description, tracking_code)
             VALUES ($1, $2, $3, $4, 'Wrong Apt', 'OTHER', 'Desc', $5)`,
            [orgId, vopAId, otherAptId, occUserId, `SR-BAD-${suffix}`]
          )
        ),
      /row-level security/i
    );
  });

  await t.test('5. audit_log visibility for OWNER and MANAGER on M11/M13 entities', async () => {
    const audVopSr = await adminPool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'UPDATE_SERVICE_REQUEST', 'service_request', $2, '{"status":"IN_PROGRESS"}'::jsonb) RETURNING id`,
      [sysAdminId, cleanup.srIds[0]]
    );
    cleanup.auditIds.push(audVopSr.rows[0].id);

    const audVopAnn = await adminPool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'MARK_ANNOUNCEMENT_ZALO_SENT', 'announcement', $2, '{}'::jsonb) RETURNING id`,
      [sysAdminId, cleanup.annIds[0]]
    );
    cleanup.auditIds.push(audVopAnn.rows[0].id);

    const audVscAnn = await adminPool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'SEND_ANNOUNCEMENT', 'announcement', $2, '{}'::jsonb) RETURNING id`,
      [sysAdminId, cleanup.annIds[2]]
    );
    cleanup.auditIds.push(audVscAnn.rows[0].id);

    for (const actorId of [ownerVopId, mgrVopAId]) {
      await asUserTx(actorId, async (client) => {
        const res = await client.query(`SELECT id FROM audit_log WHERE id = ANY($1::bigint[]) ORDER BY id`, [
          [audVopSr.rows[0].id, audVopAnn.rows[0].id, audVscAnn.rows[0].id],
        ]);
        const foundIds = new Set(res.rows.map((r) => String(r.id)));
        assert.equal(foundIds.has(String(audVopSr.rows[0].id)), true);
        assert.equal(foundIds.has(String(audVopAnn.rows[0].id)), true);
        assert.equal(foundIds.has(String(audVscAnn.rows[0].id)), false, 'Must not see VSC-A audit_log');
      });
    }
  });
});
