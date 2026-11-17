import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/features/meters/services/meters_service.dart';
import 'package:flutter_resihub/features/tenants/services/tenants_service.dart';

class _RecordingAdapter implements HttpClientAdapter {
  _RecordingAdapter(this.onFetch);

  final Future<ResponseBody> Function(RequestOptions options) onFetch;
  RequestOptions? lastRequest;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    lastRequest = options;
    return onFetch(options);
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Dio dio;
  late QueryCache queryCache;
  late TenantsService tenantsService;
  late MetersService metersService;
  late _RecordingAdapter adapter;

  ResponseBody okResponse() => ResponseBody.fromString(
        jsonEncode({'success': true, 'data': {'id': 'test-123'}}),
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );

  setUp(() {
    adapter = _RecordingAdapter((_) => Future.value(okResponse()));
    dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'))
      ..httpClientAdapter = adapter;
    queryCache = QueryCache();
    tenantsService = TenantsService(dio: dio, queryCache: queryCache);
    metersService = MetersService(dio: dio, queryCache: queryCache);
  });

  test('tenant cache TTL is 25s', () async {
    await tenantsService.list();

    final entry = queryCache.peek(buildCacheKey('tenants', {'op': 'list'}));
    expect(entry, isNotNull);
    expect(entry!.ttl, const Duration(seconds: 25));
  });

  test('meter cache TTL is 20s', () async {
    await metersService.list();

    final entry = queryCache.peek(buildCacheKey('meters', {'op': 'list'}));
    expect(entry, isNotNull);
    expect(entry!.ttl, const Duration(seconds: 20));
  });

  test('tenant list still hits canonical GET /api/v1/tenants path', () async {
    await tenantsService.list();

    expect(adapter.lastRequest!.method, 'GET');
    expect(adapter.lastRequest!.path, '/api/v1/tenants');
  });
}
