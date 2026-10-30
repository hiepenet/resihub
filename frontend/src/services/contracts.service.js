import api from './api';

export const contractsService = {
  list: (params) => api.get('/api/v1/contracts', { params }).then((r) => r.data),
  getById: (id) => api.get(`/api/v1/contracts/${id}`).then((r) => r.data),
  create: (payload) => api.post('/api/v1/contracts', payload).then((r) => r.data),
  update: (id, payload) => api.patch(`/api/v1/contracts/${id}`, payload).then((r) => r.data),
  activate: (id, payload = {}) => api.post(`/api/v1/contracts/${id}/activate`, payload).then((r) => r.data),
  approve: (id, payload = {}) => api.post(`/api/v1/contracts/${id}/approve`, payload).then((r) => r.data),
  reject: (id, payload) => api.post(`/api/v1/contracts/${id}/reject`, payload).then((r) => r.data),
  rejectContract: (id, reason) =>
    api
      .post(`/api/v1/contracts/${id}/reject`, typeof reason === 'string' ? { reason } : reason)
      .then((r) => r.data),
  cancel: (id, payload = {}) => api.post(`/api/v1/contracts/${id}/cancel`, payload).then((r) => r.data),
  uploadScan: (id, payload) => api.post(`/api/v1/contracts/${id}/scan`, payload).then((r) => r.data),

  terminate: (id, payload) => api.post(`/api/v1/contracts/${id}/terminate`, payload).then((r) => r.data),
  approveTermination: (id, payload = {}) => api.post(`/api/v1/contracts/${id}/terminate/approve`, payload).then((r) => r.data),
  rejectTermination: (id, payload) => api.post(`/api/v1/contracts/${id}/terminate/reject`, payload).then((r) => r.data),

  renew: (id, payload) => api.post(`/api/v1/contracts/${id}/renew`, payload).then((r) => r.data),
  transferRoom: (id, payload) => api.post(`/api/v1/contracts/${id}/transfer-room`, payload).then((r) => r.data),

  listOccupants: (id) => api.get(`/api/v1/contracts/${id}/occupants`).then((r) => r.data),
  addOccupant: (id, payload) => api.post(`/api/v1/contracts/${id}/occupants`, payload).then((r) => r.data),
  removeOccupant: (id, tenantId) => api.delete(`/api/v1/contracts/${id}/occupants/${tenantId}`).then((r) => r.data),

  listServicePrices: (id) => api.get(`/api/v1/contracts/${id}/service-prices`).then((r) => r.data),
  addServicePrice: (id, payload) => api.post(`/api/v1/contracts/${id}/service-prices`, payload).then((r) => r.data),
  removeServicePrice: (id, priceId) => api.delete(`/api/v1/contracts/${id}/service-prices/${priceId}`).then((r) => r.data),

  listAmendments: (id) => api.get(`/api/v1/contracts/${id}/amendments`).then((r) => r.data),
  createAmendment: (id, payload) => api.post(`/api/v1/contracts/${id}/amendments`, payload).then((r) => r.data),
  approveAmendment: (id, versionId) => api.post(`/api/v1/contracts/${id}/amendments/${versionId}/approve`).then((r) => r.data),
  rejectAmendment: (id, versionId, payload) => api.post(`/api/v1/contracts/${id}/amendments/${versionId}/reject`, payload).then((r) => r.data),

  listRequests: (params) => api.get('/api/v1/contracts/requests', { params }).then((r) => r.data),
  approveRequest: (id, payload = {}) => api.post(`/api/v1/contracts/requests/${id}/approve`, payload).then((r) => r.data),
  rejectRequest: (id, payload) => api.post(`/api/v1/contracts/requests/${id}/reject`, payload).then((r) => r.data),

  getTemplateHtml: (id) => api.get(`/api/v1/contracts/${id}/template`, { responseType: 'text' }).then((r) => r.data),
};

