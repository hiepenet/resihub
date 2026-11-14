import 'package:flutter/services.dart';
import 'package:super_clipboard/super_clipboard.dart';
import 'zalo_format.dart';

/// Sao chép tin nhắn Zalo kèm định dạng Rich Text trên Android / iOS / Desktop (sử dụng super_clipboard).
Future<bool> copyZaloRichTextPlatform(String text) async {
  final plainText = stripZaloBoldMarkers(text);
  final htmlText = zaloTextToHtml(text);

  final clipboard = SystemClipboard.instance;
  if (clipboard != null) {
    try {
      final item = DataWriterItem();
      item.add(Formats.htmlText(htmlText));
      item.add(Formats.plainText(plainText));
      await clipboard.write([item]);
      return true;
    } catch (_) {
      // Tiếp tục fallback bên dưới nếu super_clipboard gặp lỗi
    }
  }

  // Fallback về Clipboard chuẩn của Flutter (plain text)
  try {
    await Clipboard.setData(ClipboardData(text: plainText));
    return true;
  } catch (_) {
    return false;
  }
}
