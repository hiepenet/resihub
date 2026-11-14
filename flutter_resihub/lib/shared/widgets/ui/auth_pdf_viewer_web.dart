import 'dart:js_interop';
import 'dart:ui_web' as ui_web;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:web/web.dart' as web;

import '../../../core/theme/app_colors.dart';

class AuthPdfViewerPlatform extends StatefulWidget {
  final Uint8List bytes;
  final String title;

  const AuthPdfViewerPlatform({
    super.key,
    required this.bytes,
    this.title = 'Bản scan PDF',
  });

  @override
  State<AuthPdfViewerPlatform> createState() => _AuthPdfViewerPlatformState();
}

class _AuthPdfViewerPlatformState extends State<AuthPdfViewerPlatform> {
  String? _blobUrl;
  late String _viewTypeId;

  @override
  void initState() {
    super.initState();
    _initBlob();
  }

  void _initBlob() {
    final jsBytes = widget.bytes.toJS;
    final blobParts = [jsBytes].toJS;
    final options = web.BlobPropertyBag(type: 'application/pdf');
    final blob = web.Blob(blobParts, options);
    final url = web.URL.createObjectURL(blob);
    _blobUrl = url;

    _viewTypeId = 'pdf-viewer-${DateTime.now().microsecondsSinceEpoch}';

    ui_web.platformViewRegistry.registerViewFactory(_viewTypeId, (int viewId) {
      final iframe = web.document.createElement('iframe') as web.HTMLIFrameElement;
      iframe.src = url;
      iframe.style.border = 'none';
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      return iframe;
    });
  }

  @override
  void didUpdateWidget(covariant AuthPdfViewerPlatform oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!listEquals(oldWidget.bytes, widget.bytes)) {
      if (_blobUrl != null) {
        web.URL.revokeObjectURL(_blobUrl!);
      }
      _initBlob();
      setState(() {});
    }
  }

  @override
  void dispose() {
    if (_blobUrl != null) {
      web.URL.revokeObjectURL(_blobUrl!);
    }
    super.dispose();
  }

  void _openInNewTab() {
    if (_blobUrl != null) {
      web.window.open(_blobUrl!, '_blank');
    }
  }

  void _download() {
    if (_blobUrl != null) {
      final anchor = web.document.createElement('a') as web.HTMLAnchorElement;
      anchor.href = _blobUrl!;
      anchor.download = '${widget.title}.pdf';
      web.document.body?.appendChild(anchor);
      anchor.click();
      web.document.body?.removeChild(anchor);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: const BoxDecoration(
            color: AppColors.slate50,
            border: Border(bottom: BorderSide(color: AppColors.border)),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton.icon(
                onPressed: _openInNewTab,
                icon: const Icon(LucideIcons.externalLink, size: 14),
                label: const Text('Mở tab mới', style: TextStyle(fontSize: 12)),
              ),
              const SizedBox(width: 8),
              TextButton.icon(
                onPressed: _download,
                icon: const Icon(LucideIcons.download, size: 14),
                label: const Text('Tải xuống', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
        ),
        Expanded(
          child: HtmlElementView(viewType: _viewTypeId),
        ),
      ],
    );
  }
}
