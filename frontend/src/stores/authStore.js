import { create } from 'zustand';
import api from '../services/api';

export const useAuthStore = create((set, get) => ({
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  accessToken: localStorage.getItem('accessToken') || null,
  refreshToken: localStorage.getItem('refreshToken') || null,
  isAuthenticated: !!localStorage.getItem('accessToken'),
  activeRole: null,

  setAuthData: (accessToken, refreshToken, user) => {
    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    localStorage.setItem('user', JSON.stringify(user));

    const defaultRole = user.roles && user.roles.length > 0 ? user.roles[0].code : 'RESIDENT';

    set({
      accessToken,
      refreshToken,
      user,
      isAuthenticated: true,
      activeRole: defaultRole,
    });
  },

  setActiveRole: (roleCode) => {
    set({ activeRole: roleCode });
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
      set({
        user: null,
        accessToken: null,
        refreshToken: null,
        isAuthenticated: false,
        activeRole: null,
      });
    }
  },

  fetchCurrentUser: async () => {
    try {
      const res = await api.get('/api/v1/auth/me');
      const user = res.data.user;
      localStorage.setItem('user', JSON.stringify(user));
      set({
        user,
        isAuthenticated: true,
        activeRole: get().activeRole || (user.roles?.[0]?.code || 'RESIDENT'),
      });
    } catch (err) {
      get().logout();
    }
  },
}));
