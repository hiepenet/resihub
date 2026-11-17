import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/features/ai_gateway/screens/settings_page.dart';
import 'package:flutter_resihub/features/ai_gateway/services/ai_service.dart';
import 'package:flutter_resihub/features/ai_gateway/widgets/ai_gateway_config_card.dart';
import 'package:flutter_resihub/features/audit/screens/audit_logs_page.dart';
import 'package:flutter_resihub/features/audit/services/audit_service.dart';
import 'package:flutter_resihub/features/audit/widgets/audit_logs_view.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/users/screens/users_page.dart';
import 'package:flutter_resihub/features/users/services/users_service.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_badge.dart';

class _MockHttpClientAdapter implements HttpClientAdapter {
  final Future<ResponseBody> Function(RequestOptions options) _handler;

  _MockHttpClientAdapter(this._handler);

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    return _handler(options);
  }

  @override
  void close({bool force = false}) {}
}

class _MockAuthNotifier extends AuthNotifier {
  final UserModel _mockUser;
  _MockAuthNotifier(this._mockUser);

  @override
  AuthState build() {
    return AuthState(
      user: _mockUser,
      isAuthenticated: true,
      selectedBuildingId: '',
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('UsersService - 10 canonical methods', () {
    late Dio dio;
    late QueryCache queryCache;
    late UsersService usersService;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': {'id': 'user-123'},
            'message': 'OK',
          }),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      usersService = UsersService(dio: dio, queryCache: queryCache);
    });

    test('1. list sends GET /api/v1/admin/users and caches response', () async {
      final res = await usersService.list({'role': 'MANAGER'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/admin/users');
      expect(lastRequest.queryParameters['role'], 'MANAGER');

      // Subsequent call hits cache
      lastRequest = RequestOptions(path: '/should-not-be-called');
      final cached = await usersService.list({'role': 'MANAGER'});
      expect(cached, isNotNull);
      expect(lastRequest.path, '/should-not-be-called');
    });

    test('2. listRoles sends GET /api/v1/admin/users/roles and caches response', () async {
      final res = await usersService.listRoles();
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/admin/users/roles');

      lastRequest = RequestOptions(path: '/none');
      final cached = await usersService.listRoles();
      expect(cached, isNotNull);
      expect(lastRequest.path, '/none');
    });

    test('3. create sends POST /api/v1/admin/users with payload', () async {
      await usersService.create({
        'full_name': 'Nguyen Van A',
        'email': 'a@resihub.vn',
      });
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/admin/users');
      expect((lastRequest.data as Map)['full_name'], 'Nguyen Van A');
    });

    test('4. update sends PATCH /api/v1/admin/users/:id with payload', () async {
      await usersService.update('u-1', {'status': 'SUSPENDED'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/admin/users/u-1');
      expect((lastRequest.data as Map)['status'], 'SUSPENDED');
    });

    test('5. remove sends DELETE /api/v1/admin/users/:id', () async {
      await usersService.remove('u-1');
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/admin/users/u-1');
    });

    test('6. getSettings sends GET /api/v1/settings and caches response', () async {
      final res = await usersService.getSettings();
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/settings');

      lastRequest = RequestOptions(path: '/none');
      final cached = await usersService.getSettings();
      expect(cached, isNotNull);
      expect(lastRequest.path, '/none');
    });

    test('7. updateSettings sends PUT /api/v1/settings with payload { settings, ...settings }', () async {
      final inputSettings = {
        'approval_config': {'allow_self_approval': true},
        'billing_config': {'billing_day': 5},
      };

      await usersService.updateSettings(inputSettings);

      expect(lastRequest.method, 'PUT');
      expect(lastRequest.path, '/api/v1/settings');

      final sentData = lastRequest.data as Map<String, dynamic>;
      // MUST contain 'settings' key and top-level spread keys
      expect(sentData['settings'], equals(inputSettings));
      expect(sentData['approval_config'], equals({'allow_self_approval': true}));
      expect(sentData['billing_config'], equals({'billing_day': 5}));
    });

    test('8. resetSetting sends DELETE /api/v1/settings/:key with encoded key', () async {
      await usersService.resetSetting('approval_config');
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/settings/approval_config');

      await usersService.resetSetting('custom/setting with spaces');
      expect(lastRequest.path, '/api/v1/settings/custom%2Fsetting%20with%20spaces');
    });

    test('9. listCronRuns sends GET /api/v1/settings/cron-runs with query params', () async {
      await usersService.listCronRuns({'limit': 10});
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/settings/cron-runs');
      expect(lastRequest.queryParameters['limit'], 10);
    });

    test('10. triggerCronRun sends POST /api/v1/settings/cron-runs/trigger with idempotency', () async {
      await usersService.triggerCronRun(
        {'as_of_date': '2026-11-14'},
        idempotencyKey: 'cron-idemp-123',
      );
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/settings/cron-runs/trigger');
      expect((lastRequest.data as Map)['as_of_date'], '2026-11-14');
      expect(lastRequest.headers['Idempotency-Key'], 'cron-idemp-123');
    });
  });

  group('AuditService - 3 canonical methods', () {
    late Dio dio;
    late QueryCache queryCache;
    late AuditService auditService;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        if (options.responseType == ResponseType.bytes) {
          return ResponseBody(
            Stream.value(Uint8List.fromList([1, 2, 3])),
            200,
            headers: {
              Headers.contentTypeHeader: ['application/octet-stream'],
            },
          );
        }
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': [
              {
                'id': 'log-1',
                'action': 'CREATE',
                'entity': 'invoice',
                'created_at': '2026-11-14T10:00:00Z',
              }
            ],
            'pagination': {'total': 1, 'totalPages': 1},
          }),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      auditService = AuditService(dio: dio, queryCache: queryCache);
    });

    test('1. list sends GET /api/v1/audit-logs and caches response', () async {
      final res = await auditService.list({'scope': 'financial'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/audit-logs');
      expect(lastRequest.queryParameters['scope'], 'financial');

      lastRequest = RequestOptions(path: '/none');
      final cached = await auditService.list({'scope': 'financial'});
      expect(cached, isNotNull);
      expect(lastRequest.path, '/none');
    });

    test('2. exportCsv sends GET /api/v1/audit-logs with format: csv and responseType: bytes', () async {
      final bytes = await auditService.exportCsv({'scope': 'financial'});
      expect(bytes, isA<List<int>>());
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/audit-logs');
      expect(lastRequest.queryParameters['format'], 'csv');
      expect(lastRequest.queryParameters['scope'], 'financial');
      expect(lastRequest.responseType, ResponseType.bytes);
    });

    test('3. exportXlsx sends GET /api/v1/audit-logs with format: xlsx and responseType: bytes', () async {
      final bytes = await auditService.exportXlsx({'scope': 'financial'});
      expect(bytes, isA<List<int>>());
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/audit-logs');
      expect(lastRequest.queryParameters['format'], 'xlsx');
      expect(lastRequest.queryParameters['scope'], 'financial');
      expect(lastRequest.responseType, ResponseType.bytes);
    });
  });

  group('Widget Tests: UsersPage, SettingsPage, AuditLogsPage & AuditLogsView', () {
    late Dio mockDio;
    late QueryCache testQueryCache;
    late UsersService testUsersService;
    late AuditService testAuditService;
    late AiService testAiService;
    late BuildingsService testBuildingsService;
    int userListFetchCount = 0;

    setUp(() {
      mockDio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      testQueryCache = QueryCache();
      userListFetchCount = 0;

      mockDio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        final path = options.path;

        if (path == '/api/v1/admin/users') {
          userListFetchCount++;
          return ResponseBody.fromString(
            jsonEncode({
              'data': [
                {
                  'id': 'u-1',
                  'full_name': 'Admin Minh',
                  'email': 'admin@resihub.vn',
                  'phone': '0901234567',
                  'status': 'ACTIVE',
                  'roles': [
                    {'code': 'SYS_ADMIN', 'name': 'Quản trị hệ thống', 'building_code': null}
                  ],
                  'last_login_at': '2026-11-14T08:00:00Z',
                },
                {
                  'id': 'u-2',
                  'full_name': 'Quan Ly Tuan',
                  'email': 'tuan@resihub.vn',
                  'phone': '0907654321',
                  'status': 'ACTIVE',
                  'roles': [
                    {'code': 'MANAGER', 'name': 'Quản lý tòa nhà', 'building_code': 'BLD-01'}
                  ],
                  'last_login_at': null,
                }
              ]
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }

        if (path == '/api/v1/admin/users/roles') {
          return ResponseBody.fromString(
            jsonEncode({
              'data': [
                {'code': 'SYS_ADMIN', 'name': 'Quản trị hệ thống'},
                {'code': 'OWNER', 'name': 'Chủ đầu tư'},
                {'code': 'MANAGER', 'name': 'Quản lý tòa nhà'},
                {'code': 'RESIDENT', 'name': 'Cư dân'},
              ]
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }

        if (path == '/api/v1/buildings') {
          return ResponseBody.fromString(
            jsonEncode({
              'data': [
                {'id': 'b-1', 'code': 'BLD-01', 'name': 'Tòa Landmark 81'}
              ]
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }

        if (path == '/api/v1/settings') {
          return ResponseBody.fromString(
            jsonEncode({
              'data': {
                'approval_config': {'allow_self_approval': false},
                'reservation_cancel_policy': {
                  'max_hold_days': 30,
                  'public_max_hold_days': 7,
                  'full_refund_before_days': 3,
                  'partial_refund_pct': 50,
                  'default_hold_amount': 2000000,
                },
                'billing_config': {
                  'billing_day': 1,
                  'payment_due_days': 5,
                  'due_date_offset_days': 5,
                  'late_fee_grace_days': 5,
                  'late_fee_per_day': 100000,
                  'late_fee_cap': null,
                  'meter_anomaly_threshold_pct': 30,
                  'reminder_days': [3, 7, 15],
                  'electricity_default_price': 3800,
                  'water_default_price': 22000,
                },
                'sla_config': {
                  'response_hours': 2,
                  'urgent_resolve_hours': 4,
                  'normal_resolve_hours': 24,
                  'deposit_refund_days': 5,
                  'reopen_window_days': 3,
                },
                'contact_config': {
                  'working_hours': '08:00 – 18:00',
                  'technical_hotline': '1900 6868',
                  'security_hotline': '1900 9119',
                  'emergency_phone': '0909 113 114',
                  'support_email': 'support@resihub.vn',
                },
                'ai_config': {
                  'enabled': true,
                  'model': 'gemini-3.8-flash',
                  'tasks': {
                    'cccd_extract': true,
                    'contract_extract': true,
                    'meter_ocr': true,
                    'ticket_triage': true,
                  },
                  'ocr_threshold': 0.85,
                  'extract_threshold': 0.75,
                  'triage_threshold': 0.65,
                  'monthly_token_limit': 5000000,
                  'monthly_budget_vnd': 1000000,
                  'warn_percent': 80,
                },
              },
              'ai_runtime': {'api_key_configured': true},
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }

        if (path == '/api/v1/settings/cron-runs') {
          return ResponseBody.fromString(
            jsonEncode({
              'data': [
                {
                  'id': 'cron-1',
                  'run_date': '2026-11-14',
                  'status': 'SUCCEEDED',
                  'attempt_count': 1,
                  'duration_ms': 420,
                  'summary': {
                    'autoCreatedInvoices': 5,
                    'skippedMeterContracts': 0,
                    'overdueMarked': 2,
                    'lateFeeUpdated': 1,
                  },
                  'error_message': null,
                }
              ],
              'allow_custom_date': true,
              'today_vn': '2026-11-14',
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }

        if (path == '/api/v1/audit-logs') {
          if (options.responseType == ResponseType.bytes) {
            return ResponseBody(
              Stream.value(Uint8List.fromList(utf8.encode('col1,col2\r\nval1,val2'))),
              200,
              headers: {Headers.contentTypeHeader: ['application/octet-stream']},
            );
          }
          return ResponseBody.fromString(
            jsonEncode({
              'data': [
                {
                  'id': 'log-101',
                  'created_at': '2026-11-14T09:30:00Z',
                  'actor_name': 'Admin Minh',
                  'actor_email': 'admin@resihub.vn',
                  'action': 'CREATE',
                  'entity': 'invoice',
                  'entity_id': 'inv-888',
                  'ip': '127.0.0.1',
                  'user_agent': 'Mozilla/5.0 ResiHub Agent',
                  'before': null,
                  'after': {'id': 'inv-888', 'total_amount': 5500000},
                }
              ],
              'pagination': {'total': 1, 'totalPages': 1},
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }

        if (path == '/api/v1/ai/usage') {
          return ResponseBody.fromString(
            jsonEncode({
              'data': {
                'period': '2026-11',
                'api_key_configured': true,
                'monthly_budget_vnd': 1000000,
                'monthly_cost_vnd': 250000,
                'monthly_budget_pct': 25,
                'monthly_calls': 42,
                'monthly_token_limit': 5000000,
                'monthly_tokens_used': 1200000,
                'monthly_token_pct': 24,
                'warn_triggered': false,
                'warn_percent': 80,
                'kpi_g6': {
                  'exact_field_acceptance_rate_pct': 88,
                  'target_pct': 70,
                  'triage_keep_rate_pct': 92,
                  'triage_target_pct': 80,
                },
              }
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }

        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': {}}),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });

      testUsersService = UsersService(dio: mockDio, queryCache: testQueryCache);
      testAuditService = AuditService(dio: mockDio, queryCache: testQueryCache);
      testAiService = AiService(dio: mockDio);
      testBuildingsService = BuildingsService(dio: mockDio, queryCache: testQueryCache);
    });

    Widget createTestApp({required Widget home, GoRouter? customRouter}) {
      final sysAdminUser = UserModel(
        id: 'admin-1',
        email: 'admin@resihub.vn',
        fullName: 'Admin Minh',
        roles: const [
          UserRoleModel(code: 'SYS_ADMIN', name: 'Quản trị hệ thống'),
        ],
      );

      final router = customRouter ??
          GoRouter(
            initialLocation: '/',
            routes: [
              GoRoute(
                path: '/',
                builder: (context, state) => home,
              ),
              GoRoute(
                path: '/admin/settings',
                builder: (context, state) => const SettingsPage(),
              ),
              GoRoute(
                path: '/admin/audit-logs',
                builder: (context, state) => const AuditLogsPage(),
              ),
            ],
          );

      return ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(mockDio),
          queryCacheProvider.overrideWithValue(testQueryCache),
          usersServiceProvider.overrideWithValue(testUsersService),
          auditServiceProvider.overrideWithValue(testAuditService),
          aiServiceProvider.overrideWithValue(testAiService),
          buildingsServiceProvider.overrideWithValue(testBuildingsService),
          authProvider.overrideWith(() => _MockAuthNotifier(sysAdminUser)),
        ],
        child: MaterialApp.router(
          routerConfig: router,
        ),
      );
    }

    testWidgets('UsersPage has root key route:/admin/users and renders 3 tabs', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 1200));

      await tester.pumpWidget(createTestApp(home: const UsersPage()));
      await tester.pumpAndSettle();

      // Check root key
      expect(find.byKey(const Key('route:/admin/users')), findsOneWidget);

      // Check 3 tabs
      expect(find.text('Quản lý tài khoản & Phân quyền'), findsOneWidget);
      expect(find.text('Cấu hình hệ thống'), findsOneWidget);
      expect(find.text('Nhật ký hệ thống'), findsOneWidget);

      // Check user list loaded
      expect(find.text('Admin Minh'), findsOneWidget);
      expect(find.text('Quan Ly Tuan'), findsOneWidget);
    });

    testWidgets('UsersPage quick button navigates to /admin/settings', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 1200));

      final router = GoRouter(
        initialLocation: '/',
        routes: [
          GoRoute(path: '/', builder: (context, state) => const UsersPage()),
          GoRoute(path: '/admin/settings', builder: (context, state) => const SettingsPage()),
        ],
      );

      await tester.pumpWidget(createTestApp(home: const UsersPage(), customRouter: router));
      await tester.pumpAndSettle();

      final openSettingsBtn = find.text('Mở trang cấu hình chi tiết & Cron');
      expect(openSettingsBtn, findsOneWidget);
      await tester.ensureVisible(openSettingsBtn);
      await tester.tap(openSettingsBtn);
      await tester.pumpAndSettle();

      // Now SettingsPage should be visible
      expect(find.byKey(const Key('route:/admin/settings')), findsOneWidget);
    });

    testWidgets('UsersPage switches to Audit tab and shows AuditLogsView', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 1200));

      await tester.pumpWidget(createTestApp(home: const UsersPage()));
      await tester.pumpAndSettle();

      // Tap tab 3
      final auditTab = find.text('Nhật ký hệ thống');
      await tester.ensureVisible(auditTab);
      await tester.tap(auditTab);
      await tester.pumpAndSettle();

      // AuditLogsView items should be rendered
      expect(find.byType(AuditLogsView), findsOneWidget);
      expect(find.text('Admin Minh'), findsWidgets);
    });

    testWidgets('SettingsPage has root key route:/admin/settings and renders AiGatewayConfigCard & Cron section', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 1200));

      await tester.pumpWidget(createTestApp(home: const SettingsPage()));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('route:/admin/settings')), findsOneWidget);
      expect(find.byType(AiGatewayConfigCard), findsOneWidget);
      expect(find.text('Tiến trình Tự động Hằng ngày (Cron 00:05 — FR-066 / FR-064)'), findsOneWidget);
      expect(find.text('Chạy đồng bộ ngay'), findsOneWidget);
    });

    testWidgets('AuditLogsPage has root key route:/admin/audit-logs and wraps AuditLogsView', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 1200));

      await tester.pumpWidget(createTestApp(home: const AuditLogsPage()));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('route:/admin/audit-logs')), findsOneWidget);
      expect(find.byType(AuditLogsView), findsOneWidget);
      expect(find.text('Nhật ký Kiểm toán Hệ thống (Audit Logs)'), findsOneWidget);
    });

    testWidgets('AuditLogsView syncs date range with syncFilterDateRange and triggers export', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 1200));

      var exportCalled = false;
      await tester.pumpWidget(createTestApp(
        home: Scaffold(
          body: AuditLogsView(
            onSaveOrShare: (bytes, name, mime) async {
              exportCalled = true;
            },
          ),
        ),
      ));
      await tester.pumpAndSettle();

      expect(find.text('Xuất CSV (RP-08)'), findsOneWidget);
      expect(find.text('Xuất Excel (.xlsx)'), findsOneWidget);

      // Tap CSV export button
      final csvBtn = find.text('Xuất CSV (RP-08)');
      await tester.ensureVisible(csvBtn);
      await tester.tap(csvBtn);
      await tester.pumpAndSettle();

      expect(exportCalled, isTrue);
    });

    // -------------------------------------------------------------------------
    // D21-D22: React/Flutter logic parity tests
    // -------------------------------------------------------------------------

    testWidgets('config tab renders full billing, SLA and contact field groups', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 1200));
      await tester.pumpWidget(createTestApp(home: const UsersPage()));
      await tester.pumpAndSettle();

      final configTab = find.text('Cấu hình hệ thống');
      await tester.ensureVisible(configTab);
      await tester.tap(configTab);
      await tester.pumpAndSettle();

      // Billing (3 fields missing in Flutter)
      expect(find.text('Thời hạn thanh toán (số ngày sau phát hành)'), findsOneWidget);
      expect(find.text('Các mốc ngày nhắc nợ tự động (cách nhau dấu phẩy)'), findsOneWidget);
      expect(find.text('Lãi phạt chậm thanh toán (% / tháng)'), findsOneWidget);
      // SLA (2 fields missing in Flutter)
      expect(find.text('SLA xử lý sự cố KHẨN CẤP (giờ)'), findsOneWidget);
      expect(find.text('SLA xử lý sự cố THÔNG THƯỜNG (giờ)'), findsOneWidget);
      // Contact (3 fields missing in Flutter)
      expect(find.text('Hotline An ninh / Trực bảo vệ 24/7'), findsOneWidget);
      expect(find.text('Số điện thoại khẩn cấp / PCCC'), findsOneWidget);
      expect(find.text('Email tiếp nhận hỗ trợ cư dân'), findsOneWidget);
    });

    testWidgets('role badges use ROLE_LABELS instead of raw codes', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 1200));
      await tester.pumpWidget(createTestApp(home: const UsersPage()));
      await tester.pumpAndSettle();

      // React renders ROLE_LABELS[code] (e.g. "Quản trị hệ thống"), not the raw code.
      expect(find.textContaining('Quản trị hệ thống'), findsWidgets);
      expect(find.textContaining('Quản lý tòa nhà'), findsWidgets);
    });

    testWidgets('edit modal has account status select and can remove the last role', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 1200));
      await tester.pumpWidget(createTestApp(home: const UsersPage()));
      await tester.pumpAndSettle();

      // u-1 has exactly one role; open its edit modal.
      final editBtn = find.text('Phân quyền').first;
      await tester.ensureVisible(editBtn);
      await tester.tap(editBtn);
      await tester.pumpAndSettle();

      expect(find.text('Trạng thái tài khoản'), findsOneWidget);

      // Removing the only role must be allowed while editing (minRoles = 0).
      expect(find.byKey(const Key('remove-role-row-0')), findsOneWidget);
      await tester.tap(find.byKey(const Key('remove-role-row-0')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('remove-role-row-0')), findsNothing);
    });

    testWidgets('search input debounces user fetch by 200ms', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 1200));
      await tester.pumpWidget(createTestApp(home: const UsersPage()));
      await tester.pumpAndSettle();

      final initialCount = userListFetchCount;
      expect(initialCount, greaterThanOrEqualTo(1));

      final searchField = find.byType(TextField).first;
      await tester.enterText(searchField, 'A');
      await tester.pump(const Duration(milliseconds: 50));
      await tester.enterText(searchField, 'AB');
      await tester.pump(const Duration(milliseconds: 50));
      await tester.enterText(searchField, 'ABC');
      // Still within the 200ms window — no fetch yet.
      await tester.pump(const Duration(milliseconds: 50));
      expect(userListFetchCount, initialCount);

      // After a 200ms debounce a single fetch fires (must have happened by 350ms total).
      await tester.pump(const Duration(milliseconds: 210));
      expect(userListFetchCount, initialCount + 1, reason: 'fetch must fire within 200ms debounce');
      await tester.pumpAndSettle();
    });
  });

  group('UsersPage settings payload parity (D21-D22)', () {
    Map<String, dynamic> baseBilling() => <String, dynamic>{
          'billing_day': 1,
          'payment_due_days': 5,
          'reminder_days_text': '3, 7, 15',
          'late_fee_percent': 0,
          'electricity_default_price': 3800,
          'water_default_price': 22000,
        };

    test('buildSettingsPayload clamps billing_day to 1..31 and payment_due_days to >=1', () {
      final payload = buildSettingsPayload(
        billing: <String, dynamic>{
          ...baseBilling(),
          'billing_day': '99',
          'payment_due_days': '0',
        },
        sla: Map<String, dynamic>.from(kUsersDefaultSlaConfig),
        contact: Map<String, dynamic>.from(kUsersDefaultContactConfig),
        approval: const <String, dynamic>{},
        ai: const <String, dynamic>{},
      );
      final billing = payload['billing_config'] as Map<String, dynamic>;
      expect(billing['billing_day'], 31);
      expect(billing['payment_due_days'], 1);
    });

    test('buildSettingsPayload falls back monthly_budget_vnd to 0 and keeps fractional late_fee_percent', () {
      final payload = buildSettingsPayload(
        billing: <String, dynamic>{...baseBilling(), 'late_fee_percent': '0.5'},
        sla: Map<String, dynamic>.from(kUsersDefaultSlaConfig),
        contact: Map<String, dynamic>.from(kUsersDefaultContactConfig),
        approval: const <String, dynamic>{},
        ai: const <String, dynamic>{'monthly_budget_vnd': '', 'monthly_token_limit': ''},
      );
      expect((payload['billing_config'] as Map)['late_fee_percent'], 0.5);
      expect((payload['ai_config'] as Map)['monthly_budget_vnd'], 0);
    });

    test('billingStateFromConfig derives reminder_days_text instead of keeping stale text', () {
      final state = billingStateFromConfig(<String, dynamic>{
        'billing_day': 5,
        'reminder_days': <int>[3, 10],
      });
      expect(state['reminder_days_text'], '3, 10');
      expect(state['billing_day'], 5);
      expect(billingStateFromConfig(null)['reminder_days_text'], '3, 7, 15');
    });

    test('role badge constants match React (RESIDENT is purple)', () {
      expect(kRoleLabels['RESIDENT'], 'Cư dân');
      expect(kRoleBadgeVariants['RESIDENT'], AppBadgeVariant.purple);
    });
  });
}
