import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/constants/roles.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/network/session_lifecycle_bridge.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/utils/permissions.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/auth/providers/permission_provider.dart';
import 'package:flutter_resihub/features/auth/services/auth_service.dart';

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

  group('1. Permissions Utility Helpers (permissions.dart)', () {
    test('extractRoleCodes handles null, string list, map list, and UserModel', () {
      expect(extractRoleCodes(null), isEmpty);
      expect(extractRoleCodes({}), isEmpty);
      expect(extractRoleCodes({'roles': null}), isEmpty);
      expect(
        extractRoleCodes({'roles': ['MANAGER', 'RESIDENT', 'MANAGER']}),
        ['MANAGER', 'RESIDENT'],
      );
      expect(
        extractRoleCodes({
          'roles': [
            {'code': 'SYS_ADMIN', 'name': 'Quản trị'},
            {'code': 'OWNER', 'building_id': 'b-123'},
            {'code': 'SYS_ADMIN'},
          ],
        }),
        ['SYS_ADMIN', 'OWNER'],
      );

      final user = UserModel(
        id: 'u1',
        fullName: 'Nguyễn Văn A',
        roles: [
          UserRoleModel(code: 'SYS_ADMIN'),
          UserRoleModel(code: 'MANAGER', buildingId: 'b-99'),
        ],
      );
      expect(extractRoleCodes(user), ['SYS_ADMIN', 'MANAGER']);
    });

    test('getPrimaryRole respects priority SYS_ADMIN > OWNER > MANAGER > RESIDENT', () {
      expect(getPrimaryRole(null), AppRole.resident);
      expect(getPrimaryRole({'roles': []}), AppRole.resident);

      expect(
        getPrimaryRole({'roles': ['RESIDENT']}),
        AppRole.resident,
      );
      expect(
        getPrimaryRole({'roles': ['MANAGER', 'RESIDENT']}),
        AppRole.manager,
      );
      expect(
        getPrimaryRole({'roles': ['RESIDENT', 'OWNER', 'MANAGER']}),
        AppRole.owner,
      );
      expect(
        getPrimaryRole({'roles': ['RESIDENT', 'SYS_ADMIN', 'OWNER']}),
        AppRole.sysAdmin,
      );
    });

    test('hasAnyRole checks single and list of roles for both string and AppRole', () {
      final user = {'roles': ['MANAGER', 'RESIDENT']};
      expect(hasAnyRole(user, null), isTrue);
      expect(hasAnyRole(user, []), isTrue);
      expect(hasAnyRole(user, 'MANAGER'), isTrue);
      expect(hasAnyRole(user, AppRole.manager), isTrue);
      expect(hasAnyRole(user, [AppRole.sysAdmin, AppRole.manager]), isTrue);
      expect(hasAnyRole(user, [AppRole.sysAdmin, AppRole.owner]), isFalse);
      expect(hasAnyRole(user, ['SYS_ADMIN']), isFalse);
    });

    test('isAdminPortalUser returns true for admin portal roles and false for resident', () {
      expect(isAdminPortalUser({'roles': ['SYS_ADMIN']}), isTrue);
      expect(isAdminPortalUser({'roles': ['OWNER']}), isTrue);
      expect(isAdminPortalUser({'roles': ['MANAGER']}), isTrue);
      expect(isAdminPortalUser({'roles': ['RESIDENT']}), isFalse);
      expect(isAdminPortalUser(null), isFalse);
    });

    test('getAssignedBuildingIds extracts deduplicated building IDs from user roles', () {
      expect(getAssignedBuildingIds(null), isEmpty);
      expect(getAssignedBuildingIds({'roles': []}), isEmpty);
      expect(getAssignedBuildingIds({'roles': ['SYS_ADMIN']}), isEmpty);

      final mapUser = {
        'roles': [
          {'code': 'MANAGER', 'building_id': 'b1'},
          {'code': 'MANAGER', 'building_id': 'b2'},
          {'code': 'OWNER', 'building_id': 'b1'}, // duplicate b1
          {'code': 'RESIDENT', 'building_id': null},
          {'code': 'SYS_ADMIN'},
        ],
      };
      expect(getAssignedBuildingIds(mapUser), ['b1', 'b2']);

      final modelUser = UserModel(
        id: 'u2',
        fullName: 'Trần B',
        roles: [
          UserRoleModel(code: 'MANAGER', buildingId: 'b-alpha'),
          UserRoleModel(code: 'OWNER', buildingId: 'b-beta'),
          UserRoleModel(code: 'RESIDENT', buildingId: 'b-alpha'),
        ],
      );
      expect(getAssignedBuildingIds(modelUser), ['b-alpha', 'b-beta']);
    });
  });

  group('2. UserModel (user_model.dart)', () {
    test('UserModel.fromJson parses full backend user payload correctly', () {
      final json = {
        'id': 'u-uuid-1234',
        'sub': 'u-uuid-1234',
        'full_name': 'Lê Văn Cường',
        'email': 'cuong.le@example.com',
        'phone': '0901234567',
        'org_id': 'org-001',
        'avatar_url': '/api/v1/attachments/avatar-1/view',
        'token_version': 2,
        'roles': [
          {'code': 'MANAGER', 'name': 'Quản lý tòa nhà', 'building_id': 'b-55'},
          {'code': 'RESIDENT', 'name': 'Cư dân'},
        ],
      };

      final user = UserModel.fromJson(json);
      expect(user.id, 'u-uuid-1234');
      expect(user.fullName, 'Lê Văn Cường');
      expect(user.email, 'cuong.le@example.com');
      expect(user.phone, '0901234567');
      expect(user.orgId, 'org-001');
      expect(user.avatarUrl, '/api/v1/attachments/avatar-1/view');
      expect(user.tokenVersion, 2);
      expect(user.roles.length, 2);
      expect(user.roles[0].code, 'MANAGER');
      expect(user.roles[0].name, 'Quản lý tòa nhà');
      expect(user.roles[0].buildingId, 'b-55');
      expect(user.roles[0].appRole, AppRole.manager);

      expect(user.primaryRole, AppRole.manager);
      expect(user.roleCodes, ['MANAGER', 'RESIDENT']);
      expect(user.assignedBuildingIds, ['b-55']);
      expect(user.isAdminPortal, isTrue);
    });

    test('UserModel.toJson serializes snake_case format matching backend', () {
      final user = UserModel(
        id: 'u-100',
        fullName: 'Ngô Thị Mai',
        email: 'mai@example.com',
        phone: '0988776655',
        orgId: 'org-10',
        avatarUrl: 'https://example.com/avatar.png',
        roles: [
          UserRoleModel(code: 'OWNER', name: 'Chủ sở hữu', buildingId: 'b-99'),
        ],
      );

      final json = user.toJson();
      expect(json['id'], 'u-100');
      expect(json['sub'], 'u-100');
      expect(json['full_name'], 'Ngô Thị Mai');
      expect(json['email'], 'mai@example.com');
      expect(json['phone'], '0988776655');
      expect(json['org_id'], 'org-10');
      expect(json['avatar_url'], 'https://example.com/avatar.png');
      expect(json['roles'], isA<List>());
      final roleJson = (json['roles'] as List).first as Map<String, dynamic>;
      expect(roleJson['code'], 'OWNER');
      expect(roleJson['name'], 'Chủ sở hữu');
      expect(roleJson['building_id'], 'b-99');
    });

    test('UserModel copyWith and equality work deterministically', () {
      final user1 = UserModel(
        id: 'u-1',
        fullName: 'User 1',
        roles: [UserRoleModel(code: 'SYS_ADMIN')],
      );
      final user2 = user1.copyWith(fullName: 'User 1 Updated');

      expect(user2.id, 'u-1');
      expect(user2.fullName, 'User 1 Updated');
      expect(user2.roles, user1.roles);
      expect(user1 == user2, isFalse);

      final user3 = UserModel(
        id: 'u-1',
        fullName: 'User 1',
        roles: [UserRoleModel(code: 'SYS_ADMIN')],
      );
      expect(user1 == user3, isTrue);
      expect(user1.hashCode, user3.hashCode);
    });
  });

  group('3. AuthService (auth_service.dart) - 11 Methods Parity', () {
    late Dio dio;
    late Dio publicDio;
    late AuthService service;
    late List<Map<String, dynamic>> capturedRequests;

    setUp(() {
      capturedRequests = [];

      final adapter = _MockHttpClientAdapter((options) async {
        capturedRequests.add({
          'method': options.method,
          'path': options.path,
          'data': options.data,
          'headers': options.headers,
        });

        dynamic responseBody = {'success': true};
        if (options.path.contains('/public-config')) {
          responseBody = {'env': 'production', 'allow_registration': false};
        } else if (options.path.contains('/login') || options.path.contains('/otp/verify')) {
          responseBody = {
            'accessToken': 'token_abc',
            'refreshToken': 'token_xyz',
            'user': {
              'id': 'u1',
              'full_name': 'Test User',
              'roles': [{'code': 'MANAGER'}],
            },
          };
        } else if (options.path.contains('/profile')) {
          responseBody = {'data': {'person_id': 'p1', 'full_name': 'Profile User'}};
        }

        return ResponseBody.fromString(
          jsonEncode(responseBody),
          200,
          headers: {
            'content-type': ['application/json'],
          },
        );
      });

      dio = Dio()..httpClientAdapter = adapter;
      publicDio = Dio()..httpClientAdapter = adapter;
      service = AuthService(dio: dio, publicDio: publicDio);
    });

    test('1. getPublicConfig GET /api/v1/auth/public-config', () async {
      final res = await service.getPublicConfig();
      expect(res['env'], 'production');
      expect(capturedRequests.last['method'], 'GET');
      expect(capturedRequests.last['path'], '/api/v1/auth/public-config');
    });

    test('2. loginEmail POST /api/v1/auth/login', () async {
      final res = await service.loginEmail('admin@resihub.vn', 'secret123');
      expect(res['accessToken'], 'token_abc');
      expect(capturedRequests.last['method'], 'POST');
      expect(capturedRequests.last['path'], '/api/v1/auth/login');
      expect(capturedRequests.last['data'], {'email': 'admin@resihub.vn', 'password': 'secret123'});
    });

    test('3. requestOtp POST /api/v1/auth/otp/request', () async {
      await service.requestOtp('0901234567');
      expect(capturedRequests.last['method'], 'POST');
      expect(capturedRequests.last['path'], '/api/v1/auth/otp/request');
      expect(capturedRequests.last['data'], {'phone': '0901234567'});
    });

    test('4. verifyOtp POST /api/v1/auth/otp/verify', () async {
      final res = await service.verifyOtp('0901234567', '123456');
      expect(res['accessToken'], 'token_abc');
      expect(capturedRequests.last['method'], 'POST');
      expect(capturedRequests.last['path'], '/api/v1/auth/otp/verify');
      expect(capturedRequests.last['data'], {'phone': '0901234567', 'otp': '123456'});
    });

    test('5. me GET /api/v1/auth/me', () async {
      await service.me();
      expect(capturedRequests.last['method'], 'GET');
      expect(capturedRequests.last['path'], '/api/v1/auth/me');
    });

    test('6. getProfile GET /api/v1/auth/profile', () async {
      final res = await service.getProfile();
      expect(res['data']['person_id'], 'p1');
      expect(capturedRequests.last['method'], 'GET');
      expect(capturedRequests.last['path'], '/api/v1/auth/profile');
    });

    test('7. updateProfile PATCH /api/v1/auth/profile', () async {
      await service.updateProfile({'full_name': 'Updated Name'});
      expect(capturedRequests.last['method'], 'PATCH');
      expect(capturedRequests.last['path'], '/api/v1/auth/profile');
      expect(capturedRequests.last['data'], {'full_name': 'Updated Name'});
    });

    test('8. changePassword POST /api/v1/auth/change-password', () async {
      await service.changePassword('oldPass123', 'newPass456');
      expect(capturedRequests.last['method'], 'POST');
      expect(capturedRequests.last['path'], '/api/v1/auth/change-password');
      expect(capturedRequests.last['data'], {'currentPassword': 'oldPass123', 'newPassword': 'newPass456'});
    });

    test('9. forgotPassword POST /api/v1/auth/forgot-password', () async {
      await service.forgotPassword('reset@example.com');
      expect(capturedRequests.last['method'], 'POST');
      expect(capturedRequests.last['path'], '/api/v1/auth/forgot-password');
      expect(capturedRequests.last['data'], {'email': 'reset@example.com'});
    });

    test('10. resetPassword POST /api/v1/auth/reset-password', () async {
      await service.resetPassword(
        email: 'reset@example.com',
        code: '654321',
        newPassword: 'freshPassword789',
      );
      expect(capturedRequests.last['method'], 'POST');
      expect(capturedRequests.last['path'], '/api/v1/auth/reset-password');
      expect(capturedRequests.last['data'], {
        'email': 'reset@example.com',
        'code': '654321',
        'newPassword': 'freshPassword789',
      });
    });

    test('11. logout POST /api/v1/auth/logout', () async {
      await service.logout();
      expect(capturedRequests.last['method'], 'POST');
      expect(capturedRequests.last['path'], '/api/v1/auth/logout');
    });
  });

  group('4. AuthNotifier & Session Management (auth_provider.dart)', () {
    late AppStorage storage;
    late QueryCache queryCache;
    late SessionLifecycleBridge sessionBridge;
    late ProviderContainer container;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      storage = AppStorage(isWeb: true);
      await storage.init();
      queryCache = QueryCache(storage: storage);
      sessionBridge = SessionLifecycleBridge();

      container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          queryCacheProvider.overrideWithValue(queryCache),
          sessionLifecycleBridgeProvider.overrideWithValue(sessionBridge),
        ],
      );
    });

    tearDown(() {
      container.dispose();
      sessionBridge.dispose();
    });

    test('Hydrates initial authenticated state from storage if already present', () async {
      SharedPreferences.setMockInitialValues({
        'accessToken': 'init_access_token',
        'refreshToken': 'init_refresh_token',
        'user': jsonEncode({
          'id': 'u-init',
          'full_name': 'Init User',
          'roles': [
            {'code': 'MANAGER', 'building_id': 'b-init'},
          ],
        }),
        'selectedBuildingId': 'b-init',
      });

      final hydratedStorage = AppStorage(isWeb: true);
      await hydratedStorage.init();

      final hydContainer = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(hydratedStorage),
          queryCacheProvider.overrideWithValue(QueryCache(storage: hydratedStorage)),
          sessionLifecycleBridgeProvider.overrideWithValue(sessionBridge),
        ],
      );

      final state = hydContainer.read(authProvider);
      expect(state.isAuthenticated, isTrue);
      expect(state.accessToken, 'init_access_token');
      expect(state.refreshToken, 'init_refresh_token');
      expect(state.user?.id, 'u-init');
      expect(state.selectedBuildingId, 'b-init');
      expect(state.primaryRole, AppRole.manager);

      hydContainer.dispose();
    });

    test('setAuthData auto-selects building when user has exactly one building assigned', () async {
      final notifier = container.read(authProvider.notifier);

      final singleBuildingUser = UserModel(
        id: 'u-single',
        fullName: 'Single Building Manager',
        roles: [
          UserRoleModel(code: 'MANAGER', buildingId: 'b-single-100'),
        ],
      );

      await notifier.setAuthData(
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        user: singleBuildingUser,
      );

      final state = container.read(authProvider);
      expect(state.isAuthenticated, isTrue);
      expect(state.accessToken, 'at-1');
      expect(state.user?.id, 'u-single');
      expect(state.selectedBuildingId, 'b-single-100');
      expect(storage.selectedBuildingId, 'b-single-100');
      expect(storage.accessToken, 'at-1');
    });

    test('setAuthData leaves selectedBuildingId empty if user has multiple or 0 buildings', () async {
      final notifier = container.read(authProvider.notifier);

      final multiBuildingUser = UserModel(
        id: 'u-multi',
        fullName: 'Multi Building Manager',
        roles: [
          UserRoleModel(code: 'MANAGER', buildingId: 'b1'),
          UserRoleModel(code: 'MANAGER', buildingId: 'b2'),
        ],
      );

      await notifier.setAuthData(
        accessToken: 'at-2',
        user: multiBuildingUser,
      );

      final state = container.read(authProvider);
      expect(state.selectedBuildingId, '');
      expect(storage.selectedBuildingId, isNull);
    });

    test('setSelectedBuildingId updates state and storage', () async {
      final notifier = container.read(authProvider.notifier);

      await notifier.setSelectedBuildingId('b-custom-999');
      expect(container.read(authProvider).selectedBuildingId, 'b-custom-999');
      expect(storage.selectedBuildingId, 'b-custom-999');

      await notifier.setSelectedBuildingId(null);
      expect(container.read(authProvider).selectedBuildingId, '');
      expect(storage.selectedBuildingId, isNull);
    });

    test('updateUser merges fields into user and persists to storage', () async {
      final notifier = container.read(authProvider.notifier);
      final initialUser = UserModel(
        id: 'u-upd',
        fullName: 'Old Name',
        email: 'old@test.com',
        roles: [UserRoleModel(code: 'MANAGER')],
      );

      await notifier.setAuthData(accessToken: 'at', user: initialUser);
      expect(container.read(authProvider).user?.fullName, 'Old Name');

      await notifier.updateUser({'full_name': 'Brand New Name'});
      final updated = container.read(authProvider).user;
      expect(updated?.fullName, 'Brand New Name');
      expect(updated?.email, 'old@test.com');
      expect(storage.user?['full_name'], 'Brand New Name');
    });

    test('clearSession clears tokens, user, selectedBuildingId, storage, and QueryCache', () async {
      final notifier = container.read(authProvider.notifier);
      await notifier.setAuthData(
        accessToken: 'at',
        refreshToken: 'rt',
        user: UserModel(
          id: 'u-clear',
          fullName: 'To Clear',
          roles: [UserRoleModel(code: 'MANAGER', buildingId: 'b-to-clear')],
        ),
      );
      // Seed some queryCache data
      await queryCache.cachedFetch('test:key', () async => 'cached_data');
      expect(queryCache.peek('test:key'), isNotNull);

      await notifier.clearSession();

      final state = container.read(authProvider);
      expect(state.isAuthenticated, isFalse);
      expect(state.user, isNull);
      expect(state.accessToken, isNull);
      expect(state.refreshToken, isNull);
      expect(state.selectedBuildingId, '');

      expect(storage.accessToken, isNull);
      expect(storage.user, isNull);
      expect(storage.selectedBuildingId, isNull);
      expect(queryCache.peek('test:key'), isNull);
    });

    test('SessionLifecycleBridge notifyTokenRefreshed updates user & accessToken in AuthNotifier', () async {
      // Initialize notifier
      container.read(authProvider);

      final refreshedUserMap = {
        'id': 'u-refreshed',
        'full_name': 'Refreshed Name',
        'roles': [{'code': 'MANAGER', 'building_id': 'b-refreshed'}],
      };

      sessionBridge.notifyTokenRefreshed(refreshedUserMap, 'fresh_token_999');

      final state = container.read(authProvider);
      expect(state.accessToken, 'fresh_token_999');
      expect(state.user?.fullName, 'Refreshed Name');
      expect(state.user?.id, 'u-refreshed');
    });

    test('SessionLifecycleBridge notifySessionExpired clears session & resets selectedBuildingId & QueryCache', () async {
      final notifier = container.read(authProvider.notifier);
      await notifier.setAuthData(
        accessToken: 'at-expire',
        user: UserModel(
          id: 'u-expire',
          fullName: 'Expire Me',
          roles: [UserRoleModel(code: 'MANAGER', buildingId: 'b-exp')],
        ),
      );

      await queryCache.cachedFetch('invoices:all', () async => ['inv-1']);
      expect(queryCache.peek('invoices:all'), isNotNull);

      // Trigger expiration via bridge
      sessionBridge.notifySessionExpired();

      final state = container.read(authProvider);
      expect(state.isAuthenticated, isFalse);
      expect(state.accessToken, isNull);
      expect(state.user, isNull);
      expect(state.selectedBuildingId, '');
      expect(storage.selectedBuildingId, isNull);
      expect(queryCache.peek('invoices:all'), isNull);
    });
  });

  group('5. PermissionMatrix (26 Flags & 4 Roles Parity)', () {
    UserModel makeUser(String roleCode, {String? buildingId}) {
      return UserModel(
        id: 'u-$roleCode',
        fullName: 'User $roleCode',
        roles: [UserRoleModel(code: roleCode, buildingId: buildingId)],
      );
    }

    test('Role SYS_ADMIN satisfies exact 26-flag specifications', () {
      final matrix = PermissionMatrix(makeUser('SYS_ADMIN'));

      // Core role checks
      expect(matrix.isSysAdmin, isTrue);
      expect(matrix.isOwner, isFalse);
      expect(matrix.isManager, isFalse);
      expect(matrix.isResident, isFalse);
      expect(matrix.isAdminPortal, isTrue);

      // Building / Real estate
      expect(matrix.canManageBuildings, isTrue);
      expect(matrix.canCreateBuilding, isTrue);
      expect(matrix.canEditRealEstate, isTrue);
      expect(matrix.isOwnerFieldLockedForManager('owner-uuid'), isFalse);
      expect(matrix.isOwnerFieldLockedForManager(null), isFalse);

      // Tenants
      expect(matrix.canManageTenants, isTrue);
      expect(matrix.isTenantIdImagesMasked, isFalse);

      // Contracts & Price
      expect(matrix.canEditContracts, isFalse);
      expect(matrix.canApprovePrice, isTrue);

      // Deposits
      expect(matrix.canManageDeposits, isFalse);
      expect(matrix.canApproveDeposit, isTrue);

      // Meters & Services
      expect(matrix.canRecordMeters, isFalse);
      expect(matrix.canManageServices, isFalse);

      // Invoices
      expect(matrix.canCreateInvoice, isFalse);
      expect(matrix.canEditInvoice, isFalse);
      expect(matrix.canIssueInvoice, isFalse);
      expect(matrix.canRequestAdjustment, isFalse);
      expect(matrix.canApproveAdjustment, isTrue);

      // Payments
      expect(matrix.canRecordPayment, isFalse);
      expect(matrix.canConfirmPayment, isFalse);
      expect(matrix.canApproveCreditRefund, isTrue);

      // Operations & Communications
      expect(matrix.canHandleMaintenance, isFalse);
      expect(matrix.canSendAnnouncements, isFalse);
      expect(matrix.canManageZaloGroups, isTrue);

      // Admin & Audit
      expect(matrix.canManageUsers, isTrue);
      expect(matrix.canManageSettings, isTrue);
      expect(matrix.canViewAuditLogs, isTrue);
    });

    test('Role OWNER satisfies exact 26-flag specifications', () {
      final matrix = PermissionMatrix(makeUser('OWNER', buildingId: 'b-owner'));

      // Core role checks
      expect(matrix.isSysAdmin, isFalse);
      expect(matrix.isOwner, isTrue);
      expect(matrix.isManager, isFalse);
      expect(matrix.isResident, isFalse);
      expect(matrix.isAdminPortal, isTrue);

      // Building / Real estate
      expect(matrix.canManageBuildings, isFalse);
      expect(matrix.canCreateBuilding, isFalse);
      expect(matrix.canEditRealEstate, isFalse);
      expect(matrix.isOwnerFieldLockedForManager('owner-uuid'), isFalse);

      // Tenants
      expect(matrix.canManageTenants, isFalse);
      expect(matrix.isTenantIdImagesMasked, isTrue);

      // Contracts & Price
      expect(matrix.canEditContracts, isFalse);
      expect(matrix.canApprovePrice, isTrue);

      // Deposits
      expect(matrix.canManageDeposits, isFalse);
      expect(matrix.canApproveDeposit, isTrue);

      // Meters & Services
      expect(matrix.canRecordMeters, isFalse);
      expect(matrix.canManageServices, isFalse);

      // Invoices
      expect(matrix.canCreateInvoice, isFalse);
      expect(matrix.canEditInvoice, isFalse);
      expect(matrix.canIssueInvoice, isFalse);
      expect(matrix.canRequestAdjustment, isFalse);
      expect(matrix.canApproveAdjustment, isTrue);

      // Payments
      expect(matrix.canRecordPayment, isFalse);
      expect(matrix.canConfirmPayment, isFalse);
      expect(matrix.canApproveCreditRefund, isTrue);

      // Operations & Communications
      expect(matrix.canHandleMaintenance, isFalse);
      expect(matrix.canSendAnnouncements, isFalse);
      expect(matrix.canManageZaloGroups, isFalse);

      // Admin & Audit
      expect(matrix.canManageUsers, isFalse);
      expect(matrix.canManageSettings, isFalse);
      expect(matrix.canViewAuditLogs, isTrue);
    });

    test('Role MANAGER satisfies exact 26-flag specifications & owner locking rule', () {
      final matrix = PermissionMatrix(makeUser('MANAGER', buildingId: 'b-manager'));

      // Core role checks
      expect(matrix.isSysAdmin, isFalse);
      expect(matrix.isOwner, isFalse);
      expect(matrix.isManager, isTrue);
      expect(matrix.isResident, isFalse);
      expect(matrix.isAdminPortal, isTrue);

      // Building / Real estate
      expect(matrix.canManageBuildings, isFalse);
      expect(matrix.canCreateBuilding, isTrue);
      expect(matrix.canEditRealEstate, isTrue);
      expect(matrix.isOwnerFieldLockedForManager('owner-123'), isTrue);
      expect(matrix.isOwnerFieldLockedForManager(null), isFalse);
      expect(matrix.isOwnerFieldLockedForManager(''), isFalse);

      // Tenants
      expect(matrix.canManageTenants, isTrue);
      expect(matrix.isTenantIdImagesMasked, isFalse);

      // Contracts & Price
      expect(matrix.canEditContracts, isTrue);
      expect(matrix.canApprovePrice, isFalse);

      // Deposits
      expect(matrix.canManageDeposits, isTrue);
      expect(matrix.canApproveDeposit, isFalse);

      // Meters & Services
      expect(matrix.canRecordMeters, isTrue);
      expect(matrix.canManageServices, isTrue);

      // Invoices
      expect(matrix.canCreateInvoice, isTrue);
      expect(matrix.canEditInvoice, isTrue);
      expect(matrix.canIssueInvoice, isTrue);
      expect(matrix.canRequestAdjustment, isTrue);
      expect(matrix.canApproveAdjustment, isFalse);

      // Payments
      expect(matrix.canRecordPayment, isTrue);
      expect(matrix.canConfirmPayment, isTrue);
      expect(matrix.canApproveCreditRefund, isFalse);

      // Operations & Communications
      expect(matrix.canHandleMaintenance, isTrue);
      expect(matrix.canSendAnnouncements, isTrue);
      expect(matrix.canManageZaloGroups, isTrue);

      // Admin & Audit
      expect(matrix.canManageUsers, isFalse);
      expect(matrix.canManageSettings, isFalse);
      expect(matrix.canViewAuditLogs, isFalse);
    });

    test('Role RESIDENT has no admin permissions', () {
      final matrix = PermissionMatrix(makeUser('RESIDENT'));

      expect(matrix.isSysAdmin, isFalse);
      expect(matrix.isOwner, isFalse);
      expect(matrix.isManager, isFalse);
      expect(matrix.isResident, isTrue);
      expect(matrix.isAdminPortal, isFalse);

      expect(matrix.canManageBuildings, isFalse);
      expect(matrix.canCreateBuilding, isFalse);
      expect(matrix.canEditRealEstate, isFalse);
      expect(matrix.isOwnerFieldLockedForManager('owner-uuid'), isFalse);
      expect(matrix.canManageTenants, isFalse);
      expect(matrix.isTenantIdImagesMasked, isFalse);
      expect(matrix.canEditContracts, isFalse);
      expect(matrix.canApprovePrice, isFalse);
      expect(matrix.canManageDeposits, isFalse);
      expect(matrix.canApproveDeposit, isFalse);
      expect(matrix.canRecordMeters, isFalse);
      expect(matrix.canManageServices, isFalse);
      expect(matrix.canCreateInvoice, isFalse);
      expect(matrix.canEditInvoice, isFalse);
      expect(matrix.canIssueInvoice, isFalse);
      expect(matrix.canRequestAdjustment, isFalse);
      expect(matrix.canApproveAdjustment, isFalse);
      expect(matrix.canRecordPayment, isFalse);
      expect(matrix.canConfirmPayment, isFalse);
      expect(matrix.canApproveCreditRefund, isFalse);
      expect(matrix.canHandleMaintenance, isFalse);
      expect(matrix.canSendAnnouncements, isFalse);
      expect(matrix.canManageZaloGroups, isFalse);
      expect(matrix.canManageUsers, isFalse);
      expect(matrix.canManageSettings, isFalse);
      expect(matrix.canViewAuditLogs, isFalse);
    });

    test('Multi-role user (e.g. MANAGER + OWNER) inherits combination of permissions', () {
      final multiUser = UserModel(
        id: 'u-dual',
        fullName: 'Dual Role User',
        roles: [
          UserRoleModel(code: 'MANAGER', buildingId: 'b1'),
          UserRoleModel(code: 'OWNER', buildingId: 'b1'),
        ],
      );
      final matrix = PermissionMatrix(multiUser);

      expect(matrix.isManager, isTrue);
      expect(matrix.isOwner, isTrue);
      expect(matrix.isSysAdmin, isFalse);

      // Operational canEditContracts (from manager)
      expect(matrix.canEditContracts, isTrue);
      // Approval canApprovePrice (from owner)
      expect(matrix.canApprovePrice, isTrue);
      // Adjustment approval (from owner)
      expect(matrix.canApproveAdjustment, isTrue);
      // Audit logs (from owner)
      expect(matrix.canViewAuditLogs, isTrue);
    });

    test('permissionProvider updates reactively when authProvider changes', () async {
      SharedPreferences.setMockInitialValues({});
      final storage = AppStorage(isWeb: true);
      await storage.init();
      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          queryCacheProvider.overrideWithValue(QueryCache(storage: storage)),
          sessionLifecycleBridgeProvider.overrideWithValue(SessionLifecycleBridge()),
        ],
      );

      // Initially unauthenticated
      expect(container.read(permissionProvider).isAdminPortal, isFalse);

      // Log in as SYS_ADMIN
      await container.read(authProvider.notifier).setAuthData(
        accessToken: 'at-sys',
        user: UserModel(
          id: 'u-admin',
          fullName: 'Super Admin',
          roles: [UserRoleModel(code: 'SYS_ADMIN')],
        ),
      );

      expect(container.read(permissionProvider).isSysAdmin, isTrue);
      expect(container.read(permissionProvider).canManageUsers, isTrue);

      container.dispose();
    });
  });
}
