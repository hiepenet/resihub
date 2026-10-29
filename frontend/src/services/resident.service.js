import api from './api';

export const residentService = {
  getOverview: () => api.get('/api/v1/resident/overview').then((r) => r.data),
  submitRentalApplication: (payload) => api.post('/api/v1/resident/rental-application', payload).then((r) => r.data),

  listServiceRequests: () => api.get('/api/v1/resident/service-requests').then((r) => r.data),
  createServiceRequest: (payload) => api.post('/api/v1/resident/service-requests', payload).then((r) => r.data),
  rateServiceRequest: (id, payload) => api.post(`/api/v1/resident/service-requests/${id}/rating`, payload).then((r) => r.data),

  listInvoices: () => api.get('/api/v1/resident/invoices').then((r) => r.data),
  reportPayment: (payload) => api.post('/api/v1/resident/payments/report', payload).then((r) => r.data),

  listServices: () => api.get('/api/v1/resident/services').then((r) => r.data),
  subscribeService: (payload) => api.post('/api/v1/resident/services', payload).then((r) => r.data),
  cancelService: (id, payload = {}) => api.patch(`/api/v1/resident/services/${id}/cancel`, payload).then((r) => r.data),

  updateProfile: (payload) => api.patch('/api/v1/resident/profile', payload).then((r) => r.data),

  listContractRequests: () => api.get('/api/v1/resident/contract-requests').then((r) => r.data),
  createContractRequest: (payload) => api.post('/api/v1/resident/contract-requests', payload).then((r) => r.data),
  listDepositTransactions: () => api.get('/api/v1/resident/deposit-transactions').then((r) => r.data),
};

