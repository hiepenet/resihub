import api from './api';
import { withIdempotency } from '../utils/idempotency';

export const serviceRequestsService = {
  list: (params) => api.get('/api/v1/service-requests', { params }).then((r) => r.data),
  getById: (id) => api.get(`/api/v1/service-requests/${id}`).then((r) => r.data),
  create: (payload, options = {}) =>
    api.post('/api/v1/service-requests', payload, withIdempotency(options)).then((r) => r.data),
  updateStatus: (id, payload, options = {}) =>
    api
      .patch(`/api/v1/service-requests/${id}/status`, payload, withIdempotency(options))
      .then((r) => r.data),
  applyTriage: (id, payload, options = {}) =>
    api
      .post(`/api/v1/service-requests/${id}/apply-triage`, payload, withIdempotency(options))
      .then((r) => r.data),
  rate: (id, payload, options = {}) =>
    api
      .post(`/api/v1/service-requests/${id}/rating`, payload, withIdempotency(options))
      .then((r) => r.data),
};
