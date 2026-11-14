import 'dart:ui';

/// The 15 business status domains used across the ResiHub system.
enum StatusDomain {
  apartment,
  contract,
  deposit,
  invoice,
  payment,
  receivable,
  reservation,
  serviceRequest,
  announcement,
  priority,
  subscription,
  tenant,
  user,
  invoiceAdjustment,
  creditBalance,
}

/// Visual presentation metadata for a domain status code.
class StatusMeta {
  const StatusMeta({
    required this.code,
    required this.label,
    required this.variant,
    required this.color,
    required this.bgColor,
    required this.borderColor,
    this.dotColor,
  });

  final String code;
  final String label;
  final String variant;
  final Color color;
  final Color bgColor;
  final Color borderColor;
  final Color? dotColor;
}

/// Payment method option for select inputs.
class PaymentMethodOption {
  const PaymentMethodOption({
    required this.value,
    required this.label,
  });

  final String value;
  final String label;
}

/// Metadata for invoice line types.
class InvoiceLineTypeMeta {
  const InvoiceLineTypeMeta({
    required this.label,
    required this.variant,
  });

  final String label;
  final String variant;
}

// ---------------------------------------------------------------------------
// Color helpers for badge variants
// ---------------------------------------------------------------------------

StatusMeta _createStatusMeta({
  required String code,
  required String label,
  required String variant,
}) {
  final (color, bgColor, borderColor, dotColor) = switch (variant) {
    'sky' => (
        const Color(0xFF0369A1), // sky-700
        const Color(0xFFF0F9FF), // sky-50
        const Color(0xFFBAE6FD), // sky-200
        const Color(0xFF0EA5E9), // sky-500
      ),
    'indigo' => (
        const Color(0xFF4338CA), // indigo-700
        const Color(0xFFEEF2FF), // indigo-50
        const Color(0xFFC7D2FE), // indigo-200
        const Color(0xFF6366F1), // indigo-500
      ),
    'emerald' => (
        const Color(0xFF047857), // emerald-700
        const Color(0xFFECFDF5), // emerald-50
        const Color(0xFFA7F3D0), // emerald-200
        const Color(0xFF10B981), // emerald-500
      ),
    'amber' => (
        const Color(0xFFB45309), // amber-700
        const Color(0xFFFFFBEB), // amber-50
        const Color(0xFFFDE68A), // amber-200
        const Color(0xFFF59E0B), // amber-500
      ),
    'red' => (
        const Color(0xFFBE123C), // rose-700
        const Color(0xFFFFF1F2), // rose-50
        const Color(0xFFFECDD3), // rose-200
        const Color(0xFFF43F5E), // rose-500
      ),
    'purple' => (
        const Color(0xFF7E22CE), // purple-700
        const Color(0xFFFAF5FF), // purple-50
        const Color(0xFFE9D5FF), // purple-200
        const Color(0xFFA855F7), // purple-500
      ),
    _ => (
        const Color(0xFF334155), // slate-700
        const Color(0xFFF1F5F9), // slate-100
        const Color(0xFFE2E8F0), // slate-200
        const Color(0xFF94A3B8), // slate-400
      ),
  };

  return StatusMeta(
    code: code,
    label: label,
    variant: variant,
    color: color,
    bgColor: bgColor,
    borderColor: borderColor,
    dotColor: dotColor,
  );
}

// ---------------------------------------------------------------------------
// Status definitions for each domain (from frontend/src/constants/statuses.js)
// ---------------------------------------------------------------------------

const Map<String, (String label, String variant)> _apartmentStatuses = {
  'AVAILABLE': ('Còn trống', 'emerald'),
  'OCCUPIED': ('Đang thuê', 'red'),
  'RESERVED': ('Đã giữ chỗ', 'amber'),
  'MAINTENANCE': ('Đang bảo trì', 'slate'),
  'BLOCKED': ('Tạm khóa', 'purple'),
  'INACTIVE': ('Ngưng khai thác', 'purple'),
};

const Map<String, (String label, String variant)> _contractStatuses = {
  'DRAFT': ('Bản nháp', 'slate'),
  'PENDING_APPROVAL': ('Chờ phê duyệt', 'amber'),
  'ACTIVE': ('Đang hiệu lực', 'emerald'),
  'RENEWAL_PENDING': ('Chờ duyệt gia hạn', 'sky'),
  'TERMINATION_PENDING': ('Chờ bàn giao chấm dứt', 'amber'),
  'EXPIRED': ('Đã hết hạn', 'slate'),
  'TERMINATED': ('Đã thanh lý', 'red'),
  'CANCELLED': ('Đã hủy', 'slate'),
};

const Map<String, (String label, String variant)> _depositStatuses = {
  'HELD': ('Đang giữ cọc', 'sky'),
  'SETTLEMENT_DRAFT': ('Nháp tất toán', 'slate'),
  'PENDING_APPROVAL': ('Chờ duyệt hoàn cọc', 'amber'),
  'APPROVED_PENDING_PAYOUT': ('Đã duyệt - Chờ chi tiền', 'amber'),
  'PARTIALLY_REFUNDED': ('Hoàn cọc một phần', 'indigo'),
  'REFUNDED': ('Đã hoàn đủ 100%', 'emerald'),
  'DEDUCTED_FULL': ('Đã khấu trừ hết cọc', 'amber'),
  'TRANSFERRED': ('Đã kết chuyển', 'indigo'),
  'DISPUTED': ('Đang tranh chấp', 'red'),
  'RETURNED': ('Ngân hàng hoàn trả lệnh chi', 'red'),
};

const Map<String, (String label, String variant)> _invoiceStatuses = {
  'DRAFT': ('Bản nháp', 'slate'),
  'ISSUED': ('Đã phát hành', 'sky'),
  'PARTIALLY_PAID': ('Thanh toán một phần', 'amber'),
  'PAID': ('Đã thanh toán', 'emerald'),
  'OVERDUE': ('Quá hạn', 'red'),
  'ADJUSTED': ('Đã điều chỉnh', 'purple'),
  'VOID': ('Đã hủy', 'slate'),
  'CANCELLED': ('Đã hủy', 'slate'),
};

const Map<String, (String label, String variant)> _paymentStatuses = {
  'PENDING_CONFIRMATION': ('Chờ đối soát', 'amber'),
  'CONFIRMED': ('Đã xác nhận', 'emerald'),
  'REJECTED': ('Đã từ chối', 'red'),
};

const Map<String, (String label, String variant)> _receivableStatuses = {
  'OPEN': ('Chưa thu', 'red'),
  'PARTIALLY_PAID': ('Thu một phần', 'amber'),
  'PAID': ('Đã thu đủ', 'emerald'),
  'WRITTEN_OFF': ('Đã xóa nợ', 'slate'),
};

const Map<String, (String label, String variant)> _reservationStatuses = {
  'PENDING_CONFIRM': ('Chờ xác nhận chuyển khoản', 'amber'),
  'HELD': ('Đang giữ chỗ', 'amber'),
  'CANCEL_PENDING_APPROVAL': ('Chờ duyệt hủy giữ chỗ', 'amber'),
  'APPROVED_PENDING_PAYOUT': ('Chờ chi hoàn giữ chỗ', 'sky'),
  'CONVERTED': ('Đã lên hợp đồng', 'emerald'),
  'EXPIRED': ('Hết hạn giữ chỗ', 'slate'),
  'CANCELLED': ('Đã hủy giữ chỗ', 'slate'),
  'PARTIALLY_REFUNDED': ('Hoàn một phần', 'amber'),
  'REFUNDED': ('Đã hoàn cọc giữ chỗ', 'sky'),
  'FORFEITED': ('Thu giữ cọc (Bỏ cọc)', 'red'),
  'REJECTED': ('Từ chối xác nhận', 'red'),
};

const Map<String, (String label, String variant)> _serviceRequestStatuses = {
  'NEW': ('Mới tiếp nhận', 'sky'),
  'ASSIGNED': ('Đã phân công', 'indigo'),
  'IN_PROGRESS': ('Đang xử lý', 'amber'),
  'ON_HOLD': ('Tạm hoãn / Hẹn lại', 'purple'),
  'RESOLVED': ('Đã xử lý xong', 'emerald'),
  'REOPENED': ('Mở lại xử lý', 'red'),
  'CLOSED': ('Đã đóng', 'slate'),
  'CANCELLED': ('Đã hủy', 'red'),
};

const Map<String, (String label, String variant)> _announcementStatuses = {
  'DRAFT': ('Bản nháp', 'slate'),
  'SCHEDULED': ('Hẹn giờ gửi', 'amber'),
  'SENT': ('Đã phát hành', 'emerald'),
  'CANCELLED': ('Đã hủy', 'red'),
};

const Map<String, (String label, String variant)> _serviceRequestPriorities = {
  'LOW': ('Thấp', 'slate'),
  'NORMAL': ('Bình thường', 'sky'),
  'HIGH': ('Cao', 'amber'),
  'URGENT': ('Khẩn cấp', 'red'),
};

const Map<String, (String label, String variant)> _subscriptionStatuses = {
  'PENDING_APPROVAL': ('Chờ phê duyệt', 'amber'),
  'ACTIVE': ('Đang sử dụng', 'emerald'),
  'CANCELLATION_PENDING': ('Chờ hủy', 'amber'),
  'TERMINATED': ('Đã chấm dứt', 'red'),
  'CANCELLED': ('Đã hủy', 'slate'),
  'REJECTED': ('Từ chối', 'red'),
};

const Map<String, (String label, String variant)> _tenantStatuses = {
  'ACTIVE': ('Đang thuê', 'emerald'),
  'APPROVED': ('Đã duyệt (Chờ lập HĐ)', 'sky'),
  'PENDING': ('Chờ duyệt / Thiếu giấy tờ', 'amber'),
  'REJECTED': ('Từ chối hồ sơ', 'red'),
  'INACTIVE': ('Đã trả phòng', 'slate'),
  'MOVED_OUT': ('Đã trả phòng', 'slate'),
  'MERGED': ('Đã gộp hồ sơ', 'slate'),
};

const Map<String, (String label, String variant)> _userStatuses = {
  'ACTIVE': ('Đang hoạt động', 'emerald'),
  'SUSPENDED': ('Tạm khóa', 'red'),
};

const Map<String, (String label, String variant)> _invoiceAdjustmentStatuses = {
  'PENDING_APPROVAL': ('Chờ phê duyệt', 'amber'),
  'APPROVED': ('Đã duyệt', 'emerald'),
  'REJECTED': ('Từ chối', 'red'),
  'CANCELLED': ('Đã hủy', 'slate'),
};

const Map<String, (String label, String variant)> _creditBalanceStatuses = {
  'AVAILABLE': ('Khả dụng', 'emerald'),
  'PARTIALLY_APPLIED': ('Đã dùng một phần', 'indigo'),
  'APPLIED': ('Đã cấn trừ đủ', 'sky'),
  'PENDING_DIRECT_REFUND': ('Chờ duyệt hoàn tiền', 'amber'),
  'REFUNDED_DIRECT': ('Đã hoàn tiền', 'emerald'),
  'PENDING_SETTLEMENT_PAYOUT': ('Chờ chi quyết toán', 'amber'),
  'REFUNDED_IN_SETTLEMENT': ('Đã hoàn theo quyết toán', 'emerald'),
  'TRANSFERRED': ('Đã kết chuyển', 'indigo'),
  'VOID': ('Đã hủy', 'slate'),
  'CANCELLED': ('Đã hủy', 'slate'),
};

/// Resolves the metadata (label, variant, colors) for any status in ResiHub.
StatusMeta resolveStatusMeta(StatusDomain domain, String? code) {
  if (code == null || code.trim().isEmpty) {
    return _createStatusMeta(
      code: 'UNKNOWN',
      label: 'Không xác định',
      variant: 'slate',
    );
  }

  final normalized = code.trim().toUpperCase();

  final map = switch (domain) {
    StatusDomain.apartment => _apartmentStatuses,
    StatusDomain.contract => _contractStatuses,
    StatusDomain.deposit => _depositStatuses,
    StatusDomain.invoice => _invoiceStatuses,
    StatusDomain.payment => _paymentStatuses,
    StatusDomain.receivable => _receivableStatuses,
    StatusDomain.reservation => _reservationStatuses,
    StatusDomain.serviceRequest => _serviceRequestStatuses,
    StatusDomain.announcement => _announcementStatuses,
    StatusDomain.priority => _serviceRequestPriorities,
    StatusDomain.subscription => _subscriptionStatuses,
    StatusDomain.tenant => _tenantStatuses,
    StatusDomain.user => _userStatuses,
    StatusDomain.invoiceAdjustment => _invoiceAdjustmentStatuses,
    StatusDomain.creditBalance => _creditBalanceStatuses,
  };

  final found = map[normalized];
  if (found != null) {
    return _createStatusMeta(
      code: normalized,
      label: found.$1,
      variant: found.$2,
    );
  }

  return _createStatusMeta(
    code: code,
    label: code,
    variant: 'slate',
  );
}

// ---------------------------------------------------------------------------
// Payment method options & labels
// ---------------------------------------------------------------------------

const Map<String, String> kPaymentMethodLabels = {
  'BANK_TRANSFER': 'Chuyển khoản',
  'TRANSFER': 'Chuyển khoản',
  'QR_CODE': 'QR Code',
  'E_WALLET': 'Ví điện tử',
  'EWALLET': 'Ví điện tử',
  'CASH': 'Tiền mặt',
  'CARD': 'Thẻ',
  'OTHER': 'Khác',
};

const List<PaymentMethodOption> kPaymentMethodOptions = [
  PaymentMethodOption(value: 'BANK_TRANSFER', label: 'Chuyển khoản'),
  PaymentMethodOption(value: 'QR_CODE', label: 'QR Code'),
  PaymentMethodOption(value: 'E_WALLET', label: 'Ví điện tử'),
  PaymentMethodOption(value: 'CASH', label: 'Tiền mặt'),
  PaymentMethodOption(value: 'CARD', label: 'Thẻ'),
  PaymentMethodOption(value: 'OTHER', label: 'Khác'),
];

// ---------------------------------------------------------------------------
// Invoice line types
// ---------------------------------------------------------------------------

const Map<String, InvoiceLineTypeMeta> kInvoiceLineTypes = {
  'RENT': InvoiceLineTypeMeta(label: 'Tiền thuê phòng', variant: 'sky'),
  'ELECTRICITY': InvoiceLineTypeMeta(label: 'Tiền điện', variant: 'amber'),
  'WATER': InvoiceLineTypeMeta(label: 'Tiền nước', variant: 'sky'),
  'SERVICE': InvoiceLineTypeMeta(label: 'Dịch vụ tiện ích', variant: 'indigo'),
  'LATE_FEE': InvoiceLineTypeMeta(label: 'Phạt chậm thanh toán', variant: 'red'),
  'ADJUSTMENT': InvoiceLineTypeMeta(label: 'Điều chỉnh', variant: 'purple'),
  'OTHER': InvoiceLineTypeMeta(label: 'Khoản khác', variant: 'slate'),
};

// ---------------------------------------------------------------------------
// Preferred service slot labels
// ---------------------------------------------------------------------------

const Map<String, String> kPreferredSlotLabels = {
  'MORNING_08_12': 'Sáng (08:00 – 12:00)',
  'AFTERNOON_13_17': 'Chiều (13:00 – 17:00)',
  'EVENING_18_21': 'Tối (18:00 – 21:00)',
  'ANYTIME': 'Linh hoạt cả ngày',
};

// ---------------------------------------------------------------------------
// Service request categories
// ---------------------------------------------------------------------------

const Map<String, String> kServiceRequestCategories = {
  'ELECTRICAL': 'Điện chiếu sáng / Ổ cắm',
  'PLUMBING': 'Cấp thoát nước',
  'HVAC': 'Điều hòa / Thông gió',
  'FURNITURE': 'Nội thất căn hộ',
  'APPLIANCE': 'Thiết bị gia dụng',
  'CLEANING': 'Vệ sinh môi trường',
  'SECURITY': 'An ninh / Khóa cửa',
  'OTHER': 'Hạng mục khác',
};
