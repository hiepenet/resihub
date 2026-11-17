import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/notification_navigation.dart';
import '../../../shared/providers/notification_provider.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/notification_detail_modal.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_skeleton.dart';
import '../../../shared/widgets/ui/app_tabs.dart';

class NotificationsTab extends ConsumerStatefulWidget {
  final Map<String, dynamic>? overview;
  final Future<void> Function() onRefreshOverview;
  final void Function(String tab, [Map<String, dynamic>? extra]) onNavigateTab;

  const NotificationsTab({
    super.key,
    required this.overview,
    required this.onRefreshOverview,
    required this.onNavigateTab,
  });

  @override
  ConsumerState<NotificationsTab> createState() => _NotificationsTabState();
}

/// Icon/color/label metadata for a notification type.
/// Port of `NotificationsTab.jsx:getNotificationMeta` (lines 29-163).
class _NotificationMeta {
  final IconData icon;
  final Color bg;
  final Color fg;
  final Color border;
  final String label;

  const _NotificationMeta({
    required this.icon,
    required this.bg,
    required this.fg,
    required this.border,
    required this.label,
  });
}

_NotificationMeta _notificationMeta(dynamic rawType) {
  final upper = (rawType?.toString() ?? '').toUpperCase();

  _NotificationMeta meta(
          IconData icon, Color bg, Color fg, Color border, String label) =>
      _NotificationMeta(
          icon: icon, bg: bg, fg: fg, border: border, label: label);

  const emerald =
      (AppColors.emerald50, AppColors.emerald600, AppColors.emerald100);
  const rose = (AppColors.rose50, AppColors.rose600, AppColors.rose100);
  const purple = (AppColors.purple50, AppColors.purple700, AppColors.purple200);
  const sky = (AppColors.sky50, AppColors.primary600, AppColors.primary100);
  const indigo =
      (AppColors.secondary50, AppColors.secondary700, AppColors.secondary100);
  const amber = (AppColors.amber50, AppColors.amber600, AppColors.amber100);

  if (upper.contains('CREDIT')) {
    var label = 'Tín dụng & Hoàn tiền';
    if (upper == 'CREDIT_APPLIED') {
      label = 'Đã cấn trừ tín dụng';
    } else if (upper == 'CREDIT_REFUND_PENDING') {
      label = 'Chờ duyệt hoàn tiền tín dụng';
    } else if (upper == 'CREDIT_REFUNDED') {
      label = 'Đã hoàn tiền tín dụng';
    } else if (upper == 'CREDIT_REFUND_REJECTED') {
      label = 'Từ chối hoàn tiền tín dụng';
    }
    return meta(LucideIcons.receipt, emerald.$1, emerald.$2, emerald.$3, label);
  }
  if (upper == 'PAYMENT_REMINDER') {
    return meta(
        LucideIcons.receipt, rose.$1, rose.$2, rose.$3, 'Nhắc nợ hóa đơn');
  }
  if (upper == 'INVOICE_ADJUSTED' || upper == 'INVOICE_ADJUSTMENT_PENDING') {
    return meta(
      LucideIcons.receipt,
      purple.$1,
      purple.$2,
      purple.$3,
      upper == 'INVOICE_ADJUSTED'
          ? 'Hóa đơn đã điều chỉnh'
          : 'Đang duyệt điều chỉnh hóa đơn',
    );
  }
  if (upper.contains('INVOICE') || upper.contains('PAYMENT')) {
    return meta(
        LucideIcons.receipt, sky.$1, sky.$2, sky.$3, 'Tài chính & Hóa đơn');
  }
  if (upper.contains('CONTRACT') ||
      upper.contains('DEPOSIT') ||
      upper.contains('SETTLEMENT')) {
    return meta(LucideIcons.fileText, indigo.$1, indigo.$2, indigo.$3,
        'Hợp đồng & Sổ cọc');
  }
  if (upper == 'UTILITY_INTERRUPTION') {
    return meta(
        LucideIcons.droplets, sky.$1, sky.$2, sky.$3, 'Thông báo Điện / Nước');
  }
  if (upper == 'MAINTENANCE_NOTICE') {
    return meta(LucideIcons.wrench, amber.$1, amber.$2, amber.$3,
        'Lịch bảo trì tòa nhà');
  }
  if (upper == 'HOUSE_RULES') {
    return meta(LucideIcons.bookOpen, indigo.$1, indigo.$2, indigo.$3,
        'Nhắc nhở Nội quy');
  }
  if (upper == 'SECURITY_ALERT') {
    return meta(LucideIcons.shieldAlert, rose.$1, rose.$2, rose.$3,
        'Cảnh báo An ninh & PCCC');
  }
  if (upper.startsWith('SERVICE_REQUEST_') ||
      upper.contains('SERVICE_REQUEST') ||
      upper == 'MAINTENANCE_UPDATE') {
    final isUrgent = upper == 'SERVICE_REQUEST_URGENT' ||
        upper == 'SERVICE_REQUEST_SLA_BREACH';
    return meta(
      LucideIcons.wrench,
      isUrgent ? rose.$1 : amber.$1,
      isUrgent ? rose.$2 : amber.$2,
      isUrgent ? rose.$3 : amber.$3,
      'Kỹ thuật & Báo hỏng',
    );
  }
  if (upper == 'ANNOUNCEMENT') {
    return meta(LucideIcons.megaphone, purple.$1, purple.$2, purple.$3,
        'Thông báo Ban Quản Lý');
  }
  if (upper.contains('SERVICE_UPDATE') ||
      upper.contains('SUBSCRIPTION') ||
      upper == 'SERVICE_TERMINATED') {
    return meta(
      LucideIcons.sparkles,
      emerald.$1,
      emerald.$2,
      emerald.$3,
      upper == 'SERVICE_TERMINATED'
          ? 'Dịch vụ đã chấm dứt'
          : 'Dịch vụ tiện ích',
    );
  }
  if (upper.contains('APPLICATION') ||
      upper.contains('ONBOARDING') ||
      upper.contains('RESERVATION')) {
    return meta(LucideIcons.home, sky.$1, sky.$2, sky.$3, 'Hồ sơ & Giữ chỗ');
  }
  return meta(LucideIcons.megaphone, purple.$1, purple.$2, purple.$3,
      'Thông báo Ban Quản Lý');
}

class _NotificationsTabState extends ConsumerState<NotificationsTab> {
  String _filter = 'ALL';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(notificationProvider.notifier).fetchNotifications();
    });
  }

  bool _isUnread(Map<String, dynamic> notif) {
    final readAt = notif['read_at'];
    return readAt == null || readAt.toString().isEmpty;
  }

  Map<String, dynamic> _payload(Map<String, dynamic> notif) {
    final raw = notif['payload'];
    if (raw is Map) return Map<String, dynamic>.from(raw);
    return const <String, dynamic>{};
  }

  void _handleNotificationClick(
    Map<String, dynamic> notif, [
    NotificationActionResult? resolvedAction,
  ]) {
    if (_isUnread(notif)) {
      ref.read(notificationProvider.notifier).markAsRead(notif['id'], notif);
    }

    final action = resolvedAction ?? resolveNotificationAction(notif);

    if (action.kind == NotificationActionKind.navigate && action.url != null) {
      GoRouter.maybeOf(context)?.go(action.url!);
      return;
    }

    NotificationDetailModal.show(
      context: context,
      notification: notif,
      fallbackUrl: action.fallbackUrl,
      fallbackLabel: action.actionLabel.isNotEmpty
          ? action.actionLabel
          : 'Đi tới trang liên quan',
      onNavigateFallback: (url) => GoRouter.maybeOf(context)?.go(url),
    );
  }

  Widget _buildNotificationItem(Map<String, dynamic> notif) {
    final isUnread = _isUnread(notif);
    final meta = _notificationMeta(notif['type']);
    final action = resolveNotificationAction(notif);
    final actionLabel =
        action.actionLabel.isNotEmpty ? action.actionLabel : 'Xem chi tiết';
    final senderName = _payload(notif)['sender_name']?.toString();
    final title = notif['title']?.toString() ?? 'Thông báo';
    final content =
        notif['content']?.toString() ?? notif['message']?.toString() ?? '';
    final createdAt = notif['created_at'];
    final readAt = notif['read_at'];

    return InkWell(
      onTap: () => _handleNotificationClick(notif, action),
      borderRadius: BorderRadius.circular(14),
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: isUnread
              ? AppColors.primary50.withValues(alpha: 0.45)
              : Colors.white,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
              color: isUnread ? AppColors.primary200 : AppColors.slate200),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: meta.bg,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: meta.border),
              ),
              child: Icon(meta.icon, size: 20, color: meta.fg),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Wrap(
                          spacing: 8,
                          runSpacing: 4,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            if (isUnread)
                              Container(
                                width: 8,
                                height: 8,
                                decoration: const BoxDecoration(
                                  color: AppColors.primary500,
                                  shape: BoxShape.circle,
                                ),
                              ),
                            Text(
                              title,
                              style: TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 14,
                                fontWeight: isUnread
                                    ? FontWeight.bold
                                    : FontWeight.w600,
                                color: isUnread
                                    ? AppColors.slate900
                                    : AppColors.slate700,
                              ),
                            ),
                            AppBadge(
                              label: meta.label,
                              variant: isUnread
                                  ? AppBadgeVariant.sky
                                  : AppBadgeVariant.slate,
                            ),
                            if (senderName != null && senderName.isNotEmpty)
                              Text(
                                '• Gửi bởi: $senderName',
                                style: const TextStyle(
                                    fontSize: 11, color: AppColors.slate500),
                              ),
                          ],
                        ),
                      ),
                      if (createdAt != null) ...[
                        const SizedBox(width: 8),
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(LucideIcons.clock,
                                size: 13, color: AppColors.slate400),
                            const SizedBox(width: 4),
                            Tooltip(
                              message: formatDateTime(createdAt),
                              child: Text(
                                formatRelativeTime(createdAt),
                                style: const TextStyle(
                                    fontSize: 11, color: AppColors.slate400),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                  if (content.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      content,
                      style: const TextStyle(
                        fontSize: 12,
                        color: AppColors.slate600,
                        height: 1.5,
                      ),
                    ),
                  ],
                  const SizedBox(height: 8),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      if (isUnread)
                        const Text(
                          'Nhấn để xử lý ngay',
                          style: TextStyle(
                            fontSize: 11,
                            color: AppColors.primary600,
                            fontWeight: FontWeight.w500,
                          ),
                        )
                      else
                        Row(
                          children: [
                            const Icon(LucideIcons.checkCircle2,
                                size: 13, color: AppColors.emerald500),
                            const SizedBox(width: 4),
                            Text(
                              'Đã xem lúc ${formatDateTime(readAt)}',
                              style: const TextStyle(
                                  fontSize: 11, color: AppColors.slate400),
                            ),
                          ],
                        ),
                      GestureDetector(
                        onTap: () => _handleNotificationClick(notif, action),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              actionLabel,
                              style: const TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                                color: AppColors.primary600,
                              ),
                            ),
                            const SizedBox(width: 4),
                            const Icon(
                              LucideIcons.arrowRight,
                              size: 14,
                              color: AppColors.primary600,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(bool loading, List<Map<String, dynamic>> filtered) {
    if (loading && filtered.isEmpty) {
      return Column(
        children: List.generate(
          4,
          (_) => const Padding(
            padding: EdgeInsets.only(bottom: 10),
            child: AppSkeleton(
                height: 80,
                borderRadius: BorderRadius.all(Radius.circular(14))),
          ),
        ),
      );
    }

    if (filtered.isEmpty) {
      final isUnreadFilter = _filter == 'UNREAD';
      return EmptyState(
        icon: LucideIcons.bell,
        title: isUnreadFilter
            ? 'Bạn đã đọc hết tất cả thông báo'
            : 'Chưa có thông báo nào',
        description: isUnreadFilter
            ? 'Không còn thông báo mới nào chưa đọc trong hộp thư của bạn.'
            : 'Các bản tin từ Ban Quản Lý và thông báo tự động của hệ thống sẽ xuất hiện tại đây.',
      );
    }

    return Column(children: filtered.map(_buildNotificationItem).toList());
  }

  @override
  Widget build(BuildContext context) {
    final notifState = ref.watch(notificationProvider);
    final allNotifications = notifState.notifications;
    final unreadCount = notifState.unreadCount;

    final filtered = _filter == 'UNREAD'
        ? allNotifications.where(_isUnread).toList()
        : allNotifications;

    return RefreshIndicator(
      onRefresh: () async {
        await ref.read(notificationProvider.notifier).fetchNotifications();
      },
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: AppCard(
          padding: EdgeInsets.zero,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
                child: AppCardHeader(
                  title: 'Hộp thư Thông báo Cư dân',
                  subtitle:
                      'Cập nhật thông báo vận hành tòa nhà, nhắc lịch hóa đơn và tiến độ xử lý yêu cầu',
                  action: unreadCount > 0
                      ? AppButton(
                          text: 'Đánh dấu đọc tất cả ($unreadCount)',
                          size: AppButtonSize.sm,
                          variant: AppButtonVariant.soft,
                          icon: const Icon(LucideIcons.checkCheck, size: 16),
                          onPressed: () {
                            ref
                                .read(notificationProvider.notifier)
                                .markAllAsRead();
                            ref
                                .read(toastProvider.notifier)
                                .success('Đã đánh dấu đọc tất cả thông báo.');
                          },
                        )
                      : null,
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: AppTabs(
                  activeTab: _filter,
                  onChanged: (value) => setState(() => _filter = value),
                  tabs: [
                    AppTabItem(
                        id: 'ALL',
                        label: 'Tất cả',
                        count: allNotifications.length),
                    AppTabItem(
                        id: 'UNREAD', label: 'Chưa đọc', count: unreadCount),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              Padding(
                padding: const EdgeInsets.all(20),
                child: _buildBody(notifState.loading, filtered),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
