import 'dotenv/config';
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
import attachmentsRoute from './routes/attachments.js';
import depositsRoute from './routes/deposits.js';
import reservationsRoute from './routes/reservations.js';
import notificationsRoute from './routes/notifications.js';
import announcementsRoute from './routes/announcements.js';
import zaloGroupsRoute from './routes/zalo-groups.js';
import residentRoute from './routes/resident.js';
import serviceRequestsRoute from './routes/service-requests.js';
import metersRoute from './routes/meters.js';
import servicesRoute, { serviceCatalogRouter, serviceSubscriptionsRouter } from './routes/services.js';
import invoicesRoute from './routes/invoices.js';
import paymentsRoute, { receivablesRouter } from './routes/payments.js';
import adminUsersRoute from './routes/admin/users.js';
import auditLogsRoute from './routes/admin/audit-logs.js';
import settingsRoute from './routes/settings.js';
import reportsRoute from './routes/reports.js'; import publicRoute from './routes/public.js';
import { startDailyJobs } from './jobs/daily.js';
import { generalLimiter } from './middleware/rateLimiter.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  exposedHeaders: ['Idempotent-Replayed'],
}));

// Request Logger
app.use(morgan('dev'));

// Body parser (hỗ trợ upload ảnh base64 tối đa 5MB/ảnh x 3 ảnh hoặc PDF scan hợp đồng tối đa 10MB)
app.use(express.json({ limit: '20mb' }));

// General Rate Limiter
app.use('/api/', generalLimiter);

// API Routes
app.use('/api', healthRoute);
app.use('/api/v1/auth', authRoute);
app.use('/api/v1/buildings', buildingsRoute);
app.use('/api/v1/apartments', apartmentsRoute);
app.use('/api/v1/tenants', tenantsRoute);
app.use('/api/v1/contracts', contractsRoute);
app.use('/api/v1/attachments', attachmentsRoute);
app.use('/api/v1/deposits', depositsRoute);
app.use('/api/v1/reservations', reservationsRoute);
app.use('/api/v1/notifications', notificationsRoute);
app.use('/api/v1/announcements', announcementsRoute);
app.use('/api/v1/zalo-groups', zaloGroupsRoute);
app.use('/api/v1/resident', residentRoute);
app.use('/api/v1/service-requests', serviceRequestsRoute);
app.use('/api/v1/meters', metersRoute);
app.use('/api/v1/services', servicesRoute);
app.use('/api/v1/service-catalog', serviceCatalogRouter);
app.use('/api/v1/service-subscriptions', serviceSubscriptionsRouter);
app.use('/api/v1/invoices', invoicesRoute);
app.use('/api/v1/payments', paymentsRoute);
app.use('/api/v1/receivables', receivablesRouter);
app.use('/api/v1/admin/users', adminUsersRoute);
app.use('/api/v1/audit-logs', auditLogsRoute);
app.use('/api/v1/settings', settingsRoute);
app.use('/api/v1/reports', reportsRoute); app.use('/api/v1/public', publicRoute);

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
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 ResiHub API running on http://localhost:${PORT}`);
  console.log(`🩺 Health check: http://localhost:${PORT}/api/health`);
  console.log(`===============================================`);
  startDailyJobs();
});

export default app;
