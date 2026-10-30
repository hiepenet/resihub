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
  const isResident = roleCodes.includes(ROLES.RESIDENT);

  return {
    user,
    roleCodes,
    primaryRole: getCurrentRole(),
    hasRole,
    isSysAdmin,
    isOwner,
    isManager,
    isResident,
    // Ma trận quyền 4 vai trò: SYS_ADMIN, OWNER (100% Read-Only), MANAGER (vận hành + kế toán + kỹ thuật), RESIDENT
    canCreateBuildings: isSysAdmin || isManager,
    canManageBuildings: isSysAdmin,
    canEditRealEstate: isSysAdmin || isManager,
    canManageTenants: isSysAdmin || isManager,
    canCreateContracts: isSysAdmin || isManager,
    canApproveContracts: isSysAdmin || isManager,
    canTerminateContracts: isSysAdmin || isManager,
    canSettleDeposits: isSysAdmin || isManager,
    canApproveDepositRefund: isSysAdmin || isManager,
    canManageMeters: isSysAdmin || isManager,
    canManageServiceCatalog: isSysAdmin || isManager,
    canManageServices: isSysAdmin || isManager,
    canManageInvoices: isSysAdmin || isManager,
    canManagePayments: isSysAdmin || isManager,
    canHandleMaintenance: isSysAdmin || isManager,
    canSendNotifications: isSysAdmin || isManager,
    canManageUsers: isSysAdmin,
    canViewAuditLogs: isSysAdmin || isOwner,
  };
}
