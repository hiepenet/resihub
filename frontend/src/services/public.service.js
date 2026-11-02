import axios from 'axios';
import { withIdempotency } from '../utils/idempotency';

const publicApi = axios.create({
  baseURL: '',
  headers: {
    'Content-Type': 'application/json',
  },
});

export const publicService = {
  getApartments: (params) =>
    publicApi.get('/api/v1/public/apartments', { params }).then((r) => r.data),
  requestReservationOtp: (phone) =>
    publicApi.post('/api/v1/public/reservations/otp/request', { phone }).then((r) => r.data),
  createReservation: (payload, options = {}) =>
    publicApi
      .post('/api/v1/public/reservations', payload, withIdempotency(options))
      .then((r) => r.data),
};
