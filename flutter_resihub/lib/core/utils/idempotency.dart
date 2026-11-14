import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';

const _uuid = Uuid();

/// Tạo chuỗi UUID v4 dùng làm Idempotency-Key cho các request nhạy cảm (thanh toán, phiếu thu, gia hạn).
String createIdempotencyKey() => _uuid.v4();

/// Gắn header `Idempotency-Key` vào map options.
Map<String, dynamic> withIdempotency([Map<String, dynamic>? options]) {
  final opts = options != null ? Map<String, dynamic>.from(options) : <String, dynamic>{};
  final headers = opts['headers'] != null
      ? Map<String, dynamic>.from(opts['headers'] as Map)
      : <String, dynamic>{};
  final idempotencyKey = opts['idempotencyKey']?.toString() ?? createIdempotencyKey();
  headers['Idempotency-Key'] = idempotencyKey;
  opts['headers'] = headers;
  return opts;
}

/// Gắn header `Idempotency-Key` vào Dio `Options`.
Options withIdempotencyOptions(Options? options, {String? idempotencyKey}) {
  final opts = options ?? Options();
  final headers = Map<String, dynamic>.from(opts.headers ?? {});
  headers['Idempotency-Key'] = idempotencyKey ?? createIdempotencyKey();
  return opts.copyWith(headers: headers);
}

/// Kiểm tra điều kiện có thể thu thêm tiền cọc bổ sung cho phiếu giữ chỗ.
bool canCollectAdditionalDeposit(dynamic row) {
  if (row == null) return false;
  final status = row is Map ? row['status']?.toString() : (row as dynamic).status?.toString();
  if (status != 'HELD') return false;

  final contractStatus = row is Map
      ? row['contract_status']?.toString()
      : (row as dynamic).contract_status?.toString();
  const allowedContractStatuses = {'ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING'};
  if (!allowedContractStatuses.contains(contractStatus)) {
    return false;
  }

  final depositVal = row is Map ? row['deposit_amount'] : (row as dynamic).deposit_amount;
  final heldVal = row is Map ? row['amount_held'] : (row as dynamic).amount_held;

  final reqAmount = (depositVal is num ? depositVal : num.tryParse(depositVal?.toString() ?? '')) ?? 0;
  final heldAmount = (heldVal is num ? heldVal : num.tryParse(heldVal?.toString() ?? '')) ?? 0;

  return reqAmount > 0 && reqAmount > heldAmount;
}
