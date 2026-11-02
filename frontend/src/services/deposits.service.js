import api from './api';
import { withIdempotency } from '../utils/idempotency';

export const depositsService = {
  list: (params) => api.get('/api/v1/deposits', { params }).then((r) => r.data),
  listTransactions: (id) => api.get(`/api/v1/deposits/${id}/transactions`).then((r) => r.data),
  getAuditLogs: (id) => api.get(`/api/v1/deposits/${id}/audit-logs`).then((r) => r.data),
  createTransaction: (id, payload, options = {}) =>
    api.post(`/api/v1/deposits/${id}/transactions`, payload, withIdempotency(options)).then((r) => r.data),
  getSettlement: (id) => api.get(`/api/v1/deposits/${id}/settlement`).then((r) => r.data),
  submitSettlement: (id, payload, options = {}) =>
    api.post(`/api/v1/deposits/${id}/settlement`, payload, withIdempotency(options)).then((r) => r.data),
  approveSettlement: (id, payload = {}, options = {}) =>
    api.post(`/api/v1/deposits/${id}/settlement/approve`, payload, withIdempotency(options)).then((r) => r.data),
  rejectSettlement: (id, payload, options = {}) =>
    api.post(`/api/v1/deposits/${id}/settlement/reject`, payload, withIdempotency(options)).then((r) => r.data),
  dispute: (id, payload, options = {}) =>
    api.post(`/api/v1/deposits/${id}/dispute`, payload, withIdempotency(options)).then((r) => r.data),
  resolveDispute: (id, payload, options = {}) =>
    api.post(`/api/v1/deposits/${id}/resolve-dispute`, payload, withIdempotency(options)).then((r) => r.data),
  executePayout: (id, payload, options = {}) =>
    api.post(`/api/v1/deposits/${id}/payout`, payload, withIdempotency(options)).then((r) => r.data),
  markPayoutReturned: (id, payload, options = {}) =>
    api.post(`/api/v1/deposits/${id}/payout-returned`, payload, withIdempotency(options)).then((r) => r.data),
  updateRefundBankInfo: (id, payload, options = {}) =>
    api.patch(`/api/v1/deposits/${id}/bank-info`, payload, withIdempotency(options)).then((r) => r.data),
  getSettlementPdfHtml: (id) =>
    api.get(`/api/v1/deposits/${id}/settlement/pdf`, { responseType: 'text' }).then((r) => r.data),
};
