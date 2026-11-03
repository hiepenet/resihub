import api from './api';
import { withIdempotency } from '../utils/idempotency';

export const notificationsService = {
  list: () => api.get('/api/v1/notifications').then((r) => r.data),
  send: (payload, options = {}) =>
    api.post('/api/v1/notifications', payload, withIdempotency(options)).then((r) => r.data),
  markRead: (id) => api.patch(`/api/v1/notifications/${id}/read`).then((r) => r.data),
  markAllRead: () => api.post('/api/v1/notifications/read-all').then((r) => r.data),
};
