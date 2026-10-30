import { useAuthStore } from '../stores/authStore';
import { ROLES } from '../constants/roles';

export function usePermission() {
  const user = useAuthStore((s) => s.user);
  const hasRole = useAuthStore((s) => s.hasRole);
  const getRoleCodes = useAuthStore((s) => s.getRoleCodes);
  const getCurrentRole = useAuthStore((s) => s.getCurrentRole);

  const roleCodes = getRoleCodes();
  const isSysAdmin = roleCodes.includes(ROLES.SYS_ADMIN);
  const isOwner = roleCodes.includes(ROLES.OWNER);
  const isManager = roleCodes.includes(ROLES.MANAGER);
  const isAccountant = roleCodes.includes(ROLES.ACCOUNTANT);
  const isStaff = roleCodes.includes(ROLES.STAFF);
  const isResident = roleCodes.includes(ROLES.RESIDENT);

  return {
    user,
    roleCodes,
    primaryRole: getCurrentRole(),
    hasRole,
    isSysAdmin,
    isOwner,
    isManager,
    isAccountant,
    isStaff,
    isResident,
    // Ma trận quyền PRD v2.0 Mục 6.1 & 6.2 (Phương án 2: OWNER 100% Read-Only, không tham gia vận hành)
    canCreateBuildings: isSysAdmin || isManager,
    canManageBuildings: isSysAdmin,
    canEditRealEstate: isSysAdmin || isManager,
    canManageTenants: isSysAdmin || isManager,
    canCreateContracts: isManager,
    canApproveContracts: isSysAdmin || isManager,
    canTerminateContracts: isSysAdmin || isManager,
    canSettleDeposits: isSysAdmin || isManager || isAccountant,
    canApproveDepositRefund: isSysAdmin || isManager,
    canManageMeters: isSysAdmin || isManager || isStaff || isAccountant,
    canManageServiceCatalog: isSysAdmin || isManager || isAccountant,
    canManageServices: isSysAdmin || isManager,
    canManageInvoices: isSysAdmin || isManager || isAccountant,
    canManagePayments: isSysAdmin || isManager || isAccountant,
    canHandleMaintenance: isSysAdmin || isManager || isStaff,
    canSendNotifications: isSysAdmin || isManager,
    canManageUsers: isSysAdmin,
  };
}
