import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_client.dart';

/// Notifications Service.
/// Port of `frontend/src/services/notifications.service.js`.
class NotificationsService {
  final Dio dio;

  NotificationsService(this.dio);

  /// GET /api/v1/notifications
  Future<dynamic> list() {
    return dio.get<dynamic>('/api/v1/notifications').then((r) => r.data);
  }

  /// POST /api/v1/notifications
  Future<dynamic> send(Map<String, dynamic> payload, {Options? options}) {
    return dio.post<dynamic>('/api/v1/notifications', data: payload, options: options).then((r) => r.data);
  }

  /// PATCH /api/v1/notifications/:id/read
  Future<dynamic> markRead(dynamic id) {
    return dio.patch<dynamic>('/api/v1/notifications/$id/read').then((r) => r.data);
  }

  /// POST /api/v1/notifications/read-all
  Future<dynamic> markAllRead() {
    return dio.post<dynamic>('/api/v1/notifications/read-all').then((r) => r.data);
  }
}

/// Provider for [NotificationsService].
final notificationsServiceProvider = Provider<NotificationsService>((ref) {
  final dio = ref.watch(dioProvider);
  return NotificationsService(dio);
});
