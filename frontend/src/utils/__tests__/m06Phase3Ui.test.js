import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESERVATION_STATUS } from '../../constants/statuses.js';
import {
  computeSuggestedCancelSplit,
  canSettleReservationCancel,
  canManagerConfirmReservationPayment,
} from '../depositUiHelpers.js';

test('M06 Phase 3 UI — RESERVATION_STATUS defines PENDING_CONFIRM, PARTIALLY_REFUNDED, REJECTED', () => {
  assert.deepEqual(RESERVATION_STATUS.PENDING_CONFIRM, {
    label: 'Chờ xác nhận chuyển khoản',
    variant: 'amber',
  });
  assert.deepEqual(RESERVATION_STATUS.PARTIALLY_REFUNDED, {
    label: 'Hoàn một phần',
    variant: 'amber',
  });
  assert.deepEqual(RESERVATION_STATUS.REJECTED, {
    label: 'Từ chối xác nhận',
    variant: 'red',
  });
});

test('M06 Phase 3 UI — computeSuggestedCancelSplit rounds to nearest 1,000 VND (PRD 10.3)', () => {
  const defaultPolicy = {
    full_refund_before_days: 3,
    partial_refund_pct: 50,
  };

  // >= 3 days left -> 100% refund
  assert.deepEqual(
    computeSuggestedCancelSplit({
      holdAmount: 2_000_000,
      holdUntil: '2026-11-10',
      todayStr: '2026-11-06',
      policy: defaultPolicy,
    }),
    { refunded_amount: 2_000_000, forfeited_amount: 0 }
  );

  // 1 day left with 2_000_000 & 50% -> 1_000_000 / 1_000_000
  assert.deepEqual(
    computeSuggestedCancelSplit({
      holdAmount: 2_000_000,
      holdUntil: '2026-11-07',
      todayStr: '2026-11-06',
      policy: defaultPolicy,
    }),
    { refunded_amount: 1_000_000, forfeited_amount: 1_000_000 }
  );

  // 1 day left with 1_050_000 & 33% -> raw 346,500 -> rounded 347,000 / forfeited 703,000 (sum === 1_050_000)
  const oddSplit = computeSuggestedCancelSplit({
    holdAmount: 1_050_000,
    holdUntil: '2026-11-07',
    todayStr: '2026-11-06',
    policy: { full_refund_before_days: 3, partial_refund_pct: 33 },
  });
  assert.deepEqual(oddSplit, {
    refunded_amount: 347_000,
    forfeited_amount: 703_000,
  });
  assert.equal(oddSplit.refunded_amount + oddSplit.forfeited_amount, 1_050_000);

  // Overdue (< 0 days left) -> 0 refund, 100% forfeited
  assert.deepEqual(
    computeSuggestedCancelSplit({
      holdAmount: 2_000_000,
      holdUntil: '2026-11-05',
      todayStr: '2026-11-06',
      policy: defaultPolicy,
    }),
    { refunded_amount: 0, forfeited_amount: 2_000_000 }
  );
});

test('M06 Phase 3 UI — canSettleReservationCancel enforces settleable states and blocks unconfirmed/settled rows', () => {
  // HELD unsettled -> true
  assert.equal(
    canSettleReservationCancel({
      status: 'HELD',
      source: 'PUBLIC',
      confirmed_at: '2026-11-02T10:00:00Z',
      refunded_amount: 0,
      forfeited_amount: 0,
    }),
    true
  );

  // EXPIRED internal unsettled -> true
  assert.equal(
    canSettleReservationCancel({
      status: 'EXPIRED',
      source: 'INTERNAL',
      confirmed_at: null,
      refunded_amount: 0,
      forfeited_amount: 0,
    }),
    true
  );

  // EXPIRED public WITH confirmed_at unsettled -> true
  assert.equal(
    canSettleReservationCancel({
      status: 'EXPIRED',
      source: 'PUBLIC',
      confirmed_at: '2026-11-01T10:00:00Z',
      refunded_amount: 0,
      forfeited_amount: 0,
    }),
    true
  );

  // EXPIRED public WITHOUT confirmed_at -> false
  assert.equal(
    canSettleReservationCancel({
      status: 'EXPIRED',
      source: 'PUBLIC',
      confirmed_at: null,
      refunded_amount: 0,
      forfeited_amount: 0,
    }),
    false
  );

  //EXPIRED already settled -> false
  assert.equal(
    canSettleReservationCancel({
      status: 'EXPIRED',
      source: 'INTERNAL',
      confirmed_at: '2026-11-01T10:00:00Z',
      refunded_amount: 0,
      forfeited_amount: 2_000_000,
    }),
    false
  );

  // Non-settleable statuses -> false
  for (const st of [
    'PENDING_CONFIRM',
    'CANCEL_PENDING_APPROVAL',
    'APPROVED_PENDING_PAYOUT',
    'REJECTED',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'FORFEITED',
    'CONVERTED',
  ]) {
    assert.equal(
      canSettleReservationCancel({
        status: st,
        source: 'PUBLIC',
        confirmed_at: '2026-11-01T10:00:00Z',
        refunded_amount: 0,
        forfeited_amount: 0,
      }),
      false,
      `Expected false for status ${st}`
    );
  }
});

test('M06 Phase 3 UI — canManagerConfirmReservationPayment only allows MANAGER on PENDING_CONFIRM', () => {
  assert.equal(
    canManagerConfirmReservationPayment({ status: 'PENDING_CONFIRM' }, { isManager: true }),
    true
  );
  assert.equal(
    canManagerConfirmReservationPayment({ status: 'PENDING_CONFIRM' }, { isManager: false }),
    false
  );
  assert.equal(
    canManagerConfirmReservationPayment({ status: 'HELD' }, { isManager: true }),
    false
  );
  assert.equal(
    canManagerConfirmReservationPayment({ status: 'REJECTED' }, { isManager: true }),
    false
  );
});
