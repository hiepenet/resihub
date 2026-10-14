import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';

import healthRoute from './routes/health.js';
import authRoute from './routes/auth.js';
import buildingsRoute from './routes/buildings.js';
import apartmentsRoute from './routes/apartments.js';
import tenantsRoute from './routes/tenants.js';
import contractsRoute from './routes/contracts.js';
import depositsRoute from './routes/deposits.js';
import reservationsRoute from './routes/reservations.js';
import notificationsRoute from './routes/notifications.js';
import { generalLimiter } from './middleware/rateLimiter.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Request Logger
app.use(morgan('dev'));

// Body parser
app.use(express.json());

// General Rate Limiter
app.use('/api/', generalLimiter);

// API Routes
app.use('/api', healthRoute);
app.use('/api/v1/auth', authRoute);
app.use('/api/v1/buildings', buildingsRoute);
app.use('/api/v1/apartments', apartmentsRoute);
app.use('/api/v1/tenants', tenantsRoute);
app.use('/api/v1/contracts', contractsRoute);
app.use('/api/v1/deposits', depositsRoute);
app.use('/api/v1/reservations', reservationsRoute);
app.use('/api/v1/notifications', notificationsRoute);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    code: 'ROUTE_NOT_FOUND',
    message: `Không tìm thấy endpoint: ${req.method} ${req.originalUrl}`,
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Global Error]:', err.stack || err);
  res.status(err.status || 500).json({
    code: err.code || 'INTERNAL_SERVER_ERROR',
    message: err.message || 'Đã xảy ra lỗi hệ thống.',
  });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🚀 ResiHub API running on http://localhost:${PORT}`);
  console.log(`🩺 Health check: http://localhost:${PORT}/api/health`);
  console.log(`===============================================`);
});

export default app;
