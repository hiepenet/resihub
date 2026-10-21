import { test } from 'node:test';
import assert from 'node:assert';
import { refundDeadline, expiryAlertDates } from '../src/services/deadlines.js';

test('refundDeadline: chấm dứt 21/10 → cảnh báo 24/10 (+3d), due 26/10 (+5d)', () => {
  const d = refundDeadline('2026-10-21');
  assert.equal(d.warnAt, '2026-10-24');
  assert.equal(d.dueAt, '2026-10-26');
});

test('refundDeadline: xử lý chuyển tháng (30/10)', () => {
  const d = refundDeadline('2026-10-30');
  assert.equal(d.warnAt, '2026-11-02');
  assert.equal(d.dueAt, '2026-11-04');
});

test('expiryAlertDates: còn 30 ngày → ["30"]; còn 90 ngày → []', () => {
  const today = '2026-10-21';
  assert.deepEqual(expiryAlertDates('2026-11-20', today), ['30']);
  assert.deepEqual(expiryAlertDates('2027-01-19', today), []);
});
