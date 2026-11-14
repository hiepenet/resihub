/// ResiHub user roles and permissions.
enum AppRole {
  sysAdmin(
    code: 'SYS_ADMIN',
    label: 'Quản trị hệ thống',
    badgeVariant: 'indigo',
    isAdminPortal: true,
  ),
  owner(
    code: 'OWNER',
    label: 'Chủ đầu tư',
    badgeVariant: 'amber',
    isAdminPortal: true,
  ),
  manager(
    code: 'MANAGER',
    label: 'Quản lý tòa nhà',
    badgeVariant: 'sky',
    isAdminPortal: true,
  ),
  resident(
    code: 'RESIDENT',
    label: 'Cư dân',
    badgeVariant: 'purple',
    isAdminPortal: false,
  );

  const AppRole({
    required this.code,
    required this.label,
    required this.badgeVariant,
    required this.isAdminPortal,
  });

  final String code;
  final String label;
  final String badgeVariant;
  final bool isAdminPortal;

  /// Parses a role code case-insensitively, returning [fallback] (default `AppRole.resident`)
  /// if [code] is null or does not match any valid role.
  static AppRole fromCode(String? code, {AppRole fallback = AppRole.resident}) {
    if (code == null) return fallback;
    final normalized = code.trim().toUpperCase();
    for (final role in AppRole.values) {
      if (role.code == normalized) return role;
    }
    return fallback;
  }

  /// Parses a role code case-insensitively, returning `null` if not found.
  static AppRole? tryFromCode(String? code) {
    if (code == null) return null;
    final normalized = code.trim().toUpperCase();
    for (final role in AppRole.values) {
      if (role.code == normalized) return role;
    }
    return null;
  }
}

/// Order of authority: SYS_ADMIN > OWNER > MANAGER > RESIDENT
const List<AppRole> kRolePriority = [
  AppRole.sysAdmin,
  AppRole.owner,
  AppRole.manager,
  AppRole.resident,
];

/// Roles allowed to access the admin portal.
const List<AppRole> kAdminPortalRoles = [
  AppRole.sysAdmin,
  AppRole.owner,
  AppRole.manager,
];
