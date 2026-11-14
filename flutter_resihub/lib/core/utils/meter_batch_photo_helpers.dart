import 'dart:async';
import 'dart:math' as math;
import 'billing_helpers.dart' show
    evaluateClientMeterAnomaly,
    computeMeterEstimatedAmount,
    isMeterRowLockedForEdit;

export 'billing_helpers.dart' show resolveMeterSlotView;

const int kMaxBatchMeterPhotos = 30;
const int kDefaultOcrConcurrency = 2;

String _normalizeAsciiTokenString(dynamic input) {
  final str = input?.toString() ?? '';
  // Simple accent removal for Vietnamese characters
  const vietnameseMap = {
    'à': 'a', 'á': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a',
    'ă': 'a', 'ằ': 'a', 'ắ': 'a', 'ẳ': 'a', 'ẵ': 'a', 'ặ': 'a',
    'â': 'a', 'ầ': 'a', 'ấ': 'a', 'ẩ': 'a', 'ẫ': 'a', 'ậ': 'a',
    'è': 'e', 'é': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e',
    'ê': 'e', 'ề': 'e', 'ế': 'e', 'ể': 'e', 'ễ': 'e', 'ệ': 'e',
    'ì': 'i', 'í': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i',
    'ò': 'o', 'ó': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o',
    'ô': 'o', 'ồ': 'o', 'ố': 'o', 'ổ': 'o', 'ỗ': 'o', 'ộ': 'o',
    'ơ': 'o', 'ờ': 'o', 'ớ': 'o', 'ở': 'o', 'ỡ': 'o', 'ợ': 'o',
    'ù': 'u', 'ú': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u',
    'ư': 'u', 'ừ': 'u', 'ứ': 'u', 'ử': 'u', 'ữ': 'u', 'ự': 'u',
    'ỳ': 'y', 'ý': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y',
    'đ': 'd',
    'À': 'A', 'Á': 'A', 'Ả': 'A', 'Ã': 'A', 'Ạ': 'A',
    'Ă': 'A', 'Ằ': 'A', 'Ắ': 'A', 'Ẳ': 'A', 'Ẵ': 'A', 'Ặ': 'A',
    'Â': 'A', 'Ầ': 'A', 'Ấ': 'A', 'Ẩ': 'A', 'Ẫ': 'A', 'Ậ': 'A',
    'È': 'E', 'É': 'E', 'Ẻ': 'E', 'Ẽ': 'E', 'Ẹ': 'E',
    'Ê': 'E', 'Ề': 'E', 'Ế': 'E', 'Ể': 'E', 'Ễ': 'E', 'Ệ': 'E',
    'Ì': 'I', 'Í': 'I', 'Ỉ': 'I', 'Ĩ': 'I', 'Ị': 'I',
    'Ò': 'O', 'Ó': 'O', 'Ỏ': 'O', 'Õ': 'O', 'Ọ': 'O',
    'Ô': 'O', 'Ồ': 'O', 'Ố': 'O', 'Ổ': 'O', 'Ỗ': 'O', 'Ộ': 'O',
    'Ơ': 'O', 'Ờ': 'O', 'Ớ': 'O', 'Ở': 'O', 'Ỡ': 'O', 'Ợ': 'O',
    'Ù': 'U', 'Ú': 'U', 'Ủ': 'U', 'Ũ': 'U', 'Ụ': 'U',
    'Ư': 'U', 'Ừ': 'U', 'Ứ': 'U', 'Ử': 'U', 'Ữ': 'U', 'Ự': 'U',
    'Ỳ': 'Y', 'Ý': 'Y', 'Ỷ': 'Y', 'Ỹ': 'Y', 'Ỵ': 'Y',
    'Đ': 'D',
  };

  final sb = StringBuffer();
  for (int i = 0; i < str.length; i++) {
    final ch = str[i];
    sb.write(vietnameseMap[ch] ?? ch);
  }
  return sb.toString().toUpperCase();
}

String _stripFileExtension(dynamic fileName) {
  final str = fileName?.toString().trim() ?? '';
  return str.replaceAll(RegExp(r'\.[a-zA-Z0-9]{2,5}$'), '');
}

RegExp _buildCodeBoundaryRegex(String normCode) {
  final escaped = RegExp.escape(normCode);
  return RegExp('(?<![A-Z0-9])$escaped(?![A-Z0-9])');
}

/// Phát hiện gợi ý loại đồng hồ (ĐIỆN hoặc NƯỚC) từ văn bản hoặc tên file.
String? detectMeterTypeHintFromText(dynamic rawText) {
  final norm = _normalizeAsciiTokenString(rawText);
  if (norm.isEmpty) return null;

  final hasElec = RegExp(r'(?<![A-Z0-9])(DIEN|ELECTRICITY|ELECTRIC|ELEC|KWH|EL|E)(?![A-Z0-9])').hasMatch(norm);
  final hasWater = RegExp(r'(?<![A-Z0-9])(NUOC|WATER|M3|WT|W)(?![A-Z0-9])').hasMatch(norm);

  if (hasElec && !hasWater) return 'ELECTRICITY';
  if (hasWater && !hasElec) return 'WATER';
  return null;
}

num _resolveMeterPreviousBaseline(Map<String, dynamic>? row) {
  if (row == null) return 0;
  if (row['period_previous_reading'] != null) {
    final v = row['period_previous_reading'];
    return v is num ? v : num.tryParse(v.toString()) ?? 0;
  }
  if (row['last_known_reading'] != null) {
    final v = row['last_known_reading'];
    return v is num ? v : num.tryParse(v.toString()) ?? 0;
  }
  final v = row['initial_reading'] ?? 0;
  return v is num ? v : num.tryParse(v.toString()) ?? 0;
}

num? _resolveMeterRollingAvg(Map<String, dynamic>? row) {
  if (row == null) return null;
  if (row['baseline_avg_consumption'] != null) {
    final v = row['baseline_avg_consumption'];
    return v is num ? v : num.tryParse(v.toString());
  }
  if (row['last_known_consumption'] != null) {
    final v = row['last_known_consumption'];
    return v is num ? v : num.tryParse(v.toString());
  }
  return null;
}

class MeterFilenameMatch {
  final String matchKind; // 'EXACT_METER' | 'APARTMENT_ONLY' | 'UNMATCHED'
  final String? meterId;
  final String? apartmentId;
  final String? apartmentCode;
  final String? meterTypeHint;

  const MeterFilenameMatch({
    required this.matchKind,
    required this.meterId,
    required this.apartmentId,
    required this.apartmentCode,
    required this.meterTypeHint,
  });
}

class _AptGroup {
  final String normAptCode;
  final String? apartmentId;
  final String apartmentCode;
  final List<Map<String, dynamic>> meters;

  _AptGroup({
    required this.normAptCode,
    required this.apartmentId,
    required this.apartmentCode,
    required this.meters,
  });
}

/// Nhận diện công tơ hoặc căn hộ mục tiêu từ tên file ảnh chụp công tơ:
/// - Ưu tiên 1: Khớp chính xác `meter_code` (sắp xếp độ dài giảm dần, ranh giới chữ-số).
/// - Ưu tiên 2: Khớp mã căn hộ `apartment_code` (độ dài giảm dần để `A1001` không bao giờ khớp nhầm `A100` hoặc `A10`).
MeterFilenameMatch matchMeterFromFilename(dynamic fileName, [List<dynamic> buildingMeters = const []]) {
  final List<Map<String, dynamic>> meters = [];
  for (final m in buildingMeters) {
    if (m is Map) {
      meters.add(Map<String, dynamic>.from(m));
    }
  }

  final stemNorm = _normalizeAsciiTokenString(_stripFileExtension(fileName));
  if (stemNorm.isEmpty || meters.isEmpty) {
    return MeterFilenameMatch(
      matchKind: 'UNMATCHED',
      meterId: null,
      apartmentId: null,
      apartmentCode: null,
      meterTypeHint: detectMeterTypeHintFromText(stemNorm),
    );
  }

  // 1) Khớp chính xác meter_code (dài nhất trước)
  final metersByCodeLen = meters.where((m) => m['meter_code'] != null).toList()
    ..sort((a, b) => b['meter_code'].toString().length.compareTo(a['meter_code'].toString().length));

  for (final m in metersByCodeLen) {
    final codeNorm = _normalizeAsciiTokenString(m['meter_code']).trim();
    if (codeNorm.isEmpty) continue;
    if (_buildCodeBoundaryRegex(codeNorm).hasMatch(stemNorm)) {
      return MeterFilenameMatch(
        matchKind: 'EXACT_METER',
        meterId: m['id']?.toString(),
        apartmentId: m['apartment_id']?.toString(),
        apartmentCode: m['apartment_code']?.toString(),
        meterTypeHint: m['meter_type']?.toString(),
      );
    }
  }

  // 2) Nhóm theo căn hộ và khớp apartment_code dài nhất trước (chống đụng độ tiền tố A10 / A100 / A1001)
  final Map<String, _AptGroup> aptMap = {};
  for (final m in meters) {
    final rawAptCode = (m['apartment_code'] ?? '').toString().trim();
    final normAptCode = _normalizeAsciiTokenString(rawAptCode).trim();
    if (normAptCode.isEmpty) continue;
    if (!aptMap.containsKey(normAptCode)) {
      aptMap[normAptCode] = _AptGroup(
        normAptCode: normAptCode,
        apartmentId: m['apartment_id']?.toString(),
        apartmentCode: rawAptCode,
        meters: [],
      );
    }
    aptMap[normAptCode]!.meters.add(m);
  }

  final sortedApts = aptMap.values.toList()
    ..sort((a, b) => b.normAptCode.length.compareTo(a.normAptCode.length));

  for (final apt in sortedApts) {
    final re = _buildCodeBoundaryRegex(apt.normAptCode);
    if (re.hasMatch(stemNorm)) {
      final remainder = stemNorm.replaceAll(re, ' ');
      final typeHint = detectMeterTypeHintFromText(remainder);

      if (typeHint != null) {
        final typedCandidates = apt.meters.where((m) => m['meter_type'] == typeHint).toList();
        if (typedCandidates.length == 1) {
          return MeterFilenameMatch(
            matchKind: 'EXACT_METER',
            meterId: typedCandidates[0]['id']?.toString(),
            apartmentId: apt.apartmentId,
            apartmentCode: apt.apartmentCode,
            meterTypeHint: typeHint,
          );
        }
      }

      return MeterFilenameMatch(
        matchKind: 'APARTMENT_ONLY',
        meterId: null,
        apartmentId: apt.apartmentId,
        apartmentCode: apt.apartmentCode,
        meterTypeHint: typeHint,
      );
    }
  }

  return MeterFilenameMatch(
    matchKind: 'UNMATCHED',
    meterId: null,
    apartmentId: null,
    apartmentCode: null,
    meterTypeHint: detectMeterTypeHintFromText(stemNorm),
  );
}

/// Sau khi AI đọc ảnh công tơ xong, tự động gắn `meterId` cho các ảnh chỉ có tên phòng (`APARTMENT_ONLY`).
String? resolveMeterAfterOcr({
  dynamic item,
  dynamic ocrData,
  List<dynamic> buildingMeters = const [],
}) {
  final it = item is Map ? item : const {};
  if (it['meterId'] != null) {
    return it['meterId'].toString();
  }

  final List<Map<String, dynamic>> meters = [];
  for (final m in buildingMeters) {
    if (m is Map) meters.add(Map<String, dynamic>.from(m));
  }

  final ocr = ocrData is Map ? ocrData : const {};
  final output = ocr['output'] is Map ? ocr['output'] as Map : const {};
  final backendResolvedId = output['resolved_meter_id']?.toString();

  if (backendResolvedId != null && meters.any((m) => m['id']?.toString() == backendResolvedId)) {
    return backendResolvedId;
  }

  final detType = (output['detected_meter_type'] ?? '').toString().trim().toUpperCase();
  final targetApartmentId = it['apartmentId']?.toString() ?? output['apartment_id']?.toString();

  if (targetApartmentId != null) {
    final aptMeters = meters.where((m) => m['apartment_id']?.toString() == targetApartmentId).toList();
    if (detType == 'ELECTRICITY' || detType == 'WATER') {
      final typed = aptMeters.where((m) => m['meter_type'] == detType).toList();
      if (typed.length == 1) {
        return typed[0]['id']?.toString();
      }
    } else if (aptMeters.length == 1) {
      return aptMeters[0]['id']?.toString();
    }
  }

  return null;
}

/// Khớp lại danh sách ảnh khi tải lại danh sách công tơ hoặc khi Quản lý đổi Tòa nhà mục tiêu.
List<Map<String, dynamic>> rematchBatchPhotoItemsForBuilding(
  List<dynamic> items,
  List<dynamic> newBuildingMeters, [
  String nextBuildingId = '',
]) {
  final List<Map<String, dynamic>> meters = [];
  for (final m in newBuildingMeters) {
    if (m is Map) meters.add(Map<String, dynamic>.from(m));
  }
  final meterIdSet = meters.map((m) => m['id']?.toString()).whereType<String>().toSet();

  return items.map((raw) {
    final row = raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    final rowBuildingId = row['buildingId']?.toString() ?? '';
    final sameBuilding = rowBuildingId.isEmpty || nextBuildingId.isEmpty || rowBuildingId == nextBuildingId;

    final meterIdStr = row['meterId']?.toString();

    if (sameBuilding && row['manualMeterAssigned'] == true && meterIdStr != null && meterIdSet.contains(meterIdStr)) {
      row['buildingId'] = nextBuildingId.isNotEmpty ? nextBuildingId : rowBuildingId;
      return row;
    }

    if (sameBuilding && meterIdStr != null && meterIdSet.contains(meterIdStr)) {
      row['buildingId'] = nextBuildingId.isNotEmpty ? nextBuildingId : rowBuildingId;
      return row;
    }

    final m = matchMeterFromFilename(row['fileName'], meters);
    row['buildingId'] = nextBuildingId;
    row['matchKind'] = m.matchKind;
    row['meterId'] = m.meterId;
    row['apartmentId'] = m.apartmentId;
    row['apartmentCode'] = m.apartmentCode;
    row['meterTypeHint'] = m.meterTypeHint;
    row['manualMeterAssigned'] = false;
    row['suggestionId'] = sameBuilding ? row['suggestionId'] : null;
    return row;
  }).toList();
}

class QueueTaskResult<R> {
  final String status; // 'fulfilled' | 'rejected'
  final R? value;
  final dynamic reason;

  const QueueTaskResult({
    required this.status,
    this.value,
    this.reason,
  });
}

/// Hàng đợi bất đồng bộ giới hạn số luồng chạy song song (`concurrency = 2`),
/// bảo toàn thứ tự kết quả và cô lập lỗi của từng phần tử.
Future<List<QueueTaskResult<R>>> runBoundedConcurrencyQueue<T, R>(
  List<T> items,
  int concurrency,
  Future<R> Function(T item, int index) workerFn,
) async {
  if (items.isEmpty) return [];

  final limit = math.max(1, math.min(concurrency, items.length));
  final results = List<QueueTaskResult<R>?>.filled(items.length, null);
  int cursor = 0;

  Future<void> runWorker() async {
    while (true) {
      final idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;

      try {
        final val = await workerFn(items[idx], idx);
        results[idx] = QueueTaskResult<R>(status: 'fulfilled', value: val);
      } catch (err) {
        results[idx] = QueueTaskResult<R>(status: 'rejected', reason: err);
      }
    }
  }

  final workers = List.generate(limit, (_) => runWorker());
  await Future.wait(workers);
  return results.whereType<QueueTaskResult<R>>().toList();
}

class BatchPhotoImportRow {
  final Map<String, dynamic> raw;
  final Map<String, dynamic>? meter;
  final num? prevReading;
  final num? baselineAvg;
  final double? consumption;
  final int? diffPct;
  final bool isAbnormal;
  final bool isInvalidReading;
  final bool hasReadingInput;
  final int? estimatedAmount;
  final bool hasTypeMismatchWarning;
  final String validationState;
  final bool isSaveable;

  const BatchPhotoImportRow({
    required this.raw,
    required this.meter,
    required this.prevReading,
    required this.baselineAvg,
    required this.consumption,
    required this.diffPct,
    required this.isAbnormal,
    required this.isInvalidReading,
    required this.hasReadingInput,
    required this.estimatedAmount,
    required this.hasTypeMismatchWarning,
    required this.validationState,
    required this.isSaveable,
  });
}

class BatchPhotoImportSummary {
  final int totalCount;
  final int processingCount;
  final int saveableCount;
  final int abnormalSaveableCount;
  final int abnormalMissingNoteCount;
  final int duplicateCount;
  final int lockedCount;
  final int missingMeterCount;
  final int missingOrInvalidReadingCount;
  final int skippedCount;

  const BatchPhotoImportSummary({
    required this.totalCount,
    required this.processingCount,
    required this.saveableCount,
    required this.abnormalSaveableCount,
    required this.abnormalMissingNoteCount,
    required this.duplicateCount,
    required this.lockedCount,
    required this.missingMeterCount,
    required this.missingOrInvalidReadingCount,
    required this.skippedCount,
  });
}

class BatchPhotoImportEvaluation {
  final List<BatchPhotoImportRow> rows;
  final List<BatchPhotoImportRow> saveableRows;
  final BatchPhotoImportSummary summary;

  const BatchPhotoImportEvaluation({
    required this.rows,
    required this.saveableRows,
    required this.summary,
  });
}

/// Đánh giá toàn bộ danh sách ảnh trong Modal đối soát trước khi Lưu nháp / Lưu & Chốt (FR-030).
BatchPhotoImportEvaluation evaluateBatchPhotoImportItems(
  List<dynamic> items,
  List<dynamic> buildingMeters, {
  num anomalyThresholdPct = 30,
  bool canWriteMeters = true,
}) {
  final List<Map<String, dynamic>> meters = [];
  for (final m in buildingMeters) {
    if (m is Map) meters.add(Map<String, dynamic>.from(m));
  }
  final meterById = {
    for (final m in meters)
      if (m['id'] != null) m['id'].toString(): m
  };

  final Map<String, int> meterTargetCounts = {};
  for (final it in items) {
    if (it is Map && it['meterId'] != null) {
      final k = it['meterId'].toString();
      meterTargetCounts[k] = (meterTargetCounts[k] ?? 0) + 1;
    }
  }

  final List<BatchPhotoImportRow> rows = [];
  for (final raw in items) {
    final it = raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    final meterIdStr = it['meterId']?.toString();
    final meter = meterIdStr != null ? meterById[meterIdStr] : null;

    final ocrStatus = it['ocrStatus']?.toString();
    final isProcessing = ocrStatus == 'PENDING' || ocrStatus == 'PROCESSING';
    final isDuplicateTarget = meter != null && (meterTargetCounts[meter['id']?.toString()] ?? 0) > 1;
    final isLocked = meter != null ? isMeterRowLockedForEdit(meter, canWriteMeters) : false;

    final prevReading = meter != null ? _resolveMeterPreviousBaseline(meter) : null;
    final baselineAvg = meter != null ? _resolveMeterRollingAvg(meter) : null;

    final draftReadingVal = it['draftReading'];
    final anomaly = meter != null
        ? evaluateClientMeterAnomaly(
            prevReading: prevReading,
            currentReading: draftReadingVal,
            baselineAvg: baselineAvg,
            thresholdPct: anomalyThresholdPct,
          )
        : evaluateClientMeterAnomaly(
            prevReading: 0,
            currentReading: draftReadingVal,
            baselineAvg: null,
            thresholdPct: anomalyThresholdPct,
          );

    bool isAbnormal = anomaly.isAbnormal;
    if (meter != null &&
        !isAbnormal &&
        meter['period_is_abnormal'] == true &&
        anomaly.hasInput &&
        !anomaly.isInvalid &&
        meter['period_current_reading'] != null) {
      final num? dVal = num.tryParse(draftReadingVal?.toString() ?? '');
      final num? pVal = num.tryParse(meter['period_current_reading'].toString());
      if (dVal != null && pVal != null && dVal == pVal) {
        isAbnormal = true;
      }
    }

    final estimatedAmount = (meter != null && anomaly.hasInput && !anomaly.isInvalid)
        ? computeMeterEstimatedAmount(anomaly.consumption, meter)
        : null;

    final detType = it['detectedMeterType']?.toString().toUpperCase();
    final hasTypeMismatchWarning = meter != null &&
        detType != null &&
        (detType == 'ELECTRICITY' || detType == 'WATER') &&
        meter['meter_type'] != detType;

    String validationState = 'READY';
    bool isSaveable = false;

    if (isProcessing) {
      validationState = 'OCR_PROCESSING';
    } else if (meter == null) {
      validationState = 'MISSING_METER';
    } else if (isLocked) {
      validationState = 'LOCKED_BILLED';
    } else if (isDuplicateTarget) {
      validationState = 'DUPLICATE_METER_TARGET';
    } else if (!anomaly.hasInput) {
      validationState = 'MISSING_READING';
    } else if (anomaly.isInvalid) {
      validationState = 'INVALID_READING';
    } else if (isAbnormal) {
      validationState = 'READY_ABNORMAL';
      isSaveable = true;
    } else {
      validationState = 'READY';
      isSaveable = true;
    }

    rows.add(BatchPhotoImportRow(
      raw: it,
      meter: meter,
      prevReading: prevReading,
      baselineAvg: baselineAvg,
      consumption: anomaly.consumption,
      diffPct: anomaly.diffPct,
      isAbnormal: isAbnormal,
      isInvalidReading: anomaly.isInvalid,
      hasReadingInput: anomaly.hasInput,
      estimatedAmount: estimatedAmount,
      hasTypeMismatchWarning: hasTypeMismatchWarning,
      validationState: validationState,
      isSaveable: isSaveable,
    ));
  }

  final saveableRows = rows.where((r) => r.isSaveable).toList();
  final summary = BatchPhotoImportSummary(
    totalCount: rows.length,
    processingCount: rows.where((r) => r.validationState == 'OCR_PROCESSING').length,
    saveableCount: saveableRows.length,
    abnormalSaveableCount: saveableRows.where((r) => r.isAbnormal).length,
    abnormalMissingNoteCount: saveableRows.where(
      (r) => r.isAbnormal && (r.raw['abnormalNote']?.toString().trim().isEmpty ?? true),
    ).length,
    duplicateCount: rows.where((r) => r.validationState == 'DUPLICATE_METER_TARGET').length,
    lockedCount: rows.where((r) => r.validationState == 'LOCKED_BILLED').length,
    missingMeterCount: rows.where((r) => r.validationState == 'MISSING_METER').length,
    missingOrInvalidReadingCount: rows.where(
      (r) => r.validationState == 'MISSING_READING' || r.validationState == 'INVALID_READING',
    ).length,
    skippedCount: rows.length - saveableRows.length,
  );

  return BatchPhotoImportEvaluation(
    rows: rows,
    saveableRows: saveableRows,
    summary: summary,
  );
}

/// Đóng gói dữ liệu gửi lên `POST /api/v1/meters/readings/batch` kèm ảnh bằng chứng và `ai_suggestion_id`.
Map<String, dynamic> buildBatchPhotoSavePayload({
  List<dynamic> saveableRows = const [],
  required String period,
  String targetStatus = 'DRAFT',
}) {
  final List<Map<String, dynamic>> readings = [];

  for (final raw in saveableRows) {
    Map<String, dynamic>? targetMeter;
    dynamic draftReading;
    String? abnormalNote;
    String? imageDataUri;
    String? suggestionId;

    if (raw is BatchPhotoImportRow) {
      if (!raw.isSaveable || raw.meter == null || raw.meter!['id'] == null) continue;
      targetMeter = raw.meter;
      draftReading = raw.raw['draftReading'];
      abnormalNote = raw.raw['abnormalNote']?.toString();
      imageDataUri = raw.raw['imageDataUri']?.toString();
      suggestionId = raw.raw['suggestionId']?.toString();
    } else if (raw is Map) {
      if (raw['isSaveable'] != true && raw['meter'] == null) continue;
      targetMeter = raw['meter'] is Map ? (raw['meter'] as Map<String, dynamic>) : null;
      if (targetMeter == null || targetMeter['id'] == null) continue;
      draftReading = raw['draftReading'];
      abnormalNote = raw['abnormalNote']?.toString();
      imageDataUri = raw['imageDataUri']?.toString();
      suggestionId = raw['suggestionId']?.toString();
    } else {
      continue;
    }

    if (targetMeter == null || targetMeter['id'] == null) continue;

    final num? readingNum = num.tryParse(draftReading?.toString() ?? '');
    final entry = <String, dynamic>{
      'meter_id': targetMeter['id'],
      'current_reading': readingNum ?? 0,
    };

    if (targetMeter['target_contract_id'] != null) {
      entry['contract_id'] = targetMeter['target_contract_id'];
    }
    final trimmedNote = abnormalNote?.trim();
    if (trimmedNote != null && trimmedNote.isNotEmpty) {
      entry['abnormal_note'] = trimmedNote;
    }
    if (imageDataUri != null && imageDataUri.startsWith('data:image/')) {
      entry['image_base64'] = imageDataUri;
    }
    if (suggestionId != null && suggestionId.isNotEmpty) {
      entry['ai_suggestion_id'] = suggestionId;
    }

    readings.add(entry);
  }

  return {
    'period': period,
    'status': targetStatus,
    'hold_if_abnormal': true,
    'readings': readings,
  };
}
