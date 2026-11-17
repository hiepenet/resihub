import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/navigation.dart';
import '../../../core/storage/app_storage.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/permissions.dart';
import '../../../features/auth/providers/auth_provider.dart';

/// Manages reactive sidebar collapse state persisted in AppStorage.
class SidebarCollapsedNotifier extends Notifier<bool> {
  @override
  bool build() {
    final storage = ref.watch(appStorageProvider);
    return storage.sidebarCollapsed;
  }

  Future<void> toggle() async {
    final storage = ref.read(appStorageProvider);
    final next = !state;
    state = next;
    await storage.setSidebarCollapsed(next);
  }

  Future<void> setCollapsed(bool collapsed) async {
    if (state == collapsed) return;
    final storage = ref.read(appStorageProvider);
    state = collapsed;
    await storage.setSidebarCollapsed(collapsed);
  }
}

/// Provider for reactive sidebar collapse state.
final sidebarCollapsedProvider =
    NotifierProvider<SidebarCollapsedNotifier, bool>(SidebarCollapsedNotifier.new);

/// Responsive Admin Sidebar supporting desktop rail & mobile drawer,
/// role-based menu filtering across SYS_ADMIN / OWNER / MANAGER,
/// route highlighting, and persistent collapse state.
/// Matches `frontend/src/components/layout/Sidebar.jsx`.
class SidebarWidget extends ConsumerWidget {
  final String currentPath;
  final ValueChanged<String>? onNavigate;
  final VoidCallback? onClose;
  final bool collapsible;
  final bool isDrawer;

  const SidebarWidget({
    super.key,
    this.currentPath = '/admin/dashboard',
    this.onNavigate,
    this.onClose,
    this.collapsible = false,
    this.isDrawer = false,
  });

  void _handleItemClick(BuildContext context, String path) {
    if (onClose != null) {
      onClose!();
    }
    if (onNavigate != null) {
      onNavigate!(path);
    } else {
      final router = GoRouter.maybeOf(context);
      if (router != null) {
        router.go(path);
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authProvider.select((s) => s.user));
    final primaryRole = ref.watch(authProvider.select((s) => s.primaryRole));
    final collapsedState = ref.watch(sidebarCollapsedProvider);
    final isCollapsed = collapsible && collapsedState && !isDrawer;

    // Filter navigation groups by user roles
    final filteredGroups = kAdminNavGroups.map((grp) {
      final items = grp.items.where((item) {
        return user != null && hasAnyRole(user, item.roles);
      }).toList();
      return NavGroup(group: grp.group, items: items);
    }).where((grp) => grp.items.isNotEmpty).toList();

    final sidebarWidth = isCollapsed ? 72.0 : 256.0;

    return Container(
      width: sidebarWidth,
      height: double.infinity,
      color: AppColors.slate900,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Brand Header
          Container(
            height: 64,
            padding: EdgeInsets.symmetric(horizontal: isCollapsed ? 12 : 16),
            decoration: const BoxDecoration(
              border: Border(
                bottom: BorderSide(color: AppColors.slate800, width: 1),
              ),
            ),
            child: Row(
              mainAxisAlignment:
                  isCollapsed ? MainAxisAlignment.center : MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(10),
                          gradient: const LinearGradient(
                            colors: [Color(0xFF38BDF8), Color(0xFF4F46E5)],
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                          ),
                          boxShadow: const [
                            BoxShadow(
                              color: Color.fromRGBO(14, 165, 233, 0.3),
                              blurRadius: 8,
                              offset: Offset(0, 2),
                            ),
                          ],
                        ),
                        child: const Center(
                          child: Icon(
                            LucideIcons.home,
                            size: 18,
                            color: Colors.white,
                          ),
                        ),
                      ),
                      if (!isCollapsed) ...[
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: const [
                              Text(
                                'ResiHub',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 16,
                                  fontWeight: FontWeight.w700,
                                  color: Colors.white,
                                  letterSpacing: -0.2,
                                  height: 1.1,
                                ),
                              ),
                              SizedBox(height: 2),
                              Text(
                                'Property Cloud v2.0',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 11,
                                  fontWeight: FontWeight.w500,
                                  color: AppColors.primary400,
                                  height: 1.1,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (!isCollapsed && isDrawer && onClose != null)
                  IconButton(
                    icon: const Icon(LucideIcons.x, size: 20, color: AppColors.slate400),
                    onPressed: onClose,
                    tooltip: 'Đóng menu',
                  )
                else if (collapsible && !isDrawer)
                  IconButton(
                    key: const Key('sidebar-collapse-toggle'),
                    icon: Icon(
                      isCollapsed ? LucideIcons.panelLeftOpen : LucideIcons.panelLeftClose,
                      size: 18,
                      color: AppColors.slate400,
                    ),
                    onPressed: () {
                      ref.read(sidebarCollapsedProvider.notifier).toggle();
                    },
                    tooltip: isCollapsed ? 'Mở rộng sidebar' : 'Thu gọn sidebar',
                  ),
              ],
            ),
          ),

          // Navigation items list
          Expanded(
            child: SingleChildScrollView(
              padding: EdgeInsets.symmetric(
                horizontal: isCollapsed ? 8 : 12,
                vertical: 16,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: filteredGroups.map((group) {
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (!isCollapsed)
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                            child: Text(
                              group.group.toUpperCase(),
                              style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                color: AppColors.slate500,
                                letterSpacing: 0.8,
                              ),
                            ),
                          )
                        else
                          const Divider(color: AppColors.slate800, height: 16),
                        ...group.items.map((item) {
                          final isActive = currentPath == item.path;
                          final navButton = Material(
                            color: Colors.transparent,
                            child: InkWell(
                              onTap: () => _handleItemClick(context, item.path),
                              borderRadius: BorderRadius.circular(10),
                              child: AnimatedContainer(
                                duration: const Duration(milliseconds: 150),
                                padding: EdgeInsets.symmetric(
                                  horizontal: isCollapsed ? 10 : 12,
                                  vertical: 10,
                                ),
                                decoration: BoxDecoration(
                                  color: isActive
                                      ? AppColors.primary500
                                      : Colors.transparent,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: Row(
                                  mainAxisAlignment: isCollapsed
                                      ? MainAxisAlignment.center
                                      : MainAxisAlignment.start,
                                  children: [
                                    Icon(
                                      item.icon,
                                      size: 18,
                                      color: isActive
                                          ? Colors.white
                                          : AppColors.slate300,
                                    ),
                                    if (!isCollapsed) ...[
                                      const SizedBox(width: 12),
                                      Expanded(
                                        child: Text(
                                          item.label,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(
                                            fontFamily: 'Inter',
                                            fontSize: 13,
                                            fontWeight: isActive
                                                ? FontWeight.w600
                                                : FontWeight.w500,
                                            color: isActive
                                                ? Colors.white
                                                : AppColors.slate300,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            ),
                          );

                          if (isCollapsed) {
                            return Tooltip(
                              message: item.label,
                              preferBelow: false,
                              child: navButton,
                            );
                          }
                          return navButton;
                        }),
                      ],
                    ),
                  );
                }).toList(),
              ),
            ),
          ),

          // Role Footer
          Container(
            padding: EdgeInsets.all(isCollapsed ? 8 : 14),
            decoration: const BoxDecoration(
              border: Border(
                top: BorderSide(color: AppColors.slate800, width: 1),
              ),
            ),
            child: isCollapsed
                ? Tooltip(
                    message: 'Vai trò: ${primaryRole.label}',
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: AppColors.slate800.withValues(alpha: 0.7),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: const Icon(
                        LucideIcons.shieldCheck,
                        size: 16,
                        color: AppColors.primary400,
                      ),
                    ),
                  )
                : Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                    decoration: BoxDecoration(
                      color: AppColors.slate800.withValues(alpha: 0.7),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                        color: AppColors.slate700.withValues(alpha: 0.6),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Vai trò hiện tại',
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 11,
                            color: AppColors.slate400,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          primaryRole.label,
                          style: const TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: AppColors.primary400,
                          ),
                        ),
                      ],
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
