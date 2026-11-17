import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/features/resident/services/resident_service.dart';
import 'package:flutter_resihub/features/resident/tabs/invoices_tab.dart';

/// Counts listInvoices calls without changing what the service returns.
class _CountingResidentService extends Fake implements ResidentService {
  int listInvoicesCalls = 0;

  @override
  Future<dynamic> listInvoices([String? contractId, Options? options]) async {
    listInvoicesCalls++;
    return {'data': <dynamic>[]};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
      'remounting the invoices tab within the cache TTL reuses cached data',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final counting = _CountingResidentService();
    final cache = QueryCache();
    final dio = Dio();

    List<Override> overrides() => [
          dioProvider.overrideWithValue(dio),
          queryCacheProvider.overrideWithValue(cache),
          residentServiceProvider.overrideWithValue(counting),
        ];

    Widget buildTab() => ProviderScope(
          overrides: overrides(),
          child: MaterialApp(
            home: Scaffold(
              body: InvoicesTab(
                overview: const {
                  'active_contract': {'contract_id': 'c-1'},
                },
                onRefreshOverview: () async {},
                onNavigateTab: (_, [__]) {},
              ),
            ),
          ),
        );

    // First mount: one network fetch, cached for the TTL window.
    await tester.pumpWidget(buildTab());
    await tester.pumpAndSettle();
    expect(counting.listInvoicesCalls, 1);

    // Unmount the whole tree (app-level rebuild / tab genuinely recreated).
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();

    // Remount within the 20s TTL: initState runs again but must reuse cache.
    await tester.pumpWidget(buildTab());
    await tester.pumpAndSettle();

    expect(counting.listInvoicesCalls, 1,
        reason: 'listInvoices re-fetched on remount instead of reusing cache');
  });

  testWidgets('pull-to-refresh bypasses the cache', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final counting = _CountingResidentService();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(Dio()),
          queryCacheProvider.overrideWithValue(QueryCache()),
          residentServiceProvider.overrideWithValue(counting),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: InvoicesTab(
              overview: const {
                'active_contract': {'contract_id': 'c-1'},
              },
              onRefreshOverview: () async {},
              onNavigateTab: (_, [__]) {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(counting.listInvoicesCalls, 1);

    await tester.drag(find.byType(RefreshIndicator), const Offset(0, 300));
    await tester.pumpAndSettle();

    expect(counting.listInvoicesCalls, 2,
        reason: 'pull-to-refresh must force a network refetch');
  });
}
