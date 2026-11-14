import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/constants/statuses.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/utils/notification_navigation.dart';
import 'package:flutter_resihub/shared/providers/notification_provider.dart';
import 'package:flutter_resihub/shared/widgets/common/bank_select.dart';
import 'package:flutter_resihub/shared/widgets/common/data_table_widget.dart';
import 'package:flutter_resihub/shared/widgets/common/service_subscription_meta_fields.dart';
import 'package:flutter_resihub/shared/widgets/common/status_badge.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('notification_navigation.dart', () {
    test('readOrgNotifStorageKey formats correctly', () {
      expect(readOrgNotifStorageKey('user-1'), 'resihub:read-org-notifs:user-1');
      expect(readOrgNotifStorageKey(null), 'resihub:read-org-notifs:anon');
    });

    test('getReadOrgNotifIds and persistReadOrgNotifIds work with SharedPreferences and AppStorage', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();

      final initial = getReadOrgNotifIds('u1', prefs: prefs);
      expect(initial, isEmpty);

      persistReadOrgNotifIds('u1', {'id-1', 'id-2'}, prefs: prefs);
      final stored = getReadOrgNotifIds('u1', prefs: prefs);
      expect(stored, containsAll(['id-1', 'id-2']));
    });

    test('mergeOrgNotificationReadState marks org notifications as read and adjusts unreadCount', () {
      final rows = [
        {
          'id': 'notif-org-1',
          'user_id': null,
          'title': 'Toà nhà bảo trì',
          'read_at': null,
        },
        {
          'id': 'notif-user-1',
          'user_id': 'u1',
          'title': 'Hóa đơn tháng 11',
          'read_at': null,
        },
      ];

      // With notif-org-1 in read ids
      final merged = mergeOrgNotificationReadState(
        rows,
        'u1',
        mockReadOrgIds: {'notif-org-1'},
        serverUnreadCount: 2,
      );

      expect(merged.notifications[0]['read_at'], isNotNull);
      expect(merged.notifications[1]['read_at'], isNull);
      expect(merged.unreadCount, 1);
    });

    test('NotificationNotifier.markAllAsRead with extraRows stores org notifications in storage', () async {
      SharedPreferences.setMockInitialValues({});
      final storage = AppStorage(isWeb: true);
      await storage.init();

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
        ],
      );

      final notifier = container.read(notificationProvider.notifier);
      await notifier.markAllAsRead([
        {'id': 'org-extra-1', 'user_id': null, 'title': 'Org alert'},
      ]);

      final state = container.read(notificationProvider);
      expect(state.unreadCount, 0);

      final ids = getReadOrgNotifIds(null, storage: storage);
      expect(ids, contains('org-extra-1'));
    });

    group('resolveNotificationAction - Resident', () {
      test('Broadcast types resolve to detail_modal', () {
        final res = resolveNotificationAction(
          {'type': 'ANNOUNCEMENT', 'payload': {'building_id': 'b-1'}},
          role: 'RESIDENT',
        );
        expect(res.kind, NotificationActionKind.detailModal);
        expect(res.actionLabel, 'Xem thông báo');
      });

      test('INVOICE_ISSUED resolves to navigate with pay modal', () {
        final res = resolveNotificationAction(
          {
            'type': 'INVOICE_ISSUED',
            'payload': {
              'contract_id': '11111111-1111-1111-1111-111111111111',
              'invoice_id': '22222222-2222-2222-2222-222222222222',
            },
          },
          role: 'RESIDENT',
        );
        expect(res.kind, NotificationActionKind.navigate);
        expect(res.url, contains('tab=invoices'));
        expect(res.url, contains('modal=pay'));
        expect(res.actionLabel, 'Thanh toán ngay');
      });

      test('CONTRACT_EXPIRING resolves to navigate with renew modal', () {
        final res = resolveNotificationAction(
          {
            'type': 'CONTRACT_EXPIRING',
            'payload': {
              'contract_id': '11111111-1111-1111-1111-111111111111',
            },
          },
          role: 'RESIDENT',
        );
        expect(res.kind, NotificationActionKind.navigate);
        expect(res.url, contains('tab=contract'));
        expect(res.url, contains('modal=renew'));
        expect(res.actionLabel, 'Gia hạn / Phản hồi');
      });
    });

    group('resolveNotificationAction - Admin', () {
      test('SERVICE_REQUEST resolves to admin maintenance', () {
        final res = resolveNotificationAction(
          {
            'type': 'SERVICE_REQUEST_CREATED',
            'payload': {
              'service_request_id': '11111111-1111-1111-1111-111111111111',
            },
          },
          role: 'MANAGER',
          isAdminPortal: true,
        );
        expect(res.kind, NotificationActionKind.navigate);
        expect(res.url, contains('/admin/maintenance'));
        expect(res.actionLabel, 'Xử lý phiếu bảo trì');
      });

      test('PAYMENT_REPORTED resolves to transactions review', () {
        final res = resolveNotificationAction(
          {
            'type': 'PAYMENT_REPORTED',
            'payload': {
              'payment_id': '11111111-1111-1111-1111-111111111111',
            },
          },
          role: 'MANAGER',
          isAdminPortal: true,
        );
        expect(res.kind, NotificationActionKind.navigate);
        expect(res.url, contains('/admin/payments?tab=transactions'));
        expect(res.url, contains('modal=review'));
        expect(res.actionLabel, 'Đối soát chứng từ');
      });

      test('AI_BUDGET_WARNING gated by SYS_ADMIN role', () {
        final resManager = resolveNotificationAction(
          {'type': 'AI_BUDGET_WARNING', 'payload': {}},
          role: 'MANAGER',
          isAdminPortal: true,
        );
        expect(resManager.kind, NotificationActionKind.detailModal);

        final resAdmin = resolveNotificationAction(
          {'type': 'AI_BUDGET_WARNING', 'payload': {}},
          role: 'SYS_ADMIN',
          isAdminPortal: true,
        );
        expect(resAdmin.kind, NotificationActionKind.navigate);
        expect(resAdmin.url, contains('/admin/settings'));
        expect(resAdmin.url, contains('modal=ai'));
        expect(resAdmin.actionLabel, 'Kiểm tra hạn mức AI');
      });
    });
  });

  group('Widget Tests', () {
    testWidgets('StatusBadge renders correctly according to domain & code', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: StatusBadge(
              domain: StatusDomain.contract,
              status: 'ACTIVE',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Đang hiệu lực'), findsOneWidget);
    });

    testWidgets('ServiceSubscriptionMetaFields renders vehicle plates inputs according to quantity', (tester) async {
      final plates = ['59A1-12345', ''];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ServiceSubscriptionMetaFields(
              isParking: true,
              quantity: 2,
              vehiclePlates: plates,
              onPlateChange: (idx, val) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Biển số xe #1'), findsOneWidget);
      expect(find.text('Biển số xe #2'), findsOneWidget);
      expect(find.byType(VehiclePlatesBadges), findsNothing);
    });

    testWidgets('BankSelect renders correctly', (tester) async {
      await tester.pumpWidget(
        const ProviderScope(
          child: MaterialApp(
            home: Scaffold(
              body: BankSelect(
                value: 'VCB',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Ngân hàng (VietQR)'), findsOneWidget);
    });

    testWidgets('DataTableWidget renders columns, rows, and pagination', (tester) async {
      final data = [
        {'id': '1', 'name': 'Item A'},
        {'id': '2', 'name': 'Item B'},
      ];

      final columns = [
        DataTableColumn<Map<String, dynamic>>(
          key: 'name',
          label: 'Tên hạng mục',
          cellText: (row) => row['name'] as String,
        ),
      ];

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: DataTableWidget<Map<String, dynamic>>(
              columns: columns,
              data: data,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Tên hạng mục'), findsOneWidget);
      expect(find.text('Item A'), findsOneWidget);
      expect(find.text('Item B'), findsOneWidget);
    });
  });
}
