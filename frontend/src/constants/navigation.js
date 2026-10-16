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
    roles: ['OWNER', 'MANAGER'],
  },
  {
    name: 'Bất động sản',
    path: '/admin/buildings',
    icon: Building2,
    roles: ['OWNER', 'MANAGER'],
  },
  {
    name: 'Cư dân & Khách',
    path: '/admin/tenants',
    icon: Users,
    roles: ['OWNER', 'MANAGER'],
  },
  {
    name: 'Hợp đồng thuê',
    path: '/admin/contracts',
    icon: FileText,
    roles: ['OWNER', 'MANAGER'],
  },
  {
    name: 'Sổ quản lý cọc',
    path: '/admin/deposits',
    icon: ShieldCheck,
    roles: ['OWNER', 'MANAGER'],
  },
];
