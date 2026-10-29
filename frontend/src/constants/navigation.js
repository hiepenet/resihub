import {
  LayoutDashboard,
  Building2,
  Users,
  FileText,
  ShieldCheck,
} from 'lucide-react';

export const NAV_ITEMS = [
  {
    name: 'Dashboard',
    path: '/admin/dashboard',
    icon: LayoutDashboard,
    roles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
  },
  {
    name: 'Bất động sản',
    path: '/admin/buildings',
    icon: Building2,
    roles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
  },
  {
    name: 'Cư dân & Khách',
    path: '/admin/tenants',
    icon: Users,
    roles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
  },
  {
    name: 'Hợp đồng thuê',
    path: '/admin/contracts',
    icon: FileText,
    roles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
  },
  {
    name: 'Sổ quản lý cọc',
    path: '/admin/deposits',
    icon: ShieldCheck,
    roles: ['SYS_ADMIN', 'OWNER', 'MANAGER'],
  },
];
