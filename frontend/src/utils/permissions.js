import { ROLE_PRIORITY, ROLES, ADMIN_PORTAL_ROLES } from '../constants/roles';

export function extractRoleCodes(user) {
  if (!user || !Array.isArray(user.roles)) return [];
  const codes = user.roles
    .map((r) => (typeof r === 'string' ? r : r?.code))
    .filter(Boolean);
  return Array.from(new Set(codes));
}

export function getPrimaryRole(user) {
  const codes = extractRoleCodes(user);
  for (const prio of ROLE_PRIORITY) {
    if (codes.includes(prio)) return prio;
  }
  return ROLES.RESIDENT;
}

export function hasAnyRole(user, allowedRoles) {
  if (!allowedRoles || allowedRoles.length === 0) return true;
  const codes = extractRoleCodes(user);
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return codes.some((c) => allowed.includes(c));
}

export function isAdminPortalUser(user) {
  return hasAnyRole(user, ADMIN_PORTAL_ROLES);
}

export function getAssignedBuildingIds(user) {
  if (!user || !Array.isArray(user.roles)) return [];
  return Array.from(
    new Set(
      user.roles
        .map((r) => (typeof r === 'object' ? r?.building_id : null))
        .filter(Boolean)
    )
  );
}

