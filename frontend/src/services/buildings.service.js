import api from './api';
import { withIdempotency } from '../utils/idempotency';

export const buildingsService = {
  list: () => api.get('/api/v1/buildings').then((r) => r.data),
  getById: (id) => api.get(`/api/v1/buildings/${id}`).then((r) => r.data),
  checkCode: (code) => api.get('/api/v1/buildings/check-code', { params: { code } }).then((r) => r.data),
  lookupOwner: (identifier) => api.get('/api/v1/buildings/lookup-owner', { params: { identifier } }).then((r) => r.data),
  listOwners: () => api.get('/api/v1/buildings/owners').then((r) => r.data),
  listBanks: () => api.get('/api/v1/buildings/banks').then((r) => r.data),
  create: (payload) => api.post('/api/v1/buildings', payload).then((r) => r.data),
  update: (id, payload) => api.patch(`/api/v1/buildings/${id}`, payload).then((r) => r.data),
  remove: (id) => api.delete(`/api/v1/buildings/${id}`).then((r) => r.data),
  updateStatus: (id, status) => api.patch(`/api/v1/buildings/${id}/status`, { status }).then((r) => r.data),

  getFloorMap: (id) => api.get(`/api/v1/buildings/${id}/floor-map`).then((r) => r.data),
  listFloors: (id) => api.get(`/api/v1/buildings/${id}/floors`).then((r) => r.data),
  createFloor: (id, payload) => api.post(`/api/v1/buildings/${id}/floors`, payload).then((r) => r.data),
  updateFloor: (id, floorId, payload) => api.patch(`/api/v1/buildings/${id}/floors/${floorId}`, payload).then((r) => r.data),
  deleteFloor: (id, floorId) => api.delete(`/api/v1/buildings/${id}/floors/${floorId}`).then((r) => r.data),

  listZones: (id) => api.get(`/api/v1/buildings/${id}/zones`).then((r) => r.data),
  createZone: (id, payload) => api.post(`/api/v1/buildings/${id}/zones`, payload).then((r) => r.data),
  updateZone: (id, zoneId, payload) => api.patch(`/api/v1/buildings/${id}/zones/${zoneId}`, payload).then((r) => r.data),
  deleteZone: (id, zoneId) => api.delete(`/api/v1/buildings/${id}/zones/${zoneId}`).then((r) => r.data),

  listApartments: (params) => api.get('/api/v1/apartments', { params }).then((r) => r.data),
  getApartment: (id) => api.get(`/api/v1/apartments/${id}`).then((r) => r.data),
  createApartment: (payload) => api.post('/api/v1/apartments', payload).then((r) => r.data),
  updateApartment: (id, payload) => api.patch(`/api/v1/apartments/${id}`, payload).then((r) => r.data),
  deleteApartment: (id) => api.delete(`/api/v1/apartments/${id}`).then((r) => r.data),
  handoverApartment: (id, payload = {}) =>
    api.patch(`/api/v1/apartments/${id}/handover`, payload).then((r) => r.data),

  listReservations: (params) => api.get('/api/v1/reservations', { params }).then((r) => r.data),
  getReservationCancelPolicy: () =>
    api.get('/api/v1/reservations/cancel-policy').then((r) => r.data),
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
  forfeitReservation: (id, payload, options = {}) =>
    api.patch(`/api/v1/reservations/${id}/forfeit`, payload, withIdempotency(options)).then((r) => r.data),
  refundReservation: (id, payload, options = {}) =>
    api.patch(`/api/v1/reservations/${id}/refund`, payload, withIdempotency(options)).then((r) => r.data),
};
