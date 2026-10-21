import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiff, nextStatusOnAmend } from '../src/services/amendment.js';

test('buildDiff: whitelist + old != new; ngoài whitelist / old==new → lỗi', () => {
  assert.deepEqual(
    buildDiff({ rent_amount: 8000000 }, { rent_amount: 9000000 }),
    { ok: true, diff: { rent_amount: { old: 8000000, new: 9000000 } } }
  );
  assert.equal(buildDiff({}, { banned_field: 1 }).ok, false);
  assert.equal(buildDiff({ rent_amount: 8000000 }, { rent_amount: 8000000 }).ok, false);
});

test('nextStatusOnAmend: end_date → RENEWAL_PENDING, khác → ACTIVE', () => {
  assert.equal(nextStatusOnAmend('end_date'), 'RENEWAL_PENDING');
  assert.equal(nextStatusOnAmend('rent_amount'), 'ACTIVE');
});
