import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeduction, DEDUCT_CATEGORIES } from '../src/services/depositSettlement.js';

test('validateDeduction: cấn trừ bằng mọi cách đặt tên đều chặn', () => {
  for (const desc of ['tiền nhà tháng 9', 'nợ tiền phòng tháng 8', 'thuê nhà nợ', 'tiền thuê tháng 9']) {
    assert.equal(validateDeduction({ category: 'RENT', amount: 1000, description: desc, evidence: ['a.png'] }).ok, false);
  }
});

test('validateDeduction: khấu trừ hư hỏng có chứng từ hợp lệ', () => {
  assert.deepEqual(validateDeduction({ category: 'DAMAGE', amount: 300000, description: 'Sơn lại tường', evidence: ['anh1.png'] }), { ok: true });
});

test('validateDeduction: thiếu category / category lạ / thiếu evidence / amount <= 0 → chặn', () => {
  assert.equal(validateDeduction({ amount: 100, description: 'x', evidence: ['a'] }).ok, false);
  assert.equal(validateDeduction({ category: 'FOO', amount: 100, description: 'x', evidence: ['a'] }).ok, false);
  assert.equal(validateDeduction({ category: 'DAMAGE', amount: 100, description: 'x', evidence: [] }).ok, false);
  assert.equal(validateDeduction({ category: 'DAMAGE', amount: 0, description: 'x', evidence: ['a'] }).ok, false);
  assert.equal(validateDeduction({ category: 'DAMAGE', amount: -50, description: 'x', evidence: ['a'] }).ok, false);
  assert.equal(validateDeduction({ category: 'DAMAGE', amount: 100, description: '', evidence: ['a'] }).ok, false);
  assert.equal(validateDeduction(null).ok, false);
});
