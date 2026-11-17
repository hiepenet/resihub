import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/errors/app_exception.dart';
import 'package:flutter_resihub/core/network/api_interceptors.dart';
import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/network/session_lifecycle_bridge.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';

/// In-memory mock implementing [SecureStorageInterface] to test mobile platform without channel calls
class MockSecureStorage implements SecureStorageInterface {
  final Map<String, String> _store = {};
  int readCount = 0;
  int writeCount = 0;
  int deleteCount = 0;
  int deleteAllCount = 0;

  @override
  Future<String?> read({required String key}) async {
    readCount++;
    return _store[key];
  }

  @override
  Future<void> write({required String key, required String? value}) async {
    writeCount++;
    if (value != null) {
      _store[key] = value;
    } else {
      _store.remove(key);
    }
  }

  @override
  Future<void> delete({required String key}) async {
    deleteCount++;
    _store.remove(key);
  }

  @override
  Future<void> deleteAll() async {
    deleteAllCount++;
    _store.clear();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('1. Platform-Aware AppStorage', () {
    test('Web Platform (isWeb: true) stores tokens and preferences in SharedPreferences and NEVER touches SecureStorage', () async {
      SharedPreferences.setMockInitialValues({
        'accessToken': 'web_access_token',
        'refreshToken': 'web_refresh_token',
        'user': jsonEncode({'id': 'u_web_1', 'name': 'Web User', 'role': 'MANAGER'}),
        'selectedBuildingId': 'b_123',
        'sidebarCollapsed': true,
        'themeMode': 'dark',
        'aiPrivacyConsent': true,
      });

      final mockSecure = MockSecureStorage();
      final storage = AppStorage(isWeb: true, secureStorage: mockSecure);

      await storage.init();

      // RAM getters check
      expect(storage.accessToken, 'web_access_token');
      expect(storage.refreshToken, 'web_refresh_token');
      expect(storage.user?['id'], 'u_web_1');
      expect(storage.userId, 'u_web_1');
      expect(storage.userRole, 'MANAGER');
      expect(storage.selectedBuildingId, 'b_123');
      expect(storage.sidebarCollapsed, true);
      expect(storage.themeMode, 'dark');
      expect(storage.aiPrivacyConsent, true);
      expect(storage.isAuthenticated, true);

      // Verify SecureStorage was NEVER touched on Web
      expect(mockSecure.readCount, 0);
      expect(mockSecure.writeCount, 0);

      // Mutate tokens and preferences
      await storage.setTokens(accessToken: 'new_web_access', refreshToken: 'new_web_refresh');
      expect(storage.accessToken, 'new_web_access');
      expect(storage.refreshToken, 'new_web_refresh');
      expect(mockSecure.writeCount, 0);

      // Clear session removes auth tokens and user, but preserves UI settings
      await storage.clearSession();
      expect(storage.accessToken, isNull);
      expect(storage.refreshToken, isNull);
      expect(storage.user, isNull);
      expect(storage.isAuthenticated, false);
      expect(storage.sidebarCollapsed, true);
      expect(storage.themeMode, 'dark');
      expect(mockSecure.deleteCount, 0);
    });

    test('Mobile Platform (isWeb: false) stores tokens in SecureStorage and UI preferences in SharedPreferences', () async {
      SharedPreferences.setMockInitialValues({
        'user': jsonEncode({'id': 'u_mob_1', 'name': 'Mobile User', 'role': 'RESIDENT'}),
        'selectedBuildingId': 'b_mob_456',
        'sidebarCollapsed': false,
      });

      final mockSecure = MockSecureStorage();
      await mockSecure.write(key: 'accessToken', value: 'mob_secure_access');
      await mockSecure.write(key: 'refreshToken', value: 'mob_secure_refresh');
      mockSecure.readCount = 0;
      mockSecure.writeCount = 0;

      final storage = AppStorage(isWeb: false, secureStorage: mockSecure);
      await storage.init();

      // Tokens hydrated from SecureStorage into synchronous RAM
      expect(storage.accessToken, 'mob_secure_access');
      expect(storage.refreshToken, 'mob_secure_refresh');
      expect(storage.userId, 'u_mob_1');
      expect(storage.userRole, 'RESIDENT');
      expect(storage.selectedBuildingId, 'b_mob_456');
      expect(storage.sidebarCollapsed, false);
      expect(mockSecure.readCount, 2);

      // Update tokens writes to SecureStorage
      await storage.setTokens(accessToken: 'updated_mob_access');
      expect(storage.accessToken, 'updated_mob_access');
      expect(mockSecure.writeCount, 1);

      // Clear session deletes tokens from SecureStorage and user from SharedPreferences
      await storage.clearSession();
      expect(storage.accessToken, isNull);
      expect(storage.user, isNull);
      expect(mockSecure.deleteCount, 2);
    });
  });

  group('2. SessionLifecycleBridge', () {
    test('notifies token refreshed and session expired listeners', () {
      final bridge = SessionLifecycleBridge();
      Map<String, dynamic>? refreshedUser;
      String? refreshedToken;
      var expiredCalled = false;

      void onToken(Map<String, dynamic>? u, String token) {
        refreshedUser = u;
        refreshedToken = token;
      }

      void onExpired() {
        expiredCalled = true;
      }

      bridge.addTokenRefreshedListener(onToken);
      bridge.addSessionExpiredListener(onExpired);

      bridge.notifyTokenRefreshed({'id': 'u_refreshed'}, 'token_999');
      expect(refreshedUser?['id'], 'u_refreshed');
      expect(refreshedToken, 'token_999');

      bridge.notifySessionExpired();
      expect(expiredCalled, true);

      // Unregister
      bridge.removeTokenRefreshedListener(onToken);
      bridge.removeSessionExpiredListener(onExpired);

      bridge.notifyTokenRefreshed({'id': 'u_none'}, 'token_none');
      expect(refreshedUser?['id'], 'u_refreshed'); // unchanged
    });
  });

  group('3. AppException', () {
    test('maps Dio timeouts and connection errors to friendly Vietnamese messages', () {
      final timeoutEx = AppException.fromDioException(
        DioException(
          requestOptions: RequestOptions(path: '/api/v1/invoices'),
          type: DioExceptionType.connectionTimeout,
        ),
      );
      expect(timeoutEx.message, contains('quá thời gian chờ'));

      final connEx = AppException.fromDioException(
        DioException(
          requestOptions: RequestOptions(path: '/api/v1/invoices'),
          type: DioExceptionType.connectionError,
        ),
      );
      expect(connEx.message, contains('Không thể kết nối đến máy chủ'));
    });

    test('extracts status code, backend code, and custom message from badResponse', () {
      final respEx = AppException.fromDioException(
        DioException(
          requestOptions: RequestOptions(path: '/api/v1/payments'),
          type: DioExceptionType.badResponse,
          response: Response(
            requestOptions: RequestOptions(path: '/api/v1/payments'),
            statusCode: 422,
            data: {
              'code': 'PAYMENT_AMOUNT_INVALID',
              'message': 'Số tiền thanh toán vượt quá số dư nợ hóa đơn',
              'details': {'field': 'amount', 'max': 1500000},
            },
          ),
        ),
      );

      expect(respEx.statusCode, 422);
      expect(respEx.code, 'PAYMENT_AMOUNT_INVALID');
      expect(respEx.message, 'Số tiền thanh toán vượt quá số dư nợ hóa đơn');
      expect(respEx.details['field'], 'amount');
    });
  });

  group('4. QueryCache & URL Invalidation', () {
    test('buildCacheKey performs stable key serialization matching ReactJS queryCache', () {
      final key1 = buildCacheKey('invoices', {'status': 'UNPAID', 'buildingId': 'b1'});
      final key2 = buildCacheKey('invoices', {'buildingId': 'b1', 'status': 'UNPAID'});
      expect(key1, key2);
      expect(key1, 'invoices:{buildingId:b1,status:UNPAID}');

      expect(buildCacheKey('users', null), 'users:all');
      expect(buildCacheKey('users', ''), 'users:all');
    });

    test('resolveScope isolates caches by userId, role, and selectedBuildingId', () async {
      SharedPreferences.setMockInitialValues({});
      final storage = AppStorage(isWeb: true);
      await storage.init();

      final cache = QueryCache(storage: storage);
      expect(cache.resolveScope(), 'anon');

      await storage.setTokens(accessToken: 'abc123xyz_sample_jwt_token_24chars');
      await storage.setUser({'id': 'u_42', 'role': 'MANAGER'});
      await storage.setSelectedBuildingId('b_99');

      expect(cache.resolveScope(), 'u:u_42:r:MANAGER:b:b_99');

      // Change building -> changes scope
      await storage.setSelectedBuildingId('b_100');
      expect(cache.resolveScope(), 'u:u_42:r:MANAGER:b:b_100');
    });

    test('cachedFetch deduplicates concurrent inflight requests and caches within TTL', () async {
      final cache = QueryCache();
      var callCount = 0;

      Future<List<String>> fetcher() async {
        callCount++;
        await Future<void>.delayed(const Duration(milliseconds: 20));
        return ['item1', 'item2'];
      }

      // Concurrent inflight deduplication
      final f1 = cache.cachedFetch<List<String>>('test:list', fetcher);
      final f2 = cache.cachedFetch<List<String>>('test:list', fetcher);
      final results = await Future.wait<List<String>>([f1, f2]);

      expect(callCount, 1);
      expect(results[0], ['item1', 'item2']);
      expect(results[1], ['item1', 'item2']);

      // Subsequent call within TTL reads from cache without calling fetcher
      final f3 = await cache.cachedFetch('test:list', fetcher);
      expect(callCount, 1);
      expect(f3, ['item1', 'item2']);

      // Peek cache entry
      final entry = cache.peek<List<String>>('test:list');
      expect(entry, isNotNull);
      expect(entry!.isFresh, true);
      expect(entry.data, ['item1', 'item2']);
    });

    test('invalidateRelatedNamespacesForUrl invalidates exact namespace mapping table', () async {
      final cache = QueryCache();

      // Seed entries
      await cache.cachedFetch('invoices:all', () async => 'inv_data');
      await cache.cachedFetch('payments:all', () async => 'pay_data');
      await cache.cachedFetch('meters:all', () async => 'meter_data');
      await cache.cachedFetch('contracts:all', () async => 'contract_data');
      await cache.cachedFetch('settings:all', () async => 'settings_data');

      // Invalidate on invoices mutation: includes invoices, payments, meters, contracts, apartments, reports, deposits
      cache.invalidateRelatedNamespacesForUrl('/api/v1/invoices/inv_123/collect');

      expect(cache.peek('invoices:all'), isNull);
      expect(cache.peek('payments:all'), isNull);
      expect(cache.peek('meters:all'), isNull);
      expect(cache.peek('contracts:all'), isNull);
      // Settings must NOT be invalidated by /api/v1/invoices
      expect(cache.peek('settings:all'), isNotNull);

      // Invalidate receivables url
      await cache.cachedFetch('invoices:all', () async => 'inv_data2');
      await cache.cachedFetch('payments:all', () async => 'pay_data2');
      cache.invalidateRelatedNamespacesForUrl('/api/v1/receivables/summary');
      expect(cache.peek('invoices:all'), isNull);
      expect(cache.peek('payments:all'), isNull);
    });
  });

  group('5. Exact 17 Idempotent Financial Endpoints Constants', () {
    test('kIdempotentFinancialEndpoints contains exact 17 prefixes matching api.js and excludes receivables', () {
      expect(kIdempotentFinancialEndpoints.length, 17);

      const expected = [
        '/api/v1/invoices',
        '/api/v1/payments',
        '/api/v1/services',
        '/api/v1/service-catalog',
        '/api/v1/service-subscriptions',
        '/api/v1/contracts',
        '/api/v1/deposits',
        '/api/v1/resident',
        '/api/v1/meters',
        '/api/v1/reservations',
        '/api/v1/public/reservations',
        '/api/v1/service-requests',
        '/api/v1/announcements',
        '/api/v1/notifications',
        '/api/v1/zalo-groups',
        '/api/v1/ai',
        '/api/v1/settings',
      ];

      for (final ep in expected) {
        expect(kIdempotentFinancialEndpoints, contains(ep), reason: 'Missing endpoint: $ep');
      }

      // CRITICAL: /api/v1/receivables must NOT be in kIdempotentFinancialEndpoints
      expect(kIdempotentFinancialEndpoints.contains('/api/v1/receivables'), isFalse);
    });
  });

  group('6. IdempotencyInterceptor', () {
    test('generates Idempotency-Key UUID on mutating requests for 17 prefixes and never overwrites existing key', () async {
      final dio = Dio();
      dio.interceptors.add(IdempotencyInterceptor());
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        return ResponseBody.fromString(
          '{"ok":true}',
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      // 1. POST to financial endpoint without key -> key generated
      final r1 = await dio.post('/api/v1/invoices/create', data: {});
      final key1 = r1.requestOptions.headers['Idempotency-Key']?.toString();
      expect(key1, isNotNull);
      expect(key1!.length, greaterThanOrEqualTo(32));

      // 2. GET to financial endpoint -> NO key generated
      final r2 = await dio.get('/api/v1/invoices/list');
      expect(r2.requestOptions.headers['Idempotency-Key'], isNull);

      // 3. POST to non-financial endpoint (e.g. /api/v1/other) -> NO key generated
      final r3 = await dio.post('/api/v1/other/action', data: {});
      expect(r3.requestOptions.headers['Idempotency-Key'], isNull);

      // 4. POST with existing Idempotency-Key -> MUST PRESERVE existing key, never overwrite
      const existingKey = 'custom-user-idempotency-uuid-12345';
      final r4 = await dio.post(
        '/api/v1/payments/collect',
        data: {},
        options: Options(headers: {'Idempotency-Key': existingKey}),
      );
      expect(r4.requestOptions.headers['Idempotency-Key'], existingKey);
    });
  });

  group('7. Single-Flight 401 Refresh in AuthInterceptor', () {
    test('3 concurrent 401 responses trigger exactly 1 refresh call and replay all requests preserving Idempotency-Key', () async {
      SharedPreferences.setMockInitialValues({});
      final storage = AppStorage(isWeb: true);
      await storage.init();
      await storage.setTokens(accessToken: 'expired_access_token', refreshToken: 'valid_refresh_token');

      final sessionBridge = SessionLifecycleBridge();
      Map<String, dynamic>? refreshedUser;
      String? refreshedToken;
      sessionBridge.addTokenRefreshedListener((user, token) {
        refreshedUser = user;
        refreshedToken = token;
      });

      var refreshCallCount = 0;
      final refreshDio = Dio();
      refreshDio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/api/v1/auth/refresh')) {
          refreshCallCount++;
          // Simulate network latency for refresh
          await Future<void>.delayed(const Duration(milliseconds: 30));
          return ResponseBody.fromString(
            jsonEncode({
              'accessToken': 'fresh_access_token_777',
              'refreshToken': 'fresh_refresh_token_888',
              'user': {'id': 'u_refreshed_1', 'name': 'Refreshed User'},
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString('{}', 404);
      });

      final clientDio = Dio();
      final authInterceptor = AuthInterceptor(
        storage: storage,
        sessionBridge: sessionBridge,
        refreshDio: refreshDio,
        clientDio: clientDio,
      );

      var clientCallCount = 0;
      final replayedAuthHeaders = <String?>[];
      final replayedIdempotencyKeys = <String?>[];

      clientDio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        clientCallCount++;
        final authHeader = options.headers['Authorization']?.toString();
        // Return 401 if expired token is sent
        if (authHeader == 'Bearer expired_access_token') {
          return ResponseBody.fromString('{"message":"Unauthorized"}', 401);
        }
        // Success on fresh token
        if (authHeader == 'Bearer fresh_access_token_777') {
          replayedAuthHeaders.add(authHeader);
          replayedIdempotencyKeys.add(options.headers['Idempotency-Key']?.toString());
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'path': options.path}),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString('{"message":"Forbidden"}', 403);
      });

      clientDio.interceptors.addAll([
        authInterceptor,
        IdempotencyInterceptor(),
      ]);

      // Fire 3 concurrent mutating requests that encounter 401
      final req1 = clientDio.post(
        '/api/v1/invoices/pay',
        options: Options(headers: {'Idempotency-Key': 'idemp-key-1'}),
      );
      final req2 = clientDio.post(
        '/api/v1/payments/record',
        options: Options(headers: {'Idempotency-Key': 'idemp-key-2'}),
      );
      final req3 = clientDio.post(
        '/api/v1/contracts/sign',
        options: Options(headers: {'Idempotency-Key': 'idemp-key-3'}),
      );

      final responses = await Future.wait([req1, req2, req3]);

      // 1. Exactly 1 refresh call was made despite 3 concurrent 401s!
      expect(refreshCallCount, 1);
      // 3 initial 401s + 3 replayed calls
      expect(clientCallCount, 6);

      // 2. All 3 requests succeeded on replay
      expect(responses.length, 3);
      for (final r in responses) {
        expect(r.statusCode, 200);
      }

      // 3. Storage updated
      expect(storage.accessToken, 'fresh_access_token_777');
      expect(storage.refreshToken, 'fresh_refresh_token_888');
      expect(storage.user?['name'], 'Refreshed User');

      // 4. Session bridge notified
      expect(refreshedToken, 'fresh_access_token_777');
      expect(refreshedUser?['id'], 'u_refreshed_1');

      // 5. All replayed requests used the fresh token and PRESERVED their original Idempotency-Keys
      expect(replayedAuthHeaders, hasLength(3));
      for (final auth in replayedAuthHeaders) {
        expect(auth, 'Bearer fresh_access_token_777');
      }
      expect(replayedIdempotencyKeys, containsAll(['idemp-key-1', 'idemp-key-2', 'idemp-key-3']));
    });

    test('Refresh failure clears session and fires SessionLifecycleBridge.onSessionExpired without looping', () async {
      SharedPreferences.setMockInitialValues({});
      final storage = AppStorage(isWeb: true);
      await storage.init();
      await storage.setTokens(accessToken: 'bad_token', refreshToken: 'expired_refresh_token');

      final sessionBridge = SessionLifecycleBridge();
      var sessionExpiredFired = false;
      sessionBridge.addSessionExpiredListener(() {
        sessionExpiredFired = true;
      });

      final refreshDio = Dio();
      refreshDio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        return ResponseBody.fromString('{"message":"Invalid refresh token"}', 401);
      });

      final clientDio = Dio();
      final authInterceptor = AuthInterceptor(
        storage: storage,
        sessionBridge: sessionBridge,
        refreshDio: refreshDio,
        clientDio: clientDio,
      );

      clientDio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        return ResponseBody.fromString('{"message":"Unauthorized"}', 401);
      });

      clientDio.interceptors.add(authInterceptor);

      // Mutating request fails with 401, refresh fails with 401
      expect(
        () => clientDio.get('/api/v1/invoices'),
        throwsA(isA<DioException>()),
      );

      // Wait a moment for async handler to finish
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(sessionExpiredFired, true);
      expect(storage.accessToken, isNull);
      expect(storage.refreshToken, isNull);
    });

    test('Does not attempt refresh on /api/v1/auth/login or /api/v1/auth/refresh 401', () async {
      SharedPreferences.setMockInitialValues({});
      final storage = AppStorage(isWeb: true);
      await storage.init();
      await storage.setTokens(accessToken: 'some_token', refreshToken: 'some_refresh');

      var refreshCalled = false;
      final refreshDio = Dio();
      refreshDio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        refreshCalled = true;
        return ResponseBody.fromString('{}', 200);
      });

      final clientDio = Dio();
      final authInterceptor = AuthInterceptor(
        storage: storage,
        sessionBridge: SessionLifecycleBridge(),
        refreshDio: refreshDio,
        clientDio: clientDio,
      );

      clientDio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        return ResponseBody.fromString('{"message":"Invalid credentials"}', 401);
      });

      clientDio.interceptors.add(authInterceptor);

      // Login 401 should NOT call refresh
      try {
        await clientDio.post('/api/v1/auth/login', data: {'username': 'test'});
      } catch (_) {}

      expect(refreshCalled, false);
    });
  });

  group('8. Protected Attachment URL & JWT Leak Prevention', () {
    test('isProtectedApiAttachmentUrl correctly identifies internal API vs external URLs', () {
      // 1. Relative internal /api/ URLs -> protected
      expect(isProtectedApiAttachmentUrl('/api/v1/attachments/att_123/view'), isTrue);
      expect(isProtectedApiAttachmentUrl('/api/v1/attachments/att_456/download'), isTrue);

      // 2. Absolute URL matching configured apiBaseUrl -> protected
      expect(
        isProtectedApiAttachmentUrl(
          'http://localhost:5000/api/v1/attachments/att_123/view',
          apiBaseUrl: 'http://localhost:5000',
        ),
        isTrue,
      );

      // 3. VietQR external URL -> NEVER protected (MUST NOT SEND JWT)
      expect(
        isProtectedApiAttachmentUrl(
          'https://img.vietqr.io/image/970422-0123456789-compact2.png?amount=500000',
          apiBaseUrl: 'http://localhost:5000',
        ),
        isFalse,
      );

      // 4. Other external URLs -> NEVER protected
      expect(
        isProtectedApiAttachmentUrl(
          'https://malicious-site.com/api/v1/attachments/steal',
          apiBaseUrl: 'http://localhost:5000',
        ),
        isFalse,
      );

      // 5. Empty / data URI -> NEVER protected
      expect(isProtectedApiAttachmentUrl(''), isFalse);
      expect(isProtectedApiAttachmentUrl('data:image/png;base64,AAAA'), isFalse);
    });

    test('fetchAuthAttachmentBytes never sends Authorization Bearer to external VietQR URL', () async {
      String? sentAuthHeader;

      final authDio = Dio();
      authDio.options.headers['Authorization'] = 'Bearer sensitive_resident_jwt';

      final publicDio = Dio();
      publicDio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        sentAuthHeader = options.headers['Authorization']?.toString();
        return ResponseBody.fromString(
          'FAKE_IMAGE_BYTES',
          200,
          headers: {Headers.contentTypeHeader: ['image/png']},
        );
      });

      final bytes = await fetchAuthAttachmentBytes(
        authDio,
        'https://img.vietqr.io/image/970422-0123456789-compact2.png',
        apiBaseUrl: 'http://localhost:5000',
        publicDio: publicDio,
      );

      expect(bytes, isNotEmpty);
      // CRITICAL SECURITY ASSERTION: No JWT sent to VietQR!
      expect(sentAuthHeader, isNull);
    });
  });
}

/// Helper adapter to mock HTTP responses in Dio tests without a real backend
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
