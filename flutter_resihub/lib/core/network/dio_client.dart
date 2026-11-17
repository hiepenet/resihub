import 'dart:typed_data';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/app_env.dart';
import '../storage/app_storage.dart';
import 'api_interceptors.dart';
import 'query_cache.dart';
import 'session_lifecycle_bridge.dart';

/// Determines whether an attachment URL is an internal protected API URL
/// that requires sending the Bearer JWT authorization header.
///
/// External domains (such as `https://img.vietqr.io/...`) and `data:` URIs
/// return `false` to prevent credential leakage.
bool isProtectedApiAttachmentUrl(String url, {String? apiBaseUrl}) {
  final clean = url.trim();
  if (clean.isEmpty || clean.startsWith('data:')) {
    return false;
  }

  // Relative internal API route
  if (clean.startsWith('/api/')) {
    return true;
  }

  // Absolute URL matching the configured API base URL
  final base = (apiBaseUrl ?? AppEnv.apiBaseUrl).trim().replaceAll(RegExp(r'/+$'), '');
  if (base.isNotEmpty && clean.startsWith('$base/api/')) {
    return true;
  }

  return false;
}

/// Fetches raw bytes for an attachment or image URL.
///
/// If [url] is a protected API endpoint, the request is executed through the authenticated [dio].
/// Otherwise, an unauthenticated request is sent (via [publicDio] or an isolated bare Dio)
/// without any credentials or authorization header.
Future<Uint8List> fetchAuthAttachmentBytes(
  Dio dio,
  String url, {
  String? apiBaseUrl,
  Dio? publicDio,
}) async {
  if (isProtectedApiAttachmentUrl(url, apiBaseUrl: apiBaseUrl)) {
    final response = await dio.get<List<int>>(
      url,
      options: Options(responseType: ResponseType.bytes),
    );
    final data = response.data;
    return Uint8List.fromList(data ?? <int>[]);
  } else {
    final unauthDio = publicDio ??
        Dio(
          BaseOptions(
            connectTimeout: const Duration(seconds: 30),
            receiveTimeout: const Duration(seconds: 30),
          ),
        );
    final response = await unauthDio.get<List<int>>(
      url,
      options: Options(
        responseType: ResponseType.bytes,
        headers: {}, // Ensure no leaked auth header
      ),
    );
    final data = response.data;
    return Uint8List.fromList(data ?? <int>[]);
  }
}

/// Provider for unauthenticated public requests (e.g. public reservations, health check).
/// Includes [IdempotencyInterceptor] and [CacheInvalidationInterceptor].
final publicDioProvider = Provider<Dio>((ref) {
  final queryCache = ref.watch(queryCacheProvider);

  final dio = Dio(
    BaseOptions(
      baseUrl: AppEnv.apiBaseUrl,
      connectTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(seconds: 30),
      headers: {'Content-Type': 'application/json'},
    ),
  );

  dio.interceptors.addAll([
    IdempotencyInterceptor(),
    CacheInvalidationInterceptor(queryCache),
  ]);

  return dio;
});

/// Provider for authenticated API requests.
/// Includes [AuthInterceptor] with single-flight token refresh,
/// [IdempotencyInterceptor] (17 endpoints), and [CacheInvalidationInterceptor].
final dioProvider = Provider<Dio>((ref) {
  final storage = ref.watch(appStorageProvider);
  final sessionBridge = ref.watch(sessionLifecycleBridgeProvider);
  final queryCache = ref.watch(queryCacheProvider);

  final clientDio = Dio(
    BaseOptions(
      baseUrl: AppEnv.apiBaseUrl,
      connectTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(seconds: 30),
      headers: {'Content-Type': 'application/json'},
    ),
  );

  // Bare Dio instance dedicated to refresh requests without AuthInterceptor to prevent deadlock
  final refreshDio = Dio(
    BaseOptions(
      baseUrl: AppEnv.apiBaseUrl,
      connectTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(seconds: 30),
      headers: {'Content-Type': 'application/json'},
    ),
  );

  clientDio.interceptors.addAll([
    AuthInterceptor(
      storage: storage,
      sessionBridge: sessionBridge,
      refreshDio: refreshDio,
      clientDio: clientDio,
    ),
    IdempotencyInterceptor(),
    CacheInvalidationInterceptor(queryCache),
  ]);

  return clientDio;
});
