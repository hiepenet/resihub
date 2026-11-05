import React, { Suspense, lazy } from 'react';
import { createBrowserRouter, Navigate, useParams } from 'react-router-dom';
import { AdminLayout } from '../components/layout/AdminLayout';
import { PageSkeleton } from '../components/ui/Skeleton';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { AccessDenied } from '../components/common/AccessDenied';
import { useAuthStore } from '../stores/authStore';
import { ROLES, ADMIN_PORTAL_ROLES } from '../constants/roles';

import { routeImporters } from './routePreloaders';

// Lazy-loaded pages (shared with routePreloaders for hover/idle warmup)
const PublicExplorePage = lazy(routeImporters.publicExplore);
const LoginPage = lazy(routeImporters.login);
const ForgotPasswordPage = lazy(routeImporters.forgotPassword);

const DashboardPage = lazy(routeImporters.dashboard);
const BuildingsPage = lazy(routeImporters.buildings);
const BuildingDetailPage = lazy(routeImporters.buildingDetail);
const ZoneDetailPage = lazy(routeImporters.zoneDetail);
const FloorPlanPage = lazy(routeImporters.floorPlan);
const ApartmentDetailPage = lazy(routeImporters.apartmentDetail);

const TenantsPage = lazy(routeImporters.tenants);
const TenantDetailPage = lazy(routeImporters.tenantDetail);

const ContractsPage = lazy(routeImporters.contracts);
const ContractDetailPage = lazy(routeImporters.contractDetail);

const DepositsPage = lazy(routeImporters.deposits);

const ServiceCatalogPage = lazy(routeImporters.services);
const SubscriptionsPage = lazy(routeImporters.subscriptions);
const MeterReadingsPage = lazy(routeImporters.meters);
const InvoicesPage = lazy(routeImporters.invoices);
const InvoiceDetailPage = lazy(routeImporters.invoiceDetail);
const PaymentsPage = lazy(routeImporters.payments);
const ServiceRequestsPage = lazy(routeImporters.maintenance);
const NotificationsPage = lazy(routeImporters.notifications);
const ReportsPage = lazy(routeImporters.reports);
const UsersPage = lazy(routeImporters.users);
const SettingsPage = lazy(routeImporters.settings);
const AuditLogsPage = lazy(routeImporters.auditLogs);

const ResidentPortalPage = lazy(routeImporters.residentPortal);

function RouteKeyWrapper({ Component }) {
  const { id, zoneId } = useParams();
  const routeKey = zoneId ? `${id || ''}:${zoneId}` : id || 'static';
  return React.createElement(Component, { key: routeKey });
}

function withSuspense(Component, fullScreen = false) {
  return (
    <Suspense fallback={fullScreen ? <LoadingSpinner fullScreen /> : <PageSkeleton />}>
      <RouteKeyWrapper Component={Component} />
    </Suspense>
  );
}

function RootRedirect() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isAdminPortal = useAuthStore((s) => s.isAdminPortal);
  if (!isAuthenticated) return withSuspense(PublicExplorePage, true);
  return <Navigate to={isAdminPortal() ? '/admin/dashboard' : '/resident'} replace />;
}

function RequireAuth({ children }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

function RequireAdminPortal({ children }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hasRole = useAuthStore((s) => s.hasRole);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!hasRole(ADMIN_PORTAL_ROLES)) {
    return <Navigate to="/resident" replace />;
  }
  return children;
}

function RoleGuard({ allowedRoles, children }) {
  const hasRole = useAuthStore((s) => s.hasRole);
  if (!hasRole(allowedRoles)) {
    return <AccessDenied />;
  }
  return children;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootRedirect />,
  },
  {
    path: '/explore',
    element: withSuspense(PublicExplorePage, true),
  },
  {
    path: '/login',
    element: withSuspense(LoginPage, true),
  },
  {
    path: '/forgot-password',
    element: withSuspense(ForgotPasswordPage, true),
  },
  {
    path: '/admin',
    element: (
      <RequireAdminPortal>
        <AdminLayout />
      </RequireAdminPortal>
    ),
    children: [
      { index: true, element: <Navigate to="/admin/dashboard" replace /> },
      { path: 'dashboard', element: withSuspense(DashboardPage) },

      // Bất động sản (M03)
      {
        path: 'buildings',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(BuildingsPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'buildings/floor-plan',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(FloorPlanPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'buildings/:id',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(BuildingDetailPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'buildings/:id/zones/:zoneId',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(ZoneDetailPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'buildings/:id/floor-plan',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(FloorPlanPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'apartments/:id',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(ApartmentDetailPage)}
          </RoleGuard>
        ),
      },

      // Cư dân (M04)
      {
        path: 'tenants',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(TenantsPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'tenants/:id',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(TenantDetailPage)}
          </RoleGuard>
        ),
      },

      // Hợp đồng (M05) & Tiền cọc (M06)
      {
        path: 'contracts',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(ContractsPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'contracts/:id',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(ContractDetailPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'deposits',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(DepositsPage)}
          </RoleGuard>
        ),
      },

      // Dịch vụ (M07) & Điện nước (M08)
      {
        path: 'services',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(ServiceCatalogPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'services/subscriptions',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(SubscriptionsPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'meters',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(MeterReadingsPage)}
          </RoleGuard>
        ),
      },

      // Hóa đơn (M09) & Thanh toán/Công nợ (M10)
      {
        path: 'invoices',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(InvoicesPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'invoices/:id',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(InvoiceDetailPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'payments',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(PaymentsPage)}
          </RoleGuard>
        ),
      },

      // Bảo trì (M11), Thông báo (M13), Báo cáo (M14), Quản trị user & Nhật ký (M01)
      {
        path: 'maintenance',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(ServiceRequestsPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'notifications',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(NotificationsPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'reports',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER, ROLES.MANAGER]}>
            {withSuspense(ReportsPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'audit-logs',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN, ROLES.OWNER]}>
            {withSuspense(AuditLogsPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'settings',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN]}>
            {withSuspense(SettingsPage)}
          </RoleGuard>
        ),
      },
      {
        path: 'users',
        element: (
          <RoleGuard allowedRoles={[ROLES.SYS_ADMIN]}>
            {withSuspense(UsersPage)}
          </RoleGuard>
        ),
      },
    ],
  },
  {
    path: '/resident',
    element: (
      <RequireAuth>
        {withSuspense(ResidentPortalPage, true)}
      </RequireAuth>
    ),
  },
  {
    path: '*',
    element: <RootRedirect />,
  },
]);

export default router;
