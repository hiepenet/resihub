import api from './api';

export const serviceRequestsService = {
  list: (params) => api.get('/api/v1/service-requests', { params }).then((r) => r.data),
  getById: (id) => api.get(`/api/v1/service-requests/${id}`).then((r) => r.data),
  create: (payload) => api.post('/api/v1/service-requests', payload).then((r) => r.data),
  updateStatus: (id, payload) => api.patch(`/api/v1/service-requests/${id}/status`, payload).then((r) => r.data),
  rate: (id, payload) => api.post(`/api/v1/service-requests/${id}/rating`, payload).then((r) => r.data),
};

