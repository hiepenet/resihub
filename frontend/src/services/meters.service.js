import api from './api';
import { withIdempotency } from '../utils/idempotency';
import { buildCacheKey, cachedFetch, peekQueryCache } from './queryCache';

const METERS_TTL_MS = 20_000;

export const metersService = {
  peekList: (params) =>
    peekQueryCache(buildCacheKey('meters', { op: 'list', ...(params || {}) }))?.data || null,
  list: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('meters', { op: 'list', ...(params || {}) }),
      () => api.get('/api/v1/meters', { params }).then((r) => r.data),
      { ttlMs: METERS_TTL_MS, force: Boolean(options?.force) }
    ),
  create: (payload, options) =>
    api.post('/api/v1/meters', payload, withIdempotency(options)).then((r) => r.data),
  peekReadings: (params) =>
    peekQueryCache(buildCacheKey('meters', { op: 'readings', ...(params || {}) }))?.data || null,
  listReadings: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('meters', { op: 'readings', ...(params || {}) }),
      () => api.get('/api/v1/meters/readings', { params }).then((r) => r.data),
      { ttlMs: METERS_TTL_MS, force: Boolean(options?.force) }
    ),
  listMeterReadings: (id) => api.get(`/api/v1/meters/${id}/readings`).then((r) => r.data),
  recordReading: (id, payload, options) =>
    api.post(`/api/v1/meters/${id}/readings`, payload, withIdempotency(options)).then((r) => r.data),
  recordBatch: (payload, options) =>
    api.post('/api/v1/meters/readings/batch', payload, withIdempotency(options)).then((r) => r.data),
  confirmReading: (readingId, payload = {}, options) =>
    api
      .post(`/api/v1/meters/readings/${readingId}/confirm`, payload, withIdempotency(options))
      .then((r) => r.data),
  confirmBatch: (payload = {}, options) =>
    api
      .post('/api/v1/meters/readings/confirm-batch', payload, withIdempotency(options))
      .then((r) => r.data),
};
