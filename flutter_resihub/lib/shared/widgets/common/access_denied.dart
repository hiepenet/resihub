import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../ui/app_button.dart';

/// Screen / component shown when a user lacks authorization (403 Forbidden).
/// Port of `frontend/src/components/common/AccessDenied.jsx`.
class AccessDenied extends StatelessWidget {
  final String message;
  final VoidCallback? onBack;

  const AccessDenied({
    super.key,
    this.message = 'Bạn không có quyền truy cập vào trang hoặc tài nguyên này.',
    this.onBack,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 48.0),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                color: const Color(0xFFFFF1F2), // rose-50
                borderRadius: BorderRadius.circular(16),
              ),
              child: const Icon(
                LucideIcons.shieldAlert,
                size: 28,
                color: Color(0xFFE11D48), // rose-600
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'Truy cập bị từ chối (403)',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w600,
                color: AppColors.slate900,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Text(
                message,
                style: const TextStyle(
                  fontSize: 14,
                  color: AppColors.slate500,
                  height: 1.5,
                ),
                textAlign: TextAlign.center,
              ),
            ),
            const SizedBox(height: 20),
            AppButton(
              text: 'Quay lại',
              icon: const Icon(LucideIcons.arrowLeft, size: 16),
              variant: AppButtonVariant.outline,
              onPressed: () {
                if (onBack != null) {
                  onBack!();
                } else {
                  Navigator.maybePop(context);
                }
              },
            ),
          ],
        ),
      ),
    );
  }
}
