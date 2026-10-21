import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeduction, DEDUCT_CATEGORIES, computeRefund, splitDepositOpening } from '../src/services/depositSettlement.js';

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

test('computeRefund khớp AC-017.1: cọc 10tr, nợ 1.2tr, hư hỏng 800k → hoàn 8tr', () => {
  assert.deepEqual(
    computeRefund({ depositAmount: 10000000n, outstandingDebt: 1200000n, items: [{ amount: 800000n }] }),
    { refund: 8000000n, shortfall: 0n }
  );
});

test('computeRefund khớp AC-017.2: tổng trừ > cọc → hoàn 0 + shortfall thành công nợ sau trả phòng', () => {
  assert.deepEqual(
    computeRefund({ depositAmount: 5000000n, outstandingDebt: 3000000n, items: [{ amount: 4000000n }] }),
    { refund: 0n, shortfall: 2000000n }
  );
});

test('outstandingDebt lớn → refund 0, shortfall đúng', () => {
  assert.deepEqual(
    computeRefund({ depositAmount: 8000000n, outstandingDebt: 10000000n, items: [] }),
    { refund: 0n, shortfall: 2000000n }
  );
});

test('splitDepositOpening: giữ chỗ 2tr, cọc HĐ 8tr → mở 2tr, cần thu bù 6tr', () => {
  assert.deepEqual(
    splitDepositOpening({ depositAmount: 8000000n, holdAmount: 2000000n }),
    { openHeld: 2000000n, remainingCollect: 6000000n }
  );
});

test('không có giữ chỗ → mở 0, cần thu cả cọc', () => {
  assert.deepEqual(
    splitDepositOpening({ depositAmount: 8000000n, holdAmount: null }),
    { openHeld: 0n, remainingCollect: 8000000n }
  );
});

test('giữ chỗ nhỏ hơn cọc HĐ tối đa → mở đúng giữ chỗ', () => {
  assert.deepEqual(
    splitDepositOpening({ depositAmount: 1500000n, holdAmount: 2000000n }),
    { openHeld: 2000000n, remainingCollect: 0n }
  );
});
