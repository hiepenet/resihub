import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/notifications/services/notifications_service.dart';

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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Dio dio;
  late QueryCache queryCache;
  late BuildingsService buildingsService;
  late NotificationsService notificationsService;
  late RequestOptions lastRequest;

  setUp(() {
    dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
    queryCache = QueryCache();

    dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
      lastRequest = options;
      return ResponseBody.fromString(
        jsonEncode({'success': true, 'data': {'id': 'test-123'}}),
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );
    });

    buildingsService = BuildingsService(dio: dio, queryCache: queryCache);
    notificationsService = NotificationsService(dio);
  });

  group('BuildingsService - Buildings (10 methods)', () {
    test('1. list sends GET /api/v1/buildings and caches', () async {
      final res = await buildingsService.list();
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/buildings');

      // Subsequent call hits cache
      lastRequest = RequestOptions(path: '/none');
      final cached = await buildingsService.list();
      expect(cached, isNotNull);
      expect(lastRequest.path, '/none'); // Not called
    });

    test('2. getById sends GET /api/v1/buildings/:id and caches', () async {
      await buildingsService.getById('b-1');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/buildings/b-1');
    });

    test('3. checkCode sends GET /api/v1/buildings/check-code with code param', () async {
      await buildingsService.checkCode('CODE123');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/buildings/check-code');
      expect(lastRequest.queryParameters['code'], 'CODE123');
    });

    test('4. lookupOwner sends GET /api/v1/buildings/lookup-owner with identifier param', () async {
      await buildingsService.lookupOwner('0901234567');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/buildings/lookup-owner');
      expect(lastRequest.queryParameters['identifier'], '0901234567');
    });

    test('5. listOwners sends GET /api/v1/buildings/owners', () async {
      await buildingsService.listOwners();
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/buildings/owners');
    });

    test('6. listBanks sends GET /api/v1/buildings/banks and caches 300s', () async {
      await buildingsService.listBanks();
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/buildings/banks');
    });

    test('7. create sends POST /api/v1/buildings with payload', () async {
      await buildingsService.create({'name': 'Building A'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/buildings');
      expect(lastRequest.data['name'], 'Building A');
    });

    test('8. update sends PATCH /api/v1/buildings/:id with payload', () async {
      await buildingsService.update('b-1', {'name': 'Building A+'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/buildings/b-1');
      expect(lastRequest.data['name'], 'Building A+');
    });

    test('9. remove sends DELETE /api/v1/buildings/:id', () async {
      await buildingsService.remove('b-1');
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/buildings/b-1');
    });

    test('10. updateStatus sends PATCH /api/v1/buildings/:id/status with status payload', () async {
      await buildingsService.updateStatus('b-1', 'INACTIVE');
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/buildings/b-1/status');
      expect(lastRequest.data['status'], 'INACTIVE');
    });
  });

  group('BuildingsService - FloorMap & Floors (7 methods)', () {
    test('11. getFloorMap sends GET /api/v1/buildings/:id/floor-map and caches', () async {
      await buildingsService.getFloorMap('b-1');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/buildings/b-1/floor-map');
    });

    test('12. listFloors sends GET /api/v1/buildings/:id/floors and caches', () async {
      await buildingsService.listFloors('b-1');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/buildings/b-1/floors');
    });

    test('13. createFloor sends POST /api/v1/buildings/:id/floors', () async {
      await buildingsService.createFloor('b-1', {'name': 'Floor 1'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/buildings/b-1/floors');
    });

    test('14. previewFloorsBulk sends POST with dry_run: true and skipCacheInvalidation: true', () async {
      await buildingsService.previewFloorsBulk('b-1', {'count': 5});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/buildings/b-1/floors/bulk');
      expect(lastRequest.data['dry_run'], true);
      expect(lastRequest.extra['skipCacheInvalidation'], true);
    });

    test('15. createFloorsBulk sends POST with dry_run: false', () async {
      await buildingsService.createFloorsBulk('b-1', {'count': 5});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/buildings/b-1/floors/bulk');
      expect(lastRequest.data['dry_run'], false);
      expect(lastRequest.extra['skipCacheInvalidation'], isNot(true));
    });

    test('16. updateFloor sends PATCH /api/v1/buildings/:id/floors/:floorId', () async {
      await buildingsService.updateFloor('b-1', 'fl-1', {'name': 'Floor 1A'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/buildings/b-1/floors/fl-1');
      expect(lastRequest.data['name'], 'Floor 1A');
    });

    test('17. deleteFloor sends DELETE /api/v1/buildings/:id/floors/:floorId', () async {
      await buildingsService.deleteFloor('b-1', 'fl-1');
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/buildings/b-1/floors/fl-1');
    });
  });

  group('BuildingsService - Zones (4 methods)', () {
    test('18. listZones sends GET /api/v1/buildings/:id/zones and caches', () async {
      await buildingsService.listZones('b-1');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/buildings/b-1/zones');
    });

    test('19. createZone sends POST /api/v1/buildings/:id/zones', () async {
      await buildingsService.createZone('b-1', {'name': 'Zone A'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/buildings/b-1/zones');
      expect(lastRequest.data['name'], 'Zone A');
    });

    test('20. updateZone sends PATCH /api/v1/buildings/:id/zones/:zoneId', () async {
      await buildingsService.updateZone('b-1', 'z-1', {'name': 'Zone A+'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/buildings/b-1/zones/z-1');
      expect(lastRequest.data['name'], 'Zone A+');
    });

    test('21. deleteZone sends DELETE /api/v1/buildings/:id/zones/:zoneId', () async {
      await buildingsService.deleteZone('b-1', 'z-1');
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/buildings/b-1/zones/z-1');
    });
  });

  group('BuildingsService - Apartments (8 methods)', () {
    test('22. listApartments sends GET /api/v1/apartments with params and caches', () async {
      await buildingsService.listApartments({'building_id': 'b-1'});
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/apartments');
      expect(lastRequest.queryParameters['building_id'], 'b-1');
    });

    test('23. getApartment sends GET /api/v1/apartments/:id and caches', () async {
      await buildingsService.getApartment('ap-1');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/apartments/ap-1');
    });

    test('24. createApartment sends POST /api/v1/apartments', () async {
      await buildingsService.createApartment({'room_number': '101'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/apartments');
      expect(lastRequest.data['room_number'], '101');
    });

    test('25. previewApartmentsBulk sends POST with dry_run: true and skipCacheInvalidation: true', () async {
      await buildingsService.previewApartmentsBulk({'building_id': 'b-1'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/apartments/bulk');
      expect(lastRequest.data['dry_run'], true);
      expect(lastRequest.extra['skipCacheInvalidation'], true);
    });

    test('26. createApartmentsBulk sends POST with dry_run: false', () async {
      await buildingsService.createApartmentsBulk({'building_id': 'b-1'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/apartments/bulk');
      expect(lastRequest.data['dry_run'], false);
      expect(lastRequest.extra['skipCacheInvalidation'], isNot(true));
    });

    test('27. updateApartment sends PATCH /api/v1/apartments/:id', () async {
      await buildingsService.updateApartment('ap-1', {'room_number': '101B'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/apartments/ap-1');
    });

    test('28. deleteApartment sends DELETE /api/v1/apartments/:id', () async {
      await buildingsService.deleteApartment('ap-1');
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/apartments/ap-1');
    });

    test('29. handoverApartment sends PATCH /api/v1/apartments/:id/handover', () async {
      await buildingsService.handoverApartment('ap-1', {'note': 'Cleaned'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/apartments/ap-1/handover');
      expect(lastRequest.data['note'], 'Cleaned');
    });
  });

  group('BuildingsService - Reservations (12 methods with strict HTTP verbs)', () {
    test('30. listReservations sends GET /api/v1/reservations', () async {
      await buildingsService.listReservations({'status': 'PENDING'});
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/reservations');
    });

    test('31. getReservationCancelPolicy sends GET /api/v1/reservations/cancel-policy and caches 120s', () async {
      await buildingsService.getReservationCancelPolicy();
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/reservations/cancel-policy');
    });

    test('32. createReservation sends POST /api/v1/reservations', () async {
      await buildingsService.createReservation({'apartment_id': 'ap-1'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/reservations');
    });

    test('33. confirmReservationPayment sends PATCH /api/v1/reservations/:id/confirm-payment', () async {
      await buildingsService.confirmReservationPayment('r-1');
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/reservations/r-1/confirm-payment');
    });

    test('34. rejectReservationPayment sends PATCH /api/v1/reservations/:id/reject-payment', () async {
      await buildingsService.rejectReservationPayment('r-1', {'reason': 'Invalid slip'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/reservations/r-1/reject-payment');
      expect(lastRequest.data['reason'], 'Invalid slip');
    });

    test('35. cancelSettleReservation sends PATCH /api/v1/reservations/:id/cancel-settle', () async {
      await buildingsService.cancelSettleReservation('r-1', {'note': 'Cancelled'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/reservations/r-1/cancel-settle');
    });

    test('36. approveReservationCancel sends POST /api/v1/reservations/:id/cancel-approve', () async {
      await buildingsService.approveReservationCancel('r-1');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/reservations/r-1/cancel-approve');
    });

    test('37. rejectReservationCancel sends POST /api/v1/reservations/:id/cancel-reject', () async {
      await buildingsService.rejectReservationCancel('r-1', {'reason': 'Non-refundable'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/reservations/r-1/cancel-reject');
      expect(lastRequest.data['reason'], 'Non-refundable');
    });

    test('38. payoutReservationCancel sends POST /api/v1/reservations/:id/cancel-payout', () async {
      await buildingsService.payoutReservationCancel('r-1', {'amount': 1000000});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/reservations/r-1/cancel-payout');
      expect(lastRequest.data['amount'], 1000000);
    });

    test('39. updateReservationBankInfo sends PATCH /api/v1/reservations/:id/bank-info', () async {
      await buildingsService.updateReservationBankInfo('r-1', {'bank_name': 'VCB'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/reservations/r-1/bank-info');
    });

    test('40. forfeitReservation sends PATCH /api/v1/reservations/:id/forfeit', () async {
      await buildingsService.forfeitReservation('r-1', {'reason': 'No show'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/reservations/r-1/forfeit');
    });

    test('41. refundReservation sends PATCH /api/v1/reservations/:id/refund', () async {
      await buildingsService.refundReservation('r-1', {'amount': 500000});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/reservations/r-1/refund');
    });
  });

  group('NotificationsService (4 methods)', () {
    test('list sends GET /api/v1/notifications', () async {
      await notificationsService.list();
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/notifications');
    });

    test('send sends POST /api/v1/notifications', () async {
      await notificationsService.send({'title': 'Hello', 'content': 'World'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/notifications');
      expect(lastRequest.data['title'], 'Hello');
    });

    test('markRead sends PATCH /api/v1/notifications/:id/read', () async {
      await notificationsService.markRead('n-1');
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/notifications/n-1/read');
    });

    test('markAllRead sends POST /api/v1/notifications/read-all', () async {
      await notificationsService.markAllRead();
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/notifications/read-all');
    });
  });
}
