import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/theme/app_theme.dart';
import 'package:flutter_resihub/core/utils/deposit_ui_helpers.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/screens/apartment_detail_page.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/shared/providers/toast_provider.dart';

class MockBuildingsService extends Fake implements BuildingsService {
  Map<String, dynamic>? apartmentData;
  List<Map<String, dynamic>> zonesData = [];
  Map<String, dynamic> cancelPolicyData = {
    'max_hold_days': 30,
    'public_max_hold_days': 7,
    'full_refund_before_days': 3,
    'partial_refund_pct': 50,
    'default_hold_amount': 2000000,
  };

  String? lastHandoverId;
  Map<String, dynamic>? lastHandoverPayload;

  Map<String, dynamic>? lastCreateReservationPayload;
  String? lastConfirmReservationId;
  String? lastRejectReservationId;
  Map<String, dynamic>? lastRejectReservationPayload;

  String? lastCancelSettleId;
  Map<String, dynamic>? lastCancelSettlePayload;

  String? lastApproveCancelId;
  Map<String, dynamic>? lastApproveCancelPayload;

  String? lastRejectCancelId;
  Map<String, dynamic>? lastRejectCancelPayload;

  String? lastPayoutCancelId;
  Map<String, dynamic>? lastPayoutCancelPayload;

  String? lastUpdateBankId;
  Map<String, dynamic>? lastUpdateBankPayload;

  String? lastDeletedApartmentId;
  String? lastUpdatedApartmentId;
  Map<String, dynamic>? lastUpdatedApartmentPayload;

  Exception? handoverError;
  Exception? cancelSettleError;

  @override
  dynamic peekApartment(String? id) => null;

  @override
  Future<dynamic> getApartment(String id, {bool force = false}) async {
    return {'data': apartmentData ?? _defaultApartmentData(id)};
  }

  @override
  Future<dynamic> getReservationCancelPolicy({bool force = false}) async {
    return {'data': cancelPolicyData};
  }

  @override
  Future<dynamic> listZones(String id, {bool force = false}) async {
    return {'data': zonesData};
  }

  @override
  Future<dynamic> listBanks() async {
    return {
      'data': [
        {
          'code': 'VCB',
          'shortName': 'Vietcombank',
          'name': 'Vietcombank',
          'bin': '970436',
          'logo': 'https://api.vietqr.io/img/VCB.png',
        },
      ],
    };
  }

  @override
  Future<dynamic> handoverApartment(String id, [Map<String, dynamic>? payload]) async {
    lastHandoverId = id;
    lastHandoverPayload = payload;
    if (handoverError != null) throw handoverError!;
    return {'message': 'Nghiệm thu & bàn giao phòng thành công.'};
  }

  @override
  Future<dynamic> updateApartment(String id, Map<String, dynamic> payload) async {
    lastUpdatedApartmentId = id;
    lastUpdatedApartmentPayload = payload;
    return {'data': {...?apartmentData, ...payload}};
  }

  @override
  Future<dynamic> deleteApartment(String id) async {
    lastDeletedApartmentId = id;
    return {'message': 'Đã xóa căn hộ thành công.'};
  }

  @override
  Future<dynamic> createReservation(Map<String, dynamic> payload, {Options? options}) async {
    lastCreateReservationPayload = payload;
    return {'id': 'rsv-new', ...payload};
  }

  @override
  Future<dynamic> confirmReservationPayment(String id, [Map<String, dynamic>? payload, Options? options]) async {
    lastConfirmReservationId = id;
    return {'message': 'Đã xác nhận tiền về và khóa giữ chỗ căn hộ.'};
  }

  @override
  Future<dynamic> rejectReservationPayment(String id, Map<String, dynamic> payload, {Options? options}) async {
    lastRejectReservationId = id;
    lastRejectReservationPayload = payload;
    return {'message': 'Đã từ chối yêu cầu giữ chỗ.'};
  }

  @override
  Future<dynamic> cancelSettleReservation(String id, Map<String, dynamic> payload, {Options? options}) async {
    lastCancelSettleId = id;
    lastCancelSettlePayload = payload;
    if (cancelSettleError != null) throw cancelSettleError!;
    return {'message': 'Đã gửi đề xuất thanh lý hủy giữ chỗ chờ phê duyệt.'};
  }

  @override
  Future<dynamic> approveReservationCancel(String id, [Map<String, dynamic>? payload, Options? options]) async {
    lastApproveCancelId = id;
    lastApproveCancelPayload = payload;
    return {'message': 'Đã phê duyệt phương án thanh lý hủy giữ chỗ.'};
  }

  @override
  Future<dynamic> rejectReservationCancel(String id, Map<String, dynamic> payload, {Options? options}) async {
    lastRejectCancelId = id;
    lastRejectCancelPayload = payload;
    return {'message': 'Đã từ chối đề xuất thanh lý hủy giữ chỗ.'};
  }

  @override
  Future<dynamic> payoutReservationCancel(String id, Map<String, dynamic> payload, {Options? options}) async {
    lastPayoutCancelId = id;
    lastPayoutCancelPayload = payload;
    return {'message': 'Đã xác nhận chi hoàn tiền giữ chỗ và lưu chứng từ UNC.'};
  }

  @override
  Future<dynamic> updateReservationBankInfo(String id, Map<String, dynamic> payload, {Options? options}) async {
    lastUpdateBankId = id;
    lastUpdateBankPayload = payload;
    return {'message': 'Đã cập nhật tài khoản nhận hoàn tiền giữ chỗ.'};
  }
}

Map<String, dynamic> _defaultApartmentData(String id) => {
      'id': id,
      'code': '101',
      'building_id': 'b-1',
      'building_code': 'B01',
      'building_name': 'Tòa Tháp Vàng',
      'building_has_active_owner': true,
      'floor_name': 'Tầng 1',
      'zone_id': 'z-1',
      'zone_code': 'A',
      'zone_name': 'Khu A',
      'status': 'AVAILABLE',
      'type': '1PN',
      'bedrooms': 1,
      'area_m2': 45.5,
      'base_rent': 8500000,
      'note': 'Căn hộ view hồ bơi',
      'amenities': {'Điều hòa': true, 'Nóng lạnh': true},
      'allowed_transitions': ['MAINTENANCE', 'BLOCKED'],
      'meters': [
        {
          'id': 'm-1',
          'meter_code': 'E-101',
          'meter_type': 'ELECTRICITY',
          'unit': 'kWh',
          'unit_price': 3500,
          'latest_reading': 120,
          'latest_period': '10/2026',
        },
      ],
      'contracts': [
        {
          'id': 'c-1',
          'tenant_name': 'Nguyễn Văn Khách',
          'start_date': '2026-01-01',
          'end_date': '2026-12-31',
          'rent_amount': 8500000,
          'status': 'ACTIVE',
        },
      ],
      'reservations': <Map<String, dynamic>>[],
      'service_requests': <Map<String, dynamic>>[],
    };

Widget _buildTestApp({
  required MockBuildingsService mockService,
  required String roleCode,
  required String currentUserId,
  required AppStorage storage,
  required String apartmentId,
  Key? key,
  String? initialReservationId,
  String? initialModal,
  void Function(ProviderContainer container)? onContainerCreated,
}) {
  final user = UserModel(
    id: currentUserId,
    fullName: 'Test User $roleCode',
    email: '$roleCode@resihub.test',
    roles: [UserRoleModel(code: roleCode)],
  );

  final container = ProviderContainer(
    overrides: [
      appStorageProvider.overrideWithValue(storage),
      buildingsServiceProvider.overrideWithValue(mockService),
    ],
  );

  container.read(authProvider.notifier).setAuthData(
        accessToken: 'test-token',
        refreshToken: 'test-refresh',
        user: user,
      );

  onContainerCreated?.call(container);

  return UncontrolledProviderScope(
    container: container,
    child: MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: ApartmentDetailPage(
          key: key ?? ValueKey('$apartmentId-$roleCode-$currentUserId'),
          apartmentId: apartmentId,
          initialReservationId: initialReservationId,
          initialModal: initialModal,
        ),
      ),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStorage storage;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    storage = AppStorage(prefs: prefs);
  });

  group('ApartmentDetailPage Tests', () {
    testWidgets('1. Renders apartment details, meters, and contract correctly', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final mock = MockBuildingsService();
      mock.apartmentData = _defaultApartmentData('apt-1');

      await tester.pumpWidget(
        _buildTestApp(
          mockService: mock,
          roleCode: 'MANAGER',
          currentUserId: 'mgr-1',
          storage: storage,
          apartmentId: 'apt-1',
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Căn hộ 101'), findsOneWidget);
      expect(find.textContaining('B01 — Tòa Tháp Vàng'), findsOneWidget);
      expect(find.textContaining('8.500.000'), findsWidgets);
      expect(find.text('45.5 m²'), findsOneWidget);
      expect(find.text('1PN (1 PN)'), findsOneWidget);
      expect(find.text('Điện (E-101)'), findsOneWidget);
      expect(find.text('Nguyễn Văn Khách'), findsOneWidget);
    });

    testWidgets('2. Handover flow when apartment is in MAINTENANCE', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final mock = MockBuildingsService();
      final data = _defaultApartmentData('apt-2');
      data['status'] = 'MAINTENANCE';
      mock.apartmentData = data;

      await tester.pumpWidget(
        _buildTestApp(
          mockService: mock,
          roleCode: 'MANAGER',
          currentUserId: 'mgr-1',
          storage: storage,
          apartmentId: 'apt-2',
        ),
      );
      await tester.pumpAndSettle();

      final handoverBtn = find.text('Nghiệm thu & Bàn giao');
      expect(handoverBtn, findsOneWidget);

      await tester.tap(handoverBtn);
      await tester.pumpAndSettle();

      expect(find.textContaining('Nghiệm thu & Bàn giao căn 101'), findsOneWidget);

      final submitBtn = find.text('Nghiệm thu & Mở bán (AVAILABLE)');
      expect(submitBtn, findsOneWidget);

      await tester.tap(submitBtn);
      await tester.pumpAndSettle();

      expect(mock.lastHandoverId, 'apt-2');
      expect(mock.lastHandoverPayload?['keep_maintenance'], false);
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('3. Cancel settlement modal computes suggested split via computeSuggestedCancelSplit', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final mock = MockBuildingsService();
      final data = _defaultApartmentData('apt-3');
      data['reservations'] = [
        {
          'id': 'rsv-100',
          'prospect_name': 'Lê Văn Khách',
          'phone': '0901234567',
          'hold_amount': 2000000,
          'status': 'HELD',
          'hold_from': '2026-11-10',
          'hold_until': '2026-11-20',
          'source': 'INTERNAL',
        }
      ];
      mock.apartmentData = data;

      await tester.pumpWidget(
        _buildTestApp(
          mockService: mock,
          roleCode: 'MANAGER',
          currentUserId: 'mgr-1',
          storage: storage,
          apartmentId: 'apt-3',
        ),
      );
      await tester.pumpAndSettle();

      final proposeBtn = find.text('Đề xuất thanh lý hủy');
      expect(proposeBtn, findsOneWidget);

      await tester.ensureVisible(proposeBtn);
      await tester.pumpAndSettle();
      await tester.tap(proposeBtn);
      await tester.pumpAndSettle();

      expect(find.textContaining('Đề xuất thanh lý hủy giữ chỗ'), findsOneWidget);
      expect(find.textContaining('Áp dụng gợi ý chính sách'), findsOneWidget);
      expect(find.textContaining('Hoàn 100%'), findsOneWidget);
      expect(find.textContaining('Tịch thu 100%'), findsOneWidget);

      // Verify computeSuggestedCancelSplit output matches default policy calculation
      final expected = computeSuggestedCancelSplit(
        holdAmount: 2000000,
        holdUntil: '2026-11-20',
        policy: mock.cancelPolicyData,
      );
      expect(expected.refundedAmount + expected.forfeitedAmount, 2000000);
    });

    testWidgets('4. Four-Eyes validation: MANAGER who proposed cannot approve, OWNER can approve', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final mock = MockBuildingsService();
      final data = _defaultApartmentData('apt-4');
      data['building_has_active_owner'] = true;
      data['reservations'] = [
        {
          'id': 'rsv-200',
          'prospect_name': 'Trần Văn Proposer',
          'hold_amount': 2000000,
          'refunded_amount': 1000000,
          'forfeited_amount': 1000000,
          'status': 'CANCEL_PENDING_APPROVAL',
          'cancel_settlement': {
            'proposed_by': 'mgr-1',
          },
        }
      ];
      mock.apartmentData = data;

      // 4A. Manager who proposed (mgr-1) is BLOCKED by 4-eyes
      await tester.pumpWidget(
        _buildTestApp(
          mockService: mock,
          roleCode: 'MANAGER',
          currentUserId: 'mgr-1',
          storage: storage,
          apartmentId: 'apt-4',
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Duyệt thanh lý hủy'), findsNothing);

      // 4B. OWNER can approve
      await tester.pumpWidget(
        _buildTestApp(
          mockService: mock,
          roleCode: 'OWNER',
          currentUserId: 'owner-1',
          storage: storage,
          apartmentId: 'apt-4',
        ),
      );
      await tester.pumpAndSettle();

      final approveBtn = find.text('Duyệt thanh lý hủy');
      expect(approveBtn, findsOneWidget);

      await tester.ensureVisible(approveBtn);
      await tester.pumpAndSettle();
      await tester.tap(approveBtn);
      await tester.pumpAndSettle();

      expect(find.textContaining('Phê duyệt thanh lý hủy giữ chỗ'), findsOneWidget);

      final confirmApprove = find.text('Phê duyệt phương án & Mở phòng');
      expect(confirmApprove, findsOneWidget);
      await tester.tap(confirmApprove);
      await tester.pumpAndSettle();

      expect(mock.lastApproveCancelId, 'rsv-200');
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('5. SYS_ADMIN 4-eyes fallback when !buildingHasActiveOwner', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final mock = MockBuildingsService();
      final data = _defaultApartmentData('apt-5');
      // Case 5A: building has active owner -> SYS_ADMIN cannot approve
      data['building_has_active_owner'] = true;
      data['reservations'] = [
        {
          'id': 'rsv-300',
          'prospect_name': 'Khách Vãng Lai',
          'hold_amount': 2000000,
          'refunded_amount': 2000000,
          'forfeited_amount': 0,
          'status': 'CANCEL_PENDING_APPROVAL',
          'cancel_settlement': {
            'proposed_by': 'mgr-1',
          },
        }
      ];
      mock.apartmentData = data;

      // 5A
      await tester.pumpWidget(
        _buildTestApp(
          key: const Key('case-5a'),
          mockService: mock,
          roleCode: 'SYS_ADMIN',
          currentUserId: 'admin-1',
          storage: storage,
          apartmentId: 'apt-5',
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Duyệt thanh lý hủy'), findsNothing);

      // Case 5B: building does NOT have active owner -> SYS_ADMIN fallback permits approval
      data['building_has_active_owner'] = false;
      mock.apartmentData = data;

      await tester.pumpWidget(
        _buildTestApp(
          key: const Key('case-5b'),
          mockService: mock,
          roleCode: 'SYS_ADMIN',
          currentUserId: 'admin-1',
          storage: storage,
          apartmentId: 'apt-5',
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Duyệt thanh lý hủy'), findsOneWidget);
    });

    testWidgets('6. Auto deep-link (?reservation_id=...&modal=reservation) opens reservation modal', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final mock = MockBuildingsService();
      final data = _defaultApartmentData('apt-6');
      data['reservations'] = [
        {
          'id': 'rsv-deeplink-1',
          'prospect_name': 'Khách DeepLink',
          'phone': '0988776655',
          'hold_amount': 3000000,
          'status': 'PENDING_CONFIRM',
          'hold_from': '2026-11-14',
          'hold_until': '2026-11-20',
          'evidence': ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY44YAAAAASUVORK5CYII='],
          'note': 'Chuyển khoản cọc căn 101',
        }
      ];
      mock.apartmentData = data;

      await tester.pumpWidget(
        _buildTestApp(
          mockService: mock,
          roleCode: 'MANAGER',
          currentUserId: 'mgr-1',
          storage: storage,
          apartmentId: 'apt-6',
          initialReservationId: 'rsv-deeplink-1',
          initialModal: 'reservation',
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Chi tiết Phiếu Giữ chỗ & Chứng từ Đặt cọc'), findsOneWidget);
      expect(find.textContaining('Khách: Khách DeepLink'), findsOneWidget);
      expect(find.text('Xác nhận tiền về'), findsWidgets);
      expect(find.text('Từ chối biên lai'), findsWidgets);
    });

    testWidgets('7. Error toast surfacing on API error in handover', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final mock = MockBuildingsService();
      final data = _defaultApartmentData('apt-7');
      data['status'] = 'MAINTENANCE';
      mock.apartmentData = data;
      mock.handoverError = DioException(
        requestOptions: RequestOptions(path: '/api/v1/apartments/apt-7/handover'),
        response: Response(
          requestOptions: RequestOptions(path: '/api/v1/apartments/apt-7/handover'),
          statusCode: 400,
          data: {'message': 'Biên bản nghiệm thu chưa đủ điều kiện.'},
        ),
        type: DioExceptionType.badResponse,
      );

      late ProviderContainer containerRef;
      await tester.pumpWidget(
        _buildTestApp(
          mockService: mock,
          roleCode: 'MANAGER',
          currentUserId: 'mgr-1',
          storage: storage,
          apartmentId: 'apt-7',
          onContainerCreated: (c) => containerRef = c,
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Nghiệm thu & Bàn giao'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Nghiệm thu & Mở bán (AVAILABLE)'));
      await tester.pumpAndSettle();

      final toasts = containerRef.read(toastProvider);
      expect(toasts.any((t) => t.message.contains('Biên bản nghiệm thu chưa đủ điều kiện.')), isTrue);
      await tester.pump(const Duration(seconds: 5));
    });
  });
}
