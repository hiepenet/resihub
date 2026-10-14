import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from '../pages/auth/LoginPage';
import AdminLayout from '../components/layout/AdminLayout';
import DashboardPage from '../pages/admin/dashboard/DashboardPage';
import BuildingsPage from '../pages/admin/buildings/BuildingsPage';
import TenantsPage from '../pages/admin/tenants/TenantsPage';
import ContractsPage from '../pages/admin/contracts/ContractsPage';
import DepositsPage from '../pages/admin/deposits/DepositsPage';
import { useAuthStore } from '../stores/authStore';

// Protected Route Component
function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuthStore();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
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
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="buildings" element={<BuildingsPage />} />
        <Route path="tenants" element={<TenantsPage />} />
        <Route path="contracts" element={<ContractsPage />} />
        <Route path="deposits" element={<DepositsPage />} />
      </Route>

      {/* Default Fallback */}
      <Route path="/" element={<Navigate to="/admin/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/admin/dashboard" replace />} />
    </Routes>
  );
}
