import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/screens/building_detail_page.dart';
import 'package:flutter_resihub/features/buildings/screens/zone_detail_page.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/buildings/widgets/bulk_apartment_modal.dart';
import 'package:flutter_resihub/features/buildings/widgets/floor_modal.dart';
import 'package:flutter_resihub/features/buildings/widgets/floor_plan_view.dart';
import 'package:flutter_resihub/features/notifications/services/notifications_service.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_input.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_select.dart';

class FakeNotificationsService extends Fake implements NotificationsService {
  @override
  Future<dynamic> list() async => {'data': <Map<String, dynamic>>[], 'unread_count': 0};
  @override
  Future<dynamic> markRead(dynamic id) async => {'success': true};
}

class MockFloorPlanBuildingsService extends Fake implements BuildingsService {
  Map<String, dynamic> buildingDetail = {
    'id': 'b-1',
    'code': 'B01',
    'name': 'Tòa Diamond',
    'address': '123 Đường ResiHub, Quận 1',
    'status': 'ACTIVE',
    'total_floors': 2,
    'total_apartments': 6,
    'payment_account': {
      'bank_name': 'Vietcombank',
      'bank_code': 'VCB',
      'account_number': '0123456789',
      'account_holder': 'CTY TNHH RESIHUB',
    },
  };

  List<Map<String, dynamic>> zonesList = [
    {
      'id': 'z-1',
      'code': 'ZONE-A',
      'name': 'Cánh Đông',
      'apartment_count': 3,
    },
    {
      'id': 'z-2',
      'code': 'ZONE-B',
      'name': 'Cánh Tây',
      'apartment_count': 3,
    },
  ];

  List<Map<String, dynamic>> floorMapData = [
    {
      'id': 'f-1',
      'level': 1,
      'name': 'Tầng 1',
      'apartments': [
        {
          'id': 'apt-1',
          'code': 'A101',
          'floor_id': 'f-1',
          'zone_id': 'z-1',
          'zone_code': 'ZONE-A',
          'status': 'AVAILABLE',
          'type': '1PN',
          'bedrooms': 1,
          'area_m2': 45,
          'base_rent': 8500000,
        },
        {
          'id': 'apt-2',
          'code': 'A102',
          'floor_id': 'f-1',
          'zone_id': 'z-1',
          'zone_code': 'ZONE-A',
          'status': 'OCCUPIED',
          'type': '2PN',
          'bedrooms': 2,
          'area_m2': 65,
          'base_rent': 12000000,
        },
        {
          'id': 'apt-3',
          'code': 'A103',
          'floor_id': 'f-1',
          'zone_id': 'z-1',
          'zone_code': 'ZONE-A',
          'status': 'RESERVED',
          'type': 'Studio',
          'bedrooms': 0,
          'area_m2': 32,
          'base_rent': 6500000,
        },
      ],
    },
    {
      'id': 'f-2',
      'level': 2,
      'name': 'Tầng 2',
      'apartments': [
        {
          'id': 'apt-4',
          'code': 'A201',
          'floor_id': 'f-2',
          'zone_id': 'z-2',
          'zone_code': 'ZONE-B',
          'status': 'MAINTENANCE',
          'type': '1PN',
          'bedrooms': 1,
          'area_m2': 45,
          'base_rent': 8500000,
        },
        {
          'id': 'apt-5',
          'code': 'A202',
          'floor_id': 'f-2',
          'zone_id': 'z-2',
          'zone_code': 'ZONE-B',
          'status': 'BLOCKED',
          'type': '2PN',
          'bedrooms': 2,
          'area_m2': 70,
          'base_rent': 13000000,
        },
        {
          'id': 'apt-6',
          'code': 'A203',
          'floor_id': 'f-2',
          'zone_id': 'z-2',
          'zone_code': 'ZONE-B',
          'status': 'INACTIVE',
          'type': '3PN',
          'bedrooms': 3,
          'area_m2': 90,
          'base_rent': 16000000,
        },
      ],
    },
  ];

  List<Map<String, dynamic>> pendingReservations = [
    {
      'id': 'rsv-pending-1',
      'building_id': 'b-1',
      'apartment_id': 'apt-1',
      'apartment_code': 'A101',
      'prospect_name': 'Nguyen Van Kha',
      'phone': '0901234567',
      'hold_amount': 2000000,
      'status': 'PENDING_CONFIRM',
      'hold_from': '2026-11-20',
      'hold_until': '2026-11-25',
      'evidence': ['https://example.com/receipt.jpg'],
    },
  ];

  Map<String, dynamic> apartmentDetails = {
    'id': 'apt-1',
    'code': 'A101',
    'floor_id': 'f-1',
    'zone_id': 'z-1',
    'zone_code': 'ZONE-A',
    'status': 'AVAILABLE',
    'type': '1PN',
    'bedrooms': 1,
    'area_m2': 45,
    'base_rent': 8500000,
    'contracts': [
      {
        'id': 'c-1',
        'status': 'ACTIVE',
        'contract_number': 'HD-101',
        'start_date': '2026-11-01',
        'end_date': '2026-11-20',
        'tenant_name': 'Le Thi B',
        'tenant_phone': '0912345678',
        'rent_amount': 8500000,
      },
    ],
    'reservations': [
      {
        'id': 'rsv-1',
        'status': 'HELD',
        'prospect_name': 'Tran Van C',
        'phone': '0987654321',
        'hold_from': '2026-11-25',
        'hold_until': '2026-11-30',
        'hold_amount': 2000000,
      },
    ],
  };

  Map<String, dynamic>? lastCreatedReservation;
  Map<String, dynamic>? lastCreatedApartment;
  Map<String, dynamic>? lastCreatedFloor;
  Map<String, dynamic>? lastCreatedFloorsBulk;
  Map<String, dynamic>? lastPreviewedApartmentsBulk;
  Map<String, dynamic>? lastCreatedApartmentsBulk;
  String? lastConfirmedPaymentId;
  String? lastRejectedPaymentId;
  String? lastDeletedFloorId;
  String? lastDeletedZoneId;
  String? lastDeletedBuildingId;
  String? lastUpdatedStatus;

  @override
  dynamic peekById(String? id) => null;

  @override
  Future<dynamic> getById(String id, {bool force = false}) async {
    return {'data': buildingDetail};
  }

  @override
  dynamic peekList() => null;

  @override
  Future<dynamic> list({bool force = false}) async {
    return {
      'data': [buildingDetail],
    };
  }

  @override
  dynamic peekFloorMap(String? id) => null;

  @override
  Future<dynamic> getFloorMap(String id, {bool force = false}) async {
    return {'data': floorMapData};
  }

  @override
  dynamic peekFloors(String? id) => null;

  @override
  Future<dynamic> listFloors(String id, {bool force = false}) async {
    return {
      'data': floorMapData.map((f) => {
            'id': f['id'],
            'level': f['level'],
            'name': f['name'],
            'apartment_count': (f['apartments'] as List).length,
          }).toList(),
    };
  }

  @override
  dynamic peekZones(String? id) => null;

  @override
  Future<dynamic> listZones(String id, {bool force = false}) async {
    return {'data': zonesList};
  }

  @override
  dynamic peekReservations([Map<String, dynamic>? params]) => null;

  @override
  Future<dynamic> listReservations([Map<String, dynamic>? params, bool force = false]) async {
    return {'data': pendingReservations};
  }

  @override
  Future<dynamic> getReservationCancelPolicy({bool force = false}) async {
    return {
      'data': {
        'max_hold_days': 30,
        'default_hold_amount': 2000000,
      },
    };
  }

  @override
  dynamic peekApartments([Map<String, dynamic>? params]) => null;

  @override
  Future<dynamic> listApartments([Map<String, dynamic>? params, bool force = false]) async {
    final allApts = <Map<String, dynamic>>[];
    for (final f in floorMapData) {
      allApts.addAll((f['apartments'] as List).map((a) => Map<String, dynamic>.from(a as Map)));
    }
    return {'data': allApts};
  }

  @override
  Future<dynamic> getApartment(String id, {bool force = false}) async {
    return {'data': apartmentDetails};
  }

  @override
  Future<dynamic> createReservation(Map<String, dynamic> payload, {dynamic options}) async {
    lastCreatedReservation = payload;
    return {'id': 'rsv-new', ...payload};
  }

  @override
  Future<dynamic> createApartment(Map<String, dynamic> payload) async {
    lastCreatedApartment = payload;
    return {'id': 'apt-new', ...payload};
  }

  @override
  Future<dynamic> confirmReservationPayment(String id, [Map<String, dynamic>? payload, dynamic options]) async {
    lastConfirmedPaymentId = id;
    return {'message': 'Đã xác nhận tiền về và khóa giữ chỗ căn hộ.'};
  }

  @override
  Future<dynamic> rejectReservationPayment(String id, Map<String, dynamic> payload, {dynamic options}) async {
    lastRejectedPaymentId = id;
    return {'message': 'Đã từ chối yêu cầu giữ chỗ.'};
  }

  @override
  Future<dynamic> createFloor(String id, Map<String, dynamic> payload) async {
    lastCreatedFloor = payload;
    return {'id': 'f-new', ...payload};
  }

  @override
  Future<dynamic> createFloorsBulk(String id, Map<String, dynamic> payload) async {
    lastCreatedFloorsBulk = payload;
    return {
      'message': 'Đã tạo 5 tầng mới.',
      'created_count': (payload['floors'] as List).length,
    };
  }

  @override
  Future<dynamic> previewApartmentsBulk(Map<String, dynamic> payload) async {
    lastPreviewedApartmentsBulk = payload;
    return {
      'valid': true,
      'total': 5,
      'conflicts': [],
      'data': [
        {
          'floor_id': 'f-1',
          'floor_name': 'Tầng 1',
          'code': 'A104',
          'type': '1PN',
          'bedrooms': 1,
          'area_m2': 45,
          'base_rent': 8500000,
        },
      ],
    };
  }

  @override
  Future<dynamic> createApartmentsBulk(Map<String, dynamic> payload) async {
    lastCreatedApartmentsBulk = payload;
    return {'message': 'Đã tạo 5 căn hộ.', 'created_count': 5};
  }

  @override
  Future<dynamic> deleteFloor(String id, String floorId) async {
    lastDeletedFloorId = floorId;
    return {'message': 'Đã xóa tầng thành công.'};
  }

  @override
  Future<dynamic> deleteZone(String id, String zoneId) async {
    lastDeletedZoneId = zoneId;
    return {'message': 'Đã xóa phân khu.'};
  }

  @override
  Future<dynamic> remove(String id) async {
    lastDeletedBuildingId = id;
    return {'message': 'Đã xóa tòa nhà thành công.'};
  }

  @override
  Future<dynamic> updateStatus(String id, String status) async {
    lastUpdatedStatus = status;
    return {'message': 'Đã cập nhật trạng thái tòa nhà.'};
  }
}

UserModel _createUser(String roleCode) {
  return UserModel(
    id: 'user-$roleCode',
    fullName: 'Test $roleCode',
    email: '$roleCode@resihub.test',
    roles: [UserRoleModel(code: roleCode)],
  );
}

Widget _buildWrapper({
  required Widget child,
  required MockFloorPlanBuildingsService service,
  required String roleCode,
}) {
  return ProviderScope(
    overrides: [
      buildingsServiceProvider.overrideWithValue(service),
      authProvider.overrideWith(() => AuthNotifierMock(_createUser(roleCode))),
    ],
    child: MaterialApp(
      home: Scaffold(body: child),
    ),
  );
}

class AuthNotifierMock extends AuthNotifier {
  final UserModel _mockUser;
  AuthNotifierMock(this._mockUser);

  @override
  AuthState build() {
    return AuthState(
      isAuthenticated: true,
      user: _mockUser,
      accessToken: 'token',
      selectedBuildingId: 'b-1',
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MockFloorPlanBuildingsService mockService;

  setUp(() {
    mockService = MockFloorPlanBuildingsService();
  });

  group('FloorPlanView Tests', () {
    testWidgets('Renders 6 apartment status badges/cards and supports status filtering', (tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildWrapper(
        child: const FloorPlanView(buildingId: 'b-1'),
        service: mockService,
        roleCode: 'MANAGER',
      ));
      await tester.pumpAndSettle();

      // Check all 6 apartments rendered
      expect(find.text('A101'), findsOneWidget); // AVAILABLE
      expect(find.text('A102'), findsOneWidget); // OCCUPIED
      expect(find.text('A103'), findsOneWidget); // RESERVED
      expect(find.text('A201'), findsOneWidget); // MAINTENANCE
      expect(find.text('A202'), findsOneWidget); // BLOCKED
      expect(find.text('A203'), findsOneWidget); // INACTIVE

      // Check legend status chips exist
      expect(find.text('Tất cả trạng thái'), findsOneWidget);
      expect(find.text('Còn trống'), findsAtLeastNWidgets(1));
      expect(find.text('Đang thuê'), findsAtLeastNWidgets(1));
      expect(find.text('Đã giữ chỗ'), findsAtLeastNWidgets(1));
      expect(find.text('Đang bảo trì'), findsAtLeastNWidgets(1));
      expect(find.text('Tạm khóa / Ngưng'), findsOneWidget);

      // Filter by 'Còn trống'
      await tester.tap(find.text('Còn trống').first);
      await tester.pumpAndSettle();

      expect(find.text('A101'), findsOneWidget);
      expect(find.text('A102'), findsNothing);
      expect(find.text('A103'), findsNothing);

      // Reset filter
      await tester.tap(find.text('Tất cả trạng thái'));
      await tester.pumpAndSettle();

      expect(find.text('A101'), findsOneWidget);
      expect(find.text('A102'), findsOneWidget);
    });

    testWidgets('Displays online pending reservations card with confirm/reject actions for MANAGER', (tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildWrapper(
        child: const FloorPlanView(buildingId: 'b-1'),
        service: mockService,
        roleCode: 'MANAGER',
      ));
      await tester.pumpAndSettle();

      expect(find.textContaining('Yêu cầu Giữ chỗ Online chờ đối chiếu sao kê'), findsOneWidget);
      expect(find.text('Nguyen Van Kha (0901234567)'), findsOneWidget);
      expect(find.text('Xác nhận tiền về'), findsOneWidget);
      expect(find.text('Từ chối'), findsOneWidget);
      expect(find.text('Chi tiết căn'), findsOneWidget);

      // Confirm payment
      await tester.tap(find.text('Xác nhận tiền về'));
      await tester.pumpAndSettle();

      expect(mockService.lastConfirmedPaymentId, 'rsv-pending-1');
    });

    testWidgets('Smart reservation suggestion avoids busy intervals & detects overlaps', (tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildWrapper(
        child: const FloorPlanView(buildingId: 'b-1'),
        service: mockService,
        roleCode: 'MANAGER',
      ));
      await tester.pumpAndSettle();

      // Click on A101 to open apartment detail drawer
      await tester.tap(find.text('A101'));
      await tester.pumpAndSettle();

      expect(find.text('Căn hộ A101'), findsOneWidget);
      expect(find.text('Đặt cọc giữ chỗ'), findsOneWidget);

      // Click "Đặt cọc giữ chỗ"
      await tester.tap(find.text('Đặt cọc giữ chỗ'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Đặt cọc giữ chỗ — Căn A101'), findsOneWidget);
      // The apartment has active contract 2026-11-01 to 2026-11-20, so earliestResStart is 2026-11-21
      expect(find.textContaining('hệ thống đã tự gợi ý ngày trống gần nhất'), findsOneWidget);

      // Try entering customer name & phone
      await tester.enterText(
        find.descendant(
          of: find.widgetWithText(AppInput, 'Họ tên khách đặt giữ chỗ'),
          matching: find.byType(TextField),
        ),
        'Pham Van Dong',
      );
      await tester.enterText(
        find.descendant(
          of: find.widgetWithText(AppInput, 'Số điện thoại'),
          matching: find.byType(TextField),
        ),
        '0988776655',
      );

      // Test invalid date validation: hold_from overlaps active contract (2026-11-10)
      await tester.enterText(
        find.descendant(
          of: find.widgetWithText(AppInput, 'Giữ chỗ từ ngày'),
          matching: find.byType(TextField),
        ),
        '2026-11-10',
      );
      await tester.tap(find.text('Xác nhận giữ chỗ'));
      await tester.pumpAndSettle();
      // Overlapping busy interval must be rejected without calling API
      expect(mockService.lastCreatedReservation, isNull);

      // Now restore valid available dates (2026-11-21 to 2026-11-24, avoiding rsv-1 starting 2026-11-25)
      await tester.enterText(
        find.descendant(
          of: find.widgetWithText(AppInput, 'Giữ chỗ từ ngày'),
          matching: find.byType(TextField),
        ),
        '2026-11-21',
      );
      await tester.enterText(
        find.descendant(
          of: find.widgetWithText(AppInput, 'Đến hết ngày'),
          matching: find.byType(TextField),
        ),
        '2026-11-24',
      );

      // Submit reservation
      await tester.tap(find.text('Xác nhận giữ chỗ'));
      await tester.pumpAndSettle();

      expect(mockService.lastCreatedReservation, isNotNull);
      expect(mockService.lastCreatedReservation!['prospect_name'], 'Pham Van Dong');
      expect(mockService.lastCreatedReservation!['apartment_id'], 'apt-1');
      expect(mockService.lastCreatedReservation!['hold_from'], '2026-11-21');
      expect(mockService.lastCreatedReservation!['hold_until'], '2026-11-24');
    });

    testWidgets('Role permission enforcement: OWNER is strictly read-only', (tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildWrapper(
        child: const FloorPlanView(buildingId: 'b-1'),
        service: mockService,
        roleCode: 'OWNER',
      ));
      await tester.pumpAndSettle();

      // OWNER must NOT see edit/create buttons
      expect(find.text('Tạo hàng loạt'), findsNothing);
      expect(find.text('Thêm tầng'), findsNothing);
      expect(find.text('Thêm căn hộ'), findsNothing);
      expect(find.text('Xác nhận tiền về'), findsNothing);
      expect(find.text('Từ chối'), findsNothing);
      expect(find.text('Xóa tầng'), findsNothing);

      // Open drawer on A101
      await tester.tap(find.text('A101'));
      await tester.pumpAndSettle();

      expect(find.text('Đặt cọc giữ chỗ'), findsNothing);
      expect(find.text('Tạo hợp đồng thuê'), findsNothing);
      expect(find.text('Chuyển sang Bảo trì'), findsNothing);
    });

    testWidgets('Apartment Drawer renders right-side drawer with 4 stat boxes, amenities and footer CTA', (tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildWrapper(
        child: const FloorPlanView(buildingId: 'b-1'),
        service: mockService,
        roleCode: 'MANAGER',
      ));
      await tester.pumpAndSettle();

      // Open drawer on A101
      await tester.tap(find.text('A101'));
      await tester.pumpAndSettle();

      expect(find.text('Căn hộ A101'), findsOneWidget);
      expect(find.text('Phân khu'), findsOneWidget);
      expect(find.text('Loại căn'), findsOneWidget);
      expect(find.text('Diện tích'), findsOneWidget);
      expect(find.text('Phòng ngủ'), findsOneWidget);
      expect(find.text('Mở trang chi tiết căn hộ'), findsOneWidget);
    });

    testWidgets('Drawer pending list filters PENDING_CONFIRM, not PENDING_PAYMENT', (tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      mockService.apartmentDetails = {
        ...mockService.apartmentDetails,
        'reservations': [
          ...(mockService.apartmentDetails['reservations'] as List),
          {
            'id': 'rsv-drawer-confirm',
            'status': 'PENDING_CONFIRM',
            'prospect_name': 'Confirm Owner',
            'phone': '0900000002',
            'hold_amount': 3000000,
            'hold_from': '2026-11-20',
            'hold_until': '2026-11-22',
          },
          {
            'id': 'rsv-drawer-pay',
            'status': 'PENDING_PAYMENT',
            'prospect_name': 'Payment Owner',
            'phone': '0900000003',
            'hold_amount': 1000000,
            'hold_from': '2026-11-23',
            'hold_until': '2026-11-24',
          },
        ],
      };

      await tester.pumpWidget(_buildWrapper(
        child: const FloorPlanView(buildingId: 'b-1'),
        service: mockService,
        roleCode: 'MANAGER',
      ));
      await tester.pumpAndSettle();

      await tester.tap(find.text('A101'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Confirm Owner'), findsOneWidget);
      expect(find.textContaining('Payment Owner'), findsNothing);
    });

    testWidgets('Reservation modal offers 6 payment method options', (tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildWrapper(
        child: const FloorPlanView(buildingId: 'b-1'),
        service: mockService,
        roleCode: 'MANAGER',
      ));
      await tester.pumpAndSettle();

      await tester.tap(find.text('A101'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Đặt cọc giữ chỗ'));
      await tester.pumpAndSettle();

      await tester.tap(
        find.descendant(
          of: find.byWidgetPredicate(
            (w) => w is AppSelect && w.label == 'Phương thức thu tiền',
          ),
          matching: find.byType(InkWell),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Chuyển khoản'), findsWidgets);
      expect(find.text('QR Code'), findsOneWidget);
      expect(find.text('Ví điện tử'), findsOneWidget);
      expect(find.text('Tiền mặt'), findsOneWidget);
      expect(find.text('Thẻ'), findsOneWidget);
      expect(find.text('Khác'), findsOneWidget);
    });

    testWidgets('Add apartment modal has zone select and sends zone_id', (tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildWrapper(
        child: const FloorPlanView(buildingId: 'b-1'),
        service: mockService,
        roleCode: 'MANAGER',
      ));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Thêm căn hộ'));
      await tester.pumpAndSettle();

      expect(find.text('Khu / Phân khu'), findsOneWidget);

      await tester.tap(
        find.descendant(
          of: find.byWidgetPredicate(
            (w) => w is AppSelect && w.label == 'Khu / Phân khu',
          ),
          matching: find.byType(InkWell),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cánh Tây'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.descendant(
          of: find.widgetWithText(AppInput, 'Mã căn hộ'),
          matching: find.byType(TextField),
        ),
        'A1101',
      );
      await tester.tap(find.text('Tạo căn hộ'));
      await tester.pumpAndSettle();

      expect(mockService.lastCreatedApartment, isNotNull);
      expect(mockService.lastCreatedApartment!['zone_id'], 'z-2');
    });
  });

  group('FloorModal and BulkApartmentModal Tests', () {
    testWidgets('FloorModal supports bulk creation and computes floor preview', (tester) async {
      tester.view.physicalSize = const Size(1000, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildWrapper(
        child: FloorModal(
          open: true,
          buildingId: 'b-1',
          existingFloors: mockService.floorMapData,
          onClose: () {},
          onCreated: (_) {},
        ),
        service: mockService,
        roleCode: 'MANAGER',
      ));
      await tester.pumpAndSettle();

      expect(find.text('Thêm tầng vào tòa nhà'), findsOneWidget);
      expect(find.text('Thêm hàng loạt'), findsOneWidget);
      expect(find.text('Thêm từng tầng'), findsOneWidget);

      // Submit bulk creation
      await tester.tap(find.text('Khởi tạo tầng'));
      await tester.pumpAndSettle();

      expect(mockService.lastCreatedFloorsBulk, isNotNull);
    });

    testWidgets('BulkApartmentModal 2-step flow: dry-run preview then create', (tester) async {
      tester.view.physicalSize = const Size(1000, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildWrapper(
        child: BulkApartmentModal(
          open: true,
          buildingId: 'b-1',
          floors: mockService.floorMapData,
          zones: mockService.zonesList,
          onClose: () {},
          onCreated: (_) {},
        ),
        service: mockService,
        roleCode: 'MANAGER',
      ));
      await tester.pumpAndSettle();

      expect(find.text('Tạo căn hộ hàng loạt'), findsOneWidget);
      expect(find.text('Xem trước'), findsOneWidget);

      // Click "Xem trước" for dry-run
      await tester.tap(find.text('Xem trước'));
      await tester.pumpAndSettle();

      expect(mockService.lastPreviewedApartmentsBulk, isNotNull);
      // Modal gửi payload sạch; service thêm dry_run khi gọi API (React parity C13).
      expect(mockService.lastPreviewedApartmentsBulk!['dry_run'], isNot(true));

      // Now "Khởi tạo căn hộ" is available
      expect(find.text('Khởi tạo căn hộ'), findsOneWidget);
      await tester.tap(find.text('Khởi tạo căn hộ'));
      await tester.pumpAndSettle();

      expect(mockService.lastCreatedApartmentsBulk, isNotNull);
      expect(mockService.lastCreatedApartmentsBulk!['dry_run'], isNot(true));
    });
  });

  group('BuildingDetailPage and ZoneDetailPage Tests', () {
    testWidgets('BuildingDetailPage renders tabs and embedded floor plan', (tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildWrapper(
        child: const BuildingDetailPage(buildingId: 'b-1'),
        service: mockService,
        roleCode: 'MANAGER',
      ));
      await tester.pumpAndSettle();

      expect(find.text('B01 — Tòa Diamond'), findsAtLeastNWidgets(1));
      expect(find.text('Sơ đồ tòa & Tổng quan'), findsOneWidget);
      expect(find.text('Danh sách Khu'), findsOneWidget);
      expect(find.text('Tài khoản nhận thanh toán'), findsOneWidget);

      // Switch to 'Danh sách Khu' tab
      await tester.tap(find.text('Danh sách Khu'));
      await tester.pumpAndSettle();

      expect(find.text('ZONE-A'), findsOneWidget);
      expect(find.text('ZONE-B'), findsOneWidget);
      expect(find.text('Thêm phân khu (Zone)'), findsOneWidget);
    });

    testWidgets('ZoneDetailPage renders zone header, apartment list and edit action', (tester) async {
      tester.view.physicalSize = const Size(1200, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildWrapper(
        child: const ZoneDetailPage(buildingId: 'b-1', zoneId: 'z-1'),
        service: mockService,
        roleCode: 'MANAGER',
      ));
      await tester.pumpAndSettle();

      expect(find.text('Phân khu ZONE-A — Cánh Đông'), findsOneWidget);
      expect(find.text('Đổi tên khu'), findsOneWidget);
      expect(find.text('A101'), findsOneWidget);
    });
  });
}
