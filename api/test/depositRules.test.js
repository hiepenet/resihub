import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPositiveSafeIntegerVnd,
  getTodayVnDateStr,
  validateDeduction,
  DEDUCT_CATEGORIES,
  computeRefund,
  splitDepositOpening,
  resolvePostSettlementStatus,
  validateRefundBankInfo,
  isSettlementSnapshotStale,
} from '../src/services/depositSettlement.js';

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


test('isPositiveSafeIntegerVnd, getTodayVnDateStr & validateDeduction: chặn số thập phân/boolean, chuẩn ngày giờ VN', () => {
  assert.equal(isPositiveSafeIntegerVnd(500000), true);
  assert.equal(isPositiveSafeIntegerVnd(' 1000000 '), true);
  for (const bad of [0, -100, 1000.5, '1000.5', '1e5', '', '   ', true, false, null, undefined, [1000]]) {
    assert.equal(isPositiveSafeIntegerVnd(bad), false, `Phải từ chối giá trị: ${JSON.stringify(bad)}`);
  }
  assert.equal(getTodayVnDateStr(new Date('2026-11-01T18:30:00Z')), '2026-11-02');
  assert.equal(getTodayVnDateStr('2026-11-02'), '2026-11-02');
  assert.equal(
    validateDeduction({ category: 'DAMAGE', amount: 1000.5, description: 'Lẻ xu', evidence: ['a.png'] }).code,
    'INVALID_AMOUNT'
  );
  assert.equal(
    validateDeduction({ category: 'DAMAGE', amount: true, description: 'Boolean', evidence: ['a.png'] }).code,
    'INVALID_AMOUNT'
  );
});

test('resolvePostSettlementStatus: hoàn 100% -> REFUNDED; hoàn 1 phần -> PARTIALLY_REFUNDED; trừ sạch cọc -> DEDUCTED_FULL; cọc 0 không trừ -> REFUNDED', () => {
  assert.equal(resolvePostSettlementStatus({ refundAmount: 10000000n, outstandingDebt: 0n, items: [], shortfall: 0n }), 'REFUNDED');
  assert.equal(resolvePostSettlementStatus({ refundAmount: 8000000n, outstandingDebt: 1200000n, items: [{ amount: 800000n }], shortfall: 0n }), 'PARTIALLY_REFUNDED');
  assert.equal(resolvePostSettlementStatus({ refundAmount: 0n, outstandingDebt: 0n, items: [{ amount: 5000000n }], shortfall: 0n }), 'DEDUCTED_FULL');
  assert.equal(resolvePostSettlementStatus({ refundAmount: 0n, outstandingDebt: 3000000n, items: [{ amount: 4000000n }], shortfall: 2000000n }), 'DEDUCTED_FULL');
  assert.equal(resolvePostSettlementStatus({ refundAmount: 0n, outstandingDebt: 0n, items: [], shortfall: 0n }), 'REFUNDED');
});

test('validateRefundBankInfo: bắt buộc STK hợp lệ khi refund > 0 và BANK_TRANSFER; bỏ qua khi CASH hoặc refund = 0', () => {
  assert.equal(validateRefundBankInfo({ refundAmount: 5000000, refundMethod: 'FOO', bankInfo: {} }).code, 'INVALID_REFUND_METHOD');
  assert.equal(validateRefundBankInfo({ refundAmount: 5000000, refundMethod: 'BANK_TRANSFER', bankInfo: {} }).code, 'BANK_INFO_REQUIRED');
  assert.equal(
    validateRefundBankInfo({
      refundAmount: 5000000,
      refundMethod: 'BANK_TRANSFER',
      bankInfo: { bank_name: 'VCB', account_number: ' 0011-0099 ', account_holder: 'NGUYEN VAN A' },
    }).code,
    'INVALID_ACCOUNT_NUMBER'
  );
  const okBank = validateRefundBankInfo({
    refundAmount: 5000000,
    refundMethod: 'BANK_TRANSFER',
    bankInfo: { bank_name: ' Vietcombank ', account_number: ' 001100999888 ', account_holder: ' NGUYEN VAN A ' },
  });
  assert.equal(okBank.ok, true);
  assert.equal(okBank.normalizedBankInfo.account_number, '001100999888');
  assert.equal(validateRefundBankInfo({ refundAmount: 0, refundMethod: 'BANK_TRANSFER', bankInfo: {} }).ok, true);
  assert.equal(validateRefundBankInfo({ refundAmount: 5000000, refundMethod: 'CASH', bankInfo: {} }).ok, true);
});

test('isSettlementSnapshotStale: phát hiện đổi hóa đơn mở dù tổng serviceDebt không đổi', () => {
  const saved = {
    outstanding_debt: 500000,
    rent_debt: 0,
    deposit_held_before_settlement: 5000000,
    open_invoice_snapshot: [{ id: 'inv-1', remaining: 500000, service_unpaid: 500000, rent_unpaid: 0 }],
  };
  assert.equal(
    isSettlementSnapshotStale(saved, {
      serviceDebt: 500000,
      rentDebt: 0,
      heldAmount: 5000000,
      openInvoices: [{ id: 'inv-1', remaining: 500000, service_unpaid: 500000, rent_unpaid: 0 }],
    }),
    false
  );
  assert.equal(
    isSettlementSnapshotStale(saved, {
      serviceDebt: 500000,
      rentDebt: 0,
      heldAmount: 5000000,
      openInvoices: [{ id: 'inv-2', remaining: 500000, service_unpaid: 500000, rent_unpaid: 0 }],
    }),
    true
  );
});
