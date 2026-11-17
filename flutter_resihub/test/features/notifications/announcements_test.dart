import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/utils/notification_navigation.dart';
import 'package:flutter_resihub/core/utils/zalo_format.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/auth/providers/permission_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/notifications/screens/notifications_page.dart';
import 'package:flutter_resihub/features/notifications/services/announcements_service.dart';
import 'package:flutter_resihub/features/notifications/services/notifications_service.dart';
import 'package:flutter_resihub/shared/providers/notification_provider.dart';

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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Dio dio;
  late RequestOptions lastRequest;
  late AnnouncementsService announcementsService;

  setUp(() {
    dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
    dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
      lastRequest = options;
      return ResponseBody.fromString(
        jsonEncode({
          'success': true,
          'message': 'OK',
          'data': {
            'id': 'test-id-123',
            'title': 'Thông báo thử nghiệm',
            'recipient_count': 10,
          },
        }),
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );
    });

    announcementsService = AnnouncementsService(dio);
  });

  group('AnnouncementsService - 10 Canonical Methods Matching announcements.service.js', () {
    test('1. listTemplates sends GET /api/v1/announcements/templates', () async {
      final res = await announcementsService.listTemplates();
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/announcements/templates');
    });

    test('2. listAnnouncements sends GET /api/v1/announcements with params', () async {
      final res = await announcementsService.listAnnouncements({
        'building_id': 'b-101',
        'status': 'SENT',
      });
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/announcements');
      expect(lastRequest.queryParameters['building_id'], 'b-101');
      expect(lastRequest.queryParameters['status'], 'SENT');
    });

    test('3. createAnnouncement sends POST /api/v1/announcements with payload and Idempotency-Key', () async {
      final payload = {
        'building_id': 'b-101',
        'target_scope': 'BUILDING',
        'type': 'ANNOUNCEMENT',
        'title': 'Bảo trì tòa nhà',
        'body': 'Nội dung thông báo bảo trì',
        'zalo_content': 'Nội dung zalo',
      };
      final res = await announcementsService.createAnnouncement(payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/announcements');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('4. updateAnnouncement sends PUT /api/v1/announcements/:id with payload (STRICT PUT)', () async {
      final payload = {
        'title': 'Tiêu đề đã sửa',
        'status': 'DRAFT',
      };
      final res = await announcementsService.updateAnnouncement('ann-456', payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'PUT');
      expect(lastRequest.path, '/api/v1/announcements/ann-456');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('5. sendAnnouncement sends POST /api/v1/announcements/:id/send with confirm_send', () async {
      final res = await announcementsService.sendAnnouncement('ann-456');
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/announcements/ann-456/send');
      expect(lastRequest.data, {'confirm_send': true});
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('6. markZaloSent sends POST /api/v1/announcements/:id/mark-zalo-sent with payload', () async {
      final payload = {
        'zalo_group_ids': ['zg-1', 'zg-2'],
        'note': 'Đã gửi vào nhóm lúc 9h',
      };
      final res = await announcementsService.markZaloSent('ann-456', payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/announcements/ann-456/mark-zalo-sent');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('7. listZaloGroups sends GET /api/v1/zalo-groups with params', () async {
      final res = await announcementsService.listZaloGroups({
        'building_id': 'b-101',
        'scope': 'BUILDING',
      });
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/zalo-groups');
      expect(lastRequest.queryParameters['building_id'], 'b-101');
      expect(lastRequest.queryParameters['scope'], 'BUILDING');
    });

    test('8. createZaloGroup sends POST /api/v1/zalo-groups with payload and Idempotency-Key', () async {
      final payload = {
        'building_id': 'b-101',
        'scope': 'BUILDING',
        'name': 'Nhóm Cư dân Tòa A',
        'invite_link': 'https://zalo.me/g/abcd123',
        'is_active': true,
      };
      final res = await announcementsService.createZaloGroup(payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/zalo-groups');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('9. updateZaloGroup sends PUT /api/v1/zalo-groups/:id with payload (STRICT PUT)', () async {
      final payload = {
        'name': 'Nhóm Cư dân Tòa A (Đổi tên)',
        'invite_link': 'https://chat.zalo.me/g/xyz987',
        'is_active': true,
      };
      final res = await announcementsService.updateZaloGroup('zg-888', payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'PUT');
      expect(lastRequest.path, '/api/v1/zalo-groups/zg-888');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('10. deleteZaloGroup sends DELETE /api/v1/zalo-groups/:id', () async {
      final res = await announcementsService.deleteZaloGroup('zg-888');
      expect(res, isNotNull);
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/zalo-groups/zg-888');
    });
  });

  group('Zalo Format & URL Validation Helpers', () {
    test('isValidZaloGroupUrl validates zalo.me and chat.zalo.me links', () {
      expect(isValidZaloGroupUrl('https://zalo.me/g/thongbaocudan'), isTrue);
      expect(isValidZaloGroupUrl('https://chat.zalo.me/g/bql-toanha-101'), isTrue);
      expect(isValidZaloGroupUrl(''), isTrue); // Empty allowed in form
      expect(isValidZaloGroupUrl(null), isTrue);

      expect(isValidZaloGroupUrl('http://zalo.me/g/test'), isFalse); // Non-HTTPS
      expect(isValidZaloGroupUrl('https://facebook.com/groups/123'), isFalse);
      expect(isValidZaloGroupUrl('https://zalo.me/../malicious'), isFalse);
    });

    test('kZaloQuickTemplates provides 5 predefined templates', () {
      expect(kZaloQuickTemplates.length, 5);
      final keys = kZaloQuickTemplates.map((t) => t.key).toList();
      expect(keys, contains('UTILITY_INTERRUPTION'));
      expect(keys, contains('MAINTENANCE_NOTICE'));
      expect(keys, contains('HOUSE_RULES'));
      expect(keys, contains('SECURITY_ALERT'));
      expect(keys, contains('GENERAL_ANNOUNCEMENT'));
    });

    test('buildZaloPreviewText creates structured text with bold markers', () {
      final preview = buildZaloPreviewText(
        type: 'UTILITY_INTERRUPTION',
        title: 'Cắt nước bảo trì',
        body: 'Tạm ngừng cấp nước từ 8h đến 11h',
        targetScope: 'BUILDING',
        buildingCode: 'VOP-A',
        buildingName: 'Vinhomes Ocean Park A',
      );
      expect(preview, contains('**[THÔNG BÁO BQL TÒA VOP-A]**'));
      expect(preview, contains('**THÔNG BÁO ĐIỆN / NƯỚC**'));
      expect(preview, contains('**Cắt nước bảo trì**'));
      expect(preview, contains('Tạm ngừng cấp nước từ 8h đến 11h'));
    });

    test('parseZaloBoldSegments extracts bold vs regular segments', () {
      final segments = parseZaloBoldSegments('Chào **Quý Cư dân**, vui lòng **chú ý**!');
      expect(segments.length, 5);
      expect(segments[0].text, 'Chào ');
      expect(segments[0].bold, isFalse);
      expect(segments[1].text, 'Quý Cư dân');
      expect(segments[1].bold, isTrue);
      expect(segments[2].text, ', vui lòng ');
      expect(segments[2].bold, isFalse);
      expect(segments[3].text, 'chú ý');
      expect(segments[3].bold, isTrue);
      expect(segments[4].text, '!');
      expect(segments[4].bold, isFalse);
    });
  });

  group('Organization Broadcast Read State Sync (markAllAsRead)', () {
    test('markAllAsRead syncs extra broadcast rows and updates unreadCount to 0', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final appStorage = AppStorage(prefs: prefs, isWeb: true);
      await appStorage.init();

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(appStorage),
          authProvider.overrideWith(() {
            return _FakeAuthNotifier(
              AuthState(
                user: UserModel(
                  id: 'u-admin-1',
                  email: 'admin@resihub.vn',
                  fullName: 'Quản Lý Vận Hành',
                  roles: [UserRoleModel(code: 'MANAGER', name: 'Manager')],
                ),
                isAuthenticated: true,
              ),
            );
          }),
          notificationsServiceProvider.overrideWithValue(NotificationsService(dio)),
        ],
      );

      final notifier = container.read(notificationProvider.notifier);

      final broadcastRows = [
        {
          'id': 'org-broadcast-1',
          'user_id': null,
          'title': 'Bản tin toàn hệ thống',
          'content': 'Nội dung',
          'read_at': null,
        },
        {
          'id': 'org-broadcast-2',
          'user_id': null,
          'title': 'Thông báo bảo trì máy chủ',
          'content': 'Nội dung',
          'read_at': null,
        },
      ];

      await notifier.markAllAsRead(broadcastRows);

      final state = container.read(notificationProvider);
      expect(state.unreadCount, 0);

      // Verify IDs persisted in storage
      final storedIds = getReadOrgNotifIds('u-admin-1', storage: appStorage);
      expect(storedIds, contains('org-broadcast-1'));
      expect(storedIds, contains('org-broadcast-2'));

      container.dispose();
    });
  });

  group('Permission Matrix - Notifications & Zalo Groups', () {
    test('OWNER is read-only (cannot send announcements or manage Zalo groups)', () {
      final ownerUser = UserModel(
        id: 'u-owner-1',
        email: 'owner@resihub.vn',
        fullName: 'Chủ Tòa Nhà',
        roles: [UserRoleModel(code: 'OWNER', name: 'Owner')],
      );
      final matrix = PermissionMatrix(ownerUser);
      expect(matrix.isOwner, isTrue);
      expect(matrix.canSendAnnouncements, isFalse);
      expect(matrix.canSendNotifications, isFalse);
      expect(matrix.canManageZaloGroups, isFalse);
      expect(matrix.canDeleteZaloGroups, isFalse);
    });

    test('MANAGER can send announcements and manage Zalo groups (cannot delete)', () {
      final managerUser = UserModel(
        id: 'u-mgr-1',
        email: 'mgr@resihub.vn',
        fullName: 'Quản Lý Tòa Nhà',
        roles: [UserRoleModel(code: 'MANAGER', name: 'Manager')],
      );
      final matrix = PermissionMatrix(managerUser);
      expect(matrix.isManager, isTrue);
      expect(matrix.canSendAnnouncements, isTrue);
      expect(matrix.canSendNotifications, isTrue);
      expect(matrix.canManageZaloGroups, isTrue);
      expect(matrix.canDeleteZaloGroups, isFalse);
    });

    test('SYS_ADMIN can manage and delete Zalo groups', () {
      final adminUser = UserModel(
        id: 'u-admin-1',
        email: 'admin@resihub.vn',
        fullName: 'Quản Trị Viên',
        roles: [UserRoleModel(code: 'SYS_ADMIN', name: 'Sys Admin')],
      );
      final matrix = PermissionMatrix(adminUser);
      expect(matrix.isSysAdmin, isTrue);
      expect(matrix.canManageZaloGroups, isTrue);
      expect(matrix.canDeleteZaloGroups, isTrue);
      expect(matrix.canSendAnnouncements, isFalse);
    });
  });

  group('NotificationsPage Widget Tests', () {
    late Dio testDio;

    setUp(() {
      testDio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      testDio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        final path = options.path;
        if (path == '/api/v1/buildings') {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': [
                {'id': 'b-101', 'code': 'VOP-A', 'name': 'Vinhomes Ocean Park A'},
              ],
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (path == '/api/v1/announcements') {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': [
                {
                  'id': 'ann-1',
                  'building_id': 'b-101',
                  'building_code': 'VOP-A',
                  'building_name': 'Vinhomes Ocean Park A',
                  'target_scope': 'BUILDING',
                  'type': 'ANNOUNCEMENT',
                  'title': 'Thông báo họp cư dân',
                  'body': 'Kính mời cư dân tham gia buổi họp',
                  'status': 'SENT',
                  'read_count': 5,
                  'recipient_count': 10,
                  'manual_sent_at': null,
                  'zalo_content': 'Nội dung zalo',
                  'target_zalo_groups': [
                    {
                      'id': 'zg-1',
                      'name': 'Nhóm Cư dân Tòa A',
                      'invite_link': 'https://zalo.me/g/vop-a',
                      'scope': 'BUILDING',
                    }
                  ],
                },
              ],
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (path == '/api/v1/zalo-groups') {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': [
                {
                  'id': 'zg-1',
                  'building_id': 'b-101',
                  'building_code': 'VOP-A',
                  'building_name': 'Vinhomes Ocean Park A',
                  'scope': 'BUILDING',
                  'name': 'Nhóm Cư dân Tòa A',
                  'invite_link': 'https://zalo.me/g/vop-a',
                  'is_active': true,
                  'note': 'Nhóm cư dân chính',
                },
              ],
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (path == '/api/v1/notifications') {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'unread_count': 1,
              'data': [
                {
                  'id': 'notif-1',
                  'type': 'ANNOUNCEMENT',
                  'title': 'Bản tin BQL mới',
                  'content': 'Có thông báo mới được gửi',
                  'read_at': null,
                  'created_at': DateTime.now().toIso8601String(),
                },
              ],
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (path == '/api/v1/notifications/read-all') {
          return ResponseBody.fromString(
            jsonEncode({'success': true}),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': []}),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });
    });

    testWidgets('renders all 3 tabs and announcements for MANAGER', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final appStorage = AppStorage(prefs: prefs, isWeb: true);
      await appStorage.init();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(testDio),
            appStorageProvider.overrideWithValue(appStorage),
            notificationsServiceProvider.overrideWithValue(NotificationsService(testDio)),
            announcementsServiceProvider.overrideWithValue(AnnouncementsService(testDio)),
            buildingsServiceProvider.overrideWithValue(
              BuildingsService(dio: testDio),
            ),
            authProvider.overrideWith(() {
              return _FakeAuthNotifier(
                AuthState(
                  user: UserModel(
                    id: 'u-mgr-1',
                    email: 'mgr@resihub.vn',
                    fullName: 'Quản Lý Tòa Nhà',
                    roles: [UserRoleModel(code: 'MANAGER', name: 'Manager')],
                  ),
                  isAuthenticated: true,
                  selectedBuildingId: 'b-101',
                ),
              );
            }),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: NotificationsPage(),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Check Tabs exist
      expect(find.text('Thông báo & Xuất Zalo'), findsWidgets);
      expect(find.text('Danh bạ Nhóm Zalo'), findsWidgets);
      expect(find.textContaining('Hộp thư đến'), findsWidgets);

      // Check Manager can see compose card
      expect(find.text('Soạn bản tin mới'), findsOneWidget);
      expect(find.text('Mẫu thông báo nhanh (1 chạm điền sẵn)'), findsOneWidget);
      expect(find.text('Phát hành thông báo ngay'), findsOneWidget);

      // Check announcements list item
      expect(find.text('Thông báo họp cư dân'), findsOneWidget);
      expect(find.text('Sao chép dán Zalo'), findsOneWidget);
    });

    testWidgets('respects initialTab parameter (e.g. zalo_groups)', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final appStorage = AppStorage(prefs: prefs, isWeb: true);
      await appStorage.init();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(testDio),
            appStorageProvider.overrideWithValue(appStorage),
            notificationsServiceProvider.overrideWithValue(NotificationsService(testDio)),
            announcementsServiceProvider.overrideWithValue(AnnouncementsService(testDio)),
            buildingsServiceProvider.overrideWithValue(
              BuildingsService(dio: testDio),
            ),
            authProvider.overrideWith(() {
              return _FakeAuthNotifier(
                AuthState(
                  user: UserModel(
                    id: 'u-mgr-1',
                    email: 'mgr@resihub.vn',
                    fullName: 'Quản Lý Tòa Nhà',
                    roles: [UserRoleModel(code: 'MANAGER', name: 'Manager')],
                  ),
                  isAuthenticated: true,
                  selectedBuildingId: 'b-101',
                ),
              );
            }),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: NotificationsPage(initialTab: 'zalo_groups'),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Should display Zalo groups tab contents
      expect(find.text('Thêm nhóm Zalo'), findsOneWidget);
      expect(find.text('Nhóm Cư dân Tòa A'), findsOneWidget);
    });

    testWidgets('OWNER sees read-only announcements without compose card', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final appStorage = AppStorage(prefs: prefs, isWeb: true);
      await appStorage.init();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(testDio),
            appStorageProvider.overrideWithValue(appStorage),
            notificationsServiceProvider.overrideWithValue(NotificationsService(testDio)),
            announcementsServiceProvider.overrideWithValue(AnnouncementsService(testDio)),
            buildingsServiceProvider.overrideWithValue(
              BuildingsService(dio: testDio),
            ),
            authProvider.overrideWith(() {
              return _FakeAuthNotifier(
                AuthState(
                  user: UserModel(
                    id: 'u-owner-1',
                    email: 'owner@resihub.vn',
                    fullName: 'Chủ Sở Hữu',
                    roles: [UserRoleModel(code: 'OWNER', name: 'Owner')],
                  ),
                  isAuthenticated: true,
                  selectedBuildingId: 'b-101',
                ),
              );
            }),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: NotificationsPage(),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Compose form should NOT be present for OWNER
      expect(find.text('Soạn bản tin mới'), findsNothing);
      expect(find.text('Phát hành thông báo ngay'), findsNothing);

      // Announcements list is still visible
      expect(find.text('Thông báo họp cư dân'), findsOneWidget);
      expect(find.text('Xem nội dung Zalo'), findsOneWidget);
    });

    testWidgets('modal renders as an overlay above the scroll view rather than inside scroll column', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final appStorage = AppStorage(prefs: prefs, isWeb: true);
      await appStorage.init();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(testDio),
            appStorageProvider.overrideWithValue(appStorage),
            notificationsServiceProvider.overrideWithValue(NotificationsService(testDio)),
            announcementsServiceProvider.overrideWithValue(AnnouncementsService(testDio)),
            buildingsServiceProvider.overrideWithValue(
              BuildingsService(dio: testDio),
            ),
            authProvider.overrideWith(() {
              return _FakeAuthNotifier(
                AuthState(
                  user: UserModel(
                    id: 'u-mgr-1',
                    email: 'mgr@resihub.vn',
                    fullName: 'Quản Lý Tòa Nhà',
                    roles: [UserRoleModel(code: 'MANAGER', name: 'Manager')],
                  ),
                  isAuthenticated: true,
                  selectedBuildingId: 'b-101',
                ),
              );
            }),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: NotificationsPage(),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Tap 'Sao chép dán Zalo' to open modal overlay
      final openModalButton = find.text('Sao chép dán Zalo');
      expect(openModalButton, findsOneWidget);
      await tester.tap(openModalButton);
      await tester.pumpAndSettle();

      // Modal content is visible
      expect(find.text('Sao chép & Dán sang nhóm Zalo vận hành'), findsOneWidget);

      // Verify page root Stack has modal layer rendered above the scroll view
      final rootStack = find.byType(Stack).first;
      expect(rootStack, findsOneWidget);

      // Verify the modal is NOT inside the main SingleChildScrollView's Column
      final scrollView = find.byType(SingleChildScrollView).first;
      final scrollColumn = find.descendant(of: scrollView, matching: find.byType(Column)).first;
      final modalInsideScrollColumn = find.descendant(
        of: scrollColumn,
        matching: find.text('Sao chép & Dán sang nhóm Zalo vận hành'),
      );
      expect(modalInsideScrollColumn, findsNothing);
    });
  });

  group('D20 parity - compose & inbox', () {
    late Dio parityDio;
    Map<String, dynamic>? draftPayload;
    List<Map<String, dynamic>> inboxRows = [];
    int serverUnread = 0;

    setUp(() {
      draftPayload = null;
      inboxRows = [];
      serverUnread = 0;
      parityDio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      parityDio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        final path = options.path;
        if (options.method == 'POST' && path == '/api/v1/announcements') {
          draftPayload = Map<String, dynamic>.from(options.data as Map);
        }
        dynamic body;
        if (path == '/api/v1/buildings') {
          body = {
            'success': true,
            'data': [
              {'id': 'b-101', 'code': 'VOP-A', 'name': 'Vinhomes Ocean Park A'},
              {'id': 'b-999', 'code': 'OTHER-B', 'name': 'Tòa khác'},
            ],
          };
        } else if (path == '/api/v1/notifications') {
          body = {'success': true, 'unread_count': serverUnread, 'data': inboxRows};
        } else {
          body = {'success': true, 'data': []};
        }
        return ResponseBody.fromString(
          jsonEncode(body),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });
    });

    Future<void> pumpPage(WidgetTester tester, {String tab = 'announcements'}) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final appStorage = AppStorage(prefs: prefs, isWeb: true);
      await appStorage.init();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(parityDio),
            appStorageProvider.overrideWithValue(appStorage),
            notificationsServiceProvider.overrideWithValue(NotificationsService(parityDio)),
            announcementsServiceProvider.overrideWithValue(AnnouncementsService(parityDio)),
            buildingsServiceProvider.overrideWithValue(BuildingsService(dio: parityDio)),
            authProvider.overrideWith(() {
              return _FakeAuthNotifier(
                AuthState(
                  user: UserModel(
                    id: 'u-mgr-1',
                    email: 'mgr@resihub.vn',
                    fullName: 'Quản Lý Tòa Nhà',
                    roles: [UserRoleModel(code: 'MANAGER', name: 'Manager')],
                  ),
                  isAuthenticated: true,
                  selectedBuildingId: 'b-101',
                ),
              );
            }),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: NotificationsPage(initialTab: tab),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('zalo_content is trimmed and never null in save-draft payload', (tester) async {
      await pumpPage(tester);

      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'Tiêu đề test');
      await tester.enterText(fields.at(1), 'Nội dung test');
      await tester.pumpAndSettle();
      await tester.enterText(fields.at(2), '   ');
      await tester.pumpAndSettle();

      final saveButton = find.text('Lưu nháp');
      await tester.ensureVisible(saveButton);
      await tester.pumpAndSettle();
      await tester.tap(saveButton);
      await tester.pumpAndSettle();

      expect(draftPayload, isNotNull);
      final payload = draftPayload!;
      expect(payload['zalo_content'], isA<String>());
      expect(payload['zalo_content'], '');
    });

    testWidgets('inbox filters by payload.building_id and tab label shows "N mới"', (tester) async {
      inboxRows = [
        {
          'id': 'n-ok',
          'type': 'ANNOUNCEMENT',
          'title': 'Thông báo cùng tòa',
          'content': 'Nội dung đúng tòa',
          'read_at': null,
          'payload': {'building_id': 'b-101'},
          'created_at': DateTime.now().toIso8601String(),
        },
        {
          'id': 'n-other',
          'type': 'ANNOUNCEMENT',
          'title': 'Thông báo tòa khác',
          'content': 'Nội dung tòa khác',
          'read_at': null,
          'payload': {'building_id': 'b-999'},
          'created_at': DateTime.now().toIso8601String(),
        },
      ];
      serverUnread = 2;

      await pumpPage(tester, tab: 'inbox');

      expect(find.text('Thông báo cùng tòa'), findsOneWidget);
      expect(find.text('Thông báo tòa khác'), findsNothing);
      expect(find.text('Hộp thư đến (2 mới)'), findsOneWidget);
    });

    test('toLocalDateTimeInputValue converts ISO to local datetime input value', () {
      expect(toLocalDateTimeInputValue(null), '');
      expect(toLocalDateTimeInputValue(''), '');
      expect(toLocalDateTimeInputValue('không phải ngày'), '');
      expect(toLocalDateTimeInputValue('2026-12-01T08:30:45'), '2026-12-01T08:30');

      final dt = DateTime.utc(2027, 1, 2, 3, 4).toLocal();
      String p(int n) => n.toString().padLeft(2, '0');
      final expected = '${dt.year}-${p(dt.month)}-${p(dt.day)}T${p(dt.hour)}:${p(dt.minute)}';
      expect(toLocalDateTimeInputValue('2027-01-02T03:04:00.000Z'), expected);
    });
  });
}

class _FakeAuthNotifier extends AuthNotifier {
  final AuthState _initial;
  _FakeAuthNotifier(this._initial);

  @override
  AuthState build() => _initial;
}
