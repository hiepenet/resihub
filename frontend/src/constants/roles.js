export const ROLES = {
  SYS_ADMIN: 'SYS_ADMIN',
  OWNER: 'OWNER',
  MANAGER: 'MANAGER',
  RESIDENT: 'RESIDENT',
};

export const ROLE_PRIORITY = [
  ROLES.SYS_ADMIN,
  ROLES.OWNER,
  ROLES.MANAGER,
  ROLES.RESIDENT,
];

export const ROLE_LABELS = {
  SYS_ADMIN: 'Quản trị hệ thống',
  OWNER: 'Chủ đầu tư',
  MANAGER: 'Quản lý tòa nhà',
  RESIDENT: 'Cư dân',
};

export const ROLE_BADGE_VARIANTS = {
  SYS_ADMIN: 'indigo',
  OWNER: 'amber',
  MANAGER: 'sky',
  RESIDENT: 'purple',
};

export const ADMIN_PORTAL_ROLES = [
  ROLES.SYS_ADMIN,
  ROLES.OWNER,
  ROLES.MANAGER,
];

