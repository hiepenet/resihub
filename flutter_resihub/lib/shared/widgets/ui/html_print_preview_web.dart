import 'dart:js_interop';
import 'dart:ui_web' as ui_web;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:web/web.dart' as web;

import '../../../core/theme/app_colors.dart';

class HtmlPrintPreviewPlatform extends StatefulWidget {
  final String htmlContent;
  final String title;

  const HtmlPrintPreviewPlatform({
    super.key,
    required this.htmlContent,
    this.title = 'Bản in',
  });

  @override
  State<HtmlPrintPreviewPlatform> createState() => _HtmlPrintPreviewPlatformState();
}

class _HtmlPrintPreviewPlatformState extends State<HtmlPrintPreviewPlatform> {
  late final String _viewTypeId;
  web.HTMLIFrameElement? _iframe;

  @override
  void initState() {
    super.initState();
    _viewTypeId = 'html-print-preview-${DateTime.now().microsecondsSinceEpoch}';

    ui_web.platformViewRegistry.registerViewFactory(_viewTypeId, (int viewId) {
      final iframe = web.document.createElement('iframe') as web.HTMLIFrameElement;
      iframe.srcdoc = widget.htmlContent.toJS;
      iframe.style.border = 'none';
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      _iframe = iframe;
      return iframe;
    });
  }

  void _print() {
    _iframe?.contentWindow?.print();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: const BoxDecoration(
            color: AppColors.slate50,
            border: Border(bottom: BorderSide(color: AppColors.border)),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              ElevatedButton.icon(
                onPressed: _print,
                icon: const Icon(LucideIcons.printer, size: 16),
                label: const Text('In / Xuất PDF', style: TextStyle(fontSize: 13)),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary500,
                  foregroundColor: Colors.white,
                ),
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
