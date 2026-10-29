import api from './api';

export const tenantsService = {
  list: (params) => api.get('/api/v1/tenants', { params }).then((r) => r.data),
  getById: (id) => api.get(`/api/v1/tenants/${id}`).then((r) => r.data),
  checkDup: (params) => api.get('/api/v1/tenants/check-dup', { params }).then((r) => r.data),
  create: (payload) => api.post('/api/v1/tenants', payload).then((r) => r.data),
  update: (id, payload) => api.patch(`/api/v1/tenants/${id}`, payload).then((r) => r.data),
  merge: (payload) => api.post('/api/v1/tenants/merge', payload).then((r) => r.data),
  getIdImages: (id) => api.get(`/api/v1/tenants/${id}/id-images`).then((r) => r.data),
  uploadIdImage: (id, payload) => api.post(`/api/v1/tenants/${id}/id-images`, payload).then((r) => r.data),
};

