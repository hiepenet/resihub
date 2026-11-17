import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import 'html_print_preview_stub.dart'
    if (dart.library.js_interop) 'html_print_preview_web.dart';

class HtmlPrintPreviewModal extends StatelessWidget {
  final String title;
  final String htmlContent;
  final String? fileName;

  const HtmlPrintPreviewModal({
    super.key,
    required this.title,
    required this.htmlContent,
    this.fileName,
  });

  static Future<void> show(
    BuildContext context, {
    required String title,
    required String htmlContent,
    String? fileName,
  }) {
    return showDialog<void>(
      context: context,
      barrierColor: AppColors.slate900.withValues(alpha: 0.75),
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: const EdgeInsets.all(16),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 960, maxHeight: 780),
          child: Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          title,
                          style: const TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: AppColors.slate900,
                          ),
                        ),
                      ),
                      IconButton(
                        icon: const Icon(LucideIcons.x, size: 20, color: AppColors.slate500),
                        onPressed: () => Navigator.of(ctx).pop(),
                        splashRadius: 20,
                      ),
                    ],
                  ),
                ),
                const Divider(height: 1),
                Expanded(
                  child: HtmlPrintPreviewModal(
                    title: title,
                    htmlContent: htmlContent,
                    fileName: fileName,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return HtmlPrintPreviewPlatform(
      htmlContent: htmlContent,
      title: title,
    );
  }
}
