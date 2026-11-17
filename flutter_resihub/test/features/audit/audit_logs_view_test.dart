import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/features/audit/services/audit_service.dart';
import 'package:flutter_resihub/features/audit/widgets/audit_logs_view.dart';

/// Minimal Dio adapter trả response JSON tĩnh cho /api/v1/audit-logs.
class _AuditHttpClientAdapter implements HttpClientAdapter {
  final Map<String, dynamic> body;
  final List<RequestOptions> requests;

  _AuditHttpClientAdapter(this.body, this.requests);

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return ResponseBody.fromString(
      jsonEncode(body),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<RequestOptions> requests;

  setUp(() {
    requests = <RequestOptions>[];
  });

  Future<void> pumpView(
    WidgetTester tester, {
    String? lockedScope,
    required List<Map<String, dynamic>> logs,
    int total = 0,
    int totalPages = 1,
  }) async {
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
    dio.httpClientAdapter = _AuditHttpClientAdapter(
      {
        'data': logs,
        'pagination': {'total': total, 'totalPages': totalPages},
      },
      requests,
    );

    final container = ProviderContainer(
      overrides: [
        auditServiceProvider.overrideWithValue(
          AuditService(dio: dio, queryCache: QueryCache()),
        ),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: AuditLogsView(lockedScope: lockedScope),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('AuditLogsView có selector giới hạn 20/50/100 mỗi trang', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    // Pagination card (nơi đặt selector theo React) chỉ hiện khi total > limit.
    await pumpView(tester, logs: const [], total: 250, totalPages: 13);

    expect(find.text('20 / trang'), findsOneWidget,
        reason: 'phải có lựa chọn 20 / trang');

    await tester.tap(find.text('20 / trang'));
    await tester.pumpAndSettle();

    expect(find.text('50 / trang'), findsOneWidget,
        reason: 'phải có lựa chọn 50 / trang');
    expect(find.text('100 / trang'), findsOneWidget,
        reason: 'phải có lựa chọn 100 / trang');

    await tester.tap(find.text('50 / trang'));
    await tester.pumpAndSettle();

    expect(
      requests.any((r) => r.queryParameters['limit']?.toString() == '50'),
      isTrue,
      reason: 'đổi limit phải gọi lại API với limit=50',
    );
  });

  testWidgets('AuditLogsView hiện "Xóa bộ lọc" khi có scope', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await pumpView(tester, lockedScope: 'financial', logs: const []);

    // Không có search/entity/action/date, chỉ có scope -> nút reset vẫn phải hiện.
    expect(find.text('Xóa bộ lọc'), findsOneWidget,
        reason: 'scope là một bộ lọc, phải làm nút "Xóa bộ lọc" xuất hiện');
  });

  testWidgets('Modal chi tiết hiển thị User-Agent', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1400, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AuditTest/1.0';
    await pumpView(
      tester,
      logs: [
        {
          'action': 'UPDATE',
          'entity': 'invoice',
          'entity_id': 'inv-1',
          'actor_name': 'Admin',
          'created_at': '2026-11-17T08:00:00Z',
          'user_agent': ua,
        },
      ],
      total: 1,
    );

    await tester.tap(find.text('Xem JSON'));
    await tester.pumpAndSettle();

    expect(find.textContaining('User-Agent'), findsWidgets,
        reason: 'modal phải có nhãn User-Agent');
    expect(find.text(ua), findsOneWidget,
        reason: 'modal phải hiển thị giá trị user_agent của bản ghi');
  });
}
