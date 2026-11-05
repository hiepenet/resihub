import api from './api';
import { withIdempotency } from '../utils/idempotency';
import { buildCacheKey, cachedFetch, peekQueryCache } from './queryCache';

const BUILDINGS_TTL_MS = 25_000;
const POLICY_TTL_MS = 120_000;

export const buildingsService = {
  peekList: () => peekQueryCache(buildCacheKey('buildings', { op: 'list' }))?.data || null,
  list: (options = {}) =>
    cachedFetch(
      buildCacheKey('buildings', { op: 'list' }),
      () => api.get('/api/v1/buildings').then((r) => r.data),
      { ttlMs: BUILDINGS_TTL_MS, force: Boolean(options?.force) }
    ),

  peekById: (id) => (id ? peekQueryCache(buildCacheKey('buildings', { op: 'detail', id }))?.data || null : null),
  getById: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('buildings', { op: 'detail', id }),
      () => api.get(`/api/v1/buildings/${id}`).then((r) => r.data),
      { ttlMs: BUILDINGS_TTL_MS, force: Boolean(options?.force) }
    ),

  checkCode: (code) => api.get('/api/v1/buildings/check-code', { params: { code } }).then((r) => r.data),
  lookupOwner: (identifier) => api.get('/api/v1/buildings/lookup-owner', { params: { identifier } }).then((r) => r.data),
  listOwners: () => api.get('/api/v1/buildings/owners').then((r) => r.data),
  listBanks: () =>
    cachedFetch(
      buildCacheKey('buildings', { op: 'banks' }),
      () => api.get('/api/v1/buildings/banks').then((r) => r.data),
      { ttlMs: 300_000 }
    ),
  create: (payload) => api.post('/api/v1/buildings', payload).then((r) => r.data),
  update: (id, payload) => api.patch(`/api/v1/buildings/${id}`, payload).then((r) => r.data),
  remove: (id) => api.delete(`/api/v1/buildings/${id}`).then((r) => r.data),
  updateStatus: (id, status) => api.patch(`/api/v1/buildings/${id}/status`, { status }).then((r) => r.data),

  peekFloorMap: (id) => (id ? peekQueryCache(buildCacheKey('buildings', { op: 'floorMap', id }))?.data || null : null),
  getFloorMap: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('buildings', { op: 'floorMap', id }),
      () => api.get(`/api/v1/buildings/${id}/floor-map`).then((r) => r.data),
      { ttlMs: BUILDINGS_TTL_MS, force: Boolean(options?.force) }
    ),

  peekFloors: (id) => (id ? peekQueryCache(buildCacheKey('buildings', { op: 'floors', id }))?.data || null : null),
  listFloors: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('buildings', { op: 'floors', id }),
      () => api.get(`/api/v1/buildings/${id}/floors`).then((r) => r.data),
      { ttlMs: BUILDINGS_TTL_MS, force: Boolean(options?.force) }
    ),
  createFloor: (id, payload) => api.post(`/api/v1/buildings/${id}/floors`, payload).then((r) => r.data),
  updateFloor: (id, floorId, payload) => api.patch(`/api/v1/buildings/${id}/floors/${floorId}`, payload).then((r) => r.data),
  deleteFloor: (id, floorId) => api.delete(`/api/v1/buildings/${id}/floors/${floorId}`).then((r) => r.data),

  peekZones: (id) => (id ? peekQueryCache(buildCacheKey('buildings', { op: 'zones', id }))?.data || null : null),
  listZones: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('buildings', { op: 'zones', id }),
      () => api.get(`/api/v1/buildings/${id}/zones`).then((r) => r.data),
      { ttlMs: BUILDINGS_TTL_MS, force: Boolean(options?.force) }
    ),
  createZone: (id, payload) => api.post(`/api/v1/buildings/${id}/zones`, payload).then((r) => r.data),
  updateZone: (id, zoneId, payload) => api.patch(`/api/v1/buildings/${id}/zones/${zoneId}`, payload).then((r) => r.data),
  deleteZone: (id, zoneId) => api.delete(`/api/v1/buildings/${id}/zones/${zoneId}`).then((r) => r.data),

  peekApartments: (params) =>
    peekQueryCache(buildCacheKey('apartments', { op: 'list', ...(params || {}) }))?.data || null,
  listApartments: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('apartments', { op: 'list', ...(params || {}) }),
      () => api.get('/api/v1/apartments', { params }).then((r) => r.data),
      { ttlMs: BUILDINGS_TTL_MS, force: Boolean(options?.force) }
    ),

  peekApartment: (id) =>
    id ? peekQueryCache(buildCacheKey('apartments', { op: 'detail', id }))?.data || null : null,
  getApartment: (id, options = {}) =>
    cachedFetch(
      buildCacheKey('apartments', { op: 'detail', id }),
      () => api.get(`/api/v1/apartments/${id}`).then((r) => r.data),
      { ttlMs: BUILDINGS_TTL_MS, force: Boolean(options?.force) }
    ),
  createApartment: (payload) => api.post('/api/v1/apartments', payload).then((r) => r.data),
  previewApartmentsBulk: (payload) =>
    api.post('/api/v1/apartments/bulk', { ...payload, dry_run: true }).then((r) => r.data),
  createApartmentsBulk: (payload) =>
    api.post('/api/v1/apartments/bulk', { ...payload, dry_run: false }).then((r) => r.data),
  updateApartment: (id, payload) => api.patch(`/api/v1/apartments/${id}`, payload).then((r) => r.data),
  deleteApartment: (id) => api.delete(`/api/v1/apartments/${id}`).then((r) => r.data),
  handoverApartment: (id, payload = {}) =>
    api.patch(`/api/v1/apartments/${id}/handover`, payload).then((r) => r.data),

  peekReservations: (params) =>
    peekQueryCache(buildCacheKey('reservations', { op: 'list', ...(params || {}) }))?.data || null,
  listReservations: (params, options = {}) =>
    cachedFetch(
      buildCacheKey('reservations', { op: 'list', ...(params || {}) }),
      () => api.get('/api/v1/reservations', { params }).then((r) => r.data),
      { ttlMs: BUILDINGS_TTL_MS, force: Boolean(options?.force) }
    ),
  getReservationCancelPolicy: (options = {}) =>
    cachedFetch(
      buildCacheKey('reservations', { op: 'cancelPolicy' }),
      () => api.get('/api/v1/reservations/cancel-policy').then((r) => r.data),
      { ttlMs: POLICY_TTL_MS, force: Boolean(options?.force) }
    ),
  createReservation: (payload, options = {}) =>
    api.post('/api/v1/reservations', payload, withIdempotency(options)).then((r) => r.data),
  confirmReservationPayment: (id, payload = {}, options = {}) =>
    api
      .patch(`/api/v1/reservations/${id}/confirm-payment`, payload, withIdempotency(options))
      .then((r) => r.data),
  rejectReservationPayment: (id, payload, options = {}) =>
    api
      .patch(`/api/v1/reservations/${id}/reject-payment`, payload, withIdempotency(options))
      .then((r) => r.data),
  cancelSettleReservation: (id, payload, options = {}) =>
    api
      .patch(`/api/v1/reservations/${id}/cancel-settle`, payload, withIdempotency(options))
      .then((r) => r.data),
  approveReservationCancel: (id, payload = {}, options = {}) =>
    api
      .post(`/api/v1/reservations/${id}/cancel-approve`, payload, withIdempotency(options))
      .then((r) => r.data),
  rejectReservationCancel: (id, payload, options = {}) =>
    api
      .post(`/api/v1/reservations/${id}/cancel-reject`, payload, withIdempotency(options))
      .then((r) => r.data),
  payoutReservationCancel: (id, payload, options = {}) =>
    api
      .post(`/api/v1/reservations/${id}/cancel-payout`, payload, withIdempotency(options))
      .then((r) => r.data),
  updateReservationBankInfo: (id, payload, options = {}) =>
    api
      .patch(`/api/v1/reservations/${id}/bank-info`, payload, withIdempotency(options))
      .then((r) => r.data),
  forfeitReservation: (id, payload, options = {}) =>
    api.patch(`/api/v1/reservations/${id}/forfeit`, payload, withIdempotency(options)).then((r) => r.data),
  refundReservation: (id, payload, options = {}) =>
    api.patch(`/api/v1/reservations/${id}/refund`, payload, withIdempotency(options)).then((r) => r.data),
};
