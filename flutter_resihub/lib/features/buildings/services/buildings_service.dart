import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/api_endpoints.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';

const Duration kBuildingsTtl = Duration(milliseconds: 25000);
const Duration kPolicyTtl = Duration(milliseconds: 120000);
const Duration kBanksTtl = Duration(milliseconds: 300000);

/// Buildings, Floors, Zones, Apartments & Reservations Service.
/// Port of `frontend/src/services/buildings.service.js`.
class BuildingsService {
  final Dio dio;
  final QueryCache? queryCache;

  BuildingsService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kBuildingsTtl,
    bool force = false,
  }) {
    if (queryCache != null) {
      return queryCache!.cachedFetch<T>(logicalKey, fetcher, ttl: ttl, force: force);
    }
    return fetcher();
  }

  // ---------------------------------------------------------------------------
  // Buildings (10 methods + peek helpers)
  // ---------------------------------------------------------------------------

  dynamic peekList() =>
      queryCache?.peek<dynamic>(buildCacheKey('buildings', {'op': 'list'}))?.data;

  Future<dynamic> list({bool force = false}) {
    return _cachedFetch(
      buildCacheKey('buildings', {'op': 'list'}),
      () => dio.get<dynamic>(ApiEndpoints.buildings).then((r) => r.data),
      ttl: kBuildingsTtl,
      force: force,
    );
  }

  dynamic peekById(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('buildings', {'op': 'detail', 'id': id}))?.data
          : null;

  Future<dynamic> getById(String id, {bool force = false}) {
    return _cachedFetch(
      buildCacheKey('buildings', {'op': 'detail', 'id': id}),
      () => dio.get<dynamic>('${ApiEndpoints.buildings}/$id').then((r) => r.data),
      ttl: kBuildingsTtl,
      force: force,
    );
  }

  Future<dynamic> checkCode(String code) {
    return dio.get<dynamic>('${ApiEndpoints.buildings}/check-code', queryParameters: {'code': code}).then((r) => r.data);
  }

  Future<dynamic> lookupOwner(String identifier) {
    return dio.get<dynamic>('${ApiEndpoints.buildings}/lookup-owner', queryParameters: {'identifier': identifier}).then((r) => r.data);
  }

  Future<dynamic> listOwners() {
    return dio.get<dynamic>('${ApiEndpoints.buildings}/owners').then((r) => r.data);
  }

  Future<dynamic> listBanks() {
    return _cachedFetch(
      buildCacheKey('buildings', {'op': 'banks'}),
      () => dio.get<dynamic>('${ApiEndpoints.buildings}/banks').then((r) => r.data),
      ttl: kBanksTtl,
    );
  }

  Future<dynamic> create(Map<String, dynamic> payload) {
    return dio.post<dynamic>(ApiEndpoints.buildings, data: payload).then((r) => r.data);
  }

  Future<dynamic> update(String id, Map<String, dynamic> payload) {
    return dio.patch<dynamic>('${ApiEndpoints.buildings}/$id', data: payload).then((r) => r.data);
  }

  Future<dynamic> remove(String id) {
    return dio.delete<dynamic>('${ApiEndpoints.buildings}/$id').then((r) => r.data);
  }

  Future<dynamic> updateStatus(String id, String status) {
    return dio.patch<dynamic>('${ApiEndpoints.buildings}/$id/status', data: {'status': status}).then((r) => r.data);
  }

  // ---------------------------------------------------------------------------
  // FloorMap & Floors (7 methods + peek helpers)
  // ---------------------------------------------------------------------------

  dynamic peekFloorMap(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('buildings', {'op': 'floorMap', 'id': id}))?.data
          : null;

  Future<dynamic> getFloorMap(String id, {bool force = false}) {
    return _cachedFetch(
      buildCacheKey('buildings', {'op': 'floorMap', 'id': id}),
      () => dio.get<dynamic>('${ApiEndpoints.buildings}/$id/floor-map').then((r) => r.data),
      ttl: kBuildingsTtl,
      force: force,
    );
  }

  dynamic peekFloors(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('buildings', {'op': 'floors', 'id': id}))?.data
          : null;

  Future<dynamic> listFloors(String id, {bool force = false}) {
    return _cachedFetch(
      buildCacheKey('buildings', {'op': 'floors', 'id': id}),
      () => dio.get<dynamic>('${ApiEndpoints.buildings}/$id/floors').then((r) => r.data),
      ttl: kBuildingsTtl,
      force: force,
    );
  }

  Future<dynamic> createFloor(String id, Map<String, dynamic> payload) {
    return dio.post<dynamic>('${ApiEndpoints.buildings}/$id/floors', data: payload).then((r) => r.data);
  }

  Future<dynamic> previewFloorsBulk(String id, Map<String, dynamic> payload) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.buildings}/$id/floors/bulk',
          data: {...payload, 'dry_run': true},
          options: Options(extra: {'skipCacheInvalidation': true}),
        )
        .then((r) => r.data);
  }

  Future<dynamic> createFloorsBulk(String id, Map<String, dynamic> payload) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.buildings}/$id/floors/bulk',
          data: {...payload, 'dry_run': false},
        )
        .then((r) => r.data);
  }

  Future<dynamic> updateFloor(String id, String floorId, Map<String, dynamic> payload) {
    return dio.patch<dynamic>('${ApiEndpoints.buildings}/$id/floors/$floorId', data: payload).then((r) => r.data);
  }

  Future<dynamic> deleteFloor(String id, String floorId) {
    return dio.delete<dynamic>('${ApiEndpoints.buildings}/$id/floors/$floorId').then((r) => r.data);
  }

  // ---------------------------------------------------------------------------
  // Zones (4 methods + peek helpers)
  // ---------------------------------------------------------------------------

  dynamic peekZones(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('buildings', {'op': 'zones', 'id': id}))?.data
          : null;

  Future<dynamic> listZones(String id, {bool force = false}) {
    return _cachedFetch(
      buildCacheKey('buildings', {'op': 'zones', 'id': id}),
      () => dio.get<dynamic>('${ApiEndpoints.buildings}/$id/zones').then((r) => r.data),
      ttl: kBuildingsTtl,
      force: force,
    );
  }

  Future<dynamic> createZone(String id, Map<String, dynamic> payload) {
    return dio.post<dynamic>('${ApiEndpoints.buildings}/$id/zones', data: payload).then((r) => r.data);
  }

  Future<dynamic> updateZone(String id, String zoneId, Map<String, dynamic> payload) {
    return dio.patch<dynamic>('${ApiEndpoints.buildings}/$id/zones/$zoneId', data: payload).then((r) => r.data);
  }

  Future<dynamic> deleteZone(String id, String zoneId) {
    return dio.delete<dynamic>('${ApiEndpoints.buildings}/$id/zones/$zoneId').then((r) => r.data);
  }

  // ---------------------------------------------------------------------------
  // Apartments (8 methods + peek helpers)
  // ---------------------------------------------------------------------------

  dynamic peekApartments([Map<String, dynamic>? params]) =>
      queryCache
          ?.peek<dynamic>(buildCacheKey('apartments', {'op': 'list', ...(params ?? {})}))
          ?.data;

  Future<dynamic> listApartments([Map<String, dynamic>? params, bool force = false]) {
    return _cachedFetch(
      buildCacheKey('apartments', {'op': 'list', ...(params ?? {})}),
      () => dio.get<dynamic>(ApiEndpoints.apartments, queryParameters: params).then((r) => r.data),
      ttl: kBuildingsTtl,
      force: force,
    );
  }

  dynamic peekApartment(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('apartments', {'op': 'detail', 'id': id}))?.data
          : null;

  Future<dynamic> getApartment(String id, {bool force = false}) {
    return _cachedFetch(
      buildCacheKey('apartments', {'op': 'detail', 'id': id}),
      () => dio.get<dynamic>('${ApiEndpoints.apartments}/$id').then((r) => r.data),
      ttl: kBuildingsTtl,
      force: force,
    );
  }

  Future<dynamic> createApartment(Map<String, dynamic> payload) {
    return dio.post<dynamic>(ApiEndpoints.apartments, data: payload).then((r) => r.data);
  }

  Future<dynamic> previewApartmentsBulk(Map<String, dynamic> payload) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.apartments}/bulk',
          data: {...payload, 'dry_run': true},
          options: Options(extra: {'skipCacheInvalidation': true}),
        )
        .then((r) => r.data);
  }

  Future<dynamic> createApartmentsBulk(Map<String, dynamic> payload) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.apartments}/bulk',
          data: {...payload, 'dry_run': false},
        )
        .then((r) => r.data);
  }

  Future<dynamic> updateApartment(String id, Map<String, dynamic> payload) {
    return dio.patch<dynamic>('${ApiEndpoints.apartments}/$id', data: payload).then((r) => r.data);
  }

  Future<dynamic> deleteApartment(String id) {
    return dio.delete<dynamic>('${ApiEndpoints.apartments}/$id').then((r) => r.data);
  }

  Future<dynamic> handoverApartment(String id, [Map<String, dynamic>? payload]) {
    return dio.patch<dynamic>('${ApiEndpoints.apartments}/$id/handover', data: payload ?? {}).then((r) => r.data);
  }

  // ---------------------------------------------------------------------------
  // Reservations (12 methods + peek helpers)
  // ---------------------------------------------------------------------------

  dynamic peekReservations([Map<String, dynamic>? params]) =>
      queryCache
          ?.peek<dynamic>(buildCacheKey('reservations', {'op': 'list', ...(params ?? {})}))
          ?.data;

  Future<dynamic> listReservations([Map<String, dynamic>? params, bool force = false]) {
    return _cachedFetch(
      buildCacheKey('reservations', {'op': 'list', ...(params ?? {})}),
      () => dio.get<dynamic>(ApiEndpoints.reservations, queryParameters: params).then((r) => r.data),
      ttl: kBuildingsTtl,
      force: force,
    );
  }

  Future<dynamic> getReservationCancelPolicy({bool force = false}) {
    return _cachedFetch(
      buildCacheKey('reservations', {'op': 'cancelPolicy'}),
      () => dio.get<dynamic>('${ApiEndpoints.reservations}/cancel-policy').then((r) => r.data),
      ttl: kPolicyTtl,
      force: force,
    );
  }

  Future<dynamic> createReservation(Map<String, dynamic> payload, {Options? options}) {
    return dio.post<dynamic>(ApiEndpoints.reservations, data: payload, options: options).then((r) => r.data);
  }

  Future<dynamic> confirmReservationPayment(String id, [Map<String, dynamic>? payload, Options? options]) {
    return dio
        .patch<dynamic>('${ApiEndpoints.reservations}/$id/confirm-payment', data: payload ?? {}, options: options)
        .then((r) => r.data);
  }

  Future<dynamic> rejectReservationPayment(String id, Map<String, dynamic> payload, {Options? options}) {
    return dio
        .patch<dynamic>('${ApiEndpoints.reservations}/$id/reject-payment', data: payload, options: options)
        .then((r) => r.data);
  }

  Future<dynamic> cancelSettleReservation(String id, Map<String, dynamic> payload, {Options? options}) {
    return dio
        .patch<dynamic>('${ApiEndpoints.reservations}/$id/cancel-settle', data: payload, options: options)
        .then((r) => r.data);
  }

  Future<dynamic> approveReservationCancel(String id, [Map<String, dynamic>? payload, Options? options]) {
    return dio
        .post<dynamic>('${ApiEndpoints.reservations}/$id/cancel-approve', data: payload ?? {}, options: options)
        .then((r) => r.data);
  }

  Future<dynamic> rejectReservationCancel(String id, Map<String, dynamic> payload, {Options? options}) {
    return dio
        .post<dynamic>('${ApiEndpoints.reservations}/$id/cancel-reject', data: payload, options: options)
        .then((r) => r.data);
  }

  Future<dynamic> payoutReservationCancel(String id, Map<String, dynamic> payload, {Options? options}) {
    return dio
        .post<dynamic>('${ApiEndpoints.reservations}/$id/cancel-payout', data: payload, options: options)
        .then((r) => r.data);
  }

  Future<dynamic> updateReservationBankInfo(String id, Map<String, dynamic> payload, {Options? options}) {
    return dio
        .patch<dynamic>('${ApiEndpoints.reservations}/$id/bank-info', data: payload, options: options)
        .then((r) => r.data);
  }

  Future<dynamic> forfeitReservation(String id, Map<String, dynamic> payload, {Options? options}) {
    return dio
        .patch<dynamic>('${ApiEndpoints.reservations}/$id/forfeit', data: payload, options: options)
        .then((r) => r.data);
  }

  Future<dynamic> refundReservation(String id, Map<String, dynamic> payload, {Options? options}) {
    return dio
        .patch<dynamic>('${ApiEndpoints.reservations}/$id/refund', data: payload, options: options)
        .then((r) => r.data);
  }
}

/// Provider for [BuildingsService].
final buildingsServiceProvider = Provider<BuildingsService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return BuildingsService(dio: dio, queryCache: queryCache);
});
