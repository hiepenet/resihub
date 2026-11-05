import api from './api';
import { withIdempotency } from '../utils/idempotency';
import { buildCacheKey, cachedFetch, peekQueryCache } from './queryCache';

const SETTINGS_TTL_MS = 120_000;

export const usersService = {
  list: (params) => api.get('/api/v1/admin/users', { params }).then((r) => r.data),
  listRoles: () => api.get('/api/v1/admin/users/roles').then((r) => r.data),
  create: (payload) => api.post('/api/v1/admin/users', payload).then((r) => r.data),
  update: (id, payload) => api.patch(`/api/v1/admin/users/${id}`, payload).then((r) => r.data),

  peekSettings: () => peekQueryCache(buildCacheKey('settings', 'global'))?.data || null,
  getSettings: (options = {}) =>
    cachedFetch(
      buildCacheKey('settings', 'global'),
      () => api.get('/api/v1/settings').then((r) => r.data),
      { ttlMs: SETTINGS_TTL_MS, force: Boolean(options?.force) }
    ),
  updateSettings: (settings) =>
    api
      .put('/api/v1/settings', {
        settings,
        ...(settings && typeof settings === 'object' ? settings : {}),
      })
      .then((r) => r.data),

  listCronRuns: (params) =>
    api.get('/api/v1/settings/cron-runs', { params }).then((r) => r.data),
  triggerCronRun: (payload = {}, options) =>
    api
      .post('/api/v1/settings/cron-runs/trigger', payload, withIdempotency(options))
      .then((r) => r.data),
};
