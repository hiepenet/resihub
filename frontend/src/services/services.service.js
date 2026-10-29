import api from './api';

export const servicesService = {
  listCatalog: (params) => api.get('/api/v1/service-catalog', { params }).then((r) => r.data),
  createCatalog: (payload) => api.post('/api/v1/service-catalog', payload).then((r) => r.data),
  updateCatalog: (id, payload) => api.patch(`/api/v1/service-catalog/${id}`, payload).then((r) => r.data),

  listSubscriptions: (params) => api.get('/api/v1/service-subscriptions', { params }).then((r) => r.data),
  createSubscription: (payload) => api.post('/api/v1/service-subscriptions', payload).then((r) => r.data),
  updateSubscription: (id, payload) => api.patch(`/api/v1/service-subscriptions/${id}`, payload).then((r) => r.data),
};

