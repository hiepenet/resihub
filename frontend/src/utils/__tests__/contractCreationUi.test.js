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
