import 'dart:ui';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:flutter_resihub/core/constants/roles.dart';
import 'package:flutter_resihub/core/constants/statuses.dart';
import 'package:flutter_resihub/core/constants/navigation.dart';
import 'package:flutter_resihub/core/utils/resident_nav_helpers.dart';
import 'package:flutter_resihub/core/constants/api_endpoints.dart';

void main() {
  group('Roles & Permissions (roles.dart)', () {
    test('AppRole enum defines all 4 expected roles with codes and labels', () {
      expect(AppRole.values.length, 4);

      expect(AppRole.sysAdmin.code, 'SYS_ADMIN');
      expect(AppRole.sysAdmin.label, 'Quản trị hệ thống');
      expect(AppRole.sysAdmin.badgeVariant, 'indigo');
      expect(AppRole.sysAdmin.isAdminPortal, isTrue);

      expect(AppRole.owner.code, 'OWNER');
      expect(AppRole.owner.label, 'Chủ đầu tư');
      expect(AppRole.owner.badgeVariant, 'amber');
      expect(AppRole.owner.isAdminPortal, isTrue);

      expect(AppRole.manager.code, 'MANAGER');
      expect(AppRole.manager.label, 'Quản lý tòa nhà');
      expect(AppRole.manager.badgeVariant, 'sky');
      expect(AppRole.manager.isAdminPortal, isTrue);

      expect(AppRole.resident.code, 'RESIDENT');
      expect(AppRole.resident.label, 'Cư dân');
      expect(AppRole.resident.badgeVariant, 'purple');
      expect(AppRole.resident.isAdminPortal, isFalse);
    });

    test('AppRole.fromCode parses role strings case-insensitively with fallback', () {
      expect(AppRole.fromCode('SYS_ADMIN'), AppRole.sysAdmin);
      expect(AppRole.fromCode('sys_admin'), AppRole.sysAdmin);
      expect(AppRole.fromCode(' OWNER '), AppRole.owner);
      expect(AppRole.fromCode('manager'), AppRole.manager);
      expect(AppRole.fromCode('RESIDENT'), AppRole.resident);
      expect(AppRole.fromCode('INVALID_ROLE'), AppRole.resident);
      expect(AppRole.fromCode(null), AppRole.resident);
      expect(
        AppRole.fromCode('UNKNOWN', fallback: AppRole.owner),
        AppRole.owner,
      );
    });

    test('kRolePriority follows hierarchical order sysAdmin > owner > manager > resident', () {
      expect(kRolePriority, [
        AppRole.sysAdmin,
        AppRole.owner,
        AppRole.manager,
        AppRole.resident,
      ]);
    });

    test('kAdminPortalRoles contains exactly the 3 management roles', () {
      expect(kAdminPortalRoles, [
        AppRole.sysAdmin,
        AppRole.owner,
        AppRole.manager,
      ]);
      expect(kAdminPortalRoles.contains(AppRole.resident), isFalse);
    });
  });

  group('Statuses & Status Meta (statuses.dart)', () {
    test('StatusDomain contains all 15 required domains', () {
      expect(StatusDomain.values.length, 15);
      expect(StatusDomain.values, containsAll([
        StatusDomain.apartment,
        StatusDomain.contract,
        StatusDomain.deposit,
        StatusDomain.invoice,
        StatusDomain.payment,
        StatusDomain.receivable,
        StatusDomain.reservation,
        StatusDomain.serviceRequest,
        StatusDomain.announcement,
        StatusDomain.priority,
        StatusDomain.subscription,
        StatusDomain.tenant,
        StatusDomain.user,
        StatusDomain.invoiceAdjustment,
        StatusDomain.creditBalance,
      ]));
    });

    test('Apartment domain resolves all 6 official apartment statuses with color meta', () {
      final available = resolveStatusMeta(StatusDomain.apartment, 'AVAILABLE');
      expect(available.code, 'AVAILABLE');
      expect(available.label, 'Còn trống');
      expect(available.variant, 'emerald');
      expect(available.color, isA<Color>());
      expect(available.bgColor, isA<Color>());
      expect(available.borderColor, isA<Color>());

      final occupied = resolveStatusMeta(StatusDomain.apartment, 'OCCUPIED');
      expect(occupied.code, 'OCCUPIED');
      expect(occupied.label, 'Đang thuê');
      expect(occupied.variant, 'red');

      final reserved = resolveStatusMeta(StatusDomain.apartment, 'RESERVED');
      expect(reserved.code, 'RESERVED');
      expect(reserved.label, 'Đã giữ chỗ');
      expect(reserved.variant, 'amber');

      final maintenance = resolveStatusMeta(StatusDomain.apartment, 'MAINTENANCE');
      expect(maintenance.code, 'MAINTENANCE');
      expect(maintenance.label, 'Đang bảo trì');
      expect(maintenance.variant, 'slate');

      final blocked = resolveStatusMeta(StatusDomain.apartment, 'BLOCKED');
      expect(blocked.code, 'BLOCKED');
      expect(blocked.label, 'Tạm khóa');
      expect(blocked.variant, 'purple');

      final inactive = resolveStatusMeta(StatusDomain.apartment, 'INACTIVE');
      expect(inactive.code, 'INACTIVE');
      expect(inactive.label, 'Ngưng khai thác');
      expect(inactive.variant, 'purple');
    });

    test('Resolves statuses correctly for the other 14 domains', () {
      // Contract
      final contractActive = resolveStatusMeta(StatusDomain.contract, 'ACTIVE');
      expect(contractActive.label, 'Đang hiệu lực');
      expect(contractActive.variant, 'emerald');

      // Deposit
      final depositHeld = resolveStatusMeta(StatusDomain.deposit, 'HELD');
      expect(depositHeld.label, 'Đang giữ cọc');
      expect(depositHeld.variant, 'sky');

      // Invoice
      final invoicePaid = resolveStatusMeta(StatusDomain.invoice, 'PAID');
      expect(invoicePaid.label, 'Đã thanh toán');
      expect(invoicePaid.variant, 'emerald');

      // Payment
      final paymentConfirmed = resolveStatusMeta(StatusDomain.payment, 'CONFIRMED');
      expect(paymentConfirmed.label, 'Đã xác nhận');
      expect(paymentConfirmed.variant, 'emerald');

      // Receivable
      final receivableOpen = resolveStatusMeta(StatusDomain.receivable, 'OPEN');
      expect(receivableOpen.label, 'Chưa thu');
      expect(receivableOpen.variant, 'red');

      // Reservation
      final resConverted = resolveStatusMeta(StatusDomain.reservation, 'CONVERTED');
      expect(resConverted.label, 'Đã lên hợp đồng');
      expect(resConverted.variant, 'emerald');

      // Service Request
      final srInProgress = resolveStatusMeta(StatusDomain.serviceRequest, 'IN_PROGRESS');
      expect(srInProgress.label, 'Đang xử lý');
      expect(srInProgress.variant, 'amber');

      // Announcement
      final annSent = resolveStatusMeta(StatusDomain.announcement, 'SENT');
      expect(annSent.label, 'Đã phát hành');
      expect(annSent.variant, 'emerald');

      // Priority
      final prioUrgent = resolveStatusMeta(StatusDomain.priority, 'URGENT');
      expect(prioUrgent.label, 'Khẩn cấp');
      expect(prioUrgent.variant, 'red');

      // Subscription
      final subActive = resolveStatusMeta(StatusDomain.subscription, 'ACTIVE');
      expect(subActive.label, 'Đang sử dụng');
      expect(subActive.variant, 'emerald');

      // Tenant
      final tenantActive = resolveStatusMeta(StatusDomain.tenant, 'ACTIVE');
      expect(tenantActive.label, 'Đang thuê');
      expect(tenantActive.variant, 'emerald');

      // User
      final userSuspended = resolveStatusMeta(StatusDomain.user, 'SUSPENDED');
      expect(userSuspended.label, 'Tạm khóa');
      expect(userSuspended.variant, 'red');

      // Invoice Adjustment
      final adjApproved = resolveStatusMeta(StatusDomain.invoiceAdjustment, 'APPROVED');
      expect(adjApproved.label, 'Đã duyệt');
      expect(adjApproved.variant, 'emerald');

      // Credit Balance
      final cbAvailable = resolveStatusMeta(StatusDomain.creditBalance, 'AVAILABLE');
      expect(cbAvailable.label, 'Khả dụng');
      expect(cbAvailable.variant, 'emerald');
    });

    test('resolveStatusMeta gracefully falls back on unknown or null code', () {
      final nullMeta = resolveStatusMeta(StatusDomain.apartment, null);
      expect(nullMeta.code, 'UNKNOWN');
      expect(nullMeta.label, 'Không xác định');
      expect(nullMeta.variant, 'slate');
      expect(nullMeta.color, isNotNull);

      final unknownMeta = resolveStatusMeta(StatusDomain.invoice, 'NON_EXISTENT_STATUS');
      expect(unknownMeta.code, 'NON_EXISTENT_STATUS');
      expect(unknownMeta.label, 'NON_EXISTENT_STATUS');
      expect(unknownMeta.variant, 'slate');
    });

    test('Auxiliary constants: payment methods, invoice lines, slots, categories', () {
      expect(kPaymentMethodOptions.length, 6);
      expect(kPaymentMethodOptions.map((o) => o.value), containsAll([
        'BANK_TRANSFER', 'QR_CODE', 'E_WALLET', 'CASH', 'CARD', 'OTHER',
      ]));

      expect(kInvoiceLineTypes.containsKey('RENT'), isTrue);
      expect(kInvoiceLineTypes['RENT']?.label, 'Tiền thuê phòng');
      expect(kInvoiceLineTypes['ELECTRICITY']?.label, 'Tiền điện');
      expect(kInvoiceLineTypes['WATER']?.label, 'Tiền nước');

      expect(kPreferredSlotLabels.containsKey('MORNING_08_12'), isTrue);
      expect(kPreferredSlotLabels['MORNING_08_12'], 'Sáng (08:00 – 12:00)');
      expect(kPreferredSlotLabels['ANYTIME'], 'Linh hoạt cả ngày');

      expect(kServiceRequestCategories.containsKey('ELECTRICAL'), isTrue);
      expect(kServiceRequestCategories['ELECTRICAL'], 'Điện chiếu sáng / Ổ cắm');
      expect(kServiceRequestCategories['SECURITY'], 'An ninh / Khóa cửa');
    });
  });

  group('Navigation Configuration (navigation.dart)', () {
    test('kAdminNavGroups defines 4 groups and exactly 14 total items', () {
      expect(kAdminNavGroups.length, 4);

      final groupNames = kAdminNavGroups.map((g) => g.group).toList();
      expect(groupNames, [
        'Tổng quan',
        'Khai thác & Cư dân',
        'Tài chính & Vận hành',
        'Hệ thống & Báo cáo',
      ]);

      final allItems = kAdminNavGroups.expand((g) => g.items).toList();
      expect(allItems.length, 14);

      // Group 1: Tổng quan
      expect(kAdminNavGroups[0].items.length, 1);
      expect(kAdminNavGroups[0].items[0].label, 'Bảng điều khiển');
      expect(kAdminNavGroups[0].items[0].path, '/admin/dashboard');
      expect(kAdminNavGroups[0].items[0].icon, LucideIcons.layoutDashboard);

      // Group 2: Khai thác & Cư dân
      expect(kAdminNavGroups[1].items.length, 4);
      expect(kAdminNavGroups[1].items.map((i) => i.label), [
        'Bất động sản',
        'Hồ sơ Cư dân',
        'Hợp đồng thuê',
        'Quản lý Tiền cọc',
      ]);

      // Group 3: Tài chính & Vận hành
      expect(kAdminNavGroups[2].items.length, 5);
      expect(kAdminNavGroups[2].items.map((i) => i.label), [
        'Chỉ số Điện / Nước',
        'Dịch vụ & Tiện ích',
        'Hóa đơn kỳ',
        'Thanh toán & Công nợ',
        'Yêu cầu & Báo hỏng',
      ]);

      // Group 4: Hệ thống & Báo cáo
      expect(kAdminNavGroups[3].items.length, 4);
      expect(kAdminNavGroups[3].items.map((i) => i.label), [
        'Thông báo cư dân',
        'Báo cáo thống kê',
        'Nhật ký hệ thống',
        'Người dùng & Cấu hình',
      ]);
    });

    test('Role filtering in Admin Nav matches roles.js specification', () {
      final auditLogItem = kAdminNavGroups[3].items.firstWhere((i) => i.path == '/admin/audit-logs');
      expect(auditLogItem.roles, [AppRole.sysAdmin, AppRole.owner]);

      final userItem = kAdminNavGroups[3].items.firstWhere((i) => i.path == '/admin/users');
      expect(userItem.roles, [AppRole.sysAdmin]);

      final dashboardItem = kAdminNavGroups[0].items.firstWhere((i) => i.path == '/admin/dashboard');
      expect(dashboardItem.roles, [AppRole.sysAdmin, AppRole.owner, AppRole.manager]);
    });

    test('kResidentPortalTabs defines 8 resident tabs with codes P1..P8', () {
      expect(kResidentPortalTabs.length, 8);

      final expectedCodes = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
      final actualCodes = kResidentPortalTabs.map((t) => t.code).toList();
      expect(actualCodes, expectedCodes);

      final expectedIds = [
        'overview',
        'contract',
        'invoices',
        'services',
        'maintenance',
        'notifications',
        'contact',
        'profile',
      ];
      final actualIds = kResidentPortalTabs.map((t) => t.id).toList();
      expect(actualIds, expectedIds);

      // Icons check
      expect(kResidentPortalTabs[0].icon, LucideIcons.home);
      expect(kResidentPortalTabs[1].icon, LucideIcons.fileText);
      expect(kResidentPortalTabs[2].icon, LucideIcons.receipt);
      expect(kResidentPortalTabs[3].icon, LucideIcons.sparkles);
      expect(kResidentPortalTabs[4].icon, LucideIcons.wrench);
      expect(kResidentPortalTabs[5].icon, LucideIcons.bell);
      expect(kResidentPortalTabs[6].icon, LucideIcons.phoneCall);
      expect(kResidentPortalTabs[7].icon, LucideIcons.userCircle);
    });
  });

  group('Resident Mobile Navigation Helpers (resident_nav_helpers.dart)', () {
    test('resolveResidentMobileNavState splits 4 primary tabs and 4 secondary tabs', () {
      final state = resolveResidentMobileNavState(activeTab: 'overview', unreadCount: 0);

      expect(state.primaryTabs.length, 4);
      expect(state.primaryTabs.map((t) => t.id), ['overview', 'invoices', 'maintenance', 'services']);

      expect(state.secondaryTabs.length, 4);
      expect(state.secondaryTabs.map((t) => t.id), ['contract', 'notifications', 'contact', 'profile']);

      expect(state.isMoreActive, isFalse);
      expect(state.activeSecondaryTab, isNull);
      expect(state.moreBadgeCount, 0);
    });

    test('resolveResidentMobileNavState sets isMoreActive=true when a secondary tab is active', () {
      final state = resolveResidentMobileNavState(activeTab: 'profile', unreadCount: 5);

      expect(state.isMoreActive, isTrue);
      expect(state.activeSecondaryTab?.id, 'profile');
      expect(state.moreBadgeCount, 5);
    });

    test('resolveResidentMobileNavState clamps negative unreadCount to 0', () {
      final state = resolveResidentMobileNavState(activeTab: 'overview', unreadCount: -3);
      expect(state.moreBadgeCount, 0);
    });

    test('getResidentActionTapCount returns tap budget according to UX specs', () {
      expect(getResidentActionTapCount('view_overview'), 1);
      expect(getResidentActionTapCount('pay_invoice'), 2);
      expect(getResidentActionTapCount('create_maintenance'), 2);
      expect(getResidentActionTapCount('non_existent_action'), 2);
    });
  });

  group('API Endpoints (api_endpoints.dart)', () {
    test('ApiEndpoints base paths match server.js routes with /api/v1 prefix', () {
      expect(ApiEndpoints.prefix, '/api/v1');
      expect(ApiEndpoints.auth, '/api/v1/auth');
      expect(ApiEndpoints.buildings, '/api/v1/buildings');
      expect(ApiEndpoints.apartments, '/api/v1/apartments');
      expect(ApiEndpoints.tenants, '/api/v1/tenants');
      expect(ApiEndpoints.contracts, '/api/v1/contracts');
      expect(ApiEndpoints.attachments, '/api/v1/attachments');
      expect(ApiEndpoints.deposits, '/api/v1/deposits');
      expect(ApiEndpoints.reservations, '/api/v1/reservations');
      expect(ApiEndpoints.notifications, '/api/v1/notifications');
      expect(ApiEndpoints.announcements, '/api/v1/announcements');
      expect(ApiEndpoints.zaloGroups, '/api/v1/zalo-groups');
      expect(ApiEndpoints.resident, '/api/v1/resident');
      expect(ApiEndpoints.serviceRequests, '/api/v1/service-requests');
      expect(ApiEndpoints.meters, '/api/v1/meters');
      expect(ApiEndpoints.services, '/api/v1/services');
      expect(ApiEndpoints.serviceCatalog, '/api/v1/service-catalog');
      expect(ApiEndpoints.serviceSubscriptions, '/api/v1/service-subscriptions');
      expect(ApiEndpoints.invoices, '/api/v1/invoices');
      expect(ApiEndpoints.payments, '/api/v1/payments');
      expect(ApiEndpoints.receivables, '/api/v1/receivables');
      expect(ApiEndpoints.adminUsers, '/api/v1/admin/users');
      expect(ApiEndpoints.auditLogs, '/api/v1/audit-logs');
      expect(ApiEndpoints.settings, '/api/v1/settings');
      expect(ApiEndpoints.reports, '/api/v1/reports');
      expect(ApiEndpoints.public, '/api/v1/public');
      expect(ApiEndpoints.ai, '/api/v1/ai');
    });

    test('ApiEndpoints attachment helper methods format URLs correctly', () {
      expect(ApiEndpoints.attachmentView('abc-123'), '/api/v1/attachments/abc-123/view');
      expect(ApiEndpoints.attachmentDownload('abc-123'), '/api/v1/attachments/abc-123/download');
    });
  });
}
