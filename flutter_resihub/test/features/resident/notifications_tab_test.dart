import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/features/resident/tabs/notifications_tab.dart';
import 'package:flutter_resihub/shared/providers/notification_provider.dart';
import 'package:flutter_resihub/shared/widgets/common/notification_detail_modal.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_skeleton.dart';

class _FakeNotificationNotifier extends NotificationNotifier {
  final NotificationState _initial;

  _FakeNotificationNotifier(this._initial);

  @override
  NotificationState build() => _initial;

  @override
  Future<void> fetchNotifications() async {}

  @override
  Future<void> markAsRead(dynamic id,
      [Map<String, dynamic>? notificationObj]) async {}

  @override
  Future<void> markAllAsRead(
      [List<Map<String, dynamic>> extraRows = const []]) async {}
}

Widget _buildTab(NotificationState state) {
  return ProviderScope(
    overrides: [
      notificationProvider.overrideWith(() => _FakeNotificationNotifier(state)),
    ],
    child: const MaterialApp(
      home: Scaffold(
        body: NotificationsTab(
          overview: null,
          onRefreshOverview: _noopAsync,
          onNavigateTab: _noopNavigate,
        ),
      ),
    ),
  );
}

Future<void> _noopAsync() async {}

void _noopNavigate(String tab, [Map<String, dynamic>? extra]) {}

Map<String, dynamic> _unreadPaymentNotification(String createdAt) {
  return {
    'id': 'n-1',
    'type': 'PAYMENT_REMINDER',
    'title': 'Hóa đơn cần thanh toán',
    'content': 'Hạn thanh toán là ngày 30 trong tháng.',
    'created_at': createdAt,
    'read_at': null,
    'payload': {
      'sender_name': 'Ban Quản Lý',
      'invoice_id': '11111111-1111-4111-8111-111111111111',
      'contract_id': '22222222-2222-4222-8222-222222222222',
    },
  };
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'header, filter chips, mark-all count and unread item with type badge, sender and action CTA',
    (tester) async {
      final state = NotificationState(
        notifications: [
          _unreadPaymentNotification(DateTime.now().toIso8601String())
        ],
        unreadCount: 30,
      );

      await tester.pumpWidget(_buildTab(state));
      await tester.pumpAndSettle();

      expect(find.text('Hộp thư Thông báo Cư dân'), findsOneWidget);
      expect(
        find.text(
          'Cập nhật thông báo vận hành tòa nhà, nhắc lịch hóa đơn và tiến độ xử lý yêu cầu',
        ),
        findsOneWidget,
      );
      expect(find.text('Tất cả'), findsOneWidget);
      expect(find.text('Chưa đọc'), findsOneWidget);
      expect(find.text('Đánh dấu đọc tất cả (30)'), findsOneWidget);

      // Type mapping: PAYMENT_REMINDER -> "Nhắc nợ hóa đơn", sender + CTA + unread hint.
      expect(find.text('Nhắc nợ hóa đơn'), findsOneWidget);
      expect(find.text('• Gửi bởi: Ban Quản Lý'), findsOneWidget);
      expect(find.text('Nhấn để xử lý ngay'), findsOneWidget);
      expect(find.text('Thanh toán ngay'), findsOneWidget);
      expect(find.text('Vừa xong'), findsOneWidget);
    },
  );

  testWidgets('two empty-state variants for ALL and UNREAD filters',
      (tester) async {
    await tester.pumpWidget(_buildTab(const NotificationState()));
    await tester.pumpAndSettle();

    expect(find.text('Chưa có thông báo nào'), findsOneWidget);
    expect(
      find.text(
        'Các bản tin từ Ban Quản Lý và thông báo tự động của hệ thống sẽ xuất hiện tại đây.',
      ),
      findsOneWidget,
    );

    await tester.tap(find.text('Chưa đọc'));
    await tester.pumpAndSettle();

    expect(find.text('Bạn đã đọc hết tất cả thông báo'), findsOneWidget);
    expect(
      find.text('Không còn thông báo mới nào chưa đọc trong hộp thư của bạn.'),
      findsOneWidget,
    );
  });

  testWidgets('renders four skeletons while loading with no notifications',
      (tester) async {
    await tester.pumpWidget(_buildTab(const NotificationState(loading: true)));
    await tester.pumpAndSettle();

    expect(find.byType(AppSkeleton), findsNWidgets(4));
  });

  testWidgets(
      'tapping an item opens the richer detail modal with a navigation button',
      (tester) async {
    final notif = <String, dynamic>{
      'id': 'n-2',
      'type': 'INVOICE_ADJUSTED',
      'title': 'Hóa đơn đã điều chỉnh',
      'content': 'Giá trị hóa đơn đã được điều chỉnh.',
      'created_at': DateTime.now().toIso8601String(),
      'read_at': null,
      'payload': const <String, dynamic>{},
    };
    final state = NotificationState(notifications: [notif], unreadCount: 1);

    await tester.pumpWidget(_buildTab(state));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Hóa đơn đã điều chỉnh').first);
    await tester.pumpAndSettle();

    expect(find.byType(NotificationDetailModal), findsOneWidget);
    expect(find.text('Chi tiết thông báo'), findsOneWidget);
    // Content appears both in the list item and inside the modal.
    expect(find.text('Giá trị hóa đơn đã được điều chỉnh.'), findsNWidgets(2));
    // CTA in the list plus the modal's deep-link button.
    expect(find.text('Xem hóa đơn'), findsNWidgets(2));
  });
}
