import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', '..');

function readSrc(relPath) {
  return fs.readFileSync(path.join(SRC_DIR, relPath), 'utf8');
}

test('StatsCard never truncates KPI value or subtext with ellipsis', () => {
  const src = readSrc('components/common/StatsCard.jsx');
  assert.equal(/truncate[^>]*>\{value\}/.test(src), false, 'StatsCard value must not use truncate');
  assert.equal(/truncate[^>]*>\{subtext\}/.test(src), false, 'StatsCard subtext must not use truncate');
});

test('Select dropdown options display full label and sublabel without truncate when open', () => {
  const src = readSrc('components/ui/Select.jsx');
  assert.equal(/<span className="truncate">\{opt\.label\}<\/span>/.test(src), false, 'Open Select option label must not truncate');
  assert.equal(/truncate[^>]*>\s*\{opt\.sublabel\}/.test(src), false, 'Open Select option sublabel must not truncate');
});

test('Badge supports icon prop and statuses defines RESERVATION_STATUS', async () => {
  const badgeSrc = readSrc('components/ui/Badge.jsx');
  assert.equal(/icon:\s*Icon/.test(badgeSrc), true, 'Badge must destructure and render icon prop');

  const statuses = await import('../../constants/statuses.js');
  assert.ok(statuses.RESERVATION_STATUS, 'RESERVATION_STATUS must be exported');
  for (const key of ['HELD', 'CONVERTED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'FORFEITED']) {
    assert.ok(statuses.RESERVATION_STATUS[key]?.label, `RESERVATION_STATUS.${key} must have Vietnamese label`);
  }
});

test('Resident OverviewTab KPI cards and subtitles never clip monetary values or status footers', () => {
  const src = readSrc('pages/resident/tabs/OverviewTab.jsx');
  assert.equal(/text-2xl[^`"]*truncate/.test(src), false, 'OverviewTab KPI values must not use truncate');
  assert.equal(
    /<span className="text-xs text-slate-500 truncate">\s*\{currentAmountDue/.test(src),
    false,
    'OverviewTab debt subtitle must not truncate'
  );
  assert.equal(
    /<span className="text-xs text-slate-500 truncate">\s*\{contract\.deposit_status/.test(src),
    false,
    'OverviewTab deposit subtitle must not truncate'
  );
  assert.equal(src.includes('total_amount_due_all'), true, 'OverviewTab must surface total_amount_due_all for multi-apartment residents');
});

test('Resident tabs map backend fields accurately (MaintenanceTab resolution_note, ContractTab deposit_refund_due_date, ProfileTab id_images)', () => {
  const maintSrc = readSrc('pages/resident/tabs/MaintenanceTab.jsx');
  assert.equal(maintSrc.includes('resolution_note'), true, 'MaintenanceTab must display resolution_note details (internal_note is staff-only per PRD 13.5)');
  assert.equal(maintSrc.includes('resolved_at'), true, 'MaintenanceTab must display resolved_at timestamp');

  const contractTabSrc = readSrc('pages/resident/tabs/ContractTab.jsx');
  assert.equal(contractTabSrc.includes('deposit_refund_due_date'), true, 'ContractTab must map deposit_refund_due_date');
  assert.equal(
    /<span className="text-xs font-semibold text-slate-800 truncate">\s*\{step\.label\}/.test(contractTabSrc),
    false,
    'ContractTab timeline step label must not truncate'
  );

  const profileTabSrc = readSrc('pages/resident/tabs/ProfileTab.jsx');
  assert.equal(profileTabSrc.includes('id_images'), true, 'ProfileTab must display uploaded CCCD id_images');
});

test('Admin pages do not hide building bank account, tower suffix, terminated contract email, extra proof images, or cancelled tickets', () => {
  const bldgDetailSrc = readSrc('pages/admin/buildings/BuildingDetailPage.jsx');
  assert.equal(
    bldgDetailSrc.includes('lease_terms?.payment_account'),
    true,
    'BuildingDetailPage must read building.lease_terms?.payment_account'
  );

  const tenantsSrc = readSrc('pages/admin/tenants/TenantsPage.jsx');
  assert.equal(tenantsSrc.includes('max-w-[95px]'), false, 'TenantsPage must not clip building_name to 95px');

  const contractsSrc = readSrc('pages/admin/contracts/ContractsPage.jsx');
  assert.equal(
    /<p className="text-xs text-slate-500 truncate max-w-\[180px\]">\{row\.building_name\}<\/p>/.test(contractsSrc),
    false,
    'ContractsPage must not truncate building_name at 180px'
  );

  const contractDetailSrc = readSrc('pages/admin/contracts/ContractDetailPage.jsx');
  assert.equal(
    contractDetailSrc.includes('Email liên hệ / Ngày thanh lý'),
    false,
    'ContractDetailPage must not overwrite tenant_email with terminated_at'
  );

  const invDetailSrc = readSrc('pages/admin/invoices/InvoiceDetailPage.jsx');
  assert.equal(
    invDetailSrc.includes('setPreviewProof(py.proof_images[0])'),
    false,
    'InvoiceDetailPage must allow viewing all proof_images, not only index 0'
  );

  const srSrc = readSrc('pages/admin/maintenance/ServiceRequestsPage.jsx');
  assert.equal(
    /status:\s*'CANCELLED'|key:\s*'CANCELLED'|id:\s*'CANCELLED'/.test(srSrc),
    true,
    'ServiceRequestsPage Kanban must support CANCELLED column so cancelled tickets are visible'
  );
});
