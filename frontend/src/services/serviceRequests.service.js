import api from './api';
import { withIdempotency } from '../utils/idempotency';
import { buildCacheKey, cachedFetch, peekQueryCache } from './queryCache';

const SERVICE_REQUESTS_TTL_MS = 20_000;

export const serviceRequestsService = {
  peekList: (params) =>
    peekQueryCache(buildCacheKey('serviceRequests', { op: 'list', ...(params || {}) }))?.data || null,
  list: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('serviceRequests', { op: 'list', ...(params || {}) }),
      () => api.get('/api/v1/service-requests', { params }).then((r) => r.data),
      { ttlMs: SERVICE_REQUESTS_TTL_MS, force: Boolean(options?.force) }
    ),
  peekById: (id) =>
    id
      ? peekQueryCache(buildCacheKey('serviceRequests', { op: 'detail', id }))?.data || null
      : null,
  getById: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('serviceRequests', { op: 'detail', id }),
      () => api.get(`/api/v1/service-requests/${id}`).then((r) => r.data),
      { ttlMs: SERVICE_REQUESTS_TTL_MS, force: Boolean(options?.force) }
    ),
  create: (payload, options = {}) =>
    api.post('/api/v1/service-requests', payload, withIdempotency(options)).then((r) => r.data),
  updateStatus: (id, payload, options = {}) =>
    api
      .patch(`/api/v1/service-requests/${id}/status`, payload, withIdempotency(options))
      .then((r) => r.data),
  applyTriage: (id, payload, options = {}) =>
    api
      .post(`/api/v1/service-requests/${id}/apply-triage`, payload, withIdempotency(options))
      .then((r) => r.data),
  rate: (id, payload, options = {}) =>
    api
      .post(`/api/v1/service-requests/${id}/rating`, payload, withIdempotency(options))
      .then((r) => r.data),
};
