import api from './api';
import { buildCacheKey, cachedFetch, peekQueryCache } from './queryCache';

const TENANTS_TTL_MS = 25_000;

export const tenantsService = {
  peekList: (params) => peekQueryCache(buildCacheKey('tenants', { op: 'list', ...(params || {}) }))?.data || null,
  list: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('tenants', { op: 'list', ...(params || {}) }),
      () => api.get('/api/v1/tenants', { params }).then((r) => r.data),
      { ttlMs: TENANTS_TTL_MS, force: Boolean(options?.force) }
    ),

  peekById: (id) => (id ? peekQueryCache(buildCacheKey('tenants', { op: 'detail', id }))?.data || null : null),
  getById: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('tenants', { op: 'detail', id }),
      () => api.get(`/api/v1/tenants/${id}`).then((r) => r.data),
      { ttlMs: TENANTS_TTL_MS, force: Boolean(options?.force) }
    ),

  peekIdImages: (id) => (id ? peekQueryCache(buildCacheKey('tenants', { op: 'idImages', id }))?.data || null : null),
  getIdImages: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('tenants', { op: 'idImages', id }),
      () => api.get(`/api/v1/tenants/${id}/id-images`).then((r) => r.data),
      { ttlMs: TENANTS_TTL_MS, force: Boolean(options?.force) }
    ),

  lookup: (identifier) => api.get('/api/v1/tenants/lookup', { params: { identifier } }).then((r) => r.data),
  checkDup: (params) => api.get('/api/v1/tenants/check-dup', { params }).then((r) => r.data),
  create: (payload) => api.post('/api/v1/tenants', payload).then((r) => r.data),
  update: (id, payload) => api.patch(`/api/v1/tenants/${id}`, payload).then((r) => r.data),
  remove: (id) => api.delete(`/api/v1/tenants/${id}`).then((r) => r.data),
  merge: (payload) => api.post('/api/v1/tenants/merge', payload).then((r) => r.data),
  uploadIdImage: (id, payload) => api.post(`/api/v1/tenants/${id}/id-images`, payload).then((r) => r.data),
  deleteIdImage: (id, attachmentId) =>
    api.delete(`/api/v1/tenants/${id}/id-images/${attachmentId}`).then((r) => r.data),
};
