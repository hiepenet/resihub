import api from './api';

export const reportsService = {
  getDashboard: (params) => api.get('/api/v1/reports/dashboard', { params }).then((r) => r.data),
  getSummary: (params) => api.get('/api/v1/reports/summary', { params }).then((r) => r.data),
};

