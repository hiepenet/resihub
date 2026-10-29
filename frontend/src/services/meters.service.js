import api from './api';

export const metersService = {
  list: (params) => api.get('/api/v1/meters', { params }).then((r) => r.data),
  create: (payload) => api.post('/api/v1/meters', payload).then((r) => r.data),
  listReadings: (params) => api.get('/api/v1/meters/readings', { params }).then((r) => r.data),
  listMeterReadings: (id) => api.get(`/api/v1/meters/${id}/readings`).then((r) => r.data),
  recordReading: (id, payload) => api.post(`/api/v1/meters/${id}/readings`, payload).then((r) => r.data),
  recordBatch: (payload) => api.post('/api/v1/meters/readings/batch', payload).then((r) => r.data),
};

