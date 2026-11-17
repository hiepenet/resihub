import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/api_endpoints.dart';
import '../../../core/network/dio_client.dart';

/// Notifications Service.
/// Port of `frontend/src/services/notifications.service.js`.
class NotificationsService {
  final Dio dio;

  NotificationsService(this.dio);

  /// GET /api/v1/notifications
  Future<dynamic> list() {
    return dio.get<dynamic>(ApiEndpoints.notifications).then((r) => r.data);
  }

  /// POST /api/v1/notifications
  Future<dynamic> send(Map<String, dynamic> payload, {Options? options}) {
    return dio.post<dynamic>(ApiEndpoints.notifications, data: payload, options: options).then((r) => r.data);
  }

  /// PATCH /api/v1/notifications/:id/read
  Future<dynamic> markRead(dynamic id) {
    return dio.patch<dynamic>('${ApiEndpoints.notifications}/$id/read').then((r) => r.data);
  }

  /// POST /api/v1/notifications/read-all
  Future<dynamic> markAllRead() {
    return dio.post<dynamic>('${ApiEndpoints.notifications}/read-all').then((r) => r.data);
  }
}

/// Provider for [NotificationsService].
final notificationsServiceProvider = Provider<NotificationsService>((ref) {
  final dio = ref.watch(dioProvider);
  return NotificationsService(dio);
});
