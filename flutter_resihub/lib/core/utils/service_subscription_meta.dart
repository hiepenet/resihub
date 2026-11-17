import 'dart:math' as math;

const int kMaxParkingQuantity = 10;
const int kMinPlateLength = 2;
const int kMaxPlateLength = 30;
const int kMaxNoteLength = 500;

/// Kiểm tra dịch vụ có thuộc nhóm Gửi xe (PARKING) hay không.
bool isParkingService(dynamic svcOrCategory) {
  if (svcOrCategory == null) return false;
  if (svcOrCategory is String) {
    return svcOrCategory.trim().toUpperCase() == 'PARKING';
  }
  if (svcOrCategory is Map) {
    final cat = svcOrCategory['category'] ?? svcOrCategory['service_category'] ?? '';
    return cat.toString().trim().toUpperCase() == 'PARKING';
  }
  return false;
}

/// Kiểm tra dịch vụ có cho phép chọn số lượng > 1 (định dạng QUANTITY hoặc PARKING) hay không.
bool allowsMultiQuantity(dynamic svcOrObj) {
  if (svcOrObj == null || svcOrObj is! Map) return false;
  final billingType = (svcOrObj['billing_type'] ?? '').toString().trim().toUpperCase();
  return billingType == 'QUANTITY' || isParkingService(svcOrObj);
}

/// Đồng bộ mảng danh sách biển số xe theo số lượng xe đăng ký (tối đa 10 xe).
List<String> syncVehiclePlatesArray(dynamic plates, dynamic nextQuantity) {
  final List<String> base = [];
  if (plates is List) {
    for (final p in plates) {
      base.add(p?.toString() ?? '');
    }
  }

  if (nextQuantity == null || nextQuantity.toString().trim().isEmpty) {
    return base.isNotEmpty ? base.take(kMaxParkingQuantity).toList() : [''];
  }

  final num? parsedNum = nextQuantity is num ? nextQuantity : num.tryParse(nextQuantity.toString());
  final int parsed = parsedNum?.floor() ?? 1;
  final int targetLen = math.min(kMaxParkingQuantity, math.max(1, parsed));

  final next = base.take(targetLen).toList();
  while (next.length < targetLen) {
    next.add('');
  }
  return next;
}

String _normalizePlateKey(String plate) {
  return plate.trim().replaceAll(RegExp(r'\s+'), ' ').toUpperCase();
}

class ServiceMetaValidationResult {
  final bool valid;
  final List<String> plateErrors;
  final String quantityError;
  final String noteError;
  final List<String> cleanPlates;
  final String cleanNote;

  const ServiceMetaValidationResult({
    required this.valid,
    required this.plateErrors,
    required this.quantityError,
    required this.noteError,
    required this.cleanPlates,
    required this.cleanNote,
  });
}

/// Xác thực dữ liệu đầu vào khi đăng ký dịch vụ / gói gửi xe (FR-017 / FR-018).
ServiceMetaValidationResult validateServiceMetaInput({
  bool isParking = false,
  dynamic quantity = 1,
  dynamic vehiclePlates,
  dynamic note,
}) {
  num? rawQty;
  if (quantity != null && quantity.toString().trim().isNotEmpty) {
    rawQty = quantity is num ? quantity : num.tryParse(quantity.toString());
  }

  String quantityError = '';
  if (rawQty == null || rawQty.truncateToDouble() != rawQty || rawQty < 1) {
    quantityError = 'Số lượng đăng ký phải là số nguyên dương >= 1.';
  } else if (isParking && rawQty > kMaxParkingQuantity) {
    quantityError = 'Mỗi gói gửi xe chỉ đăng ký tối đa $kMaxParkingQuantity xe.';
  }

  final int safeQty = (rawQty == null || rawQty.truncateToDouble() != rawQty || rawQty < 1)
      ? 1
      : (isParking ? math.min(kMaxParkingQuantity, rawQty.toInt()) : rawQty.toInt());

  final cleanNote = note?.toString().trim() ?? '';
  final String noteError = cleanNote.length > kMaxNoteLength
      ? 'Ghi chú dịch vụ không được vượt quá $kMaxNoteLength ký tự.'
      : '';

  if (!isParking) {
    return ServiceMetaValidationResult(
      valid: quantityError.isEmpty && noteError.isEmpty,
      plateErrors: const [],
      quantityError: quantityError,
      noteError: noteError,
      cleanPlates: const [],
      cleanNote: cleanNote,
    );
  }

  final slots = syncVehiclePlatesArray(vehiclePlates, safeQty);
  final List<String> plateErrors = [];
  final List<String> cleanPlates = [];
  final Set<String> seenKeys = {};

  for (int i = 0; i < safeQty; i++) {
    final trimmed = slots[i].trim();
    if (trimmed.isEmpty) {
      plateErrors.add(
        safeQty == 1 ? 'Vui lòng nhập biển số xe.' : 'Vui lòng nhập biển số xe #${i + 1}.',
      );
      cleanPlates.add('');
      continue;
    }

    if (trimmed.length < kMinPlateLength || trimmed.length > kMaxPlateLength) {
      plateErrors.add(
        'Biển số xe${safeQty > 1 ? ' #${i + 1}' : ''} phải từ $kMinPlateLength đến $kMaxPlateLength ký tự.',
      );
      cleanPlates.add(trimmed);
      continue;
    }

    final cmpKey = _normalizePlateKey(trimmed);
    if (seenKeys.contains(cmpKey)) {
      plateErrors.add('Biển số xe "$trimmed" bị trùng lặp trong cùng gói đăng ký.');
    } else {
      seenKeys.add(cmpKey);
      plateErrors.add('');
    }
    cleanPlates.add(trimmed);
  }

  final hasPlateError = plateErrors.any((e) => e.isNotEmpty);
  return ServiceMetaValidationResult(
    valid: quantityError.isEmpty && noteError.isEmpty && !hasPlateError,
    plateErrors: plateErrors,
    quantityError: quantityError,
    noteError: noteError,
    cleanPlates: cleanPlates,
    cleanNote: cleanNote,
  );
}
