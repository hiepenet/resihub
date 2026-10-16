import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from '../pages/auth/LoginPage';
import AdminLayout from '../components/layout/AdminLayout';
import DashboardPage from '../pages/admin/dashboard/DashboardPage';
import BuildingsPage from '../pages/admin/buildings/BuildingsPage';
import TenantsPage from '../pages/admin/tenants/TenantsPage';
import ContractsPage from '../pages/admin/contracts/ContractsPage';
import DepositsPage from '../pages/admin/deposits/DepositsPage';
import ResidentLayout from '../components/layout/ResidentLayout';
import ResidentPortalPage from '../pages/resident/ResidentPortalPage';
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
  const isAllowed = allowedRoles && allowedRoles.includes(currentRole);

  if (!isAllowed) {
    return <AccessDenied currentRole={currentRole} allowedRoles={allowedRoles} />;
  }

  return children;
}

// Smart Root / Fallback Redirection based on user role
function RootRedirect() {
  const { isAuthenticated, getCurrentRole } = useAuthStore();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  const role = getCurrentRole();
  if (role === 'RESIDENT') {
    return <Navigate to="/resident" replace />;
  }
  return <Navigate to="/admin/dashboard" replace />;
}

export default function AppRouter() {
  return (
    <Routes>
      {/* Public Auth Routes */}
      <Route path="/login" element={<LoginPage />} />

      {/* Protected Resident Routes */}
      <Route
        path="/resident"
        element={
          <ProtectedRoute>
            <RoleRoute allowedRoles={['RESIDENT']}>
              <ResidentLayout />
            </RoleRoute>
          </ProtectedRoute>
        }
      >
        <Route index element={<ResidentPortalPage />} />
        <Route path="apartment" element={<ResidentPortalPage />} />
      </Route>

      {/* Protected Admin Routes */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<RootRedirect />} />
        
        <Route
          path="dashboard"
          element={
            <RoleRoute allowedRoles={['OWNER', 'MANAGER']}>
              <DashboardPage />
            </RoleRoute>
          }
        />

        <Route
          path="buildings"
          element={
            <RoleRoute allowedRoles={['OWNER', 'MANAGER']}>
              <BuildingsPage />
            </RoleRoute>
          }
        />

        <Route
          path="tenants"
          element={
            <RoleRoute allowedRoles={['OWNER', 'MANAGER']}>
              <TenantsPage />
            </RoleRoute>
          }
        />

        <Route
          path="contracts"
          element={
            <RoleRoute allowedRoles={['OWNER', 'MANAGER']}>
              <ContractsPage />
            </RoleRoute>
          }
        />

        <Route
          path="deposits"
          element={
            <RoleRoute allowedRoles={['OWNER', 'MANAGER']}>
              <DepositsPage />
            </RoleRoute>
          }
        />
      </Route>

      {/* Default Fallback */}
      <Route path="/" element={<RootRedirect />} />
      <Route path="*" element={<RootRedirect />} />
    </Routes>
  );
}
