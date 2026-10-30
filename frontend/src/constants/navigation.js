import { ROLES } from './roles';

export const ADMIN_NAV_GROUPS = [
  {
    group: 'Tổng quan',
    items: [
      {
        label: 'Bảng điều khiển',
        path: '/admin/dashboard',
        icon: 'LayoutDashboard',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
    ],
  },
  {
    group: 'Khai thác & Cư dân',
    items: [
      {
        label: 'Bất động sản',
        path: '/admin/buildings',
        icon: 'Building2',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
      {
        label: 'Hồ sơ Cư dân',
        path: '/admin/tenants',
        icon: 'Users',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
      {
        label: 'Hợp đồng thuê',
        path: '/admin/contracts',
        icon: 'FileSignature',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
      {
        label: 'Quản lý Tiền cọc',
        path: '/admin/deposits',
        icon: 'ShieldCheck',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
    ],
  },
  {
    group: 'Tài chính & Vận hành',
    items: [
      {
        label: 'Chỉ số Điện / Nước',
        path: '/admin/meters',
        icon: 'Gauge',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
      {
        label: 'Dịch vụ & Tiện ích',
        path: '/admin/services',
        icon: 'Sparkles',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
      {
        label: 'Hóa đơn kỳ',
        path: '/admin/invoices',
        icon: 'Receipt',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
      {
        label: 'Thanh toán & Công nợ',
        path: '/admin/payments',
        icon: 'Wallet',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
      {
        label: 'Yêu cầu & Báo hỏng',
        path: '/admin/maintenance',
        icon: 'Wrench',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
    ],
  },
  {
    group: 'Hệ thống & Báo cáo',
    items: [
      {
        label: 'Thông báo cư dân',
        path: '/admin/notifications',
        icon: 'BellRing',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
      {
        label: 'Báo cáo thống kê',
        path: '/admin/reports',
        icon: 'BarChart3',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER],
      },
      {
        label: 'Nhật ký hệ thống',
        path: '/admin/audit-logs',
        icon: 'ScrollText',
        roles: [ROLES.SYS_ADMIN, ROLES.OWNER],
      },
      {
        label: 'Người dùng & Cấu hình',
        path: '/admin/users',
        icon: 'UserCog',
        roles: [ROLES.SYS_ADMIN],
      },
    ],
  },
];

export const RESIDENT_PORTAL_TABS = [
  { id: 'overview', label: 'Tổng quan', shortLabel: 'Tổng quan', icon: 'Home', code: 'P1' },
  { id: 'contract', label: 'Hợp đồng & Cọc', shortLabel: 'Hợp đồng', icon: 'FileText', code: 'P2' },
  { id: 'invoices', label: 'Hóa đơn & TT', shortLabel: 'Hóa đơn', icon: 'Receipt', code: 'P3' },
  { id: 'services', label: 'Dịch vụ tiện ích', shortLabel: 'Dịch vụ', icon: 'Sparkles', code: 'P4' },
  { id: 'maintenance', label: 'Báo hỏng / Hỗ trợ', shortLabel: 'Báo hỏng', icon: 'Wrench', code: 'P5' },
  { id: 'notifications', label: 'Thông báo', shortLabel: 'Thông báo', icon: 'Bell', code: 'P6' },
  { id: 'contact', label: 'Danh bạ BQL', shortLabel: 'Liên hệ', icon: 'PhoneCall', code: 'P7' },
  { id: 'profile', label: 'Hồ sơ cá nhân', shortLabel: 'Hồ sơ', icon: 'UserCircle', code: 'P8' },
];
