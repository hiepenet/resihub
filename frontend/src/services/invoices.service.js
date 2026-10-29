import api from './api';

export const invoicesService = {
  list: (params) => api.get('/api/v1/invoices', { params }).then((r) => r.data),
  getById: (id) => api.get(`/api/v1/invoices/${id}`).then((r) => r.data),
  generateBatch: (payload) => api.post('/api/v1/invoices/generate-batch', payload).then((r) => r.data),
  updateStatus: (id, payload) => api.patch(`/api/v1/invoices/${id}/status`, payload).then((r) => r.data),
};

