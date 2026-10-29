import api from './api';

export const depositsService = {
  list: (params) => api.get('/api/v1/deposits', { params }).then((r) => r.data),
  listTransactions: (id) => api.get(`/api/v1/deposits/${id}/transactions`).then((r) => r.data),
  createTransaction: (id, payload) => api.post(`/api/v1/deposits/${id}/transactions`, payload).then((r) => r.data),
  getSettlement: (id) => api.get(`/api/v1/deposits/${id}/settlement`).then((r) => r.data),
  submitSettlement: (id, payload) => api.post(`/api/v1/deposits/${id}/settlement`, payload).then((r) => r.data),
  approveSettlement: (id, payload) => api.post(`/api/v1/deposits/${id}/settlement/approve`, payload).then((r) => r.data),
  rejectSettlement: (id, payload) => api.post(`/api/v1/deposits/${id}/settlement/reject`, payload).then((r) => r.data),
  dispute: (id, payload) => api.post(`/api/v1/deposits/${id}/dispute`, payload).then((r) => r.data),
};

