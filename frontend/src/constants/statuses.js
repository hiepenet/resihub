// 5 màu sơ đồ tầng theo kế hoạch: Xanh=AVAILABLE, Đỏ=OCCUPIED, Cam=RESERVED, Xám=MAINTENANCE, Tím=BLOCKED/INACTIVE
export const APARTMENT_STATUS = {
  AVAILABLE: {
    label: 'Còn trống',
    variant: 'emerald',
    floorBg: 'bg-emerald-50 hover:bg-emerald-100 border-emerald-300 text-emerald-900',
    dot: 'bg-emerald-500',
  },
  OCCUPIED: {
    label: 'Đang thuê',
    variant: 'red',
    floorBg: 'bg-rose-50 hover:bg-rose-100 border-rose-300 text-rose-900',
    dot: 'bg-rose-500',
  },
  RESERVED: {
    label: 'Đã giữ chỗ',
    variant: 'amber',
    floorBg: 'bg-amber-50 hover:bg-amber-100 border-amber-300 text-amber-900',
    dot: 'bg-amber-500',
  },
  MAINTENANCE: {
    label: 'Đang bảo trì',
    variant: 'slate',
    floorBg: 'bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-800',
    dot: 'bg-slate-500',
  },
  BLOCKED: {
    label: 'Tạm khóa',
    variant: 'purple',
    floorBg: 'bg-purple-50 hover:bg-purple-100 border-purple-300 text-purple-900',
    dot: 'bg-purple-500',
  },
  INACTIVE: {
    label: 'Ngưng khai thác',
    variant: 'purple',
    floorBg: 'bg-purple-50 hover:bg-purple-100 border-purple-300 text-purple-900',
    dot: 'bg-purple-500',
  },
};

export const CONTRACT_STATUS = {
  DRAFT: { label: 'Bản nháp', variant: 'slate' },
  PENDING_APPROVAL: { label: 'Chờ phê duyệt', variant: 'amber' },
  ACTIVE: { label: 'Đang hiệu lực', variant: 'emerald' },
  RENEWAL_PENDING: { label: 'Chờ duyệt gia hạn', variant: 'sky' },
  TERMINATION_PENDING: { label: 'Chờ duyệt chấm dứt', variant: 'amber' },
  EXPIRED: { label: 'Đã hết hạn', variant: 'slate' },
  TERMINATED: { label: 'Đã thanh lý', variant: 'red' },
  CANCELLED: { label: 'Đã hủy', variant: 'slate' },
};

export const DEPOSIT_STATUS = {
  HELD: { label: 'Đang giữ cọc', variant: 'sky' },
  SETTLEMENT_DRAFT: { label: 'Nháp tất toán', variant: 'slate' },
  PENDING_APPROVAL: { label: 'Chờ duyệt hoàn cọc', variant: 'amber' },
  PARTIALLY_REFUNDED: { label: 'Hoàn cọc một phần', variant: 'indigo' },
  REFUNDED: { label: 'Đã tất toán / Hoàn đủ', variant: 'emerald' },
  TRANSFERRED: { label: 'Đã kết chuyển', variant: 'indigo' },
  DISPUTED: { label: 'Đang tranh chấp', variant: 'red' },
};

export const PAYMENT_METHOD_LABELS = {
  BANK_TRANSFER: 'Chuyển khoản',
  TRANSFER: 'Chuyển khoản',
  QR_CODE: 'QR Code',
  E_WALLET: 'Ví điện tử',
  EWALLET: 'Ví điện tử',
  CASH: 'Tiền mặt',
  CARD: 'Thẻ',
  OTHER: 'Khác',
};

export const PAYMENT_METHOD_OPTIONS = [
  { value: 'BANK_TRANSFER', label: 'Chuyển khoản' },
  { value: 'QR_CODE', label: 'QR Code' },
  { value: 'E_WALLET', label: 'Ví điện tử' },
  { value: 'CASH', label: 'Tiền mặt' },
  { value: 'CARD', label: 'Thẻ' },
  { value: 'OTHER', label: 'Khác' },
];

export const INVOICE_LINE_TYPES = {
  RENT: { label: 'Tiền thuê phòng', variant: 'sky' },
  ELECTRICITY: { label: 'Tiền điện', variant: 'amber' },
  WATER: { label: 'Tiền nước', variant: 'sky' },
  SERVICE: { label: 'Dịch vụ tiện ích', variant: 'indigo' },
  LATE_FEE: { label: 'Phạt chậm thanh toán', variant: 'red' },
  ADJUSTMENT: { label: 'Điều chỉnh', variant: 'purple' },
  OTHER: { label: 'Khoản khác', variant: 'slate' },
};

export const INVOICE_STATUS = {
  DRAFT: { label: 'Bản nháp', variant: 'slate' },
  ISSUED: { label: 'Đã phát hành', variant: 'sky' },
  PARTIALLY_PAID: { label: 'Thanh toán một phần', variant: 'amber' },
  PAID: { label: 'Đã thanh toán', variant: 'emerald' },
  OVERDUE: { label: 'Quá hạn', variant: 'red' },
  CANCELLED: { label: 'Đã hủy', variant: 'slate' },
};

export const PAYMENT_STATUS = {
  PENDING_CONFIRMATION: { label: 'Chờ đối soát', variant: 'amber' },
  CONFIRMED: { label: 'Đã xác nhận', variant: 'emerald' },
  REJECTED: { label: 'Đã từ chối', variant: 'red' },
};

export const RECEIVABLE_STATUS = {
  OPEN: { label: 'Chưa thu', variant: 'red' },
  PARTIALLY_PAID: { label: 'Thu một phần', variant: 'amber' },
  PAID: { label: 'Đã thu đủ', variant: 'emerald' },
  WRITTEN_OFF: { label: 'Đã xóa nợ', variant: 'slate' },
};

export const SERVICE_REQUEST_STATUS = {
  NEW: { label: 'Mới tiếp nhận', variant: 'sky' },
  ASSIGNED: { label: 'Đã phân công', variant: 'indigo' },
  IN_PROGRESS: { label: 'Đang xử lý', variant: 'amber' },
  RESOLVED: { label: 'Đã xử lý xong', variant: 'emerald' },
  CLOSED: { label: 'Đã đóng', variant: 'slate' },
  CANCELLED: { label: 'Đã hủy', variant: 'red' },
};

export const SERVICE_REQUEST_PRIORITY = {
  LOW: { label: 'Thấp', variant: 'slate' },
  NORMAL: { label: 'Bình thường', variant: 'sky' },
  HIGH: { label: 'Cao', variant: 'amber' },
  URGENT: { label: 'Khẩn cấp', variant: 'red' },
};

export const SERVICE_REQUEST_CATEGORY = {
  ELECTRICAL: 'Điện chiếu sáng / Ổ cắm',
  PLUMBING: 'Cấp thoát nước',
  HVAC: 'Điều hòa / Thông gió',
  FURNITURE: 'Nội thất căn hộ',
  APPLIANCE: 'Thiết bị gia dụng',
  CLEANING: 'Vệ sinh môi trường',
  SECURITY: 'An ninh / Khóa cửa',
  OTHER: 'Hạng mục khác',
};

export const SUBSCRIPTION_STATUS = {
  PENDING_APPROVAL: { label: 'Chờ phê duyệt', variant: 'amber' },
  ACTIVE: { label: 'Đang sử dụng', variant: 'emerald' },
  CANCELLATION_PENDING: { label: 'Chờ hủy', variant: 'amber' },
  CANCELLED: { label: 'Đã hủy', variant: 'slate' },
  REJECTED: { label: 'Từ chối', variant: 'red' },
};

export const TENANT_STATUS = {
  ACTIVE: { label: 'Đang thuê', variant: 'emerald' },
  PENDING: { label: 'Chờ nhận phòng', variant: 'amber' },
  INACTIVE: { label: 'Đã trả phòng', variant: 'slate' },
  MOVED_OUT: { label: 'Đã chuyển đi', variant: 'slate' },
};

export const USER_STATUS = {
  ACTIVE: { label: 'Đang hoạt động', variant: 'emerald' },
  SUSPENDED: { label: 'Tạm khóa', variant: 'red' },
};

export const ALL_STATUS_MAPS = {
  apartment: APARTMENT_STATUS,
  contract: CONTRACT_STATUS,
  deposit: DEPOSIT_STATUS,
  invoice: INVOICE_STATUS,
  payment: PAYMENT_STATUS,
  receivable: RECEIVABLE_STATUS,
  service_request: SERVICE_REQUEST_STATUS,
  priority: SERVICE_REQUEST_PRIORITY,
  subscription: SUBSCRIPTION_STATUS,
  tenant: TENANT_STATUS,
  user: USER_STATUS,
};

