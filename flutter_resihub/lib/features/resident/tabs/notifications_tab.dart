import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../shared/providers/notification_provider.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_modal.dart';

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

class _NotificationsTabState extends ConsumerState<NotificationsTab> {
  String _filter = 'ALL';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(notificationProvider.notifier).fetchNotifications();
    });
  }

  void _showNotificationDetail(BuildContext context, Map<String, dynamic> notif) {
    final title = notif['title']?.toString() ?? 'Thông báo';
    final content = notif['content']?.toString() ?? notif['message']?.toString() ?? '';
    final createdAt = notif['created_at'];
    final id = notif['id']?.toString() ?? '';

    if (notif['read_at'] == null && id.isNotEmpty) {
      ref.read(notificationProvider.notifier).markAsRead(id);
    }

    AppModal.show(
      context: context,
      title: title,
      subtitle: createdAt != null ? formatDateTime(createdAt) : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            content,
            style: const TextStyle(
              fontSize: 14,
              color: AppColors.slate800,
              height: 1.5,
            ),
          ),
          const SizedBox(height: 20),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              AppButton(
                text: 'Đóng',
                variant: AppButtonVariant.outline,
                onPressed: () => Navigator.of(context).pop(),
              ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final notifState = ref.watch(notificationProvider);
    final allNotifications = notifState.notifications;

    final filtered = _filter == 'UNREAD'
        ? allNotifications.where((n) => n['read_at'] == null).toList()
        : allNotifications;

    return RefreshIndicator(
      onRefresh: () async {
        await ref.read(notificationProvider.notifier).fetchNotifications();
      },
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    _buildFilterChip('Tất cả', 'ALL', allNotifications.length),
                    const SizedBox(width: 8),
                    _buildFilterChip('Chưa đọc', 'UNREAD', notifState.unreadCount),
                  ],
                ),
                if (notifState.unreadCount > 0)
                  AppButton(
                    text: 'Đọc tất cả',
                    size: AppButtonSize.sm,
                    variant: AppButtonVariant.ghost,
                    onPressed: () {
                      ref.read(notificationProvider.notifier).markAllAsRead();
                      ref.read(toastProvider.notifier).success('Đã đánh dấu đọc tất cả thông báo.');
                    },
                  ),
              ],
            ),
            const SizedBox(height: 16),
            if (filtered.isEmpty)
              Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(LucideIcons.bellOff, size: 48, color: AppColors.slate400),
                      const SizedBox(height: 12),
                      const Text(
                        'Không có thông báo nào',
                        style: TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          color: AppColors.slate800,
                        ),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Các tin tức tòa nhà và thông báo tài chính sẽ hiển thị tại đây.',
                        style: TextStyle(fontSize: 13, color: AppColors.slate500),
                      ),
                    ],
                  ),
                ),
              )
            else
              ...filtered.map((n) {
                final isRead = n['read_at'] != null;
                final title = n['title']?.toString() ?? 'Thông báo';
                final content = n['content']?.toString() ?? n['message']?.toString() ?? '';
                final createdAt = n['created_at'];

                return InkWell(
                  onTap: () => _showNotificationDetail(context, n),
                  borderRadius: BorderRadius.circular(14),
                  child: Container(
                    margin: const EdgeInsets.only(bottom: 10),
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: isRead ? Colors.white : AppColors.primary50.withValues(alpha: 0.4),
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(
                        color: isRead ? AppColors.slate200 : AppColors.primary200,
                      ),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: isRead ? AppColors.slate100 : AppColors.primary100,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Icon(
                            isRead ? LucideIcons.bell : LucideIcons.bellRing,
                            size: 18,
                            color: isRead ? AppColors.slate600 : AppColors.primary600,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Expanded(
                                    child: Text(
                                      title,
                                      style: TextStyle(
                                        fontFamily: 'Inter',
                                        fontSize: 14,
                                        fontWeight: isRead ? FontWeight.w600 : FontWeight.bold,
                                        color: AppColors.slate900,
                                      ),
                                    ),
                                  ),
                                  if (!isRead)
                                    Container(
                                      width: 8,
                                      height: 8,
                                      decoration: const BoxDecoration(
                                        color: AppColors.rose500,
                                        shape: BoxShape.circle,
                                      ),
                                    ),
                                ],
                              ),
                              const SizedBox(height: 4),
                              Text(
                                content,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 13, color: AppColors.slate600),
                              ),
                              if (createdAt != null) ...[
                                const SizedBox(height: 6),
                                Text(
                                  formatDateTime(createdAt),
                                  style: const TextStyle(fontSize: 11, color: AppColors.slate400),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }

  Widget _buildFilterChip(String label, String value, int count) {
    final isSelected = _filter == value;
    return InkWell(
      onTap: () => setState(() => _filter = value),
      borderRadius: BorderRadius.circular(20),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: isSelected ? AppColors.primary600 : Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(
            color: isSelected ? AppColors.primary600 : AppColors.slate200,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              label,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 12,
                fontWeight: isSelected ? FontWeight.bold : FontWeight.w500,
                color: isSelected ? Colors.white : AppColors.slate700,
              ),
            ),
            if (count > 0) ...[
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(
                  color: isSelected ? Colors.white24 : AppColors.slate100,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  '$count',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                    color: isSelected ? Colors.white : AppColors.slate600,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
