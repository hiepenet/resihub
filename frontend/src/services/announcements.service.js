import api from './api';
import { withIdempotency } from '../utils/idempotency';

export const announcementsService = {
  listTemplates: () => api.get('/api/v1/announcements/templates').then((r) => r.data),
  listAnnouncements: (params) => api.get('/api/v1/announcements', { params }).then((r) => r.data),
  createAnnouncement: (payload, options = {}) =>
    api.post('/api/v1/announcements', payload, withIdempotency(options)).then((r) => r.data),
  updateAnnouncement: (id, payload, options = {}) =>
    api.put(`/api/v1/announcements/${id}`, payload, withIdempotency(options)).then((r) => r.data),
  sendAnnouncement: (id, payload = { confirm_send: true }, options = {}) =>
    api.post(`/api/v1/announcements/${id}/send`, payload, withIdempotency(options)).then((r) => r.data),
  markZaloSent: (id, payload = {}, options = {}) =>
    api
      .post(`/api/v1/announcements/${id}/mark-zalo-sent`, payload, withIdempotency(options))
      .then((r) => r.data),

  listZaloGroups: (params) => api.get('/api/v1/zalo-groups', { params }).then((r) => r.data),
  createZaloGroup: (payload, options = {}) =>
    api.post('/api/v1/zalo-groups', payload, withIdempotency(options)).then((r) => r.data),
  updateZaloGroup: (id, payload, options = {}) =>
    api.put(`/api/v1/zalo-groups/${id}`, payload, withIdempotency(options)).then((r) => r.data),
  deleteZaloGroup: (id) =>
    api.delete(`/api/v1/zalo-groups/${id}`).then((r) => r.data),
};

