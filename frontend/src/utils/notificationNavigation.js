const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NOTIFICATION_TRIGGER_PARAMS = [
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

function isValidId(val) {
  return typeof val === 'string' && UUID_RE.test(val.trim());
}

function parsePayload(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function buildUrl(basePath, entries) {
  const sp = new URLSearchParams();
  for (const [k, v] of entries) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      sp.set(k, String(v).trim());
    }
  }
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function stripNotificationTriggerParams(searchParams) {
  const next = new URLSearchParams(searchParams);
  for (const key of NOTIFICATION_TRIGGER_PARAMS) {
    next.delete(key);
  }
  return next;
}

export function readOrgNotifStorageKey(userId) {
  return `resihub:read-org-notifs:${userId || 'anon'}`;
}

export function getReadOrgNotifIds(userId, storage = globalThis?.localStorage) {
  if (!userId || !storage || typeof storage.getItem !== 'function') return new Set();
  try {
    const raw = storage.getItem(readOrgNotifStorageKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

export function persistReadOrgNotifIds(userId, ids, storage = globalThis?.localStorage) {
  if (!userId || !storage || typeof storage.setItem !== 'function') return;
  try {
    const unique = [...new Set([...ids].map(String))].slice(-200);
    storage.setItem(readOrgNotifStorageKey(userId), JSON.stringify(unique));
  } catch {
    // ignore storage quota errors
  }
}

export function mergeOrgNotificationReadState(
  rows = [],
  userId = null,
  storage = globalThis?.localStorage
) {
  const list = Array.isArray(rows) ? rows : [];
  const localReadIds = getReadOrgNotifIds(userId, storage);
  const nowIso = new Date().toISOString();

  const notifications = list.map((n) => {
    if (n && n.user_id == null && !n.read_at && localReadIds.has(String(n.id))) {
      return { ...n, read_at: nowIso };
    }
    return n;
  });

  const unreadCount = notifications.reduce((acc, n) => acc + (n?.read_at ? 0 : 1), 0);
  return { notifications, unreadCount };
}

const BROADCAST_TYPES = new Set([
  'ANNOUNCEMENT',
  'UTILITY_INTERRUPTION',
  'MAINTENANCE_NOTICE',
  'HOUSE_RULES',
  'SECURITY_ALERT',
  'SYSTEM',
  'SYSTEM_NOTICE',
]);

function detailModalResult(buildingId, contractId, fallbackUrl = null, actionLabel = 'Xem chi tiết') {
  return {
    kind: 'detail_modal',
    url: null,
    fallbackUrl,
    buildingId: buildingId || null,
    contractId: contractId || null,
    actionLabel,
  };
}

function navigateResult(url, buildingId, contractId, actionLabel) {
  return {
    kind: 'navigate',
    url,
    fallbackUrl: null,
    buildingId: buildingId || null,
    contractId: contractId || null,
    actionLabel,
  };
}

function resolveResidentAction(type, p) {
  const cid = isValidId(p.contract_id) ? p.contract_id.trim() : null;
  const bid = isValidId(p.building_id)
    ? p.building_id.trim()
    : isValidId(p.desired_building_id)
      ? p.desired_building_id.trim()
      : null;
  const iid = isValidId(p.invoice_id) ? p.invoice_id.trim() : null;
  const crid = isValidId(p.credit_id) ? p.credit_id.trim() : null;
  const did = isValidId(p.deposit_id) ? p.deposit_id.trim() : null;
  const srid = isValidId(p.service_request_id) ? p.service_request_id.trim() : null;
  const subid = isValidId(p.subscription_id) ? p.subscription_id.trim() : null;
  const rsvid = isValidId(p.reservation_id) ? p.reservation_id.trim() : null;

  if (BROADCAST_TYPES.has(type)) {
    return detailModalResult(bid, cid, null, 'Xem thông báo');
  }

  // 1. Invoice payment group
  if (['INVOICE_ISSUED', 'PAYMENT_REMINDER', 'PAYMENT_REJECTED'].includes(type)) {
    if (!iid && !cid) return detailModalResult(bid, cid, '/resident?tab=invoices', 'Xem hóa đơn');
    return navigateResult(
      buildUrl('/resident', [
        ['tab', 'invoices'],
        ['target_contract_id', cid],
        ['invoice_id', iid],
        ['modal', 'pay'],
      ]),
      bid,
      cid,
      'Thanh toán ngay'
    );
  }

  // 2. Invoice / Credit detail group
  if (
    [
      'PAYMENT_CONFIRMED',
      'INVOICE_ADJUSTED',
      'INVOICE_ADJUSTMENT_PENDING',
      'INVOICE_VOIDED',
      'CREDIT_APPLIED',
      'CREDIT_REFUND_PENDING',
      'CREDIT_REFUNDED',
      'CREDIT_REFUND_REJECTED',
    ].includes(type)
  ) {
    if (type.startsWith('CREDIT_') && crid && !iid) {
      return navigateResult(
        buildUrl('/resident', [
          ['tab', 'invoices'],
          ['target_contract_id', cid],
          ['credit_id', crid],
          ['modal', 'credit'],
        ]),
        bid,
        cid,
        'Xem sổ tín dụng'
      );
    }
    if (iid) {
      return navigateResult(
        buildUrl('/resident', [
          ['tab', 'invoices'],
          ['target_contract_id', cid],
          ['invoice_id', iid],
          ['modal', 'detail'],
        ]),
        bid,
        cid,
        'Xem hóa đơn'
      );
    }
    if (crid) {
      return navigateResult(
        buildUrl('/resident', [
          ['tab', 'invoices'],
          ['target_contract_id', cid],
          ['credit_id', crid],
          ['modal', 'credit'],
        ]),
        bid,
        cid,
        'Xem sổ tín dụng'
      );
    }
    return detailModalResult(bid, cid, '/resident?tab=invoices', 'Xem hóa đơn');
  }

  // 3. Deposit settlement statement / dispute group
  if (['SETTLEMENT_STATEMENT_READY', 'DISPUTE_RESOLVED', 'SETTLEMENT_REJECTED'].includes(type)) {
    return navigateResult(
      buildUrl('/resident', [
        ['tab', 'contract'],
        ['target_contract_id', cid],
        ['deposit_id', did],
        ['modal', 'settlement'],
      ]),
      bid,
      cid,
      'Xem bảng kê tất toán'
    );
  }

  // 4. Deposit refund bank account group
  if (
    ['SETTLEMENT_APPROVED', 'SETTLEMENT_READY_FOR_PAYOUT', 'DEPOSIT_PAYOUT_RETURNED'].includes(type)
  ) {
    return navigateResult(
      buildUrl('/resident', [
        ['tab', 'contract'],
        ['target_contract_id', cid],
        ['deposit_id', did],
        ['modal', 'bank'],
      ]),
      bid,
      cid,
      'Cập nhật TK nhận cọc'
    );
  }

  // 5. Contract expiry -> renew modal
  if (['CONTRACT_EXPIRY', 'CONTRACT_EXPIRING'].includes(type)) {
    if (!cid) return detailModalResult(bid, null, '/resident?tab=contract', 'Xem hợp đồng');
    return navigateResult(
      buildUrl('/resident', [
        ['tab', 'contract'],
        ['target_contract_id', cid],
        ['modal', 'renew'],
      ]),
      bid,
      cid,
      'Gia hạn / Phản hồi'
    );
  }

  // 6. Contract view group
  if (
    [
      'CONTRACT_ACTIVATED',
      'CONTRACT_TERMINATED',
      'CONTRACT_REQUEST_APPROVED',
      'CONTRACT_REQUEST_REJECTED',
      'CONTRACT_BILLING_SCHEDULED',
    ].includes(type)
  ) {
    return navigateResult(
      buildUrl('/resident', [
        ['tab', 'contract'],
        ['target_contract_id', cid],
        ['modal', 'contract_view'],
      ]),
      bid,
      cid,
      'Xem hợp đồng'
    );
  }

  // 7. Deposit ledger view group
  if (
    [
      'DEPOSIT_PAYOUT_COMPLETED',
      'DEPOSIT_PAYOUT_REISSUED',
      'DEPOSIT_WARNING_3D',
      'DEPOSIT_OVERDUE_5D',
      'DEPOSIT_SECURE',
    ].includes(type)
  ) {
    if (!did && !cid) return detailModalResult(bid, null, '/resident?tab=contract', 'Xem sổ cọc');
    return navigateResult(
      buildUrl('/resident', [
        ['tab', 'contract'],
        ['target_contract_id', cid],
        ['deposit_id', did],
        ['modal', 'deposit_view'],
      ]),
      bid,
      cid,
      'Xem sổ cọc'
    );
  }

  // 8. Maintenance / Service requests
  if (type === 'MAINTENANCE_UPDATE' || type.startsWith('SERVICE_REQUEST_')) {
    return navigateResult(
      buildUrl('/resident', [
        ['tab', 'maintenance'],
        ['target_contract_id', cid],
        ['request_id', srid],
        ['modal', 'detail'],
      ]),
      bid,
      cid,
      'Xem tiến độ sửa chữa'
    );
  }

  // 9. Service subscriptions
  if (['SERVICE_UPDATE', 'SERVICE_TERMINATED'].includes(type)) {
    return navigateResult(
      buildUrl('/resident', [
        ['tab', 'services'],
        ['target_contract_id', cid],
        ['subscription_id', subid],
        ['modal', 'detail'],
      ]),
      bid,
      cid,
      'Xem gói dịch vụ'
    );
  }

  // 10. Tenant onboarding / Reservations
  if (type === 'TENANT_APPLICATION_REJECTED') {
    return navigateResult(
      buildUrl('/resident', [
        ['tab', 'overview'],
        ['modal', 'apply'],
      ]),
      bid,
      cid,
      'Bổ sung lại hồ sơ'
    );
  }

  if (type === 'TENANT_APPLICATION_APPROVED' || type.startsWith('RESERVATION_')) {
    return navigateResult(
      buildUrl('/resident', [
        ['tab', 'overview'],
        ['reservation_id', rsvid],
        ['modal', 'reservation'],
      ]),
      bid,
      cid,
      'Xem hồ sơ / Giữ chỗ'
    );
  }

  return detailModalResult(bid, cid, null, 'Xem chi tiết');
}

function resolveAdminAction(type, p, role) {
  const normRole = String(role || 'MANAGER').toUpperCase();
  const bid = isValidId(p.building_id)
    ? p.building_id.trim()
    : isValidId(p.desired_building_id)
      ? p.desired_building_id.trim()
      : null;
  const aid = isValidId(p.apartment_id)
    ? p.apartment_id.trim()
    : isValidId(p.desired_apartment_id)
      ? p.desired_apartment_id.trim()
      : null;
  const cid = isValidId(p.contract_id) ? p.contract_id.trim() : null;
  const iid = isValidId(p.invoice_id) ? p.invoice_id.trim() : null;
  const pid = isValidId(p.payment_id) ? p.payment_id.trim() : null;
  const crid = isValidId(p.credit_id) ? p.credit_id.trim() : null;
  const did = isValidId(p.deposit_id) ? p.deposit_id.trim() : null;
  const srid = isValidId(p.service_request_id) ? p.service_request_id.trim() : null;
  const subid = isValidId(p.subscription_id) ? p.subscription_id.trim() : null;
  const rsvid = isValidId(p.reservation_id) ? p.reservation_id.trim() : null;
  const reqid = isValidId(p.request_id) ? p.request_id.trim() : null;
  const tid = isValidId(p.tenant_id) ? p.tenant_id.trim() : null;

  if (BROADCAST_TYPES.has(type)) {
    return detailModalResult(bid, cid, null, 'Xem thông báo');
  }

  // 1. Maintenance / Service requests
  if (type.startsWith('SERVICE_REQUEST_') || type === 'MAINTENANCE_UPDATE') {
    if (!srid) return detailModalResult(bid, cid, '/admin/maintenance', 'Mở trang bảo trì');
    return navigateResult(
      buildUrl('/admin/maintenance', [['request_id', srid]]),
      bid,
      cid,
      'Xử lý phiếu bảo trì'
    );
  }

  // 2. Payment proof review
  if (
    type === 'PAYMENT_REPORTED' ||
    (['PAYMENT_CONFIRMED', 'PAYMENT_REJECTED'].includes(type) && pid)
  ) {
    if (!pid) return detailModalResult(bid, cid, '/admin/payments', 'Mở trang thanh toán');
    return navigateResult(
      buildUrl('/admin/payments', [
        ['tab', 'transactions'],
        ['payment_id', pid],
        ['modal', 'review'],
      ]),
      bid,
      cid,
      normRole === 'MANAGER' ? 'Đối soát chứng từ' : 'Xem giao dịch'
    );
  }

  // 3. Credit refund 4-eyes
  if (
    [
      'PENDING_CREDIT_REFUND',
      'CREDIT_REFUND_PENDING',
      'CREDIT_REFUNDED',
      'CREDIT_REFUND_REJECTED',
      'CREDIT_APPLIED',
    ].includes(type)
  ) {
    if (!crid) return detailModalResult(bid, cid, '/admin/payments?tab=credits', 'Mở sổ tín dụng');
    return navigateResult(
      buildUrl('/admin/payments', [
        ['tab', 'credits'],
        ['credit_id', crid],
        ['modal', 'credit'],
      ]),
      bid,
      cid,
      type === 'PENDING_CREDIT_REFUND' ? 'Duyệt hoàn tín dụng' : 'Xem sổ tín dụng'
    );
  }

  // 4. Service subscription / cancellation requests
  if (
    [
      'SERVICE_SUBSCRIPTION_REQUESTED',
      'SERVICE_CANCELLATION_REQUESTED',
      'SERVICE_UPDATE',
      'SERVICE_TERMINATED',
    ].includes(type)
  ) {
    if (!subid) {
      return detailModalResult(bid, cid, '/admin/services/subscriptions', 'Mở đăng ký dịch vụ');
    }
    return navigateResult(
      buildUrl('/admin/services/subscriptions', [
        ['subscription_id', subid],
        ['modal', 'review'],
      ]),
      bid,
      cid,
      type === 'SERVICE_CANCELLATION_REQUESTED'
        ? 'Xử lý hủy dịch vụ'
        : normRole === 'MANAGER'
          ? 'Duyệt đăng ký dịch vụ'
          : 'Xem đăng ký dịch vụ'
    );
  }

  // 5. Invoices & 4-eyes invoice adjustments
  if (
    [
      'INVOICE_ADJUSTMENT_PENDING',
      'INVOICE_ADJUSTED',
      'INVOICE_ISSUED',
      'INVOICE_VOIDED',
      'PAYMENT_REMINDER',
    ].includes(type)
  ) {
    if (!iid) return detailModalResult(bid, cid, '/admin/invoices', 'Mở danh sách hóa đơn');
    return navigateResult(
      buildUrl(`/admin/invoices/${iid}`, [['modal', 'auto']]),
      bid,
      cid,
      type === 'INVOICE_ADJUSTMENT_PENDING' ? 'Duyệt điều chỉnh HĐ' : 'Xem hóa đơn'
    );
  }

  // 6. Contract renewal / termination requests
  if (
    ['CONTRACT_REQUEST_SUBMITTED', 'CONTRACT_REQUEST_APPROVED', 'CONTRACT_REQUEST_REJECTED'].includes(
      type
    )
  ) {
    if (!reqid) {
      return detailModalResult(bid, cid, '/admin/contracts?tab=requests', 'Mở yêu cầu hợp đồng');
    }
    return navigateResult(
      buildUrl('/admin/contracts', [
        ['tab', 'requests'],
        ['request_id', reqid],
        ['modal', 'request'],
      ]),
      bid,
      cid,
      normRole === 'MANAGER' ? 'Xử lý đề nghị HĐ' : 'Xem đề nghị HĐ'
    );
  }

  // 7. Contract detail & 4-eyes price/transfer approval
  if (
    [
      'CONTRACT_PENDING_APPROVAL',
      'CONTRACT_PRICE_REJECTED',
      'CONTRACT_BILLING_SCHEDULED',
      'CONTRACT_EXPIRY',
      'CONTRACT_EXPIRING',
      'CONTRACT_ACTIVATED',
      'CONTRACT_TERMINATED',
    ].includes(type)
  ) {
    if (!cid) return detailModalResult(bid, null, '/admin/contracts', 'Đi tới Hợp đồng');
    return navigateResult(
      buildUrl(`/admin/contracts/${cid}`, [['modal', 'auto']]),
      bid,
      cid,
      type === 'CONTRACT_PENDING_APPROVAL' ? 'Phê duyệt hợp đồng' : 'Xem chi tiết hợp đồng'
    );
  }

  // 8. Deposits & settlements
  if (
    type.startsWith('SETTLEMENT_') ||
    type.startsWith('DEPOSIT_') ||
    type === 'DISPUTE_RESOLVED'
  ) {
    if (!did) return detailModalResult(bid, cid, '/admin/deposits', 'Đi tới Tiền cọc');
    return navigateResult(
      buildUrl('/admin/deposits', [
        ['deposit_id', did],
        ['modal', 'settlement'],
      ]),
      bid,
      cid,
      type === 'SETTLEMENT_PENDING_APPROVAL' ? 'Phê duyệt tất toán cọc' : 'Xử lý sổ cọc'
    );
  }

  // 9. Apartment reservations
  if (type === 'PUBLIC_RESERVATION_PENDING_CONFIRM' || type.startsWith('RESERVATION_')) {
    if (!aid) return detailModalResult(bid, cid, '/admin/buildings', 'Đi tới Căn hộ');
    return navigateResult(
      buildUrl(`/admin/apartments/${aid}`, [
        ['reservation_id', rsvid],
        ['modal', 'reservation'],
      ]),
      bid,
      cid,
      type === 'RESERVATION_CANCEL_PENDING_APPROVAL'
        ? 'Duyệt hủy giữ chỗ'
        : 'Xử lý phiếu giữ chỗ'
    );
  }

  // 10. Tenant onboarding applications
  if (type.startsWith('TENANT_APPLICATION')) {
    if (!tid) return detailModalResult(bid, cid, '/admin/tenants', 'Đi tới Cư dân');
    return navigateResult(
      buildUrl(`/admin/tenants/${tid}`, [['modal', 'approval']]),
      bid,
      cid,
      normRole === 'MANAGER' ? 'Phê duyệt hồ sơ' : 'Xem hồ sơ cư dân'
    );
  }

  // 11. Missing meter readings
  if (type === 'MISSING_METER_READING') {
    return navigateResult(
      buildUrl('/admin/meters', [
        ['period', p.period],
        ['contract_id', cid],
        ['modal', 'record'],
      ]),
      bid,
      cid,
      'Ghi chỉ số điện nước'
    );
  }

  // 12. Monthly owner deposit report
  if (type === 'MONTHLY_DEPOSIT_REPORT') {
    let fromDate = p.from_date;
    let toDate = p.to_date;
    if ((!fromDate || !toDate) && typeof p.link === 'string' && p.link.includes('?')) {
      const linkSp = new URLSearchParams(p.link.split('?')[1]);
      fromDate = fromDate || linkSp.get('from_date');
      toDate = toDate || linkSp.get('to_date');
    }
    return navigateResult(
      buildUrl('/admin/reports', [
        ['tab', 'deposit-ledger'],
        ['building_id', bid],
        ['from_date', fromDate],
        ['to_date', toDate],
        ['modal', 'summary'],
      ]),
      bid,
      cid,
      'Xem báo cáo sổ cọc'
    );
  }

  // 13. System / AI / Cron alerts (RBAC gated to SYS_ADMIN only)
  if (['AI_BUDGET_WARNING', 'AI_BUDGET_EXCEEDED', 'CRON_JOB_FAILED'].includes(type)) {
    if (normRole !== 'SYS_ADMIN') {
      return detailModalResult(bid, cid, null, 'Xem cảnh báo hệ thống');
    }
    const modalKind = type === 'CRON_JOB_FAILED' ? 'cron' : 'ai';
    return navigateResult(
      buildUrl('/admin/settings', [['modal', modalKind]]),
      bid,
      cid,
      modalKind === 'ai' ? 'Kiểm tra hạn mức AI' : 'Kiểm tra tiến trình nền'
    );
  }

  const safeFallback =
    typeof p.link === 'string' && p.link.startsWith('/admin/') && !p.link.includes('/admin/settings')
      ? p.link
      : null;
  return detailModalResult(bid, cid, safeFallback, 'Xem chi tiết');
}

export function resolveNotificationAction(
  notification,
  { role = 'RESIDENT', isAdminPortal = false } = {}
) {
  if (!notification) {
    return detailModalResult(null, null, null, 'Xem chi tiết');
  }
  const type = String(notification.type || 'SYSTEM').trim().toUpperCase();
  const payload = parsePayload(notification.payload);
  const normRole = String(role || 'RESIDENT').trim().toUpperCase();
  const useAdmin = Boolean(isAdminPortal) || ['SYS_ADMIN', 'OWNER', 'MANAGER'].includes(normRole);

  if (useAdmin && normRole !== 'RESIDENT') {
    return resolveAdminAction(type, payload, normRole);
  }
  return resolveResidentAction(type, payload);
}
