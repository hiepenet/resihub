import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh';

function createFakeBootstrapPool() {
  const state = {
    orgs: [],
    roles: [],
    catalog: [],
    settings: [],
    persons: [],
    users: [],
    userRoles: [],
    alteredPassword: null,
    locked: false,
  };

  const client = {
    async query(sql, params = []) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (s.includes('pg_advisory_lock')) {
        state.locked = true;
        return { rows: [] };
      }
      if (s.includes('pg_advisory_unlock')) {
        state.locked = false;
        return { rows: [] };
      }
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes("format('ALTER ROLE resihub_app WITH LOGIN PASSWORD %L'")) {
        return { rows: [{ ddl: `ALTER ROLE resihub_app WITH LOGIN PASSWORD '${params[0]}'` }] };
      }
      if (s.startsWith('ALTER ROLE resihub_app WITH LOGIN PASSWORD')) {
        state.alteredPassword = s;
        return { rows: [] };
      }
      if (s.startsWith('SELECT id FROM organization')) {
        return { rows: state.orgs.slice(0, 1) };
      }
      if (s.startsWith('INSERT INTO organization')) {
        const row = { id: '11111111-1111-4111-8111-111111111111', name: params[0] };
        state.orgs.push(row);
        return { rows: [row] };
      }
      if (s.startsWith('INSERT INTO role')) {
        const [orgId, code, name, scope] = params;
        if (!state.roles.find((r) => r.orgId === orgId && r.code === code)) {
          state.roles.push({ id: `role-${code}`, orgId, code, name, scope });
        }
        return { rows: [] };
      }
      if (s.startsWith('SELECT id, code FROM role WHERE org_id = $1')) {
        return { rows: state.roles.filter((r) => r.orgId === params[0]) };
      }
      if (s.startsWith('INSERT INTO service_catalog')) {
        const [orgId, code] = params;
        if (!state.catalog.find((c) => c.orgId === orgId && c.code === code)) {
          state.catalog.push({ orgId, code });
        }
        return { rows: [] };
      }
      if (s.startsWith('INSERT INTO system_setting')) {
        const [orgId, key] = params;
        if (!state.settings.find((st) => st.orgId === orgId && st.key === key)) {
          state.settings.push({ orgId, key });
        }
        return { rows: [] };
      }
      if (s.includes("WHERE r.code = 'SYS_ADMIN'")) {
        const hasSys = state.userRoles.some((ur) => ur.roleId === 'role-SYS_ADMIN');
        return { rows: hasSys ? [{ exists: 1 }] : [] };
      }
      if (s.startsWith('INSERT INTO person')) {
        const p = { id: 'person-admin', orgId: params[0], email: params[3] };
        state.persons.push(p);
        return { rows: [p] };
      }
      if (s.startsWith('INSERT INTO app_user')) {
        const u = { id: 'user-admin', personId: params[0], passwordHash: params[2] };
        state.users.push(u);
        return { rows: [u] };
      }
      if (s.startsWith('INSERT INTO user_role')) {
        state.userRoles.push({ userId: params[0], roleId: params[1] });
        return { rows: [] };
      }
      throw new Error(`Unhandled SQL in test mock: ${s}`);
    },
    release() {},
  };

  return {
    state,
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
  };
}

test('BP01: runProductionBootstrap chạy 2 lần liên tiếp hoàn toàn idempotent và khởi tạo đủ dữ liệu nền', async () => {
  const { runProductionBootstrap } = await import('../src/db/bootstrapProd.js');
  const { state, pool } = createFakeBootstrapPool();
  const envObj = {
    APP_DB_PASSWORD: 'app_secret_hex_password',
    INIT_ORG_NAME: 'BQL Tòa Nhà Việt Nam',
    INIT_ADMIN_EMAIL: 'admin@resihub.vn',
    INIT_ADMIN_PASSWORD: 'StrongPassword123',
    INIT_ADMIN_PHONE: '0900000001',
  };

  const first = await runProductionBootstrap({ poolInstance: pool, envObj, closePool: false });
  assert.equal(first.syncedAppRole, true);
  assert.equal(first.createdAdmin, true);
  assert.equal(state.orgs.length, 1);
  assert.equal(state.roles.length, 4);
  assert.equal(state.catalog.length, 7);
  assert.equal(state.settings.length, 6);
  assert.equal(state.users.length, 1);
  assert.equal(state.locked, false);

  const second = await runProductionBootstrap({ poolInstance: pool, envObj, closePool: false });
  assert.equal(second.createdAdmin, false);
  assert.equal(state.orgs.length, 1);
  assert.equal(state.users.length, 1);
  assert.equal(state.userRoles.length, 1);
});

test('BP02: runProductionBootstrap từ chối INIT_ADMIN_PASSWORD ngắn hơn 8 ký tự khi chưa có SYS_ADMIN', async () => {
  const { runProductionBootstrap } = await import('../src/db/bootstrapProd.js');
  const { state, pool } = createFakeBootstrapPool();
  await assert.rejects(
    () =>
      runProductionBootstrap({
        poolInstance: pool,
        envObj: {
          INIT_ADMIN_EMAIL: 'admin@resihub.vn',
          INIT_ADMIN_PASSWORD: 'short',
        },
        closePool: false,
      }),
    /8/
  );
  assert.equal(state.locked, false);
});
