import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/resident/screens/resident_portal_page.dart';
import 'package:flutter_resihub/features/resident/services/resident_service.dart';

/// Counts listInvoices calls without changing what the service returns.
class _CountingResidentService extends Fake implements ResidentService {
  int listInvoicesCalls = 0;

  @override
  @override
  Future<dynamic> listInvoices([String? contractId, Options? options]) async {
    listInvoicesCalls++;
    return {'data': <dynamic>[]};
  }

  @override
  Future<dynamic> getOverview([String? contractId, Options? options]) async {
    return {
      'data': {
        'active_contract': {
          'contract_id': 'c-1',
          'apartment_code': 'A101',
          'status': 'ACTIVE',
        },
      },
    };
  }

  @override
  Future<dynamic> listServiceRequests([String? contractId, Options? options]) async {
    return {'data': <dynamic>[]};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
      'revisiting the invoices tab does not call listInvoices again within the session',
      (tester) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() => tester.view.resetPhysicalSize());
    SharedPreferences.setMockInitialValues({});

    final storage = AppStorage(isWeb: true);
    await storage.init();
    final counting = _CountingResidentService();

    // overview data returned directly; the tab under test uses the counting
    // service for its own fetch.
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost'));

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          dioProvider.overrideWithValue(dio),
          residentServiceProvider.overrideWithValue(counting),
        ],
        child: const MaterialApp(home: ResidentPortalPage()),
      ),
    );
    await tester.pumpAndSettle();

    final beforeVisit = counting.listInvoicesCalls;

    // Navigate to invoices via the bottom/side tab, then back, then again.
    final invoicesTab = find.text('Hóa đơn & TT');
    expect(invoicesTab, findsWidgets);
    await tester.tap(invoicesTab.first);
    await tester.pumpAndSettle();
    final afterFirst = counting.listInvoicesCalls;

    await tester.tap(find.text('Tổng quan').first);
    await tester.pumpAndSettle();
    await tester.tap(invoicesTab.first);
    await tester.pumpAndSettle();

    // The tab widget is kept alive in the IndexedStack; a second visit must
    // not re-enter initState and fetch again.
    expect(counting.listInvoicesCalls, afterFirst,
        reason: 'listInvoices called again when revisiting the invoices tab');
  });
}
