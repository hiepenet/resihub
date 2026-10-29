import api from './api';

export const paymentsService = {
  list: (params) => api.get('/api/v1/payments', { params }).then((r) => r.data),
  create: (payload) => api.post('/api/v1/payments', payload).then((r) => r.data),
  confirm: (id, payload = {}) => api.patch(`/api/v1/payments/${id}/confirm`, payload).then((r) => r.data),
  reject: (id, payload) => api.patch(`/api/v1/payments/${id}/reject`, payload).then((r) => r.data),
  listReceivables: (params) => api.get('/api/v1/receivables', { params }).then((r) => r.data),
};

