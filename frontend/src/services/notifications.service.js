import api from './api';

export const notificationsService = {
  list: () => api.get('/api/v1/notifications').then((r) => r.data),
  send: (payload) => api.post('/api/v1/notifications', payload).then((r) => r.data),
  markRead: (id) => api.patch(`/api/v1/notifications/${id}/read`).then((r) => r.data),
  markAllRead: () => api.post('/api/v1/notifications/read-all').then((r) => r.data),
};

