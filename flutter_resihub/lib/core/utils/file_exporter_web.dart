import 'dart:js_interop';
import 'dart:typed_data';
import 'package:web/web.dart' as web;

/// Tự động tải xuống tệp bytes trên trình duyệt thông qua thẻ `<a>` kèm blob URL.
Future<void> saveOrShareBytesPlatform(
  Uint8List bytes, {
  required String fileName,
  required String mimeType,
  String? shareSubject,
}) async {
  final jsBytes = bytes.toJS;
  final blobParts = [jsBytes].toJS;
  final options = web.BlobPropertyBag(type: mimeType);
  final blob = web.Blob(blobParts, options);
  final url = web.URL.createObjectURL(blob);
  final anchor = web.document.createElement('a') as web.HTMLAnchorElement;
  anchor.href = url;
  anchor.download = fileName;
  web.document.body?.appendChild(anchor);
  anchor.click();
  web.document.body?.removeChild(anchor);
  web.URL.revokeObjectURL(url);
}
