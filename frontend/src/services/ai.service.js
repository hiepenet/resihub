import api from './api';
import { withIdempotency } from '../utils/idempotency';

export const aiService = {
  extractDocument: (payload, options = {}) =>
    api.post('/api/v1/ai/extract', payload, withIdempotency(options)).then((r) => r.data),

  ocrMeterReading: (payload, options = {}) =>
    api.post('/api/v1/ai/meter-ocr', payload, withIdempotency(options)).then((r) => r.data),

  classifyServiceRequest: (payload, options = {}) =>
    api.post('/api/v1/ai/classify', payload, withIdempotency(options)).then((r) => r.data),

  reviewSuggestion: (id, payload, options = {}) =>
    api
      .post(`/api/v1/ai/suggestions/${id}/review`, payload, withIdempotency(options))
      .then((r) => r.data),

  getUsageSummary: (params) => api.get('/api/v1/ai/usage', { params }).then((r) => r.data),
};

