/**
 * Pure UI permission & state helpers for M06 Deposits & Reservations (PRD 6.2, FR-024, R-12, NFR-016)
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function canActorApproveDepositRow({
  isOwner = false,
  isManager = false,
  isSysAdmin = false,
  currentUserId = null,
  createdBy = null,
  buildingHasActiveOwner = false,
  allowSelfApproval = false,
} = {}) {
  const isCreator = Boolean(
    createdBy && currentUserId && String(createdBy) === String(currentUserId)
  );
  if (isCreator && !allowSelfApproval) {
    return false;
  }
  if (isOwner || isManager) {
    return true;
  }
  if (isSysAdmin) {
    return !buildingHasActiveOwner;
  }
  return false;
}

export function canActorApproveReservationRow({
  isOwner = false,
  isManager = false,
  isSysAdmin = false,
  currentUserId = null,
  createdBy = null,
  buildingHasActiveOwner = false,
  allowSelfApproval = false,
} = {}) {
  const isCreator = Boolean(
    createdBy && currentUserId && String(createdBy) === String(currentUserId)
  );
  if (isCreator && !allowSelfApproval) {
    return false;
  }
  if (isOwner || isManager) {
    return true;
  }
  if (isSysAdmin) {
    return !buildingHasActiveOwner;
  }
  return false;
}

export function getResidentDisputeWindowState(deposit, nowMs = Date.now()) {
  const status = deposit?.status || deposit?.deposit_status || null;
  const settlement = deposit?.settlement || {};

  if (settlement?.post_settlement_dispute_closed === true) {
    return {
      canDispute: false,
      daysRemaining: 0,
      lockedReason: 'FINALIZED',
    };
  }

  if (['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT'].includes(status)) {
    return {
      canDispute: true,
      daysRemaining: null,
      lockedReason: null,
    };
  }

  if (['PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL'].includes(status)) {
    const anchorRaw =
      settlement?.payout_at ||
      settlement?.accounting_committed_at ||
      settlement?.approved_at ||
      deposit?.updated_at ||
      null;
    if (!anchorRaw) {
      return {
        canDispute: true,
        daysRemaining: 7,
        lockedReason: null,
      };
    }
    const anchorMs = Date.parse(anchorRaw);
    if (!Number.isFinite(anchorMs)) {
      return {
        canDispute: true,
        daysRemaining: 7,
        lockedReason: null,
      };
    }
    const deadlineMs = anchorMs + 7 * DAY_MS;
    if (nowMs > deadlineMs) {
      return {
        canDispute: false,
        daysRemaining: 0,
        lockedReason: 'EXPIRED',
      };
    }
    const daysRemaining = Math.max(1, Math.min(7, Math.ceil((deadlineMs - nowMs) / DAY_MS)));
    return {
      canDispute: true,
      daysRemaining,
      lockedReason: null,
    };
  }

  return {
    canDispute: false,
    daysRemaining: null,
    lockedReason: status === 'DISPUTED' ? 'IN_PROGRESS' : 'NOT_APPLICABLE',
  };
}

export function canResidentUpdateRefundBankInfo(deposit) {
  const status = deposit?.status || deposit?.deposit_status || null;
  const refundAmt = Number(deposit?.settlement?.refund_amount ?? 0);
  return ['APPROVED_PENDING_PAYOUT', 'RETURNED'].includes(status) && refundAmt > 0;
}
