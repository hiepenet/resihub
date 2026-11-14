import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_colors.dart';
import '../../../features/auth/providers/auth_provider.dart';
import '../../providers/notification_provider.dart';
import 'sidebar_widget.dart';
import 'top_bar.dart';

/// Responsive Admin Shell wrapper for all `/admin/*` routes.
/// Matching `frontend/src/components/layout/AdminLayout.jsx`.
class AdminShell extends ConsumerStatefulWidget {
  final Widget child;
  final String? currentLocation;
  final ValueChanged<String>? onNavigate;

  const AdminShell({
    super.key,
    required this.child,
    this.currentLocation,
    this.onNavigate,
  });

  @override
  ConsumerState<AdminShell> createState() => _AdminShellState();
}

class _AdminShellState extends ConsumerState<AdminShell> {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final auth = ref.read(authProvider);
      if (auth.isAuthenticated) {
        ref.read(notificationProvider.notifier).fetchNotifications();
      }
    });
  }

  void _handleNavigate(String route) {
    if (widget.onNavigate != null) {
      widget.onNavigate!(route);
    } else {
      final router = GoRouter.maybeOf(context);
      if (router != null) {
        router.go(route);
      }
    }
  }

  String _resolveCurrentLocation() {
    if (widget.currentLocation != null && widget.currentLocation!.isNotEmpty) {
      return widget.currentLocation!;
    }
    try {
      final state = GoRouterState.of(context);
      return state.uri.toString();
    } catch (_) {
      return '/admin/dashboard';
    }
  }

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isDesktop = width >= 1024;
    final currentPath = _resolveCurrentLocation();

    return Scaffold(
      key: _scaffoldKey,
      backgroundColor: AppColors.background,
      drawer: isDesktop
          ? null
          : Drawer(
              child: SidebarWidget(
                currentPath: currentPath,
                isDrawer: true,
                onNavigate: (route) {
                  Navigator.of(context).pop();
                  _handleNavigate(route);
                },
                onClose: () => Navigator.of(context).pop(),
              ),
            ),
      body: Row(
        children: [
          if (isDesktop)
            SidebarWidget(
              currentPath: currentPath,
              collapsible: true,
              onNavigate: _handleNavigate,
            ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TopBar(
                  currentPath: currentPath,
                  onOpenMobileMenu: isDesktop
                      ? null
                      : () => _scaffoldKey.currentState?.openDrawer(),
                  onNavigate: _handleNavigate,
                ),
                Expanded(
                  child: widget.child,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
