import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/shared/widgets/common/service_subscription_meta_fields.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_input.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('ServiceSubscriptionMetaFields enforces maxLength 30/500', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: ServiceSubscriptionMetaFields(
            isParking: true,
            quantity: 1,
            vehiclePlates: ['59A1-123.45'],
          ),
        ),
      ),
    );

    final plateField = tester.widget<TextField>(
      find.descendant(
        of: find.byKey(const ValueKey('plate_0')),
        matching: find.byType(TextField),
      ),
    );
    expect(plateField.maxLength, 30);

    final noteField = tester.widget<TextField>(find.byType(TextField).last);
    expect(noteField.maxLength, 500);
  });

  testWidgets('AppInput forwards controller and maxLength', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppInput(controller: controller, maxLength: 7),
        ),
      ),
    );

    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.maxLength, 7);

    await tester.enterText(find.byType(TextField), 'abc');
    expect(controller.text, 'abc');
  });
}
