import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/ai_helpers.dart';

class AISuggestionField extends StatelessWidget {
  final bool active;
  final bool confirmed;
  final bool edited;
  final dynamic confidence;
  final double threshold;
  final String? warningText;
  final VoidCallback? onConfirm;
  final VoidCallback? onDismiss;
  final Widget child;

  const AISuggestionField({
    super.key,
    this.active = false,
    this.confirmed = false,
    this.edited = false,
    this.confidence,
    this.threshold = 0.75,
    this.warningText,
    this.onConfirm,
    this.onDismiss,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    if (!active) {
      return child;
    }

    final confInfo = confidence != null ? formatConfidenceBadge(confidence, threshold) : null;

    final (badgeBg, badgeText, badgeBorder) = switch (confInfo?.tone) {
      'rose' => (AppColors.rose100, AppColors.rose800, AppColors.rose200),
      'emerald' => (AppColors.emerald100, AppColors.emerald700, AppColors.emerald200),
      _ => (AppColors.amber100, AppColors.amber900, AppColors.amber200),
    };

    final (wrapperBg, wrapperBorder) = confirmed
        ? (AppColors.emerald50.withValues(alpha: 0.35), AppColors.emerald200)
        : (confInfo?.isUncertain ?? false)
            ? (AppColors.rose50.withValues(alpha: 0.45), AppColors.rose300)
            : (AppColors.amber50.withValues(alpha: 0.5), AppColors.amber400);

    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: wrapperBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: wrapperBorder,
          width: confirmed ? 1 : 1.5,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          // Header row with AI tags and Action buttons
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Flexible(
                child: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: AppColors.amber100,
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(color: AppColors.amber300),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            LucideIcons.sparkles,
                            size: 12,
                            color: AppColors.amber600,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            confirmed
                                ? (edited ? 'Đã chỉnh sửa từ AI' : 'Đã xác nhận gợi ý AI')
                                : 'AI đề xuất',
                            style: const TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: AppColors.amber900,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (confInfo != null)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: badgeBg,
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: badgeBorder),
                        ),
                        child: Text(
                          'Tin cậy ${confInfo.percentText}',
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 10,
                            fontWeight: FontWeight.w500,
                            color: badgeText,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (!confirmed && onConfirm != null) ...[
                    InkWell(
                      onTap: onConfirm,
                      borderRadius: BorderRadius.circular(6),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: AppColors.emerald600,
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: const Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(LucideIcons.check, size: 12, color: Colors.white),
                            SizedBox(width: 4),
                            Text(
                              'Xác nhận',
                              style: TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                color: Colors.white,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                  ],
                  if (onDismiss != null)
                    InkWell(
                      onTap: onDismiss,
                      borderRadius: BorderRadius.circular(6),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: const Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(LucideIcons.x, size: 12, color: AppColors.slate600),
                            SizedBox(width: 2),
                            Text(
                              'Bỏ',
                              style: TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 11,
                                fontWeight: FontWeight.w500,
                                color: AppColors.slate600,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 8),

          // Child input widget
          child,

          // Warning text if present
          if (warningText != null && warningText!.isNotEmpty) ...[
            const SizedBox(height: 6),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Padding(
                  padding: EdgeInsets.only(top: 2),
                  child: Icon(
                    LucideIcons.triangleAlert,
                    size: 14,
                    color: AppColors.rose600,
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    warningText!,
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 11,
                      fontWeight: FontWeight.w500,
                      color: AppColors.rose700,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
