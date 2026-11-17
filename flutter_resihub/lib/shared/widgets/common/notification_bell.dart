import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/notification_navigation.dart';
import '../../../features/auth/providers/auth_provider.dart';
import '../../../features/buildings/services/buildings_service.dart';
import '../../providers/notification_provider.dart';
import 'notification_detail_modal.dart';

/// Notification Bell icon button with unread badge, popover / modal sheet list,
/// deep-link action dispatching, and detail modal view.
/// Port of `frontend/src/components/common/NotificationBell.jsx`.
class NotificationBell extends ConsumerStatefulWidget {
  final VoidCallback? onViewAll;

  const NotificationBell({
    super.key,
    this.onViewAll,
  });

  @override
  ConsumerState<NotificationBell> createState() => _NotificationBellState();
}

class _NotificationBellState extends ConsumerState<NotificationBell> {
  Timer? _pollingTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(notificationProvider.notifier).fetchNotifications();
    });
    // Poll every 60s matching React useEffect
    _pollingTimer = Timer.periodic(const Duration(seconds: 60), (_) {
      ref.read(notificationProvider.notifier).fetchNotifications();
    });
  }

  @override
  void dispose() {
    _pollingTimer?.cancel();
    super.dispose();
  }

  /// Extracts building ids from a buildings list payload (cache or fresh fetch).
  static List<String> _buildingIdsFrom(dynamic res) {
    final data = res is Map ? res['data'] : res;
    if (data is! List) return const [];
    return data
        .whereType<Map>()
        .map((b) => b['id']?.toString() ?? '')
        .where((id) => id.isNotEmpty)
        .toList();
  }

  Future<void> _handleNotificationClick(Map<String, dynamic> notif) async {
    final notifier = ref.read(notificationProvider.notifier);
    notifier.markAsRead(notif['id'], notif);

    final authState = ref.read(authProvider);
    final userRole = authState.user?.primaryRole.name.toUpperCase();
    final isAdminPortal = authState.isAdminPortal;

    final action = resolveNotificationAction(
      notif,
      role: userRole,
      isAdminPortal: isAdminPortal,
    );

    // E10: match React useNotificationAction - sync the active building filter
    // to the notification's target building before navigating (admin only).
    if (isAdminPortal &&
        action.buildingId != null &&
        action.buildingId!.isNotEmpty &&
        authState.selectedBuildingId.isNotEmpty &&
        authState.selectedBuildingId != action.buildingId) {
      final buildingsService = ref.read(buildingsServiceProvider);
      List<String> accessibleIds = _buildingIdsFrom(buildingsService.peekList());
      if (accessibleIds.isEmpty) {
        try {
          accessibleIds = _buildingIdsFrom(await buildingsService.list());
        } catch (_) {
          accessibleIds = const [];
        }
      }
      if (mounted) {
        syncBuildingFilterBeforeNavigate(
          action.buildingId,
          selectedBuildingId: authState.selectedBuildingId,
          accessibleBuildingIds: accessibleIds,
          setSelectedBuildingId: (id) =>
              ref.read(authProvider.notifier).setSelectedBuildingId(id),
        );
      }
    }

    if (!mounted) return;

    if (action.kind == NotificationActionKind.navigate && action.url != null) {
      final router = GoRouter.maybeOf(context);
      if (router != null) {
        router.go(action.url!);
      }
    } else {
      NotificationDetailModal.show(
        context: context,
        notification: notif,
        fallbackUrl: action.fallbackUrl,
        fallbackLabel: action.actionLabel,
        onNavigateFallback: (url) {
          final router = GoRouter.maybeOf(context);
          router?.go(url);
        },
      );
    }
  }

  void _openNotificationsSheet() {
    final notifier = ref.read(notificationProvider.notifier);

    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (sheetContext) {
        return Consumer(
          builder: (ctx, refWatch, _) {
            final liveState = refWatch.watch(notificationProvider);
            final items = liveState.notifications.take(12).toList();
            final unread = liveState.unreadCount;

            return Container(
              constraints: BoxConstraints(
                maxHeight: MediaQuery.of(ctx).size.height * 0.75,
              ),
              decoration: const BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          'Thông báo ($unread chưa đọc)',
                          style: const TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w700,
                            color: AppColors.slate900,
                          ),
                        ),
                        if (unread > 0)
                          InkWell(
                            onTap: () => notifier.markAllAsRead(),
                            child: const Row(
                              children: [
                                Icon(
                                  LucideIcons.checkCheck,
                                  size: 15,
                                  color: AppColors.primary600,
                                ),
                                SizedBox(width: 4),
                                Text(
                                  'Đọc tất cả',
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w600,
                                    color: AppColors.primary600,
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
                  ),
                  const Divider(height: 1, color: AppColors.slate100),
                  Flexible(
                    child: items.isEmpty
                        ? const Padding(
                            padding: EdgeInsets.symmetric(vertical: 36.0),
                            child: Center(
                              child: Text(
                                'Chưa có thông báo nào.',
                                style: TextStyle(
                                  fontSize: 13,
                                  color: AppColors.slate400,
                                ),
                              ),
                            ),
                          )
                        : ListView.separated(
                            shrinkWrap: true,
                            itemCount: items.length,
                            separatorBuilder: (_, __) => const Divider(
                              height: 1,
                              color: AppColors.slate100,
                            ),
                            itemBuilder: (ctx, idx) {
                              final n = items[idx];
                              final isUnread = n['read_at'] == null || n['read_at'].toString().isEmpty;
                              final title = n['title']?.toString() ?? '';
                              final content = n['content']?.toString() ?? '';
                              final createdAt = n['created_at']?.toString();

                              final auth = ref.read(authProvider);
                              final actionMeta = resolveNotificationAction(
                                n,
                                role: auth.user?.primaryRole.name.toUpperCase(),
                                isAdminPortal: auth.isAdminPortal,
                              );

                              return InkWell(
                                onTap: () {
                                  Navigator.of(sheetContext).pop();
                                  _handleNotificationClick(n);
                                },
                                child: Container(
                                  color: isUnread ? const Color(0xFFF0FDF4).withValues(alpha: 0.3) : Colors.transparent,
                                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                                  child: Row(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Container(
                                        width: 8,
                                        height: 8,
                                        margin: const EdgeInsets.only(top: 5, right: 10),
                                        decoration: BoxDecoration(
                                          color: isUnread ? AppColors.primary600 : Colors.transparent,
                                          shape: BoxShape.circle,
                                        ),
                                      ),
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              title,
                                              style: TextStyle(
                                                fontSize: 13,
                                                fontWeight: isUnread ? FontWeight.w600 : FontWeight.w500,
                                                color: AppColors.slate900,
                                              ),
                                            ),
                                            if (content.isNotEmpty) ...[
                                              const SizedBox(height: 2),
                                              Text(
                                                content,
                                                maxLines: 2,
                                                overflow: TextOverflow.ellipsis,
                                                style: const TextStyle(
                                                  fontSize: 12,
                                                  color: AppColors.slate600,
                                                ),
                                              ),
                                            ],
                                            const SizedBox(height: 6),
                                            Row(
                                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                              children: [
                                                if (createdAt != null)
                                                  Text(
                                                    formatRelativeTime(createdAt),
                                                    style: const TextStyle(
                                                      fontSize: 11,
                                                      color: AppColors.slate400,
                                                    ),
                                                  ),
                                                Row(
                                                  children: [
                                                    Text(
                                                      actionMeta.actionLabel,
                                                      style: const TextStyle(
                                                        fontSize: 11,
                                                        fontWeight: FontWeight.w600,
                                                        color: AppColors.primary600,
                                                      ),
                                                    ),
                                                    const SizedBox(width: 2),
                                                    const Icon(
                                                      LucideIcons.arrowRight,
                                                      size: 11,
                                                      color: AppColors.primary600,
                                                    ),
                                                  ],
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
                            },
                          ),
                  ),
                  if (widget.onViewAll != null) ...[
                    const Divider(height: 1, color: AppColors.slate100),
                    InkWell(
                      onTap: () {
                        Navigator.of(sheetContext).pop();
                        widget.onViewAll!();
                      },
                      child: Container(
                        width: double.infinity,
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        alignment: Alignment.center,
                        child: const Text(
                          'Xem toàn bộ thông báo',
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            color: AppColors.primary600,
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(notificationProvider);
    final unread = state.unreadCount;

    return Stack(
      children: [
        IconButton(
          icon: const Icon(LucideIcons.bell, size: 20, color: AppColors.slate600),
          tooltip: 'Thông báo',
          onPressed: _openNotificationsSheet,
        ),
        if (unread > 0)
          Positioned(
            top: 6,
            right: 6,
            child: IgnorePointer(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                decoration: BoxDecoration(
                  color: const Color(0xFFF43F5E), // rose-500
                  borderRadius: BorderRadius.circular(10),
                ),
                constraints: const BoxConstraints(minWidth: 16, minHeight: 16),
                child: Center(
                  child: Text(
                    unread > 99 ? '99+' : '$unread',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 9,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
