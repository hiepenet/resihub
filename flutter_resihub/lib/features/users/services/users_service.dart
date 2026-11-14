import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';
import '../../../core/utils/idempotency.dart';

const Duration kUsersTtl = Duration(milliseconds: 25000);
const Duration kSettingsTtl = Duration(milliseconds: 120000);

/// Users & System Settings Service.
/// 1:1 port of `frontend/src/services/users.service.js` (10 methods + peek helpers).
class UsersService {
  final Dio dio;
  final QueryCache? queryCache;

  UsersService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kUsersTtl,
    bool force = false,
  }) {
    if (queryCache != null) {
      return queryCache!.cachedFetch<T>(logicalKey, fetcher, ttl: ttl, force: force);
    }
    return fetcher();
  }

  // ---------------------------------------------------------------------------
  // Users Management
  // ---------------------------------------------------------------------------

  /// Read cached user list without triggering network request.
  dynamic peekList([Map<String, dynamic>? params]) {
    final keyParams = {'op': 'list', if (params != null) ...params};
    return queryCache?.peek<dynamic>(buildCacheKey('users', keyParams))?.data;
  }

  /// 1. List admin users with optional filters (role, status, search).
  /// GET /api/v1/admin/users
  Future<dynamic> list([Map<String, dynamic>? params, bool force = false]) {
    final keyParams = {'op': 'list', if (params != null) ...params};
    return _cachedFetch(
      buildCacheKey('users', keyParams),
      () => dio
          .get<dynamic>(
            '/api/v1/admin/users',
            queryParameters: params,
          )
          .then((r) => r.data),
      ttl: kUsersTtl,
      force: force,
    );
  }

  /// Read cached roles without triggering network request.
  dynamic peekRoles() {
    return queryCache?.peek<dynamic>(buildCacheKey('users', 'roles'))?.data;
  }

  /// 2. List system roles with permissions.
  /// GET /api/v1/admin/users/roles
  Future<dynamic> listRoles({bool force = false}) {
    return _cachedFetch(
      buildCacheKey('users', 'roles'),
      () => dio.get<dynamic>('/api/v1/admin/users/roles').then((r) => r.data),
      ttl: kSettingsTtl,
      force: force,
    );
  }

  /// 3. Create a new user with role assignments.
  /// POST /api/v1/admin/users
  Future<dynamic> create(Map<String, dynamic> payload) {
    return dio.post<dynamic>('/api/v1/admin/users', data: payload).then((r) => r.data);
  }

  /// 4. Update an existing user and their role assignments.
  /// PATCH /api/v1/admin/users/:id
  Future<dynamic> update(String id, Map<String, dynamic> payload) {
    return dio.patch<dynamic>('/api/v1/admin/users/$id', data: payload).then((r) => r.data);
  }

  /// 5. Delete an unreferenced user.
  /// DELETE /api/v1/admin/users/:id
  Future<dynamic> remove(String id) {
    return dio.delete<dynamic>('/api/v1/admin/users/$id').then((r) => r.data);
  }

  // ---------------------------------------------------------------------------
  // System Settings
  // ---------------------------------------------------------------------------

  /// Read cached system settings without triggering network request.
  dynamic peekSettings() {
    return queryCache?.peek<dynamic>(buildCacheKey('settings', 'global'))?.data;
  }

  /// 6. Retrieve global system settings.
  /// GET /api/v1/settings
  Future<dynamic> getSettings({bool force = false}) {
    return _cachedFetch(
      buildCacheKey('settings', 'global'),
      () => dio.get<dynamic>('/api/v1/settings').then((r) => r.data),
      ttl: kSettingsTtl,
      force: force,
    );
  }

  /// 7. Update global system settings.
  /// PUT /api/v1/settings with payload `{ settings, ...settings }`
  /// Critical payload format matching `frontend/src/services/users.service.js:37`!
  Future<dynamic> updateSettings(Map<String, dynamic> settings) {
    final payload = <String, dynamic>{
      'settings': settings,
      ...settings,
    };
    return dio.put<dynamic>('/api/v1/settings', data: payload).then((r) => r.data);
  }

  /// 8. Reset a specific configuration group back to its default value.
  /// DELETE /api/v1/settings/:key
  Future<dynamic> resetSetting(String key) {
    final encodedKey = Uri.encodeComponent(key);
    return dio.delete<dynamic>('/api/v1/settings/$encodedKey').then((r) => r.data);
  }

  // ---------------------------------------------------------------------------
  // Cron Jobs Monitoring & Triggering (FR-066 / PRD 14.5)
  // ---------------------------------------------------------------------------

  /// 9. List automated daily cron job execution history.
  /// GET /api/v1/settings/cron-runs
  Future<dynamic> listCronRuns([Map<String, dynamic>? params]) {
    return dio
        .get<dynamic>(
          '/api/v1/settings/cron-runs',
          queryParameters: params,
        )
        .then((r) => r.data);
  }

  /// 10. Manually trigger the daily automated cron job with idempotency support.
  /// POST /api/v1/settings/cron-runs/trigger
  Future<dynamic> triggerCronRun(
    Map<String, dynamic>? payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '/api/v1/settings/cron-runs/trigger',
          data: payload ?? <String, dynamic>{},
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }
}

/// Riverpod provider for [UsersService].
final usersServiceProvider = Provider<UsersService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return UsersService(dio: dio, queryCache: queryCache);
});
