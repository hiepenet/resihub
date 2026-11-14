import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/ai_gateway/screens/settings_page.dart';
import '../features/audit/screens/audit_logs_page.dart';
import '../features/auth/providers/auth_provider.dart';
import '../features/auth/screens/forgot_password_page.dart';
import '../features/auth/screens/login_page.dart';
import '../features/buildings/screens/apartment_detail_page.dart';
import '../features/buildings/screens/building_detail_page.dart';
import '../features/buildings/screens/buildings_page.dart';
import '../features/buildings/screens/floor_plan_page.dart';
import '../features/buildings/screens/zone_detail_page.dart';
import '../features/contracts/screens/contract_detail_page.dart';
import '../features/contracts/screens/contracts_page.dart';
import '../features/deposits/screens/deposits_page.dart';
import '../features/invoices/screens/invoice_detail_page.dart';
import '../features/invoices/screens/invoices_page.dart';
import '../features/maintenance/screens/service_requests_page.dart';
import '../features/meters/screens/meter_readings_page.dart';
import '../features/notifications/screens/notifications_page.dart';
import '../features/payments/screens/payments_page.dart';
import '../features/public/screens/public_explore_page.dart';
import '../features/reports/screens/dashboard_page.dart';
import '../features/reports/screens/reports_page.dart';
import '../features/resident/screens/resident_portal_page.dart';
import '../features/services/screens/service_catalog_page.dart';
import '../features/services/screens/subscriptions_page.dart';
import '../features/tenants/screens/tenant_detail_page.dart';
import '../features/tenants/screens/tenants_page.dart';
import '../features/users/screens/users_page.dart';
import '../shared/widgets/layout/admin_shell.dart';
import 'route_guards.dart';

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
      // Public & Resident routes
      GoRoute(
        path: '/explore',
        builder: (context, state) => const PublicExplorePage(),
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
        builder: (context, state) => ResidentPortalPage(
          initialTab: state.uri.queryParameters['tab'],
          contractId: state.uri.queryParameters['contract_id'],
          targetContractId: state.uri.queryParameters['target_contract_id'],
          action: state.uri.queryParameters['action'],
          invoiceId: state.uri.queryParameters['invoice_id'],
          requestId: state.uri.queryParameters['request_id'],
          modal: state.uri.queryParameters['modal'],
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
            builder: (context, state) => const DashboardPage(),
          ),

          // Buildings (M03)
          GoRoute(
            path: '/admin/buildings',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: BuildingsPage(),
            ),
          ),
          // MANDATORY STATIC-BEFORE-DYNAMIC ORDER:
          // /admin/buildings/floor-plan MUST be declared BEFORE /admin/buildings/:id
          GoRoute(
            path: '/admin/buildings/floor-plan',
            builder: (context, state) => RoleGuard(
              allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: FloorPlanPage(
                highlightPendingConfirm: state.uri.queryParameters['pending_confirm'] == '1',
              ),
            ),
          ),
          GoRoute(
            path: '/admin/buildings/:id',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: BuildingDetailPage(
                  key: ValueKey('$id:'),
                  buildingId: id,
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
                child: ZoneDetailPage(
                  key: ValueKey('$id:$zoneId'),
                  buildingId: id,
                  zoneId: zoneId,
                ),
              );
            },
          ),
          GoRoute(
            path: '/admin/buildings/:id/floor-plan',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: FloorPlanPage(
                  buildingId: id,
                  highlightPendingConfirm: state.uri.queryParameters['pending_confirm'] == '1',
                ),
              );
            },
          ),
          GoRoute(
            path: '/admin/apartments/:id',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: ApartmentDetailPage(
                  key: ValueKey('$id:'),
                  apartmentId: id,
                  initialReservationId: state.uri.queryParameters['reservation_id'],
                  initialModal: state.uri.queryParameters['modal'],
                ),
              );
            },
          ),

          // Tenants (M04)
          GoRoute(
            path: '/admin/tenants',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: TenantsPage(),
            ),
          ),
          GoRoute(
            path: '/admin/tenants/:id',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: TenantDetailPage(
                  key: ValueKey('$id:'),
                  tenantId: id,
                  initialModal: state.uri.queryParameters['modal'],
                ),
              );
            },
          ),

          // Contracts (M05) & Deposits (M06)
          GoRoute(
            path: '/admin/contracts',
            builder: (context, state) => RoleGuard(
              allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: ContractsPage(initialTab: state.uri.queryParameters['tab']),
            ),
          ),
          GoRoute(
            path: '/admin/contracts/:id',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: ContractDetailPage(
                  key: ValueKey('$id:'),
                  contractId: id,
                  initialModal: state.uri.queryParameters['modal'],
                ),
              );
            },
          ),
          GoRoute(
            path: '/admin/deposits',
            builder: (context, state) => RoleGuard(
              allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: DepositsPage(
                initialDepositId: state.uri.queryParameters['deposit_id'],
                initialModal: state.uri.queryParameters['modal'],
              ),
            ),
          ),

          // Services (M07) & Meters (M08)
          // MANDATORY STATIC-BEFORE-DYNAMIC ORDER:
          // /admin/services/subscriptions MUST be declared BEFORE /admin/services
          GoRoute(
            path: '/admin/services/subscriptions',
            builder: (context, state) => RoleGuard(
              allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: SubscriptionsPage(
                initialSubscriptionId: state.uri.queryParameters['subscription_id'],
                initialModal: state.uri.queryParameters['modal'],
              ),
            ),
          ),
          GoRoute(
            path: '/admin/services',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: ServiceCatalogPage(),
            ),
          ),
          GoRoute(
            path: '/admin/meters',
            builder: (context, state) => RoleGuard(
              allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: MeterReadingsPage(
                initialMeterId: state.uri.queryParameters['meter_id'],
                initialModal: state.uri.queryParameters['modal'],
              ),
            ),
          ),

          // Invoices (M09) & Payments (M10)
          GoRoute(
            path: '/admin/invoices',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: InvoicesPage(),
            ),
          ),
          GoRoute(
            path: '/admin/invoices/:id',
            builder: (context, state) {
              final id = state.pathParameters['id'] ?? '';
              return RoleGuard(
                allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
                child: InvoiceDetailPage(
                  key: ValueKey('$id:'),
                  invoiceId: id,
                  initialModal: state.uri.queryParameters['modal'],
                ),
              );
            },
          ),
          GoRoute(
            path: '/admin/payments',
            builder: (context, state) => RoleGuard(
              allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: PaymentsPage(
                initialTab: state.uri.queryParameters['tab'],
                initialBucket: state.uri.queryParameters['bucket'],
                initialPaymentId: state.uri.queryParameters['payment_id'],
              ),
            ),
          ),

          // Maintenance (M11) / Service Requests
          GoRoute(
            path: '/admin/maintenance',
            builder: (context, state) => RoleGuard(
              allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: ServiceRequestsPage(
                initialRequestId: state.uri.queryParameters['request_id'],
              ),
            ),
          ),
          GoRoute(
            path: '/admin/service-requests',
            redirect: (context, state) => state.uri.query.isEmpty
                ? '/admin/maintenance'
                : '/admin/maintenance?${state.uri.query}',
          ),

          // Notifications (M13)
          GoRoute(
            path: '/admin/notifications',
            builder: (context, state) => RoleGuard(
              allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: NotificationsPage(initialTab: state.uri.queryParameters['tab']),
            ),
          ),

          // Reports (M14)
          GoRoute(
            path: '/admin/reports',
            builder: (context, state) => RoleGuard(
              allowedRoles: const ['SYS_ADMIN', 'OWNER', 'MANAGER'],
              child: ReportsPage(
                initialTab: state.uri.queryParameters['tab'],
                initialModal: state.uri.queryParameters['modal'],
              ),
            ),
          ),

          // RBAC Gated Administration Routes
          GoRoute(
            path: '/admin/audit-logs',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN', 'OWNER'],
              child: AuditLogsPage(),
            ),
          ),
          GoRoute(
            path: '/admin/settings',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN'],
              child: SettingsPage(),
            ),
          ),
          GoRoute(
            path: '/admin/users',
            builder: (context, state) => const RoleGuard(
              allowedRoles: ['SYS_ADMIN'],
              child: UsersPage(),
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
