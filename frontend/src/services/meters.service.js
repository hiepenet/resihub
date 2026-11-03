import api from './api';
import { withIdempotency } from '../utils/idempotency';

export const metersService = {
  list: (params) => api.get('/api/v1/meters', { params }).then((r) => r.data),
  create: (payload, options) =>
    api.post('/api/v1/meters', payload, withIdempotency(options)).then((r) => r.data),
  listReadings: (params) => api.get('/api/v1/meters/readings', { params }).then((r) => r.data),
  listMeterReadings: (id) => api.get(`/api/v1/meters/${id}/readings`).then((r) => r.data),
  recordReading: (id, payload, options) =>
    api.post(`/api/v1/meters/${id}/readings`, payload, withIdempotency(options)).then((r) => r.data),
  recordBatch: (payload, options) =>
    api.post('/api/v1/meters/readings/batch', payload, withIdempotency(options)).then((r) => r.data),
  confirmReading: (readingId, payload = {}, options) =>
    api
      .post(`/api/v1/meters/readings/${readingId}/confirm`, payload, withIdempotency(options))
      .then((r) => r.data),
  confirmBatch: (payload = {}, options) =>
    api
      .post('/api/v1/meters/readings/confirm-batch', payload, withIdempotency(options))
      .then((r) => r.data),
};
