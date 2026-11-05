import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = path.resolve(__dirname, '../../frontend/src');

function readFrontend(relPath) {
  return fs.readFileSync(path.join(FRONTEND_SRC, relPath), 'utf8');
}

test('Task 4.1 — Route chunk preloaders cover core navigation hubs and are wired into Sidebar & AdminLayout', () => {
  const preloaderPath = path.join(FRONTEND_SRC, 'router/routePreloaders.js');
  assert.ok(fs.existsSync(preloaderPath), 'frontend/src/router/routePreloaders.js must exist');

  const preloaderSrc = readFrontend('router/routePreloaders.js');
  assert.ok(preloaderSrc.includes('preloadRouteChunk'), 'Must export preloadRouteChunk');
  assert.ok(
    preloaderSrc.includes('preloadCoreAdminNavigationChunks'),
    'Must export preloadCoreAdminNavigationChunks'
  );
  for (const requiredRoute of ['/admin/buildings', '/admin/tenants', '/admin/contracts']) {
    assert.ok(preloaderSrc.includes(requiredRoute), `Preloader map must include ${requiredRoute}`);
  }

  const sidebarSrc = readFrontend('components/layout/Sidebar.jsx');
  assert.ok(
    sidebarSrc.includes('preloadRouteChunk'),
    'Sidebar.jsx must preload route chunks on pointer enter / focus'
  );

  const layoutSrc = readFrontend('components/layout/AdminLayout.jsx');
  assert.ok(
    layoutSrc.includes('preloadCoreAdminNavigationChunks'),
    'AdminLayout.jsx must warm core navigation chunks during idle time'
  );
});

test('Task 4.2 — BuildingDetailPage & FloorPlanView eliminate upfront tenant/contract blocking and duplicate building/zone waterfall', () => {
  const bldDetailSrc = readFrontend('pages/admin/buildings/BuildingDetailPage.jsx');

  // Extract loadBuildingData block and ensure tenantsService.list & contractsService.list are NOT inside initial overview Promise.all
  const loadMatch = bldDetailSrc.match(/const loadBuildingData\s*=\s*useCallback\([\s\S]*?\},\s*\[[^\]]*\]\);/);
  assert.ok(loadMatch, 'BuildingDetailPage must define loadBuildingData');
  assert.equal(
    loadMatch[0].includes('tenantsService.list'),
    false,
    'loadBuildingData must NOT block initial overview render on tenantsService.list'
  );
  assert.equal(
    loadMatch[0].includes('contractsService.list'),
    false,
    'loadBuildingData must NOT block initial overview render on contractsService.list'
  );

  assert.ok(
    bldDetailSrc.includes('initialBuilding=') && bldDetailSrc.includes('initialZones='),
    'BuildingDetailPage must pass initialBuilding and initialZones into embedded FloorPlanView'
  );

  const floorPlanSrc = readFrontend('pages/admin/buildings/FloorPlanPage.jsx');
  assert.ok(
    floorPlanSrc.includes('initialBuilding') && floorPlanSrc.includes('initialZones'),
    'FloorPlanView must accept initialBuilding and initialZones to skip duplicate HTTP requests when embedded'
  );
});

test('Task 4.3 — ContractDetailPage & ApartmentDetailPage eliminate sequential waterfalls via bundled payloads', () => {
  const contractDetailSrc = readFrontend('pages/admin/contracts/ContractDetailPage.jsx');
  const loadAllMatch = contractDetailSrc.match(/const loadAll\s*=\s*useCallback\([\s\S]*?\},\s*\[[^\]]*\]\);/);
  assert.ok(loadAllMatch, 'ContractDetailPage must define loadAll');
  assert.equal(
    loadAllMatch[0].includes('contractsService.listOccupants(id)'),
    false,
    'ContractDetailPage loadAll must consume bundled occupants from getById instead of firing separate listOccupants'
  );
  assert.equal(
    loadAllMatch[0].includes('contractsService.listAmendments(id)'),
    false,
    'ContractDetailPage loadAll must consume bundled amendments from getById instead of firing separate listAmendments'
  );
  assert.equal(
    loadAllMatch[0].includes('contractsService.listServicePrices(id)'),
    false,
    'ContractDetailPage loadAll must consume bundled service_prices from getById instead of firing separate listServicePrices'
  );

  const aptDetailSrc = readFrontend('pages/admin/apartments/ApartmentDetailPage.jsx');
  assert.ok(
    aptDetailSrc.includes('Array.isArray(d?.zones)') || aptDetailSrc.includes('Array.isArray(d.zones)'),
    'ApartmentDetailPage must consume bundled d.zones from getApartment(id) to avoid sequential listZones waterfall'
  );
});

test('Task 4.4 — Core resident, contract, and building/apartment pages seed state from queryCache peek helpers to prevent skeleton flash', () => {
  const expectedPeeks = [
    ['pages/admin/tenants/TenantsPage.jsx', 'tenantsService.peekList'],
    ['pages/admin/tenants/TenantDetailPage.jsx', 'tenantsService.peekById'],
    ['pages/admin/contracts/ContractsPage.jsx', 'contractsService.peekList'],
    ['pages/admin/contracts/ContractDetailPage.jsx', 'contractsService.peekById'],
    ['pages/admin/buildings/BuildingsPage.jsx', 'buildingsService.peekList'],
    ['pages/admin/buildings/BuildingDetailPage.jsx', 'buildingsService.peekById'],
    ['pages/admin/apartments/ApartmentDetailPage.jsx', 'buildingsService.peekApartment'],
  ];

  for (const [relFile, peekSymbol] of expectedPeeks) {
    const src = readFrontend(relFile);
    assert.ok(
      src.includes(peekSymbol),
      `${relFile} must seed initial state from ${peekSymbol} to avoid PageSkeleton/table flash on repeat navigation`
    );
  }
});

test('Task 4.5 — Route param transitions (:id1 -> :id2) remount cleanly via RouteKeyWrapper and FloorPlanView guards initialBuilding ID match', () => {
  const routerSrc = readFrontend('router/index.jsx');
  assert.ok(
    routerSrc.includes('RouteKeyWrapper') && routerSrc.includes('useParams'),
    'router/index.jsx withSuspense must key route elements via RouteKeyWrapper + useParams so :id1 -> :id2 transitions do not leak stale state'
  );

  const floorPlanSrc = readFrontend('pages/admin/buildings/FloorPlanPage.jsx');
  assert.ok(
    floorPlanSrc.includes('String(initialBuilding.id) === String(buildingId)'),
    'FloorPlanView must verify initialBuilding.id matches buildingId before seeding or skipping network fetch'
  );
  assert.match(
    floorPlanSrc,
    /<FloorPlanView[\s\S]*?key=\{selectedBuildingId\}/,
    'Standalone FloorPlanPage must key FloorPlanView by selectedBuildingId when switching buildings'
  );
});
