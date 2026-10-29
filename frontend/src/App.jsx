import React, { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { ToastContainer } from './components/ui/Toast';
import { useAuthStore } from './stores/authStore';
import { authService } from './services/auth.service';

export function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const updateUser = useAuthStore((s) => s.updateUser);
  const clearSession = useAuthStore((s) => s.clearSession);

  useEffect(() => {
    if (!isAuthenticated) return;
    authService
      .me()
      .then((res) => {
        if (res.user) updateUser(res.user);
      })
      .catch((err) => {
        if (err?.response?.status === 401 || err?.response?.status === 403) {
          clearSession();
        }
      });
  }, [isAuthenticated, updateUser, clearSession]);

  return (
    <>
      <RouterProvider router={router} />
      <ToastContainer />
    </>
  );
}

export default App;
