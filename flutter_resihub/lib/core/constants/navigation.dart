import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'roles.dart';

/// Navigation item in the Admin portal navigation hierarchy.
class NavItem {
  const NavItem({
    required this.label,
    required this.path,
    required this.icon,
    required this.roles,
  });

  final String label;
  final String path;
  final IconData icon;
  final List<AppRole> roles;
}

/// Navigation group categorization in the Admin portal.
class NavGroup {
  const NavGroup({
    required this.group,
    required this.items,
  });

  final String group;
  final List<NavItem> items;
}

/// Definition for tabs in the Resident portal.
class ResidentTabDef {
  const ResidentTabDef({
    required this.id,
    required this.label,
    required this.shortLabel,
    required this.icon,
    required this.code,
  });

  final String id;
  final String label;
  final String shortLabel;
  final IconData icon;
  final String code;
}

/// Admin Portal Navigation Groups (4 groups, 14 items).
/// Matches frontend/src/constants/navigation.js.
const List<NavGroup> kAdminNavGroups = [
  NavGroup(
    group: 'Tổng quan',
    items: [
      NavItem(
        label: 'Bảng điều khiển',
        path: '/admin/dashboard',
        icon: LucideIcons.layoutDashboard,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
    ],
  ),
  NavGroup(
    group: 'Khai thác & Cư dân',
    items: [
      NavItem(
        label: 'Bất động sản',
        path: '/admin/buildings',
        icon: LucideIcons.building2,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
      NavItem(
        label: 'Hồ sơ Cư dân',
        path: '/admin/tenants',
        icon: LucideIcons.users,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
      NavItem(
        label: 'Hợp đồng thuê',
        path: '/admin/contracts',
        icon: LucideIcons.fileSignature,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
      NavItem(
        label: 'Quản lý Tiền cọc',
        path: '/admin/deposits',
        icon: LucideIcons.shieldCheck,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
    ],
  ),
  NavGroup(
    group: 'Tài chính & Vận hành',
    items: [
      NavItem(
        label: 'Chỉ số Điện / Nước',
        path: '/admin/meters',
        icon: LucideIcons.gauge,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
      NavItem(
        label: 'Dịch vụ & Tiện ích',
        path: '/admin/services',
        icon: LucideIcons.sparkles,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
      NavItem(
        label: 'Hóa đơn kỳ',
        path: '/admin/invoices',
        icon: LucideIcons.receipt,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
      NavItem(
        label: 'Thanh toán & Công nợ',
        path: '/admin/payments',
        icon: LucideIcons.wallet,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
      NavItem(
        label: 'Yêu cầu & Báo hỏng',
        path: '/admin/maintenance',
        icon: LucideIcons.wrench,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
    ],
  ),
  NavGroup(
    group: 'Hệ thống & Báo cáo',
    items: [
      NavItem(
        label: 'Thông báo cư dân',
        path: '/admin/notifications',
        icon: LucideIcons.bellRing,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
      NavItem(
        label: 'Báo cáo thống kê',
        path: '/admin/reports',
        icon: LucideIcons.barChart3,
        roles: [AppRole.sysAdmin, AppRole.owner, AppRole.manager],
      ),
      NavItem(
        label: 'Nhật ký hệ thống',
        path: '/admin/audit-logs',
        icon: LucideIcons.scrollText,
        roles: [AppRole.sysAdmin, AppRole.owner],
      ),
      NavItem(
        label: 'Người dùng & Cấu hình',
        path: '/admin/users',
        icon: LucideIcons.userCog,
        roles: [AppRole.sysAdmin],
      ),
    ],
  ),
];

/// Resident Portal Tabs (8 tabs, P1..P8).
/// Matches frontend/src/constants/navigation.js.
const List<ResidentTabDef> kResidentPortalTabs = [
  ResidentTabDef(
    id: 'overview',
    label: 'Tổng quan',
    shortLabel: 'Tổng quan',
    icon: LucideIcons.home,
    code: 'P1',
  ),
  ResidentTabDef(
    id: 'contract',
    label: 'Hợp đồng & Cọc',
    shortLabel: 'Hợp đồng',
    icon: LucideIcons.fileText,
    code: 'P2',
  ),
  ResidentTabDef(
    id: 'invoices',
    label: 'Hóa đơn & TT',
    shortLabel: 'Hóa đơn',
    icon: LucideIcons.receipt,
    code: 'P3',
  ),
  ResidentTabDef(
    id: 'services',
    label: 'Dịch vụ tiện ích',
    shortLabel: 'Dịch vụ',
    icon: LucideIcons.sparkles,
    code: 'P4',
  ),
  ResidentTabDef(
    id: 'maintenance',
    label: 'Báo hỏng / Hỗ trợ',
    shortLabel: 'Báo hỏng',
    icon: LucideIcons.wrench,
    code: 'P5',
  ),
  ResidentTabDef(
    id: 'notifications',
    label: 'Thông báo',
    shortLabel: 'Thông báo',
    icon: LucideIcons.bell,
    code: 'P6',
  ),
  ResidentTabDef(
    id: 'contact',
    label: 'Danh bạ BQL',
    shortLabel: 'Liên hệ',
    icon: LucideIcons.phoneCall,
    code: 'P7',
  ),
  ResidentTabDef(
    id: 'profile',
    label: 'Hồ sơ cá nhân',
    shortLabel: 'Hồ sơ',
    icon: LucideIcons.userCircle,
    code: 'P8',
  ),
];
