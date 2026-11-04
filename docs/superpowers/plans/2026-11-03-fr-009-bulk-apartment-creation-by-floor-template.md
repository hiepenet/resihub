# FR-009 Bulk Apartment Creation by Floor Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a MANAGER generate 1..n apartments on one or more existing floors from a reusable floor template (unit mix + code rule), preview the exact result, and commit all-or-nothing with audit.

**Architecture:** A stateless bulk endpoint (`POST /api/v1/apartments/bulk`) accepts a building, 1..n floor IDs, an optional zone/prefix, and 1..n unit specs. A pure generator in `api/src/services/apartmentBulk.js` expands the template into concrete drafts (`code = prefix + floorToken + suffix`). `dry_run: true` returns the same drafts plus database conflicts without writing; the commit path inserts every draft inside one RLS-bound transaction and writes one audit row per apartment. A dedicated React modal in `FloorPlanPage` collects the template, shows the preview grouped by floor, and only enables commit when the preview is conflict-free.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (`FORCE ROW LEVEL SECURITY` + `getUserClient`), `node:test`, React 19, TailwindCSS, Vite.

**Spec:** PRD v2.0 `FR-009` (M03, P1) plus `FR-008` apartment rules (`Mục 10.2`, `AC-008.1..3`) and RBAC `Mục 6.2`.

## Global Constraints

- **RBAC:** `MANAGER` may create only on assigned buildings (`getManagerBuildingIds`); `SYS_ADMIN` may create anywhere in the org; `OWNER`/`RESIDENT` receive `403` from `requireRole(['SYS_ADMIN','MANAGER'])`. Every denied attempt calls `logAccessDenied`.
- **Code rule:** `apartment.code = UPPER(code_prefix + floorToken + unitSuffix)`. `floorToken` is `level` for `level >= 1`, `G` for `level = 0`, `B<abs(level)>` for negative levels. Auto suffix is the 1-based unit index padded to 2 digits (`01`, `02`, ...). Explicit `suffix` wins and is uppercased/trimmed.
- **Uniqueness:** Codes must be unique inside the payload and against `UNIQUE (building_id, code)`. Any duplicate blocks the whole batch; never partial-insert.
- **All-or-nothing:** The commit runs in one transaction via `getUserClient(req)`; any failure rolls back every apartment and audit row.
- **Status:** Every generated apartment starts `AVAILABLE`, matching the existing `POST /api/v1/apartments`.
- **Limits:** `units` 1..50, `floor_ids` 1..50, `units.length * floor_ids.length <= 500`.
- **Money:** `base_rent` is an integer VND amount `>= 0` (never a float). `area_m2 >= 0`, `bedrooms` integer `0..20`.
- **Audit:** One `audit_log` row per apartment: `action='CREATE'`, `entity='apartment'`, `actor_id=req.user.sub`, `after=JSON.stringify(row)`.
- **No migration:** The template is a request payload, not a persisted entity. No new table, no new dependency.
- **UI copy:** Vietnamese, following the existing `FloorPlanPage.jsx` wording.

## Review Focus

1. **Multi-floor duplicate codes:** Two units on the same floor with the same suffix, or a generated code that already exists in the building, must return a conflict and insert zero rows. Pinned in Task 1 (`findDuplicateCodes`) and Task 2 (integration duplicate test).
2. **Cross-building floor IDs (IDOR):** A MANAGER of building A sending a floor ID from building B must get `422 FLOOR_MISMATCH` (or `404`) and no rows. Pinned in Task 2.
3. **Unassigned building:** A MANAGER sending `building_id` outside their assignment must get `403 ACCESS_DENIED` before any validation of units. Pinned in Task 2.
4. **`dry_run` writes nothing and matches commit:** Preview must not insert/audit, and stale previews must not be committed. Pinned in Task 2 (DB count after dry run) and Task 3 (preview cleared on form change).
5. **Ground/basement floor tokens:** `level = 0` must produce `G`, `level = -2` must produce `B2`, not `0`/`-2`. Pinned in Task 1.
6. **Zone mismatch:** `zone_id` from another building must return `422 ZONE_MISMATCH` and insert nothing. Pinned in Task 2.

---

## File Structure

- **Create:** `api/src/services/apartmentBulk.js` — pure template expansion + duplicate detection. No DB, no Express.
- **Create:** `api/test/apartmentBulk.test.js` — `node:test` unit tests for the generator.
- **Create:** `api/test/apartmentBulkCreate.test.js` — API integration tests (skip when the API server is unreachable, matching `zoneAndDuplicateAudit.test.js`).
- **Modify:** `api/src/routes/apartments.js` — add `POST /bulk` after the existing `POST /` handler.
- **Create:** `frontend/src/pages/admin/buildings/BulkApartmentModal.jsx` — floor selection, unit template rows, preview, commit.
- **Modify:** `frontend/src/pages/admin/buildings/FloorPlanPage.jsx` — add the “Tạo hàng loạt” entry point and render the modal.
- **Modify:** `frontend/src/services/buildings.service.js` — add `previewApartmentsBulk` and `createApartmentsBulk`.
- **Modify:** `README.md` — document the endpoint next to `POST /api/v1/apartments`.

---

### Task 1: Pure Floor-Template Generator

**Files:**
- Create: `api/src/services/apartmentBulk.js`
- Test: `api/test/apartmentBulk.test.js`

**Interfaces:**
- Produces:
  - `floorLevelToken(level: number | string): string`
  - `buildApartmentDrafts({ codePrefix, units, floors, zoneId, amenities, note }): Array<{ floor_id, floor_name, code, zone_id, type, bedrooms, area_m2, base_rent, amenities, note }>`
  - `findDuplicateCodes(drafts: Array<{ code: string }>): string[]`

- [ ] **Step 1: Write the failing unit test**

Create `api/test/apartmentBulk.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApartmentDrafts,
  findDuplicateCodes,
  floorLevelToken,
} from '../src/services/apartmentBulk.js';

const units = [
  { suffix: '01', type: '1PN', bedrooms: 1, area_m2: 45, base_rent: 8500000 },
  { suffix: '02', type: '2PN', bedrooms: 2, area_m2: 60, base_rent: 11000000 },
];

test('floorLevelToken maps positive, ground and basement levels', () => {
  assert.equal(floorLevelToken(5), '5');
  assert.equal(floorLevelToken(0), 'G');
  assert.equal(floorLevelToken(-2), 'B2');
});

test('buildApartmentDrafts builds one code per floor × unit', () => {
  const drafts = buildApartmentDrafts({
    codePrefix: 'a',
    floors: [
      { id: 'f1', level: 1, name: 'Tầng 1' },
      { id: 'f2', level: 2, name: 'Tầng 2' },
    ],
    units,
    zoneId: 'z1',
    amenities: { wifi: true },
    note: 'mẫu tầng',
  });

  assert.equal(drafts.length, 4);
  assert.deepEqual(drafts.map((d) => d.code), ['A101', 'A102', 'A201', 'A202']);
  assert.equal(drafts[0].floor_id, 'f1');
  assert.equal(drafts[0].floor_name, 'Tầng 1');
  assert.equal(drafts[0].zone_id, 'z1');
  assert.deepEqual(drafts[0].amenities, { wifi: true });
  assert.equal(drafts[0].note, 'mẫu tầng');
  assert.equal(drafts[2].bedrooms, 2);
  assert.equal(drafts[2].base_rent, 11000000);
});

test('buildApartmentDrafts auto-generates padded suffixes when suffix is omitted', () => {
  const drafts = buildApartmentDrafts({
    floors: [{ id: 'ground', level: 0 }],
    units: [{ type: 'Studio' }, { type: 'Studio' }],
  });

  assert.deepEqual(drafts.map((d) => d.code), ['G01', 'G02']);
});

test('buildApartmentDrafts normalizes prefix, suffix and numeric fields', () => {
  const drafts = buildApartmentDrafts({
    codePrefix: ' b ',
    floors: [{ id: 'basement', level: -1 }],
    units: [
      { suffix: ' a ', type: ' 1PN ', bedrooms: '1', area_m2: '45.5', base_rent: '8500000' },
    ],
  });

  assert.equal(drafts[0].code, 'BB1A');
  assert.equal(drafts[0].type, '1PN');
  assert.equal(drafts[0].bedrooms, 1);
  assert.equal(drafts[0].area_m2, 45.5);
  assert.equal(drafts[0].base_rent, 8500000);
});

test('findDuplicateCodes returns each duplicated code once', () => {
  const drafts = [{ code: 'A101' }, { code: 'A101' }, { code: 'A102' }];
  assert.deepEqual(findDuplicateCodes(drafts), ['A101']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\resihub\api; node --test test/apartmentBulk.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` or `floorLevelToken is not a function`.

- [ ] **Step 3: Implement `api/src/services/apartmentBulk.js`**

```js
export function floorLevelToken(level) {
  const n = Number(level);
  if (!Number.isInteger(n)) return String(level ?? '').trim().toUpperCase();
  if (n < 0) return `B${Math.abs(n)}`;
  if (n === 0) return 'G';
  return String(n);
}

export function buildApartmentDrafts({
  codePrefix = '',
  units = [],
  floors = [],
  zoneId = null,
  amenities = {},
  note = '',
} = {}) {
  const prefix = String(codePrefix || '').trim().toUpperCase();

  return floors.flatMap((floor) =>
    units.map((unit, index) => {
      const suffix = unit.suffix
        ? String(unit.suffix).trim().toUpperCase()
        : String(index + 1).padStart(2, '0');

      return {
        floor_id: floor.id,
        floor_name: floor.name || `Tầng ${floor.level}`,
        code: `${prefix}${floorLevelToken(floor.level)}${suffix}`,
        zone_id: zoneId || null,
        type: String(unit.type || '1PN').trim(),
        bedrooms: Number(unit.bedrooms ?? 1),
        area_m2: Number(unit.area_m2 ?? 0),
        base_rent: Number(unit.base_rent ?? 0),
        amenities: amenities || {},
        note: note || '',
      };
    })
  );
}

export function findDuplicateCodes(drafts = []) {
  const seen = new Set();
  const duplicates = new Set();
  for (const draft of drafts) {
    const code = String(draft?.code || '').trim().toUpperCase();
    if (!code) continue;
    if (seen.has(code)) duplicates.add(code);
    else seen.add(code);
  }
  return [...duplicates];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd d:\resihub\api; node --test test/apartmentBulk.test.js`
Expected: PASS, 5/5 tests.

- [ ] **Step 5: Commit**

```powershell
git add api/src/services/apartmentBulk.js api/test/apartmentBulk.test.js
git commit -m "feat(m03): add bulk apartment draft generator for floor templates (FR-009)"
```

---

### Task 2: Bulk Creation API Endpoint

**Files:**
- Modify: `api/src/routes/apartments.js` (add `POST /bulk` after the existing `POST /` handler, before `PATCH /:id`)
- Test: `api/test/apartmentBulkCreate.test.js`

**Interfaces:**
- Consumes: `buildApartmentDrafts`, `findDuplicateCodes` from Task 1; `getUserClient` and `pool` from `../db/client.js`; `getManagerBuildingIds`, `logAccessDenied` from `../services/ownerScope.js`.
- Produces: `POST /api/v1/apartments/bulk`
  - Request: `{ building_id, floor_ids, zone_id?, code_prefix?, units: [{ suffix?, type, bedrooms, area_m2, base_rent }], amenities?, note?, dry_run? }`
  - `dry_run: true` → `200 { data, conflicts, total, valid }`
  - commit → `201 { message, created_count, data }`
  - errors: `403 ACCESS_DENIED`, `404 NOT_FOUND`, `422 VALIDATION_ERROR | FLOOR_MISMATCH | ZONE_MISMATCH | DUPLICATE_CODE_IN_PAYLOAD`, `409 DUPLICATE_CODE`

- [ ] **Step 1: Write the failing integration test**

Create `api/test/apartmentBulkCreate.test.js` following the login/fetch/cleanup pattern of `api/test/zoneAndDuplicateAudit.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  const body = await res.json();
  return { status: res.status, body };
}

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

  async function cleanupByPrefix() {
    const idsRes = await adminPool.query(`SELECT id FROM apartment WHERE code LIKE 'ZZB%'`);
    const ids = idsRes.rows.map((r) => r.id);
    if (ids.length === 0) return;
    await adminPool.query(
      `DELETE FROM audit_log WHERE entity = 'apartment' AND entity_id = ANY($1::uuid[])`,
      [ids]
    );
    await adminPool.query(`DELETE FROM apartment WHERE id = ANY($1::uuid[])`, [ids]);
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

  await t.test('manager of another building gets ACCESS_DENIED', async () => {
    const res = await apiFetch('/api/v1/apartments/bulk', mgrB.token, {
      method: 'POST',
      body: JSON.stringify(payload),
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\resihub\api; node --test test/apartmentBulkCreate.test.js`
Expected: FAIL with `404` (endpoint missing) or skip when the API server is not running.

- [ ] **Step 3: Implement `POST /api/v1/apartments/bulk` in `api/src/routes/apartments.js`**

Add the import:

```js
import { buildApartmentDrafts, findDuplicateCodes } from '../services/apartmentBulk.js';
```

Add the handler after the existing `router.post('/', ...)` block:

```js
router.post('/bulk', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const body = req.body || {};
  const {
    building_id: buildingId,
    floor_ids: rawFloorIds,
    zone_id: zoneId,
    code_prefix: rawPrefix,
    units,
    amenities,
    note,
    dry_run: dryRun,
  } = body;

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const fail = (status, code, message, extra = {}) =>
    res.status(status).json({ code, message, ...extra });

  // 1. Shape validation
  if (!uuidRe.test(String(buildingId || ''))) {
    return fail(422, 'VALIDATION_ERROR', 'Tòa nhà không hợp lệ.');
  }
  const floorIds = Array.isArray(rawFloorIds)
    ? [...new Set(rawFloorIds.map((id) => String(id || '').trim()))].filter(Boolean)
    : [];
  if (floorIds.length === 0 || floorIds.length > 50 || floorIds.some((id) => !uuidRe.test(id))) {
    return fail(422, 'VALIDATION_ERROR', 'Chọn từ 1 đến 50 tầng hợp lệ.');
  }
  if (!Array.isArray(units) || units.length === 0 || units.length > 50) {
    return fail(422, 'VALIDATION_ERROR', 'Mẫu tầng phải có từ 1 đến 50 loại căn.');
  }
  if (units.length * floorIds.length > 500) {
    return fail(422, 'VALIDATION_ERROR', 'Một lần chỉ được tạo tối đa 500 căn hộ.');
  }

  const cleanPrefix = String(rawPrefix || '').trim().toUpperCase();
  if (cleanPrefix && !/^[A-Z0-9-]+$/.test(cleanPrefix)) {
    return fail(422, 'VALIDATION_ERROR', 'Tiền tố mã căn chỉ được chứa chữ cái, số và dấu gạch ngang.');
  }
  if (amenities !== undefined && amenities !== null && (typeof amenities !== 'object' || Array.isArray(amenities))) {
    return fail(422, 'VALIDATION_ERROR', 'Tiện ích phải là một đối tượng JSON.');
  }
  if (note !== undefined && typeof note !== 'string') {
    return fail(422, 'VALIDATION_ERROR', 'Ghi chú phải là chuỗi.');
  }

  const cleanUnits = [];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i] || {};
    const suffix = unit.suffix === undefined || unit.suffix === null
      ? ''
      : String(unit.suffix).trim().toUpperCase();
    if (suffix && !/^[A-Z0-9-]{1,10}$/.test(suffix)) {
      return fail(422, 'VALIDATION_ERROR', `Hậu tố căn thứ ${i + 1} không hợp lệ.`);
    }
    const bedrooms = Number(unit.bedrooms ?? 1);
    const area = Number(unit.area_m2 ?? 0);
    const rent = Number(unit.base_rent ?? 0);
    if (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 20) {
      return fail(422, 'VALIDATION_ERROR', `Số phòng ngủ của căn thứ ${i + 1} phải là số nguyên từ 0 đến 20.`);
    }
    if (!Number.isFinite(area) || area < 0) {
      return fail(422, 'VALIDATION_ERROR', `Diện tích của căn thứ ${i + 1} không hợp lệ.`);
    }
    if (!Number.isInteger(rent) || rent < 0) {
      return fail(422, 'VALIDATION_ERROR', `Giá thuê của căn thứ ${i + 1} phải là số nguyên VND không âm.`);
    }
    cleanUnits.push({
      suffix,
      type: String(unit.type || '1PN').trim() || '1PN',
      bedrooms,
      area_m2: area,
      base_rent: rent,
    });
  }

  try {
    const orgId = req.user.org_id;
    const isSysAdmin = getUserRoleCodes(req).includes('SYS_ADMIN');

    const bCheck = await adminPool.query(
      'SELECT id, code FROM building WHERE id = $1 AND org_id = $2',
      [buildingId, orgId]
    );
    if (bCheck.rows.length === 0) {
      return fail(404, 'NOT_FOUND', 'Không tìm thấy tòa nhà.');
    }

    if (!isSysAdmin) {
      const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
      if (!mgrIds.includes(buildingId)) {
        await logAccessDenied(req, 'building', buildingId, 'MANAGER attempted bulk apartment creation in unassigned building');
        return fail(403, 'ACCESS_DENIED', 'Bạn không có quyền quản lý tòa nhà này để tạo căn hộ.');
      }
    }

    let zoneCode = '';
    if (zoneId) {
      const zoneCheck = await pool.query(
        'SELECT code FROM zone WHERE id = $1 AND building_id = $2',
        [zoneId, buildingId]
      );
      if (zoneCheck.rows.length === 0) {
        return fail(422, 'ZONE_MISMATCH', 'Khu không thuộc tòa nhà này.');
      }
      zoneCode = zoneCheck.rows[0].code || '';
    }

    const effectivePrefix = cleanPrefix || String(zoneCode || '').trim().toUpperCase();

    const floorsRes = await pool.query(
      'SELECT id, level, name FROM floor WHERE building_id = $1 AND id = ANY($2::uuid[]) ORDER BY level ASC',
      [buildingId, floorIds]
    );
    if (floorsRes.rows.length !== floorIds.length) {
      return fail(422, 'FLOOR_MISMATCH', 'Có tầng không thuộc tòa nhà này.');
    }

    const drafts = buildApartmentDrafts({
      codePrefix: effectivePrefix,
      units: cleanUnits,
      floors: floorsRes.rows,
      zoneId: zoneId || null,
      amenities: amenities || {},
      note: note || '',
    });

    const payloadDuplicates = findDuplicateCodes(drafts);
    if (payloadDuplicates.length > 0) {
      return fail(422, 'DUPLICATE_CODE_IN_PAYLOAD', 'Mẫu tầng sinh ra mã căn trùng nhau.', {
        conflicts: payloadDuplicates.map((code) => ({ code })),
      });
    }

    const existing = await pool.query(
      'SELECT code FROM apartment WHERE building_id = $1 AND code = ANY($2::text[])',
      [buildingId, drafts.map((d) => d.code)]
    );
    const existingCodes = new Set(existing.rows.map((r) => r.code));
    const conflicts = drafts
      .filter((d) => existingCodes.has(d.code))
      .map((d) => ({ code: d.code, floor_id: d.floor_id, floor_name: d.floor_name }));

    if (dryRun) {
      return res.json({
        data: drafts,
        conflicts,
        total: drafts.length,
        valid: conflicts.length === 0,
      });
    }

    if (conflicts.length > 0) {
      return fail(409, 'DUPLICATE_CODE', 'Một số mã căn đã tồn tại trong tòa nhà này.', { conflicts });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const created = [];
      for (const draft of drafts) {
        const inserted = await client.query(
          `INSERT INTO apartment
             (building_id, zone_id, floor_id, code, area_m2, type, bedrooms, base_rent, status, amenities, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AVAILABLE', $9, $10)
           RETURNING *`,
          [
            buildingId,
            draft.zone_id,
            draft.floor_id,
            draft.code,
            draft.area_m2,
            draft.type,
            draft.bedrooms,
            draft.base_rent,
            JSON.stringify(draft.amenities || {}),
            draft.note || '',
          ]
        );
        const row = inserted.rows[0];
        created.push(row);
        await client.query(
          `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
           VALUES ($1, 'CREATE', 'apartment', $2, $3)`,
          [req.user.sub, row.id, JSON.stringify(row)]
        );
      }
      await client.query('COMMIT');
      return res.status(201).json({
        message: `Đã tạo ${created.length} căn hộ từ mẫu tầng.`,
        created_count: created.length,
        data: created,
      });
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      if (txErr.code === '23505') {
        return fail(409, 'DUPLICATE_CODE', 'Mã căn vừa bị tạo bởi thao tác khác. Vui lòng xem trước lại.');
      }
      throw txErr;
    } finally {
      await release();
    }
  } catch (err) {
    console.error('[Bulk Create Apartments Error]:', err);
    return res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo căn hộ hàng loạt.' });
  }
});
```

- [ ] **Step 4: Run the unit and integration tests**

Run:
```powershell
cd d:\resihub\api
node --test test/apartmentBulk.test.js test/apartmentBulkCreate.test.js
```
Expected: unit tests PASS; integration tests PASS when the API server is running, or skip with `API server not reachable`.

- [ ] **Step 5: Commit**

```powershell
git add api/src/routes/apartments.js api/test/apartmentBulkCreate.test.js
git commit -m "feat(m03): add bulk apartment creation endpoint (FR-009)"
```

---

### Task 3: Bulk Template UI in the Floor Plan

**Files:**
- Create: `frontend/src/pages/admin/buildings/BulkApartmentModal.jsx`
- Modify: `frontend/src/pages/admin/buildings/FloorPlanPage.jsx`
- Modify: `frontend/src/services/buildings.service.js`

**Interfaces:**
- Consumes: `POST /api/v1/apartments/bulk` from Task 2.
- Produces:
  - `buildingsService.previewApartmentsBulk(payload)` → `{ data, conflicts, total, valid }`
  - `buildingsService.createApartmentsBulk(payload)` → `{ created_count, data, message }`
  - `<BulkApartmentModal open buildingId floors zones onClose onCreated />`
    - `floors: Array<{ id, level, name, apartment_count? }>`
    - `zones: Array<{ id, code, name }>`
    - `onCreated: (response) => void`

- [ ] **Step 1: Add the two service methods**

In `frontend/src/services/buildings.service.js`, below `createApartment`:

```js
previewApartmentsBulk: (payload) =>
  api.post('/api/v1/apartments/bulk', { ...payload, dry_run: true }).then((r) => r.data),
createApartmentsBulk: (payload) =>
  api.post('/api/v1/apartments/bulk', { ...payload, dry_run: false }).then((r) => r.data),
```

- [ ] **Step 2: Create `frontend/src/pages/admin/buildings/BulkApartmentModal.jsx`**

Implement the component with this exact state and behavior:

```jsx
import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Eye } from 'lucide-react';
import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { MoneyInput } from '../../../components/ui/MoneyInput';
import { buildingsService } from '../../../services/buildings.service';
import { useToast } from '../../../hooks/useToast';
import { extractErrorMessage } from '../../../utils/validation';

const DEFAULT_UNIT = { suffix: '', type: '1PN', bedrooms: 1, area_m2: 45, base_rent: 8500000 };

function makeUnits(count, current = []) {
  return Array.from({ length: count }, (_, i) => {
    if (current[i]) return current[i];
    const row = { ...DEFAULT_UNIT, suffix: String(i + 1).padStart(2, '0') };
    return row;
  });
}

export function BulkApartmentModal({ open, buildingId, floors = [], zones = [], onClose, onCreated }) {
  const toast = useToast();
  const [selectedFloorIds, setSelectedFloorIds] = useState([]);
  const [zoneId, setZoneId] = useState('');
  const [codePrefix, setCodePrefix] = useState('');
  const [units, setUnits] = useState(() => makeUnits(5));
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset every time the modal opens; default to the first floor only.
  useEffect(() => {
    if (!open) return;
    setSelectedFloorIds(floors[0] ? [floors[0].id] : []);
    setZoneId('');
    setCodePrefix('');
    setUnits(makeUnits(5));
    setPreview(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Any form edit invalidates the previous preview so a stale preview is never committed.
  const invalidate = () => setPreview(null);

  const totalDrafts = selectedFloorIds.length * units.length;

  const previewByFloor = useMemo(() => {
    const groups = new Map();
    for (const draft of preview?.data || []) {
      if (!groups.has(draft.floor_id)) {
        groups.set(draft.floor_id, { floor_name: draft.floor_name, items: [] });
      }
      groups.get(draft.floor_id).items.push(draft);
    }
    return [...groups.values()];
  }, [preview]);

  const handlePreview = async () => {
    if (selectedFloorIds.length === 0) {
      toast.warning('Vui lòng chọn ít nhất một tầng.');
      return;
    }
    setLoadingPreview(true);
    try {
      const res = await buildingsService.previewApartmentsBulk({
        building_id: buildingId,
        floor_ids: selectedFloorIds,
        zone_id: zoneId || undefined,
        code_prefix: codePrefix.trim().toUpperCase() || undefined,
        units,
      });
      setPreview(res);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!preview || preview.valid === false) {
      toast.warning('Vui lòng xem trước và xử lý hết mã trùng trước khi tạo.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await buildingsService.createApartmentsBulk({
        building_id: buildingId,
        floor_ids: selectedFloorIds,
        zone_id: zoneId || undefined,
        code_prefix: codePrefix.trim().toUpperCase() || undefined,
        units,
      });
      toast.success(res.message || `Đã tạo ${res.created_count} căn hộ.`);
      onCreated?.(res);
      onClose?.();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ...render...
}
```

Rendering requirements (Tailwind, no new dependency):
- `<Modal open={open} onClose={onClose} title="Tạo căn hộ hàng loạt theo mẫu tầng" size="xl">`
- Section 1 — “Chọn tầng áp dụng”: checkbox per floor (`floor.name || 'Tầng ' + floor.level`, plus `(${floor.apartment_count || 0} căn hiện có)` when known), each checkbox `onChange` updates the selected IDs and calls `invalidate()`. Above the list: “Chọn tất cả” / “Bỏ chọn” buttons.
- Section 2 — “Khu / Phân khu (tuỳ chọn)” `Select` with `placeholder="-- Không gán khu --"`, options from `zones` (`${z.code} — ${z.name || ''}`), `onChange` calls `invalidate()`.
- Section 3 — “Tiền tố mã căn” `Input`, `placeholder="VD: A"`, hint “Mã căn = Tiền tố + Tầng + Hậu tố (VD: A + tầng 5 + 01 = A501). Để trống sẽ dùng mã khu nếu đã chọn khu.” `onChange` calls `invalidate()`.
- Section 4 — “Mẫu căn”: number input “Số căn mỗi tầng” bound to `unitCount`; changing it calls `setUnits(makeUnits(n, units))` and `invalidate()`. Then an `overflow-x-auto` table with one row per unit and columns: Hậu tố (`Input`), Loại căn (`Select` with `['Studio','1PN','2PN','3PN','Penthouse','Duplex']`), Số PN (`Input type="number" min="0"`), Diện tích m² (`Input type="number" min="0" step="0.5"`), Giá thuê (`MoneyInput`), and a remove button (`Trash2`, disabled when `units.length === 1`). Each edit replaces the row and calls `invalidate()`. A “Thêm loại căn” button appends `{ ...DEFAULT_UNIT, suffix: String(units.length + 1).padStart(2, '0') }` and calls `invalidate()`.
- Section 5 — Preview action: `<Button variant="outline" icon={Eye} loading={loadingPreview} onClick={handlePreview} type="button">Xem trước {totalDrafts} căn</Button>`.
- Preview panel when `preview` exists:
  - If `preview.valid`: green summary “{preview.total} căn hợp lệ, chưa có mã trùng” and grouped badges per floor (`floor_name` + each `code`).
  - If `!preview.valid`: red summary listing each conflict `code` and floor, with instruction to đổi tiền tố/hậu tố.
- Footer: `Hủy` button + submit button `Tạo {preview?.total || totalDrafts} căn hộ`, disabled when `!preview || preview.valid === false || submitting`.
- All `Input`/`Select`/`MoneyInput` changes must call `invalidate()`; this is the stale-preview guard.

- [ ] **Step 3: Wire the modal into `FloorPlanPage.jsx`**

Add imports:

```jsx
import { CopyPlus } from 'lucide-react';
import { BulkApartmentModal } from './BulkApartmentModal';
```

Add state next to `aptModalOpen`:

```jsx
const [bulkModalOpen, setBulkModalOpen] = useState(false);
```

Add a “Tạo hàng loạt” button next to both existing “Thêm căn hộ” buttons (the full-screen header actions and the embedded filter-bar actions):

```jsx
<Button variant="outline" size="sm" icon={CopyPlus} onClick={() => setBulkModalOpen(true)}>
  Tạo hàng loạt
</Button>
```

Render the modal near the existing apartment modal:

```jsx
<BulkApartmentModal
  open={bulkModalOpen}
  onClose={() => setBulkModalOpen(false)}
  buildingId={buildingId}
  floors={(floorMap || []).map((f) => ({ id: f.id, level: f.level, name: f.name, apartment_count: (f.apartments || []).length }))}
  zones={zones}
  onCreated={() => loadFloorPlan()}
/>
```

- [ ] **Step 4: Verify the frontend build and existing UI tests**

Run:
```powershell
cd d:\resihub\frontend
npm run build
node --test src/utils/__tests__/uiInformationCompleteness.test.js
```
Expected: Vite build succeeds with no errors; UI test passes.

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/pages/admin/buildings/BulkApartmentModal.jsx frontend/src/pages/admin/buildings/FloorPlanPage.jsx frontend/src/services/buildings.service.js
git commit -m "feat(m03): add bulk apartment creation UI by floor template (FR-009)"
```

---

### Task 4: Documentation and Full Verification

**Files:**
- Modify: `README.md` (API endpoint list, around line 339)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: user-facing endpoint documentation; final verification evidence.

- [ ] **Step 1: Document the endpoint**

In `README.md`, under `#### Bất động sản (``/api/v1/buildings`` & ``/api/v1/apartments``)`, after the `POST /api/v1/apartments` bullet, add:

```md
- `POST /api/v1/apartments/bulk` — Tạo hàng loạt căn hộ theo mẫu tầng trên 1..n tầng; gửi `dry_run: true` để xem trước mã căn và danh sách trùng.
```

- [ ] **Step 2: Run the full backend test suite**

Run:
```powershell
cd d:\resihub\api
npm test
```
Expected: no new failures; bulk unit test passes; integration tests pass or skip when the API server is not running.

- [ ] **Step 3: Run the frontend build**

Run:
```powershell
cd d:\resihub\frontend
npm run build
```
Expected: build succeeds.

- [ ] **Step 4: Manual smoke check (with API + frontend running)**

1. Log in as `manager.vop.a@resihub.vn` / `Demo@123456`.
2. Open a building → Sơ đồ tầng → “Tạo hàng loạt”.
3. Select 2 floors, prefix `ZZ`, 2 unit rows with suffixes `01`/`02`.
4. Click “Xem trước 4 căn” → verify codes `ZZ<floor>01`, `ZZ<floor>02` for both floors.
5. Change the prefix → verify the preview disappears and must be regenerated.
6. Click “Tạo 4 căn hộ” → verify 4 new apartments appear in the floor plan and the toast reports 4.
7. Repeat the same batch → verify a duplicate-code error and no new apartments.

- [ ] **Step 5: Commit**

```powershell
git add README.md
git commit -m "docs(m03): document bulk apartment creation endpoint (FR-009)"
```

---

## Self-Review Notes

- **Spec coverage:** FR-009 (bulk 1..n by floor template, code rule) → Tasks 1–3. FR-008 duplicate blocking + audit → Task 2. RBAC `Mục 6.2` → Task 2. UI preview/edit-before-save → Task 3.
- **Type consistency:** `floorLevelToken`, `buildApartmentDrafts`, `findDuplicateCodes` are introduced in Task 1 and used with the same names in Task 2. Service methods `previewApartmentsBulk` / `createApartmentsBulk` are introduced and consumed in Task 3.
- **Intentional omission:** No persisted “template” table and no template CRUD. The PRD only requires generating apartments from a floor template; persisting templates is speculative. Add `apartment_template` storage only when users ask to reuse templates across sessions.
- **Intentional omission:** No idempotency-key middleware on this endpoint. Re-submitting the same payload is already blocked by the unique `(building_id, code)` constraint and the all-or-nothing pre-check; a second submit returns `409` without creating rows.
