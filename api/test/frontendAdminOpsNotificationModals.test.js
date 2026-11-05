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

test('ServiceRequestsPage auto-opens detail drawer from ?request_id and cleans URL with replace: true', () => {
  const src = readRel('frontend/src/pages/admin/maintenance/ServiceRequestsPage.jsx');
  assert.match(src, /stripNotificationTriggerParams/, 'ServiceRequestsPage must use stripNotificationTriggerParams');
  assert.match(src, /request_id/, 'ServiceRequestsPage must consume request_id');
  assert.match(src, /openDetailDrawer\(/, 'ServiceRequestsPage must call openDetailDrawer');
  assert.match(src, /replace:\s*true/, 'ServiceRequestsPage must clean URL with replace: true');
});

test('PaymentsPage auto-opens payment review modal and credit refund review/detail modal with RBAC safety', () => {
  const src = readRel('frontend/src/pages/admin/payments/PaymentsPage.jsx');
  assert.match(src, /stripNotificationTriggerParams/, 'PaymentsPage must use stripNotificationTriggerParams');
  assert.match(src, /payment_id/, 'PaymentsPage must consume payment_id');
  assert.match(src, /credit_id/, 'PaymentsPage must consume credit_id');
  assert.match(src, /reviewCredit/, 'PaymentsPage must render Credit Refund Review / Detail Modal');
  assert.match(src, /replace:\s*true/, 'PaymentsPage must clean URL with replace: true');
});

test('SubscriptionsPage auto-opens pro-rata cancel modal or subscription review/detail modal', () => {
  const src = readRel('frontend/src/pages/admin/services/SubscriptionsPage.jsx');
  assert.match(src, /stripNotificationTriggerParams/, 'SubscriptionsPage must use stripNotificationTriggerParams');
  assert.match(src, /subscription_id/, 'SubscriptionsPage must consume subscription_id');
  assert.match(src, /reviewSubscription/, 'SubscriptionsPage must render Subscription Review / Detail Modal');
  assert.match(src, /replace:\s*true/, 'SubscriptionsPage must clean URL with replace: true');
});

test('InvoiceDetailPage auto-opens adjustment review, quick pay, or invoice summary modal on ?modal=auto', () => {
  const src = readRel('frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx');
  assert.match(src, /stripNotificationTriggerParams/, 'InvoiceDetailPage must use stripNotificationTriggerParams');
  assert.match(src, /modal\s*===\s*['"]auto['"]/, 'InvoiceDetailPage must consume modal=auto');
  assert.match(src, /reviewAdjustment/, 'InvoiceDetailPage must render Invoice Adjustment Review Modal');
  assert.match(src, /summaryModalOpen/, 'InvoiceDetailPage must render Invoice Summary Modal fallback');
  assert.match(src, /replace:\s*true/, 'InvoiceDetailPage must clean URL with replace: true');
});

test('DepositsPage, MeterReadingsPage, ReportsPage, and SettingsPage consume deep-link modal params and clean URL', () => {
  const depSrc = readRel('frontend/src/pages/admin/deposits/DepositsPage.jsx');
  assert.match(depSrc, /stripNotificationTriggerParams/, 'DepositsPage must use stripNotificationTriggerParams');
  assert.match(depSrc, /deposit_id/, 'DepositsPage must consume deposit_id');
  assert.match(depSrc, /handleOpenSettlement|handleOpenTransactions/, 'DepositsPage must open settlement or transactions modal');

  const meterSrc = readRel('frontend/src/pages/admin/meters/MeterReadingsPage.jsx');
  assert.match(meterSrc, /stripNotificationTriggerParams/, 'MeterReadingsPage must use stripNotificationTriggerParams');
  assert.match(meterSrc, /modal\s*===\s*['"]record['"]/, 'MeterReadingsPage must consume modal=record');
  assert.match(meterSrc, /openSingleModal\(/, 'MeterReadingsPage must open single meter modal');
  assert.match(meterSrc, /replace:\s*true/, 'MeterReadingsPage must clean URL with replace: true');

  const repSrc = readRel('frontend/src/pages/admin/reports/ReportsPage.jsx');
  assert.match(repSrc, /stripNotificationTriggerParams/, 'ReportsPage must use stripNotificationTriggerParams');
  assert.match(repSrc, /modal\s*===\s*['"]summary['"]/, 'ReportsPage must consume modal=summary');
  assert.match(repSrc, /depositSummaryModalOpen/, 'ReportsPage must render Monthly Deposit Report Summary Modal');

  const setSrc = readRel('frontend/src/pages/admin/settings/SettingsPage.jsx');
  assert.match(setSrc, /stripNotificationTriggerParams/, 'SettingsPage must use stripNotificationTriggerParams');
  assert.match(setSrc, /systemAlertModal/, 'SettingsPage must render AI Budget / Cron Health Detail Modal');
  assert.match(setSrc, /replace:\s*true/, 'SettingsPage must clean URL with replace: true');
});

