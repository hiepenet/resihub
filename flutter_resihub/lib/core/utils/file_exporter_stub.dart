import 'dart:io';
import 'dart:typed_data';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

/// Lưu hoặc chia sẻ tệp bytes trên Android / iOS / Desktop thông qua hộp thoại Share hệ thống.
Future<void> saveOrShareBytesPlatform(
  Uint8List bytes, {
  required String fileName,
  required String mimeType,
  String? shareSubject,
}) async {
  final tempDir = await getTemporaryDirectory();
  final filePath = '${tempDir.path}/$fileName';
  final file = File(filePath);
  await file.writeAsBytes(bytes, flush: true);
  await Share.shareXFiles(
    [XFile(filePath, mimeType: mimeType, name: fileName)],
    subject: shareSubject,
  );
}
