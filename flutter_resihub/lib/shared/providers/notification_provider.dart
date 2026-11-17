import 'dart:math' as math;
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/storage/app_storage.dart';
import '../../core/utils/notification_navigation.dart';
import '../../features/auth/providers/auth_provider.dart';
import '../../features/notifications/services/notifications_service.dart';

@immutable
class NotificationState {
  final List<Map<String, dynamic>> notifications;
  final List<Map<String, dynamic>> sentHistory;
  final int unreadCount;
  final bool loading;

  const NotificationState({
    this.notifications = const [],
    this.sentHistory = const [],
    this.unreadCount = 0,
    this.loading = false,
  });

  NotificationState copyWith({
    List<Map<String, dynamic>>? notifications,
    List<Map<String, dynamic>>? sentHistory,
    int? unreadCount,
    bool? loading,
  }) {
    return NotificationState(
      notifications: notifications ?? this.notifications,
      sentHistory: sentHistory ?? this.sentHistory,
      unreadCount: unreadCount ?? this.unreadCount,
      loading: loading ?? this.loading,
    );
  }
}

/// Manages notification state, unread counts, and organization-wide broadcast read sync.
/// Port of `frontend/src/stores/notificationStore.js`.
class NotificationNotifier extends Notifier<NotificationState> {
  @override
  NotificationState build() {
    return const NotificationState();
  }

  String? _getCurrentUserId() {
    final user = ref.read(authProvider).user;
    return user?.id;
  }

  /// Fetches notifications from backend and merges client-side org-broadcast read state.
  Future<void> fetchNotifications() async {
    state = state.copyWith(loading: true);
    try {
      final service = ref.read(notificationsServiceProvider);
      final res = await service.list();

      final userId = _getCurrentUserId();
      final storage = ref.read(appStorageProvider);

      final List<dynamic> rows;
      if (res is Map && res['data'] is List) {
        rows = res['data'] as List;
      } else if (res is List) {
        rows = res;
      } else {
        rows = const [];
      }

      final List<dynamic> sentRows;
      if (res is Map && res['sent_history'] is List) {
        sentRows = res['sent_history'] as List;
      } else {
        sentRows = const [];
      }

      final serverUnread = res is Map ? res['unread_count'] : null;

      final merged = mergeOrgNotificationReadState(
        rows,
        userId,
        storage: storage,
        serverUnreadCount: serverUnread,
      );

      final sentHistory = sentRows
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();

      state = state.copyWith(
        notifications: merged.notifications,
        sentHistory: sentHistory,
        unreadCount: merged.unreadCount,
        loading: false,
      );
    } catch (_) {
      state = state.copyWith(loading: false);
    }
  }

  /// Marks a specific notification as read.
  Future<void> markAsRead(dynamic id, [Map<String, dynamic>? notificationObj]) async {
    final strId = id?.toString() ?? '';
    final target = state.notifications.firstWhere(
      (n) => n['id']?.toString() == strId,
      orElse: () => notificationObj ?? const {},
    );

    final wasUnread = target.isNotEmpty && (target['read_at'] == null || target['read_at'].toString().isEmpty);
    final nowIso = DateTime.now().toIso8601String();

    if (target.isNotEmpty && target['user_id'] == null) {
      final userId = _getCurrentUserId();
      final storage = ref.read(appStorageProvider);
      final ids = getReadOrgNotifIds(userId, storage: storage);
      ids.add(strId);
      persistReadOrgNotifIds(userId, ids, storage: storage);
    }

    final updatedNotifications = state.notifications.map((n) {
      if (n['id']?.toString() == strId) {
        return {...n, 'read_at': n['read_at'] ?? nowIso};
      }
      return n;
    }).toList();

    state = state.copyWith(
      notifications: updatedNotifications,
      unreadCount: wasUnread ? math.max(0, state.unreadCount - 1) : state.unreadCount,
    );

    try {
      final service = ref.read(notificationsServiceProvider);
      await service.markRead(id);
    } catch (_) {
      // ignore
    }
  }

  /// Marks all notifications as read, including any additional org-broadcast rows provided.
  Future<void> markAllAsRead([List<Map<String, dynamic>> extraRows = const []]) async {
    final userId = _getCurrentUserId();
    final storage = ref.read(appStorageProvider);

    final combined = [...state.notifications, ...extraRows];
    final orgNotifIds = combined
        .where((n) => n['user_id'] == null && n['id'] != null)
        .map((n) => n['id'].toString())
        .toList();

    if (orgNotifIds.isNotEmpty) {
      final ids = getReadOrgNotifIds(userId, storage: storage);
      ids.addAll(orgNotifIds);
      persistReadOrgNotifIds(userId, ids, storage: storage);
    }

    final nowIso = DateTime.now().toIso8601String();
    final updatedNotifications = state.notifications.map((n) {
      return {...n, 'read_at': n['read_at'] ?? nowIso};
    }).toList();

    state = state.copyWith(
      notifications: updatedNotifications,
      unreadCount: 0,
    );

    try {
      final service = ref.read(notificationsServiceProvider);
      await service.markAllRead();
    } catch (_) {
      // ignore
    }
  }

  /// Resets notification state to blank.
  void reset() {
    state = const NotificationState();
  }
}

/// Riverpod provider for notification state and operations.
final notificationProvider = NotifierProvider<NotificationNotifier, NotificationState>(
  NotificationNotifier.new,
);
