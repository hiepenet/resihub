import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/roles.dart';
import '../../../core/utils/permissions.dart';
import '../models/user_model.dart';
import 'auth_provider.dart';

/// Comprehensive 4-role permission matrix port of `frontend/src/hooks/usePermission.js`.
/// Implements all 26 canonical permission flags and operational helpers.
@immutable
class PermissionMatrix {
  final UserModel? user;
  final List<String> roleCodes;

  PermissionMatrix(this.user)
      : roleCodes = user?.roleCodes ?? const [];

  // =========================================================================
  // Core Role Flags & Metadata
  // =========================================================================

  /// True if user has SYS_ADMIN role.
  bool get isSysAdmin => roleCodes.contains(AppRole.sysAdmin.code);

  /// True if user has OWNER role.
  bool get isOwner => roleCodes.contains(AppRole.owner.code);

  /// True if user has MANAGER role.
  bool get isManager => roleCodes.contains(AppRole.manager.code);

  /// True if user has RESIDENT role.
  bool get isResident => roleCodes.contains(AppRole.resident.code);

  /// True if user has access to Admin Portal (SYS_ADMIN, OWNER, MANAGER).
  bool get isAdminPortal => isSysAdmin || isOwner || isManager;

  /// Primary role based on hierarchy.
  AppRole get primaryRole => user?.primaryRole ?? AppRole.resident;

  /// Checks if the user holds any of the specified roles.
  bool hasRole(dynamic allowedRoles) =>
      user != null && hasAnyRole(user, allowedRoles);

  // =========================================================================
  // Building & Real Estate Management
  // =========================================================================

  /// SYS_ADMIN only.
  bool get canManageBuildings => isSysAdmin;

  /// SYS_ADMIN or MANAGER.
  bool get canCreateBuilding => isSysAdmin || isManager;
  bool get canCreateBuildings => canCreateBuilding;

  /// SYS_ADMIN or MANAGER.
  bool get canEditRealEstate => isSysAdmin || isManager;

  /// Prevents MANAGER from altering the Owner field on an existing building/unit
  /// if an owner is already assigned.
  bool isOwnerFieldLockedForManager(String? currentOwnerId) {
    return isManager && currentOwnerId != null && currentOwnerId.trim().isNotEmpty;
  }

  // =========================================================================
  // Tenants & Identity Privacy
  // =========================================================================

  /// SYS_ADMIN or MANAGER.
  bool get canManageTenants => isSysAdmin || isManager;

  /// OWNER role masks CCCD/ID card image previews for tenant privacy.
  bool get isTenantIdImagesMasked => isOwner;

  // =========================================================================
  // Contracts
  // =========================================================================

  /// MANAGER operational editing rights.
  bool get canEditContracts => isManager;
  bool get canCreateContracts => isManager;
  bool get canManageContracts => isManager;
  bool get canApproveContracts => isManager;
  bool get canApproveContractAmendments => isManager;
  bool get canTerminateContracts => isManager;

  /// OWNER or SYS_ADMIN price approval.
  bool get canApprovePrice => isOwner || isSysAdmin;
  bool get canApproveContractPrice => canApprovePrice;

  // =========================================================================
  // Deposits
  // =========================================================================

  /// MANAGER deposits operational management.
  bool get canManageDeposits => isManager;
  bool get canSettleDeposits => isManager;
  bool get canExecuteDepositPayout => isManager;

  /// Deposit refund approval.
  bool get canApproveDeposit => isOwner || isSysAdmin;
  bool get canApproveDepositRefund => isOwner || isManager || isSysAdmin;

  // =========================================================================
  // Meters & Services
  // =========================================================================

  /// MANAGER records meter readings.
  bool get canRecordMeters => isManager;
  bool get canManageMeters => isManager;

  /// MANAGER manages service catalog and subscriptions.
  bool get canManageServices => isManager;
  bool get canManageServiceCatalog => isManager;

  // =========================================================================
  // Invoices & Billing
  // =========================================================================

  /// MANAGER creates invoices.
  bool get canCreateInvoice => isManager;

  /// MANAGER edits invoices.
  bool get canEditInvoice => isManager;

  /// MANAGER issues invoices.
  bool get canIssueInvoice => isManager;

  /// MANAGER requests invoice adjustments.
  bool get canRequestAdjustment => isManager;

  /// OWNER or SYS_ADMIN approves adjustments.
  bool get canApproveAdjustment => isOwner || isSysAdmin;

  /// General invoice management.
  bool get canManageInvoices => isManager;
  bool get canApproveInvoiceAdjustments => isOwner || isManager || isSysAdmin;

  // =========================================================================
  // Payments & Financial Refunds
  // =========================================================================

  /// MANAGER records payments.
  bool get canRecordPayment => isManager;

  /// MANAGER confirms payments.
  bool get canConfirmPayment => isManager;

  /// OWNER or SYS_ADMIN approves credit balance refunds.
  bool get canApproveCreditRefund => isOwner || isSysAdmin;

  /// General payment management.
  bool get canManagePayments => isManager;
  bool get canApproveCreditRefunds => isOwner || isManager || isSysAdmin;

  // =========================================================================
  // Operations & Maintenance
  // =========================================================================

  /// MANAGER handles maintenance service requests.
  bool get canHandleMaintenance => isManager;

  /// MANAGER sends announcements/notifications.
  bool get canSendAnnouncements => isManager;
  bool get canSendNotifications => isManager;

  /// SYS_ADMIN or MANAGER manages Zalo groups.
  bool get canManageZaloGroups => isSysAdmin || isManager;

  /// SYS_ADMIN deletes Zalo groups.
  bool get canDeleteZaloGroups => isSysAdmin;

  // =========================================================================
  // Administration & Audit Logs
  // =========================================================================

  /// SYS_ADMIN manages users and accounts.
  bool get canManageUsers => isSysAdmin;

  /// SYS_ADMIN manages system settings.
  bool get canManageSettings => isSysAdmin;

  /// SYS_ADMIN or OWNER views audit logs.
  bool get canViewAuditLogs => isSysAdmin || isOwner;

  /// Financial audit log viewing.
  bool get canViewFinancialAuditLogs => isSysAdmin || isOwner || isManager;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PermissionMatrix &&
          runtimeType == other.runtimeType &&
          user == other.user &&
          listEquals(roleCodes, other.roleCodes);

  @override
  int get hashCode => Object.hash(user, Object.hashAll(roleCodes));
}

/// Riverpod provider for reactive 4-role permission evaluation.
final permissionProvider = Provider<PermissionMatrix>((ref) {
  final authState = ref.watch(authProvider);
  return PermissionMatrix(authState.user);
});
