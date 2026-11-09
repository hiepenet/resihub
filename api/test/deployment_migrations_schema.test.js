import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migDir = path.join(__dirname, '../src/db/migrations');

test('DDL01: 002_core_tables.sql và 010_production_schema_alignment.sql có đủ các cột bắt buộc cho DB mới', () => {
  const core = fs.readFileSync(path.join(migDir, '002_core_tables.sql'), 'utf8');
  const alignPath = path.join(migDir, '010_production_schema_alignment.sql');
  assert.equal(fs.existsSync(alignPath), true, 'Thiếu file 010_production_schema_alignment.sql');
  const align = fs.readFileSync(alignPath, 'utf8');

  const requiredTokens = [
    'token_version',
    'privacy_consent_at',
    'privacy_policy_version',
    'desired_apartment_id',
    'application_note',
    'is_room_transfer',
    'transfer_deposit',
    'desired_date',
    'is_active',
    'prorata_amount',
    'request_hash',
    'status_code',
    'DEDUCTED_FULL',
    'ADJUSTED',
    'NEEDS_MANUAL_REVIEW',
  ];
  for (const token of requiredTokens) {
    assert.match(core, new RegExp(`\\b${token}\\b`), `002_core_tables.sql thiếu ${token}`);
    assert.match(align, new RegExp(`\\b${token}\\b`), `010_production_schema_alignment.sql thiếu ${token}`);
  }
});

test('DDL02: migrate.js dùng pg_advisory_lock(73918201) và luôn giải phóng khóa trong finally', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh';
  const { runMigrations, MIGRATION_ADVISORY_LOCK_KEY } = await import('../src/db/migrate.js');
  assert.equal(MIGRATION_ADVISORY_LOCK_KEY, 73918201);

  const calls = [];
  const fakeClient = {
    async query(sql) {
      calls.push(String(sql).trim());
      if (String(sql).includes('SELECT name FROM _migrations')) {
        const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
        return { rows: files.map((name) => ({ name })) };
      }
      return { rows: [] };
    },
    release() {
      calls.push('RELEASE_CLIENT');
    },
  };
  const fakePool = {
    async connect() {
      return fakeClient;
    },
    async end() {
      calls.push('END_POOL');
    },
  };

  await runMigrations({ poolInstance: fakePool, closePool: false });
  assert.ok(calls.some((c) => c.includes('pg_advisory_lock')));
  assert.ok(calls.some((c) => c.includes('pg_advisory_unlock')));
  assert.ok(!calls.includes('END_POOL'));
});
