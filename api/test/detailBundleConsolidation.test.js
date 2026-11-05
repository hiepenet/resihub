import { test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5000';

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

async function apiFetch(path, token) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await res.json();
  return { status: res.status, body };
}

test('Task 2.1 — GET /api/v1/apartments/:id bundles building zones matching /buildings/:id/zones', async () => {
  const mgr = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const aptsRes = await apiFetch('/api/v1/apartments', mgr.token);
  assert.equal(aptsRes.status, 200);
  assert.ok(aptsRes.body.data.length > 0, 'Seed apartments must exist for manager.vop.a');

  const sampleApt = aptsRes.body.data[0];
  const [aptDetailRes, standaloneZonesRes] = await Promise.all([
    apiFetch(`/api/v1/apartments/${sampleApt.id}`, mgr.token),
    apiFetch(`/api/v1/buildings/${sampleApt.building_id}/zones`, mgr.token),
  ]);

  assert.equal(aptDetailRes.status, 200);
  assert.equal(standaloneZonesRes.status, 200);
  assert.ok(
    Array.isArray(aptDetailRes.body.data.zones),
    'GET /api/v1/apartments/:id must include zones array in response data'
  );
  assert.deepEqual(
    aptDetailRes.body.data.zones.map((z) => ({
      id: z.id,
      code: z.code,
      name: z.name,
      apartment_count: z.apartment_count,
    })),
    standaloneZonesRes.body.data.map((z) => ({
      id: z.id,
      code: z.code,
      name: z.name,
      apartment_count: z.apartment_count,
    })),
    'Bundled apartment zones must match standalone /buildings/:id/zones'
  );
});

test('Task 2.2 — GET /api/v1/contracts/:id bundles occupants (with OWNER PII masking), amendments, service_prices & catalog_services', async () => {
  const [mgr, owner] = await Promise.all([
    login('manager.vop.a@resihub.vn', 'Demo@123456'),
    login('owner.vop@resihub.vn', 'Demo@123456'),
  ]);

  const listRes = await apiFetch('/api/v1/contracts', mgr.token);
  assert.equal(listRes.status, 200);
  assert.ok(listRes.body.data.length > 0, 'Seed contracts must exist for manager.vop.a');

  // Prefer a contract that has co-occupants if present in seed data; otherwise use first contract
  let targetContract = listRes.body.data[0];
  for (const candidate of listRes.body.data.slice(0, 15)) {
    const occRes = await apiFetch(`/api/v1/contracts/${candidate.id}/occupants`, mgr.token);
    if (occRes.status === 200 && Array.isArray(occRes.body.data) && occRes.body.data.length > 0) {
      targetContract = candidate;
      break;
    }
  }

  const [detailMgr, occMgr, amendMgr, pricesMgr, detailOwner, occOwner] = await Promise.all([
    apiFetch(`/api/v1/contracts/${targetContract.id}`, mgr.token),
    apiFetch(`/api/v1/contracts/${targetContract.id}/occupants`, mgr.token),
    apiFetch(`/api/v1/contracts/${targetContract.id}/amendments`, mgr.token),
    apiFetch(`/api/v1/contracts/${targetContract.id}/service-prices`, mgr.token),
    apiFetch(`/api/v1/contracts/${targetContract.id}`, owner.token),
    apiFetch(`/api/v1/contracts/${targetContract.id}/occupants`, owner.token),
  ]);

  assert.equal(detailMgr.status, 200);
  assert.ok(Array.isArray(detailMgr.body.data.occupants), 'Contract detail must bundle occupants array');
  assert.ok(Array.isArray(detailMgr.body.data.amendments), 'Contract detail must bundle amendments array');
  assert.ok(Array.isArray(detailMgr.body.data.service_prices), 'Contract detail must bundle service_prices array');
  assert.ok(Array.isArray(detailMgr.body.data.catalog_services), 'Contract detail must bundle catalog_services array');

  assert.deepEqual(detailMgr.body.data.occupants, occMgr.body.data);
  assert.deepEqual(detailMgr.body.data.amendments, amendMgr.body.data);
  assert.deepEqual(detailMgr.body.data.service_prices, pricesMgr.body.data);
  assert.ok(
    detailMgr.body.data.catalog_services.every((s) => s.is_active === true),
    'Bundled catalog_services must contain only active services'
  );

  // Review Focus #3: OWNER PII masking on bundled occupants must match standalone /occupants
  assert.equal(detailOwner.status, 200);
  assert.deepEqual(
    detailOwner.body.data.occupants,
    occOwner.body.data,
    'OWNER bundled occupants must preserve exact maskIdNumber PII masking'
  );
  const ownerOccWithId = detailOwner.body.data.occupants.find((o) => o.id_number);
  if (ownerOccWithId) {
    assert.ok(
      String(ownerOccWithId.id_number).includes('*'),
      'OWNER bundled occupant id_number must be masked with asterisks'
    );
  }
});

test('Task 2.3 — GET /api/v1/service-catalog honors both active_only=true and is_active=true', async () => {
  const mgr = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const [resActiveOnly, resIsActive] = await Promise.all([
    apiFetch('/api/v1/service-catalog?active_only=true', mgr.token),
    apiFetch('/api/v1/service-catalog?is_active=true', mgr.token),
  ]);
  assert.equal(resActiveOnly.status, 200);
  assert.equal(resIsActive.status, 200);
  assert.ok(resIsActive.body.data.every((item) => item.is_active === true));
  assert.equal(resIsActive.body.data.length, resActiveOnly.body.data.length);
});
