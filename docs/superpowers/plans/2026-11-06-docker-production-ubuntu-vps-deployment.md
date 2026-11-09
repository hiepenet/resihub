# Docker Production & Ubuntu VPS Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đóng gói toàn bộ hệ thống ResiHub (Web SPA + REST API + Cron Worker + PostgreSQL 16 + Automated Nightly Backup) thành cụm Docker chuẩn Production và triển khai self-host an toàn trên máy chủ Ubuntu VPS đặt tại Việt Nam (chạy ngay với IP trần HTTP `:80` và tự động nâng cấp lên HTTPS khi gắn tên miền).

**Architecture:** Caddy v2 phục vụ tĩnh gói build React SPA (`/srv`), nén `zstd`/`gzip` và reverse-proxy `/api/*` vào container `api` nội bộ; container `worker` dùng chung image `api` nhưng chạy tiến trình cron độc lập (`src/jobs/worker.js`); container `backup` chạy `crond` sao lưu CSDL + tệp đính kèm lúc `02:00` sáng giờ Việt Nam. Mạng nội bộ `resihub_internal` cô lập hoàn toàn cổng `5000` (API) và `5432` (PostgreSQL) khỏi Internet; dữ liệu bền vững lưu trên 4 named volumes (`pgdata`, `api_uploads`, `caddy_data`, `caddy_config`).

**Tech Stack:** Docker Engine & Docker Compose v2, Caddy 2 Alpine, Node.js 22 Alpine (`node:test` + `node:assert/strict`), Express 4, PostgreSQL 16 Alpine (RLS `resihub_app`), React 19 + Vite 8, POSIX sh / Bash.

**Spec:** `docs/superpowers/specs/2026-11-06-docker-production-and-ubuntu-vps-deployment-design.md`

## Global Constraints

- Tuyệt đối giữ `NODE_ENV=production` trên VPS ngoài Internet (không dùng `NODE_ENV=development` để tránh mở mật khẩu dự phòng `'password123'`, OTP bypass `'123456'` và tắt Rate Limiter).
- Tách riêng hai công tắc runtime `OTP_DEMO_MODE=true|false` và `SHOW_DEMO_ACCOUNTS=true|false` (đọc qua `GET /api/v1/auth/public-config`, `Cache-Control: no-store`) để có thể bật/tắt tức thì giao diện Demo và mã OTP kiểm thử trên VPS trong ~2 giây mà **không cần build lại Frontend image** và vẫn giữ nguyên mọi khóa bảo mật của `NODE_ENV=production`.
- Không expose cổng `5000` (API) và `5432` (PostgreSQL) ra host (`0.0.0.0`); chỉ duy nhất service `web` mở cổng `80/tcp`, `443/tcp`, `443/udp`.
- Không sửa `docker-compose.yml`, `api/Dockerfile`, `frontend/Dockerfile` hiện tại — giữ nguyên 100% môi trường local dev và toàn bộ test suite `cd api && npm test` (`node --test --test-concurrency=1`).
- Không tự động ghi đè dữ liệu mẫu khi khởi động Production: mặc định `SEED_DEMO_ON_FIRST_BOOT=false` chạy `bootstrapProd.js` idempotent để đồng bộ mật khẩu role RLS `resihub_app` (`APP_DB_PASSWORD`) và khởi tạo sạch `organization` + 4 `role` + `service_catalog` + `system_setting` + tài khoản `SYS_ADMIN` gốc; khi `SEED_DEMO_ON_FIRST_BOOT=true` và bảng `organization` đang trống (`0` dòng), nạp 1 lần dữ liệu mẫu Vinhomes (`seed_vinhomes.js`) rồi chạy `bootstrapProd.js` đồng bộ `resihub_app`.
- Thư mục `uploads/` bắt buộc gắn vào Docker Named Volume `api_uploads` với quyền đọc/ghi cho user non-root `node` (UID `1000`); không phục vụ static công khai `/uploads/*` trên Caddy (mọi lượt xem đi qua `/api/v1/attachments/:id/view` có kiểm tra RBAC/RLS và ghi `audit_log`).
- Giữ `api` chạy đúng `1` instance (`replicas: 1`) vì `otpStore`, `emailLoginTracker`, `resetTokenStore` lưu trên RAM tiến trình.
- Đồng bộ múi giờ `Asia/Ho_Chi_Minh` xuyên suốt Ubuntu OS, PostgreSQL (`TZ`/`PGTZ`) và Node.js (`TZ`).
- Tất cả mật khẩu sinh cho `.env.production` dùng `openssl rand -hex 32` (64 ký tự hex một dòng, không chứa `/`, `+`, `=`, `@` gây vỡ chuỗi kết nối URI hoặc xuống dòng).

## Review Focus

1. **Lệch schema trên CSDL trắng mới khởi tạo lần đầu** — bản gộp `002_core_tables.sql` / `003_constraints_and_indexes.sql` hiện thiếu một số cột (`app_user.token_version`, `idempotency_key.actor_id/request_hash/state/status_code`, `service_catalog.is_active`, `contract.is_room_transfer`, v.v.) khiến đăng nhập và ghi dữ liệu lỗi `500` trên VPS mới → **Task 1** đồng bộ DDL và ghim bằng `api/test/deployment_migrations_schema.test.js`.
2. **Mất hiệu lực Rate Limiter và rớt header `Idempotency-Key` phía sau Caddy** — thiếu `app.set('trust proxy', 1)` khiến mọi IP Internet bị nhận nhầm là IP Docker `172.x.x.x`, còn cấu hình `cors` sai làm mất `allowedHeaders`/`exposedHeaders` → **Task 2** ghim bằng `api/test/deployment_backend_guards.test.js`.
3. **Trống `service_catalog` / `system_setting` hoặc tạo trùng dữ liệu khi `api` restart nhiều lần** — `008_seeds.sql` chạy lúc bảng `organization` còn trống nên chèn 0 dòng, còn `user_role` có `building_id IS NULL` không ăn `ON CONFLICT` thường → **Task 3** bù dữ liệu nền trong `bootstrapProd.js` và ghim bằng `api/test/deployment_bootstrap_prod.test.js`.
4. **Lỗi CRLF (`\r\n`) từ Windows sang Alpine, mất chứng chỉ SSL khi recreate `web`, hoặc `worker` thiếu biến môi trường** — ghim bằng `.gitattributes` + `sed -i 's/\r$//'` trong `Dockerfile.prod`, named volumes `caddy_data`/`caddy_config`, truyền đủ `DATABASE_URL` + `JWT_SECRET` cho `worker` và kiểm chứng ở **Task 5** + **Task 8**.
5. **Kịch bản `restore.sh` ghi đè nhầm DB đang chạy hoặc chặn Upload >1MB trên Caddy** — `request_body { max_size 25MB }` trong `Caddyfile` và chế độ diễn tập `--verify-only` trên DB nháp `resihub_restore_drill` có `trap` tự dọn sạch → kiểm chứng thực tế ở **Task 6** & **Task 8**.

---

## Cấu Trúc File Thay Đổi & Tạo Mới

```text
resihub/
├── .gitignore                                              [MOD] + .env.production, backups/
├── .gitattributes                                          [NEW] Ép LF cho *.sh, Caddyfile, Dockerfile*
├── .env.production.example                                 [NEW] Mẫu cấu hình Production đầy đủ
├── docker-compose.prod.yml                                 [NEW] Cụm 5 dịch vụ: postgres, api, worker, web, backup
├── api/
│   ├── .dockerignore                                       [MOD] Loại trừ .env*, uploads/, test/, *.md
│   ├── Dockerfile.prod                                     [NEW] Multi-stage Node 22 Alpine, non-root su-exec
│   ├── docker-entrypoint.sh                                [NEW] Chown uploads → migrate → bootstrap → su-exec node
│   ├── src/
│   │   ├── config/env.js                                   [MOD] + isOtpDemoEnabled(), isDemoAccountsEnabled(), resolveCorsOriginOption()
│   │   ├── db/
│   │   │   ├── migrate.js                                  [MOD] + pg_advisory_lock(73918201) & export runMigrations()
│   │   │   ├── bootstrapProd.js                            [NEW] Đồng bộ resihub_app + init org/roles/catalog/settings/admin
│   │   │   └── migrations/
│   │   │       ├── 002_core_tables.sql                     [MOD] Bổ sung đủ cột/ràng buộc cho DB khởi tạo mới
│   │   │       ├── 003_constraints_and_indexes.sql         [MOD] Đồng bộ partial unique indexes hợp đồng & hóa đơn
│   │   │       └── 010_production_schema_alignment.sql     [NEW] Migration idempotent đồng bộ cho cả DB hiện hữu
│   │   ├── jobs/
│   │   │   ├── daily.js                                    [MOD] Mở rộng startDailyJobs({ ..., keepAlive })
│   │   │   └── worker.js                                   [NEW] Entrypoint tiến trình Cron Worker độc lập
│   │   ├── routes/
│   │   │   ├── auth.js                                     [MOD] + GET /public-config & dùng isOtpDemoEnabled()
│   │   │   ├── public.js                                   [MOD] Dùng isOtpDemoEnabled() cho cả log & devOtp giữ chỗ
│   │   │   └── health.js                                   [MOD] Trả HTTP 503 khi mất kết nối PostgreSQL
│   │   └── server.js                                       [MOD] trust proxy, CORS production-safe, cờ ENABLE_IN_PROCESS_CRON
│   └── test/
│       ├── deployment_migrations_schema.test.js            [NEW] Kiểm tra hợp đồng DDL & khóa migrate
│       ├── deployment_backend_guards.test.js               [NEW] Kiểm tra OTP/Demo flags, CORS, health 503, keepAlive, trust proxy
│       └── deployment_bootstrap_prod.test.js               [NEW] Kiểm tra tính idempotent của bootstrapProd
├── frontend/
│   ├── .dockerignore                                       [MOD] Loại trừ .env*, dist/, *.md
│   ├── Dockerfile.prod                                     [NEW] Multi-stage Vite build → Caddy 2 Alpine
│   └── src/
│       ├── pages/auth/LoginPage.jsx                        [MOD] Bật/tắt khung tài khoản Demo động theo /api/v1/auth/public-config
│       └── services/
│           ├── auth.service.js                             [MOD] + getPublicConfig()
│           └── api.js                                      [MOD] Phủ kín prefix endpoint cần Idempotency-Key
└── deploy/
    ├── Caddyfile                                           [NEW] Reverse proxy /api/* + SPA fallback + Auto-HTTPS + 25MB body
    ├── backup-cron.sh                                      [NEW] Script sao lưu thực thi bên trong container backup
    ├── backup.sh                                           [NEW] Lệnh gọi sao lưu nhanh từ máy chủ Ubuntu
    ├── restore.sh                                          [NEW] Khôi phục DB/uploads kèm chế độ diễn tập --verify-only
    ├── demo-mode.sh                                        [NEW] Bật/tắt giao diện Demo tức thì trên VPS (on [--seed] | off | status)
    ├── setup-ubuntu-vps.sh                                 [NEW] Cài đặt Ubuntu 22.04/24.04: TZ, Swap 2GB, Docker, UFW
    └── HUONG_DAN_DEPLOY_UBUNTU.md                          [NEW] Tài liệu vận hành tiếng Việt từng bước (IP trần → DuckDNS HTTPS)
```

---

### Task 1: Đồng bộ Schema Migration cho CSDL Sạch & Khóa Chống Chạy Trùng (`migrate.js`)

**Files:**
- Modify: `api/src/db/migrations/002_core_tables.sql`
- Modify: `api/src/db/migrations/003_constraints_and_indexes.sql`
- Create: `api/src/db/migrations/010_production_schema_alignment.sql`
- Modify: `api/src/db/migrate.js`
- Test: `api/test/deployment_migrations_schema.test.js`

**Interfaces:**
- Produces: `export const MIGRATION_ADVISORY_LOCK_KEY = 73918201` và `export async function runMigrations({ poolInstance = pool, closePool = true } = {}): Promise<void>` từ `api/src/db/migrate.js` (chỉ tự động gọi `runMigrations()` ở cấp module khi file được chạy trực tiếp qua CLI).
- Produces: Bộ schema `001`..`010` đầy đủ mọi cột và ràng buộc `CHECK` mà tầng `routes/` và `middleware/` đang truy vấn trên một database PostgreSQL hoàn toàn trống.

- [ ] **Step 1: Viết bài test kiểm tra tính đầy đủ của DDL và khóa `pg_advisory_lock`**

  Tạo `api/test/deployment_migrations_schema.test.js` dùng `node:test` và `node:assert/strict`:
  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migDir = path.join(__dirname, '../src/db/migrations');

  test('DDL01: 002_core_tables.sql và 010_production_schema_alignment.sql có đủ các cột bắt buộc cho DB mới', () => {
    const core = fs.readFileSync(path.join(migDir, '002_core_tables.sql'), 'utf8');
    const alignPath = path.join(migDir, '010_production_schema_alignment.sql');
    assert.equal(fs.existsSync(alignPath), true, 'Thiếu file 010_production_schema_alignment.sql');
    const align = fs.readFileSync(alignPath, 'utf8');

    const requiredTokens = [
      'token_version',
      'privacy_consent_at',
      'privacy_policy_version',
      'desired_apartment_id',
      'application_note',
      'is_room_transfer',
      'transfer_deposit',
      'desired_date',
      'is_active',
      'prorata_amount',
      'request_hash',
      'status_code',
      'DEDUCTED_FULL',
      'ADJUSTED',
      'NEEDS_MANUAL_REVIEW',
    ];
    for (const token of requiredTokens) {
      assert.match(core, new RegExp(`\\b${token}\\b`), `002_core_tables.sql thiếu ${token}`);
      assert.match(align, new RegExp(`\\b${token}\\b`), `010_production_schema_alignment.sql thiếu ${token}`);
    }
  });

  test('DDL02: migrate.js dùng pg_advisory_lock(73918201) và luôn giải phóng khóa trong finally', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh';
    const { runMigrations, MIGRATION_ADVISORY_LOCK_KEY } = await import('../src/db/migrate.js');
    assert.equal(MIGRATION_ADVISORY_LOCK_KEY, 73918201);

    const calls = [];
    const fakeClient = {
      async query(sql) {
        calls.push(String(sql).trim());
        if (String(sql).includes('SELECT name FROM _migrations')) {
          const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
          return { rows: files.map((name) => ({ name })) };
        }
        return { rows: [] };
      },
      release() {
        calls.push('RELEASE_CLIENT');
      },
    };
    const fakePool = {
      async connect() { return fakeClient; },
      async end() { calls.push('END_POOL'); },
    };

    await runMigrations({ poolInstance: fakePool, closePool: false });
    assert.ok(calls.some((c) => c.includes('pg_advisory_lock(73918201)')));
    assert.ok(calls.some((c) => c.includes('pg_advisory_unlock(73918201)')));
    assert.ok(!calls.includes('END_POOL'));
  });
  ```

- [ ] **Step 2: Chạy test để xác nhận FAIL**

  Run: `cd api && node --test test/deployment_migrations_schema.test.js`
  Expected: FAIL (`Thiếu file 010_production_schema_alignment.sql` và `runMigrations is not a function`).

- [ ] **Step 3: Cập nhật `002_core_tables.sql`, `003_constraints_and_indexes.sql` và tạo `010_production_schema_alignment.sql`**

  Cập nhật đúng định nghĩa bảng trong `002_core_tables.sql` và lặp lại dạng idempotent (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, cập nhật `CHECK` constraints) trong `010_production_schema_alignment.sql` cho các điểm sau:
  - `person`: thêm `privacy_consent_at TIMESTAMPTZ`, `privacy_policy_version TEXT`.
  - `app_user`: thêm `token_version INT NOT NULL DEFAULT 1`.
  - `zone`: thêm `status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE'))`.
  - `tenant`: thêm `desired_apartment_id UUID REFERENCES apartment(id) ON DELETE SET NULL`, `application_note TEXT`, `rejection_reason TEXT`.
  - `contract`: thêm `is_room_transfer BOOLEAN NOT NULL DEFAULT FALSE`, `transfer_deposit BOOLEAN NOT NULL DEFAULT TRUE`.
  - `contract_request`: thêm `desired_date DATE`; đặt `status` default `'SUBMITTED'` với `CHECK (status IN ('SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'))`.
  - `deposit`: bổ sung `'DEDUCTED_FULL'` vào `status CHECK`.
  - `service_request`: bổ sung `images TEXT[] DEFAULT '{}'`, `internal_note TEXT`, `resolved_by UUID REFERENCES app_user(id) ON DELETE SET NULL`, `rating INTEGER CHECK (rating BETWEEN 1 AND 5)`, `rating_note TEXT`; mở rộng `category CHECK` gồm `('ELECTRICAL','PLUMBING','HVAC','FURNITURE','APPLIANCE','STRUCTURAL','CLEANING','SECURITY','OTHER')`; mở rộng `ai_triage_status CHECK` gồm `('PENDING','SUGGESTED','NEEDS_MANUAL_REVIEW','ACCEPTED','OVERRIDDEN','FAILED','SKIPPED')`.
  - `service_catalog`: thêm `is_active BOOLEAN NOT NULL DEFAULT TRUE`.
  - `service_subscription`: thêm `prorata_amount BIGINT NOT NULL DEFAULT 0`.
  - `invoice`: bổ sung `'ADJUSTED'` vào `status CHECK`; chuẩn hóa `invoice_paid_lte_total_check` (`paid_amount >= 0 AND total_amount >= 0 AND paid_amount <= total_amount`).
  - `system_setting`: thêm `updated_by UUID REFERENCES app_user(id) ON DELETE SET NULL`.
  - `idempotency_key`: chuẩn hóa cột khớp `api/src/middleware/idempotency.js` gồm `actor_id UUID REFERENCES app_user(id) ON DELETE CASCADE` (nullable cho luồng public), `scope_key TEXT NOT NULL`, `method TEXT NOT NULL`, `route_path TEXT NOT NULL`, `idem_key TEXT NOT NULL`, `request_hash TEXT NOT NULL`, `state TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (state IN ('IN_PROGRESS', 'COMPLETED'))`, `status_code INTEGER`, `response_body JSONB`, `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')`, `UNIQUE (org_id, scope_key, method, route_path, idem_key)` + `GRANT ALL PRIVILEGES ON TABLE idempotency_key TO resihub_app`.
  - Trong `003_constraints_and_indexes.sql` (và `010`): sửa `uq_contract_open_room_transfer` đánh trên `contract (parent_contract_id) WHERE is_room_transfer = TRUE AND status IN ('DRAFT', 'PENDING_APPROVAL')`; sửa `idx_invoice_unique_active_period` dùng điều kiện `WHERE status NOT IN ('CANCELLED', 'VOID') AND COALESCE(invoice_type, 'REGULAR') <> 'LATE_FEE_SETTLEMENT'`.

- [ ] **Step 4: Cập nhật `api/src/db/migrate.js` bổ sung `pg_advisory_lock(73918201)`**

  Export `MIGRATION_ADVISORY_LOCK_KEY = 73918201` và `runMigrations({ poolInstance = pool, closePool = true } = {})`. Ngay sau `connect()`, gọi `await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY])`; trong khối `finally`, gọi `await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => {})` trước `client.release()`, và chỉ gọi `await poolInstance.end()` khi `closePool === true`. Chỉ tự kích hoạt `runMigrations()` khi `process.argv[1] && path.resolve(process.argv[1]) === __filename`.

- [ ] **Step 5: Chạy lại test để xác nhận PASS**

  Run: `cd api && node --test test/deployment_migrations_schema.test.js`
  Expected: PASS (2/2 tests).

- [ ] **Step 6: Commit**

  ```bash
  git add api/src/db/migrations/002_core_tables.sql \
          api/src/db/migrations/003_constraints_and_indexes.sql \
          api/src/db/migrations/010_production_schema_alignment.sql \
          api/src/db/migrate.js \
          api/test/deployment_migrations_schema.test.js
  git commit -m "fix(db): align clean-install schema columns/constraints and add migration advisory lock"
  ```

---

### Task 2: Điều chỉnh Mã nguồn Backend cho Môi trường Production

**Files:**
- Modify: `api/src/config/env.js`
- Modify: `api/src/routes/auth.js:114-124`
- Modify: `api/src/routes/public.js:270-282`
- Modify: `api/src/routes/health.js:1-26`
- Modify: `api/src/server.js:36-46,80-85,129-136`
- Modify: `api/src/jobs/daily.js:1646-1703`
- Test: `api/test/deployment_backend_guards.test.js`

**Interfaces:**
- Produces: `export function isOtpDemoEnabled(envObj = process.env): boolean` và `export function isDemoAccountsEnabled(envObj = process.env): boolean` từ `api/src/config/env.js`.
- Produces: `GET /api/v1/auth/public-config` trả `{ showDemoAccounts: boolean, otpDemoMode: boolean }` (`Cache-Control: no-store`) từ `api/src/routes/auth.js`.
- Produces: `export function resolveCorsOriginOption(envObj = process.env): '*' | false | string[]` (từ `api/src/config/env.js` để `server.js` và unit test dùng chung).
- Produces: `export function createHealthRouter(dbPool = pool): express.Router` (vẫn giữ `export default createHealthRouter()` tương thích ngược trong `api/src/routes/health.js`).
- Produces: `export function startDailyJobs(options?: { targetHour?: number, targetMinute?: number, runCatchUpOnBoot?: boolean, keepAlive?: boolean }): { stop(): void, hasRef(): boolean }` từ `api/src/jobs/daily.js`.

- [ ] **Step 1: Viết bài test cho các cơ chế bảo vệ & công tắc Demo runtime ở Backend**

  Tạo `api/test/deployment_backend_guards.test.js` dùng `node:test` và `node:assert/strict`:
  ```js
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
    const resOk = await fetch(`http://127.0.0.1:${srvOk.address().port}/api/health`);
    const bodyOk = await resOk.json();
    srvOk.close();
    assert.equal(resOk.status, 200);
    assert.equal(bodyOk.status, 'ok');
    assert.equal(bodyOk.database, 'connected');

    const appFail = express();
    appFail.use('/api', createHealthRouter({ query: async () => { throw new Error('conn refused'); } }));
    const srvFail = appFail.listen(0);
    const resFail = await fetch(`http://127.0.0.1:${srvFail.address().port}/api/health`);
    const bodyFail = await resFail.json();
    srvFail.close();
    assert.equal(resFail.status, 503);
    assert.equal(bodyFail.status, 'degraded');
    assert.match(bodyFail.database, /error:/);
  });

  test('BG04: trust proxy = 1 giúp isLocalOrDev nhận diện đúng IP công khai qua X-Forwarded-For', async () => {
    const { isLocalOrDev } = await import('../src/middleware/rateLimiter.js');
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = express();
      app.set('trust proxy', 1);
      app.get('/check-ip', (req, res) => {
        res.json({ ip: req.ip, skipLimiter: isLocalOrDev(req) });
      });
      const srv = app.listen(0);
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/check-ip`, {
        headers: { 'X-Forwarded-For': '113.161.72.15' },
      });
      const data = await res.json();
      srv.close();
      assert.equal(data.ip, '113.161.72.15');
      assert.equal(data.skipLimiter, false);
    } finally {
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
  ```

- [ ] **Step 2: Chạy test để xác nhận FAIL**

  Run: `cd api && node --test test/deployment_backend_guards.test.js`
  Expected: FAIL (`isOtpDemoEnabled is not a function`, `createHealthRouter is not a function`, `jobKeep.hasRef is not a function`).

- [ ] **Step 3: Triển khai các hàm & cấu hình trong `env.js`, `auth.js`, `public.js`, `health.js`, `daily.js`, `server.js`**

  - `api/src/config/env.js`:
    - Thêm `export function isOtpDemoEnabled(envObj = process.env)` trả `envObj.NODE_ENV !== 'production' || envObj.OTP_DEMO_MODE === 'true'`.
    - Thêm `export function isDemoAccountsEnabled(envObj = process.env)` trả `envObj.NODE_ENV !== 'production' || envObj.SHOW_DEMO_ACCOUNTS === 'true'`.
    - Thêm `export function resolveCorsOriginOption(envObj = process.env)`: nếu `envObj.NODE_ENV !== 'production'` trả `'*'`; ngược lại tách `envObj.CORS_ORIGIN` theo dấu phẩy, `.map(s => s.trim()).filter(Boolean)`, nếu mảng rỗng trả `false`, nếu có phần tử trả mảng đó.
  - `api/src/routes/auth.js`:
    - Bổ sung route công khai `router.get('/public-config', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ showDemoAccounts: isDemoAccountsEnabled(), otpDemoMode: isOtpDemoEnabled() }); });`.
    - Thay 2 vị trí `process.env.NODE_ENV !== 'production'` ở luồng `/otp/request` (dòng 114 & 122) và ở luồng `/forgot-password` (`devResetCode` + `console.log` dòng 621–626) bằng `isOtpDemoEnabled()`. Giữ nguyên khóa cứng `process.env.NODE_ENV !== 'production'` tại mật khẩu dự phòng `password123` (dòng 294, 581).
  - `api/src/routes/public.js`: tại `/reservations/otp/request` (dòng 270–280), bọc **cả khối `console.log` mã OTP lẫn gán `responsePayload.devOtp`** trong `if (isOtpDemoEnabled())`.
  - `api/src/routes/health.js`: export `createHealthRouter(dbPool = pool)` và `export default createHealthRouter()`. Khi query thành công trả `200` (`status: 'ok'`, `database: 'connected'`); khi vào `catch` trả `res.status(503).json({ status: 'degraded', app: 'ResiHub API', version: '1.0.0', timestamp: new Date().toISOString(), database: \`error: \${err.message}\` })`.
  - `api/src/jobs/daily.js`: trong `startDailyJobs(options = {})`, đọc thêm `keepAlive = false` từ `options`. Chỉ gọi `timer.unref?.()` khi `!keepAlive`. Bổ sung method `hasRef() { return Boolean(timer?.hasRef?.()); }` trên object trả về cùng với `stop()`.
  - `api/src/server.js`:
    - Đặt `if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true') { app.set('trust proxy', 1); }` ngay sau `const app = express();` (trước `cors` và `generalLimiter`).
    - Trong `app.use(cors({ ... }))`, dùng `origin: resolveCorsOriginOption()` và **giữ nguyên** `methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']`, `allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key']`, `exposedHeaders: ['Idempotent-Replayed']` (không bật `credentials: true`).
    - Tại `app.listen`, bọc `if (process.env.ENABLE_IN_PROCESS_CRON !== 'false') { startDailyJobs(); }`.

- [ ] **Step 4: Chạy test mới và toàn bộ bộ test hiện có để xác nhận không hồi quy**

  Run: `cd api && node --test test/deployment_backend_guards.test.js && npm test`
  Expected: Toàn bộ tests PASS, exit code `0`.

- [ ] **Step 5: Commit**

  ```bash
  git add api/src/config/env.js api/src/routes/auth.js api/src/routes/public.js \
          api/src/routes/health.js api/src/jobs/daily.js api/src/server.js \
          api/test/deployment_backend_guards.test.js
  git commit -m "feat(api): add OTP_DEMO_MODE, trust proxy, production CORS, 503 healthcheck, and cron keepAlive"
  ```

---

### Task 3: Tiến trình Cron Worker Độc lập, Bootstrap Production & Docker Entrypoint

**Files:**
- Create: `api/src/jobs/worker.js`
- Create: `api/src/db/bootstrapProd.js`
- Create: `api/docker-entrypoint.sh`
- Test: `api/test/deployment_bootstrap_prod.test.js`

**Interfaces:**
- Consumes: `startDailyJobs({ keepAlive, runCatchUpOnBoot })` từ `api/src/jobs/daily.js` (Task 2); `adminPool`, `appPool` từ `api/src/db/client.js`.
- Produces:
  - `export const BOOTSTRAP_ADVISORY_LOCK_KEY = 73918202`
  - `export async function runProductionBootstrap({ poolInstance = adminPool, envObj = process.env, closePool = false } = {}): Promise<{ orgId: string, createdAdmin: boolean, syncedAppRole: boolean }>` trong `api/src/db/bootstrapProd.js`.
  - `api/src/jobs/worker.js` — CLI entrypoint cho container `worker`.
  - `api/docker-entrypoint.sh` — POSIX `#!/bin/sh` entrypoint cho image `resihub-api:prod`.

- [ ] **Step 1: Viết bài test cho tính idempotent và bảo toàn dữ liệu của `runProductionBootstrap`**

  Tạo `api/test/deployment_bootstrap_prod.test.js`:
  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh';

  function createFakeBootstrapPool() {
    const state = {
      orgs: [],
      roles: [],
      catalog: [],
      settings: [],
      persons: [],
      users: [],
      userRoles: [],
      alteredPassword: null,
      locked: false,
    };

    const client = {
      async query(sql, params = []) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (s.includes('pg_advisory_lock')) { state.locked = true; return { rows: [] }; }
        if (s.includes('pg_advisory_unlock')) { state.locked = false; return { rows: [] }; }
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.includes("format('ALTER ROLE resihub_app WITH LOGIN PASSWORD %L'")) {
          return { rows: [{ ddl: `ALTER ROLE resihub_app WITH LOGIN PASSWORD '${params[0]}'` }] };
        }
        if (s.startsWith('ALTER ROLE resihub_app WITH LOGIN PASSWORD')) {
          state.alteredPassword = s;
          return { rows: [] };
        }
        if (s.startsWith('SELECT id FROM organization')) {
          return { rows: state.orgs.slice(0, 1) };
        }
        if (s.startsWith('INSERT INTO organization')) {
          const row = { id: '11111111-1111-4111-8111-111111111111', name: params[0] };
          state.orgs.push(row);
          return { rows: [row] };
        }
        if (s.startsWith('INSERT INTO role')) {
          const [orgId, code, name, scope] = params;
          if (!state.roles.find((r) => r.orgId === orgId && r.code === code)) {
            state.roles.push({ id: `role-${code}`, orgId, code, name, scope });
          }
          return { rows: [] };
        }
        if (s.startsWith('SELECT id, code FROM role WHERE org_id = $1')) {
          return { rows: state.roles.filter((r) => r.orgId === params[0]) };
        }
        if (s.startsWith('INSERT INTO service_catalog')) {
          const [orgId, code] = params;
          if (!state.catalog.find((c) => c.orgId === orgId && c.code === code)) {
            state.catalog.push({ orgId, code });
          }
          return { rows: [] };
        }
        if (s.startsWith('INSERT INTO system_setting')) {
          const [orgId, key] = params;
          if (!state.settings.find((st) => st.orgId === orgId && st.key === key)) {
            state.settings.push({ orgId, key });
          }
          return { rows: [] };
        }
        if (s.includes("WHERE r.code = 'SYS_ADMIN'")) {
          const hasSys = state.userRoles.some((ur) => ur.roleId === 'role-SYS_ADMIN');
          return { rows: hasSys ? [{ exists: 1 }] : [] };
        }
        if (s.startsWith('INSERT INTO person')) {
          const p = { id: 'person-admin', orgId: params[0], email: params[3] };
          state.persons.push(p);
          return { rows: [p] };
        }
        if (s.startsWith('INSERT INTO app_user')) {
          const u = { id: 'user-admin', personId: params[0], passwordHash: params[2] };
          state.users.push(u);
          return { rows: [u] };
        }
        if (s.startsWith('INSERT INTO user_role')) {
          state.userRoles.push({ userId: params[0], roleId: params[1] });
          return { rows: [] };
        }
        throw new Error(`Unhandled SQL in test mock: ${s}`);
      },
      release() {},
    };

    return {
      state,
      pool: {
        async connect() { return client; },
        async end() {},
      },
    };
  }

  test('BP01: runProductionBootstrap chạy 2 lần liên tiếp hoàn toàn idempotent và khởi tạo đủ dữ liệu nền', async () => {
    const { runProductionBootstrap } = await import('../src/db/bootstrapProd.js');
    const { state, pool } = createFakeBootstrapPool();
    const envObj = {
      APP_DB_PASSWORD: 'app_secret_hex_password',
      INIT_ORG_NAME: 'BQL Tòa Nhà Việt Nam',
      INIT_ADMIN_EMAIL: 'admin@resihub.vn',
      INIT_ADMIN_PASSWORD: 'StrongPassword123',
      INIT_ADMIN_PHONE: '0900000001',
    };

    const first = await runProductionBootstrap({ poolInstance: pool, envObj, closePool: false });
    assert.equal(first.syncedAppRole, true);
    assert.equal(first.createdAdmin, true);
    assert.equal(state.orgs.length, 1);
    assert.equal(state.roles.length, 4);
    assert.equal(state.catalog.length, 7);
    assert.equal(state.settings.length, 6);
    assert.equal(state.users.length, 1);
    assert.equal(state.locked, false);

    const second = await runProductionBootstrap({ poolInstance: pool, envObj, closePool: false });
    assert.equal(second.createdAdmin, false);
    assert.equal(state.orgs.length, 1);
    assert.equal(state.users.length, 1);
    assert.equal(state.userRoles.length, 1);
  });
  ```

- [ ] **Step 2: Chạy test để xác nhận FAIL**

  Run: `cd api && node --test test/deployment_bootstrap_prod.test.js`
  Expected: FAIL (`Cannot find module '../src/db/bootstrapProd.js'`).

- [ ] **Step 3: Tạo `api/src/db/bootstrapProd.js`**

  Triển khai `runProductionBootstrap({ poolInstance = adminPool, envObj = process.env, closePool = false } = {})` theo đúng thứ tự trong transaction + `pg_advisory_lock(73918202)`:
  1. Nếu `envObj.APP_DB_PASSWORD` có giá trị: chạy `SELECT format('ALTER ROLE resihub_app WITH LOGIN PASSWORD %L', $1::text) AS ddl` với `[envObj.APP_DB_PASSWORD]`, rồi thực thi `await client.query(ddl)` để đồng bộ mật khẩu role RLS an toàn tuyệt đối với ký tự đặc biệt.
  2. Kiểm tra `SELECT id FROM organization ORDER BY created_at ASC LIMIT 1`. Nếu trống, `INSERT INTO organization (name, settings) VALUES ($1, '{"currency":"VND","timezone":"Asia/Ho_Chi_Minh"}'::jsonb) RETURNING id` với `envObj.INIT_ORG_NAME || 'Ban Quản Lý Tòa Nhà ResiHub'`.
  3. Đảm bảo đủ 4 vai trò chuẩn (`OWNER`/`org`, `MANAGER`/`building`, `RESIDENT`/`building`, `SYS_ADMIN`/`org`) bằng `INSERT INTO role (org_id, code, name, scope) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, code) DO NOTHING`, sau đó đọc `SELECT id, code FROM role WHERE org_id = $1`.
  4. Đảm bảo 7 dịch vụ chuẩn (`ELECTRICITY`, `WATER`, `INTERNET_FIBER`, `MOTORBIKE_PARKING`, `CAR_PARKING`, `CLEANING_WEEKLY`, `MANAGEMENT_FEE`) trong `service_catalog` (dùng `INSERT INTO service_catalog ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM service_catalog WHERE org_id = $1 AND building_id IS NULL AND lower(code) = lower($2))`) và 6 khóa cấu hình chuẩn (`billing_config`, `sla_config`, `contact_config`, `approval_config`, `reservation_cancel_policy`, `ai_config` — giá trị y hệt `008_seeds.sql`) trong `system_setting` với `ON CONFLICT (org_id, key) DO NOTHING` (bảo toàn cấu hình đã chỉnh sửa).
  5. Kiểm tra đã có tài khoản giữ quyền `SYS_ADMIN` chưa (`SELECT 1 AS exists FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE r.code = 'SYS_ADMIN' LIMIT 1`). Nếu chưa có và cả `INIT_ADMIN_EMAIL` lẫn `INIT_ADMIN_PASSWORD` được khai báo (ném lỗi rõ ràng nếu mật khẩu `< 8` ký tự): băm mật khẩu bằng `bcrypt.hash(pwd, 10)`, chèn `person` (`full_name = 'Quản trị hệ thống'`, `phone = envObj.INIT_ADMIN_PHONE || '0900000001'`, `email = cleanEmail`), chèn `app_user` (`auth_uid = 'sys-admin-init'`, `status = 'ACTIVE'`), và chèn `user_role` (`user_id`, `role_id` của `SYS_ADMIN`, `building_id = NULL`).
  6. Luôn `pg_advisory_unlock(73918202)` trong `finally`. Khi chạy trực tiếp từ CLI (`path.resolve(process.argv[1]) === __filename`), gọi `runProductionBootstrap({ closePool: true })` và `process.exit(1)` nếu lỗi.

- [ ] **Step 4: Tạo `api/src/jobs/worker.js`**

  ```js
  import '../config/env.js';
  import { adminPool, appPool } from '../db/client.js';
  import { startDailyJobs } from './daily.js';

  async function main() {
    await adminPool.query('SELECT 1');
    const job = startDailyJobs({ keepAlive: true, runCatchUpOnBoot: true });
    console.log('[Worker] ResiHub Daily Cron Worker started (00:05 Asia/Ho_Chi_Minh).');

    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[Worker] Received ${signal}, shutting down gracefully...`);
      job.stop();
      await Promise.allSettled([adminPool.end(), appPool.end()]);
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  main().catch((err) => {
    console.error('[Worker] Fatal startup error:', err);
    process.exit(1);
  });
  ```

- [ ] **Step 5: Tạo `api/docker-entrypoint.sh`**

  Không dùng `pg_isready` phụ thuộc biến rời `PGHOST`/`PGUSER`; kiểm tra kết nối trực tiếp qua `DATABASE_URL` bằng Node để đồng nhất cấu hình:
  ```sh
  #!/bin/sh
  set -eu

  mkdir -p /app/uploads
  chown -R node:node /app/uploads

  if [ "${SKIP_DB_INIT:-false}" != "true" ]; then
    echo "[Entrypoint] Waiting for PostgreSQL via DATABASE_URL..."
    su-exec node node -e '
      import("pg").then(async ({ default: pg }) => {
        for (let i = 1; i <= 30; i++) {
          const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
          try { await c.connect(); await c.query("SELECT 1"); await c.end(); process.exit(0); }
          catch (e) { await c.end().catch(() => {}); if (i === 30) { console.error(e.message); process.exit(1); } await new Promise(r => setTimeout(r, 2000)); }
        }
      });
    '
  fi

  if [ "${RUN_MIGRATIONS_ON_BOOT:-false}" = "true" ]; then
    echo "[Entrypoint] Running database migrations..."
    su-exec node node src/db/migrate.js
  fi

  if [ "${SEED_DEMO_ON_FIRST_BOOT:-false}" = "true" ]; then
    ORG_COUNT=$(su-exec node node -e '
      import("pg").then(async ({ default: pg }) => {
        const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
        await c.connect();
        const r = await c.query("SELECT COUNT(*)::int AS cnt FROM organization");
        await c.end();
        process.stdout.write(String(r.rows[0]?.cnt ?? 0));
      });
    ')
    if [ "${ORG_COUNT}" = "0" ]; then
      echo "[Entrypoint] Empty DB + SEED_DEMO_ON_FIRST_BOOT=true -> seeding Vinhomes demo dataset..."
      su-exec node node src/db/seed_vinhomes.js
    else
      echo "[Entrypoint] Organization already exists (count=${ORG_COUNT}) -> skipping demo seed."
    fi
  fi

  if [ "${RUN_BOOTSTRAP:-false}" = "true" ]; then
    echo "[Entrypoint] Running production bootstrap..."
    su-exec node node src/db/bootstrapProd.js
  fi

  exec su-exec node "$@"
  ```

- [ ] **Step 6: Chạy test xác nhận PASS**

  Run: `cd api && node --test test/deployment_bootstrap_prod.test.js`
  Expected: PASS (1/1 test).

- [ ] **Step 7: Commit**

  ```bash
  git add api/src/db/bootstrapProd.js api/src/jobs/worker.js \
          api/docker-entrypoint.sh api/test/deployment_bootstrap_prod.test.js
  git commit -m "feat(api): add cron worker entrypoint, idempotent production bootstrap, and docker entrypoint"
  ```

---

### Task 4: Điều chỉnh Frontend (Bật/Tắt Giao diện Demo Runtime) & Chuẩn hóa Ignore/LF

**Files:**
- Modify: `frontend/src/services/auth.service.js`
- Modify: `frontend/src/pages/auth/LoginPage.jsx:344-368`
- Modify: `frontend/src/services/api.js:14-22`
- Modify: `.gitignore`
- Create: `.gitattributes`
- Modify: `api/.dockerignore`
- Modify: `frontend/.dockerignore`

**Interfaces:**
- Consumes: `GET /api/v1/auth/public-config` (Task 2) trả `{ showDemoAccounts, otpDemoMode }`.
- Produces: Bản build SPA duy nhất tự động ẩn/hiện khung tài khoản Demo theo cấu hình runtime trên VPS mà không cần build lại; tự động đính kèm `Idempotency-Key` cho mọi thao tác ghi dữ liệu trên Production; khoá lỗi CRLF và chặn rò rỉ `.env.production` / `backups/` / `uploads/`.

- [ ] **Step 1: Kết nối cờ runtime `showDemoAccounts` trên `auth.service.js` & `LoginPage.jsx`**

  - Trong `frontend/src/services/auth.service.js`: bổ sung `getPublicConfig: () => api.get('/api/v1/auth/public-config').then((r) => r.data)`.
  - Trong `frontend/src/pages/auth/LoginPage.jsx`: khai báo `const [showDemoAccounts, setShowDemoAccounts] = useState(Boolean(import.meta.env.DEV));`, thêm `useEffect` gọi `authService.getPublicConfig()` khi mở trang để cập nhật `setShowDemoAccounts(Boolean(cfg?.showDemoAccounts))` (bỏ qua êm nếu lỗi mạng), và bọc khối `{/* Quick Demo Accounts */}` (dòng 345–367) trong `{showDemoAccounts ? ( ... ) : null}`.

- [ ] **Step 2: Mở rộng danh sách `IDEMPOTENT_FINANCIAL_ENDPOINTS` trong `frontend/src/services/api.js`**

  Cập nhật mảng `IDEMPOTENT_FINANCIAL_ENDPOINTS` để bao phủ đầy đủ mọi prefix route có gắn `idempotencyGuard()` ở Backend (interceptor chỉ gắn key mới khi `!config.headers['Idempotency-Key']`, không ghi đè key truyền từ `withIdempotency`):
  ```js
  const IDEMPOTENT_FINANCIAL_ENDPOINTS = [
    '/api/v1/invoices',
    '/api/v1/payments',
    '/api/v1/services',
    '/api/v1/service-catalog',
    '/api/v1/service-subscriptions',
    '/api/v1/contracts',
    '/api/v1/deposits',
    '/api/v1/resident',
    '/api/v1/meters',
    '/api/v1/reservations',
    '/api/v1/public/reservations',
    '/api/v1/service-requests',
    '/api/v1/announcements',
    '/api/v1/notifications',
    '/api/v1/zalo-groups',
    '/api/v1/ai',
    '/api/v1/settings',
  ];
  ```

- [ ] **Step 3: Cập nhật `.gitignore`, tạo `.gitattributes`, và siết `.dockerignore`**

  - `.gitignore`: bổ sung `.env.production` và `backups/` (giữ `!.env.production.example`).
  - `.gitattributes`:
    ```gitattributes
    *.sh text eol=lf
    Dockerfile* text eol=lf
    Caddyfile text eol=lf
    ```
  - `api/.dockerignore`: loại trừ `node_modules`, `npm-debug.log*`, `*.log`, `.env*`, `uploads`, `test`, `test-artifacts`, `*.md`.
  - `frontend/.dockerignore`: loại trừ `node_modules`, `dist`, `npm-debug.log*`, `*.log`, `.env*`, `*.md`.

- [ ] **Step 4: Chạy build và lint Frontend để kiểm chứng**

  Run: `cd frontend && npm run lint && npm run build`
  Expected: Lint sạch (exit `0`) và Vite xuất `frontend/dist/` thành công.

- [ ] **Step 5: Commit**

  ```bash
  git add frontend/src/services/auth.service.js frontend/src/pages/auth/LoginPage.jsx \
          frontend/src/services/api.js .gitignore .gitattributes \
          api/.dockerignore frontend/.dockerignore
  git commit -m "feat(frontend,chore): add runtime demo accounts toggle, cover idempotency prefixes, and harden ignores"
  ```

---

### Task 5: Production Dockerfiles, Caddyfile & Cụm 5 Dịch vụ (`docker-compose.prod.yml`)

**Files:**
- Create: `api/Dockerfile.prod`
- Create: `deploy/Caddyfile`
- Create: `frontend/Dockerfile.prod`
- Create: `docker-compose.prod.yml`
- Create: `.env.production.example`

**Interfaces:**
- Consumes: `api/docker-entrypoint.sh`, `api/src/jobs/worker.js` (Task 3), gói build `frontend` (Task 4), và đường dẫn mount `./deploy/backup-cron.sh` (tạo ở Task 6 trước khi chạy `up -d`).
- Produces: Images `resihub-api:prod`, `resihub-web:prod` và cấu hình cụm 5 services (`postgres`, `api`, `worker`, `web`, `backup`) trên mạng nội bộ `resihub_internal` với 4 named volumes (`pgdata`, `api_uploads`, `caddy_data`, `caddy_config`).

- [ ] **Step 1: Tạo `api/Dockerfile.prod`**

  ```dockerfile
  # --- Stage 1: production dependencies ---
  FROM node:22-alpine AS deps
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci --omit=dev && npm cache clean --force

  # --- Stage 2: non-root runtime ---
  FROM node:22-alpine
  RUN apk add --no-cache su-exec tzdata
  WORKDIR /app
  COPY --from=deps /app/node_modules ./node_modules
  COPY . .
  RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && \
      chmod +x /app/docker-entrypoint.sh && \
      mkdir -p /app/uploads && \
      chown -R node:node /app/uploads /app
  EXPOSE 5000
  ENTRYPOINT ["/app/docker-entrypoint.sh"]
  CMD ["node", "src/server.js"]
  ```

- [ ] **Step 2: Tạo `deploy/Caddyfile`**

  Tách rạch ròi `handle /api/*` và `handle` tĩnh để không bao giờ ghi đè lỗi API thành `index.html`, dùng `X-Frame-Options "SAMEORIGIN"` để không chặn khung xem PDF hợp đồng inline, và mở `max_size 25MB`:
  ```caddyfile
  {$APP_DOMAIN::80} {
    request_body {
      max_size 25MB
    }

    encode zstd gzip

    header {
      X-Content-Type-Options "nosniff"
      X-Frame-Options "SAMEORIGIN"
      Referrer-Policy "strict-origin-when-cross-origin"
      -Server
    }

    handle /api/* {
      reverse_proxy api:5000
    }

    handle {
      root * /srv
      @hashed_assets path /assets/*
      header @hashed_assets Cache-Control "public, max-age=31536000, immutable"
      @html_entry path / /index.html
      header @html_entry Cache-Control "no-cache"
      try_files {path} /index.html
      file_server
    }
  }
  ```

- [ ] **Step 3: Tạo `frontend/Dockerfile.prod` (dùng root repo `.` làm build context)**

  ```dockerfile
  # --- Stage 1: build React SPA ---
  FROM node:22-alpine AS builder
  WORKDIR /app
  COPY frontend/package*.json ./
  RUN npm ci
  COPY frontend/ ./
  RUN npm run build

  # --- Stage 2: serve with Caddy 2 ---
  FROM caddy:2-alpine
  COPY --from=builder /app/dist /srv
  COPY deploy/Caddyfile /etc/caddy/Caddyfile
  EXPOSE 80 443
  ```

- [ ] **Step 4: Tạo `docker-compose.prod.yml` và `.env.production.example`**

  `docker-compose.prod.yml` định nghĩa đủ 5 services, healthchecks, log rotation (`10m` x `3`), mạng nội bộ và 4 named volumes:
  ```yaml
  services:
    postgres:
      image: postgres:16-alpine
      restart: unless-stopped
      environment:
        TZ: Asia/Ho_Chi_Minh
        PGTZ: Asia/Ho_Chi_Minh
        POSTGRES_DB: ${POSTGRES_DB:-resihub}
        POSTGRES_USER: ${POSTGRES_USER:-postgres}
        POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      volumes:
        - pgdata:/var/lib/postgresql/data
      networks:
        - resihub_internal
      healthcheck:
        test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER:-postgres} -d $${POSTGRES_DB:-resihub}"]
        interval: 10s
        timeout: 5s
        retries: 6
      logging: &default-logging
        driver: json-file
        options:
          max-size: "10m"
          max-file: "3"

    api:
      image: resihub-api:prod
      build:
        context: ./api
        dockerfile: Dockerfile.prod
      pull_policy: never
      restart: unless-stopped
      environment:
        TZ: Asia/Ho_Chi_Minh
        NODE_ENV: production
        PORT: 5000
        DATABASE_URL: postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-resihub}
        APP_DB_PASSWORD: ${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}
        APP_DATABASE_URL: postgresql://resihub_app:${APP_DB_PASSWORD}@postgres:5432/${POSTGRES_DB:-resihub}
        JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is required}
        JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET:?JWT_REFRESH_SECRET is required}
        CORS_ORIGIN: ${CORS_ORIGIN:-}
        OTP_DEMO_MODE: ${OTP_DEMO_MODE:-false}
        SHOW_DEMO_ACCOUNTS: ${SHOW_DEMO_ACCOUNTS:-false}
        SEED_DEMO_ON_FIRST_BOOT: ${SEED_DEMO_ON_FIRST_BOOT:-false}
        ENABLE_IN_PROCESS_CRON: "false"
        RUN_MIGRATIONS_ON_BOOT: "true"
        RUN_BOOTSTRAP: "true"
        INIT_ORG_NAME: ${INIT_ORG_NAME:-Ban Quản Lý Tòa Nhà ResiHub}
        INIT_ADMIN_EMAIL: ${INIT_ADMIN_EMAIL:-admin@resihub.vn}
        INIT_ADMIN_PASSWORD: ${INIT_ADMIN_PASSWORD:-}
        INIT_ADMIN_PHONE: ${INIT_ADMIN_PHONE:-0900000001}
        VIETQR_CLIENT_ID: ${VIETQR_CLIENT_ID:-}
        VIETQR_API_KEY: ${VIETQR_API_KEY:-}
        GEMINI_API_KEY: ${GEMINI_API_KEY:-}
        GEMINI_BASE_URL: ${GEMINI_BASE_URL:-https://generativelanguage.googleapis.com/v1beta}
        GEMINI_TIMEOUT_MS: ${GEMINI_TIMEOUT_MS:-45000}
      volumes:
        - api_uploads:/app/uploads
      networks:
        - default
        - resihub_internal
      depends_on:
        postgres:
          condition: service_healthy
      healthcheck:
        test: ["CMD", "wget", "-qO-", "http://127.0.0.1:5000/api/health"]
        interval: 15s
        timeout: 5s
        retries: 5
        start_period: 35s
      logging: *default-logging

    worker:
      image: resihub-api:prod
      build:
        context: ./api
        dockerfile: Dockerfile.prod
      pull_policy: never
      command: ["node", "src/jobs/worker.js"]
      restart: unless-stopped
      environment:
        TZ: Asia/Ho_Chi_Minh
        NODE_ENV: production
        DATABASE_URL: postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-resihub}
        APP_DATABASE_URL: postgresql://resihub_app:${APP_DB_PASSWORD}@postgres:5432/${POSTGRES_DB:-resihub}
        JWT_SECRET: ${JWT_SECRET}
        JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
        OTP_DEMO_MODE: ${OTP_DEMO_MODE:-false}
        RUN_MIGRATIONS_ON_BOOT: "false"
        RUN_BOOTSTRAP: "false"
        GEMINI_API_KEY: ${GEMINI_API_KEY:-}
        GEMINI_BASE_URL: ${GEMINI_BASE_URL:-https://generativelanguage.googleapis.com/v1beta}
        GEMINI_TIMEOUT_MS: ${GEMINI_TIMEOUT_MS:-45000}
      volumes:
        - api_uploads:/app/uploads
      networks:
        - resihub_internal
      depends_on:
        api:
          condition: service_healthy
      healthcheck:
        test: ["CMD-SHELL", "pgrep -f 'src/jobs/worker.js' >/dev/null"]
        interval: 30s
        timeout: 5s
        retries: 3
      logging: *default-logging

    web:
      image: resihub-web:prod
      build:
        context: .
        dockerfile: frontend/Dockerfile.prod
      pull_policy: never
      restart: unless-stopped
      environment:
        APP_DOMAIN: ${APP_DOMAIN:-:80}
      ports:
        - "80:80"
        - "443:443"
        - "443:443/udp"
      volumes:
        - caddy_data:/data
        - caddy_config:/config
      networks:
        - default
        - resihub_internal
      depends_on:
        api:
          condition: service_healthy
      logging: *default-logging

    backup:
      image: postgres:16-alpine
      restart: unless-stopped
      environment:
        TZ: Asia/Ho_Chi_Minh
        PGHOST: postgres
        PGPORT: 5432
        PGDATABASE: ${POSTGRES_DB:-resihub}
        PGUSER: ${POSTGRES_USER:-postgres}
        PGPASSWORD: ${POSTGRES_PASSWORD}
        BACKUP_RETENTION_DAYS: ${BACKUP_RETENTION_DAYS:-30}
      volumes:
        - ./deploy/backup-cron.sh:/usr/local/bin/backup-cron.sh:ro
        - api_uploads:/uploads:ro
        - ./backups:/backups
      networks:
        - resihub_internal
      depends_on:
        postgres:
          condition: service_healthy
      entrypoint:
        - /bin/sh
        - -c
        - |
          echo "0 2 * * * /bin/sh /usr/local/bin/backup-cron.sh >> /proc/1/fd/1 2>> /proc/1/fd/2" > /etc/crontabs/root
          echo "[Backup Cron] Scheduled daily backup at 02:00 Asia/Ho_Chi_Minh (retention: $${BACKUP_RETENTION_DAYS:-30}d)"
          exec crond -f -l 2
      logging: *default-logging

  networks:
    resihub_internal:
      internal: true

  volumes:
    pgdata:
    api_uploads:
    caddy_data:
    caddy_config:
  ```

  > **Phân vùng mạng bảo mật:** `postgres`, `worker` và `backup` chỉ gắn vào `resihub_internal` (`internal: true`) nên bị cô lập hoàn toàn khỏi Internet cả chiều vào lẫn chiều ra; `api` nối thêm `default` (nhưng **không** khai báo `ports:`) để gọi HTTPS chiều ra tới Google Gemini API / VietQR API mà vẫn không phơi cổng `5000` ra host.

  Tạo `.env.production.example` hướng dẫn sinh khóa bằng `openssl rand -hex 32`, đặt placeholder không rỗng `CHANGE_ME_GENERATE_WITH_OPENSSL_RAND_HEX_32` cho 4 biến bắt buộc (`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET` — giúp lệnh kiểm tra cấu hình `docker compose ... config` hoạt động mượt mà, đồng thời nhắc quản trị viên thay mới trên VPS), và đặt mặc định `APP_DOMAIN=:80` (chạy IP trần HTTP cổng 80 ngay lập tức; đổi sang `ten-mien.duckdns.org` hoặc `quanly.tenmien.vn` khi muốn kích hoạt HTTPS tự động).

- [ ] **Step 5: Kiểm tra cú pháp Compose, build cả 2 image và chạy thử container `api` độc lập**

  ```bash
  docker compose -f docker-compose.prod.yml --env-file .env.production.example config >/dev/null
  docker build -f api/Dockerfile.prod -t resihub-api:prod ./api
  docker build -f frontend/Dockerfile.prod -t resihub-web:prod .
  docker run --rm -e SKIP_DB_INIT=true -e NODE_ENV=production \
    -e APP_DATABASE_URL=postgresql://u:p@localhost:5432/db \
    -e JWT_SECRET=test -e JWT_REFRESH_SECRET=test \
    resihub-api:prod node -e "console.log('uid=' + process.getuid())"
  ```
  Expected: Cả hai image build thành công; lệnh `docker run` in ra `uid=1000` (chứng minh `docker-entrypoint.sh` không dính lỗi CRLF và đã hạ quyền xuống user `node` thành công).

- [ ] **Step 6: Commit**

  ```bash
  git add api/Dockerfile.prod frontend/Dockerfile.prod deploy/Caddyfile \
          docker-compose.prod.yml .env.production.example
  git commit -m "feat(docker): add production Dockerfiles, Caddyfile, and 5-service compose stack"
  ```

---

### Task 6: Tự động hóa Sao lưu & Diễn tập Khôi phục (`backup-cron.sh`, `backup.sh`, `restore.sh`)

**Files:**
- Create: `deploy/backup-cron.sh`
- Create: `deploy/backup.sh`
- Create: `deploy/restore.sh`

**Interfaces:**
- Consumes: Container `backup` và `postgres` trong `docker-compose.prod.yml`; file `.env.production`.
- Produces:
  - `deploy/backup-cron.sh` — thực thi bên trong container `backup`: sinh `/backups/db_YYYYMMDD_HHMMSS.dump` + `/backups/uploads_YYYYMMDD_HHMMSS.tar.gz`, kiểm tra kích thước tệp `> 0`, dọn tệp quá `${BACKUP_RETENTION_DAYS:-30}` ngày.
  - `deploy/backup.sh` — kích hoạt ngay một bản sao lưu từ host Ubuntu thông qua container `backup` (dùng chung 100% logic với `crond`, không lộ biến môi trường trên host).
  - `deploy/restore.sh` — hai chế độ `--verify-only [dump_file]` (diễn tập an toàn trên DB nháp `resihub_restore_drill`) và `--apply <dump_file> [uploads_tar]` (khôi phục thật có xác nhận, tự dừng/bật `api` + `worker` và đồng bộ lại `resihub_app`).

- [ ] **Step 1: Tạo `deploy/backup-cron.sh` (POSIX `#!/bin/sh` chạy trong container `backup`)**

  ```sh
  #!/bin/sh
  set -eu

  TS=$(date +%Y%m%d_%H%M%S)
  DB_FILE="/backups/db_${TS}.dump"
  UP_FILE="/backups/uploads_${TS}.tar.gz"
  RETENTION="${BACKUP_RETENTION_DAYS:-30}"

  mkdir -p /backups
  echo "[Backup] Starting PostgreSQL dump -> ${DB_FILE}"
  pg_dump -Fc --no-owner --no-acl -f "${DB_FILE}" "${PGDATABASE}"

  if [ ! -s "${DB_FILE}" ]; then
    echo "[Backup] ERROR: Dump file is empty!" >&2
    rm -f "${DB_FILE}"
    exit 1
  fi

  echo "[Backup] Archiving uploads -> ${UP_FILE}"
  tar -czf "${UP_FILE}" -C /uploads .

  find /backups -type f \( -name "db_*.dump" -o -name "uploads_*.tar.gz" \) -mtime +"${RETENTION}" -delete
  echo "[Backup] Completed successfully at $(date -Iseconds)."
  ```

- [ ] **Step 2: Tạo `deploy/backup.sh` (wrapper gọi từ máy chủ Ubuntu)**

  Xác định `ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"`, kiểm tra tồn tại `${ROOT_DIR}/.env.production`, tạo `${ROOT_DIR}/backups`, gọi:
  `docker compose -f "${ROOT_DIR}/docker-compose.prod.yml" --env-file "${ROOT_DIR}/.env.production" exec -T backup /bin/sh /usr/local/bin/backup-cron.sh`
  sau đó `ls -lh "${ROOT_DIR}/backups" | tail -n 5`.

- [ ] **Step 3: Tạo `deploy/restore.sh` hỗ trợ `--verify-only` và `--apply`**

  - **`--verify-only [dump_file]`**:
    - Nếu không truyền `dump_file`, tự chọn bản `backups/db_*.dump` mới nhất.
    - Đặt `DRILL_DB="resihub_restore_drill"` và đăng ký `trap` dọn sạch `DROP DATABASE IF EXISTS resihub_restore_drill WITH (FORCE);` khi script kết thúc (dù thành công hay lỗi).
    - Copy/đọc luồng dump vào container `backup` (vốn đã mount sẵn `/backups`) để tạo `resihub_restore_drill`, chạy `pg_restore --no-owner --no-privileges -d resihub_restore_drill /backups/$(basename "$DUMP_FILE")`.
    - Chạy câu SQL kiểm tra số lượng bản ghi trên các bảng `organization`, `role`, `app_user`, `building`, `apartment`, `contract`, `invoice` và in bảng biên bản diễn tập rõ ràng (phục vụ tiêu chí Go/No-Go NFR-006).
  - **`--apply <dump_file> [uploads_tar]`**:
    - In cảnh báo đỏ và bắt buộc người vận hành gõ chính xác `KHOI_PHUC_PRODUCTION`.
    - Chạy `docker compose ... stop api worker` để đóng toàn bộ kết nối ứng dụng.
    - Ngắt kết nối dư trên PostgreSQL (`pg_terminate_backend`), chạy `pg_restore --clean --if-exists --no-owner --no-privileges -d "$PGDATABASE" "/backups/$(basename "$DUMP_FILE")"`.
    - Nếu có truyền `uploads_tar`, dùng container tạm gắn volume `api_uploads` xóa nội dung cũ và giải nén `uploads_tar` vào `/app/uploads`.
    - Chạy `docker compose ... start api worker` (`api` khởi động sẽ tự chạy `docker-entrypoint.sh` → `chown node:node /app/uploads` + `migrate.js` + `bootstrapProd.js` đồng bộ lại mật khẩu `resihub_app` khớp `.env.production`).

- [ ] **Step 4: Cấp quyền thực thi và kiểm tra cú pháp shell (`sh -n` / `bash -n`)**

  ```bash
  chmod +x deploy/backup-cron.sh deploy/backup.sh deploy/restore.sh
  sh -n deploy/backup-cron.sh
  bash -n deploy/backup.sh
  bash -n deploy/restore.sh
  ```
  Expected: Không có bất kỳ lỗi cú pháp nào (exit `0`).

- [ ] **Step 5: Commit**

  ```bash
  git add deploy/backup-cron.sh deploy/backup.sh deploy/restore.sh
  git commit -m "feat(deploy): add container-native nightly backup cron and verify-only/apply restore scripts"
  ```

---

### Task 7: Script Cài Đặt Hạ tầng Ubuntu VPS, Công Tắc Demo & Tài Liệu Vận Hành Tiếng Việt

**Files:**
- Create: `deploy/setup-ubuntu-vps.sh`
- Create: `deploy/demo-mode.sh`
- Create: `deploy/HUONG_DAN_DEPLOY_UBUNTU.md`

**Interfaces:**
- Produces:
  - `deploy/setup-ubuntu-vps.sh` — script idempotent chạy bằng `sudo bash deploy/setup-ubuntu-vps.sh` trên Ubuntu 22.04 / 24.04 LTS mới thuê.
  - `deploy/demo-mode.sh` — lệnh bật/tắt tức thì giao diện Demo trên VPS (`./deploy/demo-mode.sh on [--seed]` | `off` | `status`) không cần build lại Frontend.
  - `deploy/HUONG_DAN_DEPLOY_UBUNTU.md` — tài liệu hướng dẫn bàn giao bằng tiếng Việt cho quản trị viên vận hành VPS tại Việt Nam.

- [ ] **Step 1: Tạo `deploy/setup-ubuntu-vps.sh` (Idempotent 100%)**

  Các bước kiểm tra & thiết lập an toàn khi chạy nhiều lần:
  1. Kiểm tra quyền `root` (`[ "$(id -u)" -eq 0 ]`) và kiểm tra `/etc/os-release` là Ubuntu (`22.04` hoặc `24.04`).
  2. Đặt múi giờ hệ thống: `timedatectl set-timezone Asia/Ho_Chi_Minh`.
  3. Kiểm tra tổng dung lượng Swap hiện tại (`free -m | awk '/^Swap:/ {print $2}'`): nếu `< 1024` và chưa có `/swapfile` thì tạo `/swapfile` `2G` (`fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048`), `chmod 600`, `mkswap`, `swapon`, và chỉ thêm dòng `/swapfile none swap sw 0 0` vào `/etc/fstab` khi `grep -q '/swapfile' /etc/fstab` chưa có.
  4. Cài đặt gói cơ bản (`ca-certificates`, `curl`, `git`, `ufw`, `openssl`) và cài Docker Engine + Docker Compose v2 chính thức nếu `command -v docker` chưa tồn tại; bật `systemctl enable --now docker`. Nếu biến `SUDO_USER` tồn tại và khác `root`, thêm `usermod -aG docker "$SUDO_USER"`.
  5. Cấu hình tường lửa `ufw`: mở `22/tcp` (hoặc cổng SSH đang lắng nghe thực tế đọc từ `sshd -T` để không tự khóa SSH nếu nhà cung cấp VPS đổi port SSH!), `80/tcp`, `443/tcp`, `443/udp`, đặt `ufw default deny incoming`, `ufw default allow outgoing`, `ufw --force enable`.
  6. In tóm tắt trạng thái (`docker --version`, `docker compose version`, `free -h`, `timedatectl`, `ufw status`) và các lệnh tiếp theo.

- [ ] **Step 2: Tạo `deploy/demo-mode.sh` (Bật/Tắt giao diện Demo tức thì trên VPS)**

  Hỗ trợ 3 lệnh con rõ ràng trên `${ROOT_DIR}/.env.production`:
  - `./deploy/demo-mode.sh on [--seed]`: cập nhật (hoặc thêm) `SHOW_DEMO_ACCOUNTS=true` và `OTP_DEMO_MODE=true` trong `.env.production`, chạy `docker compose -f docker-compose.prod.yml --env-file .env.production up -d api` (chỉ recreate `api` trong ~2 giây, không build lại `web`). Nếu truyền kèm `--seed`, hiển thị cảnh báo và yêu cầu xác nhận trước khi gọi `docker compose ... exec api node src/db/seed_vinhomes.js` + `docker compose ... exec api node src/db/bootstrapProd.js` (để nạp đủ 3 tòa Vinhomes Ocean Park, 240 căn hộ và đồng bộ lại mật khẩu `resihub_app`).
  - `./deploy/demo-mode.sh off`: cập nhật `SHOW_DEMO_ACCOUNTS=false` (và `OTP_DEMO_MODE=false`) trong `.env.production`, chạy `docker compose -f docker-compose.prod.yml --env-file .env.production up -d api` (~2 giây là ẩn hoàn toàn khung tài khoản Demo trên trang `/login`).
  - `./deploy/demo-mode.sh status`: in giá trị hiện tại của `SHOW_DEMO_ACCOUNTS`, `OTP_DEMO_MODE`, `SEED_DEMO_ON_FIRST_BOOT` và phản hồi thực tế từ `GET /api/v1/auth/public-config`.

- [ ] **Step 3: Tạo `deploy/HUONG_DAN_DEPLOY_UBUNTU.md`**

  Biên soạn súc tích, thực chiến bằng tiếng Việt gồm 8 mục:
  1. **Yêu cầu cấu hình VPS tại Việt Nam** (Ubuntu 22.04/24.04 LTS, tối thiểu 2 vCPU / 2GB RAM / 25GB SSD, IPv4 Public mở cổng 80/443).
  2. **Bước 1 — Chuẩn bị máy chủ:** SSH vào VPS, `git clone` mã nguồn về `/opt/resihub`, chạy `sudo bash deploy/setup-ubuntu-vps.sh`.
  3. **Bước 2 — Thiết lập `.env.production`:** copy từ `.env.production.example`, chạy lệnh 1 dòng `openssl rand -hex 32` sinh 4 khóa bảo mật (`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`), điền `INIT_ADMIN_EMAIL` / `INIT_ADMIN_PASSWORD` (hoặc bật `SEED_DEMO_ON_FIRST_BOOT=true` + `SHOW_DEMO_ACCOUNTS=true` nếu muốn dựng sẵn nguyên bản trình diễn Vinhomes ngay từ đầu).
  4. **Bước 3 — Khởi chạy giai đoạn IP trần (chưa cần tên miền):** giữ `APP_DOMAIN=:80`, chạy `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`, kiểm tra `curl http://<IP_VPS>/api/health` và đăng nhập quản trị.
  5. **Bước 4 — Gắn tên miền miễn phí DuckDNS hoặc tên miền `.vn` để bật HTTPS ổ khóa xanh tự động:** trỏ A record về `<IP_VPS>`, sửa đúng 2 dòng `APP_DOMAIN=ten-cua-ban.duckdns.org` và `CORS_ORIGIN=https://ten-cua-ban.duckdns.org` trong `.env.production`, chạy `docker compose -f docker-compose.prod.yml --env-file .env.production up -d web api` (Caddy tự cấp & gia hạn Let's Encrypt).
  6. **Bật/Tắt chế độ Giao diện Demo tức thì trên VPS (`deploy/demo-mode.sh`):** hướng dẫn chạy `./deploy/demo-mode.sh on` (kèm `--seed` nếu cần nạp dữ liệu Vinhomes) khi trình diễn cho chủ đầu tư và `./deploy/demo-mode.sh off` khi chuyển sang vận hành thật — mất đúng 2 giây, không cần build lại giao diện.
  7. **Sao lưu tự động 02:00 sáng & Diễn tập khôi phục định kỳ:** kiểm tra thư mục `./backups/`, chạy tay `./deploy/backup.sh`, diễn tập an toàn `./deploy/restore.sh --verify-only` và quy trình khôi phục khẩn cấp `--apply`.
  8. **Bảng tra cứu lệnh vận hành & xử lý sự cố thường gặp** (xem log `api`/`worker`/`web`, cập nhật phiên bản mới không mất dữ liệu `git pull && docker compose ... up -d --build`).

- [ ] **Step 4: Kiểm tra cú pháp các script hạ tầng**

  Run: `chmod +x deploy/setup-ubuntu-vps.sh deploy/demo-mode.sh && bash -n deploy/setup-ubuntu-vps.sh && bash -n deploy/demo-mode.sh`
  Expected: Exit `0`, không có lỗi cú pháp.

- [ ] **Step 5: Commit**

  ```bash
  git add deploy/setup-ubuntu-vps.sh deploy/demo-mode.sh deploy/HUONG_DAN_DEPLOY_UBUNTU.md
  git commit -m "docs(deploy): add Ubuntu VPS setup script, runtime demo-mode toggle script, and deployment guide"
  ```

---

### Task 8: Kiểm Thử Tích Hợp Cụm Production Local & Nghiệm Thu End-to-End Trên Ubuntu VPS

**Files:**
- Không tạo file mã nguồn mới — bước xác minh toàn cụm trước và sau khi đưa lên Ubuntu VPS tại Việt Nam.

**Interfaces:**
- Consumes: Toàn bộ sản phẩm từ Task 1–7 (`docker-compose.prod.yml`, scripts trong `deploy/`).

- [ ] **Step 1: Khởi chạy cụm Production thử nghiệm trên máy local với CSDL trắng**

  Tạo `.env.production` tạm trên local (dùng mật khẩu hex ngẫu nhiên, `APP_DOMAIN=:80`, `OTP_DEMO_MODE=true`, `INIT_ADMIN_EMAIL=admin@resihub.vn`, `INIT_ADMIN_PASSWORD=AdminProd@2026`), sau đó khởi chạy:
  ```bash
  docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
  docker compose -f docker-compose.prod.yml --env-file .env.production ps
  ```
  Expected: `postgres` (`healthy`), `api` (`healthy`), `worker` (`healthy` / `running`), `web` (`running`), `backup` (`running`); kiểm tra `docker compose -f docker-compose.prod.yml --env-file .env.production port postgres 5432` và `port api 5000` đều không mở ra ngoài host.

- [ ] **Step 2: Xác minh API Health, Đăng nhập `SYS_ADMIN` gốc, Giới hạn Payload 25MB và Idempotency**

  - `curl -fsS http://localhost/api/health` → HTTP `200`, `"database":"connected"`.
  - Gọi `POST http://localhost/api/v1/auth/login` với `admin@resihub.vn` / `AdminProd@2026` → HTTP `200`, nhận `accessToken` (chứng minh `002`/`010` có đủ `token_version` và `bootstrapProd.js` đã tạo admin + đồng bộ mật khẩu `resihub_app`).
  - Kiểm tra giới hạn body `25MB` qua Caddy: gửi `POST http://localhost/api/v1/auth/login` với JSON payload độn ~6MB → nhận `400 VALIDATION_ERROR` từ Express (chứng minh Caddy **không** chặn `413 Request Entity Too Large` như mặc định 1MB).
  - Truy cập `http://localhost/admin/dashboard` trực tiếp (deep-link SPA) → HTTP `200` trả về trang HTML của React SPA; kiểm tra `curl -fsS http://localhost/api/v1/auth/public-config` trả `"showDemoAccounts":false`, sau đó chạy `./deploy/demo-mode.sh on` → trả `"showDemoAccounts":true` tức thì mà không cần build lại `web`, và chạy `./deploy/demo-mode.sh off` để trả về `"showDemoAccounts":false`.

- [ ] **Step 3: Xác minh Sao lưu, Diễn tập Khôi phục (`--verify-only`) và Tính Idempotent khi Restart**

  ```bash
  ./deploy/backup.sh
  ./deploy/restore.sh --verify-only
  docker compose -f docker-compose.prod.yml --env-file .env.production restart api worker
  ```
  Expected: `backups/` sinh cặp file `db_*.dump` + `uploads_*.tar.gz` có dung lượng `> 0`; `--verify-only` in biên bản `organization = 1`, `role = 4`, `app_user = 1` và tự xóa `resihub_restore_drill`; sau khi restart `api`, số lượng `organization` và `app_user` vẫn giữ nguyên là `1`. Dọn cụm test local bằng `docker compose -f docker-compose.prod.yml --env-file .env.production down -v` sau khi pass.

- [ ] **Step 4: Triển khai & Nghiệm thu trên Ubuntu VPS thật tại Việt Nam**

  Thực hiện tuần tự theo `deploy/HUONG_DAN_DEPLOY_UBUNTU.md` trên VPS Ubuntu:
  1. SSH vào VPS → `git clone` vào `/opt/resihub` → `sudo bash deploy/setup-ubuntu-vps.sh`.
  2. Khởi tạo `.env.production` với khóa `openssl rand -hex 32` mới hoàn toàn (riêng cho VPS) → `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`.
  3. Kiểm tra từ máy tính cá nhân qua Internet: mở `http://<IP_VPS>` (hoặc `https://<TEN_MIEN>` sau khi trỏ DuckDNS / domain của chủ đầu tư), đăng nhập `SYS_ADMIN`, tạo thử 1 tòa nhà + tải lên 1 tệp đính kèm, `restart api` và xác nhận tệp đính kèm vẫn xem lại bình thường qua `/api/v1/attachments/:id/view`.
  4. Chạy `./deploy/backup.sh` và `./deploy/restore.sh --verify-only` ngay trên VPS để hoàn tất biên bản nghiệm thu NFR-006.
