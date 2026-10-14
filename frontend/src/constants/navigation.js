import {
  LayoutDashboard,
  Building2,
  Users,
  FileText,
  ShieldCheck,
  CreditCard,
  Wrench,
  Bell,
  Settings,
} from 'lucide-react';

export const NAV_ITEMS = [
  {
    name: 'Dashboard',
    path: '/admin/dashboard',
    icon: LayoutDashboard,
    roles: ['OWNER', 'MANAGER', 'ACCOUNTANT', 'STAFF', 'SYS_ADMIN'],
  },
  {
    name: 'Bất động sản',
    path: '/admin/buildings',
    icon: Building2,
    roles: ['OWNER', 'MANAGER', 'SYS_ADMIN'],
  },
  {
    name: 'Cư dân & Khách',
    path: '/admin/tenants',
    icon: Users,
    roles: ['MANAGER', 'STAFF', 'SYS_ADMIN'],
  },
  {
    name: 'Hợp đồng thuê',
    path: '/admin/contracts',
    icon: FileText,
    roles: ['OWNER', 'MANAGER', 'ACCOUNTANT', 'SYS_ADMIN'],
  },
  {
    name: 'Sổ quản lý cọc',
    path: '/admin/deposits',
    icon: ShieldCheck,
    roles: ['OWNER', 'ACCOUNTANT', 'MANAGER', 'SYS_ADMIN'],
  },
];
