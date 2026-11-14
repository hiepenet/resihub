import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/navigation.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/resident_nav_helpers.dart';
import '../../../features/auth/providers/auth_provider.dart';
import '../../providers/notification_provider.dart';
import '../common/notification_bell.dart';
import '../ui/app_select.dart';

/// 3-Tier Responsive Resident Shell matching `ResidentLayout.jsx`.
/// - Desktop (>= 1024px): Left 8-tab sidebar + apartment switcher
/// - Tablet (768..1023px): Top sticky horizontal tab strip of all 8 tabs
/// - Mobile (< 768px): 5-slot Bottom Navigation Bar (4 primary tabs + 'Thêm' modal sheet)
class ResidentShell extends ConsumerStatefulWidget {
  final Widget child;
  final String activeTab;
  final ValueChanged<String> onTabSelected;
  final List<Map<String, dynamic>> contracts;
  final String? selectedContractId;
  final ValueChanged<String>? onContractChanged;
  final String? apartmentBadge;
  final Map<String, int> badgeCounts;

  const ResidentShell({
    super.key,
    required this.child,
    required this.activeTab,
    required this.onTabSelected,
    this.contracts = const [],
    this.selectedContractId,
    this.onContractChanged,
    this.apartmentBadge,
    this.badgeCounts = const {},
  });

  @override
  ConsumerState<ResidentShell> createState() => _ResidentShellState();
}

class _ResidentShellState extends ConsumerState<ResidentShell> {
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
        }
      }
    }
  }

  void _handleBack() {
    final router = GoRouter.maybeOf(context);
    if (router != null && router.canPop()) {
      router.pop();
    } else if (widget.activeTab != 'overview') {
      widget.onTabSelected('overview');
    }
  }

  void _openMoreBottomSheet(
    BuildContext context,
    ResidentMobileNavState mobileNav,
  ) {
    final user = ref.read(authProvider).user;
    final unreadCount = ref.read(notificationProvider).unreadCount;

    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (sheetContext) {
        return Container(
          decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
          ),
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          child: SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Tiện ích & Hồ sơ cư dân',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 16,
                              fontWeight: FontWeight.w700,
                              color: AppColors.slate900,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            user?.fullName.isNotEmpty == true
                                ? 'Xin chào, ${user!.fullName}'
                                : 'Truy cập nhanh các mục khác',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 12,
                              color: AppColors.slate500,
                            ),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      icon: const Icon(LucideIcons.x, size: 18, color: AppColors.slate400),
                      onPressed: () => Navigator.of(sheetContext).pop(),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                const Divider(height: 1, color: AppColors.slate100),
                const SizedBox(height: 12),
                ...mobileNav.secondaryTabs.map((t) {
                  final isActive = widget.activeTab == t.id;
                  final unread = t.id == 'notifications'
                      ? (widget.badgeCounts[t.id] ?? unreadCount)
                      : (widget.badgeCounts[t.id] ?? 0);
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: InkWell(
                      onTap: () {
                        Navigator.of(sheetContext).pop();
                        widget.onTabSelected(t.id);
                      },
                      borderRadius: BorderRadius.circular(12),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                        decoration: BoxDecoration(
                          color: isActive ? AppColors.primary50 : Colors.white,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: isActive ? AppColors.primary200 : AppColors.slate200,
                          ),
                        ),
                        child: Row(
                          children: [
                            Container(
                              width: 36,
                              height: 36,
                              decoration: BoxDecoration(
                                color: isActive ? AppColors.primary500 : AppColors.slate100,
                                borderRadius: BorderRadius.circular(10),
                              ),
                              child: Icon(
                                t.icon,
                                size: 18,
                                color: isActive ? Colors.white : AppColors.slate600,
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                t.label,
                                style: TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 14,
                                  fontWeight: isActive ? FontWeight.w600 : FontWeight.w500,
                                  color: isActive ? AppColors.primary700 : AppColors.slate800,
                                ),
                              ),
                            ),
                            if (unread > 0) ...[
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                decoration: BoxDecoration(
                                  color: AppColors.rose500,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: Text(
                                  '$unread mới',
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontSize: 11,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                            ],
                            const Icon(
                              LucideIcons.chevronRight,
                              size: 16,
                              color: AppColors.slate400,
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                }),
                const SizedBox(height: 8),
                const Divider(height: 1, color: AppColors.slate100),
                const SizedBox(height: 12),
                InkWell(
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    _handleLogout();
                  },
                  borderRadius: BorderRadius.circular(12),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(
                      color: AppColors.rose50,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.rose200),
                    ),
                    child: Row(
                      children: [
                        Container(
                          width: 36,
                          height: 36,
                          decoration: BoxDecoration(
                            color: AppColors.rose100,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: const Icon(
                            LucideIcons.logOut,
                            size: 18,
                            color: AppColors.rose600,
                          ),
                        ),
                        const SizedBox(width: 12),
                        const Expanded(
                          child: Text(
                            'Đăng xuất tài khoản',
                            style: TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                              color: AppColors.rose700,
                            ),
                          ),
                        ),
                        const Icon(
                          LucideIcons.chevronRight,
                          size: 16,
                          color: AppColors.rose400,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isDesktop = width >= 1024;
    final isTablet = width >= 768 && width < 1024;
    final isMobile = width < 768;

    final authState = ref.watch(authProvider);
    final user = authState.user;
    final unreadCount = ref.watch(notificationProvider).unreadCount;

    final mobileNav = resolveResidentMobileNavState(
      activeTab: widget.activeTab,
      unreadCount: unreadCount,
      tabs: kResidentPortalTabs,
    );

    final router = GoRouter.maybeOf(context);
    final canGoBack = (router != null && router.canPop()) || widget.activeTab != 'overview';

    final contractOptions = widget.contracts.map((c) {
      final apt = c['apartment_code']?.toString() ?? '';
      final bld = c['building_name']?.toString();
      final isFuture = c['is_future_contract'] == true;
      return AppSelectOption<String>(
        value: c['contract_id']?.toString() ?? '',
        label: 'Căn $apt${bld != null && bld.isNotEmpty ? ' — $bld' : ''}',
        badge: isFuture ? 'HĐ tương lai' : null,
      );
    }).toList();

    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            // Top Header
            Container(
              decoration: const BoxDecoration(
                color: Colors.white,
                border: Border(
                  bottom: BorderSide(color: AppColors.slate200, width: 1),
                ),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  // Left: Back button + Brand + Apartment info / Multi-contract selector
                  Expanded(
                    child: Row(
                      children: [
                        IconButton(
                          icon: const Icon(LucideIcons.arrowLeft, size: 20),
                          color: canGoBack ? AppColors.slate700 : AppColors.slate300,
                          onPressed: canGoBack ? _handleBack : null,
                          tooltip: 'Quay lại trang trước',
                        ),
                        const SizedBox(width: 4),
                        Container(
                          width: 34,
                          height: 34,
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(10),
                            gradient: const LinearGradient(
                              colors: [AppColors.primary500, AppColors.secondary600],
                              begin: Alignment.topLeft,
                              end: Alignment.bottomRight,
                            ),
                          ),
                          child: const Center(
                            child: Icon(LucideIcons.home, size: 18, color: Colors.white),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              FittedBox(
                                fit: BoxFit.scaleDown,
                                alignment: Alignment.centerLeft,
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    const Text(
                                      'ResiHub',
                                      style: TextStyle(
                                        fontFamily: 'Inter',
                                        fontSize: 15,
                                        fontWeight: FontWeight.w700,
                                        color: AppColors.slate900,
                                      ),
                                    ),
                                    const SizedBox(width: 6),
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                                      decoration: BoxDecoration(
                                        color: AppColors.primary50,
                                        borderRadius: BorderRadius.circular(10),
                                        border: Border.all(color: AppColors.primary100),
                                      ),
                                      child: const Text(
                                        'Cổng cư dân',
                                        style: TextStyle(
                                          fontFamily: 'Inter',
                                          fontSize: 10,
                                          fontWeight: FontWeight.w600,
                                          color: AppColors.primary600,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              if (!isMobile && widget.contracts.length > 1) ...[
                                const SizedBox(height: 4),
                                ConstrainedBox(
                                  constraints: const BoxConstraints(maxWidth: 320),
                                  child: KeyedSubtree(
                                    key: const Key('resident-contract-switcher'),
                                    child: AppSelect<String>(
                                      value: widget.selectedContractId ??
                                          (widget.contracts.isNotEmpty
                                              ? widget.contracts.first['contract_id']?.toString()
                                              : null),
                                      options: contractOptions,
                                      searchable: widget.contracts.length > 3,
                                      searchPlaceholder: 'Tìm mã căn hộ, tòa nhà...',
                                      icon: const Icon(LucideIcons.building2,
                                          size: 16, color: AppColors.primary600),
                                      onChanged: (val) {
                                        if (val != null) {
                                          widget.onContractChanged?.call(val);
                                        }
                                      },
                                    ),
                                  ),
                                ),
                              ] else if (widget.apartmentBadge != null &&
                                  widget.apartmentBadge!.isNotEmpty) ...[
                                const SizedBox(height: 2),
                                Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    const Icon(LucideIcons.building2,
                                        size: 13, color: AppColors.slate400),
                                    const SizedBox(width: 4),
                                    Flexible(
                                      child: Text(
                                        widget.apartmentBadge!,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                          fontFamily: 'Inter',
                                          fontSize: 11,
                                          color: AppColors.slate500,
                                        ),
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
                  ),

                  // Right: Notification Bell, Profile, Logout
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      NotificationBell(
                        onViewAll: () => widget.onTabSelected('notifications'),
                      ),
                      if (!isMobile) ...[
                        const SizedBox(width: 8),
                        InkWell(
                          onTap: () => widget.onTabSelected('profile'),
                          borderRadius: BorderRadius.circular(10),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            child: Row(
                              children: [
                                Container(
                                  width: 28,
                                  height: 28,
                                  decoration: BoxDecoration(
                                    color: AppColors.primary100,
                                    borderRadius: BorderRadius.circular(14),
                                  ),
                                  child: Center(
                                    child: Text(
                                      (user?.fullName.isNotEmpty == true
                                              ? user!.fullName
                                              : (user?.email ?? 'C'))
                                          .substring(0, 1)
                                          .toUpperCase(),
                                      style: const TextStyle(
                                        fontFamily: 'Inter',
                                        fontSize: 12,
                                        fontWeight: FontWeight.w700,
                                        color: AppColors.primary700,
                                      ),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 6),
                                ConstrainedBox(
                                  constraints: const BoxConstraints(maxWidth: 140),
                                  child: Text(
                                    user?.fullName ?? 'Cư dân',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 12,
                                      fontWeight: FontWeight.w600,
                                      color: AppColors.slate700,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(width: 4),
                      IconButton(
                        icon: const Icon(LucideIcons.logOut, size: 18, color: AppColors.slate500),
                        onPressed: _handleLogout,
                        tooltip: 'Đăng xuất',
                      ),
                    ],
                  ),
                ],
              ),
            ),

            // Mobile Contract Switcher (< 768px, matching ResidentLayout.jsx:182)
            if (isMobile && widget.contracts.length > 1)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                decoration: const BoxDecoration(
                  color: Colors.white,
                  border: Border(
                    bottom: BorderSide(color: AppColors.slate100, width: 1),
                  ),
                ),
                child: KeyedSubtree(
                  key: const Key('resident-contract-switcher'),
                  child: AppSelect<String>(
                    value: widget.selectedContractId ??
                        (widget.contracts.isNotEmpty
                            ? widget.contracts.first['contract_id']?.toString()
                            : null),
                    options: contractOptions,
                    searchable: widget.contracts.length > 3,
                    searchPlaceholder: 'Tìm mã căn hộ, tòa nhà...',
                    icon: const Icon(LucideIcons.building2, size: 16, color: AppColors.primary600),
                    onChanged: (val) {
                      if (val != null) {
                        widget.onContractChanged?.call(val);
                      }
                    },
                  ),
                ),
              ),

            // Tablet Sticky Horizontal Tab Bar (768..1023px)
            if (isTablet)
              Container(
                key: const Key('resident-horizontal-tabs'),
                decoration: const BoxDecoration(
                  color: Color(0xFFF8FAFC),
                  border: Border(
                    top: BorderSide(color: AppColors.slate100, width: 1),
                    bottom: BorderSide(color: AppColors.slate200, width: 1),
                  ),
                ),
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  child: Row(
                    children: kResidentPortalTabs.map((t) {
                      final isActive = widget.activeTab == t.id;
                      final unread = t.id == 'notifications'
                          ? (widget.badgeCounts[t.id] ?? unreadCount)
                          : (widget.badgeCounts[t.id] ?? 0);
                      return Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: InkWell(
                          onTap: () => widget.onTabSelected(t.id),
                          borderRadius: BorderRadius.circular(10),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                            decoration: BoxDecoration(
                              color: isActive ? AppColors.primary500 : Colors.white,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(
                                color: isActive ? AppColors.primary500 : AppColors.slate200,
                              ),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(
                                  t.icon,
                                  size: 14,
                                  color: isActive ? Colors.white : AppColors.slate600,
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  t.shortLabel,
                                  style: TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 12,
                                    fontWeight: isActive ? FontWeight.w600 : FontWeight.w500,
                                    color: isActive ? Colors.white : AppColors.slate700,
                                  ),
                                ),
                                if (unread > 0) ...[
                                  const SizedBox(width: 6),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                                    decoration: BoxDecoration(
                                      color: isActive ? Colors.white : AppColors.rose500,
                                      borderRadius: BorderRadius.circular(10),
                                    ),
                                    child: Text(
                                      unread > 99 ? '99+' : '$unread',
                                      style: TextStyle(
                                        fontSize: 10,
                                        fontWeight: FontWeight.bold,
                                        color: isActive ? AppColors.primary600 : Colors.white,
                                      ),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        ),
                      );
                    }).toList(),
                  ),
                ),
              ),

            // Main Content Area with Desktop Sidebar
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Desktop 8-Tab Sidebar (>= 1024px)
                  if (isDesktop)
                    Container(
                      width: 240,
                      decoration: const BoxDecoration(
                        color: Colors.white,
                        border: Border(
                          right: BorderSide(color: AppColors.slate200, width: 1),
                        ),
                      ),
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          children: kResidentPortalTabs.map((t) {
                          final isActive = widget.activeTab == t.id;
                          final unread = t.id == 'notifications'
                              ? (widget.badgeCounts[t.id] ?? unreadCount)
                              : (widget.badgeCounts[t.id] ?? 0);
                          return Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: InkWell(
                              onTap: () => widget.onTabSelected(t.id),
                              borderRadius: BorderRadius.circular(10),
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                                decoration: BoxDecoration(
                                  color: isActive ? AppColors.primary500 : Colors.transparent,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: Row(
                                  children: [
                                    Icon(
                                      t.icon,
                                      size: 16,
                                      color: isActive ? Colors.white : AppColors.slate600,
                                    ),
                                    const SizedBox(width: 10),
                                    Expanded(
                                      child: Text(
                                        t.label,
                                        style: TextStyle(
                                          fontFamily: 'Inter',
                                          fontSize: 13,
                                          fontWeight: isActive ? FontWeight.w600 : FontWeight.w500,
                                          color: isActive ? Colors.white : AppColors.slate700,
                                        ),
                                      ),
                                    ),
                                    if (unread > 0)
                                      Container(
                                        padding:
                                            const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                        decoration: BoxDecoration(
                                          color: isActive ? Colors.white : AppColors.rose500,
                                          borderRadius: BorderRadius.circular(10),
                                        ),
                                        child: Text(
                                          unread > 99 ? '99+' : '$unread',
                                          style: TextStyle(
                                            fontSize: 10,
                                            fontWeight: FontWeight.bold,
                                            color: isActive ? AppColors.primary600 : Colors.white,
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                          );
                        }).toList(),
                        ),
                      ),
                    ),

                  // Main View
                  Expanded(
                    child: widget.child,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),

      // Mobile Fixed 5-Slot Bottom Navigation Bar (< 768px)
      bottomNavigationBar: isMobile
          ? Container(
              key: const Key('resident-bottom-nav'),
              decoration: const BoxDecoration(
                color: Colors.white,
                border: Border(
                  top: BorderSide(color: AppColors.slate200, width: 1),
                ),
                boxShadow: [
                  BoxShadow(
                    color: Color.fromRGBO(15, 23, 42, 0.04),
                    blurRadius: 10,
                    offset: Offset(0, -2),
                  ),
                ],
              ),
              child: SafeArea(
                top: false,
                child: SizedBox(
                  height: 56,
                  child: Row(
                    children: [
                      ...mobileNav.primaryTabs.map((t) {
                        final isActive = widget.activeTab == t.id;
                        return Expanded(
                          child: InkWell(
                            onTap: () => widget.onTabSelected(t.id),
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Icon(
                                  t.icon,
                                  size: 20,
                                  color: isActive ? AppColors.primary600 : AppColors.slate500,
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  t.shortLabel,
                                  style: TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 11,
                                    fontWeight: isActive ? FontWeight.w600 : FontWeight.w500,
                                    color: isActive ? AppColors.primary600 : AppColors.slate500,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      }),

                      // 5th slot: Thêm
                      Expanded(
                        child: InkWell(
                          onTap: () => _openMoreBottomSheet(context, mobileNav),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Stack(
                                clipBehavior: Clip.none,
                                children: [
                                  Icon(
                                    LucideIcons.moreHorizontal,
                                    size: 20,
                                    color: mobileNav.isMoreActive
                                        ? AppColors.primary600
                                        : AppColors.slate500,
                                  ),
                                  if (mobileNav.moreBadgeCount > 0)
                                    Positioned(
                                      top: -4,
                                      right: -6,
                                      child: Container(
                                        padding:
                                            const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                                        decoration: BoxDecoration(
                                          color: AppColors.rose500,
                                          borderRadius: BorderRadius.circular(8),
                                        ),
                                        child: Text(
                                          mobileNav.moreBadgeCount > 99
                                              ? '99+'
                                              : '${mobileNav.moreBadgeCount}',
                                          style: const TextStyle(
                                            color: Colors.white,
                                            fontSize: 9,
                                            fontWeight: FontWeight.bold,
                                          ),
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                              const SizedBox(height: 2),
                              Text(
                                mobileNav.activeSecondaryTab != null
                                    ? mobileNav.activeSecondaryTab!.shortLabel
                                    : 'Thêm',
                                style: TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 11,
                                  fontWeight:
                                      mobileNav.isMoreActive ? FontWeight.w600 : FontWeight.w500,
                                  color: mobileNav.isMoreActive
                                      ? AppColors.primary600
                                      : AppColors.slate500,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            )
          : null,
    );
  }
}
