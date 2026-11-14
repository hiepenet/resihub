import 'dart:convert';
import 'dart:math' as math;
import 'package:shared_preferences/shared_preferences.dart';

import '../storage/app_storage.dart';

final RegExp _kUuidRegex = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);

const List<String> kNotificationTriggerParams = [
  'modal',
  'invoice_id',
  'payment_id',
  'credit_id',
  'deposit_id',
  'request_id',
  'subscription_id',
  'reservation_id',
  'target_contract_id',
];

bool _isValidId(dynamic val) {
  if (val == null) return false;
  final s = val.toString().trim();
  return _kUuidRegex.hasMatch(s);
}

Map<String, dynamic> _parsePayload(dynamic raw) {
  if (raw == null) return {};
  if (raw is Map<String, dynamic>) return raw;
  if (raw is Map) return Map<String, dynamic>.from(raw);
  if (raw is String) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) return decoded;
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {
      return {};
    }
  }
  return {};
}

String _buildUrl(String basePath, List<(String, dynamic)> entries) {
  final queryParts = <String>[];
  for (final (k, v) in entries) {
    if (v != null && v.toString().trim().isNotEmpty) {
      final valStr = Uri.encodeComponent(v.toString().trim());
      final keyStr = Uri.encodeComponent(k.trim());
      queryParts.add('$keyStr=$valStr');
    }
  }
  final qs = queryParts.join('&');
  return qs.isNotEmpty ? '$basePath?$qs' : basePath;
}

/// Removes modal deep-link trigger parameters from a query params map.
Map<String, String> stripNotificationTriggerParams(Map<String, String> params) {
  final copy = Map<String, String>.from(params);
  for (final key in kNotificationTriggerParams) {
    copy.remove(key);
  }
  return copy;
}

/// Picks the targeted item from a list or falls back to the first available element.
Map<String, dynamic>? pickDeepLinkTarget(
  List<Map<String, dynamic>>? list,
  dynamic targetId, {
  String Function(Map<String, dynamic> item)? getId,
  List<Map<String, dynamic>>? fallbackList,
}) {
  final items = list ?? const [];
  final cleanId = targetId?.toString().trim() ?? '';
  final getter = getId ?? ((item) => item['id']?.toString() ?? '');

  if (cleanId.isNotEmpty) {
    for (final item in items) {
      if (getter(item) == cleanId) return item;
    }
  }
  final fallbacks = fallbackList ?? items;
  return fallbacks.isNotEmpty ? fallbacks.first : null;
}

/// Syncs building filter before navigation if target building is accessible.
void syncBuildingFilterBeforeNavigate(
  String? targetBuildingId, {
  required String selectedBuildingId,
  required List<String> accessibleBuildingIds,
  required void Function(String newId) setSelectedBuildingId,
}) {
  if (targetBuildingId == null || targetBuildingId.isEmpty) return;
  if (selectedBuildingId == targetBuildingId) return;

  if (accessibleBuildingIds.contains(targetBuildingId)) {
    setSelectedBuildingId(targetBuildingId);
  } else {
    setSelectedBuildingId('');
  }
}

/// Key used to persist client-side read IDs for organization-wide broadcast notifications.
String readOrgNotifStorageKey(String? userId) {
  return 'resihub:read-org-notifs:${userId ?? 'anon'}';
}

/// Retrieves the set of locally marked read org-wide notification IDs.
Set<String> getReadOrgNotifIds(
  String? userId, {
  AppStorage? storage,
  SharedPreferences? prefs,
  Set<String>? mockReadOrgIds,
}) {
  if (mockReadOrgIds != null) return Set<String>.from(mockReadOrgIds);
  final p = prefs ?? storage?.prefs;
  if (p == null) return <String>{};
  final raw = p.getString(readOrgNotifStorageKey(userId));
  if (raw == null || raw.trim().isEmpty) return <String>{};
  try {
    final parsed = jsonDecode(raw);
    if (parsed is List) {
      return parsed.map((e) => e.toString()).toSet();
    }
  } catch (_) {}
  return <String>{};
}

/// Persists locally marked read org-wide notification IDs (keeps last 200).
void persistReadOrgNotifIds(
  String? userId,
  Set<String> ids, {
  AppStorage? storage,
  SharedPreferences? prefs,
}) {
  final p = prefs ?? storage?.prefs;
  if (p == null) return;
  try {
    final unique = ids.toList();
    final trimmed = unique.length > 200 ? unique.sublist(unique.length - 200) : unique;
    p.setString(readOrgNotifStorageKey(userId), jsonEncode(trimmed));
  } catch (_) {}
}

class NotificationReadMergeResult {
  final List<Map<String, dynamic>> notifications;
  final int unreadCount;

  const NotificationReadMergeResult({
    required this.notifications,
    required this.unreadCount,
  });
}

/// Merges local org-broadcast read status with server notification records.
NotificationReadMergeResult mergeOrgNotificationReadState(
  List<dynamic>? rows,
  String? userId, {
  AppStorage? storage,
  SharedPreferences? prefs,
  dynamic serverUnreadCount,
  Set<String>? mockReadOrgIds,
}) {
  final list = rows != null
      ? rows.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
      : <Map<String, dynamic>>[];
  final localReadIds = getReadOrgNotifIds(
    userId,
    storage: storage,
    prefs: prefs,
    mockReadOrgIds: mockReadOrgIds,
  );
  final nowIso = DateTime.now().toIso8601String();
  var locallyReadOrgCount = 0;

  final notifications = list.map((n) {
    if (n['user_id'] == null && (n['read_at'] == null || n['read_at'].toString().isEmpty)) {
      if (localReadIds.contains(n['id']?.toString())) {
        locallyReadOrgCount += 1;
        return {...n, 'read_at': nowIso};
      }
    }
    return n;
  }).toList();

  final listUnread = notifications.where((n) {
    final readAt = n['read_at']?.toString();
    return readAt == null || readAt.isEmpty;
  }).length;

  final num? sCount = serverUnreadCount is num
      ? serverUnreadCount
      : num.tryParse(serverUnreadCount?.toString() ?? '');

  final unreadCount = sCount != null
      ? math.max(listUnread, math.max(0, sCount.toInt() - locallyReadOrgCount))
      : listUnread;

  return NotificationReadMergeResult(
    notifications: notifications,
    unreadCount: unreadCount,
  );
}

enum NotificationActionKind {
  detailModal,
  navigate,
}

class NotificationActionResult {
  final NotificationActionKind kind;
  final String? url;
  final String? fallbackUrl;
  final String? buildingId;
  final String? contractId;
  final String actionLabel;

  const NotificationActionResult({
    required this.kind,
    this.url,
    this.fallbackUrl,
    this.buildingId,
    this.contractId,
    required this.actionLabel,
  });
}

const Set<String> _kBroadcastTypes = {
  'ANNOUNCEMENT',
  'UTILITY_INTERRUPTION',
  'MAINTENANCE_NOTICE',
  'HOUSE_RULES',
  'SECURITY_ALERT',
  'SYSTEM',
  'SYSTEM_NOTICE',
};

NotificationActionResult _detailModalResult({
  String? buildingId,
  String? contractId,
  String? fallbackUrl,
  String actionLabel = 'Xem chi tiết',
}) {
  return NotificationActionResult(
    kind: NotificationActionKind.detailModal,
    fallbackUrl: fallbackUrl,
    buildingId: buildingId,
    contractId: contractId,
    actionLabel: actionLabel,
  );
}

NotificationActionResult _navigateResult({
  required String url,
  String? buildingId,
  String? contractId,
  required String actionLabel,
}) {
  return NotificationActionResult(
    kind: NotificationActionKind.navigate,
    url: url,
    buildingId: buildingId,
    contractId: contractId,
    actionLabel: actionLabel,
  );
}

NotificationActionResult _resolveResidentAction(String type, Map<String, dynamic> p) {
  final cid = _isValidId(p['contract_id']) ? p['contract_id'].toString().trim() : null;
  final bid = _isValidId(p['building_id'])
      ? p['building_id'].toString().trim()
      : _isValidId(p['desired_building_id'])
          ? p['desired_building_id'].toString().trim()
          : null;
  final iid = _isValidId(p['invoice_id']) ? p['invoice_id'].toString().trim() : null;
  final crid = _isValidId(p['credit_id']) ? p['credit_id'].toString().trim() : null;
  final did = _isValidId(p['deposit_id']) ? p['deposit_id'].toString().trim() : null;
  final srid = _isValidId(p['service_request_id']) ? p['service_request_id'].toString().trim() : null;
  final subid = _isValidId(p['subscription_id']) ? p['subscription_id'].toString().trim() : null;
  final rsvid = _isValidId(p['reservation_id']) ? p['reservation_id'].toString().trim() : null;

  if (_kBroadcastTypes.contains(type)) {
    return _detailModalResult(buildingId: bid, contractId: cid, actionLabel: 'Xem thông báo');
  }

  // 1. Invoice payment group
  if (const ['INVOICE_ISSUED', 'PAYMENT_REMINDER', 'PAYMENT_REJECTED'].contains(type)) {
    if (iid == null && cid == null) {
      return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: '/resident?tab=invoices', actionLabel: 'Xem hóa đơn');
    }
    return _navigateResult(
      url: _buildUrl('/resident', [
        ('tab', 'invoices'),
        ('target_contract_id', cid),
        ('invoice_id', iid),
        ('modal', 'pay'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Thanh toán ngay',
    );
  }

  // 2. Invoice / Credit detail group
  if (const [
    'PAYMENT_CONFIRMED',
    'INVOICE_ADJUSTED',
    'INVOICE_ADJUSTMENT_PENDING',
    'INVOICE_VOIDED',
    'CREDIT_APPLIED',
    'CREDIT_REFUND_PENDING',
    'CREDIT_REFUNDED',
    'CREDIT_REFUND_REJECTED',
  ].contains(type)) {
    if (type.startsWith('CREDIT_') && crid != null && iid == null) {
      return _navigateResult(
        url: _buildUrl('/resident', [
          ('tab', 'invoices'),
          ('target_contract_id', cid),
          ('credit_id', crid),
          ('modal', 'credit'),
        ]),
        buildingId: bid,
        contractId: cid,
        actionLabel: 'Xem sổ tín dụng',
      );
    }
    if (iid != null) {
      return _navigateResult(
        url: _buildUrl('/resident', [
          ('tab', 'invoices'),
          ('target_contract_id', cid),
          ('invoice_id', iid),
          ('modal', 'detail'),
        ]),
        buildingId: bid,
        contractId: cid,
        actionLabel: 'Xem hóa đơn',
      );
    }
    if (crid != null) {
      return _navigateResult(
        url: _buildUrl('/resident', [
          ('tab', 'invoices'),
          ('target_contract_id', cid),
          ('credit_id', crid),
          ('modal', 'credit'),
        ]),
        buildingId: bid,
        contractId: cid,
        actionLabel: 'Xem sổ tín dụng',
      );
    }
    return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: '/resident?tab=invoices', actionLabel: 'Xem hóa đơn');
  }

  // 3. Deposit settlement statement / dispute group
  if (const ['SETTLEMENT_STATEMENT_READY', 'DISPUTE_RESOLVED', 'SETTLEMENT_REJECTED'].contains(type)) {
    return _navigateResult(
      url: _buildUrl('/resident', [
        ('tab', 'contract'),
        ('target_contract_id', cid),
        ('deposit_id', did),
        ('modal', 'settlement'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Xem bảng kê tất toán',
    );
  }

  // 4. Deposit refund bank account group
  if (const ['SETTLEMENT_APPROVED', 'SETTLEMENT_READY_FOR_PAYOUT', 'DEPOSIT_PAYOUT_RETURNED'].contains(type)) {
    return _navigateResult(
      url: _buildUrl('/resident', [
        ('tab', 'contract'),
        ('target_contract_id', cid),
        ('deposit_id', did),
        ('modal', 'bank'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Cập nhật TK nhận cọc',
    );
  }

  // 5. Contract expiry -> renew modal
  if (const ['CONTRACT_EXPIRY', 'CONTRACT_EXPIRING'].contains(type)) {
    if (cid == null) {
      return _detailModalResult(buildingId: bid, contractId: null, fallbackUrl: '/resident?tab=contract', actionLabel: 'Xem hợp đồng');
    }
    return _navigateResult(
      url: _buildUrl('/resident', [
        ('tab', 'contract'),
        ('target_contract_id', cid),
        ('modal', 'renew'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Gia hạn / Phản hồi',
    );
  }

  // 6. Contract view group
  if (const [
    'CONTRACT_ACTIVATED',
    'CONTRACT_TERMINATED',
    'CONTRACT_REQUEST_SUBMITTED',
    'CONTRACT_REQUEST_APPROVED',
    'CONTRACT_REQUEST_REJECTED',
    'CONTRACT_BILLING_SCHEDULED',
  ].contains(type)) {
    return _navigateResult(
      url: _buildUrl('/resident', [
        ('tab', 'contract'),
        ('target_contract_id', cid),
        ('modal', 'contract_view'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Xem hợp đồng',
    );
  }

  // 7. Deposit ledger view group
  if (const [
    'DEPOSIT_PAYOUT_COMPLETED',
    'DEPOSIT_PAYOUT_REISSUED',
    'DEPOSIT_WARNING_3D',
    'DEPOSIT_OVERDUE_5D',
    'DEPOSIT_SECURE',
  ].contains(type)) {
    if (did == null && cid == null) {
      return _detailModalResult(buildingId: bid, contractId: null, fallbackUrl: '/resident?tab=contract', actionLabel: 'Xem sổ cọc');
    }
    return _navigateResult(
      url: _buildUrl('/resident', [
        ('tab', 'contract'),
        ('target_contract_id', cid),
        ('deposit_id', did),
        ('modal', 'deposit_view'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Xem sổ cọc',
    );
  }

  // 8. Maintenance / Service requests
  if (type == 'MAINTENANCE_UPDATE' || type.startsWith('SERVICE_REQUEST_')) {
    return _navigateResult(
      url: _buildUrl('/resident', [
        ('tab', 'maintenance'),
        ('target_contract_id', cid),
        ('request_id', srid),
        ('modal', 'detail'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Xem tiến độ sửa chữa',
    );
  }

  // 9. Service subscriptions
  if (const [
    'SERVICE_UPDATE',
    'SERVICE_TERMINATED',
    'SERVICE_SUBSCRIPTION_REQUESTED',
    'SERVICE_CANCELLATION_REQUESTED',
  ].contains(type)) {
    return _navigateResult(
      url: _buildUrl('/resident', [
        ('tab', 'services'),
        ('target_contract_id', cid),
        ('subscription_id', subid),
        ('modal', 'detail'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Xem gói dịch vụ',
    );
  }

  // 10. Tenant onboarding / Reservations
  if (type == 'TENANT_APPLICATION_REJECTED') {
    return _navigateResult(
      url: _buildUrl('/resident', [
        ('tab', 'overview'),
        ('modal', 'apply'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Bổ sung lại hồ sơ',
    );
  }

  if (type == 'TENANT_APPLICATION_APPROVED' || type.startsWith('RESERVATION_')) {
    return _navigateResult(
      url: _buildUrl('/resident', [
        ('tab', 'overview'),
        ('reservation_id', rsvid),
        ('modal', 'reservation'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Xem hồ sơ / Giữ chỗ',
    );
  }

  return _detailModalResult(buildingId: bid, contractId: cid, actionLabel: 'Xem chi tiết');
}

NotificationActionResult _resolveAdminAction(String type, Map<String, dynamic> p, String role) {
  final normRole = role.toUpperCase();
  final bid = _isValidId(p['building_id'])
      ? p['building_id'].toString().trim()
      : _isValidId(p['desired_building_id'])
          ? p['desired_building_id'].toString().trim()
          : null;
  final aid = _isValidId(p['apartment_id'])
      ? p['apartment_id'].toString().trim()
      : _isValidId(p['desired_apartment_id'])
          ? p['desired_apartment_id'].toString().trim()
          : null;
  final cid = _isValidId(p['contract_id']) ? p['contract_id'].toString().trim() : null;
  final iid = _isValidId(p['invoice_id']) ? p['invoice_id'].toString().trim() : null;
  final pid = _isValidId(p['payment_id']) ? p['payment_id'].toString().trim() : null;
  final crid = _isValidId(p['credit_id']) ? p['credit_id'].toString().trim() : null;
  final did = _isValidId(p['deposit_id']) ? p['deposit_id'].toString().trim() : null;
  final srid = _isValidId(p['service_request_id']) ? p['service_request_id'].toString().trim() : null;
  final subid = _isValidId(p['subscription_id']) ? p['subscription_id'].toString().trim() : null;
  final rsvid = _isValidId(p['reservation_id']) ? p['reservation_id'].toString().trim() : null;
  final reqid = _isValidId(p['request_id']) ? p['request_id'].toString().trim() : null;
  final tid = _isValidId(p['tenant_id']) ? p['tenant_id'].toString().trim() : null;

  if (_kBroadcastTypes.contains(type)) {
    return _detailModalResult(buildingId: bid, contractId: cid, actionLabel: 'Xem thông báo');
  }

  // 1. Maintenance / Service requests
  if (type.startsWith('SERVICE_REQUEST_') || type == 'MAINTENANCE_UPDATE') {
    if (srid == null) {
      return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: '/admin/maintenance', actionLabel: 'Mở trang bảo trì');
    }
    return _navigateResult(
      url: _buildUrl('/admin/maintenance', [('request_id', srid)]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Xử lý phiếu bảo trì',
    );
  }

  // 2. Payment proof review
  if (type == 'PAYMENT_REPORTED' ||
      (const ['PAYMENT_CONFIRMED', 'PAYMENT_REJECTED'].contains(type) && pid != null)) {
    if (pid == null) {
      return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: '/admin/payments', actionLabel: 'Mở trang thanh toán');
    }
    return _navigateResult(
      url: _buildUrl('/admin/payments', [
        ('tab', 'transactions'),
        ('payment_id', pid),
        ('modal', 'review'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: normRole == 'MANAGER' ? 'Đối soát chứng từ' : 'Xem giao dịch',
    );
  }

  // 3. Credit refund 4-eyes
  if (const [
    'PENDING_CREDIT_REFUND',
    'CREDIT_REFUND_PENDING',
    'CREDIT_REFUNDED',
    'CREDIT_REFUND_REJECTED',
    'CREDIT_APPLIED',
  ].contains(type)) {
    if (crid == null) {
      return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: '/admin/payments?tab=credits', actionLabel: 'Mở sổ tín dụng');
    }
    return _navigateResult(
      url: _buildUrl('/admin/payments', [
        ('tab', 'credits'),
        ('credit_id', crid),
        ('modal', 'credit'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: type == 'PENDING_CREDIT_REFUND' ? 'Duyệt hoàn tín dụng' : 'Xem sổ tín dụng',
    );
  }

  // 4. Service subscription / cancellation requests
  if (const [
    'SERVICE_SUBSCRIPTION_REQUESTED',
    'SERVICE_CANCELLATION_REQUESTED',
    'SERVICE_UPDATE',
    'SERVICE_TERMINATED',
  ].contains(type)) {
    if (subid == null) {
      return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: '/admin/services/subscriptions', actionLabel: 'Mở đăng ký dịch vụ');
    }
    return _navigateResult(
      url: _buildUrl('/admin/services/subscriptions', [
        ('subscription_id', subid),
        ('modal', 'review'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: type == 'SERVICE_CANCELLATION_REQUESTED'
          ? 'Xử lý hủy dịch vụ'
          : normRole == 'MANAGER'
              ? 'Duyệt đăng ký dịch vụ'
              : 'Xem đăng ký dịch vụ',
    );
  }

  // 5. Invoices & 4-eyes invoice adjustments
  if (const [
    'INVOICE_ADJUSTMENT_PENDING',
    'INVOICE_ADJUSTED',
    'INVOICE_ISSUED',
    'INVOICE_VOIDED',
    'PAYMENT_REMINDER',
  ].contains(type)) {
    if (iid == null) {
      return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: '/admin/invoices', actionLabel: 'Mở danh sách hóa đơn');
    }
    return _navigateResult(
      url: _buildUrl('/admin/invoices/$iid', [('modal', 'auto')]),
      buildingId: bid,
      contractId: cid,
      actionLabel: type == 'INVOICE_ADJUSTMENT_PENDING' ? 'Duyệt điều chỉnh HĐ' : 'Xem hóa đơn',
    );
  }

  // 6. Contract renewal / termination requests
  if (const ['CONTRACT_REQUEST_SUBMITTED', 'CONTRACT_REQUEST_APPROVED', 'CONTRACT_REQUEST_REJECTED'].contains(type)) {
    if (reqid == null) {
      return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: '/admin/contracts?tab=requests', actionLabel: 'Mở yêu cầu hợp đồng');
    }
    return _navigateResult(
      url: _buildUrl('/admin/contracts', [
        ('tab', 'requests'),
        ('request_id', reqid),
        ('modal', 'request'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: normRole == 'MANAGER' ? 'Xử lý đề nghị HĐ' : 'Xem đề nghị HĐ',
    );
  }

  // 7. Contract detail & 4-eyes price/transfer approval
  if (const [
    'CONTRACT_PENDING_APPROVAL',
    'CONTRACT_PRICE_REJECTED',
    'CONTRACT_BILLING_SCHEDULED',
    'CONTRACT_EXPIRY',
    'CONTRACT_EXPIRING',
    'CONTRACT_ACTIVATED',
    'CONTRACT_TERMINATED',
  ].contains(type)) {
    if (cid == null) {
      return _detailModalResult(buildingId: bid, contractId: null, fallbackUrl: '/admin/contracts', actionLabel: 'Đi tới Hợp đồng');
    }
    return _navigateResult(
      url: _buildUrl('/admin/contracts/$cid', [('modal', 'auto')]),
      buildingId: bid,
      contractId: cid,
      actionLabel: type == 'CONTRACT_PENDING_APPROVAL' ? 'Phê duyệt hợp đồng' : 'Xem chi tiết hợp đồng',
    );
  }

  // 8. Deposits & settlements
  if (type.startsWith('SETTLEMENT_') || type.startsWith('DEPOSIT_') || type == 'DISPUTE_RESOLVED') {
    if (did == null) {
      return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: '/admin/deposits', actionLabel: 'Đi tới Tiền cọc');
    }
    return _navigateResult(
      url: _buildUrl('/admin/deposits', [
        ('deposit_id', did),
        ('modal', 'settlement'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: type == 'SETTLEMENT_PENDING_APPROVAL' ? 'Phê duyệt tất toán cọc' : 'Xử lý sổ cọc',
    );
  }

  // 9. Apartment reservations
  if (type == 'PUBLIC_RESERVATION_PENDING_CONFIRM' || type.startsWith('RESERVATION_')) {
    if (aid == null) {
      return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: '/admin/buildings', actionLabel: 'Đi tới Căn hộ');
    }
    return _navigateResult(
      url: _buildUrl('/admin/apartments/$aid', [
        ('reservation_id', rsvid),
        ('modal', 'reservation'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: type == 'RESERVATION_CANCEL_PENDING_APPROVAL' ? 'Duyệt hủy giữ chỗ' : 'Xử lý phiếu giữ chỗ',
    );
  }

  // 10. Tenant onboarding applications
  if (type.startsWith('TENANT_APPLICATION')) {
    if (tid == null) {
      return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: '/admin/tenants', actionLabel: 'Đi tới Cư dân');
    }
    return _navigateResult(
      url: _buildUrl('/admin/tenants/$tid', [('modal', 'approval')]),
      buildingId: bid,
      contractId: cid,
      actionLabel: normRole == 'MANAGER' ? 'Phê duyệt hồ sơ' : 'Xem hồ sơ cư dân',
    );
  }

  // 11. Missing meter readings
  if (const ['MISSING_METER_READING', 'METER_UNRECORDED', 'METER_UNRECORDED_ALERT'].contains(type)) {
    return _navigateResult(
      url: _buildUrl('/admin/meters', [
        ('period', p['period']),
        ('contract_id', cid),
        ('modal', 'record'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Ghi chỉ số điện nước',
    );
  }

  // 12. Monthly owner deposit report
  if (type == 'MONTHLY_DEPOSIT_REPORT') {
    dynamic fromDate = p['from_date'];
    dynamic toDate = p['to_date'];
    final link = p['link'];
    if ((fromDate == null || toDate == null) && link is String && link.contains('?')) {
      final uri = Uri.tryParse(link);
      if (uri != null) {
        fromDate ??= uri.queryParameters['from_date'];
        toDate ??= uri.queryParameters['to_date'];
      }
    }
    return _navigateResult(
      url: _buildUrl('/admin/reports', [
        ('tab', 'deposit-ledger'),
        ('building_id', bid),
        ('from_date', fromDate),
        ('to_date', toDate),
        ('modal', 'summary'),
      ]),
      buildingId: bid,
      contractId: cid,
      actionLabel: 'Xem báo cáo sổ cọc',
    );
  }

  // 13. System / AI / Cron alerts (RBAC gated to SYS_ADMIN only)
  if (const ['AI_BUDGET_WARNING', 'AI_BUDGET_EXCEEDED', 'CRON_JOB_FAILED'].contains(type)) {
    if (normRole != 'SYS_ADMIN') {
      return _detailModalResult(buildingId: bid, contractId: cid, actionLabel: 'Xem cảnh báo hệ thống');
    }
    final modalKind = type == 'CRON_JOB_FAILED' ? 'cron' : 'ai';
    return _navigateResult(
      url: _buildUrl('/admin/settings', [('modal', modalKind)]),
      buildingId: bid,
      contractId: cid,
      actionLabel: modalKind == 'ai' ? 'Kiểm tra hạn mức AI' : 'Kiểm tra tiến trình nền',
    );
  }

  final link = p['link'];
  final safeFallback = link is String && link.startsWith('/admin/') && !link.contains('/admin/settings') ? link : null;
  return _detailModalResult(buildingId: bid, contractId: cid, fallbackUrl: safeFallback, actionLabel: 'Xem chi tiết');
}

/// Resolves navigation or modal display actions for a notification object.
/// Full port of `frontend/src/utils/notificationNavigation.js:resolveNotificationAction`.
NotificationActionResult resolveNotificationAction(
  Map<String, dynamic>? notification, {
  String? role = 'RESIDENT',
  bool? isAdminPortal = false,
}) {
  if (notification == null) {
    return _detailModalResult(actionLabel: 'Xem chi tiết');
  }

  final type = (notification['type'] ?? 'SYSTEM').toString().trim().toUpperCase();
  final payload = _parsePayload(notification['payload']);
  final normRole = (role ?? 'RESIDENT').trim().toUpperCase();
  final useAdmin = (isAdminPortal == true) || const {'SYS_ADMIN', 'OWNER', 'MANAGER'}.contains(normRole);

  if (useAdmin && normRole != 'RESIDENT') {
    return _resolveAdminAction(type, payload, normRole);
  }
  return _resolveResidentAction(type, payload);
}
