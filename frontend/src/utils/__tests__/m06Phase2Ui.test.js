import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPOSIT_STATUS } from '../../constants/statuses.js';
import {
  canActorApproveDepositRow,
  canActorApproveReservationRow,
  getResidentDisputeWindowState,
  canResidentUpdateRefundBankInfo,
} from '../depositUiHelpers.js';

test('M06 Phase 2 UI — DEPOSIT_STATUS defines APPROVED_PENDING_PAYOUT, DEDUCTED_FULL, RETURNED', () => {
  assert.equal(DEPOSIT_STATUS.APPROVED_PENDING_PAYOUT?.label, 'Đã duyệt - Chờ chi tiền');
  assert.equal(DEPOSIT_STATUS.APPROVED_PENDING_PAYOUT?.variant, 'amber');
  assert.equal(DEPOSIT_STATUS.DEDUCTED_FULL?.label, 'Đã khấu trừ hết cọc');
  assert.equal(DEPOSIT_STATUS.RETURNED?.label, 'Ngân hàng hoàn trả lệnh chi');
  assert.equal(DEPOSIT_STATUS.RETURNED?.variant, 'red');
});

test('M06 Phase 2 UI — canActorApproveDepositRow & canActorApproveReservationRow enforce PRD 6.2 + Four-Eyes', () => {
  for (const fn of [canActorApproveDepositRow, canActorApproveReservationRow]) {
    // Active OWNER (non-creator) -> true
    assert.equal(
      fn({
        isOwner: true,
        isManager: false,
        isSysAdmin: false,
        currentUserId: 'u-owner',
        createdBy: 'u-mgr1',
        buildingHasActiveOwner: true,
      }),
      true
    );

    // Second MANAGER (non-creator) -> true
    assert.equal(
      fn({
        isOwner: false,
        isManager: true,
        isSysAdmin: false,
        currentUserId: 'u-mgr2',
        createdBy: 'u-mgr1',
        buildingHasActiveOwner: true,
      }),
      true
    );

    // Creator MANAGER -> false (Four-Eyes)
    assert.equal(
      fn({
        isOwner: false,
        isManager: true,
        isSysAdmin: false,
        currentUserId: 'u-mgr1',
        createdBy: 'u-mgr1',
        buildingHasActiveOwner: true,
      }),
      false
    );

    // SYS_ADMIN when building HAS active OWNER -> false (Read-Only per PRD 6.2)
    assert.equal(
      fn({
        isOwner: false,
        isManager: false,
        isSysAdmin: true,
        currentUserId: 'u-admin',
        createdBy: 'u-mgr1',
        buildingHasActiveOwner: true,
      }),
      false
    );

    // SYS_ADMIN fallback when building has NO active OWNER -> true
    assert.equal(
      fn({
        isOwner: false,
        isManager: false,
        isSysAdmin: true,
        currentUserId: 'u-admin',
        createdBy: 'u-mgr1',
        buildingHasActiveOwner: false,
      }),
      true
    );
  }
});

test('M06 Phase 2 UI — getResidentDisputeWindowState enforces 7-day window and single-cycle lock', () => {
  const baseNow = Date.parse('2026-11-10T10:00:00.000Z');

  // Pre-payout PENDING_APPROVAL and APPROVED_PENDING_PAYOUT -> open
  assert.deepEqual(getResidentDisputeWindowState({ status: 'PENDING_APPROVAL', settlement: {} }, baseNow), {
    canDispute: true,
    daysRemaining: null,
    lockedReason: null,
  });
  assert.deepEqual(getResidentDisputeWindowState({ status: 'APPROVED_PENDING_PAYOUT', settlement: {} }, baseNow), {
    canDispute: true,
    daysRemaining: null,
    lockedReason: null,
  });

  // Post-payout within 7 days (2 days elapsed -> 5 days remaining)
  const twoDaysAgo = new Date(baseNow - 2 * 24 * 60 * 60 * 1000).toISOString();
  const withinWindow = getResidentDisputeWindowState(
    {
      status: 'PARTIALLY_REFUNDED',
      settlement: { payout_at: twoDaysAgo, accounting_committed_at: twoDaysAgo },
    },
    baseNow
  );
  assert.equal(withinWindow.canDispute, true);
  assert.ok(withinWindow.daysRemaining >= 1 && withinWindow.daysRemaining <= 7);
  assert.equal(withinWindow.lockedReason, null);

  // Post-payout > 7 days -> EXPIRED
  const eightDaysAgo = new Date(baseNow - 8 * 24 * 60 * 60 * 1000).toISOString();
  const expiredWindow = getResidentDisputeWindowState(
    {
      status: 'PARTIALLY_REFUNDED',
      settlement: { payout_at: eightDaysAgo, accounting_committed_at: eightDaysAgo },
    },
    baseNow
  );
  assert.equal(expiredWindow.canDispute, false);
  assert.equal(expiredWindow.lockedReason, 'EXPIRED');

  // Post-payout single-cycle closed -> FINALIZED even after 1 day
  const oneDayAgo = new Date(baseNow - 1 * 24 * 60 * 60 * 1000).toISOString();
  const finalized = getResidentDisputeWindowState(
    {
      status: 'PARTIALLY_REFUNDED',
      settlement: {
        payout_at: oneDayAgo,
        accounting_committed_at: oneDayAgo,
        post_settlement_dispute_closed: true,
      },
    },
    baseNow
  );
  assert.equal(finalized.canDispute, false);
  assert.equal(finalized.lockedReason, 'FINALIZED');
});

test('M06 Phase 2 UI — canResidentUpdateRefundBankInfo', () => {
  assert.equal(
    canResidentUpdateRefundBankInfo({
      status: 'APPROVED_PENDING_PAYOUT',
      settlement: { refund_amount: 5000000 },
    }),
    true
  );
  assert.equal(
    canResidentUpdateRefundBankInfo({
      status: 'RETURNED',
      settlement: { refund_amount: 5000000 },
    }),
    true
  );
  assert.equal(
    canResidentUpdateRefundBankInfo({
      status: 'APPROVED_PENDING_PAYOUT',
      settlement: { refund_amount: 0 },
    }),
    false
  );
  assert.equal(
    canResidentUpdateRefundBankInfo({
      status: 'PARTIALLY_REFUNDED',
      settlement: { refund_amount: 5000000 },
    }),
    false
  );
});
