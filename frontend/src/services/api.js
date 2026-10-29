import axios from 'axios';
import { useAuthStore } from '../stores/authStore';

const api = axios.create({
  baseURL: '',
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

let refreshPromise = null;

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const isAuthEndpoint = originalRequest?.url?.includes('/api/v1/auth/login') ||
      originalRequest?.url?.includes('/api/v1/auth/otp/') ||
      originalRequest?.url?.includes('/api/v1/auth/refresh');

    if (error.response?.status === 401 && !originalRequest?._retry && !isAuthEndpoint) {
      originalRequest._retry = true;
      const refreshToken = localStorage.getItem('refreshToken');

      if (refreshToken) {
        try {
          if (!refreshPromise) {
            refreshPromise = axios
              .post('/api/v1/auth/refresh', { refreshToken })
              .finally(() => {
                refreshPromise = null;
              });
          }
          const res = await refreshPromise;
          const { accessToken: newAccessToken, user: refreshedUser } = res.data;

          localStorage.setItem('accessToken', newAccessToken);
          if (refreshedUser) {
            useAuthStore.getState().updateUser(refreshedUser);
          }

          originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
          return api(originalRequest);
        } catch {
          useAuthStore.getState().clearSession();
          if (window.location.pathname !== '/login') {
            window.location.href = '/login';
          }
        }
      } else {
        useAuthStore.getState().clearSession();
      }
    }

    return Promise.reject(error);
  }
);

export async function fetchAuthBlobUrl(url) {
  if (!url) return null;
  if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  const res = await api.get(url, { responseType: 'blob' });
  return URL.createObjectURL(res.data);
}

export default api;
