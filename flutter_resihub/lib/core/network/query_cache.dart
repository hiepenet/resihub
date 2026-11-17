import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../storage/app_storage.dart';

const Duration kDefaultQueryTtl = Duration(seconds: 20);
const Duration kDefaultMaxStale = Duration(seconds: 300);

/// Cache entry representing cached data with freshness and stale lifetimes.
class CacheEntry<T> {
  final String logicalKey;
  final T data;
  final DateTime updatedAt;
  final Duration ttl;
  final Duration maxStale;

  CacheEntry({
    required this.logicalKey,
    required this.data,
    required this.updatedAt,
    this.ttl = kDefaultQueryTtl,
    this.maxStale = kDefaultMaxStale,
  });

  bool get isFresh => DateTime.now().difference(updatedAt) <= ttl;
  bool get isStaleExpired => DateTime.now().difference(updatedAt) > maxStale;
}

/// Rule for mapping URL patterns to invalidated query namespaces.
class UrlInvalidationRule {
  final String match;
  final List<String> namespaces;

  const UrlInvalidationRule({
    required this.match,
    required this.namespaces,
  });
}

/// Exact invalidation rules matching `frontend/src/services/queryCache.js:160-182`.
const List<UrlInvalidationRule> kUrlInvalidationRules = [
  UrlInvalidationRule(
    match: '/api/v1/tenants',
    namespaces: ['tenants', 'contracts', 'reports', 'users'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/contracts',
    namespaces: ['contracts', 'apartments', 'buildings', 'tenants', 'deposits', 'meters', 'invoices', 'reports'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/buildings',
    namespaces: ['buildings', 'apartments', 'meters', 'reports'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/apartments',
    namespaces: ['apartments', 'buildings', 'contracts', 'meters', 'reports'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/reservations',
    namespaces: ['reservations', 'apartments', 'buildings', 'reports'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/service-catalog',
    namespaces: ['services', 'contracts', 'meters'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/service-subscriptions',
    namespaces: ['services', 'contracts', 'invoices'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/settings',
    namespaces: ['settings', 'reservations', 'meters'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/deposits',
    namespaces: ['deposits', 'contracts', 'apartments', 'reports'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/invoices',
    namespaces: ['invoices', 'payments', 'meters', 'contracts', 'apartments', 'reports', 'deposits'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/payments',
    namespaces: ['payments', 'invoices', 'contracts', 'apartments', 'reports', 'deposits'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/receivables',
    namespaces: ['payments', 'invoices', 'reports'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/meters',
    namespaces: ['meters', 'invoices', 'apartments', 'contracts', 'reports'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/service-requests',
    namespaces: ['serviceRequests', 'reports'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/notifications',
    namespaces: ['notifications'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/announcements',
    namespaces: ['notifications'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/zalo-groups',
    namespaces: ['notifications'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/admin/users',
    namespaces: ['users', 'tenants'],
  ),
  UrlInvalidationRule(
    match: '/api/v1/resident',
    namespaces: ['resident', 'contracts', 'invoices', 'services', 'serviceRequests', 'deposits'],
  ),
];

/// Stable deterministic serializer for cache key parameters.
String stableSerialize(dynamic value) {
  if (value == null || value == '') return '';
  if (value is! Map && value is! Iterable) return value.toString();
  if (value is Iterable) {
    return '[${value.map(stableSerialize).join(',')}]';
  }
  if (value is Map) {
    final keys = value.keys
        .map((k) => k.toString())
        .where((k) => value[k] != null && value[k] != '')
        .toList()
      ..sort();
    if (keys.isEmpty) return '{}';
    return '{${keys.map((k) => '$k:${stableSerialize(value[k])}').join(',')}}';
  }
  return value.toString();
}

/// Builds a logical cache key with namespace and serialized arguments.
String buildCacheKey(String? namespace, [dynamic parts]) {
  final ns = namespace ?? 'default';
  if (parts == null || parts == '') return '$ns:all';
  final serialized = stableSerialize(parts);
  return '$ns:${serialized.isNotEmpty ? serialized : 'all'}';
}

/// In-memory query cache with scope isolation, inflight deduplication, TTL,
/// and URL-based namespace invalidation. Port of `frontend/src/services/queryCache.js`.
class QueryCache {
  final AppStorage? storage;
  String Function()? customScopeResolver;

  final Map<String, CacheEntry<dynamic>> _dataStore = {};
  final Map<String, Future<dynamic>> _inflightStore = {};

  QueryCache({this.storage, this.customScopeResolver});

  /// Resolves the current scope string from custom resolver or AppStorage.
  String resolveScope() {
    if (customScopeResolver != null) {
      try {
        final custom = customScopeResolver!();
        if (custom.isNotEmpty) return custom;
      } catch (_) {}
    }

    if (storage != null) {
      final uid = storage?.userId;
      if (uid != null && uid.isNotEmpty) {
        final role = storage?.userRole ?? '';
        final bId = storage?.selectedBuildingId ?? '';
        if (role.isNotEmpty || bId.isNotEmpty) {
          return 'u:$uid:r:$role:b:$bId';
        }
        return 'u:$uid';
      }

      final token = storage?.accessToken;
      if (token != null && token.isNotEmpty) {
        final suffix = token.length >= 24 ? token.substring(token.length - 24) : token;
        return 't:$suffix';
      }
    }

    return 'anon';
  }

  /// Appends resolved scope prefix to logical key.
  String toScopedKey(String logicalKey) => '${resolveScope()}::$logicalKey';

  /// Synchronously inspects the cache without triggering fetch.
  CacheEntry<T>? peek<T>(String logicalKey, {Duration? maxStale}) {
    final sKey = toScopedKey(logicalKey);
    final entry = _dataStore[sKey];
    if (entry == null) return null;

    final now = DateTime.now();
    final effectiveMaxStale = maxStale ?? entry.maxStale;
    if (now.difference(entry.updatedAt) > effectiveMaxStale) {
      _dataStore.remove(sKey);
      return null;
    }

    return CacheEntry<T>(
      logicalKey: entry.logicalKey,
      data: entry.data as T,
      updatedAt: entry.updatedAt,
      ttl: entry.ttl,
      maxStale: entry.maxStale,
    );
  }

  /// Executes [fetcher] with caching, TTL checking, and in-flight deduplication.
  Future<T> cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration? ttl,
    Duration? maxStale,
    bool force = false,
  }) {
    final effectiveTtl = ttl ?? kDefaultQueryTtl;
    final effectiveMaxStale = maxStale ?? kDefaultMaxStale;
    final sKey = toScopedKey(logicalKey);

    if (!force) {
      final existing = _dataStore[sKey];
      if (existing != null && DateTime.now().difference(existing.updatedAt) <= effectiveTtl) {
        return Future<T>.value(existing.data as T);
      }

      final pending = _inflightStore[sKey];
      if (pending != null) {
        return pending.then((value) => value as T);
      }
    }

    late final Future<T> future;
    future = fetcher().then((result) {
      if (identical(_inflightStore[sKey], future)) {
        _dataStore[sKey] = CacheEntry<dynamic>(
          logicalKey: logicalKey,
          data: result,
          updatedAt: DateTime.now(),
          ttl: effectiveTtl,
          maxStale: effectiveMaxStale,
        );
      }
      return result;
    }).whenComplete(() {
      if (identical(_inflightStore[sKey], future)) {
        _inflightStore.remove(sKey);
      }
    });

    _inflightStore[sKey] = future;
    return future;
  }

  /// Invalidates entries matching [prefixes]. If prefixes is null, clears everything.
  void invalidate(dynamic prefixes) {
    if (prefixes == null) {
      clear();
      return;
    }

    final List<String> list;
    if (prefixes is Iterable) {
      list = prefixes.map((p) => p.toString().trim()).where((p) => p.isNotEmpty).toList();
    } else {
      final str = prefixes.toString().trim();
      list = str.isNotEmpty ? [str] : [];
    }
    if (list.isEmpty) return;

    bool matchesPrefix(String logicalKey) {
      return list.any((prefix) =>
          logicalKey == prefix ||
          logicalKey.startsWith('$prefix:') ||
          logicalKey.startsWith(prefix));
    }

    _dataStore.removeWhere((sKey, entry) => matchesPrefix(entry.logicalKey));

    final inflightKeysToRemove = <String>[];
    for (final sKey in _inflightStore.keys) {
      final sepIdx = sKey.indexOf('::');
      final logicalKey = sepIdx >= 0 ? sKey.substring(sepIdx + 2) : sKey;
      if (matchesPrefix(logicalKey)) {
        inflightKeysToRemove.add(sKey);
      }
    }
    for (final k in inflightKeysToRemove) {
      _inflightStore.remove(k);
    }
  }

  /// Invalidates query cache namespaces associated with the mutated API [url].
  void invalidateRelatedNamespacesForUrl(String? url) {
    final cleanUrl = url ?? '';
    if (cleanUrl.isEmpty) return;

    final matched = <String>{};
    for (final rule in kUrlInvalidationRules) {
      if (cleanUrl.contains(rule.match)) {
        matched.addAll(rule.namespaces);
      }
    }

    if (matched.isNotEmpty) {
      invalidate(matched.toList());
    }
  }

  /// Clears all cached and in-flight entries.
  void clear() {
    _dataStore.clear();
    _inflightStore.clear();
  }
}

/// Riverpod provider for QueryCache.
final queryCacheProvider = Provider<QueryCache>((ref) {
  final storage = ref.watch(appStorageProvider);
  return QueryCache(storage: storage);
});
