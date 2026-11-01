import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '../..');

function readSrc(relPath) {
  return fs.readFileSync(path.join(SRC_ROOT, relPath), 'utf8');
}

test('Task 5.1: usePermission enforces SYS_ADMIN R-only on contracts and OWNER price approval', () => {
  const src = readSrc('hooks/usePermission.js');
  assert.match(src, /canCreateContracts:\s*isManager\b/, 'canCreateContracts must be strictly isManager');
  assert.match(src, /canTerminateContracts:\s*isManager\b/, 'canTerminateContracts must be strictly isManager');
  assert.match(src, /canApproveContractAmendments:\s*isManager\b/, 'canApproveContractAmendments must be strictly isManager');
  assert.match(src, /canApproveContractPrice:\s*isOwner\s*\|\|\s*isSysAdmin\b/, 'canApproveContractPrice must include isOwner || isSysAdmin');
});

test('Task 5.2: FileUpload supports custom maxSizeMB, PDF preview tile, and exports AuthPdfViewer', () => {
  const src = readSrc('components/ui/FileUpload.jsx');
  assert.match(src, /maxSizeMB\s*=\s*5/, 'FileUpload must accept maxSizeMB prop defaulting to 5');
  assert.match(src, /application\/pdf/, 'FileUpload must detect application/pdf');
  assert.match(src, /export\s+function\s+AuthPdfViewer/, 'FileUpload must export AuthPdfViewer');
});

test('Task 5.3: ContractsPage supports billing_day 1-31, payment_due_days, Step 4 services & custom prices, and atomic POST without follow-up PATCH', () => {
  const src = readSrc('pages/admin/contracts/ContractsPage.jsx');
  assert.doesNotMatch(
    src,
    /contractsService\.update\(\s*created\.id\s*,\s*\{\s*billing_cycle/,
    'ContractsPage must NOT patch billing_cycle in a second request after POST'
  );
  assert.match(src, /payment_due_days/, 'ContractsPage must include payment_due_days field');
  assert.match(src, /max="31"/, 'ContractsPage must allow billing_day up to 31');
  assert.match(src, /servicesService\.listCatalog/, 'ContractsPage must load service catalog for Step 4');
  assert.match(src, /Bước 4|Dịch vụ đi kèm/, 'ContractsPage must render Step 4 accompanying services');
  assert.match(src, /Chủ sở hữu|OWNER/, 'Discount warning must reference building OWNER approval');
});

test('Task 5.4: ContractDetailPage enforces canManageOps = isManager, OWNER price approval, PDF scan upload/viewer, payment_due_days, and expected invoice schedule tab', () => {
  const src = readSrc('pages/admin/contracts/ContractDetailPage.jsx');
  assert.match(src, /const\s+canManageOps\s*=\s*isManager\s*;/, 'canManageOps must be strictly isManager');
  assert.match(src, /has_building_owner/, 'ContractDetailPage must check has_building_owner for SYS_ADMIN fallback');
  assert.match(src, /application\/pdf/, 'ContractDetailPage must accept application/pdf for signed scans');
  assert.match(src, /AuthPdfViewer/, 'ContractDetailPage must use AuthPdfViewer for PDF scans');
  assert.match(src, /payment_due_days/, 'ContractDetailPage must display and edit payment_due_days');
  assert.match(src, /invoice_schedule/, 'ContractDetailPage must render expected invoice_schedule');
  assert.match(src, /Lịch hóa đơn dự kiến/, 'ContractDetailPage must include Lịch hóa đơn dự kiến tab');
});

test('Co-occupant inline cards in ContractsPage use spacious 2-column grid instead of cramped 12-col single row', () => {
  const src = readSrc('pages/admin/contracts/ContractsPage.jsx');
  assert.match(src, /data-testid="inline-occupant-card"/, 'Each co-occupant item must render as a structured card');
  assert.doesNotMatch(
    src,
    /sm:grid-cols-12\s+gap-2\.5\s+items-start[\s\S]{0,400}occ_name_/,
    'Co-occupant inputs must not be crammed into a narrow 12-column single row'
  );
  assert.match(
    src,
    /data-testid="inline-occupant-card"[\s\S]{0,1500}sm:grid-cols-2\s+gap-4/,
    'Co-occupant card must arrange fields in a spacious 2-column grid with gap-4'
  );
});

test('Remaining Fixes UI 1: contracts.service.js exports createIdempotencyKey and sends Idempotency-Key on write transitions', () => {
  const src = readSrc('services/contracts.service.js');
  assert.match(src, /export\s+function\s+createIdempotencyKey/, 'Must export createIdempotencyKey');
  assert.match(src, /['"]Idempotency-Key['"]/, 'Must attach Idempotency-Key header');
  for (const methodName of ['create', 'activate', 'approve', 'renew', 'terminate', 'transferRoom']) {
    assert.match(
      src,
      new RegExp(`${methodName}\\s*:\\s*\\([^)]*options`),
      `contractsService.${methodName} must accept options for idempotencyKey`
    );
  }
});

test('Remaining Fixes UI 2: ContractsPage supports inline CCCD front/back FileUpload, service subscription note, reservation hold hint, and createIdemKeyRef', () => {
  const src = readSrc('pages/admin/contracts/ContractsPage.jsx');
  assert.match(src, /id_image_front/, 'ContractsPage must support id_image_front for new_tenant');
  assert.match(src, /id_image_back/, 'ContractsPage must support id_image_back for new_tenant');
  assert.match(src, /FileUpload/, 'ContractsPage must render FileUpload for inline CCCD images');
  assert.match(src, /maxSizeMB=\{5\}/, 'Inline CCCD FileUpload must enforce maxSizeMB={5}');
  assert.match(src, /createIdemKeyRef/, 'ContractsPage must keep stable createIdemKeyRef per attempt');
  assert.match(
    src,
    /servicesPayload[\s\S]{0,900}note\s*:/,
    'ContractsPage servicesPayload must include service note (e.g., vehicle license plate)'
  );
  assert.match(
    src,
    /selectedReservation[\s\S]{0,1200}hold_amount|hold_amount[\s\S]{0,1200}deposit_amount/,
    'ContractsPage must display reservation hold_amount hint when reservation_id is selected'
  );
});

test('Remaining Fixes UI 3: ContractDetailPage renders service subscription note column and allows editing draft services & meter overrides', () => {
  const src = readSrc('pages/admin/contracts/ContractDetailPage.jsx');
  assert.match(
    src,
    /title="Dịch vụ đi kèm theo hợp đồng"[\s\S]{0,2000}row\.note/,
    'ContractDetailPage accompanying services DataTable must render row.note'
  );
  assert.match(src, /draftSelectedServices/, 'ContractDetailPage must manage draftSelectedServices in Edit Draft modal');
  assert.match(src, /draftCustomMeterPrices/, 'ContractDetailPage must manage draftCustomMeterPrices in Edit Draft modal');
  assert.match(
    src,
    /const handleSaveDraft[\s\S]{0,3200}services\s*:[\s\S]{0,800}service_prices\s*:/,
    'handleSaveDraft must send services and service_prices to contractsService.update'
  );
  assert.match(src, /actionIdemKeyRef/, 'ContractDetailPage must maintain stable actionIdemKeyRef');
});


