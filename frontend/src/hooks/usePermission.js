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
    // Ma trận quyền 4 vai trò (PRD Mục 6.2 & FR-014):
    // - SYS_ADMIN: cấu hình hệ thống & BĐS cấp cao, CHỈ ĐỌC (R) trên Hợp đồng & Sổ cọc khi tòa nhà đã có OWNER hoạt động.
    // - OWNER: xem tài sản sở hữu & phê duyệt hợp đồng lệch khung giá (>10%) / tất toán hoàn cọc / hủy giữ chỗ của tòa nhà sở hữu.
    // - MANAGER: toàn quyền tác nghiệp vận hành, hợp đồng, cư dân, dịch vụ, hóa đơn, kỹ thuật, chi hoàn tiền cọc trên tòa được gán.
    canCreateBuildings: isSysAdmin || isManager,
    canManageBuildings: isSysAdmin,
    canEditRealEstate: isSysAdmin || isManager,
    canManageTenants: isSysAdmin || isManager,
    canCreateContracts: isManager,
    canManageContracts: isManager,
    canApproveContracts: isManager,
    canApproveContractAmendments: isManager,
    canApproveContractPrice: isOwner || isSysAdmin,
    canTerminateContracts: isManager,
    canSettleDeposits: isManager,
    canExecuteDepositPayout: isManager,
    canApproveDepositRefund: isOwner || isManager || isSysAdmin,
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
