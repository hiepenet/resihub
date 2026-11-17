/// Canonical API endpoints for the ResiHub backend services.
/// Defined according to api/src/server.js route mountings.
class ApiEndpoints {
  ApiEndpoints._();

  /// Root API v1 prefix.
  static const String prefix = '/api/v1';

  // System & Health
  static const String health = '/api/health';

  // Core business route base paths
  static const String auth = '$prefix/auth';
  static const String buildings = '$prefix/buildings';
  static const String apartments = '$prefix/apartments';
  static const String tenants = '$prefix/tenants';
  static const String contracts = '$prefix/contracts';
  static const String attachments = '$prefix/attachments';
  static const String deposits = '$prefix/deposits';
  static const String reservations = '$prefix/reservations';
  static const String notifications = '$prefix/notifications';
  static const String announcements = '$prefix/announcements';
  static const String zaloGroups = '$prefix/zalo-groups';
  static const String resident = '$prefix/resident';
  static const String serviceRequests = '$prefix/service-requests';
  static const String meters = '$prefix/meters';
  static const String services = '$prefix/services';
  static const String serviceCatalog = '$prefix/service-catalog';
  static const String serviceSubscriptions = '$prefix/service-subscriptions';
  static const String invoices = '$prefix/invoices';
  static const String payments = '$prefix/payments';
  static const String receivables = '$prefix/receivables';
  static const String adminUsers = '$prefix/admin/users';
  static const String auditLogs = '$prefix/audit-logs';
  static const String settings = '$prefix/settings';
  static const String reports = '$prefix/reports';
  static const String public = '$prefix/public';
  static const String ai = '$prefix/ai';

  // Auth sub-routes
  static const String authPublicConfig = '$auth/public-config';
  static const String authLogin = '$auth/login';
  static const String authLogout = '$auth/logout';
  static const String authMe = '$auth/me';
  static const String authRefresh = '$auth/refresh';
  static const String authOtpRequest = '$auth/otp/request';
  static const String authOtpVerify = '$auth/otp/verify';
  static const String authProfile = '$auth/profile';
  static const String authChangePassword = '$auth/change-password';
  static const String authForgotPassword = '$auth/forgot-password';
  static const String authResetPassword = '$auth/reset-password';

  // Resident portal sub-routes
  static const String residentOverview = '$resident/overview';
  static const String residentInvoices = '$resident/invoices';
  static const String residentContracts = '$resident/contracts';
  static const String residentDeposits = '$resident/deposits';
  static const String residentServices = '$resident/services';
  static const String residentServiceRequests = '$resident/service-requests';
  static const String residentNotifications = '$resident/notifications';
  static const String residentProfile = '$resident/profile';

  // Dynamic attachment URL builders
  static String attachmentView(String id) => '$attachments/$id/view';
  static String attachmentDownload(String id) => '$attachments/$id/download';
}
