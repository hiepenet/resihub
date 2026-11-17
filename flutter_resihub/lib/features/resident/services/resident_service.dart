import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/api_endpoints.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';
import '../../../core/utils/idempotency.dart';

/// Comprehensive Resident Portal Service.
/// Implements exact 22 methods matching `frontend/src/services/resident.service.js`.
class ResidentService {
  final Dio dio;
  final QueryCache? queryCache;

  ResidentService({required this.dio, this.queryCache});

  Map<String, dynamic>? _withContractParam(String? contractId) {
    if (contractId != null && contractId.isNotEmpty) {
      return {'contract_id': contractId};
    }
    return null;
  }

  // 1. Get overview
  dynamic peekOverview([String? contractId]) =>
      queryCache?.peek<dynamic>('resident:overview:${contractId ?? ''}')?.data;

  Future<dynamic> getOverview([String? contractId, Options? options]) {
    if (queryCache != null) {
      final key = 'resident:overview:${contractId ?? ''}';
      return queryCache!.cachedFetch<dynamic>(
        key,
        () => dio
            .get<dynamic>(
              '${ApiEndpoints.resident}/overview',
              queryParameters: _withContractParam(contractId),
              options: options,
            )
            .then((r) => r.data),
        ttl: const Duration(seconds: 30),
      );
    }
    return dio
        .get<dynamic>(
          '${ApiEndpoints.resident}/overview',
          queryParameters: _withContractParam(contractId),
          options: options,
        )
        .then((r) => r.data);
  }

  // 2. Submit rental application
  Future<dynamic> submitRentalApplication(dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.resident}/rental-application',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 3. Upload ID card image
  Future<dynamic> uploadIdImage(dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.resident}/id-images',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 4. List service requests
  dynamic peekServiceRequests([String? contractId]) =>
      queryCache?.peek<dynamic>('resident:service-requests:${contractId ?? ''}')?.data;

  Future<dynamic> listServiceRequests([String? contractId, Options? options]) {
    if (queryCache != null) {
      final key = 'resident:service-requests:${contractId ?? ''}';
      return queryCache!.cachedFetch<dynamic>(
        key,
        () => dio
            .get<dynamic>(
              '${ApiEndpoints.resident}/service-requests',
              queryParameters: _withContractParam(contractId),
              options: options,
            )
            .then((r) => r.data),
        ttl: const Duration(seconds: 30),
      );
    }
    return dio
        .get<dynamic>(
          '${ApiEndpoints.resident}/service-requests',
          queryParameters: _withContractParam(contractId),
          options: options,
        )
        .then((r) => r.data);
  }

  // 5. Create service request
  Future<dynamic> createServiceRequest(
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.resident}/service-requests',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 6. Cancel service request
  Future<dynamic> cancelServiceRequest(
    String id, [
    dynamic payload = const {},
    dynamic optionsOrKey,
    String? idempotencyKey,
  ]) {
    Options? opts;
    String? idemKey = idempotencyKey;
    if (optionsOrKey is Options) {
      opts = optionsOrKey;
    } else if (optionsOrKey is String) {
      idemKey ??= optionsOrKey;
    } else if (optionsOrKey is Map) {
      idemKey ??= optionsOrKey['idempotencyKey']?.toString();
    }
    return dio
        .post<dynamic>(
          '${ApiEndpoints.resident}/service-requests/$id/cancel',
          data: payload ?? const {},
          options: withIdempotencyOptions(opts, idempotencyKey: idemKey),
        )
        .then((r) => r.data);
  }

  // 7. Reopen service request
  Future<dynamic> reopenServiceRequest(
    String id,
    dynamic payload, [
    dynamic optionsOrKey,
    String? idempotencyKey,
  ]) {
    Options? opts;
    String? idemKey = idempotencyKey;
    if (optionsOrKey is Options) {
      opts = optionsOrKey;
    } else if (optionsOrKey is String) {
      idemKey ??= optionsOrKey;
    } else if (optionsOrKey is Map) {
      idemKey ??= optionsOrKey['idempotencyKey']?.toString();
    }
    return dio
        .post<dynamic>(
          '${ApiEndpoints.resident}/service-requests/$id/reopen',
          data: payload,
          options: withIdempotencyOptions(opts, idempotencyKey: idemKey),
        )
        .then((r) => r.data);
  }

  // 8. Rate service request
  Future<dynamic> rateServiceRequest(
    String id,
    dynamic payload, [
    dynamic optionsOrKey,
    String? idempotencyKey,
  ]) {
    Options? opts;
    String? idemKey = idempotencyKey;
    if (optionsOrKey is Options) {
      opts = optionsOrKey;
    } else if (optionsOrKey is String) {
      idemKey ??= optionsOrKey;
    } else if (optionsOrKey is Map) {
      idemKey ??= optionsOrKey['idempotencyKey']?.toString();
    }
    return dio
        .post<dynamic>(
          '${ApiEndpoints.resident}/service-requests/$id/rating',
          data: payload,
          options: withIdempotencyOptions(opts, idempotencyKey: idemKey),
        )
        .then((r) => r.data);
  }

  // 9. List invoices
  Future<dynamic> listInvoices([String? contractId, Options? options]) {
    if (queryCache != null && options == null) {
      final key = 'resident:invoices:${contractId ?? ''}';
      return queryCache!.cachedFetch<dynamic>(
        key,
        () => dio
            .get<dynamic>(
              '${ApiEndpoints.resident}/invoices',
              queryParameters: _withContractParam(contractId),
              options: options,
            )
            .then((r) => r.data),
        ttl: const Duration(seconds: 30),
      );
    }
    return dio
        .get<dynamic>(
          '${ApiEndpoints.resident}/invoices',
          queryParameters: _withContractParam(contractId),
          options: options,
        )
        .then((r) => r.data);
  }

  // 10. Report payment
  Future<dynamic> reportPayment(dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.resident}/payments/report',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 11. List services
  Future<dynamic> listServices([String? contractId, Options? options]) {
    if (queryCache != null && options == null) {
      final key = 'resident:services:${contractId ?? ''}';
      return queryCache!.cachedFetch<dynamic>(
        key,
        () => dio
            .get<dynamic>(
              '${ApiEndpoints.resident}/services',
              queryParameters: _withContractParam(contractId),
              options: options,
            )
            .then((r) => r.data),
        ttl: const Duration(seconds: 30),
      );
    }
    return dio
        .get<dynamic>(
          '${ApiEndpoints.resident}/services',
          queryParameters: _withContractParam(contractId),
          options: options,
        )
        .then((r) => r.data);
  }

  // 12. Subscribe service
  Future<dynamic> subscribeService(dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.resident}/services',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 13. Cancel service
  Future<dynamic> cancelService(String id, [dynamic payload = const {}, Options? options]) {
    return dio
        .patch<dynamic>(
          '${ApiEndpoints.resident}/services/$id/cancel',
          data: payload ?? const {},
          options: options,
        )
        .then((r) => r.data);
  }

  // 14. Withdraw cancel service
  Future<dynamic> withdrawCancelService(String id, {Options? options}) {
    return dio
        .patch<dynamic>(
          '${ApiEndpoints.resident}/services/$id/withdraw-cancel',
          options: options,
        )
        .then((r) => r.data);
  }

  // 15. Update profile
  Future<dynamic> updateProfile(dynamic payload, {Options? options}) {
    return dio
        .patch<dynamic>(
          '${ApiEndpoints.resident}/profile',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 16. List contract requests
  Future<dynamic> listContractRequests([String? contractId, Options? options]) {
    return dio
        .get<dynamic>(
          '${ApiEndpoints.resident}/contract-requests',
          queryParameters: _withContractParam(contractId),
          options: options,
        )
        .then((r) => r.data);
  }

  // 17. Create contract request
  Future<dynamic> createContractRequest(dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.resident}/contract-requests',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 18. List deposit transactions
  Future<dynamic> listDepositTransactions([String? contractId, Options? options]) {
    return dio
        .get<dynamic>(
          '${ApiEndpoints.resident}/deposit-transactions',
          queryParameters: _withContractParam(contractId),
          options: options,
        )
        .then((r) => r.data);
  }

  // 19. Dispute deposit
  Future<dynamic> disputeDeposit(
    String depositId,
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.deposits}/$depositId/dispute',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 20. Update deposit refund bank info
  Future<dynamic> updateDepositRefundBankInfo(
    String depositId,
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .patch<dynamic>(
          '${ApiEndpoints.deposits}/$depositId/bank-info',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 21. Update reservation refund bank info
  Future<dynamic> updateReservationRefundBankInfo(
    String reservationId,
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .patch<dynamic>(
          '${ApiEndpoints.reservations}/$reservationId/bank-info',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 22. Get deposit settlement PDF HTML
  Future<String> getDepositSettlementPdfHtml(String depositId, {Options? options}) {
    final opts = (options?.copyWith() ?? Options()).copyWith(
      responseType: ResponseType.plain,
    );
    return dio
        .get<String>(
          '${ApiEndpoints.deposits}/$depositId/settlement/pdf',
          options: opts,
        )
        .then((r) => r.data ?? '');
  }
}

/// Riverpod provider for [ResidentService].
final residentServiceProvider = Provider<ResidentService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return ResidentService(dio: dio, queryCache: queryCache);
});
