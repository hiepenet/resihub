import api from './api';
import { withIdempotency } from '../utils/idempotency';

const withContractParam = (contractId) =>
  contractId ? { params: { contract_id: contractId } } : undefined;

export const residentService = {
  getOverview: (contractId) =>
    api.get('/api/v1/resident/overview', withContractParam(contractId)).then((r) => r.data),
  submitRentalApplication: (payload) => api.post('/api/v1/resident/rental-application', payload).then((r) => r.data),
  uploadIdImage: (payload) => api.post('/api/v1/resident/id-images', payload).then((r) => r.data),

  listServiceRequests: (contractId) =>
    api.get('/api/v1/resident/service-requests', withContractParam(contractId)).then((r) => r.data),
  createServiceRequest: (payload) => api.post('/api/v1/resident/service-requests', payload).then((r) => r.data),
  rateServiceRequest: (id, payload) => api.post(`/api/v1/resident/service-requests/${id}/rating`, payload).then((r) => r.data),

  listInvoices: (contractId) =>
    api.get('/api/v1/resident/invoices', withContractParam(contractId)).then((r) => r.data),
  reportPayment: (payload) => api.post('/api/v1/resident/payments/report', payload).then((r) => r.data),

  listServices: (contractId) =>
    api.get('/api/v1/resident/services', withContractParam(contractId)).then((r) => r.data),
  subscribeService: (payload) => api.post('/api/v1/resident/services', payload).then((r) => r.data),
  cancelService: (id, payload = {}) => api.patch(`/api/v1/resident/services/${id}/cancel`, payload).then((r) => r.data),

  updateProfile: (payload) => api.patch('/api/v1/resident/profile', payload).then((r) => r.data),

  listContractRequests: (contractId) =>
    api.get('/api/v1/resident/contract-requests', withContractParam(contractId)).then((r) => r.data),
  createContractRequest: (payload) => api.post('/api/v1/resident/contract-requests', payload).then((r) => r.data),
  listDepositTransactions: (contractId) =>
    api.get('/api/v1/resident/deposit-transactions', withContractParam(contractId)).then((r) => r.data),
  disputeDeposit: (depositId, payload, options = {}) =>
    api.post(`/api/v1/deposits/${depositId}/dispute`, payload, withIdempotency(options)).then((r) => r.data),
  updateDepositRefundBankInfo: (depositId, payload, options = {}) =>
    api.patch(`/api/v1/deposits/${depositId}/bank-info`, payload, withIdempotency(options)).then((r) => r.data),
  getDepositSettlementPdfHtml: (depositId) =>
    api
      .get(`/api/v1/deposits/${depositId}/settlement/pdf`, { responseType: 'text' })
      .then((r) => r.data),
};
