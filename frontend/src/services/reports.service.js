import api from './api';
import { buildCacheKey, cachedFetch, peekQueryCache } from './queryCache';

const REPORTS_TTL_MS = 25_000;

export const reportsService = {
  peekDashboard: (params) =>
    peekQueryCache(buildCacheKey('reports', { op: 'dashboard', ...(params || {}) }))?.data || null,
  getDashboard: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('reports', { op: 'dashboard', ...(params || {}) }),
      () => api.get('/api/v1/reports/dashboard', { params }).then((r) => r.data),
      { ttlMs: REPORTS_TTL_MS, force: Boolean(options?.force) }
    ),
  peekSummary: (params) =>
    peekQueryCache(buildCacheKey('reports', { op: 'summary', ...(params || {}) }))?.data || null,
  getSummary: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('reports', { op: 'summary', ...(params || {}) }),
      () => api.get('/api/v1/reports/summary', { params }).then((r) => r.data),
      { ttlMs: REPORTS_TTL_MS, force: Boolean(options?.force) }
    ),
  exportSummaryXlsx: (params = {}) =>
    api
      .get('/api/v1/reports/summary', {
        params: { ...params, format: 'xlsx' },
        responseType: 'blob',
      })
      .then((r) => r.data),
  exportSummaryCsv: (params = {}) =>
    api
      .get('/api/v1/reports/summary', {
        params: { ...params, format: 'csv' },
        responseType: 'blob',
      })
      .then((r) => r.data),
  peekDepositLedger: (params) =>
    peekQueryCache(buildCacheKey('reports', { op: 'depositLedger', ...(params || {}) }))?.data || null,
  getDepositLedger: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('reports', { op: 'depositLedger', ...(params || {}) }),
      () => api.get('/api/v1/reports/deposit-ledger', { params }).then((r) => r.data),
      { ttlMs: REPORTS_TTL_MS, force: Boolean(options?.force) }
    ),
  exportDepositLedgerXlsx: (params = {}) =>
    api
      .get('/api/v1/reports/deposit-ledger', {
        params: { ...params, format: 'xlsx' },
        responseType: 'blob',
      })
      .then((r) => r.data),
  exportDepositLedgerCsv: (params = {}) =>
    api
      .get('/api/v1/reports/deposit-ledger', {
        params: { ...params, format: 'csv' },
        responseType: 'blob',
      })
      .then((r) => r.data),
};
