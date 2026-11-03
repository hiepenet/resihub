import api from './api';

export const paymentsService = {
  list: (params) => api.get('/api/v1/payments', { params }).then((r) => r.data),
  create: (payload) => api.post('/api/v1/payments', payload).then((r) => r.data),
  confirm: (id, payload = {}) => api.patch(`/api/v1/payments/${id}/confirm`, payload).then((r) => r.data),
  reject: (id, payload) => api.patch(`/api/v1/payments/${id}/reject`, payload).then((r) => r.data),
  listReceivables: (params) => api.get('/api/v1/receivables', { params }).then((r) => r.data),

  // Credit balance & 4-eyes refund operations (FR-040 & PRD Mục 5.6)
  getCredits: (params) => api.get('/api/v1/payments/credits', { params }).then((r) => r.data),
  requestCreditRefund: (creditId, payload) =>
    api.post(`/api/v1/payments/credits/${creditId}/refund`, payload).then((r) => r.data),
  approveCreditRefund: (creditId) =>
    api.post(`/api/v1/payments/credits/${creditId}/refund/approve`).then((r) => r.data),
  rejectCreditRefund: (creditId, payload) =>
    api.post(`/api/v1/payments/credits/${creditId}/refund/reject`, payload).then((r) => r.data),
};
