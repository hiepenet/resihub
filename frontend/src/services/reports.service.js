import api from './api';

export const reportsService = {
  getDashboard: (params) => api.get('/api/v1/reports/dashboard', { params }).then((r) => r.data),
  getSummary: (params) => api.get('/api/v1/reports/summary', { params }).then((r) => r.data),
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
  getDepositLedger: (params) =>
    api.get('/api/v1/reports/deposit-ledger', { params }).then((r) => r.data),
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
