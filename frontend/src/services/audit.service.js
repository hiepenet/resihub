import api from './api';
import { buildCacheKey, cachedFetch, peekQueryCache } from './queryCache';

const AUDIT_TTL_MS = 20_000;

export const auditService = {
  peekList: (params) =>
    peekQueryCache(buildCacheKey('auditLogs', { op: 'list', ...(params || {}) }))?.data || null,
  list: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('auditLogs', { op: 'list', ...(params || {}) }),
      () => api.get('/api/v1/audit-logs', { params }).then((r) => r.data),
      { ttlMs: AUDIT_TTL_MS, force: Boolean(options?.force) }
    ),
  exportCsv: (params = {}) =>
    api
      .get('/api/v1/audit-logs', {
        params: { ...params, format: 'csv' },
        responseType: 'blob',
      })
      .then((r) => r.data),
  exportXlsx: (params = {}) =>
    api
      .get('/api/v1/audit-logs', {
        params: { ...params, format: 'xlsx' },
        responseType: 'blob',
      })
      .then((r) => r.data),
};
