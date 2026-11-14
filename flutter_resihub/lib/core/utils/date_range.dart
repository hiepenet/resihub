import 'dart:math';

const Set<String> kBlockingContractStatuses = {
  'ACTIVE',
  'RENEWAL_PENDING',
  'TERMINATION_PENDING',
  'PENDING_APPROVAL',
  'DRAFT',
};

/// Chuẩn hóa giá trị ngày bất kỳ (DateTime, ISO string, YYYY-MM-DD) về chuỗi `YYYY-MM-DD`.
/// Trả về `""` nếu rỗng hoặc không hợp lệ.
String toDateOnlyStr(dynamic val) {
  if (val == null || val == '') return '';
  if (val is DateTime) {
    final y = val.year.toString().padLeft(4, '0');
    final m = val.month.toString().padLeft(2, '0');
    final d = val.day.toString().padLeft(2, '0');
    return '$y-$m-$d';
  }
  final str = val.toString().trim();
  final exactIsoMatch = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(str);
  if (exactIsoMatch != null) {
    final y = int.tryParse(exactIsoMatch.group(1)!);
    final m = int.tryParse(exactIsoMatch.group(2)!);
    final d = int.tryParse(exactIsoMatch.group(3)!);
    if (y != null && m != null && d != null) {
      final dt = DateTime.utc(y, m, d);
      if (dt.year == y && dt.month == m && dt.day == d) {
        return '${exactIsoMatch.group(1)}-${exactIsoMatch.group(2)}-${exactIsoMatch.group(3)}';
      }
    }
    return '';
  }
  final parsed = DateTime.tryParse(str);
  if (parsed == null) return '';
  final y = parsed.year.toString().padLeft(4, '0');
  final m = parsed.month.toString().padLeft(2, '0');
  final d = parsed.day.toString().padLeft(2, '0');
  return '$y-$m-$d';
}

DateTime? _parseUtc(String? dateStr) {
  final clean = toDateOnlyStr(dateStr);
  if (clean.isEmpty) return null;
  final parts = clean.split('-').map(int.parse).toList();
  return DateTime.utc(parts[0], parts[1], parts[2]);
}

String _formatUtc(DateTime dt) {
  final y = dt.year.toString().padLeft(4, '0');
  final m = dt.month.toString().padLeft(2, '0');
  final d = dt.day.toString().padLeft(2, '0');
  return '$y-$m-$d';
}

/// Định dạng `YYYY-MM-DD` sang `DD/MM/YYYY` để hiển thị trên thông báo tiếng Việt.
String formatDateVi(String? dateStr) {
  final clean = toDateOnlyStr(dateStr);
  if (clean.isEmpty) return '';
  final parts = clean.split('-');
  return '${parts[2]}/${parts[1]}/${parts[0]}';
}

/// Cộng/trừ số ngày trên chuỗi lịch `YYYY-MM-DD` theo chuẩn UTC (không lệch múi giờ).
String addDaysStr(String? dateStr, int days) {
  final dt = _parseUtc(dateStr);
  if (dt == null) return '';
  final updated = DateTime.utc(dt.year, dt.month, dt.day + days);
  return _formatUtc(updated);
}

/// Khoảng cách ngày nguyên `endStr - startStr` (trả về `null` nếu thiếu 1 trong 2 ngày).
int? diffDaysStr(String? startStr, String? endStr) {
  final s = _parseUtc(startStr);
  final e = _parseUtc(endStr);
  if (s == null || e == null) return null;
  const msPerDay = 86400000;
  return ((e.millisecondsSinceEpoch - s.millisecondsSinceEpoch) / msPerDay).round();
}

/// Cộng số tháng trên chuỗi `YYYY-MM-DD`, tự kẹp ngày cuối tháng (VD: `2026-01-31` + 1 tháng -> `2026-02-28`).
String addMonthsClampedStr(String? dateStr, int months) {
  final dt = _parseUtc(dateStr);
  if (dt == null) return '';
  final totalMonths = dt.year * 12 + (dt.month - 1) + months;
  final targetYear = totalMonths ~/ 12;
  final targetMonthIndex = ((totalMonths % 12) + 12) % 12; // 0..11
  final targetMonth = targetMonthIndex + 1; // 1..12
  final lastDayOfTargetMonth = DateTime.utc(targetYear, targetMonth + 1, 0).day;
  final clampedDay = min(dt.day, lastDayOfTargetMonth);
  return _formatUtc(DateTime.utc(targetYear, targetMonth, clampedDay));
}

/// Trả về ngày lớn nhất trong danh sách chuỗi ngày hợp lệ (`""` nếu không có ngày nào).
String maxDateStr(List<dynamic> dates) {
  var result = '';
  for (final raw in dates) {
    final d = toDateOnlyStr(raw);
    if (d.isNotEmpty && (result.isEmpty || d.compareTo(result) > 0)) {
      result = d;
    }
  }
  return result;
}

/// Trả về ngày nhỏ nhất trong danh sách chuỗi ngày hợp lệ (`""` nếu không có ngày nào).
String minDateStr(List<dynamic> dates) {
  var result = '';
  for (final raw in dates) {
    final d = toDateOnlyStr(raw);
    if (d.isNotEmpty && (result.isEmpty || d.compareTo(result) < 0)) {
      result = d;
    }
  }
  return result;
}

/// Khoảng thời gian căn hộ đang bị bận bởi Hợp đồng hoặc Giữ chỗ.
class BusyInterval {
  final dynamic id;
  final String kind; // 'contract' | 'reservation'
  final String status;
  final String from;
  final String to;
  final String label;

  const BusyInterval({
    required this.id,
    required this.kind,
    required this.status,
    required this.from,
    required this.to,
    required this.label,
  });
}

/// Trích xuất danh sách các khoảng bận của căn hộ từ contracts và reservations.
List<BusyInterval> extractApartmentBusyIntervals({
  List<dynamic> contracts = const [],
  List<dynamic> reservations = const [],
  dynamic excludeContractId,
  dynamic excludeReservationId,
  String todayStr = '',
}) {
  final minEnd = toDateOnlyStr(todayStr);
  final excludeContractKey = excludeContractId?.toString();
  final excludeResKey = excludeReservationId?.toString();

  final intervals = <BusyInterval>[];

  for (final c in contracts) {
    if (c == null) continue;
    final status = (c is Map ? c['status'] : (c as dynamic).status)?.toString() ?? '';
    if (!kBlockingContractStatuses.contains(status)) continue;
    final id = (c is Map ? c['id'] : (c as dynamic).id)?.toString();
    if (excludeContractKey != null && id == excludeContractKey) continue;

    final startDate = c is Map ? c['start_date'] : (c as dynamic).start_date;
    final endDate = c is Map ? (c['terminated_at'] ?? c['end_date']) : ((c as dynamic).terminated_at ?? (c as dynamic).end_date);
    final from = toDateOnlyStr(startDate);
    final to = toDateOnlyStr(endDate);
    if (from.isEmpty || to.isEmpty || to.compareTo(from) < 0) continue;
    if (minEnd.isNotEmpty && to.compareTo(minEnd) < 0) continue;

    final contractNumber = (c is Map ? c['contract_number'] : (c as dynamic).contract_number)?.toString();
    intervals.add(BusyInterval(
      id: id,
      kind: 'contract',
      status: status,
      from: from,
      to: to,
      label: (contractNumber != null && contractNumber.isNotEmpty)
          ? 'HĐ $contractNumber'
          : 'Hợp đồng thuê',
    ));
  }

  for (final r in reservations) {
    if (r == null) continue;
    final status = (r is Map ? r['status'] : (r as dynamic).status)?.toString() ?? '';
    if (status != 'HELD') continue;
    final id = (r is Map ? r['id'] : (r as dynamic).id)?.toString();
    if (excludeResKey != null && id == excludeResKey) continue;

    final holdFrom = r is Map ? (r['hold_from'] ?? r['created_at']) : ((r as dynamic).hold_from ?? (r as dynamic).created_at);
    final holdUntil = r is Map ? r['hold_until'] : (r as dynamic).hold_until;
    final from = toDateOnlyStr(holdFrom);
    final to = toDateOnlyStr(holdUntil);
    if (from.isEmpty || to.isEmpty || to.compareTo(from) < 0) continue;
    if (minEnd.isNotEmpty && to.compareTo(minEnd) < 0) continue;

    final prospectName = (r is Map ? r['prospect_name'] : (r as dynamic).prospect_name)?.toString();
    intervals.add(BusyInterval(
      id: id,
      kind: 'reservation',
      status: status,
      from: from,
      to: to,
      label: (prospectName != null && prospectName.isNotEmpty)
          ? 'Giữ chỗ ($prospectName)'
          : 'Phiếu giữ chỗ',
    ));
  }

  intervals.sort((a, b) {
    final cmpFrom = a.from.compareTo(b.from);
    if (cmpFrom != 0) return cmpFrom;
    return a.to.compareTo(b.to);
  });

  return intervals;
}

/// Tìm ngày bắt đầu trống đầu tiên kể từ `baseDateStr` ngoài mọi khoảng đã thuê / giữ chỗ,
/// đồng thời đủ ít nhất `minSpanDays` ngày trống liên tiếp.
String findFirstAvailableStartDate(
  String baseDateStr,
  List<BusyInterval> busyIntervals, {
  int minSpanDays = 1,
}) {
  var candidate = toDateOnlyStr(baseDateStr);
  if (candidate.isEmpty) return '';

  final sorted = [...busyIntervals]
      .where((iv) => iv.from.isNotEmpty && iv.to.isNotEmpty && iv.to.compareTo(iv.from) >= 0)
      .toList()
    ..sort((a, b) {
      final cmp = a.from.compareTo(b.from);
      return cmp != 0 ? cmp : a.to.compareTo(b.to);
    });

  final spanOffset = max(1, minSpanDays) - 1;

  var moved = true;
  while (moved) {
    moved = false;
    final spanEnd = addDaysStr(candidate, spanOffset);
    for (final iv in sorted) {
      if (iv.from.compareTo(spanEnd) <= 0 && candidate.compareTo(iv.to) <= 0) {
        final nextCandidate = addDaysStr(iv.to, 1);
        if (nextCandidate.compareTo(candidate) > 0) {
          candidate = nextCandidate;
          moved = true;
          break;
        }
      }
    }
  }

  return candidate;
}

/// Tìm các khoảng bận bị chồng lấn với khoảng `[startStr, endStr]` người dùng đang chọn.
List<BusyInterval> findOverlappingBusyIntervals(
  String startStr,
  String endStr,
  List<BusyInterval> busyIntervals,
) {
  final s = toDateOnlyStr(startStr);
  final e = toDateOnlyStr(endStr);
  if (s.isEmpty) return [];
  final rangeEnd = e.isNotEmpty && e.compareTo(s) >= 0 ? e : s;
  return busyIntervals
      .where((iv) => iv.from.isNotEmpty && iv.to.isNotEmpty && iv.from.compareTo(rangeEnd) <= 0 && iv.to.compareTo(s) >= 0)
      .toList();
}

/// Định dạng thông báo lỗi tiếng Việt khi khoảng ngày chọn bị trùng lịch thuê/giữ chỗ của căn hộ.
String formatBusyOverlapError(
  List<BusyInterval> overlaps, {
  String actionLabel = 'Khoảng thời gian chọn',
}) {
  if (overlaps.isEmpty) return '';
  final first = overlaps.first;
  final kindText = first.kind == 'reservation' ? 'phiếu giữ chỗ' : 'hợp đồng thuê';
  return '$actionLabel trùng với $kindText (${formatDateVi(first.from)} → ${formatDateVi(first.to)}). Vui lòng chọn ngoài khoảng này.';
}

/// Kiểm tra thứ tự ngày trước - ngày sau cho các form lưu dữ liệu.
String getDateOrderError(
  String? startStr,
  String? endStr, {
  bool strictAfter = false,
  String startLabel = 'Ngày bắt đầu',
  String endLabel = 'Ngày kết thúc',
}) {
  final s = toDateOnlyStr(startStr);
  final e = toDateOnlyStr(endStr);
  if (s.isEmpty || e.isEmpty) return '';
  if (strictAfter && e.compareTo(s) <= 0) {
    return '$endLabel phải sau ${startLabel.toLowerCase()}.';
  }
  if (!strictAfter && e.compareTo(s) < 0) {
    return '$endLabel không được nhỏ hơn ${startLabel.toLowerCase()}.';
  }
  return '';
}

/// Cặp ngày từ - đến sau khi đồng bộ bộ lọc.
class FilterDateRange {
  final String fromDate;
  final String toDate;

  const FilterDateRange({
    required this.fromDate,
    required this.toDate,
  });
}

/// Tự đồng bộ `toDate = fromDate` nếu `nextFrom > currentTo`.
FilterDateRange syncFilterDateRange(dynamic nextFrom, dynamic currentTo) {
  final fromDate = toDateOnlyStr(nextFrom);
  final toDate = toDateOnlyStr(currentTo);
  if (fromDate.isNotEmpty && toDate.isNotEmpty && fromDate.compareTo(toDate) > 0) {
    return FilterDateRange(fromDate: fromDate, toDate: fromDate);
  }
  return FilterDateRange(fromDate: fromDate, toDate: toDate);
}
