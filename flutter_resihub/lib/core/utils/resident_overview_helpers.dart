import 'dart:convert';

/// Nhãn tiện ích, copy nguyên vẹn từ `AMENITY_LABELS` (OverviewTab.jsx:48-71).
const Map<String, String> kResidentAmenityLabels = <String, String>{
  'wifi': 'Wi-Fi tốc độ cao',
  'internet': 'Internet cáp quang',
  'air_conditioner': 'Điều hòa nhiệt độ',
  'ac': 'Điều hòa',
  'water_heater': 'Bình nóng lạnh',
  'elevator': 'Thang máy thẻ từ',
  'fridge': 'Tủ lạnh',
  'refrigerator': 'Tủ lạnh',
  'washing_machine': 'Máy giặt',
  'washer': 'Máy giặt',
  'kitchen': 'Bếp & hút mùi',
  'balcony': 'Ban công thoáng',
  'parking': 'Bãi đỗ xe',
  'security_24_7': 'An ninh 24/7',
  'security': 'An ninh 24/7',
  'tv': 'Smart TV',
  'bed': 'Giường & nệm',
  'wardrobe': 'Tủ quần áo',
  'sofa': 'Sofa phòng khách',
  'desk': 'Bàn làm việc',
  'microwave': 'Lò vi sóng',
  'pool': 'Hồ bơi nội khu',
  'gym': 'Phòng Gym',
};

/// Tương đương `Boolean(x)` của JS, dùng để lọc phần tử giả như JS `.filter(Boolean)`.
bool _isTruthy(dynamic value) {
  if (value == null) return false;
  if (value is bool) return value;
  if (value is num) return value != 0;
  if (value is String) return value.isNotEmpty;
  if (value is Iterable) return value.isNotEmpty;
  if (value is Map) return value.isNotEmpty;
  return true;
}

String _titleCase(String text) => text.replaceAllMapped(
      RegExp(r'\b\w'),
      (match) => match.group(0)!.toUpperCase(),
    );

String? _amenityLabelFromListItem(dynamic item) {
  if (!_isTruthy(item)) return null;
  if (item is String) return kResidentAmenityLabels[item] ?? item;
  if (item is Map) {
    final label = item['label'];
    if (_isTruthy(label)) return label.toString();
    final name = item['name'];
    if (_isTruthy(name)) return name.toString();
    final code = item['code'];
    if (code != null) {
      return kResidentAmenityLabels[code.toString()] ?? code.toString();
    }
  }
  return null;
}

/// Chuyển `active_contract.amenities` (list / JSON string / chuỗi phẩy / map)
/// thành danh sách nhãn hiển thị, khớp `parseAmenities()` trong React.
List<String> parseResidentAmenities(dynamic raw) {
  if (raw == null) return const <String>[];

  dynamic parsed = raw;
  if (raw is String) {
    try {
      parsed = jsonDecode(raw);
    } catch (_) {
      return raw
          .split(',')
          .map((part) => part.trim())
          .where((part) => part.isNotEmpty)
          .map((token) => kResidentAmenityLabels[token] ?? token)
          .toList();
    }
  }

  if (parsed is List) {
    final labels = <String>[];
    for (final item in parsed) {
      final label = _amenityLabelFromListItem(item);
      if (label != null && label.isNotEmpty) labels.add(label);
    }
    return labels;
  }

  if (parsed is Map) {
    final labels = <String>[];
    parsed.forEach((key, value) {
      if (!_isTruthy(value)) return;
      final keyStr = key.toString();
      if (value is String) {
        final trimmed = value.trim();
        if (trimmed.isNotEmpty && trimmed != 'true') {
          labels.add(trimmed);
          return;
        }
      }
      final mapped = kResidentAmenityLabels[keyStr];
      if (mapped != null) {
        labels.add(mapped);
        return;
      }
      labels.add(_titleCase(keyStr.replaceAll('_', ' ')));
    });
    return labels;
  }

  return const <String>[];
}

/// Số ngày còn lại đến `endDate`, tính theo ngày lịch (bỏ giờ), khớp
/// `getDaysRemaining()` trong React. Trả về `null` khi ngày không hợp lệ.
int? getResidentDaysRemaining(Object? endDate) {
  if (endDate == null) return null;
  // ponytail: DateTime.tryParse chỉ nhận ISO; JS new Date() nhận thêm định dạng
  // locale — thêm parser nếu API trả về dạng đó.
  final end =
      endDate is DateTime ? endDate : DateTime.tryParse(endDate.toString());
  if (end == null) return null;

  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final endDay = DateTime(end.year, end.month, end.day);
  final diffMs = endDay.millisecondsSinceEpoch - today.millisecondsSinceEpoch;
  return (diffMs / Duration.millisecondsPerDay).ceil();
}
