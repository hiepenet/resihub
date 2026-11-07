import api from './api';
import { buildCacheKey, cachedFetch, peekQueryCache } from './queryCache';

const CATALOG_TTL_MS = 60_000;
const SUBSCRIPTIONS_TTL_MS = 25_000;

export const servicesService = {
  peekCatalog: (params) =>
    peekQueryCache(buildCacheKey('services', { op: 'catalog', ...(params || {}) }))?.data || null,
  listCatalog: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('services', { op: 'catalog', ...(params || {}) }),
      () => api.get('/api/v1/service-catalog', { params }).then((r) => r.data),
      { ttlMs: CATALOG_TTL_MS, force: Boolean(options?.force) }
    ),
  createCatalog: (payload) => api.post('/api/v1/service-catalog', payload).then((r) => r.data),
  updateCatalog: (id, payload) => api.patch(`/api/v1/service-catalog/${id}`, payload).then((r) => r.data),

  peekSubscriptions: (params) =>
    peekQueryCache(buildCacheKey('services', { op: 'subscriptions', ...(params || {}) }))?.data || null,
  listSubscriptions: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('services', { op: 'subscriptions', ...(params || {}) }),
      () => api.get('/api/v1/service-subscriptions', { params }).then((r) => r.data),
      { ttlMs: SUBSCRIPTIONS_TTL_MS, force: Boolean(options?.force) }
    ),
  createSubscription: (payload) => api.post('/api/v1/service-subscriptions', payload).then((r) => r.data),
  updateSubscription: (id, payload) => api.patch(`/api/v1/service-subscriptions/${id}`, payload).then((r) => r.data),
  terminateSubscription: (id, payload) => api.patch(`/api/v1/service-subscriptions/${id}`, payload).then((r) => r.data),
};
