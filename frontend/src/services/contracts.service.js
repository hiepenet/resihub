import api from './api';
import { createIdempotencyKey as createSharedIdempotencyKey, withIdempotency } from '../utils/idempotency';
import { buildCacheKey, cachedFetch, peekQueryCache } from './queryCache';

const CONTRACTS_TTL_MS = 25_000;

export function createIdempotencyKey() {
  return createSharedIdempotencyKey();
}

export const contractsService = {
  peekList: (params) => peekQueryCache(buildCacheKey('contracts', { op: 'list', ...(params || {}) }))?.data || null,
  list: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('contracts', { op: 'list', ...(params || {}) }),
      () => api.get('/api/v1/contracts', { params }).then((r) => r.data),
      { ttlMs: CONTRACTS_TTL_MS, force: Boolean(options?.force) }
    ),

  peekById: (id) => (id ? peekQueryCache(buildCacheKey('contracts', { op: 'detail', id }))?.data || null : null),
  getById: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('contracts', { op: 'detail', id }),
      () => api.get(`/api/v1/contracts/${id}`).then((r) => r.data),
      { ttlMs: CONTRACTS_TTL_MS, force: Boolean(options?.force) }
    ),

  peekRequests: (params) =>
    peekQueryCache(buildCacheKey('contracts', { op: 'requests', ...(params || {}) }))?.data || null,
  listRequests: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('contracts', { op: 'requests', ...(params || {}) }),
      () => api.get('/api/v1/contracts/requests', { params }).then((r) => r.data),
      { ttlMs: CONTRACTS_TTL_MS, force: Boolean(options?.force) }
    ),

  create: (payload, options = {}) =>
    api.post('/api/v1/contracts', payload, withIdempotency(options)).then((r) => r.data),
  update: (id, payload) => api.patch(`/api/v1/contracts/${id}`, payload).then((r) => r.data),
  activate: (id, payload = {}, options = {}) =>
    api.post(`/api/v1/contracts/${id}/activate`, payload, withIdempotency(options)).then((r) => r.data),
  approve: (id, payload = {}, options = {}) =>
    api.post(`/api/v1/contracts/${id}/approve`, payload, withIdempotency(options)).then((r) => r.data),
  reject: (id, payload) => api.post(`/api/v1/contracts/${id}/reject`, payload).then((r) => r.data),
  rejectContract: (id, reason) =>
    api
      .post(`/api/v1/contracts/${id}/reject`, typeof reason === 'string' ? { reason } : reason)
      .then((r) => r.data),
  cancel: (id, payload = {}) => api.post(`/api/v1/contracts/${id}/cancel`, payload).then((r) => r.data),
  uploadScan: (id, payload) => api.post(`/api/v1/contracts/${id}/scan`, payload).then((r) => r.data),

  terminate: (id, payload, options = {}) =>
    api.post(`/api/v1/contracts/${id}/terminate`, payload, withIdempotency(options)).then((r) => r.data),
  approveTermination: (id, payload = {}) => api.post(`/api/v1/contracts/${id}/terminate/approve`, payload).then((r) => r.data),
  rejectTermination: (id, payload) => api.post(`/api/v1/contracts/${id}/terminate/reject`, payload).then((r) => r.data),

  renew: (id, payload, options = {}) =>
    api.post(`/api/v1/contracts/${id}/renew`, payload, withIdempotency(options)).then((r) => r.data),
  transferRoom: (id, payload, options = {}) =>
    api.post(`/api/v1/contracts/${id}/transfer-room`, payload, withIdempotency(options)).then((r) => r.data),

  listOccupants: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('contracts', { op: 'occupants', id }),
      () => api.get(`/api/v1/contracts/${id}/occupants`).then((r) => r.data),
      { ttlMs: CONTRACTS_TTL_MS, force: Boolean(options?.force) }
    ),
  addOccupant: (id, payload) => api.post(`/api/v1/contracts/${id}/occupants`, payload).then((r) => r.data),
  removeOccupant: (id, tenantId) => api.delete(`/api/v1/contracts/${id}/occupants/${tenantId}`).then((r) => r.data),

  listServicePrices: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('contracts', { op: 'servicePrices', id }),
      () => api.get(`/api/v1/contracts/${id}/service-prices`).then((r) => r.data),
      { ttlMs: CONTRACTS_TTL_MS, force: Boolean(options?.force) }
    ),
  addServicePrice: (id, payload) => api.post(`/api/v1/contracts/${id}/service-prices`, payload).then((r) => r.data),
  removeServicePrice: (id, priceId) => api.delete(`/api/v1/contracts/${id}/service-prices/${priceId}`).then((r) => r.data),

  listAmendments: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('contracts', { op: 'amendments', id }),
      () => api.get(`/api/v1/contracts/${id}/amendments`).then((r) => r.data),
      { ttlMs: CONTRACTS_TTL_MS, force: Boolean(options?.force) }
    ),
  createAmendment: (id, payload) => api.post(`/api/v1/contracts/${id}/amendments`, payload).then((r) => r.data),
  approveAmendment: (id, versionId) => api.post(`/api/v1/contracts/${id}/amendments/${versionId}/approve`).then((r) => r.data),
  rejectAmendment: (id, versionId, payload) => api.post(`/api/v1/contracts/${id}/amendments/${versionId}/reject`, payload).then((r) => r.data),

  approveRequest: (id, payload = {}) => api.post(`/api/v1/contracts/requests/${id}/approve`, payload).then((r) => r.data),
  rejectRequest: (id, payload) => api.post(`/api/v1/contracts/requests/${id}/reject`, payload).then((r) => r.data),

  getTemplateHtml: (id) => api.get(`/api/v1/contracts/${id}/template`, { responseType: 'text' }).then((r) => r.data),
};
