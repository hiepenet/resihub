import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from '../pages/auth/LoginPage';
import AdminLayout from '../components/layout/AdminLayout';
import DashboardPage from '../pages/admin/dashboard/DashboardPage';
import BuildingsPage from '../pages/admin/buildings/BuildingsPage';
import TenantsPage from '../pages/admin/tenants/TenantsPage';
import ContractsPage from '../pages/admin/contracts/ContractsPage';
import DepositsPage from '../pages/admin/deposits/DepositsPage';
import AccessDenied from '../components/common/AccessDenied';
import { useAuthStore } from '../stores/authStore';

// Protected Route Component (Authentication check)
function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuthStore();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

// Role-based Route Guard (Authorization check)
function RoleRoute({ allowedRoles, children }) {
  const { isAuthenticated, getCurrentRole } = useAuthStore();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  const currentRole = getCurrentRole();
  const isAllowed = currentRole === 'SYS_ADMIN' || (allowedRoles && allowedRoles.includes(currentRole));

  if (!isAllowed) {
    return <AccessDenied currentRole={currentRole} allowedRoles={allowedRoles} />;
  }

  return children;
}

export default function AppRouter() {
  return (
    <Routes>
      {/* Public Auth Routes */}
      <Route path="/login" element={<LoginPage />} />

      {/* Protected Admin Routes */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/admin/dashboard" replace />} />
        
        <Route
          path="dashboard"
          element={
            <RoleRoute allowedRoles={['OWNER', 'MANAGER', 'ACCOUNTANT', 'STAFF', 'SYS_ADMIN']}>
              <DashboardPage />
            </RoleRoute>
          }
        />

        <Route
          path="buildings"
          element={
            <RoleRoute allowedRoles={['OWNER', 'MANAGER', 'STAFF', 'ACCOUNTANT', 'SYS_ADMIN']}>
              <BuildingsPage />
            </RoleRoute>
          }
        />

        <Route
          path="tenants"
          element={
            <RoleRoute allowedRoles={['OWNER', 'MANAGER', 'STAFF', 'ACCOUNTANT', 'SYS_ADMIN']}>
              <TenantsPage />
            </RoleRoute>
          }
        />


        <Route
          path="contracts"
          element={
            <RoleRoute allowedRoles={['OWNER', 'MANAGER', 'ACCOUNTANT', 'SYS_ADMIN']}>
              <ContractsPage />
            </RoleRoute>
          }
        />

        <Route
          path="deposits"
          element={
            <RoleRoute allowedRoles={['OWNER', 'ACCOUNTANT', 'MANAGER', 'SYS_ADMIN']}>
              <DepositsPage />
            </RoleRoute>
          }
        />
      </Route>

      {/* Default Fallback */}
      <Route path="/" element={<Navigate to="/admin/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/admin/dashboard" replace />} />
    </Routes>
  );
}

