import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function readRel(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('ResidentPortalPage resolves target_contract_id safely for active vs ended contracts', () => {
  const src = readRel('frontend/src/pages/resident/ResidentPortalPage.jsx');
  assert.match(
    src,
    /target_contract_id/,
    'ResidentPortalPage must read target_contract_id from searchParams'
  );
  assert.match(
    src,
    /targetContractId/,
    'ResidentPortalPage must pass targetContractId down to Resident tabs'
  );
  assert.match(
    src,
    /activeContracts=\{overview\?\.active_contracts \|\| \[\]\}/,
    'ResidentLayout contract switcher must remain strictly bound to overview.active_contracts'
  );
});

test('InvoicesTab supports modal=pay, modal=detail, and modal=credit with stripNotificationTriggerParams cleanup', () => {
  const src = readRel('frontend/src/pages/resident/tabs/InvoicesTab.jsx');
  assert.match(src, /stripNotificationTriggerParams/, 'InvoicesTab must import stripNotificationTriggerParams');
  assert.match(src, /replace:\s*true/, 'InvoicesTab must clean trigger params with replace: true');
  assert.match(src, /detailInvoice/, 'InvoicesTab must provide read-only Invoice Detail Modal state');
  assert.match(src, /detailCredit|creditModal/, 'InvoicesTab must provide Credit Balance Detail Modal state');
  assert.match(src, /targetContractId/, 'InvoicesTab must support targetContractId for ended contract invoices');
});

test('ContractTab mounts A4 template modal outside EmptyState and handles settlement, bank, renew, contract_view, deposit_view', () => {
  const src = readRel('frontend/src/pages/resident/tabs/ContractTab.jsx');
  assert.match(src, /stripNotificationTriggerParams/, 'ContractTab must import stripNotificationTriggerParams');
  assert.match(src, /replace:\s*true/, 'ContractTab must clean trigger params with replace: true');
  assert.match(src, /modal\s*===\s*['"]settlement['"]/, 'ContractTab must handle modal=settlement');
  assert.match(src, /modal\s*===\s*['"]bank['"]/, 'ContractTab must handle modal=bank');
  assert.match(src, /modal\s*===\s*['"]renew['"]/, 'ContractTab must handle modal=renew');
  assert.match(src, /modal\s*===\s*['"]contract_view['"]/, 'ContractTab must handle modal=contract_view');
  assert.match(src, /modal\s*===\s*['"]deposit_view['"]/, 'ContractTab must handle modal=deposit_view');

  // Verify EmptyState does NOT prematurely return before templateOpen Modal is mounted
  const emptyStateIdx = src.indexOf('title="Chưa có hợp đồng thuê"');
  const templateModalIdx = src.indexOf('open={templateOpen}');
  assert.ok(emptyStateIdx > -1 && templateModalIdx > -1, 'Both EmptyState and templateOpen Modal must exist');
  const between = src.slice(Math.max(0, emptyStateIdx - 250), emptyStateIdx);
  assert.doesNotMatch(
    between,
    /if\s*\(!contract[\s\S]*?\)\s*\{\s*return\s*\(/,
    'ContractTab must not early-return EmptyState before mounting templateOpen Modal (co-occupant support)'
  );
});

test('MaintenanceTab, ServicesTab, and OverviewTab consume deep-link modal params and clean URL with replace: true', () => {
  const maintSrc = readRel('frontend/src/pages/resident/tabs/MaintenanceTab.jsx');
  assert.match(maintSrc, /stripNotificationTriggerParams/, 'MaintenanceTab must use stripNotificationTriggerParams');
  assert.match(maintSrc, /replace:\s*true/, 'MaintenanceTab must clean URL with replace: true');
  assert.match(maintSrc, /detailRequest/, 'MaintenanceTab must render a Service Request Detail Modal');

  const svcSrc = readRel('frontend/src/pages/resident/tabs/ServicesTab.jsx');
  assert.match(svcSrc, /stripNotificationTriggerParams/, 'ServicesTab must use stripNotificationTriggerParams');
  assert.match(svcSrc, /replace:\s*true/, 'ServicesTab must clean URL with replace: true');
  assert.match(svcSrc, /detailSubscription/, 'ServicesTab must render a Service Subscription Detail Modal');

  const ovSrc = readRel('frontend/src/pages/resident/tabs/OverviewTab.jsx');
  assert.match(ovSrc, /stripNotificationTriggerParams/, 'OverviewTab must use stripNotificationTriggerParams');
  assert.match(ovSrc, /replace:\s*true/, 'OverviewTab must clean URL with replace: true');
  assert.match(ovSrc, /modal\s*===\s*['"]apply['"]/, 'OverviewTab must handle modal=apply');
  assert.match(ovSrc, /modal\s*===\s*['"]reservation['"]/, 'OverviewTab must handle modal=reservation');
  assert.match(ovSrc, /detailReservation/, 'OverviewTab must render a Reservation Detail Modal');
});
