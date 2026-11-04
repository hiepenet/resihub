import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = path.resolve(__dirname, '../../frontend/src');

test('Modal.jsx preserves non-zero bottom padding on desktop and additive safe-area inset on mobile', () => {
  const cssSrc = fs.readFileSync(path.join(FRONTEND_SRC, 'index.css'), 'utf8');
  assert.ok(
    cssSrc.includes('.pb-safe'),
    'index.css must retain .pb-safe for mobile navigation bars'
  );
  assert.match(
    cssSrc,
    /\.pb-modal-body-safe\s*\{[^}]*calc\(\s*1\.25rem\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\s*\)/,
    'index.css must define .pb-modal-body-safe with valid spaced CSS calc() + safe-area inset'
  );
  assert.match(
    cssSrc,
    /\.pb-modal-footer-safe\s*\{[^}]*calc\(\s*1rem\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\s*\)/,
    'index.css must define .pb-modal-footer-safe with valid spaced CSS calc() + safe-area inset'
  );

  const modalSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'components/ui/Modal.jsx'),
    'utf8'
  );
  assert.equal(
    /\bpb-safe\b/.test(modalSrc),
    false,
    'Modal.jsx must not use .pb-safe directly because it overwrites py-*/p-* bottom padding to 0px on desktop'
  );

  const footerSafeMatches = modalSrc.match(/pb-modal-footer-safe/g) || [];
  assert.equal(
    footerSafeMatches.length,
    2,
    'Both drawer and center Modal footers must use pb-modal-footer-safe'
  );

  const bodySafeMatches = modalSrc.match(/pb-modal-body-safe/g) || [];
  assert.equal(
    bodySafeMatches.length,
    2,
    'Both drawer and center Modal bodies (when no footer is passed) must use pb-modal-body-safe'
  );
});

test('Select.jsx enforces single-line truncated labels, uniform desktop control height, and smart dropdown width', () => {
  const selectSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'components/ui/Select.jsx'),
    'utf8'
  );

  assert.equal(
    selectSrc.includes('break-words'),
    false,
    'Select.jsx must not allow trigger or option labels to wrap onto multiple lines via break-words'
  );
  assert.ok(
    selectSrc.includes('truncate whitespace-nowrap'),
    'Select.jsx must enforce single-line truncation with truncate whitespace-nowrap'
  );
  assert.ok(
    selectSrc.includes('sm:h-8') && selectSrc.includes('sm:h-9'),
    'Select.jsx must enforce uniform desktop heights (sm:h-8 and sm:h-9) matching Input and SearchBar'
  );
  assert.ok(
    selectSrc.includes('longestPrimaryLen'),
    'Select.jsx must compute dropdown portal width dynamically from option label length'
  );
});

test('Filter toolbars avoid cramped 5-6 column grids and raw native <select> elements', () => {
  const meterSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/admin/meters/MeterReadingsPage.jsx'),
    'utf8'
  );
  assert.equal(
    meterSrc.includes('lg:grid-cols-6'),
    false,
    'MeterReadingsPage filter bar must not cram 6 controls into lg:grid-cols-6'
  );
  assert.ok(
    meterSrc.includes('xl:grid-cols-4'),
    'MeterReadingsPage filter dropdown row must allocate spacious xl:grid-cols-4 columns'
  );
  assert.match(
    meterSrc,
    /whitespace-nowrap[^>]*>\s*<input[\s\S]{0,350}Chỉ hiện bất thường/,
    'MeterReadingsPage abnormalOnly pill label must prevent multi-line wrapping with whitespace-nowrap'
  );

  const invoicesSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/admin/invoices/InvoicesPage.jsx'),
    'utf8'
  );
  assert.equal(
    invoicesSrc.includes('lg:grid-cols-5'),
    false,
    'InvoicesPage filter bar must not squeeze month input and status Select into lg:grid-cols-5'
  );

  const maintenanceSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/admin/maintenance/ServiceRequestsPage.jsx'),
    'utf8'
  );
  assert.equal(
    maintenanceSrc.includes('lg:grid-cols-5'),
    false,
    'ServiceRequestsPage filter bar must not squeeze 3 Select controls into lg:grid-cols-5'
  );

  const auditSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/admin/audit/AuditLogsPage.jsx'),
    'utf8'
  );
  assert.equal(
    /(?<![0-9])xl:grid-cols-6/.test(auditSrc),
    false,
    'AuditLogsPage filter bar must not squeeze entity/action Selects and dates into xl:grid-cols-6'
  );
  assert.equal(
    /<select\b/.test(auditSrc),
    false,
    'AuditLogsPage must use the design-system <Select> component instead of a raw native <select>'
  );
});
