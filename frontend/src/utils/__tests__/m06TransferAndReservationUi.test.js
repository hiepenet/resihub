import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESERVATION_STATUS } from '../../constants/statuses.js';
import {
  canProposeReservationCancel,
  canApproveReservationCancel,
  canPayoutReservationCancel,
  canResidentUpdateReservationBankInfo,
} from '../depositUiHelpers.js';

test('M06 Task 5 UI — RESERVATION_STATUS defines CANCEL_PENDING_APPROVAL (amber) and APPROVED_PENDING_PAYOUT (sky)', () => {
  assert.deepEqual(RESERVATION_STATUS.CANCEL_PENDING_APPROVAL, {
    label: 'Chờ duyệt hủy giữ chỗ',
    variant: 'amber',
  });
  assert.deepEqual(RESERVATION_STATUS.APPROVED_PENDING_PAYOUT, {
    label: 'Chờ chi hoàn giữ chỗ',
    variant: 'sky',
  });
});

test('M06 Task 5 UI — canProposeReservationCancel only allows MANAGER on settleable HELD/EXPIRED rows', () => {
  const heldRow = {
    status: 'HELD',
    source: 'INTERNAL',
    refunded_amount: 0,
    forfeited_amount: 0,
  };
  const expiredConfirmedPublic = {
    status: 'EXPIRED',
    source: 'PUBLIC',
    confirmed_at: '2026-11-01T10:00:00Z',
    refunded_amount: 0,
    forfeited_amount: 0,
  };

  assert.equal(canProposeReservationCancel(heldRow, { isManager: true }), true);
  assert.equal(canProposeReservationCancel(expiredConfirmedPublic, { isManager: true }), true);
  assert.equal(canProposeReservationCancel(heldRow, { isManager: false }), false);

  for (const st of [
    'PENDING_CONFIRM',
    'CANCEL_PENDING_APPROVAL',
    'APPROVED_PENDING_PAYOUT',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'FORFEITED',
    'REJECTED',
    'CONVERTED',
  ]) {
    assert.equal(
      canProposeReservationCancel({ ...heldRow, status: st }, { isManager: true }),
      false,
      `Expected false for status ${st}`
    );
  }
});

test('M06 Task 5 UI — canApproveReservationCancel enforces CANCEL_PENDING_APPROVAL, Four-Eyes & fallback SYS_ADMIN', () => {
  const pendingRow = {
    status: 'CANCEL_PENDING_APPROVAL',
    created_by: 'mgr-1',
    confirmed_by: 'mgr-1',
    cancel_settlement: {
      proposed_by: 'mgr-1',
    },
  };

  // OWNER on owned building -> true
  assert.equal(
    canApproveReservationCancel(pendingRow, {
      isOwner: true,
      currentUserId: 'owner-1',
      buildingHasActiveOwner: true,
    }),
    true
  );

  // Proposer MANAGER self-approval -> false unless allowSelfApproval: true
  assert.equal(
    canApproveReservationCancel(pendingRow, {
      isManager: true,
      currentUserId: 'mgr-1',
      buildingHasActiveOwner: true,
      allowSelfApproval: false,
    }),
    false
  );
  assert.equal(
    canApproveReservationCancel(pendingRow, {
      isManager: true,
      currentUserId: 'mgr-1',
      buildingHasActiveOwner: true,
      allowSelfApproval: true,
    }),
    true
  );

  // Peer MANAGER (mgr-2 !== mgr-1) -> true
  assert.equal(
    canApproveReservationCancel(pendingRow, {
      isManager: true,
      currentUserId: 'mgr-2',
      buildingHasActiveOwner: true,
    }),
    true
  );

  // SYS_ADMIN blocked on owned building, allowed as fallback on unowned building
  assert.equal(
    canApproveReservationCancel(pendingRow, {
      isSysAdmin: true,
      currentUserId: 'admin-1',
      buildingHasActiveOwner: true,
    }),
    false
  );
  assert.equal(
    canApproveReservationCancel(pendingRow, {
      isSysAdmin: true,
      currentUserId: 'admin-1',
      buildingHasActiveOwner: false,
    }),
    true
  );

  // Non-pending statuses -> false
  assert.equal(
    canApproveReservationCancel(
      { ...pendingRow, status: 'HELD' },
      { isOwner: true, currentUserId: 'owner-1', buildingHasActiveOwner: true }
    ),
    false
  );
});

test('M06 Task 5 UI — canPayoutReservationCancel only allows MANAGER on APPROVED_PENDING_PAYOUT with refunded_amount > 0', () => {
  assert.equal(
    canPayoutReservationCancel(
      { status: 'APPROVED_PENDING_PAYOUT', refunded_amount: 1_200_000 },
      { isManager: true }
    ),
    true
  );
  // OWNER is strictly blocked from payout
  assert.equal(
    canPayoutReservationCancel(
      { status: 'APPROVED_PENDING_PAYOUT', refunded_amount: 1_200_000 },
      { isManager: false }
    ),
    false
  );
  assert.equal(
    canPayoutReservationCancel(
      { status: 'APPROVED_PENDING_PAYOUT', refunded_amount: 0 },
      { isManager: true }
    ),
    false
  );
  assert.equal(
    canPayoutReservationCancel(
      { status: 'CANCEL_PENDING_APPROVAL', refunded_amount: 1_200_000 },
      { isManager: true }
    ),
    false
  );
});

test('M06 Task 5 UI — canResidentUpdateReservationBankInfo checks status/reservation_status === APPROVED_PENDING_PAYOUT and refunded_amount > 0', () => {
  assert.equal(
    canResidentUpdateReservationBankInfo({
      reservation_status: 'APPROVED_PENDING_PAYOUT',
      refunded_amount: 1_500_000,
    }),
    true
  );
  assert.equal(
    canResidentUpdateReservationBankInfo({
      status: 'APPROVED_PENDING_PAYOUT',
      refunded_amount: '2000000',
    }),
    true
  );
  assert.equal(
    canResidentUpdateReservationBankInfo({
      reservation_status: 'CANCEL_PENDING_APPROVAL',
      refunded_amount: 1_500_000,
    }),
    false
  );
  assert.equal(
    canResidentUpdateReservationBankInfo({
      reservation_status: 'APPROVED_PENDING_PAYOUT',
      refunded_amount: 0,
    }),
    false
  );
});
