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
    // Helpers theo ma trận quyền PRD 6.2 (SYS_ADMIN = CRUD, MANAGER = CRU trên Tòa/Khu/Tầng/Căn hộ)
    canCreateBuildings: isSysAdmin || isManager,
    canManageBuildings: isSysAdmin,
    canEditRealEstate: isSysAdmin || isManager,
    canManageTenants: isSysAdmin || isManager,
    canCreateContracts: isManager,
    canApproveContracts: isOwner || isManager,
    canSettleDeposits: isManager,
    canApproveDepositRefund: isOwner,
    canManageMeters: isSysAdmin || isManager || isStaff,
    canManageServices: isSysAdmin || isManager,
    canManageInvoices: isSysAdmin || isManager || isAccountant,
    canManagePayments: isSysAdmin || isManager || isAccountant,
    canHandleMaintenance: isSysAdmin || isManager || isStaff,
    canSendNotifications: isSysAdmin || isOwner || isManager,
    canManageUsers: isSysAdmin,
  };
}

