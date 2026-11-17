import 'dart:math' as math;
import 'billing_helpers.dart' show roundVND;
import 'date_range.dart' show toDateOnlyStr;

export 'billing_helpers.dart' show resolveSettlementPayoutSummary, SettlementPayoutSummary;
export 'idempotency.dart' show canCollectAdditionalDeposit;

const int kDayMs = 24 * 60 * 60 * 1000;

const Map<String, dynamic> kDefaultReservationCancelPolicy = {
  'max_hold_days': 30,
  'public_max_hold_days': 7,
  'full_refund_before_days': 3,
  'partial_refund_pct': 50,
  'default_hold_amount': 2000000,
};

int roundVndToThousand(dynamic amount) {
  return roundVND(amount);
}

class ReservationCancelSplitResult {
  final int refundedAmount;
  final int forfeitedAmount;

  const ReservationCancelSplitResult({
    required this.refundedAmount,
    required this.forfeitedAmount,
  });
}

/// Tính toán phân chia tiền hoàn cọc và tiền giữ chỗ bị phạt khi hủy giữ chỗ (M06 / FR-024).
ReservationCancelSplitResult computeSuggestedCancelSplit({
  dynamic holdAmount = 0,
  dynamic holdUntil,
  dynamic todayStr,
  dynamic policy,
}) {
  final num parsedHold = holdAmount is num ? holdAmount : num.tryParse(holdAmount?.toString() ?? '') ?? 0;
  final total = math.max(0, parsedHold.round());
  if (total == 0) {
    return const ReservationCancelSplitResult(refundedAmount: 0, forfeitedAmount: 0);
  }

  final pol = policy is Map ? policy : kDefaultReservationCancelPolicy;
  final rawFullDays = pol['full_refund_before_days'] ?? kDefaultReservationCancelPolicy['full_refund_before_days'];
  final rawPartialPct = pol['partial_refund_pct'] ?? kDefaultReservationCancelPolicy['partial_refund_pct'];

  final num fullDaysNum = rawFullDays is num ? rawFullDays : num.tryParse(rawFullDays.toString()) ?? 3;
  final num partialPctNum = rawPartialPct is num ? rawPartialPct : num.tryParse(rawPartialPct.toString()) ?? 50;

  final fullDays = math.max(0, fullDaysNum.toInt());
  final partialPct = math.min(100, math.max(0, partialPctNum.toInt()));

  final untilDateStr = toDateOnlyStr(holdUntil);
  final anchorDateStr = toDateOnlyStr(todayStr ?? DateTime.now());

  if (untilDateStr.isEmpty || anchorDateStr.isEmpty) {
    return ReservationCancelSplitResult(refundedAmount: 0, forfeitedAmount: total);
  }

  final untilDt = DateTime.tryParse('${untilDateStr}T00:00:00Z');
  final anchorDt = DateTime.tryParse('${anchorDateStr}T00:00:00Z');

  if (untilDt == null || anchorDt == null) {
    return ReservationCancelSplitResult(refundedAmount: 0, forfeitedAmount: total);
  }

  final daysLeft = ((untilDt.millisecondsSinceEpoch - anchorDt.millisecondsSinceEpoch) / kDayMs).round();

  if (daysLeft >= fullDays) {
    return ReservationCancelSplitResult(refundedAmount: total, forfeitedAmount: 0);
  }
  if (daysLeft < 0) {
    return ReservationCancelSplitResult(refundedAmount: 0, forfeitedAmount: total);
  }

  final rawRefunded = roundVndToThousand((total * partialPct) / 100);
  final refunded = math.min(total, math.max(0, rawRefunded));

  return ReservationCancelSplitResult(
    refundedAmount: refunded,
    forfeitedAmount: total - refunded,
  );
}

/// Kiểm tra Quản lý có thể xác nhận đã thu tiền giữ chỗ chuyển khoản không.
bool canManagerConfirmReservationPayment(dynamic reservation, {bool isManager = false}) {
  if (!isManager || reservation == null) return false;
  final st = reservation is Map ? reservation['status'] : null;
  return st == 'PENDING_CONFIRM';
}

/// Kiểm tra đơn giữ chỗ có ở trạng thái cho phép xử lý hủy/quyết toán không.
bool canSettleReservationCancel(dynamic reservation) {
  if (reservation == null || reservation is! Map) return false;
  final rawRef = reservation['refunded_amount'] ?? 0;
  final rawForf = reservation['forfeited_amount'] ?? 0;
  final num ref = rawRef is num ? rawRef : num.tryParse(rawRef.toString()) ?? 0;
  final num forf = rawForf is num ? rawForf : num.tryParse(rawForf.toString()) ?? 0;
  final settledSum = ref + forf;
  if (settledSum != 0) return false;

  final st = reservation['status']?.toString();
  if (st == 'HELD') return true;
  if (st == 'EXPIRED') {
    final src = reservation['source']?.toString();
    final hasConfirmedAt = reservation['confirmed_at'] != null;
    return src != 'PUBLIC' || hasConfirmedAt;
  }
  return false;
}

/// Kiểm tra quyền duyệt cọc 4 mắt cho đề nghị hoàn/trừ cọc (M06 / FR-024).
bool canActorApproveDepositRow({
  bool isOwner = false,
  bool isManager = false,
  bool isSysAdmin = false,
  dynamic currentUserId,
  dynamic createdBy,
  bool buildingHasActiveOwner = false,
  bool allowSelfApproval = false,
}) {
  final isCreator = createdBy != null &&
      currentUserId != null &&
      createdBy.toString() == currentUserId.toString();

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

/// Kiểm tra quyền duyệt 4 mắt cho đề nghị hoàn/phạt tiền giữ chỗ (M06).
bool canActorApproveReservationRow({
  bool isOwner = false,
  bool isManager = false,
  bool isSysAdmin = false,
  dynamic currentUserId,
  dynamic createdBy,
  bool buildingHasActiveOwner = false,
  bool allowSelfApproval = false,
}) {
  return canActorApproveDepositRow(
    isOwner: isOwner,
    isManager: isManager,
    isSysAdmin: isSysAdmin,
    currentUserId: currentUserId,
    createdBy: createdBy,
    buildingHasActiveOwner: buildingHasActiveOwner,
    allowSelfApproval: allowSelfApproval,
  );
}

/// Quản lý đề xuất hủy giữ chỗ.
bool canProposeReservationCancel(dynamic reservation, {bool isManager = false}) {
  return isManager && canSettleReservationCancel(reservation);
}

/// Duyệt đề xuất hủy giữ chỗ (kiểm tra 4 mắt).
bool canApproveReservationCancel(
  dynamic reservation, {
  bool isOwner = false,
  bool isManager = false,
  bool isSysAdmin = false,
  dynamic currentUserId,
  bool buildingHasActiveOwner = false,
  bool allowSelfApproval = false,
}) {
  if (reservation == null || reservation is! Map) return false;
  if (reservation['status'] != 'CANCEL_PENDING_APPROVAL') {
    return false;
  }
  final cancelSettlement = reservation['cancel_settlement'];
  final proposerId = (cancelSettlement is Map ? cancelSettlement['proposed_by'] : null) ??
      reservation['confirmed_by'] ??
      reservation['created_by'];

  return canActorApproveReservationRow(
    isOwner: isOwner,
    isManager: isManager,
    isSysAdmin: isSysAdmin,
    currentUserId: currentUserId,
    createdBy: proposerId,
    buildingHasActiveOwner: buildingHasActiveOwner,
    allowSelfApproval: allowSelfApproval,
  );
}

/// Kiểm tra Quản lý có thể xác nhận chi trả tiền cọc giữ chỗ không.
bool canPayoutReservationCancel(dynamic reservation, {bool isManager = false}) {
  if (!isManager || reservation == null || reservation is! Map) return false;
  final st = reservation['status']?.toString();
  final rawRefund = reservation['refunded_amount'] ?? 0;
  final num ref = rawRefund is num ? rawRefund : num.tryParse(rawRefund.toString()) ?? 0;
  return st == 'APPROVED_PENDING_PAYOUT' && ref > 0;
}

/// Cư dân có thể cập nhật tài khoản nhận hoàn tiền giữ chỗ.
bool canResidentUpdateReservationBankInfo(dynamic reservation) {
  if (reservation == null || reservation is! Map) return false;
  final st = reservation['reservation_status'] ?? reservation['status'];
  final rawRefund = reservation['refunded_amount'] ?? 0;
  final num ref = rawRefund is num ? rawRefund : num.tryParse(rawRefund.toString()) ?? 0;
  return st == 'APPROVED_PENDING_PAYOUT' && ref > 0;
}

class ResidentDisputeWindowState {
  final bool canDispute;
  final int? daysRemaining;
  final String? lockedReason;

  const ResidentDisputeWindowState({
    required this.canDispute,
    required this.daysRemaining,
    required this.lockedReason,
  });
}

/// Tính toán cửa sổ khiếu nại 7 ngày cho cư dân sau quyết toán cọc.
ResidentDisputeWindowState getResidentDisputeWindowState(dynamic deposit, [dynamic nowMs]) {
  final dep = deposit is Map ? deposit : const {};
  final status = (dep['status'] ?? dep['deposit_status'])?.toString();
  final settlement = dep['settlement'] is Map ? (dep['settlement'] as Map) : const {};

  if (settlement['post_settlement_dispute_closed'] == true) {
    return const ResidentDisputeWindowState(
      canDispute: false,
      daysRemaining: 0,
      lockedReason: 'FINALIZED',
    );
  }

  if (status == 'PENDING_APPROVAL' || status == 'APPROVED_PENDING_PAYOUT') {
    return const ResidentDisputeWindowState(
      canDispute: true,
      daysRemaining: null,
      lockedReason: null,
    );
  }

  if (status == 'PARTIALLY_REFUNDED' || status == 'REFUNDED' || status == 'DEDUCTED_FULL') {
    final anchorRaw = settlement['payout_at'] ??
        settlement['accounting_committed_at'] ??
        settlement['approved_at'] ??
        dep['updated_at'];

    if (anchorRaw == null) {
      return const ResidentDisputeWindowState(
        canDispute: true,
        daysRemaining: 7,
        lockedReason: null,
      );
    }

    final anchorDt = anchorRaw is DateTime ? anchorRaw : DateTime.tryParse(anchorRaw.toString());
    if (anchorDt == null) {
      return const ResidentDisputeWindowState(
        canDispute: true,
        daysRemaining: 7,
        lockedReason: null,
      );
    }

    final anchorEpoch = anchorDt.millisecondsSinceEpoch;
    final int currentEpoch = nowMs is DateTime
        ? nowMs.millisecondsSinceEpoch
        : (nowMs is num
            ? nowMs.toInt()
            : (nowMs != null ? (int.tryParse(nowMs.toString()) ?? DateTime.now().millisecondsSinceEpoch) : DateTime.now().millisecondsSinceEpoch));

    final deadlineEpoch = anchorEpoch + 7 * kDayMs;
    if (currentEpoch > deadlineEpoch) {
      return const ResidentDisputeWindowState(
        canDispute: false,
        daysRemaining: 0,
        lockedReason: 'EXPIRED',
      );
    }

    final daysRemaining = math.max(1, math.min(7, ((deadlineEpoch - currentEpoch) / kDayMs).ceil()));
    return ResidentDisputeWindowState(
      canDispute: true,
      daysRemaining: daysRemaining,
      lockedReason: null,
    );
  }

  return ResidentDisputeWindowState(
    canDispute: false,
    daysRemaining: null,
    lockedReason: status == 'DISPUTED' ? 'IN_PROGRESS' : 'NOT_APPLICABLE',
  );
}

/// Cư dân có thể cập nhật thông tin ngân hàng nhận hoàn cọc.
bool canResidentUpdateRefundBankInfo(dynamic deposit) {
  if (deposit == null || deposit is! Map) return false;
  final status = (deposit['status'] ?? deposit['deposit_status'])?.toString();
  final settlement = deposit['settlement'] is Map ? deposit['settlement'] : const {};
  final rawRefund = settlement['refund_amount'] ?? 0;
  final num ref = rawRefund is num ? rawRefund : num.tryParse(rawRefund.toString()) ?? 0;
  return (status == 'APPROVED_PENDING_PAYOUT' || status == 'RETURNED') && ref > 0;
}
