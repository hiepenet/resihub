# Docker Production & Ubuntu VPS Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đóng gói toàn bộ ứng dụng ResiHub (Web SPA + REST API + Cron Worker) thành Docker images production-ready và triển khai self-host lên Ubuntu VPS tại Việt Nam với HTTPS tự động qua Caddy.

**Architecture:** Caddy reverse proxy phục vụ React SPA tĩnh đồng thời proxy `/api/*` vào container `api` nội bộ; container `worker` dùng chung image với `api` nhưng chạy riêng entrypoint cron; PostgreSQL 16 và volume `api_uploads` cô lập khỏi container layer. Mọi port nội bộ (`5000`, `5432`) không expose ra ngoài Docker network.

**Tech Stack:** Docker Compose v2, Caddy v2 Alpine, Node 22 Alpine, PostgreSQL 16 Alpine, Vite build (React SPA), Bash shell scripts.

**Spec:** `docs/superpowers/specs/2026-11-06-docker-production-and-ubuntu-vps-deployment-design.md`

## Global Constraints

- `NODE_ENV=production` trên VPS — không bao giờ đặt `NODE_ENV=development` trên server ngoài internet.
- Port `5000` (API) và `5432` (Postgres) **không** được expose ra ngoài Docker bridge network.
- `uploads/` **phải** dùng Docker Named Volume `api_uploads`, không lưu trong container layer.
- `api/Dockerfile` và `docker-compose.yml` hiện tại **không được sửa** — giữ nguyên cho dev local.
- `api/src/db/seed.js` **không chạy** trên production.
- OTP demo mode điều khiển bởi biến `OTP_DEMO_MODE=true` độc lập với `NODE_ENV`.
- Múi giờ `Asia/Ho_Chi_Minh` phải nhất quán trên Ubuntu OS, PostgreSQL (`TZ`/`PGTZ` env) và Node.js (`TZ` env).
- Container `api` và `worker` chạy dưới user non-root `node` (UID 1000).
- `worker` chỉ khởi động sau khi `api` báo healthy (migrations và bootstrap đã chạy xong).
- `bootstrapProd.js` phải idempotent — chạy nhiều lần không tạo trùng admin hoặc tổ chức.
- Mật khẩu DB role `resihub_app` lấy từ env var `APP_DB_PASSWORD` — phải khớp với `APP_DATABASE_URL`.

## Review Focus

1. **Volume chưa mount khi container `api` khởi động lần đầu** — `docker-entrypoint.sh` cần `chown node:node /app/uploads` trước khi hạ quyền, dù volume trống hay đã có dữ liệu → kiểm tra bằng step smoke test Task 5 (upload ảnh thành công sau restart).
2. **`trust proxy` không được set → rate limiter vô hiệu hoàn toàn** — `app.set('trust proxy', 1)` khi `NODE_ENV=production` → Task 1 Step 3 bao gồm assertion.
3. **Worker khởi động trước khi `api` chạy migration xong** — `depends_on: api: condition: service_healthy` trong `docker-compose.prod.yml` → Task 4 Step 5 kiểm tra healthcheck log.
4. **Caddy giới hạn body `1MB` mặc định chặn upload ảnh >1MB** — `request_body { max_size 25MB }` trong Caddyfile → Task 4 Step 3 kiểm tra bằng `curl` upload file 5MB.
5. **`bootstrapProd.js` tạo trùng org/admin khi restart** — dùng `INSERT ... ON CONFLICT DO NOTHING` → Task 2 Step 4 chạy script 2 lần và assert row count không tăng.

---

### Task 1: Điều chỉnh mã nguồn Backend (5 thay đổi backward-compatible)

**Files:**
- Modify: `api/src/config/env.js`
- Modify: `api/src/routes/auth.js`
- Modify: `api/src/routes/public.js`
- Modify: `api/src/server.js`
- Modify: `api/src/routes/health.js`
- Modify: `api/src/jobs/daily.js`

**Interfaces:**
- Produces: `isOtpDemoEnabled(): boolean` exported từ `api/src/config/env.js` — dùng bởi `auth.js`, `public.js`.
- Produces: `startDailyJobs(keepAlive?: boolean): void` — khi `keepAlive=true` không gọi `timer.unref()`.

- [ ] **Step 1: Thêm `isOtpDemoEnabled()` vào `api/src/config/env.js`**

  Thêm vào cuối file, sau các export hiện tại:
  ```js
  export const isOtpDemoEnabled = () =>
    process.env.NODE_ENV !== 'production' || process.env.OTP_DEMO_MODE === 'true';
  ```

- [ ] **Step 2: Viết test cho `isOtpDemoEnabled()`**

  Tạo file `api/tests/unit/config/env.test.js`:
  ```js
  import { isOtpDemoEnabled } from '../../../src/config/env.js';
  describe('isOtpDemoEnabled', () => {
    const orig = process.env.NODE_ENV;
    afterEach(() => { process.env.NODE_ENV = orig; delete process.env.OTP_DEMO_MODE; });
    it('returns true when NODE_ENV=development', () => {
      process.env.NODE_ENV = 'development'; expect(isOtpDemoEnabled()).toBe(true);
    });
    it('returns false when NODE_ENV=production and OTP_DEMO_MODE unset', () => {
      process.env.NODE_ENV = 'production'; expect(isOtpDemoEnabled()).toBe(false);
    });
    it('returns true when NODE_ENV=production and OTP_DEMO_MODE=true', () => {
      process.env.NODE_ENV = 'production'; process.env.OTP_DEMO_MODE = 'true';
      expect(isOtpDemoEnabled()).toBe(true);
    });
  });
  ```

- [ ] **Step 3: Chạy test để xác nhận FAIL (hàm chưa được import)**

  ```bash
  cd api && npm test -- --testPathPattern=config/env
  ```
  Expected: FAIL — `isOtpDemoEnabled is not a function` hoặc tương đương.

- [ ] **Step 4: Chạy lại test sau khi đã thêm export ở Step 1**

  ```bash
  cd api && npm test -- --testPathPattern=config/env
  ```
  Expected: PASS — 3 cases.

- [ ] **Step 5: Cập nhật `auth.js` và `public.js` — thay `NODE_ENV !== 'production'` bằng `isOtpDemoEnabled()`**

  Trong `api/src/routes/auth.js` và `api/src/routes/public.js`, tìm mọi nơi điều kiện `process.env.NODE_ENV !== 'production'` liên quan đến `devOtp` và log OTP, thay bằng `isOtpDemoEnabled()`. Import hàm ở đầu file.

- [ ] **Step 6: Cập nhật `server.js` — thêm trust proxy, CORS whitelist, và cron guard**

  Trong `api/src/server.js`:
  - Thêm `if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);` ngay trước phần setup middleware.
  - Đổi `cors({ origin: '*' })` thành:
    ```js
    cors({
      origin: process.env.NODE_ENV === 'production'
        ? (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)
        : '*',
      credentials: true,
    })
    ```
  - Bọc `startDailyJobs()` trong điều kiện: `if (process.env.ENABLE_IN_PROCESS_CRON !== 'false') startDailyJobs();`

- [ ] **Step 7: Cập nhật `health.js` — trả `HTTP 503` khi DB lỗi**

  Trong `api/src/routes/health.js`, đổi route handler để nếu query DB lỗi trả `res.status(503).json({ status: 'error', database: 'disconnected' })`.

- [ ] **Step 8: Viết test cho health endpoint**

  Trong test file hiện tại hoặc tạo mới `api/tests/unit/routes/health.test.js`:
  ```js
  it('returns 503 when db query throws', async () => {
    // mock db client để throw
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.database).toBe('disconnected');
  });
  it('returns 200 with database:connected when db ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('connected');
  });
  ```

- [ ] **Step 9: Chạy test health**

  ```bash
  cd api && npm test -- --testPathPattern=routes/health
  ```
  Expected: PASS — 2 cases.

- [ ] **Step 10: Cập nhật `daily.js` — thêm tham số `keepAlive`**

  Trong `api/src/jobs/daily.js`, đổi signature `startDailyJobs()` thành `startDailyJobs(keepAlive = false)`. Chỉ gọi `timer.unref()` khi `!keepAlive`.

- [ ] **Step 11: Chạy toàn bộ test suite để xác nhận không break**

  ```bash
  cd api && npm test
  ```
  Expected: tất cả test trước đó vẫn PASS.

- [ ] **Step 12: Commit**

  ```bash
  git add api/src/config/env.js api/src/routes/auth.js api/src/routes/public.js \
          api/src/server.js api/src/routes/health.js api/src/jobs/daily.js \
          api/tests/unit/config/env.test.js api/tests/unit/routes/health.test.js
  git commit -m "feat(api): production-safe env guards — OTP_DEMO_MODE, trust proxy, health 503, cron flag"
  ```

---

### Task 2: Worker Entrypoint & Bootstrap Production

**Files:**
- Create: `api/src/jobs/worker.js`
- Create: `api/src/db/bootstrapProd.js`
- Create: `api/docker-entrypoint.sh`

**Interfaces:**
- Consumes: `startDailyJobs(keepAlive: boolean)` từ `api/src/jobs/daily.js` (Task 1).
- Produces: `api/src/jobs/worker.js` — entrypoint node script cho container `worker`.
- Produces: `api/src/db/bootstrapProd.js` — script idempotent: đồng bộ password `resihub_app`, tạo org mặc định và SYS_ADMIN đầu tiên.
- Produces: `api/docker-entrypoint.sh` — shell script: wait-for-postgres → migrate → bootstrapProd → exec node với user `node`.

- [ ] **Step 1: Tạo `api/src/jobs/worker.js`**

  File này là entrypoint Node.js cho container `worker`. Logic:
  - Bắt `SIGTERM` và `SIGINT` → đặt flag `shuttingDown = true`, log, sau đó `process.exit(0)` sau timeout 5000ms.
  - Gọi `startDailyJobs(true)` — `keepAlive=true` giữ event loop sống.
  - Log `[worker] started` khi khởi động.

- [ ] **Step 2: Tạo `api/src/db/bootstrapProd.js`**

  Script chạy một lần (nhưng idempotent). Các bước theo thứ tự:
  1. Kết nối DB với `APP_DATABASE_URL` (superuser connection để ALTER ROLE).
  2. `ALTER ROLE resihub_app WITH PASSWORD '${process.env.APP_DB_PASSWORD}';` — đồng bộ mật khẩu.
  3. `INSERT INTO organizations (name, ...) VALUES ('Default', ...) ON CONFLICT DO NOTHING;` — tạo tổ chức mặc định.
  4. Hash `ADMIN_INITIAL_PASSWORD` bằng bcrypt, `INSERT INTO users (...) ON CONFLICT (email) DO NOTHING;` — tạo SYS_ADMIN.
  5. Assign role SYS_ADMIN cho user vừa tạo nếu chưa có.
  6. Log từng bước, kết thúc bằng `process.exit(0)`.

  Biến env bắt buộc: `DATABASE_URL` (superuser), `APP_DB_PASSWORD`, `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD`.

- [ ] **Step 3: Viết test idempotency cho `bootstrapProd.js`**

  `api/tests/integration/db/bootstrapProd.test.js`:
  ```js
  it('runs twice without duplicating org or admin user', async () => {
    await runBootstrap(); // lần 1
    await runBootstrap(); // lần 2
    const orgs = await db.query('SELECT count(*) FROM organizations WHERE name=$1', ['Default']);
    expect(Number(orgs.rows[0].count)).toBe(1);
    const users = await db.query('SELECT count(*) FROM users WHERE email=$1', [process.env.ADMIN_EMAIL]);
    expect(Number(users.rows[0].count)).toBe(1);
  });
  ```

- [ ] **Step 4: Chạy test idempotency**

  ```bash
  cd api && npm test -- --testPathPattern=bootstrapProd
  ```
  Expected: PASS.

- [ ] **Step 5: Tạo `api/docker-entrypoint.sh`**

  ```bash
  #!/bin/sh
  set -e
  # 1. Wait for postgres
  until pg_isready -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER"; do
    echo "[entrypoint] waiting for postgres..."; sleep 2
  done
  # 2. chown uploads volume (cần quyền root)
  chown -R node:node /app/uploads
  # 3. Run migrations
  node src/db/migrate.js
  # 4. Run bootstrap (chỉ khi RUN_BOOTSTRAP=true để có thể skip khi chạy worker)
  if [ "${RUN_BOOTSTRAP:-true}" = "true" ]; then
    node src/db/bootstrapProd.js
  fi
  # 5. Drop privileges → exec command
  exec su-exec node "$@"
  ```

  Đặt `chmod +x api/docker-entrypoint.sh`.

- [ ] **Step 6: Commit**

  ```bash
  git add api/src/jobs/worker.js api/src/db/bootstrapProd.js api/docker-entrypoint.sh \
          api/tests/integration/db/bootstrapProd.test.js
  git commit -m "feat(api): worker entrypoint, bootstrapProd idempotent, docker-entrypoint.sh"
  ```

---

### Task 3: Điều chỉnh Frontend

**Files:**
- Modify: `frontend/src/pages/auth/LoginPage.jsx`
- Modify: `frontend/src/services/api.js`

**Interfaces:**
- Consumes: Vite env var `VITE_SHOW_DEMO_ACCOUNTS` (string `"true"` / unset).
- Produces: Demo Accounts block trong LoginPage chỉ render khi `import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_ACCOUNTS === 'true'`.

- [ ] **Step 1: Ẩn Demo Accounts trong `LoginPage.jsx`**

  Tìm block render Demo Accounts (hiện gác sau điều kiện `devOtp`). Bọc điều kiện thành:
  ```jsx
  {(import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_ACCOUNTS === 'true') && (
    // demo accounts block
  )}
  ```

- [ ] **Step 2: Bổ sung `/api/v1/services` vào idempotency list trong `api.js`**

  Trong `frontend/src/services/api.js`, tìm mảng `IDEMPOTENT_FINANCIAL_ENDPOINTS`. Thêm `/api/v1/services` vào mảng này.

- [ ] **Step 3: Chạy build production để xác nhận không lỗi**

  ```bash
  cd frontend && npm run build
  ```
  Expected: build thành công, không có warning/error liên quan đến `import.meta.env`.

- [ ] **Step 4: Commit**

  ```bash
  git add frontend/src/pages/auth/LoginPage.jsx frontend/src/services/api.js
  git commit -m "feat(frontend): hide demo accounts in prod build, add /services to idempotency list"
  ```

---

### Task 4: Dockerfile Production

**Files:**
- Create: `api/Dockerfile.prod`
- Create: `frontend/Dockerfile.prod`

**Interfaces:**
- Produces: image `resihub-api:prod` — entrypoint là `api/docker-entrypoint.sh`, default cmd là `node src/server.js`, chạy user `node`.
- Produces: image `resihub-frontend:prod` — Caddy serving React `dist/` tĩnh tại port `80`.

- [ ] **Step 1: Tạo `api/Dockerfile.prod`**

  Multi-stage:
  ```dockerfile
  # --- Stage 1: deps ---
  FROM node:22-alpine AS deps
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci --omit=dev

  # --- Stage 2: runtime ---
  FROM node:22-alpine
  RUN apk add --no-cache su-exec postgresql-client
  WORKDIR /app
  COPY --from=deps /app/node_modules ./node_modules
  COPY . .
  RUN chmod +x docker-entrypoint.sh && \
      mkdir -p uploads && chown node:node uploads
  EXPOSE 5000
  ENTRYPOINT ["./docker-entrypoint.sh"]
  CMD ["node", "src/server.js"]
  ```

- [ ] **Step 2: Tạo `frontend/Dockerfile.prod`**

  Multi-stage:
  ```dockerfile
  # --- Stage 1: build ---
  FROM node:22-alpine AS builder
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci
  COPY . .
  RUN npm run build

  # --- Stage 2: serve ---
  FROM caddy:2-alpine
  COPY --from=builder /app/dist /srv
  COPY Caddyfile /etc/caddy/Caddyfile
  EXPOSE 80 443
  ```

  > Lưu ý: `Caddyfile` được copy từ `deploy/Caddyfile` vào context build frontend, hoặc chỉ định `COPY ../deploy/Caddyfile` trong docker-compose build context.

- [ ] **Step 3: Build cả hai image trên máy local để xác nhận không lỗi**

  ```bash
  docker build -f api/Dockerfile.prod -t resihub-api:prod ./api
  docker build -f frontend/Dockerfile.prod -t resihub-frontend:prod ./frontend
  ```
  Expected: cả hai build thành công, không có lỗi.

- [ ] **Step 4: Kiểm tra image `api` chạy được**

  ```bash
  docker run --rm -e NODE_ENV=production -e APP_DATABASE_URL=skip \
    -e JWT_SECRET=test -e JWT_REFRESH_SECRET=test \
    resihub-api:prod node -e "console.log('ok')"
  ```
  Expected: in ra `ok`, exit 0.

- [ ] **Step 5: Commit**

  ```bash
  git add api/Dockerfile.prod frontend/Dockerfile.prod
  git commit -m "feat(docker): add production Dockerfiles for api and frontend"
  ```

---

### Task 5: Caddyfile & `docker-compose.prod.yml`

**Files:**
- Create: `deploy/Caddyfile`
- Create: `docker-compose.prod.yml`
- Create: `.env.production.example`

**Interfaces:**
- Consumes: image `resihub-api:prod` và `resihub-frontend:prod` từ Task 4.
- Consumes: env var `APP_DOMAIN` — nếu là IP hoặc `localhost` thì Caddy không cố lấy HTTPS cert; nếu là domain thật Caddy tự lấy Let's Encrypt.
- Produces: stack 5 services: `web`, `api`, `worker`, `postgres`, `backup`.

- [ ] **Step 1: Tạo `deploy/Caddyfile`**

  ```caddyfile
  {$APP_DOMAIN::80} {
    request_body {
      max_size 25MB
    }

    reverse_proxy /api/* api:5000

    root * /srv
    file_server

    header {
      X-Content-Type-Options nosniff
      X-Frame-Options DENY
      Referrer-Policy strict-origin-when-cross-origin
    }

    encode gzip

    handle_errors {
      rewrite * /index.html
      file_server
    }

    @spa {
      not path /api/*
      not path /health
      file {
        try_files {path} /index.html
      }
    }
    handle @spa {
      root * /srv
      file_server
    }
  }
  ```

- [ ] **Step 2: Tạo `docker-compose.prod.yml`**

  5 services với volumes, healthchecks, logging rotation:
  ```yaml
  services:
    web:
      build:
        context: ./frontend
        dockerfile: Dockerfile.prod
        args:
          - CADDYFILE_PATH=../deploy/Caddyfile
      environment:
        - APP_DOMAIN=${APP_DOMAIN:-80}
      ports:
        - "80:80"
        - "443:443"
        - "443:443/udp"
      depends_on:
        api:
          condition: service_healthy
      restart: unless-stopped
      logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }

    api:
      build:
        context: ./api
        dockerfile: Dockerfile.prod
      environment:
        - NODE_ENV=production
        - APP_DATABASE_URL=${APP_DATABASE_URL}
        - DATABASE_URL=${DATABASE_URL}
        - JWT_SECRET=${JWT_SECRET}
        - JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
        - CORS_ORIGIN=${CORS_ORIGIN}
        - APP_DB_PASSWORD=${APP_DB_PASSWORD}
        - ADMIN_EMAIL=${ADMIN_EMAIL}
        - ADMIN_INITIAL_PASSWORD=${ADMIN_INITIAL_PASSWORD}
        - OTP_DEMO_MODE=${OTP_DEMO_MODE:-false}
        - ENABLE_IN_PROCESS_CRON=false
        - TZ=Asia/Ho_Chi_Minh
      volumes:
        - api_uploads:/app/uploads
      healthcheck:
        test: ["CMD", "wget", "-qO-", "http://localhost:5000/api/health"]
        interval: 15s
        timeout: 5s
        retries: 5
        start_period: 30s
      depends_on:
        postgres:
          condition: service_healthy
      restart: unless-stopped
      logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }

    worker:
      build:
        context: ./api
        dockerfile: Dockerfile.prod
      command: node src/jobs/worker.js
      environment:
        - NODE_ENV=production
        - APP_DATABASE_URL=${APP_DATABASE_URL}
        - OTP_DEMO_MODE=${OTP_DEMO_MODE:-false}
        - RUN_BOOTSTRAP=false
        - TZ=Asia/Ho_Chi_Minh
      volumes:
        - api_uploads:/app/uploads
      depends_on:
        api:
          condition: service_healthy
      restart: unless-stopped
      logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }

    postgres:
      image: postgres:16-alpine
      environment:
        - POSTGRES_DB=${POSTGRES_DB:-resihub}
        - POSTGRES_USER=${POSTGRES_USER:-postgres}
        - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
        - TZ=Asia/Ho_Chi_Minh
        - PGTZ=Asia/Ho_Chi_Minh
      volumes:
        - pg_data:/var/lib/postgresql/data
      healthcheck:
        test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-postgres}"]
        interval: 10s
        timeout: 5s
        retries: 5
      restart: unless-stopped
      logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }

    backup:
      image: postgres:16-alpine
      environment:
        - PGHOST=postgres
        - PGUSER=${POSTGRES_USER:-postgres}
        - PGPASSWORD=${POSTGRES_PASSWORD}
        - PGDATABASE=${POSTGRES_DB:-resihub}
        - TZ=Asia/Ho_Chi_Minh
      volumes:
        - api_uploads:/uploads:ro
        - ./backups:/backups
      entrypoint: /bin/sh -c "while true; do sleep 86400; done"
      depends_on:
        - postgres
      restart: unless-stopped

  volumes:
    pg_data:
    api_uploads:
  ```

- [ ] **Step 3: Tạo `.env.production.example`**

  ```env
  # === Database ===
  POSTGRES_DB=resihub
  POSTGRES_USER=postgres
  POSTGRES_PASSWORD=CHANGE_ME_strong_password_here

  # Superuser connection (để ALTER ROLE trong bootstrapProd)
  DATABASE_URL=postgresql://postgres:CHANGE_ME_strong_password_here@postgres:5432/resihub

  # App role connection
  APP_DB_PASSWORD=CHANGE_ME_app_role_password
  APP_DATABASE_URL=postgresql://resihub_app:CHANGE_ME_app_role_password@postgres:5432/resihub

  # === Auth ===
  # Sinh bằng: openssl rand -base64 64
  JWT_SECRET=CHANGE_ME
  JWT_REFRESH_SECRET=CHANGE_ME

  # === App ===
  APP_DOMAIN=your-vps-ip  # hoặc domain.duckdns.org
  CORS_ORIGIN=http://your-vps-ip  # hoặc https://domain.duckdns.org

  # === Admin ===
  ADMIN_EMAIL=admin@resihub.vn
  ADMIN_INITIAL_PASSWORD=CHANGE_ME

  # === OTP ===
  # true = hiện OTP trên UI/log dù NODE_ENV=production (chỉ dùng khi demo)
  OTP_DEMO_MODE=false
  ```

- [ ] **Step 4: Validate cấu hình docker compose**

  ```bash
  docker compose -f docker-compose.prod.yml config
  ```
  Expected: in ra YAML hợp lệ, không có error.

- [ ] **Step 5: Smoke test local — khởi động stack và kiểm tra healthcheck**

  ```bash
  cp .env.production.example .env.production
  # Điền các CHANGE_ME thực tế (dùng password local test)
  docker compose -f docker-compose.prod.yml --env-file .env.production up -d
  docker compose -f docker-compose.prod.yml ps
  # Chờ api healthy rồi kiểm tra:
  curl http://localhost/api/health
  ```
  Expected: `{"status":"ok","database":"connected"}` với HTTP 200.

- [ ] **Step 6: Kiểm tra Caddy body limit — upload file ~5MB**

  ```bash
  # Tạo file test 5MB
  dd if=/dev/urandom bs=1M count=5 | base64 > /tmp/test5mb.txt
  curl -X POST http://localhost/api/v1/attachments \
    -H "Authorization: Bearer <token>" \
    -F "file=@/tmp/test5mb.txt"
  ```
  Expected: upload thành công (không bị `413 Request Entity Too Large`).

- [ ] **Step 7: Commit**

  ```bash
  git add deploy/Caddyfile docker-compose.prod.yml .env.production.example
  git commit -m "feat(deploy): Caddyfile, docker-compose.prod.yml, env.production.example"
  ```

---

### Task 6: Scripts Sao Lưu & Khôi Phục

**Files:**
- Create: `deploy/backup.sh`
- Create: `deploy/restore.sh`

**Interfaces:**
- Consumes: container `backup` đang chạy trong stack (`docker-compose.prod.yml`).
- Consumes: thư mục `./backups/` trên host (tạo tự động nếu chưa có).
- Produces: `deploy/backup.sh` — pg_dump + tar `api_uploads`, giữ 30 ngày, đặt tên `resihub_YYYYMMDD_HHMMSS.dump` và `resihub_uploads_YYYYMMDD_HHMMSS.tar.gz`.
- Produces: `deploy/restore.sh` — flag `--verify-only` (restore vào DB nháp `resihub_verify`, không ảnh hưởng production) và `--apply` (restore thật với xác nhận tương tác).

- [ ] **Step 1: Tạo `deploy/backup.sh`**

  ```bash
  #!/bin/bash
  set -euo pipefail
  BACKUP_DIR="$(cd "$(dirname "$0")/../backups" && pwd)"
  mkdir -p "$BACKUP_DIR"
  TS=$(date +%Y%m%d_%H%M%S)

  # DB dump
  docker compose -f docker-compose.prod.yml exec -T backup \
    pg_dump -Fc "$PGDATABASE" > "$BACKUP_DIR/resihub_${TS}.dump"

  # Uploads tar
  docker compose -f docker-compose.prod.yml exec -T backup \
    tar czf - /uploads > "$BACKUP_DIR/resihub_uploads_${TS}.tar.gz"

  # Giữ 30 ngày
  find "$BACKUP_DIR" -name "resihub_*.dump" -mtime +30 -delete
  find "$BACKUP_DIR" -name "resihub_uploads_*.tar.gz" -mtime +30 -delete

  echo "[backup] done: $BACKUP_DIR/resihub_${TS}.dump"
  ```

- [ ] **Step 2: Tạo `deploy/restore.sh`**

  Nhận tham số `--verify-only <dump_file>` hoặc `--apply <dump_file>`:
  - `--verify-only`: tạo DB `resihub_verify`, restore vào đó, chạy `SELECT count(*) FROM organizations`, sau đó drop DB nháp. In kết quả.
  - `--apply`: yêu cầu người dùng gõ `yes` để xác nhận, sau đó restore vào DB production thật (`DROP DATABASE resihub; CREATE DATABASE resihub; pg_restore`).

- [ ] **Step 3: Set executable và chạy `backup.sh` với stack đang chạy**

  ```bash
  chmod +x deploy/backup.sh deploy/restore.sh
  ./deploy/backup.sh
  ls -lh backups/
  ```
  Expected: 2 file `.dump` và `.tar.gz` có kích thước > 0.

- [ ] **Step 4: Chạy `restore.sh --verify-only` với file vừa backup**

  ```bash
  ./deploy/restore.sh --verify-only backups/resihub_<TS>.dump
  ```
  Expected: in ra kết quả count từ DB nháp, sau đó log `[restore] verify OK, dropped resihub_verify`.

- [ ] **Step 5: Commit**

  ```bash
  git add deploy/backup.sh deploy/restore.sh
  git commit -m "feat(deploy): backup and restore scripts with 30-day retention and verify-only mode"
  ```

---

### Task 7: Script Cài Đặt Ubuntu VPS & Tài Liệu Hướng Dẫn

**Files:**
- Create: `deploy/setup-ubuntu-vps.sh`
- Create: `deploy/HUONG_DAN_DEPLOY_UBUNTU.md`

**Interfaces:**
- Produces: `setup-ubuntu-vps.sh` — cài Docker CE, ufw rules (port 22, 80, 443), tạo Swap 2GB, set timezone `Asia/Ho_Chi_Minh`, tạo user deploy `resihub` (không sudo không password).
- Produces: `HUONG_DAN_DEPLOY_UBUNTU.md` — hướng dẫn tiếng Việt đầy đủ từ SSH vào VPS đến `docker compose up -d`.

- [ ] **Step 1: Tạo `deploy/setup-ubuntu-vps.sh`**

  Yêu cầu chạy với `sudo`. Script kiểm tra:
  - Ubuntu 22.04 hoặc 24.04, nếu không thì cảnh báo và dừng.
  - Cài Docker CE theo official script (`curl -fsSL https://get.docker.com | sh`).
  - Thêm user hiện tại vào group `docker`.
  - `timedatectl set-timezone Asia/Ho_Chi_Minh`.
  - Tạo swap: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile` và ghi vào `/etc/fstab`.
  - `ufw default deny incoming && ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable`.
  - In hướng dẫn tiếp theo sau khi chạy xong.

- [ ] **Step 2: Tạo `deploy/HUONG_DAN_DEPLOY_UBUNTU.md`**

  Nội dung tiếng Việt, bao gồm các phần:
  1. **Yêu cầu**: VPS Ubuntu 22.04+, RAM ≥1GB, disk ≥20GB, cổng 80/443 mở.
  2. **Bước 1 — Cài đặt server**: `git clone`, `sudo bash deploy/setup-ubuntu-vps.sh`.
  3. **Bước 2 — Tạo file `.env.production`**: copy `.env.production.example`, điền mật khẩu (hướng dẫn `openssl rand -base64 64` cho JWT secrets).
  4. **Bước 3 — Khởi động lần đầu**: `docker compose -f docker-compose.prod.yml --env-file .env.production up -d`.
  5. **Bước 4 — Kiểm tra**: `curl http://<IP>/api/health`, đăng nhập trang web.
  6. **Bước 5 — Dùng domain miễn phí (DuckDNS)**: đăng ký tại duckdns.org, trỏ subdomain về IP VPS, đổi `APP_DOMAIN=yourname.duckdns.org` trong `.env.production`, restart `web` container.
  7. **Sao lưu định kỳ**: thêm cron trên host `0 2 * * * cd /home/resihub/resihub && ./deploy/backup.sh >> /var/log/resihub-backup.log 2>&1`.
  8. **Khởi động lại sau reboot**: `docker compose ... --env-file ... up -d` hoặc dùng `--restart unless-stopped` (đã cấu hình sẵn).
  9. **Xử lý sự cố thường gặp**: logs xem bằng `docker compose logs -f api`, kiểm tra DB với `docker compose exec postgres psql`.

- [ ] **Step 3: Set executable và chạy shellcheck (nếu có)**

  ```bash
  chmod +x deploy/setup-ubuntu-vps.sh
  # Nếu shellcheck available:
  shellcheck deploy/setup-ubuntu-vps.sh deploy/backup.sh deploy/restore.sh
  ```
  Expected: không có lỗi shellcheck mức `error`.

- [ ] **Step 4: Commit**

  ```bash
  git add deploy/setup-ubuntu-vps.sh deploy/HUONG_DAN_DEPLOY_UBUNTU.md
  git commit -m "feat(deploy): Ubuntu VPS setup script and Vietnamese deployment guide"
  ```

---

### Task 8: Smoke Test End-to-End Trên VPS Thật

**Files:**
- Không tạo file mới — đây là task verification trên VPS thật.

**Interfaces:**
- Consumes: tất cả file từ Task 1–7.
- Requires: access SSH vào VPS (IP/hostname từ `thuevpsgiare.com.vn`), `.env.production` đã được điền đầy đủ.

- [ ] **Step 1: SSH vào VPS, clone repo**

  ```bash
  ssh root@<VPS_IP>
  git clone <repo_url> /home/resihub/resihub
  cd /home/resihub/resihub
  ```

- [ ] **Step 2: Chạy setup script**

  ```bash
  sudo bash deploy/setup-ubuntu-vps.sh
  # Logout và login lại để group docker có hiệu lực
  ```

- [ ] **Step 3: Tạo `.env.production` từ example**

  ```bash
  cp .env.production.example .env.production
  # Chỉnh sửa: điền POSTGRES_PASSWORD, APP_DB_PASSWORD, JWT_SECRET, JWT_REFRESH_SECRET
  # Sinh JWT: openssl rand -base64 64
  nano .env.production
  ```

- [ ] **Step 4: Khởi động stack lần đầu**

  ```bash
  docker compose -f docker-compose.prod.yml --env-file .env.production up -d
  docker compose -f docker-compose.prod.yml ps
  docker compose -f docker-compose.prod.yml logs -f api
  ```
  Expected: `api` chuyển sang `healthy`, `worker` trạng thái `running`, `web` trạng thái `running`.

- [ ] **Step 5: Kiểm tra health endpoint qua IP công khai**

  ```bash
  curl http://<VPS_IP>/api/health
  ```
  Expected: `{"status":"ok","database":"connected"}` HTTP 200.

- [ ] **Step 6: Đăng nhập và kiểm tra chức năng cơ bản**

  - Truy cập `http://<VPS_IP>` trong browser → trang login hiển thị.
  - Đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` → vào được dashboard.
  - Upload 1 ảnh đính kèm → upload thành công.

- [ ] **Step 7: Kiểm tra dữ liệu bền vững sau restart**

  ```bash
  docker compose -f docker-compose.prod.yml restart api
  # Chờ healthy rồi kiểm tra lại upload vừa tạo
  curl http://<VPS_IP>/api/health
  ```
  Expected: upload cũ vẫn còn trong volume, health OK.

- [ ] **Step 8: Chạy backup và verify**

  ```bash
  ./deploy/backup.sh
  ls -lh backups/
  ./deploy/restore.sh --verify-only backups/resihub_<TS>.dump
  ```
  Expected: backup tạo thành công, verify log in ra count ≥ 1 org.

- [ ] **Step 9: Commit tổng kết (nếu có thay đổi nhỏ phát sinh khi deploy thật)**

  ```bash
  git add -A
  git commit -m "chore(deploy): post-VPS smoke test fixes and notes"
  ```

---

## Tổng Quan File Structure

```
resihub/
├── api/
│   ├── Dockerfile.prod              [NEW] Multi-stage production image
│   ├── docker-entrypoint.sh         [NEW] Wait-postgres → migrate → bootstrap → exec
│   └── src/
│       ├── config/env.js            [MOD] + isOtpDemoEnabled()
│       ├── jobs/
│       │   ├── daily.js             [MOD] + keepAlive param
│       │   └── worker.js            [NEW] Cron worker entrypoint
│       ├── routes/
│       │   ├── auth.js              [MOD] dùng isOtpDemoEnabled()
│       │   ├── health.js            [MOD] 503 khi DB lỗi
│       │   └── public.js            [MOD] dùng isOtpDemoEnabled()
│       ├── server.js                [MOD] trust proxy, CORS whitelist, cron flag
│       └── db/
│           └── bootstrapProd.js     [NEW] Idempotent init org/admin
├── frontend/
│   ├── Dockerfile.prod              [NEW] Vite build → Caddy serve
│   └── src/
│       ├── pages/auth/LoginPage.jsx [MOD] ẩn Demo Accounts prod
│       └── services/api.js          [MOD] /services vào idempotency
├── deploy/
│   ├── Caddyfile                    [NEW] Reverse proxy + SPA + HTTPS
│   ├── backup.sh                    [NEW] pg_dump + uploads tar, 30-day retention
│   ├── restore.sh                   [NEW] --verify-only và --apply
│   ├── setup-ubuntu-vps.sh          [NEW] Docker, ufw, swap, timezone
│   └── HUONG_DAN_DEPLOY_UBUNTU.md   [NEW] Tiếng Việt step-by-step
├── docker-compose.prod.yml          [NEW] 5 services production stack
└── .env.production.example          [NEW] Template biến môi trường
```

