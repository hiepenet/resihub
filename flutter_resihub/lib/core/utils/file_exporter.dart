import 'dart:convert';
import 'dart:typed_data';

import 'file_exporter_stub.dart'
    if (dart.library.js_interop) 'file_exporter_web.dart';

/// Cấu hình cột trong tệp CSV xuất ra.
class CsvHeader {
  final String label;
  final String key;
  final dynamic Function(Map<String, dynamic> row)? accessor;

  const CsvHeader({
    required this.label,
    required this.key,
    this.accessor,
  });
}

String _escapeCsvCell(dynamic val) {
  if (val == null) return '';
  final str = val.toString().replaceAll('"', '""');
  if (str.contains(',') || str.contains('"') || str.contains('\n') || str.contains('\r')) {
    return '"$str"';
  }
  return str;
}

/// Tạo mảng bytes CSV kèm tiền tố UTF-8 BOM (`\uFEFF`) để Excel đọc đúng tiếng Việt có dấu.
Uint8List buildUtf8BomCsvBytes({
  required List<CsvHeader> headers,
  required List<Map<String, dynamic>> rows,
}) {
  final headerLine = headers.map((h) => _escapeCsvCell(h.label)).join(',');
  final dataLines = rows.map((row) {
    return headers.map((h) {
      final val = h.accessor != null ? h.accessor!(row) : row[h.key];
      return _escapeCsvCell(val);
    }).join(',');
  }).toList();

  final csvString = '\uFEFF${[headerLine, ...dataLines].join('\r\n')}';
  return Uint8List.fromList(utf8.encode(csvString));
}

/// Lưu hoặc chia sẻ tệp bytes (trên Web tự tải xuống blob, trên Android/iOS/Desktop dùng Share dialog).
Future<void> saveOrShareBytes(
  Uint8List bytes, {
  required String fileName,
  required String mimeType,
  String? shareSubject,
}) {
  return saveOrShareBytesPlatform(
    bytes,
    fileName: fileName,
    mimeType: mimeType,
    shareSubject: shareSubject,
  );
}
