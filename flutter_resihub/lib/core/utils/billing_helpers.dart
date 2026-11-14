import 'dart:math' as math;
import 'package:intl/intl.dart';

export 'idempotency.dart' show createIdempotencyKey, withIdempotency;

/// Làm tròn số tiền VND đến hàng nghìn gần nhất — ROUND(x, -3) (PRD Mục 10.3 / Ruling 3).
/// Ví dụ: 123456 -> 123000; 123500 -> 124000; -123600 -> -124000
int roundVND(dynamic amount) {
  if (amount == null) return 0;
  final num? numVal = amount is num ? amount : num.tryParse(amount.toString());
  if (numVal == null || numVal.isNaN || numVal.isInfinite || numVal == 0) return 0;
  final sign = numVal < 0 ? -1 : 1;
  final absNum = numVal.abs();
  return sign * ((absNum / 1000).round() * 1000);
}

/// Lấy ngày hôm nay theo múi giờ 'Asia/Ho_Chi_Minh' (UTC+7) dạng 'YYYY-MM-DD' (PRD 13.4).
String todayVietnamYmd([dynamic now]) {
  DateTime dt;
  if (now == null) {
    dt = DateTime.now().toUtc().add(const Duration(hours: 7));
  } else if (now is DateTime) {
    dt = now.isUtc
        ? now.add(const Duration(hours: 7))
        : now.toUtc().add(const Duration(hours: 7));
  } else {
    final parsed = DateTime.tryParse(now.toString());
    if (parsed == null) {
      dt = DateTime.now().toUtc().add(const Duration(hours: 7));
    } else {
      dt = parsed.isUtc
          ? parsed.add(const Duration(hours: 7))
          : parsed.toUtc().add(const Duration(hours: 7));
    }
  }
  final y = dt.year.toString().padLeft(4, '0');
  final m = dt.month.toString().padLeft(2, '0');
  final d = dt.day.toString().padLeft(2, '0');
  return '$y-$m-$d';
}

/// Phân bổ nhóm tuổi nợ chuẩn PRD AC-016.1:
/// - daysOverdue <= 0: 'current_not_due' (Chưa đến hạn)
/// - 1..15 ngày: '0_15'
/// - 16..30 ngày: '16_30'
/// - 31..60 ngày: '31_60'
/// - > 60 ngày: 'over_60'
String resolvePrdAgingBucket(dynamic daysOverdue) {
  final num? days = daysOverdue is num ? daysOverdue : num.tryParse(daysOverdue?.toString() ?? '');
  if (days == null || days.isNaN || days <= 0) {
    return 'current_not_due';
  }
  if (days <= 15) return '0_15';
  if (days <= 30) return '16_30';
  if (days <= 60) return '31_60';
  return 'over_60';
}

class PrdAgingBucketMeta {
  final String key;
  final String label;
  final String variant;

  const PrdAgingBucketMeta({
    required this.key,
    required this.label,
    required this.variant,
  });
}

const Map<String, PrdAgingBucketMeta> kPrdAgingBuckets = {
  'current_not_due': PrdAgingBucketMeta(
    key: 'current_not_due',
    label: 'Chưa đến hạn',
    variant: 'slate',
  ),
  '0_15': PrdAgingBucketMeta(
    key: '0_15',
    label: '0–15 ngày',
    variant: 'emerald',
  ),
  '16_30': PrdAgingBucketMeta(
    key: '16_30',
    label: '16–30 ngày',
    variant: 'amber',
  ),
  '31_60': PrdAgingBucketMeta(
    key: '31_60',
    label: '31–60 ngày',
    variant: 'orange',
  ),
  'over_60': PrdAgingBucketMeta(
    key: 'over_60',
    label: '>60 ngày',
    variant: 'red',
  ),
};

String _toDateStr(dynamic val) {
  if (val == null) return '';
  if (val is String) {
    final trimmed = val.trim();
    return trimmed.length >= 10 ? trimmed.substring(0, 10) : trimmed;
  }
  if (val is DateTime) {
    return todayVietnamYmd(val);
  }
  final s = val.toString();
  return s.length >= 10 ? s.substring(0, 10) : s;
}

class SubscriptionProrataResult {
  final int amount;
  final int activeDays;
  final int daysInMonth;
  final bool isProrated;
  final String formattedAmount;
  final String daysRatio;
  final String description;

  const SubscriptionProrataResult({
    required this.amount,
    required this.activeDays,
    required this.daysInMonth,
    required this.isProrated,
    required this.formattedAmount,
    required this.daysRatio,
    required this.description,
  });

  @override
  String toString() => formattedAmount;
}

/// Tính toán & xem trước phí Pro-rata dịch vụ đăng ký (PRD 10.3 / Ruling 3).
SubscriptionProrataResult previewSubscriptionProrata({
  dynamic unitPrice,
  dynamic quantity = 1,
  dynamic startDate,
  dynamic endDate,
  bool zeroUsage = false,
  String? periodYm,
}) {
  final num parsedPrice = unitPrice is num
      ? unitPrice
      : num.tryParse(unitPrice?.toString() ?? '') ?? 0;
  final num rawQty = quantity is num
      ? quantity
      : num.tryParse(quantity?.toString() ?? '') ?? 1;
  final safeQty = math.max(1, rawQty.toInt());

  final startStr = _toDateStr(startDate);
  final endStr = _toDateStr(endDate);

  if (zeroUsage) {
    return const SubscriptionProrataResult(
      amount: 0,
      activeDays: 0,
      daysInMonth: 30,
      isProrated: true,
      formattedAmount: '0 ₫',
      daysRatio: '0/30',
      description: 'Miễn phí sử dụng (0 ₫)',
    );
  }

  // Xác định kỳ tháng & số ngày trong tháng
  String refDateStr = endStr.isNotEmpty
      ? endStr
      : (startStr.isNotEmpty ? startStr : todayVietnamYmd());
  if (periodYm != null && RegExp(r'^\d{4}-\d{2}$').hasMatch(periodYm)) {
    refDateStr = '$periodYm-01';
  }

  int safeY = 2026;
  int safeM = 11;
  final ymParts = refDateStr.length >= 7 ? refDateStr.substring(0, 7).split('-') : [];
  if (ymParts.length == 2) {
    final y = int.tryParse(ymParts[0]);
    final m = int.tryParse(ymParts[1]);
    if (y != null && y > 1970) safeY = y;
    if (m != null && m >= 1 && m <= 12) safeM = m;
  }

  // Số ngày trong tháng safeY, safeM
  final daysInMonth = DateTime.utc(safeY, safeM + 1, 0).day;

  // Kiểm tra thứ tự ngày
  if (startStr.isNotEmpty && endStr.isNotEmpty && endStr.compareTo(startStr) < 0) {
    return SubscriptionProrataResult(
      amount: 0,
      activeDays: 0,
      daysInMonth: daysInMonth,
      isProrated: true,
      formattedAmount: '0 ₫',
      daysRatio: '0/$daysInMonth',
      description: 'Ngày kết thúc trước ngày bắt đầu (0 ₫)',
    );
  }

  int activeDays = daysInMonth;
  final padM = safeM.toString().padLeft(2, '0');
  final padDim = daysInMonth.toString().padLeft(2, '0');
  final monthStart = '$safeY-$padM-01';
  final monthEnd = '$safeY-$padM-$padDim';

  if (startStr.isNotEmpty || endStr.isNotEmpty) {
    final effStart = startStr.isNotEmpty
        ? (startStr.compareTo(monthStart) > 0 ? startStr : monthStart)
        : monthStart;
    final effEnd = endStr.isNotEmpty
        ? (endStr.compareTo(monthEnd) < 0 ? endStr : monthEnd)
        : monthEnd;

    if (effEnd.compareTo(effStart) < 0) {
      activeDays = 0;
    } else {
      final d1 = int.tryParse(effStart.length >= 10 ? effStart.substring(8, 10) : '1') ?? 1;
      final d2 = int.tryParse(effEnd.length >= 10 ? effEnd.substring(8, 10) : padDim) ?? daysInMonth;
      activeDays = math.max(0, d2 - d1 + 1);
    }
  }

  final isProrated = activeDays < daysInMonth;
  final num rawAmount = isProrated
      ? (parsedPrice * safeQty * activeDays) / daysInMonth
      : parsedPrice * safeQty;
  final amount = activeDays <= 0 ? 0 : roundVND(rawAmount);

  final formatter = NumberFormat('#,##0', 'vi_VN');
  final formattedAmount = '${formatter.format(amount)} ₫';

  return SubscriptionProrataResult(
    amount: amount,
    activeDays: activeDays,
    daysInMonth: daysInMonth,
    isProrated: isProrated,
    formattedAmount: formattedAmount,
    daysRatio: '$activeDays/$daysInMonth',
    description: isProrated
        ? '$activeDays/$daysInMonth ngày ($formattedAmount)'
        : 'Trọn kỳ ($formattedAmount)',
  );
}

/// Kiểm tra điều kiện xác nhận hủy hóa đơn 2 bước (PRD 16.2):
/// - Phải gõ đúng mã hóa đơn invoice_code
/// - Phải có lý do hủy non-empty
bool canConfirmInvoiceVoid({
  dynamic invoice,
  dynamic typedInvoiceCode,
  String? reason,
}) {
  String expected = '';
  if (invoice is String) {
    expected = invoice;
  } else if (invoice is Map) {
    expected = (invoice['invoice_code'] ?? invoice['code'] ?? '').toString();
  }

  final typed = typedInvoiceCode?.toString().trim() ?? '';
  final exp = expected.trim();

  if (exp.isEmpty || typed.isEmpty) return false;
  if (typed != exp) return false;
  if (reason == null || reason.trim().isEmpty) return false;
  return true;
}

Map<String, dynamic> _resolveActorInfo(dynamic actor) {
  if (actor == null) return {'id': null, 'roles': <String>[]};
  String? id;
  List<String> roles = [];

  if (actor is Map) {
    id = (actor['id'] ?? actor['user_id'])?.toString();
    if (actor['roleCodes'] is List) {
      roles = (actor['roleCodes'] as List).map((r) => r.toString().toUpperCase()).toList();
    } else if (actor['roles'] is List) {
      roles = (actor['roles'] as List).map((r) => r.toString().toUpperCase()).toList();
    } else if (actor['role'] != null) {
      roles = [actor['role'].toString().toUpperCase()];
    }
  } else if (actor is String) {
    roles = [actor.toUpperCase()];
  }
  return {'id': id, 'roles': roles};
}

/// Kiểm tra quyền phê duyệt 4 mắt cho đề nghị điều chỉnh hóa đơn (PRD Mục 5.6 & 6.2):
/// - Ngăn chặn tự phê duyệt (creatorId === actorId) trừ khi allowSelfApproval = true.
/// - OWNER: có quyền duyệt.
/// - MANAGER: có quyền duyệt (khi không phải người tạo).
/// - SYS_ADMIN: chỉ có quyền duyệt dự phòng khi tòa nhà chưa có OWNER hoạt động (buildingHasActiveOwner === false).
bool canActorApproveInvoiceAdjustment({
  dynamic actor,
  dynamic record,
  bool buildingHasActiveOwner = true,
  bool allowSelfApproval = false,
}) {
  final actorInfo = _resolveActorInfo(actor);
  final String? actorId = actorInfo['id'] as String?;
  final List<String> roles = actorInfo['roles'] as List<String>;

  String? creatorId;
  if (record is Map) {
    final refundMeta = record['refund_meta'];
    creatorId = (refundMeta is Map ? refundMeta['requested_by'] : null)?.toString() ??
        record['created_by']?.toString() ??
        record['requested_by']?.toString() ??
        record['creatorId']?.toString();
  }

  // 4-eyes check
  if (actorId != null && creatorId != null && actorId == creatorId) {
    if (!allowSelfApproval) return false;
  }

  final isOwner = roles.contains('OWNER');
  final isManager = roles.contains('MANAGER');
  final isSysAdmin = roles.contains('SYS_ADMIN') || roles.contains('ADMIN');

  if (isOwner) return true;
  if (isManager) return true;
  if (isSysAdmin) {
    return !buildingHasActiveOwner;
  }

  return false;
}

/// Kiểm tra quyền phê duyệt 4 mắt cho đề nghị hoàn tiền tín dụng (FR-040 & PRD Mục 5.6).
bool canActorApproveCreditRefund({
  dynamic actor,
  dynamic record,
  bool buildingHasActiveOwner = true,
  bool allowSelfApproval = false,
}) {
  return canActorApproveInvoiceAdjustment(
    actor: actor,
    record: record,
    buildingHasActiveOwner: buildingHasActiveOwner,
    allowSelfApproval: allowSelfApproval,
  );
}

class SettlementPayoutSummary {
  final int depositRefund;
  final int creditRefund;
  final int totalPayout;
  final bool requiresUncPayout;

  const SettlementPayoutSummary({
    required this.depositRefund,
    required this.creditRefund,
    required this.totalPayout,
    required this.requiresUncPayout,
  });
}

/// Tách bạch số tiền hoàn cọc và hoàn tín dụng trong quyết toán cuối kỳ (M06 / FR-024 / FR-040).
SettlementPayoutSummary resolveSettlementPayoutSummary(dynamic settlement) {
  final s = settlement is Map ? settlement : const {};
  final rawDeposit = s['deposit_refund_amount'] ??
      s['depositRefund'] ??
      s['refund_amount'] ??
      s['calculated_refund_amount'] ??
      0;
  final rawCredit = s['credit_refund_amount'] ?? s['creditRefund'] ?? s['credit_refund'] ?? 0;

  final num depNum = rawDeposit is num ? rawDeposit : num.tryParse(rawDeposit.toString()) ?? 0;
  final num credNum = rawCredit is num ? rawCredit : num.tryParse(rawCredit.toString()) ?? 0;

  final depositRefund = math.max(0, depNum.toInt());
  final creditRefund = math.max(0, credNum.toInt());

  final rawTotal = s['total_payout_amount'] ?? s['totalPayout'] ?? s['total_payout'];
  int totalPayout;
  if (rawTotal != null) {
    final num totalNum = rawTotal is num ? rawTotal : num.tryParse(rawTotal.toString()) ?? 0;
    totalPayout = math.max(0, totalNum.toInt());
  } else {
    totalPayout = depositRefund + creditRefund;
  }

  return SettlementPayoutSummary(
    depositRefund: depositRefund,
    creditRefund: creditRefund,
    totalPayout: totalPayout,
    requiresUncPayout: totalPayout > 0,
  );
}

class ClientMeterAnomalyResult {
  final bool hasInput;
  final bool isInvalid;
  final double? consumption;
  final double? baselineAvg;
  final int? diffPct;
  final bool isAbnormal;

  const ClientMeterAnomalyResult({
    required this.hasInput,
    required this.isInvalid,
    required this.consumption,
    required this.baselineAvg,
    required this.diffPct,
    required this.isAbnormal,
  });
}

/// Đánh giá sản lượng và cảnh báo biến động bất thường > thresholdPct% (mặc định 30%)
/// so với trung bình tối đa 3 kỳ CONFIRMED liền trước (M08 / FR-030 / FR-031).
ClientMeterAnomalyResult evaluateClientMeterAnomaly({
  dynamic prevReading,
  dynamic currentReading,
  dynamic baselineAvg,
  dynamic thresholdPct = 30,
}) {
  final prev = (prevReading is num ? prevReading : num.tryParse(prevReading?.toString() ?? ''))?.toDouble() ?? 0.0;
  final hasInput = currentReading != null && currentReading.toString().trim().isNotEmpty;

  double? base;
  if (baselineAvg != null) {
    final num? b = baselineAvg is num ? baselineAvg : num.tryParse(baselineAvg.toString());
    if (b != null && b > 0) {
      base = b.toDouble();
    }
  }

  if (!hasInput) {
    return ClientMeterAnomalyResult(
      hasInput: false,
      isInvalid: false,
      consumption: null,
      baselineAvg: base,
      diffPct: null,
      isAbnormal: false,
    );
  }

  final curr = (currentReading is num ? currentReading : num.tryParse(currentReading.toString()))?.toDouble();
  if (curr == null || curr.isNaN || curr.isInfinite || prev.isNaN || prev.isInfinite || curr < prev) {
    return ClientMeterAnomalyResult(
      hasInput: true,
      isInvalid: true,
      consumption: null,
      baselineAvg: base,
      diffPct: null,
      isAbnormal: false,
    );
  }

  final consumption = double.parse((curr - prev).toStringAsFixed(2));
  if (base == null) {
    return ClientMeterAnomalyResult(
      hasInput: true,
      isInvalid: false,
      consumption: consumption,
      baselineAvg: null,
      diffPct: null,
      isAbnormal: false,
    );
  }

  final thresh = (thresholdPct is num ? thresholdPct : num.tryParse(thresholdPct?.toString() ?? ''))?.toDouble() ?? 30.0;
  final safeThresh = thresh > 0 ? thresh : 30.0;

  final ratio = (consumption - base) / base;
  final diffPct = (ratio * 100).round();
  final isAbnormal = (ratio.abs() * 100) > (safeThresh + 1e-9);

  return ClientMeterAnomalyResult(
    hasInput: true,
    isInvalid: false,
    consumption: consumption,
    baselineAvg: base,
    diffPct: diffPct,
    isAbnormal: isAbnormal,
  );
}

class SkippedContractsSummary {
  final int totalSkipped;
  final int missingMeterCount;
  final List<String> missingMeterApartments;
  final int zeroBillableCount;
  final List<String> zeroBillableApartments;
  final int otherCount;
  final String message;

  const SkippedContractsSummary({
    required this.totalSkipped,
    required this.missingMeterCount,
    required this.missingMeterApartments,
    required this.zeroBillableCount,
    required this.zeroBillableApartments,
    required this.otherCount,
    required this.message,
  });
}

/// Tổng hợp danh sách hợp đồng bị bỏ qua khi sinh hóa đơn hàng loạt (AC-015.1).
SkippedContractsSummary summarizeSkippedContracts(dynamic skippedContracts) {
  final list = skippedContracts is List ? skippedContracts : [];
  final List<String> missingMeterApartments = [];
  final List<String> zeroBillableApartments = [];
  int missingMeterCount = 0;
  int zeroBillableCount = 0;
  int otherCount = 0;

  for (final item in list) {
    if (item == null || item is! Map) continue;
    final aptLabel = (item['apartment_code'] ?? item['contract_code'] ?? item['contract_id'] ?? '—').toString();
    final reasonCode = item['reason_code']?.toString() ?? '';

    if (reasonCode == 'MISSING_CONFIRMED_METER_READING') {
      missingMeterCount += 1;
      if (!missingMeterApartments.contains(aptLabel)) {
        missingMeterApartments.add(aptLabel);
      }
    } else if (reasonCode == 'ZERO_BILLABLE_AMOUNT') {
      zeroBillableCount += 1;
      if (!zeroBillableApartments.contains(aptLabel)) {
        zeroBillableApartments.add(aptLabel);
      }
    } else {
      otherCount += 1;
    }
  }

  final totalSkipped = list.length;
  final List<String> parts = [];
  if (missingMeterCount > 0) {
    parts.add('Thiếu chỉ số đồng hồ đã xác nhận ($missingMeterCount căn: ${missingMeterApartments.join(', ')})');
  }
  if (zeroBillableCount > 0) {
    parts.add('Không phát sinh khoản thu ($zeroBillableCount căn: ${zeroBillableApartments.join(', ')})');
  }
  if (otherCount > 0) {
    parts.add('Đã có hóa đơn / khác ($otherCount hợp đồng)');
  }

  return SkippedContractsSummary(
    totalSkipped: totalSkipped,
    missingMeterCount: missingMeterCount,
    missingMeterApartments: missingMeterApartments,
    zeroBillableCount: zeroBillableCount,
    zeroBillableApartments: zeroBillableApartments,
    otherCount: otherCount,
    message: parts.join(' • '),
  );
}

class BatchConfirmFeedbackResult {
  final String level; // 'success' | 'warning'
  final int confirmedCount;
  final int skippedCount;
  final String message;

  const BatchConfirmFeedbackResult({
    required this.level,
    required this.confirmedCount,
    required this.skippedCount,
    required this.message,
  });
}

/// Chuẩn hóa thông báo kết quả xác nhận chỉ số đồng hồ hàng loạt (`POST /api/v1/meters/readings/confirm-batch`).
BatchConfirmFeedbackResult resolveBatchConfirmFeedback(dynamic res) {
  final r = res is Map ? res : const {};
  final rawConfirmed = r['confirmed_count'] ?? 0;
  final confirmedCount = math.max(0, (rawConfirmed is num ? rawConfirmed : int.tryParse(rawConfirmed.toString()) ?? 0).toInt());

  final rawSkipped = r['skipped_abnormal_without_note'];
  int skippedCount = 0;
  if (rawSkipped is List) {
    skippedCount = rawSkipped.length;
  } else if (rawSkipped != null) {
    final num? n = rawSkipped is num ? rawSkipped : num.tryParse(rawSkipped.toString());
    skippedCount = math.max(0, (n ?? 0).toInt());
  }

  if (skippedCount > 0) {
    final defaultMsg = r['message']?.toString() ?? 'Đã xác nhận hàng loạt.';
    return BatchConfirmFeedbackResult(
      level: 'warning',
      confirmedCount: confirmedCount,
      skippedCount: skippedCount,
      message: '$defaultMsg (Còn $skippedCount đồng hồ bất thường cần nhập ghi chú giải trình).',
    );
  }

  return BatchConfirmFeedbackResult(
    level: 'success',
    confirmedCount: confirmedCount,
    skippedCount: 0,
    message: r['message']?.toString() ?? 'Đã xác nhận chốt $confirmedCount chỉ số.',
  );
}

/// Trích xuất đường dẫn ảnh mặt đồng hồ công tơ (FR-032) cho dòng hóa đơn ĐIỆN / NƯỚC bên Cổng Cư dân.
String? resolveResidentInvoiceLineMeterImage(dynamic line) {
  if (line == null || line is! Map) return null;
  final typeKey = (line['item_type'] ?? line['line_type'] ?? '').toString().trim().toUpperCase();
  if (typeKey != 'ELECTRICITY' && typeKey != 'WATER') {
    return null;
  }
  final formulaMeta = line['formula_meta'];
  final candidate = line['meter_image_url'] ?? (formulaMeta is Map ? formulaMeta['image_url'] : null) ?? '';
  final trimmed = candidate.toString().trim();
  return trimmed.isNotEmpty ? trimmed : null;
}

class ResidentInvoiceTotalsSummary {
  final int subtotalAmount;
  final int adjustmentAmount;
  final int creditOffsetAmount;
  final int totalAmount;
  final int paidAmount;
  final int remainingAmount;
  final bool showPreTotalBreakdown;

  const ResidentInvoiceTotalsSummary({
    required this.subtotalAmount,
    required this.adjustmentAmount,
    required this.creditOffsetAmount,
    required this.totalAmount,
    required this.paidAmount,
    required this.remainingAmount,
    required this.showPreTotalBreakdown,
  });
}

/// Chuẩn hóa số liệu tổng kết chân hóa đơn bên Cổng Cư dân.
ResidentInvoiceTotalsSummary resolveResidentInvoiceTotalsSummary(dynamic invoice) {
  final inv = invoice is Map ? invoice : const {};
  final statusUpper = (inv['status'] ?? '').toString().trim().toUpperCase();

  final rawTotal = inv['total_amount'] ?? 0;
  final rawPaid = inv['paid_amount'] ?? 0;
  final rawAdj = inv['adjustment_amount'] ?? 0;
  final rawCreditOffset = inv['credit_offset_amount'] ?? 0;

  final totalAmount = math.max(0, (rawTotal is num ? rawTotal : int.tryParse(rawTotal.toString()) ?? 0).toInt());
  final paidAmount = math.max(0, (rawPaid is num ? rawPaid : int.tryParse(rawPaid.toString()) ?? 0).toInt());
  final adjustmentAmount = (rawAdj is num ? rawAdj : int.tryParse(rawAdj.toString()) ?? 0).toInt();
  final creditOffsetAmount = math.max(0, (rawCreditOffset is num ? rawCreditOffset : int.tryParse(rawCreditOffset.toString()) ?? 0).toInt());

  int subtotalAmount;
  if (inv['subtotal_amount'] != null) {
    final rawSub = inv['subtotal_amount'];
    subtotalAmount = (rawSub is num ? rawSub : int.tryParse(rawSub.toString()) ?? 0).toInt();
  } else {
    subtotalAmount = totalAmount - adjustmentAmount + creditOffsetAmount;
  }

  final remainingAmount = (statusUpper == 'VOID' || statusUpper == 'CANCELLED')
      ? 0
      : math.max(0, totalAmount - paidAmount);

  return ResidentInvoiceTotalsSummary(
    subtotalAmount: subtotalAmount,
    adjustmentAmount: adjustmentAmount,
    creditOffsetAmount: creditOffsetAmount,
    totalAmount: totalAmount,
    paidAmount: paidAmount,
    remainingAmount: remainingAmount,
    showPreTotalBreakdown: adjustmentAmount != 0 || creditOffsetAmount > 0,
  );
}

/// Chuẩn hóa ngưỡng cảnh báo biến động chỉ số công tơ (%) từ cấu hình hệ thống (mặc định 30%).
double resolveAnomalyThresholdPct(dynamic rawPct) {
  final num? numVal = rawPct is num ? rawPct : num.tryParse(rawPct?.toString() ?? '');
  return (numVal != null && numVal > 0) ? numVal.toDouble() : 30.0;
}

/// Tính số tiền tạm tính cho công tơ trên bảng ghi chỉ số (M08).
int? computeMeterEstimatedAmount(dynamic consumption, [dynamic meterRow]) {
  if (consumption == null || consumption.toString().trim().isEmpty) {
    return null;
  }
  final num? cons = consumption is num ? consumption : num.tryParse(consumption.toString());
  if (cons == null || cons.isNaN || cons.isInfinite || cons < 0) {
    return null;
  }
  if (cons == 0) {
    return 0;
  }

  final row = meterRow is Map ? meterRow : const {};
  num rawPrice = 0;
  if (row['effective_unit_price'] != null) {
    rawPrice = (row['effective_unit_price'] is num
        ? row['effective_unit_price']
        : num.tryParse(row['effective_unit_price'].toString()) ?? 0);
  } else if (row['unit_price'] != null) {
    rawPrice = (row['unit_price'] is num
        ? row['unit_price']
        : num.tryParse(row['unit_price'].toString()) ?? 0);
  }
  final safePrice = (rawPrice.isNaN || rawPrice.isInfinite || rawPrice < 0) ? 0 : rawPrice;
  return roundVND(cons * safePrice);
}

const List<Map<String, String>> kDefaultContractServiceCodeOptions = [
  {'value': 'ELECTRICITY', 'label': 'Điện sinh hoạt (kWh)'},
  {'value': 'WATER', 'label': 'Nước sinh hoạt (m³)'},
  {'value': 'INTERNET', 'label': 'Internet / Wifi (INTERNET)'},
  {'value': 'MOTORBIKE_PARKING', 'label': 'Gửi xe máy xăng (MOTORBIKE_PARKING)'},
  {'value': 'ELECTRICBIKE_PARKING', 'label': 'Gửi xe đạp/máy điện (ELECTRICBIKE_PARKING)'},
  {'value': 'TRASH', 'label': 'Phí thu gom rác (TRASH)'},
  {'value': 'COMMON_SERVICE', 'label': 'Dịch vụ chung (COMMON_SERVICE)'},
];

/// Xây dựng danh sách mã dịch vụ riêng theo hợp đồng (FR-065).
List<Map<String, String>> buildContractServiceCodeOptions([
  List<dynamic>? catalogItems,
  List<dynamic>? existingPrices,
]) {
  final Map<String, Map<String, String>> map = {};
  for (final std in kDefaultContractServiceCodeOptions) {
    map[std['value']!] = Map<String, String>.from(std);
  }

  final Set<String> existingCodeSet = {};
  if (existingPrices != null) {
    for (final sp in existingPrices) {
      if (sp is Map) {
        final code = (sp['service_code'] ?? '').toString().trim().toUpperCase();
        if (code.isNotEmpty) existingCodeSet.add(code);
      }
    }
  }

  if (catalogItems != null) {
    for (final item in catalogItems) {
      if (item is! Map) continue;
      final code = (item['code'] ?? item['service_code'] ?? '').toString().trim().toUpperCase();
      if (code.isEmpty) continue;
      if (item['is_active'] == false && !existingCodeSet.contains(code)) continue;
      if (!map.containsKey(code)) {
        final name = (item['name'] ?? item['service_name'] ?? code).toString().trim();
        final label = name.toUpperCase() == code ? code : '$name ($code)';
        map[code] = {'value': code, 'label': label};
      }
    }
  }

  for (final code in existingCodeSet) {
    if (!map.containsKey(code)) {
      map[code] = {'value': code, 'label': code};
    }
  }

  return map.values.toList();
}

/// Kiểm tra dòng công tơ có bị khóa không cho sửa/ghi đè trên bảng hoặc modal (M08 Turnover).
bool isMeterRowLockedForEdit(dynamic row, bool canWriteMeters) {
  if (!canWriteMeters) return true;
  if (row is Map) {
    return row['period_reading_billed'] == true;
  }
  return false;
}

class MeterTurnoverBadgeMeta {
  final bool showContractTag;
  final bool isMultiSlot;
  final String? slotLabel;
  final String? contractCode;
  final String? tenantName;

  const MeterTurnoverBadgeMeta({
    required this.showContractTag,
    required this.isMultiSlot,
    required this.slotLabel,
    required this.contractCode,
    required this.tenantName,
  });
}

/// Chuẩn hóa nhãn hiển thị hợp đồng & đợt giao ca giữa tháng trên bảng ghi chỉ số đồng hồ.
MeterTurnoverBadgeMeta resolveMeterTurnoverBadgeMeta(dynamic row) {
  final r = row is Map ? row : const {};
  final contractCode = r['target_contract_code']?.toString();
  final tenantName = r['target_tenant_name']?.toString();
  final rawTotal = r['period_total_slots'] ?? 0;
  final rawSlot = r['period_slot_index'] ?? 0;
  final totalSlots = (rawTotal is num ? rawTotal : int.tryParse(rawTotal.toString()) ?? 0).toInt();
  final slotIndex = (rawSlot is num ? rawSlot : int.tryParse(rawSlot.toString()) ?? 0).toInt();
  final isMultiSlot = totalSlots > 1 && slotIndex > 0;

  return MeterTurnoverBadgeMeta(
    showContractTag: contractCode != null || isMultiSlot,
    isMultiSlot: isMultiSlot,
    slotLabel: isMultiSlot ? 'Đợt $slotIndex/$totalSlots' : null,
    contractCode: contractCode,
    tenantName: tenantName,
  );
}

/// Ánh xạ dữ liệu của một đợt hợp đồng (`overlapping_contracts`) lên đối tượng đồng hồ.
Map<String, dynamic> resolveMeterSlotView(
  Map<String, dynamic>? meter, [
  dynamic selectedContractId,
]) {
  if (meter == null) return {};
  final out = Map<String, dynamic>.from(meter);
  final slots = meter['overlapping_contracts'] is List ? (meter['overlapping_contracts'] as List) : [];
  final targetId = selectedContractId?.toString() ?? meter['target_contract_id']?.toString();

  if (targetId == null) return out;

  Map<String, dynamic>? slot;
  for (final s in slots) {
    if (s is Map && s['contract_id']?.toString() == targetId) {
      slot = Map<String, dynamic>.from(s);
      break;
    }
  }

  if (slot == null) return out;

  final hasReading = slot['reading_id'] != null;
  out['target_contract_id'] = slot['contract_id'];
  out['target_contract_code'] = slot['contract_code'];
  out['target_tenant_name'] = slot['tenant_name'];
  out['period_slot_index'] = slot['slot_index'] ?? meter['period_slot_index'];
  out['period_total_slots'] = slot['total_slots'] ?? meter['period_total_slots'];
  out['period_reading_id'] = slot['reading_id'];
  out['period_previous_reading'] = hasReading ? slot['previous_reading'] : null;
  out['period_current_reading'] = hasReading ? slot['current_reading'] : null;
  out['period_consumption'] = hasReading ? slot['consumption'] : null;
  out['period_reading_status'] = hasReading ? slot['reading_status'] : null;
  out['period_is_abnormal'] = hasReading ? (slot['is_abnormal'] == true) : false;
  out['period_abnormal_note'] = hasReading ? slot['abnormal_note'] : null;
  out['period_image_url'] = hasReading ? slot['image_url'] : null;
  out['period_reading_billed'] = slot['is_billed'] == true;

  if (slot['previous_reading'] != null) {
    out['last_known_reading'] = slot['previous_reading'];
  }
  if (slot['effective_unit_price'] != null) {
    out['effective_unit_price'] = slot['effective_unit_price'];
  }
  if (slot['effective_price_source'] != null) {
    out['effective_price_source'] = slot['effective_price_source'];
  }

  return out;
}

const List<Map<String, String>> kMeterContractFilterOptions = [
  {'value': '', 'label': 'Tất cả căn hộ'},
  {'value': 'true', 'label': 'Đang có hợp đồng ACTIVE'},
  {'value': 'false', 'label': 'Chưa có hợp đồng ACTIVE'},
];

Map<String, dynamic> buildMeterListQueryParams({
  String? buildingId,
  String? meterType,
  String? statusFilter,
  String? activeContractFilter,
  String? period,
  String? search,
}) {
  final normalizedActive = (activeContractFilter == 'true' || activeContractFilter == 'false')
      ? activeContractFilter
      : null;
  final trimmedSearch = search?.trim();

  final Map<String, dynamic> params = {};
  if (buildingId != null && buildingId.isNotEmpty) params['building_id'] = buildingId;
  if (meterType != null && meterType.isNotEmpty) params['meter_type'] = meterType;
  if (statusFilter != null && statusFilter.isNotEmpty) params['status'] = statusFilter;
  if (normalizedActive != null) params['active_contract'] = normalizedActive;
  if (period != null && period.isNotEmpty) params['period'] = period;
  if (trimmedSearch != null && trimmedSearch.isNotEmpty) params['search'] = trimmedSearch;
  return params;
}
