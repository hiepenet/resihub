import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/utils/idempotency.dart';

/// Service for managing resident announcements, templates, and Zalo groups.
/// Matches all 10 canonical methods of `frontend/src/services/announcements.service.js`.
class AnnouncementsService {
  final Dio dio;

  AnnouncementsService(this.dio);

  /// 1. GET /api/v1/announcements/templates
  Future<dynamic> listTemplates() {
    return dio.get<dynamic>('/api/v1/announcements/templates').then((r) => r.data);
  }

  /// 2. GET /api/v1/announcements
  Future<dynamic> listAnnouncements([Map<String, dynamic>? params]) {
    return dio
        .get<dynamic>('/api/v1/announcements', queryParameters: params)
        .then((r) => r.data);
  }

  /// 3. POST /api/v1/announcements
  Future<dynamic> createAnnouncement(Map<String, dynamic> payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/announcements',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  /// 4. PUT /api/v1/announcements/:id (Strictly HTTP PUT!)
  Future<dynamic> updateAnnouncement(
    dynamic id,
    Map<String, dynamic> payload, {
    Options? options,
  }) {
    return dio
        .put<dynamic>(
          '/api/v1/announcements/$id',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  /// 5. POST /api/v1/announcements/:id/send
  Future<dynamic> sendAnnouncement(
    dynamic id, [
    Map<String, dynamic>? payload,
    Options? options,
  ]) {
    final body = payload ?? const {'confirm_send': true};
    return dio
        .post<dynamic>(
          '/api/v1/announcements/$id/send',
          data: body,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  /// 6. POST /api/v1/announcements/:id/mark-zalo-sent
  Future<dynamic> markZaloSent(
    dynamic id, [
    Map<String, dynamic>? payload,
    Options? options,
  ]) {
    final body = payload ?? const {};
    return dio
        .post<dynamic>(
          '/api/v1/announcements/$id/mark-zalo-sent',
          data: body,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  /// 7. GET /api/v1/zalo-groups
  Future<dynamic> listZaloGroups([Map<String, dynamic>? params]) {
    return dio
        .get<dynamic>('/api/v1/zalo-groups', queryParameters: params)
        .then((r) => r.data);
  }

  /// 8. POST /api/v1/zalo-groups
  Future<dynamic> createZaloGroup(Map<String, dynamic> payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/zalo-groups',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  /// 9. PUT /api/v1/zalo-groups/:id (Strictly HTTP PUT!)
  Future<dynamic> updateZaloGroup(
    dynamic id,
    Map<String, dynamic> payload, {
    Options? options,
  }) {
    return dio
        .put<dynamic>(
          '/api/v1/zalo-groups/$id',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  /// 10. DELETE /api/v1/zalo-groups/:id
  Future<dynamic> deleteZaloGroup(dynamic id, {Options? options}) {
    return dio
        .delete<dynamic>('/api/v1/zalo-groups/$id', options: options)
        .then((r) => r.data);
  }
}

/// Provider for [AnnouncementsService].
final announcementsServiceProvider = Provider<AnnouncementsService>((ref) {
  final dio = ref.watch(dioProvider);
  return AnnouncementsService(dio);
});
