import api from './api';

export const invoicesService = {
  list: (params) => api.get('/api/v1/invoices', { params }).then((r) => r.data),
  getById: (id) => api.get(`/api/v1/invoices/${id}`).then((r) => r.data),
  generateBatch: (payload) => api.post('/api/v1/invoices/generate-batch', payload).then((r) => r.data),
  updateStatus: (id, payload) => api.patch(`/api/v1/invoices/${id}/status`, payload).then((r) => r.data),

  // DRAFT Line editor (PRD Mục 8.2 / Task 4)
  addLine: (invoiceId, payload) => api.post(`/api/v1/invoices/${invoiceId}/lines`, payload).then((r) => r.data),
  updateLine: (invoiceId, lineId, payload) => api.patch(`/api/v1/invoices/${invoiceId}/lines/${lineId}`, payload).then((r) => r.data),
  deleteLine: (invoiceId, lineId) => api.delete(`/api/v1/invoices/${invoiceId}/lines/${lineId}`).then((r) => r.data),

  // Issue with contextual confirmation (PRD 16.1)
  issue: (invoiceId, payload = {}) => api.post(`/api/v1/invoices/${invoiceId}/issue`, payload).then((r) => r.data),

  // 4-eyes invoice adjustment & 2-step VOID (PRD 16.2 & FR-064)
  requestAdjustment: (invoiceId, payload) => api.post(`/api/v1/invoices/${invoiceId}/adjust`, payload).then((r) => r.data),
  getAdjustments: (params) => api.get('/api/v1/invoices/adjustments', { params }).then((r) => r.data),
  approveAdjustment: (invoiceId, adjId) => api.post(`/api/v1/invoices/${invoiceId}/adjustments/${adjId}/approve`).then((r) => r.data),
  rejectAdjustment: (invoiceId, adjId, payload) => api.post(`/api/v1/invoices/${invoiceId}/adjustments/${adjId}/reject`, payload).then((r) => r.data),

  // Financial Audit Logs (PRD 8.2 & RP-08)
  getAuditLogs: (invoiceId) => api.get(`/api/v1/invoices/${invoiceId}/audit-logs`).then((r) => r.data),
};
