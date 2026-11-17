import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/resident/screens/resident_portal_page.dart';
import 'package:flutter_resihub/features/resident/services/resident_service.dart';

/// Returns an overview with two contracts and records which contract each
/// invoices fetch used, so the test can detect a frozen tab receiving stale
/// props after a contract switch.
class _ContractSwitchService extends Fake implements ResidentService {
  String? activeContractId = 'c-101';
  final List<String?> invoicesContractIds = <String?>[];
  bool _firstOverview = true;

  @override
  Future<dynamic> getOverview([String? contractId, Options? options]) async {
    // First call without explicit id -> default c-101. Later call after switch
    // receives the selected id.
    final effective = contractId ?? activeContractId;
    activeContractId = effective;
    _firstOverview = false;
    return {
      'data': {
        'active_contracts': [
          {
            'contract_id': 'c-101',
            'apartment_code': 'A.101',
            'building_name': 'Tòa Ruby'
          },
          {
            'contract_id': 'c-202',
            'apartment_code': 'B.202',
            'building_name': 'Tòa Diamond'
          },
        ],
        'active_contract': {
          'contract_id': effective,
          'apartment_code': effective == 'c-202' ? 'B.202' : 'A.101',
          'status': 'ACTIVE',
        },
      },
    };
  }

  @override
  Future<dynamic> listServiceRequests([String? contractId, Options? options]) async =>
      {'data': <dynamic>[]};

  @override
  Future<dynamic> listInvoices([String? contractId, Options? options]) async {
    invoicesContractIds.add(contractId ?? activeContractId);
    return {'data': <dynamic>[]};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
      'switching contract refetches the already-visited invoices tab for the new contract',
      (tester) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() => tester.view.resetPhysicalSize());
    SharedPreferences.setMockInitialValues({});

    final storage = AppStorage(isWeb: true);
    await storage.init();
    final service = _ContractSwitchService();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          dioProvider.overrideWithValue(Dio(BaseOptions(baseUrl: 'http://localhost'))),
          residentServiceProvider.overrideWithValue(service),
        ],
        child: const MaterialApp(home: ResidentPortalPage()),
      ),
    );
    await tester.pumpAndSettle();

    // Visit invoices once on the initial contract.
    await tester.tap(find.text('Hóa đơn & TT').first);
    await tester.pumpAndSettle();
    expect(service.invoicesContractIds, contains('c-101'));

    // Switch apartment through the shell contract switcher.
    final switcher = find.byKey(const Key('resident-contract-switcher'));
    expect(switcher, findsOneWidget);
    await tester.tap(switcher.first);
    await tester.pumpAndSettle();
    final optionB202 = find.textContaining('B.202');
    expect(optionB202, findsWidgets);
    await tester.tap(optionB202.last);
    await tester.pumpAndSettle();

    // The visited invoices tab must receive the new overview and refetch for
    // c-202; with a frozen cached widget instance this stays c-101.
    expect(service.invoicesContractIds, contains('c-202'),
        reason: 'invoices tab kept stale contract after switching apartment');
  });
}
