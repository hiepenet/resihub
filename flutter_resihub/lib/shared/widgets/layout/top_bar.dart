import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../features/auth/providers/auth_provider.dart';
import '../../../features/buildings/providers/buildings_lookup_provider.dart';
import '../../providers/notification_provider.dart';
import '../common/notification_bell.dart';
import '../common/profile_modal.dart';
import '../ui/app_badge.dart';
import '../ui/app_select.dart';

/// Top bar for Admin Shell with reactive building selector, back navigation,
/// role badge, notification bell, profile modal trigger, and logout.
/// Matches `frontend/src/components/layout/TopBar.jsx`.
class TopBar extends ConsumerStatefulWidget implements PreferredSizeWidget {
  final VoidCallback? onOpenMobileMenu;
  final VoidCallback? onBack;
  final ValueChanged<String>? onNavigate;
  final String? currentPath;

  const TopBar({
    super.key,
    this.onOpenMobileMenu,
    this.onBack,
    this.onNavigate,
    this.currentPath,
  });

  @override
  Size get preferredSize => const Size.fromHeight(64);

  @override
  ConsumerState<TopBar> createState() => _TopBarState();
}

class _TopBarState extends ConsumerState<TopBar> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _syncBuildingSelection();
    });
  }

  void _syncBuildingSelection() {
    if (!mounted) return;
    final asyncVal = ref.read(buildingsListProvider);
    asyncVal.whenData((list) {
      if (!mounted) return;
      final currentSelected = ref.read(authProvider).selectedBuildingId;
      final hasValidSelection = currentSelected.isNotEmpty &&
          list.any((b) => b['id'].toString() == currentSelected);
      if (!hasValidSelection) {
        final nextId = list.length == 1 ? list.first['id'].toString() : '';
        ref.read(authProvider.notifier).setSelectedBuildingId(nextId);
      }
    });
  }

  Future<void> _handleLogout() async {
    try {
      await ref.read(authProvider.notifier).logout();
    } catch (_) {
      // ignore
    } finally {
      ref.read(notificationProvider.notifier).reset();
      if (mounted) {
        final router = GoRouter.maybeOf(context);
        if (router != null) {
          router.go('/login');
        } else {
          widget.onNavigate?.call('/login');
        }
      }
    }
  }

  void _handleBack() {
    if (widget.onBack != null) {
      widget.onBack!();
      return;
    }
    final router = GoRouter.maybeOf(context);
    if (router != null && router.canPop()) {
      router.pop();
    } else if (widget.currentPath != null && widget.currentPath != '/admin/dashboard') {
      if (router != null) {
        router.go('/admin/dashboard');
      } else {
        widget.onNavigate?.call('/admin/dashboard');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // Reactive sync on provider changes
    ref.listen<AsyncValue<List<Map<String, dynamic>>>>(buildingsListProvider, (prev, next) {
      next.whenData((list) {
        final currentSelected = ref.read(authProvider).selectedBuildingId;
        final hasValidSelection = currentSelected.isNotEmpty &&
            list.any((b) => b['id'].toString() == currentSelected);
        if (!hasValidSelection) {
          final nextId = list.length == 1 ? list.first['id'].toString() : '';
          ref.read(authProvider.notifier).setSelectedBuildingId(nextId);
        }
      });
    });

    final authState = ref.watch(authProvider);
    final user = authState.user;
    final primaryRole = authState.primaryRole;
    final selectedBuildingId = authState.selectedBuildingId;

    final buildingsAsync = ref.watch(buildingsListProvider);
    final buildings = buildingsAsync.valueOrNull ?? const [];

    final width = MediaQuery.sizeOf(context).width;
    final isDesktop = width >= 1024;
    final isTabletOrDesktop = width >= 768;
    final isSm = width >= 640;

    final router = GoRouter.maybeOf(context);
    final canGoBack = (router != null && router.canPop()) ||
        (widget.currentPath != null && widget.currentPath != '/admin/dashboard');

    final buildingOptions = buildings.map((b) {
      return AppSelectOption<String>(
        value: b['id'].toString(),
        label: '${b['code']} — ${b['name']}',
        badge: b['code']?.toString(),
        sublabel: b['address']?.toString(),
      );
    }).toList();

    return Container(
      height: 64,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: const BoxDecoration(
        color: Colors.white,
        border: Border(
          bottom: BorderSide(color: AppColors.slate200, width: 1),
        ),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          // Left: Hamburger Menu (mobile/tablet), Back Button, Building Selector
          Expanded(
            child: Row(
              children: [
                if (!isDesktop && widget.onOpenMobileMenu != null)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: IconButton(
                      key: const Key('topbar-mobile-menu-button'),
                      icon: const Icon(LucideIcons.menu, size: 20, color: AppColors.slate700),
                      onPressed: widget.onOpenMobileMenu,
                      tooltip: 'Mở menu điều hướng',
                    ),
                  ),

                // Back Button
                IconButton(
                  key: const Key('topbar-back-button'),
                  icon: const Icon(LucideIcons.arrowLeft, size: 18),
                  color: canGoBack ? AppColors.slate700 : AppColors.slate300,
                  onPressed: canGoBack ? _handleBack : null,
                  tooltip: 'Quay lại trang trước',
                ),
                const SizedBox(width: 8),

                // Building Selector Dropdown (matches TopBar.jsx:112)
                if (buildings.isNotEmpty)
                  Flexible(
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        maxWidth: isDesktop ? 360 : (isTabletOrDesktop ? 280 : 200),
                      ),
                      child: AppSelect<String>(
                        value: selectedBuildingId.isNotEmpty ? selectedBuildingId : null,
                        options: buildingOptions,
                        placeholder: buildings.length > 1
                            ? 'Tất cả tòa nhà trong phạm vi (${buildings.length})'
                            : (buildingOptions.firstOrNull?.label ?? 'Chọn tòa nhà'),
                        searchPlaceholder: 'Tìm nhanh theo mã hoặc tên tòa nhà...',
                        searchable: buildings.length > 3,
                        disabled: buildings.length == 1,
                        icon: const Icon(LucideIcons.building2, size: 16, color: AppColors.slate500),
                        onChanged: (val) {
                          ref.read(authProvider.notifier).setSelectedBuildingId(val ?? '');
                        },
                      ),
                    ),
                  ),
              ],
            ),
          ),

          // Right: Role Badge, Notification Bell, User Avatar/Profile, Logout
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (isTabletOrDesktop) ...[
                AppBadge(
                  label: primaryRole.label,
                  variant: AppBadgeVariant.fromString(primaryRole.badgeVariant),
                ),
                const SizedBox(width: 12),
              ],

              NotificationBell(
                onViewAll: () {
                  final target = '/admin/notifications?tab=inbox';
                  if (widget.onNavigate != null) {
                    widget.onNavigate!(target);
                  } else {
                    GoRouter.maybeOf(context)?.go(target);
                  }
                },
              ),
              const SizedBox(width: 8),

              // Profile Trigger
              InkWell(
                key: const Key('topbar-profile-button'),
                onTap: () => ProfileModal.show(context: context),
                borderRadius: BorderRadius.circular(10),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 32,
                        height: 32,
                        decoration: BoxDecoration(
                          color: AppColors.primary100,
                          borderRadius: BorderRadius.circular(16),
                        ),
                        child: Center(
                          child: Text(
                            (user?.fullName.isNotEmpty == true
                                    ? user!.fullName
                                    : (user?.email ?? 'U'))
                                .substring(0, 1)
                                .toUpperCase(),
                            style: const TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                              color: AppColors.primary700,
                            ),
                          ),
                        ),
                      ),
                      if (isSm) ...[
                        const SizedBox(width: 8),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 160),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(
                                user?.fullName ?? 'Người dùng',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600,
                                  color: AppColors.slate800,
                                  height: 1.2,
                                ),
                              ),
                              Text(
                                user?.email ?? user?.phone ?? '',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 11,
                                  color: AppColors.slate400,
                                  height: 1.2,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 4),

              // Logout Button
              IconButton(
                key: const Key('topbar-logout-button'),
                icon: const Icon(LucideIcons.logOut, size: 18, color: AppColors.slate500),
                onPressed: _handleLogout,
                tooltip: 'Đăng xuất',
              ),
            ],
          ),
        ],
      ),
    );
  }
}
