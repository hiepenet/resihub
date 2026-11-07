import api from './api';
import { buildCacheKey, cachedFetch, peekQueryCache } from './queryCache';

const INVOICES_TTL_MS = 20_000;

export const invoicesService = {
  peekList: (params) =>
    peekQueryCache(buildCacheKey('invoices', { op: 'list', ...(params || {}) }))?.data || null,
  list: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('invoices', { op: 'list', ...(params || {}) }),
      () => api.get('/api/v1/invoices', { params }).then((r) => r.data),
      { ttlMs: INVOICES_TTL_MS, force: Boolean(options?.force) }
    ),
  peekById: (id) =>
    id ? peekQueryCache(buildCacheKey('invoices', { op: 'detail', id }))?.data || null : null,
  getById: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('invoices', { op: 'detail', id }),
      () => api.get(`/api/v1/invoices/${id}`).then((r) => r.data),
      { ttlMs: INVOICES_TTL_MS, force: Boolean(options?.force) }
    ),
  generateBatch: (payload) => api.post('/api/v1/invoices/generate-batch', payload).then((r) => r.data),
  updateStatus: (id, payload) => api.patch(`/api/v1/invoices/${id}/status`, payload).then((r) => r.data),

  // DRAFT Line editor (PRD Mục 8.2 / Task 4)
  addLine: (invoiceId, payload) => api.post(`/api/v1/invoices/${invoiceId}/lines`, payload).then((r) => r.data),
  updateLine: (invoiceId, lineId, payload) => api.patch(`/api/v1/invoices/${invoiceId}/lines/${lineId}`, payload).then((r) => r.data),
  deleteLine: (invoiceId, lineId) => api.delete(`/api/v1/invoices/${invoiceId}/lines/${lineId}`).then((r) => r.data),

  // Issue with contextual confirmation (PRD 16.1)
  issue: (invoiceId, payload = {}) => api.post(`/api/v1/invoices/${invoiceId}/issue`, payload).then((r) => r.data),

  // 4-eyes invoice adjustment & 2-step VOID (PRD 16.2 & FR-064)
  requestAdjustment: (invoiceId, payload) => api.post(`/api/v1/invoices/${invoiceId}/adjust`, payload).then((r) => r.data),
  peekAdjustments: (params) =>
    peekQueryCache(buildCacheKey('invoices', { op: 'adjustments', ...(params || {}) }))?.data || null,
  getAdjustments: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('invoices', { op: 'adjustments', ...(params || {}) }),
      () => api.get('/api/v1/invoices/adjustments', { params }).then((r) => r.data),
      { ttlMs: INVOICES_TTL_MS, force: Boolean(options?.force) }
    ),
  approveAdjustment: (invoiceId, adjId) => api.post(`/api/v1/invoices/${invoiceId}/adjustments/${adjId}/approve`).then((r) => r.data),
  rejectAdjustment: (invoiceId, adjId, payload) => api.post(`/api/v1/invoices/${invoiceId}/adjustments/${adjId}/reject`, payload).then((r) => r.data),

  // Financial Audit Logs (PRD 8.2 & RP-08)
  getAuditLogs: (invoiceId) => api.get(`/api/v1/invoices/${invoiceId}/audit-logs`).then((r) => r.data),
};
