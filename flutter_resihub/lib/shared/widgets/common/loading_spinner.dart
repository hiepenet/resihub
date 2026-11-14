import 'package:flutter/material.dart';

import '../../../core/theme/app_colors.dart';

/// Loading indicator with optional text label and fullScreen presentation mode.
/// Port of `frontend/src/components/common/LoadingSpinner.jsx`.
class LoadingSpinner extends StatelessWidget {
  final String? label;
  final bool fullScreen;

  const LoadingSpinner({
    super.key,
    this.label = 'Đang tải dữ liệu...',
    this.fullScreen = false,
  });

  @override
  Widget build(BuildContext context) {
    final content = Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 40.0),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            const SizedBox(
              width: 28,
              height: 28,
              child: CircularProgressIndicator(
                strokeWidth: 2.5,
                valueColor: AlwaysStoppedAnimation<Color>(AppColors.primary600),
              ),
            ),
            if (label != null && label!.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(
                label!,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: AppColors.slate500,
                ),
              ),
            ],
          ],
        ),
      ),
    );

    if (fullScreen) {
      return Scaffold(body: content);
    }
    return content;
  }
}
