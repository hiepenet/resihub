import { create } from 'zustand';
import api from '../services/api';

// Xóa bỏ hoàn toàn activeRole lưu trữ cục bộ cũ nếu có để đảm bảo vai trò được lấy chuẩn 100% từ CSDL
try {
  localStorage.removeItem('activeRole');
} catch (e) {
  // ignore
}

export const useAuthStore = create((set, get) => ({
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  accessToken: localStorage.getItem('accessToken') || null,
  refreshToken: localStorage.getItem('refreshToken') || null,
  isAuthenticated: !!localStorage.getItem('accessToken'),

  setAuthData: (accessToken, refreshToken, user) => {
    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.removeItem('activeRole');

    set({
      accessToken,
      refreshToken,
      user,
      isAuthenticated: true,
    });
  },

  // Vai trò được cố định từ CSDL theo đúng tài khoản, không cho phép thay đổi
  setActiveRole: () => {
    console.warn('[RBAC] Vai trò người dùng được cố định từ CSDL, không thể thay đổi.');
  },

  getCurrentRole: () => {
    const { user } = get();
    return user?.roles?.[0]?.code || 'RESIDENT';
  },

  getCurrentRoleInfo: () => {
    const { user } = get();
    return user?.roles?.[0] || { code: 'RESIDENT', name: 'Cư dân' };
  },

  hasRole: (allowedRoles) => {
    const { user } = get();
    if (!user) return false;
    const currentRole = user?.roles?.[0]?.code || 'RESIDENT';
    if (currentRole === 'SYS_ADMIN') return true;
    const rolesArr = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    return rolesArr.includes(currentRole);
  },

  logout: async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } catch (e) {
      // ignore
    } finally {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('user');
      localStorage.removeItem('activeRole');
      set({
        user: null,
        accessToken: null,
        refreshToken: null,
        isAuthenticated: false,
      });
    }
  },

  fetchCurrentUser: async () => {
    try {
      const res = await api.get('/api/v1/auth/me');
      const user = res.data.user;
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.removeItem('activeRole');
      set({
        user,
        isAuthenticated: true,
      });
    } catch (err) {
      get().logout();
    }
  },
}));

