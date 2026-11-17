import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../ui/app_badge.dart';
import '../ui/app_button.dart';
import '../ui/app_modal.dart';

/// Modal dialog presenting detailed notification contents, sender info, and deep-link action button.
/// Port of `frontend/src/components/common/NotificationDetailModal.jsx`.
class NotificationDetailModal extends StatelessWidget {
  final Map<String, dynamic>? notification;
  final bool open;
  final VoidCallback? onClose;
  final String? fallbackUrl;
  final String fallbackLabel;
  final ValueChanged<String>? onNavigateFallback;

  const NotificationDetailModal({
    super.key,
    required this.notification,
    this.open = true,
    this.onClose,
    this.fallbackUrl,
    this.fallbackLabel = 'Đi tới trang liên quan',
    this.onNavigateFallback,
  });

  /// Static helper to display the modal cleanly via [showDialog] root overlay.
  static Future<void> show({
    required BuildContext context,
    required Map<String, dynamic>? notification,
    String? fallbackUrl,
    String fallbackLabel = 'Đi tới trang liên quan',
    ValueChanged<String>? onNavigateFallback,
  }) {
    if (notification == null) return Future.value();
    return showDialog<void>(
      context: context,
      builder: (ctx) => NotificationDetailModal(
        notification: notification,
        fallbackUrl: fallbackUrl,
        fallbackLabel: fallbackLabel,
        onNavigateFallback: onNavigateFallback,
        onClose: () => Navigator.of(ctx).pop(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!open || notification == null) return const SizedBox.shrink();

    final notif = notification!;
    final payload = notif['payload'] is Map
        ? Map<String, dynamic>.from(notif['payload'] as Map)
        : <String, dynamic>{};

    final title = notif['title']?.toString() ?? 'Thông báo';
    final content = notif['content']?.toString() ?? 'Không có nội dung chi tiết.';
    final type = notif['type']?.toString() ?? 'THÔNG BÁO';
    final createdAt = notif['created_at']?.toString();
    final senderName = payload['sender_name']?.toString();

    return AppModal(
      title: 'Chi tiết thông báo',
      size: AppModalSize.md,
      onClose: onClose,
      footer: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          AppButton(
            text: 'Đóng',
            variant: AppButtonVariant.outline,
            onPressed: onClose,
          ),
          if (fallbackUrl != null && fallbackUrl!.isNotEmpty && onNavigateFallback != null) ...[
            const SizedBox(width: 8),
            AppButton(
              text: fallbackLabel,
              icon: const Icon(LucideIcons.arrowRight, size: 16),
              variant: AppButtonVariant.primary,
              onPressed: () {
                onClose?.call();
                onNavigateFallback!(fallbackUrl!);
              },
            ),
          ],
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: AppColors.primary50,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.primary100),
                ),
                child: const Icon(
                  LucideIcons.bell,
                  size: 20,
                  color: AppColors.primary600,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      spacing: 8,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        AppBadge(
                          label: type,
                          variant: AppBadgeVariant.sky,
                        ),
                        if (senderName != null && senderName.isNotEmpty)
                          Text(
                            'Từ: $senderName',
                            style: const TextStyle(
                              fontSize: 12,
                              color: AppColors.slate500,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      title,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        color: AppColors.slate900,
                        height: 1.3,
                      ),
                    ),
                    if (createdAt != null && createdAt.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          const Icon(
                            LucideIcons.clock,
                            size: 13,
                            color: AppColors.slate400,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            formatRelativeTime(createdAt),
                            style: const TextStyle(
                              fontSize: 12,
                              color: AppColors.slate400,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.slate200),
            ),
            child: Text(
              content,
              style: const TextStyle(
                fontSize: 13,
                color: AppColors.slate700,
                height: 1.5,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
