import api from './api';

export const auditService = {
  list: (params) => api.get('/api/v1/audit-logs', { params }).then((r) => r.data),
  exportCsv: (params = {}) =>
    api
      .get('/api/v1/audit-logs', {
        params: { ...params, format: 'csv' },
        responseType: 'blob',
      })
      .then((r) => r.data),
};
