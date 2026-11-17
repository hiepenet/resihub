import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/core/utils/resident_overview_helpers.dart';

void main() {
  group('Resident Overview Helpers (resident_overview_helpers.dart)', () {
    test('parseResidentAmenities maps wifi key and JSON string', () {
      expect(parseResidentAmenities(['wifi', 'balcony']),
          ['Wi-Fi tốc độ cao', 'Ban công thoáng']);
      expect(parseResidentAmenities('["wifi","gym"]'),
          ['Wi-Fi tốc độ cao', 'Phòng Gym']);
    });

    test('parseResidentAmenities handles comma string and map', () {
      expect(parseResidentAmenities('wifi, gym'),
          ['Wi-Fi tốc độ cao', 'Phòng Gym']);
      expect(parseResidentAmenities({'wifi': true, 'gym': false}),
          ['Wi-Fi tốc độ cao']);
    });

    test('parseResidentAmenities is null-safe and handles object entries', () {
      expect(parseResidentAmenities(null), isEmpty);
      expect(parseResidentAmenities(42), isEmpty);
      expect(parseResidentAmenities([null, '', false]), isEmpty);
      expect(
          parseResidentAmenities([
            {'code': 'wifi'},
            {'label': 'Wi-Fi riêng'}
          ]),
          ['Wi-Fi tốc độ cao', 'Wi-Fi riêng']);
      expect(
          parseResidentAmenities({'custom_feature': true}), ['Custom Feature']);
      expect(parseResidentAmenities({'note': 'GiườngKing'}), ['GiườngKing']);
    });

    test('kResidentAmenityLabels has the 23 wifi..gym labels', () {
      expect(kResidentAmenityLabels.length, equals(23));
      expect(kResidentAmenityLabels['wifi'], equals('Wi-Fi tốc độ cao'));
      expect(kResidentAmenityLabels['gym'], equals('Phòng Gym'));
      expect(kResidentAmenityLabels['security_24_7'], equals('An ninh 24/7'));
    });

    test('days remaining is null for null/invalid end date', () {
      expect(getResidentDaysRemaining(null), isNull);
      expect(getResidentDaysRemaining('not-a-date'), isNull);
    });

    test('getResidentDaysRemaining counts whole calendar days, ignoring time',
        () {
      final now = DateTime.now();
      final today = DateTime(now.year, now.month, now.day);
      final inThreeDays = today.add(const Duration(days: 3));

      expect(getResidentDaysRemaining(today), equals(0));
      expect(getResidentDaysRemaining(inThreeDays), equals(3));
      expect(
          getResidentDaysRemaining(inThreeDays.toIso8601String()), equals(3));
      // Time-of-day is dropped before comparing: 23:59 today is still "0 days".
      expect(
          getResidentDaysRemaining(
              DateTime(now.year, now.month, now.day, 23, 59)),
          equals(0));
    });
  });
}
