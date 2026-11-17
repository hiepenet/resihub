import 'dart:async';
import 'package:dio/dio.dart';
import '../storage/app_storage.dart';
import '../utils/idempotency.dart';
import 'query_cache.dart';
import 'session_lifecycle_bridge.dart';

/// Exact 17 prefixes requiring Idempotency-Key on mutating requests,
/// identical to `frontend/src/services/api.js:14-32`.
/// Note: `/api/v1/receivables` is intentionally excluded.
const List<String> kIdempotentFinancialEndpoints = [
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

/// HTTP methods considered mutating.
const Set<String> kMutatingMethods = {'POST', 'PATCH', 'PUT', 'DELETE'};

/// Interceptor that attaches a UUID v4 `Idempotency-Key` to mutating financial requests
/// if one has not already been provided.
class IdempotencyInterceptor extends Interceptor {
  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    final method = options.method.toUpperCase();
    if (kMutatingMethods.contains(method)) {
      final url = options.path;
      final isTarget = kIdempotentFinancialEndpoints.any((ep) => url.contains(ep));
      final existingKey = options.headers['Idempotency-Key'];

      if (isTarget && (existingKey == null || existingKey.toString().trim().isEmpty)) {
        options.headers['Idempotency-Key'] = createIdempotencyKey();
      }
    }
    handler.next(options);
  }
}

/// Interceptor that triggers [QueryCache] invalidation for associated namespaces
/// when a mutating request succeeds.
class CacheInvalidationInterceptor extends Interceptor {
  final QueryCache queryCache;

  CacheInvalidationInterceptor(this.queryCache);

  @override
  void onResponse(Response response, ResponseInterceptorHandler handler) {
    final method = response.requestOptions.method.toUpperCase();
    final skip = response.requestOptions.extra['skipCacheInvalidation'] == true;

    if (kMutatingMethods.contains(method) && !skip) {
      queryCache.invalidateRelatedNamespacesForUrl(response.requestOptions.path);
    }
    handler.next(response);
  }
}

/// Interceptor handling Bearer token injection and single-flight 401 token refresh queue.
class AuthInterceptor extends Interceptor {
  final AppStorage storage;
  final SessionLifecycleBridge sessionBridge;
  final Dio refreshDio;
  final Dio clientDio;

  Completer<String?>? _refreshCompleter;

  AuthInterceptor({
    required this.storage,
    required this.sessionBridge,
    required this.refreshDio,
    required this.clientDio,
  });

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    final token = storage.accessToken;
    if (token != null && token.isNotEmpty) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    final statusCode = err.response?.statusCode;
    final requestOptions = err.requestOptions;
    final url = requestOptions.path;

    final isAuthEndpoint = url.contains('/api/v1/auth/login') ||
        url.contains('/api/v1/auth/otp/') ||
        url.contains('/api/v1/auth/refresh');
    final isRetried = requestOptions.extra['_retry'] == true;

    if (statusCode != 401 || isRetried || isAuthEndpoint) {
      return handler.next(err);
    }

    requestOptions.extra['_retry'] = true;

    final refreshToken = storage.refreshToken;
    if (refreshToken == null || refreshToken.isEmpty) {
      await storage.clearSession();
      sessionBridge.notifySessionExpired();
      return handler.next(err);
    }

    try {
      if (_refreshCompleter == null) {
        final completer = Completer<String?>();
        _refreshCompleter = completer;

        () async {
          try {
            final res = await refreshDio.post<dynamic>(
              '/api/v1/auth/refresh',
              data: {'refreshToken': refreshToken},
            );

            final data = res.data;
            final newAccessToken = data is Map ? data['accessToken']?.toString() : null;
            final newRefreshToken = data is Map ? data['refreshToken']?.toString() : null;
            final refreshedUser = data is Map && data['user'] is Map
                ? Map<String, dynamic>.from(data['user'] as Map)
                : null;

            if (newAccessToken != null && newAccessToken.isNotEmpty) {
              await storage.setTokens(
                accessToken: newAccessToken,
                refreshToken: newRefreshToken ?? refreshToken,
              );
              if (refreshedUser != null) {
                await storage.setUser(refreshedUser);
              }
              sessionBridge.notifyTokenRefreshed(refreshedUser, newAccessToken);
              completer.complete(newAccessToken);
            } else {
              throw Exception('Refresh response missing accessToken');
            }
          } catch (e, st) {
            await storage.clearSession();
            sessionBridge.notifySessionExpired();
            completer.completeError(e, st);
          } finally {
            _refreshCompleter = null;
          }
        }();
      }

      final newAccessToken = await _refreshCompleter!.future;
      if (newAccessToken != null && newAccessToken.isNotEmpty) {
        requestOptions.headers['Authorization'] = 'Bearer $newAccessToken';
        final response = await clientDio.fetch<dynamic>(requestOptions);
        return handler.resolve(response);
      } else {
        return handler.next(err);
      }
    } catch (_) {
      return handler.next(err);
    }
  }
}
