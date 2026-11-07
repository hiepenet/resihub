import api from './api';
import { buildCacheKey, cachedFetch, peekQueryCache } from './queryCache';

const PAYMENTS_TTL_MS = 20_000;

export const paymentsService = {
  peekList: (params) =>
    peekQueryCache(buildCacheKey('payments', { op: 'list', ...(params || {}) }))?.data || null,
  list: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('payments', { op: 'list', ...(params || {}) }),
      () => api.get('/api/v1/payments', { params }).then((r) => r.data),
      { ttlMs: PAYMENTS_TTL_MS, force: Boolean(options?.force) }
    ),
  create: (payload) => api.post('/api/v1/payments', payload).then((r) => r.data),
  confirm: (id, payload = {}) => api.patch(`/api/v1/payments/${id}/confirm`, payload).then((r) => r.data),
  reject: (id, payload) => api.patch(`/api/v1/payments/${id}/reject`, payload).then((r) => r.data),

  peekReceivables: (params) =>
    peekQueryCache(buildCacheKey('payments', { op: 'receivables', ...(params || {}) }))?.data || null,
  listReceivables: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('payments', { op: 'receivables', ...(params || {}) }),
      () => api.get('/api/v1/receivables', { params }).then((r) => r.data),
      { ttlMs: PAYMENTS_TTL_MS, force: Boolean(options?.force) }
    ),

  // Credit balance & 4-eyes refund operations (FR-040 & PRD Mục 5.6)
  peekCredits: (params) =>
    peekQueryCache(buildCacheKey('payments', { op: 'credits', ...(params || {}) }))?.data || null,
  getCredits: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('payments', { op: 'credits', ...(params || {}) }),
      () => api.get('/api/v1/payments/credits', { params }).then((r) => r.data),
      { ttlMs: PAYMENTS_TTL_MS, force: Boolean(options?.force) }
    ),
  requestCreditRefund: (creditId, payload) =>
    api.post(`/api/v1/payments/credits/${creditId}/refund`, payload).then((r) => r.data),
  approveCreditRefund: (creditId) =>
    api.post(`/api/v1/payments/credits/${creditId}/refund/approve`).then((r) => r.data),
  rejectCreditRefund: (creditId, payload) =>
    api.post(`/api/v1/payments/credits/${creditId}/refund/reject`, payload).then((r) => r.data),
};
