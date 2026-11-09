import axios from 'axios';
import { useAuthStore } from '../stores/authStore';
import { createIdempotencyKey } from '../utils/idempotency';
import { invalidateRelatedNamespacesForUrl } from './queryCache';

const api = axios.create({
  baseURL: '',
  headers: {
    'Content-Type': 'application/json',
  },
});

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const IDEMPOTENT_FINANCIAL_ENDPOINTS = [
  '/api/v1/invoices',
  '/api/v1/payments',
  '/api/v1/services',
  '/api/v1/service-catalog',
  '/api/v1/service-subscriptions',
  '/api/v1/contracts',
  '/api/v1/deposits',
  '/api/v1/resident',
  '/api/v1/meters',
  '/api/v1/reservations',
  '/api/v1/public/reservations',
  '/api/v1/service-requests',
  '/api/v1/announcements',
  '/api/v1/notifications',
  '/api/v1/zalo-groups',
  '/api/v1/ai',
  '/api/v1/settings',
];

api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    const method = String(config.method || 'get').toUpperCase();
    if (MUTATING_METHODS.has(method)) {
      const url = config.url || '';
      const isTarget = IDEMPOTENT_FINANCIAL_ENDPOINTS.some((ep) => url.includes(ep));
      if (isTarget && !config.headers['Idempotency-Key']) {
        config.headers['Idempotency-Key'] = createIdempotencyKey();
      }
    }

    return config;
  },
  (error) => Promise.reject(error)
);

let refreshPromise = null;

api.interceptors.response.use(
  (response) => {
    const method = String(response?.config?.method || 'get').toUpperCase();
    if (MUTATING_METHODS.has(method) && !response?.config?.skipCacheInvalidation) {
      invalidateRelatedNamespacesForUrl(response?.config?.url);
    }
    return response;
  },
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
