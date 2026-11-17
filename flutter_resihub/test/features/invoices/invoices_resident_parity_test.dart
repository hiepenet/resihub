import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/theme/app_colors.dart';
import 'package:flutter_resihub/features/resident/services/resident_service.dart';
import 'package:flutter_resihub/features/resident/tabs/invoices_tab.dart';
import 'package:flutter_resihub/shared/widgets/ui/file_upload_field.dart';

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

const _invoice = {
  'invoice_id': 'inv-parity-1',
  'invoice_code': 'HD-PARITY-001',
  'period': '2026-11',
  'status': 'OVERDUE',
  'total_amount': 2500000,
  'paid_amount': 0,
  'lines': [],
};

Future<void> _pumpInvoicesTab(WidgetTester tester,
    {List<dynamic> invoices = const [_invoice]}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  final storage = AppStorage(prefs: prefs, isWeb: true);

  final dio = Dio();
  dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
    if (options.path.contains('/resident/invoices')) {
      return ResponseBody.fromString(
        jsonEncode({'success': true, 'data': invoices}),
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType]
        },
      );
    }
    return ResponseBody.fromString(
        jsonEncode({'success': true, 'data': []}), 200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType]
        });
  });

  await tester.binding.setSurfaceSize(const Size(1200, 1000));
  addTearDown(() => tester.binding.setSurfaceSize(null));

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(dio),
        appStorageProvider.overrideWithValue(storage),
        residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: InvoicesTab(
            overview: const {
              'active_contract': {'contract_id': 'c-1'},
            },
            onRefreshOverview: () async {},
            onNavigateTab: (tab, [extra]) {},
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('InvoicesTab React parity', () {
    testWidgets('filter labels match React verbatim', (tester) async {
      await _pumpInvoicesTab(tester);

      expect(find.text('Tất cả hóa đơn'), findsOneWidget);
      expect(find.text('Chờ thanh toán'), findsOneWidget);
      expect(find.text('Đã hoàn tất'), findsOneWidget);
    });

    testWidgets('summary has top Báo đã thanh toán CTA and rich report modal',
        (tester) async {
      await _pumpInvoicesTab(tester);

      // Top CTA in summary + per-invoice button => at least two.
      final ctas = find.text('Báo đã thanh toán');
      expect(ctas, findsWidgets);
      expect(tester.widgetList<Text>(ctas).length, greaterThanOrEqualTo(2));

      await tester.tap(ctas.first);
      await tester.pumpAndSettle();

      expect(find.text('Báo đã thanh toán hóa đơn'), findsOneWidget);

      // React verbatim field labels.
      expect(find.textContaining('Chọn hóa đơn thanh toán'), findsWidgets);
      expect(find.textContaining('Số tiền đã chuyển'), findsOneWidget);
      expect(find.textContaining('Phương thức'), findsWidgets);
      expect(find.textContaining('Mã tham chiếu'), findsOneWidget);
      expect(find.textContaining('Ngày thực hiện giao dịch'), findsOneWidget);
      expect(find.textContaining('Ảnh chụp biên lai'), findsOneWidget);
      expect(find.textContaining('Ghi chú gửi kế toán'), findsOneWidget);

      // Brief shorthand strings (rendered as helper hints).
      expect(find.textContaining('Mã hóa đơn'), findsWidgets);
      expect(find.textContaining('Ngày thanh toán'), findsOneWidget);
      expect(find.textContaining('Ảnh chứng từ'), findsOneWidget);

      // Up to 3 proof images.
      final upload =
          tester.widget<FileUploadField>(find.byType(FileUploadField));
      expect(upload.multiple, isTrue);
      expect(upload.maxFiles, 3);

      // React footer actions.
      expect(find.text('Hủy'), findsOneWidget);
      expect(find.text('Gửi đối soát thanh toán'), findsOneWidget);
    });

    testWidgets('OVERDUE invoice card has rose border and rose box shadow',
        (tester) async {
      await _pumpInvoicesTab(tester);

      final roseCards = find.byWidgetPredicate((widget) {
        if (widget is! Container) return false;
        final decoration = widget.decoration;
        if (decoration is! BoxDecoration) return false;
        final border = decoration.border;
        if (border is! Border) return false;
        final borderRose = border.top.color == AppColors.rose300;
        final shadowRose = decoration.boxShadow
                ?.any((shadow) => shadow.color == AppColors.rose200) ??
            false;
        return borderRose && shadowRose;
      });

      expect(roseCards, findsWidgets);
    });
  });
}
