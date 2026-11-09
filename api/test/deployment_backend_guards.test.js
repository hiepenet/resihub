import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh';

test('BG01: isOtpDemoEnabled và isDemoAccountsEnabled tách bạch công tắc runtime khỏi NODE_ENV=production', async () => {
  const { isOtpDemoEnabled, isDemoAccountsEnabled } = await import('../src/config/env.js');
  assert.equal(isOtpDemoEnabled({ NODE_ENV: 'development' }), true);
  assert.equal(isOtpDemoEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(isOtpDemoEnabled({ NODE_ENV: 'production', OTP_DEMO_MODE: 'false' }), false);
  assert.equal(isOtpDemoEnabled({ NODE_ENV: 'production', OTP_DEMO_MODE: 'true' }), true);

  assert.equal(isDemoAccountsEnabled({ NODE_ENV: 'development' }), true);
  assert.equal(isDemoAccountsEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(isDemoAccountsEnabled({ NODE_ENV: 'production', SHOW_DEMO_ACCOUNTS: 'false' }), false);
  assert.equal(isDemoAccountsEnabled({ NODE_ENV: 'production', SHOW_DEMO_ACCOUNTS: 'true' }), true);
});

test('BG02: resolveCorsOriginOption trả "*" ở dev, false khi prod rỗng, và mảng origin khi có CORS_ORIGIN', async () => {
  const { resolveCorsOriginOption } = await import('../src/config/env.js');
  assert.equal(resolveCorsOriginOption({ NODE_ENV: 'development' }), '*');
  assert.equal(resolveCorsOriginOption({ NODE_ENV: 'production', CORS_ORIGIN: '' }), false);
  assert.deepEqual(
    resolveCorsOriginOption({
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://resihub.duckdns.org, https://app.resihub.vn ',
    }),
    ['https://resihub.duckdns.org', 'https://app.resihub.vn']
  );
});

test('BG03: GET /api/health trả 200 khi DB sống và trả 503 khi DB ném lỗi', async () => {
  const { createHealthRouter } = await import('../src/routes/health.js');

  const appOk = express();
  appOk.use('/api', createHealthRouter({ query: async () => ({ rows: [{ current_time: new Date() }] }) }));
  const srvOk = appOk.listen(0);
  try {
    const resOk = await fetch(`http://127.0.0.1:${srvOk.address().port}/api/health`);
    const bodyOk = await resOk.json();
    assert.equal(resOk.status, 200);
    assert.equal(bodyOk.status, 'ok');
    assert.equal(bodyOk.database, 'connected');
  } finally {
    srvOk.close();
  }

  const appFail = express();
  appFail.use('/api', createHealthRouter({ query: async () => { throw new Error('conn refused'); } }));
  const srvFail = appFail.listen(0);
  try {
    const resFail = await fetch(`http://127.0.0.1:${srvFail.address().port}/api/health`);
    const bodyFail = await resFail.json();
    assert.equal(resFail.status, 503);
    assert.equal(bodyFail.status, 'degraded');
    assert.match(bodyFail.database, /error:/);
  } finally {
    srvFail.close();
  }
});

test('BG04: trust proxy = 1 giúp isLocalOrDev nhận diện đúng IP công khai qua X-Forwarded-For', async () => {
  const { isLocalOrDev } = await import('../src/middleware/rateLimiter.js');
  const origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const app = express();
  app.set('trust proxy', 1);
  app.get('/check-ip', (req, res) => {
    res.json({ ip: req.ip, skipLimiter: isLocalOrDev(req) });
  });
  const srv = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/check-ip`, {
      headers: { 'X-Forwarded-For': '113.161.72.15' },
    });
    const data = await res.json();
    assert.equal(data.ip, '113.161.72.15');
    assert.equal(data.skipLimiter, false);
  } finally {
    srv.close();
    process.env.NODE_ENV = origEnv;
  }
});

test('BG05: startDailyJobs({ keepAlive: true, runCatchUpOnBoot: false }) giữ timer ref sống và stop() dọn sạch', async () => {
  const { startDailyJobs } = await import('../src/jobs/daily.js');
  const jobKeep = startDailyJobs({ keepAlive: true, runCatchUpOnBoot: false });
  assert.equal(jobKeep.hasRef(), true);
  jobKeep.stop();

  const jobUnref = startDailyJobs({ keepAlive: false, runCatchUpOnBoot: false });
  assert.equal(jobUnref.hasRef(), false);
  jobUnref.stop();
});

test('BG06: GET /api/v1/auth/public-config trả showDemoAccounts và otpDemoMode kèm Cache-Control: no-store', async () => {
  const { default: authRouter } = await import('../src/routes/auth.js');
  const origEnv = process.env.NODE_ENV;
  const origDemo = process.env.SHOW_DEMO_ACCOUNTS;
  const origOtp = process.env.OTP_DEMO_MODE;
  process.env.NODE_ENV = 'production';
  process.env.SHOW_DEMO_ACCOUNTS = 'true';
  process.env.OTP_DEMO_MODE = 'false';
  const app = express();
  app.use('/api/v1/auth', authRouter);
  const srv = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/v1/auth/public-config`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(body, { showDemoAccounts: true, otpDemoMode: false });
  } finally {
    srv.close();
    process.env.NODE_ENV = origEnv;
    if (origDemo === undefined) delete process.env.SHOW_DEMO_ACCOUNTS;
    else process.env.SHOW_DEMO_ACCOUNTS = origDemo;
    if (origOtp === undefined) delete process.env.OTP_DEMO_MODE;
    else process.env.OTP_DEMO_MODE = origOtp;
  }
});
