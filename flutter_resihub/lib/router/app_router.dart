import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/providers/auth_provider.dart';
import '../../features/auth/screens/forgot_password_page.dart';
import '../../features/auth/screens/login_page.dart';
import '../../shared/widgets/layout/admin_shell.dart';
import 'route_guards.dart';

/// Lightweight route placeholder widget for screens implemented in upcoming tasks.
/// Allows tests and navigation inspection to assert route key and extracted parameters cleanly.
class RoutePlaceholderPage extends StatefulWidget {
  final String routeKey;
  final String title;
  final Map<String, String> params;

  const RoutePlaceholderPage({
    super.key,
    required this.routeKey,
    required this.title,
    this.params = const {},
  });

  @override
  State<RoutePlaceholderPage> createState() => _RoutePlaceholderPageState();
}

class _RoutePlaceholderPageState extends State<RoutePlaceholderPage> {
  static int _globalMountCounter = 0;
  late final int _mountId;

  @override
  void initState() {
    super.initState();
    _globalMountCounter++;
    _mountId = _globalMountCounter;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              widget.title,
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Text('Route: ${widget.routeKey}'),
            if (widget.params.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text('Params: ${widget.params}'),
            ],
            const SizedBox(height: 4),
            Text('Mount: $_mountId'),
          ],
        ),
      ),
    );
  }
}

/// Fallback redirector widget for unknown routes matching React Router's `<RootRedirect />` fallback.
class _UnknownRouteRedirector extends ConsumerStatefulWidget {
  const _UnknownRouteRedirector();

  @override
  ConsumerState<_UnknownRouteRedirector> createState() => _UnknownRouteRedirectorState();
}

class _UnknownRouteRedirectorState extends ConsumerState<_UnknownRouteRedirector> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final auth = ref.read(authProvider);
      final target = !auth.isAuthenticated
          ? '/explore'
          : (auth.isAdminPortal ? '/admin/dashboard' : '/resident');
      context.go(target);
    });
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: CircularProgressIndicator(),
      ),
    );
  }
}

/// Singleton [GoRouter] provider wired to [routerRefreshNotifierProvider].
///
/// Ensures a single [GoRouter] instance is created per [ProviderContainer] and
/// only triggers route evaluations when authentication state or role permissions change.
final appRouterProvider = Provider<GoRouter>((ref) {
  final refreshNotifier = ref.watch(routerRefreshNotifierProvider);

  final router = GoRouter(
    initialLocation: '/',
    refreshListenable: refreshNotifier,
    redirect: (context, state) {
      final auth = ref.read(authProvider);
      final isAuth = auth.isAuthenticated;
      final isAdmin = auth.isAdminPortal;
      final path = state.uri.path;

      final isPublicRoute = path == '/explore' ||
          path == '/login' ||
          path == '/forgot-password';

      // 1. Root "/" redirect
      if (path == '/') {
        if (!isAuth) return '/explore';
        return isAdmin ? '/admin/dashboard' : '/resident';
      }

      // 2. Unauthenticated access to protected routes -> redirect to /login
      if (!isAuth && !isPublicRoute) {
        return '/login';
      }

      // 3. Authenticated user visiting auth pages -> redirect to appropriate home
      if (isAuth && (path == '/login' || path == '/forgot-password')) {
        return isAdmin ? '/admin/dashboard' : '/resident';
      }

      // 4. Admin portal routes (/admin, /admin/*)
      if (path == '/admin') {
        if (!isAuth) return '/login';
        if (!isAdmin) return '/resident';
        return '/admin/dashboard';
      }

      if (path.startsWith('/admin/')) {
        if (!isAuth) return '/login';
        if (!isAdmin) return '/resident';
      }

      // 5. Resident portal route
      if (path == '/resident' || path.startsWith('/resident/')) {
        if (!isAuth) return '/login';
      }

      return null;
    },
    routes: [
      // Public routes
      GoRoute(
        path: '/explore',
        builder: (context, state) => const RoutePlaceholderPage(
          routeKey: '/explore',
          title: 'Khám phá ResiHub',
        ),
      ),
      GoRoute(
        path: '/login',
        builder: (context, state) => LoginPage(
          initialMode: state.uri.queryParameters['mode'],
          initialPhone: state.uri.queryParameters['phone'],
        ),
      ),
      GoRoute(
        path: '/forgot-password',
        builder: (context, state) => const ForgotPasswordPage(),
      ),
      GoRoute(
        path: '/resident',
        builder: (context, state) => const RoutePlaceholderPage(
          routeKey: '/resident',
          title: 'Cổng cư dân',
        ),
      ),

      // Admin portal routes wrapped in AdminShell via ShellRoute
      ShellRoute(
        builder: (context, state, child) {
          return AdminShell(
            currentLocation: state.uri.toString(),
            child: child,
          );
        },
        routes: [
          GoRoute(
            path: '/admin/dashboard',
            builder: (context, state) => const RoutePlaceholderPage(
              routeKey: '/admin/dashboard',
              title: 'Bảng điều khiển',
            ),
          ),

          // Buildings (M03)
          GoRoute(
            path: '/admin/buildings',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/buildings',
                title: 'Bất động sản',
              ),
            ),
          ),
          // MANDATORY STATIC-BEFORE-DYNAMIC ORDER:
          // /admin/buildings/floor-plan MUST be declared BEFORE /admin/buildings/:id
          GoRoute(
            path: '/admin/buildings/floor-plan',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/buildings/floor-plan',
                title: 'Sơ đồ mặt bằng',
              ),
            ),
          ),
          GoRoute(
            path: '/admin/buildings/:id',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              final zoneId = state.pathParameters['zoneId'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: RoutePlaceholderPage(
                  key: ValueKey('$id:$zoneId'),
                  routeKey: '/admin/buildings/:id',
                  title: 'Chi tiết tòa nhà',
                  params: {'id': id},
                ),
              );
            },
          ),
          GoRoute(
            path: '/admin/buildings/:id/zones/:zoneId',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              final zoneId = state.pathParameters['zoneId'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: RoutePlaceholderPage(
                  key: ValueKey('$id:$zoneId'),
                  routeKey: '/admin/buildings/:id/zones/:zoneId',
                  title: 'Chi tiết khu vực',
                  params: {'id': id, 'zoneId': zoneId},
                ),
              );
            },
          ),
          GoRoute(
            path: '/admin/buildings/:id/floor-plan',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              final zoneId = state.pathParameters['zoneId'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: RoutePlaceholderPage(
                  key: ValueKey('$id:$zoneId'),
                  routeKey: '/admin/buildings/:id/floor-plan',
                  title: 'Sơ đồ mặt bằng tòa nhà',
                  params: {'id': id},
                ),
              );
            },
          ),
          GoRoute(
            path: '/admin/apartments/:id',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              final zoneId = state.pathParameters['zoneId'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: RoutePlaceholderPage(
                  key: ValueKey('$id:$zoneId'),
                  routeKey: '/admin/apartments/:id',
                  title: 'Chi tiết căn hộ',
                  params: {'id': id},
                ),
              );
            },
          ),

          // Tenants (M04)
          GoRoute(
            path: '/admin/tenants',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/tenants',
                title: 'Hồ sơ Cư dân',
              ),
            ),
          ),
          GoRoute(
            path: '/admin/tenants/:id',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              final zoneId = state.pathParameters['zoneId'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: RoutePlaceholderPage(
                  key: ValueKey('$id:$zoneId'),
                  routeKey: '/admin/tenants/:id',
                  title: 'Chi tiết cư dân',
                  params: {'id': id},
                ),
              );
            },
          ),

          // Contracts (M05) & Deposits (M06)
          GoRoute(
            path: '/admin/contracts',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/contracts',
                title: 'Hợp đồng thuê',
              ),
            ),
          ),
          GoRoute(
            path: '/admin/contracts/:id',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              final zoneId = state.pathParameters['zoneId'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: RoutePlaceholderPage(
                  key: ValueKey('$id:$zoneId'),
                  routeKey: '/admin/contracts/:id',
                  title: 'Chi tiết hợp đồng',
                  params: {'id': id},
                ),
              );
            },
          ),
          GoRoute(
            path: '/admin/deposits',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/deposits',
                title: 'Quản lý Tiền cọc',
              ),
            ),
          ),

          // Services (M07) & Meters (M08)
          // MANDATORY STATIC-BEFORE-DYNAMIC ORDER:
          // /admin/services/subscriptions MUST be declared BEFORE /admin/services
          GoRoute(
            path: '/admin/services/subscriptions',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/services/subscriptions',
                title: 'Đăng ký dịch vụ',
              ),
            ),
          ),
          GoRoute(
            path: '/admin/services',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/services',
                title: 'Dịch vụ & Tiện ích',
              ),
            ),
          ),
          GoRoute(
            path: '/admin/meters',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/meters',
                title: 'Chỉ số Điện / Nước',
              ),
            ),
          ),

          // Invoices (M09) & Payments (M10)
          GoRoute(
            path: '/admin/invoices',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/invoices',
                title: 'Hóa đơn kỳ',
              ),
            ),
          ),
          GoRoute(
            path: '/admin/invoices/:id',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              final zoneId = state.pathParameters['zoneId'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: RoutePlaceholderPage(
                  key: ValueKey('$id:$zoneId'),
                  routeKey: '/admin/invoices/:id',
                  title: 'Chi tiết hóa đơn',
                  params: {'id': id},
                ),
              );
            },
          ),
          GoRoute(
            path: '/admin/payments',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/payments',
                title: 'Thanh toán & Công nợ',
              ),
            ),
          ),

          // Maintenance (M11) / Service Requests
          GoRoute(
            path: '/admin/maintenance',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/maintenance',
                title: 'Yêu cầu & Báo hỏng',
              ),
            ),
          ),
          GoRoute(
            path: '/admin/service-requests',
            redirect: (context, state) => '/admin/maintenance',
          ),

          // Notifications (M13)
          GoRoute(
            path: '/admin/notifications',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/notifications',
                title: 'Thông báo cư dân',
              ),
            ),
          ),

          // Reports (M14)
          GoRoute(
            path: '/admin/reports',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/reports',
                title: 'Báo cáo thống kê',
              ),
            ),
          ),

          // RBAC Gated Administration Routes
          GoRoute(
            path: '/admin/audit-logs',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/audit-logs',
                title: 'Nhật ký hệ thống',
              ),
            ),
          ),
          GoRoute(
            path: '/admin/settings',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/settings',
                title: 'Cài đặt hệ thống',
              ),
            ),
          ),
          GoRoute(
            path: '/admin/users',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN'],
              child: RoutePlaceholderPage(
                routeKey: '/admin/users',
                title: 'Người dùng & Cấu hình',
              ),
            ),
          ),
        ],
      ),
    ],
    errorBuilder: (context, state) => const _UnknownRouteRedirector(),
  );

  ref.onDispose(() {
    router.dispose();
  });

  return router;
});
