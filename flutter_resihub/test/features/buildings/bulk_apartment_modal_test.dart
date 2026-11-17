import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/buildings/widgets/bulk_apartment_modal.dart';

const _bedroomsKeyPrefix = 'bulk-bedrooms-';
const _unitsPerFloorKey = Key('bulk-units-per-floor');

class _RecordingBuildingsService extends Fake implements BuildingsService {
  Map<String, dynamic>? lastPreviewPayload;

  @override
  Future<dynamic> previewApartmentsBulk(Map<String, dynamic> payload) async {
    lastPreviewPayload = payload;
    return {'valid': true, 'total': 5, 'conflicts': []};
  }
}

Future<void> _pumpModal(WidgetTester tester, _RecordingBuildingsService service) async {
  tester.view.physicalSize = const Size(1200, 1800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [buildingsServiceProvider.overrideWithValue(service)],
      child: const MaterialApp(
        home: Scaffold(
          body: BulkApartmentModal(
            open: true,
            buildingId: 'b-1',
            floors: [
              {'id': 'f-1', 'name': 'Tầng 1'},
            ],
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('bedrooms payload defaults to 1 and is editable', (tester) async {
    final service = _RecordingBuildingsService();
    await _pumpModal(tester, service);

    final bedrooms = find.byKey(const Key('${_bedroomsKeyPrefix}0'));
    expect(bedrooms, findsOneWidget);
    expect(tester.widget<TextFormField>(bedrooms).initialValue, '1');

    await tester.enterText(bedrooms, '3');
    await tester.tap(find.text('Xem trước'));
    await tester.pumpAndSettle();

    final units = service.lastPreviewPayload!['units'] as List<dynamic>;
    expect(units.first['bedrooms'], 3);
  });

  testWidgets('units per floor clamps 1..50', (tester) async {
    final service = _RecordingBuildingsService();
    await _pumpModal(tester, service);

    expect(find.byKey(_unitsPerFloorKey), findsOneWidget);

    await tester.enterText(find.byKey(_unitsPerFloorKey), '999');
    await tester.pumpAndSettle();
    expect(find.text('2. Danh sách mẫu căn hộ (50 căn/tầng)'), findsOneWidget);

    await tester.enterText(find.byKey(_unitsPerFloorKey), '0');
    await tester.pumpAndSettle();
    expect(find.text('2. Danh sách mẫu căn hộ (1 căn/tầng)'), findsOneWidget);
  });
}
