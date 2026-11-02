/**
 * Pure UI permission & state helpers for M06 Deposits & Reservations (PRD 6.2, 10.3, FR-024, R-12, NFR-016)
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RESERVATION_CANCEL_POLICY = {
  max_hold_days: 30,
  public_max_hold_days: 7,
  full_refund_before_days: 3,
  partial_refund_pct: 50,
  default_hold_amount: 2000000,
};

export function roundVndToThousand(amount) {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / 1000) * 1000;
}

export function computeSuggestedCancelSplit({
  holdAmount = 0,
  holdUntil,
  todayStr,
  policy = DEFAULT_RESERVATION_CANCEL_POLICY,
} = {}) {
  const total = Math.max(0, Math.round(Number(holdAmount || 0)));
  if (total === 0) {
    return { refunded_amount: 0, forfeited_amount: 0 };
  }

  const fullDays = Math.max(
    0,
    Number(
      policy?.full_refund_before_days ??
        DEFAULT_RESERVATION_CANCEL_POLICY.full_refund_before_days
    )
  );
  const partialPct = Math.min(
    100,
    Math.max(
      0,
      Number(policy?.partial_refund_pct ?? DEFAULT_RESERVATION_CANCEL_POLICY.partial_refund_pct)
    )
  );

  const untilDateStr = String(holdUntil || '').slice(0, 10);
  const anchorDateStr = String(todayStr || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const untilMs = Date.parse(`${untilDateStr}T00:00:00Z`);
  const anchorMs = Date.parse(`${anchorDateStr}T00:00:00Z`);

  if (!Number.isFinite(untilMs) || !Number.isFinite(anchorMs)) {
    return { refunded_amount: 0, forfeited_amount: total };
  }

  const daysLeft = Math.round((untilMs - anchorMs) / DAY_MS);
  if (daysLeft >= fullDays) {
    return { refunded_amount: total, forfeited_amount: 0 };
  }
  if (daysLeft < 0) {
    return { refunded_amount: 0, forfeited_amount: total };
  }

  const refunded = Math.min(
    total,
    Math.max(0, roundVndToThousand((total * partialPct) / 100))
  );
  return {
    refunded_amount: refunded,
    forfeited_amount: total - refunded,
  };
}

export function canManagerConfirmReservationPayment(reservation, { isManager = false } = {}) {
  return Boolean(isManager && reservation?.status === 'PENDING_CONFIRM');
}

export function canSettleReservationCancel(reservation) {
  if (!reservation) return false;
  const settledSum =
    Number(reservation.refunded_amount || 0) + Number(reservation.forfeited_amount || 0);
  if (settledSum !== 0) return false;
  if (reservation.status === 'HELD') return true;
  if (reservation.status === 'EXPIRED') {
    return reservation.source !== 'PUBLIC' || Boolean(reservation.confirmed_at);
  }
  return false;
}

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
