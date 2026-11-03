import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5000';
const ADMIN_DB_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/resihub';

async function login(email, password) {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(body)}`);
  return { token: body.accessToken, user: body.user };
}

async function apiFetch(path, token, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

test('apartments router registers POST /bulk exactly once', () => {
  const src = fs.readFileSync(new URL('../src/routes/apartments.js', import.meta.url), 'utf8');
  const matches = src.match(/router\.post\(\s*['"]\/bulk['"]/g) || [];
  assert.equal(matches.length, 1);
});

test('FR-009 — bulk apartment creation by floor template', async (t) => {
  let healthOk = false;
  try {
    const h = await fetch(`${API_BASE}/api/health`);
    healthOk = h.ok;
  } catch {
    healthOk = false;
  }
  if (!healthOk) {
    t.skip('API server not reachable');
    return;
  }

  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const PREFIX = 'ZZB';
  let tempZoneIdB = null;

  async function cleanupByPrefix() {
    const idsRes = await adminPool.query(`SELECT id FROM apartment WHERE code LIKE 'ZZB%'`);
    const ids = idsRes.rows.map((r) => r.id);
    if (ids.length > 0) {
      await adminPool.query(`DELETE FROM apartment WHERE id = ANY($1::uuid[])`, [ids]);
    }
    if (tempZoneIdB) {
      await adminPool.query(`DELETE FROM zone WHERE id = $1`, [tempZoneIdB]);
      tempZoneIdB = null;
    }
  }

  await cleanupByPrefix();

  t.after(async () => {
    await cleanupByPrefix();
    await adminPool.end();
  });

  const mgrA = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const mgrB = await login('manager.vop.b@resihub.vn', 'Demo@123456');

  const bList = await apiFetch('/api/v1/buildings', mgrA.token);
  assert.equal(bList.status, 200);
  const buildingA = bList.body.data[0];
  const floorsRes = await apiFetch(`/api/v1/buildings/${buildingA.id}/floors`, mgrA.token);
  assert.equal(floorsRes.status, 200);
  const floors = floorsRes.body.data.filter((f) => Number(f.level) >= 1).slice(0, 2);
  assert.equal(floors.length, 2, 'Seed must have at least two above-ground floors');

  const units = [
    { suffix: '01', type: '1PN', bedrooms: 1, area_m2: 45, base_rent: 8500000 },
    { suffix: '02', type: '2PN', bedrooms: 2, area_m2: 60, base_rent: 11000000 },
  ];
  const payload = {
    building_id: buildingA.id,
    floor_ids: floors.map((f) => f.id),
    code_prefix: PREFIX,
    units,
  };
  const expectedCodes = floors.flatMap((f) =>
    units.map((u) => `${PREFIX}${f.level}${u.suffix}`)
  );

  await t.test('dry_run returns drafts and writes nothing', async () => {
    const res = await apiFetch('/api/v1/apartments/bulk', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ ...payload, dry_run: true }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.map((d) => d.code), expectedCodes);
    assert.equal(res.body.valid, true);

    const dbRes = await adminPool.query(
      `SELECT COUNT(*)::int AS count FROM apartment WHERE building_id = $1 AND code LIKE $2`,
      [buildingA.id, `${PREFIX}%`]
    );
    assert.equal(dbRes.rows[0].count, 0);
  });

  await t.test('commit creates every floor × unit with audit rows', async () => {
    const res = await apiFetch('/api/v1/apartments/bulk', mgrA.token, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.created_count, expectedCodes.length);

    const dbRes = await adminPool.query(
      `SELECT id, code FROM apartment WHERE building_id = $1 AND code = ANY($2::text[]) ORDER BY code`,
      [buildingA.id, expectedCodes]
    );
    assert.deepEqual(dbRes.rows.map((r) => r.code), [...expectedCodes].sort());

    const auditRes = await adminPool.query(
      `SELECT COUNT(*)::int AS count FROM audit_log
       WHERE entity = 'apartment' AND action = 'CREATE' AND entity_id = ANY($1::uuid[])`,
      [dbRes.rows.map((r) => r.id)]
    );
    assert.equal(auditRes.rows[0].count, expectedCodes.length);
  });

  await t.test('repeating the same batch is rejected without partial writes', async () => {
    const res = await apiFetch('/api/v1/apartments/bulk', mgrA.token, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'DUPLICATE_CODE');
    assert.equal(res.body.conflicts.length, expectedCodes.length);

    const dbRes = await adminPool.query(
      `SELECT COUNT(*)::int AS count FROM apartment
       WHERE building_id = $1 AND code = ANY($2::text[])`,
      [buildingA.id, expectedCodes]
    );
    assert.equal(dbRes.rows[0].count, expectedCodes.length);
  });

  await t.test('dry_run reports existing conflicts without throwing 409', async () => {
    const res = await apiFetch('/api/v1/apartments/bulk', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ ...payload, dry_run: true }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.valid, false);
    assert.equal(res.body.conflicts.length, expectedCodes.length);
  });

  await t.test('floor from another building returns FLOOR_MISMATCH', async () => {
    const bListB = await apiFetch('/api/v1/buildings', mgrB.token);
    const buildingB = bListB.body.data[0];
    const floorsB = await apiFetch(`/api/v1/buildings/${buildingB.id}/floors`, mgrB.token);
    const foreignFloor = floorsB.body.data.find((f) => Number(f.level) >= 1);

    const res = await apiFetch('/api/v1/apartments/bulk', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({ ...payload, floor_ids: [foreignFloor.id] }),
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.code, 'FLOOR_MISMATCH');
  });

  await t.test('zone from another building returns ZONE_MISMATCH and inserts nothing', async () => {
    const bListB = await apiFetch('/api/v1/buildings', mgrB.token);
    const buildingB = bListB.body.data[0];
    await adminPool.query(`DELETE FROM zone WHERE building_id = $1 AND code = 'ZZB-ZONE-B'`, [buildingB.id]);
    const zCreateB = await apiFetch(`/api/v1/buildings/${buildingB.id}/zones`, mgrB.token, {
      method: 'POST',
      body: JSON.stringify({ code: 'ZZB-ZONE-B', name: 'Zone B Test' }),
    });
    assert.equal(zCreateB.status, 201, JSON.stringify(zCreateB.body));
    tempZoneIdB = zCreateB.body.data.id;

    const res = await apiFetch('/api/v1/apartments/bulk', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        code_prefix: `${PREFIX}Z`,
        zone_id: tempZoneIdB,
      }),
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.code, 'ZONE_MISMATCH');

    const dbRes = await adminPool.query(
      `SELECT COUNT(*)::int AS count FROM apartment WHERE building_id = $1 AND code LIKE $2`,
      [buildingA.id, `${PREFIX}Z%`]
    );
    assert.equal(dbRes.rows[0].count, 0);
  });

  await t.test('manager of another building gets ACCESS_DENIED before unit validation', async () => {
    const res = await apiFetch('/api/v1/apartments/bulk', mgrB.token, {
      method: 'POST',
      body: JSON.stringify({ building_id: buildingA.id, floor_ids: [], units: [] }),
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, 'ACCESS_DENIED');
  });

  await t.test('duplicate suffix inside the payload returns DUPLICATE_CODE_IN_PAYLOAD', async () => {
    const res = await apiFetch('/api/v1/apartments/bulk', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        code_prefix: `${PREFIX}X`,
        units: [units[0], units[0]],
        floor_ids: [floors[0].id],
      }),
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.code, 'DUPLICATE_CODE_IN_PAYLOAD');
  });
});
