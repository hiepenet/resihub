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

test('Migration 051: ai_suggestion, meter_reading.source, service_request AI triage columns & 2-Layer RLS', async (t) => {
  const cleanup = {
    readingIds: [],
    srIds: [],
    suggestionIds: [],
  };

  t.after(async () => {
    for (const id of cleanup.readingIds) {
      await adminPool.query('DELETE FROM meter_reading WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.srIds) {
      await adminPool.query('DELETE FROM service_request WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.suggestionIds) {
      await adminPool.query('DELETE FROM ai_suggestion WHERE id = $1', [id]).catch(() => {});
    }
    await appPool.end().catch(() => {});
    await adminPool.end().catch(() => {});
  });

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
  const activeAptId = activeCtrRes.rows[0].apartment_id;
  const primaryTenantId = activeCtrRes.rows[0].primary_tenant_id;
  const residentUserId = activeCtrRes.rows[0].primary_user_id;

  const meterRes = await adminPool.query(
    `SELECT id, apartment_id FROM meter WHERE building_id = $1 LIMIT 1`,
    [vopAId]
  );
  const meterId = meterRes.rows[0].id;
  const meterAptId = meterRes.rows[0].apartment_id;

  // 1. Default-deny & schema constraints + system_setting ai_config seed
  const aiCfgRes = await adminPool.query(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'ai_config' LIMIT 1`,
    [orgId]
  );
  assert.ok(aiCfgRes.rows.length === 1, 'ai_config must be seeded in system_setting');
  assert.equal(aiCfgRes.rows[0].value.enabled, true);

  await assert.rejects(
    () =>
      adminPool.query(
        `INSERT INTO ai_suggestion (org_id, building_id, task_type, target_entity, model, prompt_version)
         VALUES ($1, NULL, 'METER_OCR', 'meter_reading', 'gemini-2.5-flash', 'meter-v1.0')`,
        [orgId]
      ),
    (err) => err.code === '23514',
    'METER_OCR without building_id must fail chk_ai_suggestion_building_scope'
  );

  // 2. MANAGER VOP-A can INSERT all 4 task types in VOP-A and fails on VOP-B
  const insertedIds = await asUserTx(mgrVopAId, async (client) => {
    const ids = {};
    for (const [taskType, targetEntity] of [
      ['CCCD_EXTRACT', 'tenant'],
      ['CONTRACT_EXTRACT', 'contract'],
      ['METER_OCR', 'meter_reading'],
      ['TICKET_TRIAGE', 'service_request'],
    ]) {
      const r = await client.query(
        `INSERT INTO ai_suggestion
          (org_id, building_id, task_type, target_entity, output, confidence, model, prompt_version, input_tokens, output_tokens, estimated_cost_vnd, created_by)
         VALUES ($1, $2, $3, $4, '{"masked":true}'::jsonb, 0.91, 'gemini-2.5-flash', 'v1.0', 250, 50, 12, $5)
         RETURNING id`,
        [orgId, vopAId, taskType, targetEntity, mgrVopAId]
      );
      ids[taskType] = r.rows[0].id;
    }
    return ids;
  });
  cleanup.suggestionIds.push(...Object.values(insertedIds));

  // Unset app.current_user_id -> default-deny 0 rows
  const anonRows = await asUserTx(null, async (client) => {
    const r = await client.query(`SELECT id FROM ai_suggestion WHERE id = ANY($1::uuid[])`, [
      Object.values(insertedIds),
    ]);
    return r.rows;
  });
  assert.equal(anonRows.length, 0);

  // DELETE blocked for non-superuser
  await assert.rejects(
    () =>
      asUserTx(mgrVopAId, async (client) => {
        await client.query(`DELETE FROM ai_suggestion WHERE id = $1`, [insertedIds.METER_OCR]);
      }),
    (err) => err.code === '42501'
  );

  // Cross-building VOP-B insert blocked for MANAGER VOP-A
  await assert.rejects(
    () =>
      asUserTx(mgrVopAId, async (client) => {
        await client.query(
          `INSERT INTO ai_suggestion (org_id, building_id, task_type, target_entity, model, prompt_version, created_by)
           VALUES ($1, $2, 'METER_OCR', 'meter_reading', 'gemini-2.5-flash', 'v1.0', $3)`,
          [orgId, vopBId, mgrVopAId]
        );
      }),
    (err) => err.code === '42501'
  );

  // Unowned VSC-A row invisible to OWNER VOP
  const vscSuggRes = await adminPool.query(
    `INSERT INTO ai_suggestion (org_id, building_id, task_type, target_entity, model, prompt_version)
     VALUES ($1, $2, 'METER_OCR', 'meter_reading', 'gemini-2.5-flash', 'v1.0')
     RETURNING id`,
    [orgId, vscAId]
  );
  cleanup.suggestionIds.push(vscSuggRes.rows[0].id);

  // 3. OWNER PII isolation (Review Focus #2): sees METER_OCR & TICKET_TRIAGE on VOP-A, 0 rows for CCCD_EXTRACT/CONTRACT_EXTRACT & VSC-A, cannot INSERT/UPDATE
  const ownerVisible = await asUserTx(ownerVopId, async (client) => {
    const r = await client.query(
      `SELECT id, task_type FROM ai_suggestion WHERE id = ANY($1::uuid[]) ORDER BY task_type ASC`,
      [[...Object.values(insertedIds), vscSuggRes.rows[0].id]]
    );
    return r.rows;
  });
  assert.deepEqual(
    ownerVisible.map((r) => r.task_type),
    ['METER_OCR', 'TICKET_TRIAGE'],
    'OWNER must never read CCCD_EXTRACT or CONTRACT_EXTRACT rows'
  );

  await assert.rejects(
    () =>
      asUserTx(ownerVopId, async (client) => {
        await client.query(
          `INSERT INTO ai_suggestion (org_id, building_id, task_type, target_entity, model, prompt_version, created_by)
           VALUES ($1, $2, 'METER_OCR', 'meter_reading', 'gemini-2.5-flash', 'v1.0', $3)`,
          [orgId, vopAId, ownerVopId]
        );
      }),
    (err) => err.code === '42501'
  );

  // 4. SYS_ADMIN can INSERT CCCD_EXTRACT, blocked from METER_OCR, and fn_get_ops_resource_scope works for 'meter' & 'ai_suggestion'
  const sysCccdId = await asUserTx(sysAdminId, async (client) => {
    const r = await client.query(
      `INSERT INTO ai_suggestion (org_id, building_id, task_type, target_entity, model, prompt_version, created_by)
       VALUES ($1, NULL, 'CCCD_EXTRACT', 'tenant', 'gemini-2.5-flash', 'v1.0', $2)
       RETURNING id`,
      [orgId, sysAdminId]
    );
    return r.rows[0].id;
  });
  cleanup.suggestionIds.push(sysCccdId);

  await assert.rejects(
    () =>
      asUserTx(sysAdminId, async (client) => {
        await client.query(
          `INSERT INTO ai_suggestion (org_id, building_id, task_type, target_entity, model, prompt_version, created_by)
           VALUES ($1, $2, 'METER_OCR', 'meter_reading', 'gemini-2.5-flash', 'v1.0', $3)`,
          [orgId, vopAId, sysAdminId]
        );
      }),
    (err) => err.code === '42501'
  );

  const scopeCheck = await asUserTx(mgrVopAId, async (client) => {
    const mScope = await client.query(`SELECT * FROM fn_get_ops_resource_scope('meter', $1)`, [meterId]);
    const aScope = await client.query(`SELECT * FROM fn_get_ops_resource_scope('ai_suggestion', $1)`, [
      insertedIds.METER_OCR,
    ]);
    return { mScope: mScope.rows[0], aScope: aScope.rows[0] };
  });
  assert.equal(scopeCheck.mScope.building_id, vopAId);
  assert.equal(scopeCheck.aScope.building_id, vopAId);

  // 5. RESIDENT sees 0 rows in ai_suggestion; fn_record_background_ticket_triage updates ai_* without changing status/category
  const resSuggRows = await asUserTx(residentUserId, async (client) => {
    const r = await client.query(`SELECT id FROM ai_suggestion WHERE id = ANY($1::uuid[])`, [
      Object.values(insertedIds),
    ]);
    return r.rows;
  });
  assert.equal(resSuggRows.length, 0);

  const trackingCode = `SR-M15-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const srId = await asUserTx(residentUserId, async (client) => {
    const srIns = await client.query(
      `INSERT INTO service_request
        (org_id, building_id, apartment_id, tenant_id, created_by, tracking_code, category, title, description, priority, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'OTHER', 'Test M15 Triage', 'Vòi nước rỉ', 'NORMAL', 'NEW')
       RETURNING id`,
      [orgId, vopAId, activeAptId, primaryTenantId, residentUserId, trackingCode]
    );
    const createdSrId = srIns.rows[0].id;
    const bgSuggId = await client.query(
      `SELECT fn_record_background_ticket_triage(
        $1::uuid,
        'SUGGESTED',
        'PLUMBING',
        'HIGH',
        $2::uuid,
        'Vòi nước rỉ cần xử lý sớm',
        0.92,
        '{"category":"PLUMBING"}'::jsonb,
        '[]'::jsonb,
        FALSE,
        'gemini-2.5-flash',
        'triage-v1.0',
        180,
        45,
        8,
        420,
        NULL
      ) AS suggestion_id`,
      [createdSrId, mgrVopAId]
    );
    cleanup.suggestionIds.push(bgSuggId.rows[0].suggestion_id);
    return createdSrId;
  });
  cleanup.srIds.push(srId);

  const srAfterBg = await adminPool.query(
    `SELECT status, category, priority, ai_triage_status, ai_suggested_category, ai_suggested_priority, ai_confidence
     FROM service_request WHERE id = $1`,
    [srId]
  );
  assert.equal(srAfterBg.rows[0].status, 'NEW');
  assert.equal(srAfterBg.rows[0].category, 'OTHER', 'Business category must NOT mutate automatically');
  assert.equal(srAfterBg.rows[0].ai_triage_status, 'SUGGESTED');
  assert.equal(srAfterBg.rows[0].ai_suggested_category, 'PLUMBING');
  assert.equal(srAfterBg.rows[0].ai_suggested_priority, 'HIGH');
  assert.equal(Number(srAfterBg.rows[0].ai_confidence), 0.92);

  // meter_reading.source column check
  const testPeriod = '2099-12';
  const rdgRes = await asUserTx(mgrVopAId, async (client) => {
    const r = await client.query(
      `INSERT INTO meter_reading
        (org_id, building_id, meter_id, apartment_id, period, previous_reading, current_reading, consumption, status, source, ai_suggestion_id, recorded_by)
       VALUES ($1, $2, $3, $4, $5, 1400, 1500, 100, 'DRAFT', 'AI', $6, $7)
       RETURNING id, source, ai_suggestion_id`,
      [orgId, vopAId, meterId, meterAptId, testPeriod, insertedIds.METER_OCR, mgrVopAId]
    );
    return r.rows[0];
  });
  cleanup.readingIds.push(rdgRes.id);
  assert.equal(rdgRes.source, 'AI');
  assert.equal(rdgRes.ai_suggestion_id, insertedIds.METER_OCR);
});
