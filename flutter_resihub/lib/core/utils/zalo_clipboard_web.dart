import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'package:flutter/services.dart';
import 'package:web/web.dart' as web;
import 'zalo_format.dart';

/// Sao chép tin nhắn Zalo kèm định dạng Rich Text trên Web với 3 tầng fallback:
/// 1. `ClipboardItem` (`text/html` + `text/plain`)
/// 2. Thẻ ẩn `<div contenteditable="true">` kèm `document.execCommand('copy')` (hoạt động tốt cả trên LAN HTTP)
/// 3. `Clipboard.setData` (plain text)
Future<bool> copyZaloRichTextPlatform(String text) async {
  final plainText = stripZaloBoldMarkers(text);
  final htmlText = zaloTextToHtml(text);

  // Tầng 1: ClipboardItem (HTML + Plain)
  try {
    final htmlParts = [htmlText.toJS].toJS;
    final htmlOptions = web.BlobPropertyBag(type: 'text/html');
    final htmlBlob = web.Blob(htmlParts, htmlOptions);

    final plainParts = [plainText.toJS].toJS;
    final plainOptions = web.BlobPropertyBag(type: 'text/plain');
    final plainBlob = web.Blob(plainParts, plainOptions);

    final items = JSObject();
    items['text/html'] = htmlBlob;
    items['text/plain'] = plainBlob;

    final clipboardItem = web.ClipboardItem(items);
    await web.window.navigator.clipboard.write([clipboardItem].toJS).toDart;
    return true;
  } catch (_) {
    // Chuyển sang Tầng 2
  }

  // Tầng 2: Thẻ div contenteditable ẩn + document.execCommand('copy')
  try {
    final container = web.document.createElement('div') as web.HTMLDivElement;
    container.setAttribute('contenteditable', 'true');
    container.innerHTML = htmlText.toJS;
    container.style.position = 'fixed';
    container.style.left = '-9999px';
    container.style.top = '0px';
    container.style.opacity = '0';
    container.style.pointerEvents = 'none';
    container.style.whiteSpace = 'pre-wrap';
    web.document.body?.appendChild(container);

    final selection = web.window.getSelection();
    final range = web.document.createRange();
    range.selectNodeContents(container);
    selection?.removeAllRanges();
    selection?.addRange(range);

    final copied = web.document.execCommand('copy');
    selection?.removeAllRanges();
    web.document.body?.removeChild(container);
    if (copied) return true;
  } catch (_) {
    // Chuyển sang Tầng 3
  }

  // Tầng 3: Flutter plain text clipboard fallback
  try {
    await Clipboard.setData(ClipboardData(text: plainText));
    return true;
  } catch (_) {
    return false;
  }
}
