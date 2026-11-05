export const routeImporters = {
  publicExplore: () => import('../pages/public/PublicExplorePage'),
  login: () => import('../pages/auth/LoginPage'),
  forgotPassword: () => import('../pages/auth/ForgotPasswordPage'),

  dashboard: () => import('../pages/admin/dashboard/DashboardPage'),
  buildings: () => import('../pages/admin/buildings/BuildingsPage'),
  buildingDetail: () => import('../pages/admin/buildings/BuildingDetailPage'),
  zoneDetail: () => import('../pages/admin/buildings/ZoneDetailPage'),
  floorPlan: () => import('../pages/admin/buildings/FloorPlanPage'),
  apartmentDetail: () => import('../pages/admin/apartments/ApartmentDetailPage'),

  tenants: () => import('../pages/admin/tenants/TenantsPage'),
  tenantDetail: () => import('../pages/admin/tenants/TenantDetailPage'),

  contracts: () => import('../pages/admin/contracts/ContractsPage'),
  contractDetail: () => import('../pages/admin/contracts/ContractDetailPage'),

  deposits: () => import('../pages/admin/deposits/DepositsPage'),
  services: () => import('../pages/admin/services/ServiceCatalogPage'),
  subscriptions: () => import('../pages/admin/services/SubscriptionsPage'),
  meters: () => import('../pages/admin/meters/MeterReadingsPage'),
  invoices: () => import('../pages/admin/invoices/InvoicesPage'),
  invoiceDetail: () => import('../pages/admin/invoices/InvoiceDetailPage'),
  payments: () => import('../pages/admin/payments/PaymentsPage'),
  maintenance: () => import('../pages/admin/maintenance/ServiceRequestsPage'),
  notifications: () => import('../pages/admin/notifications/NotificationsPage'),
  reports: () => import('../pages/admin/reports/ReportsPage'),
  users: () => import('../pages/admin/users/UsersPage'),
  settings: () => import('../pages/admin/settings/SettingsPage'),
  auditLogs: () => import('../pages/admin/audit/AuditLogsPage'),

  residentPortal: () => import('../pages/resident/ResidentPortalPage'),
};

export const ROUTE_IMPORT_MAP = {
  '/admin/dashboard': [routeImporters.dashboard],
  '/admin/buildings': [
    routeImporters.buildings,
    routeImporters.buildingDetail,
    routeImporters.floorPlan,
    routeImporters.apartmentDetail,
  ],
  '/admin/buildings/floor-plan': [routeImporters.floorPlan, routeImporters.apartmentDetail],
  '/admin/tenants': [routeImporters.tenants, routeImporters.tenantDetail],
  '/admin/contracts': [routeImporters.contracts, routeImporters.contractDetail],
  '/admin/deposits': [routeImporters.deposits],
  '/admin/services': [routeImporters.services],
  '/admin/services/subscriptions': [routeImporters.subscriptions],
  '/admin/meters': [routeImporters.meters],
  '/admin/invoices': [routeImporters.invoices, routeImporters.invoiceDetail],
  '/admin/payments': [routeImporters.payments],
  '/admin/maintenance': [routeImporters.maintenance],
  '/admin/notifications': [routeImporters.notifications],
  '/admin/reports': [routeImporters.reports],
  '/admin/audit-logs': [routeImporters.auditLogs],
  '/admin/settings': [routeImporters.settings],
  '/admin/users': [routeImporters.users],
};

const preloadedPaths = new Set();

export function preloadRouteChunk(path) {
  const cleanPath = String(path || '').trim();
  if (!cleanPath || preloadedPaths.has(cleanPath)) return;
  const importers = ROUTE_IMPORT_MAP[cleanPath];
  if (!importers) return;

  preloadedPaths.add(cleanPath);
  for (const load of importers) {
    try {
      Promise.resolve(load()).catch(() => {
        preloadedPaths.delete(cleanPath);
      });
    } catch {
      preloadedPaths.delete(cleanPath);
    }
  }
}

let coreWarmScheduled = false;

export function preloadCoreAdminNavigationChunks() {
  if (coreWarmScheduled) return;
  coreWarmScheduled = true;

  const warm = () => {
    preloadRouteChunk('/admin/buildings');
    preloadRouteChunk('/admin/tenants');
    preloadRouteChunk('/admin/contracts');
  };

  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(warm, { timeout: 1500 });
  } else {
    setTimeout(warm, 350);
  }
}
