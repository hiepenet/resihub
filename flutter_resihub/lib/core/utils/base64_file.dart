import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:image/image.dart' as img;

/// Mã hóa mảng bytes sang Data URI Base64 kèm xác thực dung lượng (<= 5MB cho ảnh, <= 10MB cho PDF).
String encodeBytesToDataUrl(Uint8List bytes, {required String mimeType}) {
  final mime = mimeType.trim().toLowerCase();
  if (mime.startsWith('image/')) {
    if (bytes.length > 5 * 1024 * 1024) {
      throw ArgumentError('Kích thước ảnh vượt quá giới hạn cho phép (5MB).');
    }
  } else if (mime == 'application/pdf') {
    if (bytes.length > 10 * 1024 * 1024) {
      throw ArgumentError('Kích thước tệp PDF vượt quá giới hạn cho phép (10MB).');
    }
  } else {
    throw ArgumentError('Định dạng tệp không được hỗ trợ: $mimeType');
  }

  final base64Str = base64Encode(bytes);
  return 'data:$mime;base64,$base64Str';
}

/// Nén ảnh sang JPEG Base64 Data URI, tự động thu nhỏ nếu kích thước vượt quá `maxDimension` (mặc định 1280px).
Future<String> compressImageBytesToDataUrl(
  Uint8List bytes, {
  int maxDimension = 1280,
  int jpegQuality = 78,
  String? mimeType,
}) async {
  final mime = (mimeType ?? 'image/jpeg').trim().toLowerCase();
  if (mime == 'application/pdf') {
    return encodeBytesToDataUrl(bytes, mimeType: 'application/pdf');
  }

  final decoded = img.decodeImage(bytes);
  if (decoded == null) {
    return encodeBytesToDataUrl(bytes, mimeType: mime);
  }

  img.Image outputImg = decoded;
  final width = decoded.width;
  final height = decoded.height;

  if (width > maxDimension || height > maxDimension) {
    final scale = min(1.0, maxDimension / max(width, height));
    final targetW = max(1, (width * scale).round());
    final targetH = max(1, (height * scale).round());
    outputImg = img.copyResize(
      decoded,
      width: targetW,
      height: targetH,
      interpolation: img.Interpolation.linear,
    );
  }

  final jpgBytes = Uint8List.fromList(img.encodeJpg(outputImg, quality: jpegQuality));
  return encodeBytesToDataUrl(jpgBytes, mimeType: 'image/jpeg');
}
