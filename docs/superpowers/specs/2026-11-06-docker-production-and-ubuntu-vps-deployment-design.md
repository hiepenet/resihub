# Thiết kế: Đóng gói Docker Production & Triển khai Self-host trên Ubuntu VPS tại Việt Nam

**Ngày:** 2026-11-06  
**Trạng thái:** DRAFT – chờ duyệt  
**Tác giả:** Agent (Antigravity)  
**Tham chiếu PRD:** S6, §14.1, §14.5, §17 (NFR-004..NFR-008, NFR-011, NFR-017), §18.2, §19.3  
**Tham chiếu Lộ trình:** Giai đoạn 3 – Tuần 9–10 (Deployment với Docker trên Ubuntu)

---

## 1. Ý định & Lý do (Intent & Why)

Đưa hệ thống **ResiHub** từ môi trường phát triển cục bộ (`localhost`) sang trạng thái đóng gói Docker chuẩn Production (bao gồm **Web App + REST API + Cron Worker + PostgreSQL + Automated Backup**) và triển khai tự vận hành (Self-host) trên máy chủ ảo **Ubuntu VPS đặt tại Việt Nam** (hiện người dùng đang thuê trên `thuevpsgiare.com.vn`), đáp ứng yêu cầu lưu trữ dữ liệu trong nước của Chủ đầu tư.

Thiết kế phải giải quyết trọn vẹn thực tế chuyển tiếp của dự án:
1. **Chưa mua sẵn tên miền thương mại:** Cho phép truy cập ngay qua địa chỉ IP trần (`HTTP :80`) lúc vừa dựng VPS, đồng thời chỉ cần điền 1 biến `APP_DOMAIN` (dùng tên miền miễn phí `*.duckdns.org` khi nghiệm thu Giai đoạn 3 hoặc tên miền `.vn`/`.com` chính thức của Chủ đầu tư sau này) là hệ thống **tự động kích hoạt và gia hạn chứng chỉ SSL/TLS (HTTPS)** mà không phải sửa code hay cấu hình lại chứng chỉ thủ công.
2. **Chưa tích hợp đầu số SMS Brandname & Nhu cầu bật/tắt chế độ trình diễn Demo ngay trên VPS:** Tách các công tắc runtime (`OTP_DEMO_MODE`, `SHOW_DEMO_ACCOUNTS`, `SEED_DEMO_ON_FIRST_BOOT`) độc lập hoàn toàn với `NODE_ENV=production`, giúp trên VPS có thể bật/tắt tức thì giao diện tài khoản Demo và mã OTP kiểm thử trong ~2 giây mà **không cần build lại Frontend image** và không làm mở các lỗ hổng chỉ dành cho môi trường dev.

---

## 2. Mục tiêu, Ngoài phạm vi & Phản mục tiêu

### 2.1 Mục tiêu (Goals)

| ID | Mục tiêu |
|---|---|
| **G1** | Đóng gói hoàn chỉnh cụm Production trong `docker-compose.prod.yml` gồm 5 dịch vụ: `web` (React SPA tĩnh + Caddy Reverse Proxy), `api` (Express REST API), `worker` (tiến trình Cron hằng ngày độc lập), `postgres` (PostgreSQL 16), và `backup` (sao lưu tự động hằng đêm, lưu 30 ngày). |
| **G2** | Giữ nguyên 100% khả năng làm việc ở local dev (`docker-compose.yml`, `api/Dockerfile`, `frontend/Dockerfile` và toàn bộ test suite `npm test` không bị phá vỡ). |
| **G3** | Khóa toàn bộ 5 điểm xung đột ngầm khi bật `NODE_ENV=production`: tách `OTP_DEMO_MODE`, đồng bộ mật khẩu role RLS `resihub_app`, bật `trust proxy` cho Rate Limiter, khóa `CORS_ORIGIN`, và mở giới hạn upload `25MB` trên tầng Reverse Proxy. |
| **G4** | Tự động hóa khởi tạo cơ sở dữ liệu sạch trên Production: chạy migrations có khóa chống chạy trùng, đồng bộ mật khẩu RLS, và khởi tạo an toàn `organization` + 4 `role` chuẩn + tài khoản `SYS_ADMIN` gốc (không chèn dữ liệu giả của `seed.js`). |
| **G5** | Cung cấp bộ công cụ vận hành Ubuntu VPS thực chiến: script cài đặt hạ tầng & tạo Swap chống tràn RAM (`deploy/setup-ubuntu-vps.sh`), script sao lưu/khôi phục kèm chế độ diễn tập không chạm DB thật (`deploy/backup.sh`, `deploy/restore.sh`), và hướng dẫn triển khai chi tiết (bao gồm cách gắn DuckDNS lấy HTTPS miễn phí). |

### 2.2 Ngoài phạm vi (Non-goals)

- Tích hợp cổng thanh toán tự động hoặc đầu số SMS Brandname / Zalo ZNS trả phí của nhà mạng.
- Thiết lập cụm phân tán nhiều máy chủ (Swarm / Kubernetes / Load Balancer đa node) — vượt quá nhu cầu MVP ~50 căn hộ.
- Tối ưu hóa truy vấn SQL chuyên sâu, chia nhỏ bundle biểu đồ Frontend hoặc đối soát số liệu UAT 50 căn (thuộc phạm vi Tuần 11–12).

### 2.3 Phản mục tiêu (Anti-goals — Tuyệt đối không làm dù kỹ thuật vẫn chạy)

- **AG1:** Đặt `NODE_ENV=development` trên VPS ngoài Internet chỉ để lấy mã OTP — hành động này sẽ kích hoạt mật khẩu vạn năng `'password123'` trong `api/src/routes/auth.js` và vô hiệu hóa toàn bộ Rate Limiter trong `api/src/middleware/rateLimiter.js`.
- **AG2:** Phơi cổng PostgreSQL (`5432`/`5433`) hoặc cổng API nội bộ (`5000`) trực tiếp ra Internet (`0.0.0.0`).
- **AG3:** Lưu thư mục `uploads/` (ảnh CCCD, ảnh đồng hồ, PDF hợp đồng) bên trong lớp ghi tạm của container khiến dữ liệu đính kèm bị xóa sạch khi cập nhật hoặc khởi động lại container.
- **AG4:** Nhân bản `api` lên nhiều hơn 1 instance (`replicas > 1`) trong khi `otpStore`, `emailLoginTracker` và `resetTokenStore` vẫn đang lưu trên bộ nhớ RAM cục bộ của tiến trình.

---

## 3. Ràng buộc hệ thống (Constraints)

1. **Hạ tầng VPS mục tiêu:** Ubuntu 22.04 LTS hoặc 24.04 LTS đặt tại Việt Nam (`thuevpsgiare.com.vn`), có địa chỉ IPv4 Public tĩnh mở được cổng `80`/`443`. Dung lượng RAM có thể ở mức phổ thông (`2GB–4GB RAM`), do đó quá trình build trên VPS cần có Swap bảo vệ tối thiểu `2GB` để tránh lỗi `Out of Memory` khi Vite đóng gói Frontend.
2. **Múi giờ nghiệp vụ cố định:** Toàn bộ logic chốt kỳ `billing_day`, tính phạt quá hạn `100.000 ₫/ngày` và cron hằng ngày phụ thuộc vào múi giờ `Asia/Ho_Chi_Minh` ở cả tầng hệ điều hành, PostgreSQL và Node.js.
3. **Đường dẫn lưu trữ tệp đính kèm:** `api/src/services/imageUpload.js` và `api/src/routes/attachments.js` đọc/ghi cố định tại `path.join(process.cwd(), 'uploads')` (tức `/app/uploads` trong container) và **không phục vụ static công khai** (mọi lượt xem phải đi qua `/api/v1/attachments/:id/view` có kiểm tra RBAC/RLS và ghi `audit_log`). Container `api` khi chạy dưới user non-root (`node`) phải có quyền đọc/ghi trên volume gắn vào `/app/uploads`.
4. **Giới hạn kích thước Payload:** `api/src/server.js` cho phép JSON body tới `20mb` (phục vụ PDF scan hợp đồng tối đa 10MB mã hóa base64 hoặc cụm 3 ảnh báo hỏng 5MB). Reverse Proxy bắt buộc phải cho phép tối thiểu `25MB`.
5. **Ràng buộc Role RLS `resihub_app`:** Bản migration `010_rls_policies.sql` khởi tạo role `resihub_app` với mật khẩu cứng `'resihub_app_secret'`, và `api/src/db/client.js` bắt buộc biến `APP_DATABASE_URL` phải tồn tại khi `NODE_ENV=production`. Do đó mật khẩu thực tế của `resihub_app` trong PostgreSQL phải được đồng bộ khớp với mật khẩu cấu hình trong `.env.production` trước khi `api` và `worker` mở kết nối.

---

## 4. Các phương án đã cân nhắc & Quyết định lựa chọn

### Phương án 1 (Đã chọn): Caddy Web/Reverse Proxy + Tách riêng Container `worker`
- **Kiến trúc:**
  - `web`: Multi-stage Docker build biên dịch React bằng Node 22 sang thư mục tĩnh `/srv`, sau đó chạy trên `caddy:2-alpine` vừa phục vụ SPA tĩnh (nén Zstd/Gzip) vừa chuyển tiếp `/api/*` sang `api:5000`.
  - `api`: Chạy riêng HTTP API (`ENABLE_IN_PROCESS_CRON=false`).
  - `worker`: Dùng chung chính Docker image của `api` nhưng chạy entrypoint `node src/jobs/worker.js` chuyên trách các tác vụ định kỳ (`daily.js`).
  - `postgres`: PostgreSQL 16 lưu dữ liệu trên volume `pgdata`.
  - `backup`: Container `postgres:16-alpine` chạy `crond` thực thi sao lưu DB + nén `uploads` mỗi đêm lúc `02:00` giờ VN.
- **Ưu điểm:** Chuyển đổi từ chạy IP trần (`APP_DOMAIN=:80`) sang chạy Domain + HTTPS (`APP_DOMAIN=ten-mien.duckdns.org` hoặc `.vn`) chỉ bằng đúng 1 dòng cấu hình biến môi trường; Caddy tự động xin và gia hạn chứng chỉ Let's Encrypt không cần script phụ. Tách rời `worker` đảm bảo đúng kiến trúc PRD §14.1 và tránh nghẽn luồng API khi sinh hóa đơn hàng loạt.
- **Đánh đổi:** Tốn thêm ~50MB RAM cho tiến trình `worker` chạy tách biệt (tổng mức tiêu thụ RAM lúc rảnh của toàn cụm khoảng `300–400MB`, hoàn toàn nhẹ nhàng trên VPS 2GB+ RAM).

### Phương án 2 (Loại bỏ): Nginx + Certbot truyền thống & Gộp Cron trong `api`
- **Kiến trúc:** Dùng `nginx:alpine` đi kèm container `certbot`, và để `daily.js` chạy chung bên trong tiến trình `api`.
- **Lý do loại bỏ:** Quy trình cấp SSL lần đầu với Nginx + Certbot gặp bài toán "con gà – quả trứng" (Nginx lỗi không khởi động được nếu khai báo file chứng chỉ HTTPS chưa tồn tại), buộc người vận hành phải đổi qua lại giữa 2 file cấu hình HTTP/HTTPS khi mới trỏ tên miền. Đồng thời việc gộp chung Cron vào `api` không tách bạch dịch vụ theo yêu cầu đóng gói.

### Lựa chọn cơ chế Bật/Tắt Giao diện Demo trên VPS

- **Hướng 1 (Loại bỏ — Cứng lúc Build):** Dùng biến Vite build-time `ARG VITE_SHOW_DEMO_ACCOUNTS=false`. *Nhược điểm:* Mỗi lần muốn bật hoặc tắt khung 6 tài khoản Demo trên VPS phải chạy `docker compose build web` biên dịch lại toàn bộ React SPA (tốn 1–2 phút và ngốn RAM trên VPS nhỏ).
- **Hướng 2 (Đã chọn — Bật/Tắt Runtime tức thì qua API):** Một bản build `resihub-web:prod` duy nhất gọi `GET /api/v1/auth/public-config` (`Cache-Control: no-store`) để đọc cờ `showDemoAccounts` từ biến môi trường `SHOW_DEMO_ACCOUNTS=true|false` của `api`, đi kèm tiện ích `deploy/demo-mode.sh` (`on [--seed]` / `off` / `status`) và cờ tùy chọn `SEED_DEMO_ON_FIRST_BOOT=true|false` (chỉ nạp `seed_vinhomes.js` khi bảng `organization` đang trống 0 dòng). *Ưu điểm:* Bật/tắt giao diện Demo trên VPS mất ~2 giây mà không cần build lại bất kỳ image nào.

### Phân tách Quyết định của Người dùng & Đề xuất mặc định của Agent

- **Quyết định từ Người dùng:**
  1. Triển khai trên VPS Việt Nam (`thuevpsgiare.com.vn`) cài đặt Ubuntu.
  2. Giai đoạn đầu chưa mua sẵn tên miền thương mại (cần chạy được ngay và dễ nâng cấp lên tên miền/HTTPS sau).
  3. Giữ trải nghiệm lấy mã OTP tiện lợi như dưới local cho giai đoạn chạy thử trên VPS.
  4. Chọn **Phương án 1** (Caddy làm cổng Web/Auto-SSL + tách riêng container `worker` cho Cron jobs).
  5. Chọn **Hướng 2 cho chế độ Demo trên VPS**: cho phép bật/tắt giao diện Demo tức thì lúc chạy (runtime) thông qua cấu hình trên VPS mà không phải biên dịch lại Frontend, kèm khả năng nạp dữ liệu mẫu Vinhomes khi cần trình diễn.
- **Đề xuất mặc định từ Agent (Agent's calls — có thể điều chỉnh nếu cần):**
  1. Tách bộ file `.prod` riêng (`docker-compose.prod.yml`, `api/Dockerfile.prod`, `frontend/Dockerfile.prod`) để giữ nguyên 100% môi trường `docker-compose.yml` ở local dev.
  2. Đặt mặc định `SHOW_DEMO_ACCOUNTS=false` và `SEED_DEMO_ON_FIRST_BOOT=false` trong `.env.production.example` (an toàn mặc định), đồng thời cung cấp `deploy/demo-mode.sh` để bật/tắt nhanh bằng 1 lệnh.
  3. Đặt lịch chạy container `backup` lúc `02:00` sáng giờ Việt Nam (lệch hẳn khung `00:05` của `worker` sinh hóa đơn), giữ bản lưu `30 ngày`, và bổ sung chế độ diễn tập `--Verify-Only` trên DB nháp `resihub_restore_drill`.
  4. Tự động tạo thêm `2GB Swap` trong script cài đặt Ubuntu VPS nếu máy chủ có dưới `1GB Swap` để chống treo máy lúc build giao diện.

---

## 5. Thiết kế kỹ thuật chi tiết

### 5.1 Sơ đồ kiến trúc mạng & Volume trên Ubuntu VPS

```
Internet (HTTP :80 / HTTPS :443)
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Docker Network: resihub_internal (bridge, không lộ port) │
│                                                          │
│  ┌───────────────────────────────┐                       │
│  │ web (caddy:2-alpine)          │◄── Volume: caddy_data │
│  │ - Static React SPA (/srv)     │◄── Volume: caddy_conf │
│  │ - Reverse Proxy /api/*        │                       │
│  └──────────────┬────────────────┘                       │
│                 │ http://api:5000                        │
│                 ▼                                        │
│  ┌───────────────────────────────┐    ┌────────────────┐ │
│  │ api (node:22-alpine, non-root)│    │ worker         │ │
│  │ - Express REST API (:5000)    │    │ - daily.js     │ │
│  │ - Auto-migrate & Bootstrap    │    │   (00:05 VN)   │ │
│  └──────┬───────────────┬────────┘    └───────┬────────┘ │
│         │               │                     │          │
│         │   ┌───────────▼───────────┐         │          │
│         │   │ Volume: api_uploads   │         │          │
│         │   └───────────▲───────────┘         │          │
│         │               │ (read-only)         │          │
│         ▼               │                     ▼          │
│  ┌──────────────────────┴────────┐    ┌────────────────┐ │
│  │ postgres (postgres:16-alpine) │◄───│ backup (crond) │ │
│  │ - Volume: pgdata              │    │ - 02:00 VN     │ │
│  └───────────────────────────────┘    └───────┬────────┘ │
└───────────────────────────────────────────────┼──────────┘
                                                ▼
                                     Host: ./backups (giữ 30 ngày)
```

### 5.2 Điều chỉnh trong Mã nguồn Ứng dụng (Backward-Compatible 100%)

1. **Tách biến runtime `OTP_DEMO_MODE` và `SHOW_DEMO_ACCOUNTS` (`api/src/config/env.js`, `api/src/routes/auth.js`, `api/src/routes/public.js`):**
   - Bổ sung `isOtpDemoEnabled(envObj)` trả về `true` khi `envObj.NODE_ENV !== 'production' || envObj.OTP_DEMO_MODE === 'true'`, và `isDemoAccountsEnabled(envObj)` trả về `true` khi `envObj.NODE_ENV !== 'production' || envObj.SHOW_DEMO_ACCOUNTS === 'true'`.
   - Bổ sung endpoint công khai `GET /api/v1/auth/public-config` trong `auth.js` (trả `{ showDemoAccounts, otpDemoMode }` kèm `Cache-Control: no-store`).
   - Tại `POST /api/v1/auth/otp/request` (`auth.js`), `POST /api/v1/public/reservations/otp/request` (`public.js`) và `POST /api/v1/auth/forgot-password` (`auth.js`): chỉ đính kèm `devOtp` / `devResetCode` khi `isOtpDemoEnabled()` là `true`; khi `false`, tuyệt đối không trả mã và không in ra log (tuân thủ NFR-007).
   - **Giữ nguyên khóa bảo mật Production:** Mật khẩu fallback `'password123'` (`auth.js`), mã bypass `'123456'` (`otpService.js`), điều kiện bỏ qua `rateLimiter.js`, và quyền truyền `as_of_date` tùy ý khi kích hoạt cron (`settings.js`) **vẫn chỉ dựa trên `NODE_ENV !== 'production'`** (không bao giờ mở khi `NODE_ENV=production` kể cả khi `OTP_DEMO_MODE=true` hay `SHOW_DEMO_ACCOUNTS=true`).

2. **Cấu hình `trust proxy` và `CORS_ORIGIN` (`api/src/server.js`):**
   - Khi `process.env.NODE_ENV === 'production'` hoặc `process.env.TRUST_PROXY === 'true'`, gọi `app.set('trust proxy', 1)` trước middleware `rateLimiter` để Express giải mã đúng IP thật của người dùng từ header `X-Forwarded-For` do Caddy chuyển xuống (ngăn chặn lỗi nhận nhầm toàn bộ lưu lượng Internet thành IP Docker nội bộ `172.x.x.x` trong `isLocalOrDev`).
   - Cấu hình `cors`:
     - Ở môi trường `development` / `test` (khi `NODE_ENV !== 'production'`): giữ nguyên `origin: '*'` để không ảnh hưởng công cụ dev và test tự động.
     - Ở môi trường `production`: nếu `CORS_ORIGIN` được cấu hình (hỗ trợ nhiều origin cách nhau bởi dấu phẩy, ví dụ `https://resihub.duckdns.org`), chỉ cho phép các origin khớp danh sách; nếu để trống `CORS_ORIGIN`, đặt `origin: false` (vì Web App và API chạy chung tên miền qua Caddy nên truy cập same-origin vẫn hoạt động bình thường, đồng thời chặn cross-origin lạ).

3. **Tách tiến trình Cron Worker (`api/src/server.js`, `api/src/jobs/daily.js`, `api/src/jobs/worker.js`):**
   - Trong `api/src/server.js`: chỉ gọi `startDailyJobs()` khi `process.env.ENABLE_IN_PROCESS_CRON !== 'false'` (mặc định là chạy để tương thích ngược ở local; trên `docker-compose.prod.yml` đặt `ENABLE_IN_PROCESS_CRON=false` cho service `api`).
   - Trong `api/src/jobs/daily.js`: thêm tham số `keepAlive = false` vào `startDailyJobs(options)`. Khi `keepAlive === true`, **không** gọi `timer.unref?.()` để giữ event loop của tiến trình worker sống liên tục chờ tới `00:05` giờ Việt Nam mỗi ngày.
   - Tạo mới `api/src/jobs/worker.js`:
     - Nạp `../config/env.js`, kiểm tra kết nối `adminPool.query('SELECT 1')`.
     - Gọi `const job = startDailyJobs({ keepAlive: true, runCatchUpOnBoot: true })`.
     - Lắng nghe `SIGTERM` và `SIGINT`: gọi `job.stop()`, đóng `adminPool.end()` và `appPool.end()`, sau đó `process.exit(0)`.
   - *Lưu ý tương tác:* Chức năng bấm nút chạy đồng bộ thủ công của `SYS_ADMIN` trên giao diện (`POST /api/v1/settings/cron-runs/trigger`) gọi trực tiếp `runDailyJobs()` bên trong `api` vẫn hoạt động bình thường và an toàn nhờ cơ chế khóa `pg_try_advisory_lock(73918205)` dùng chung trên PostgreSQL.

4. **Healthcheck phản ánh thực trạng DB (`api/src/routes/health.js`):**
   - Khi `SELECT NOW()` thành công: giữ nguyên HTTP `200` với `{ status: 'ok', database: 'connected', ... }`.
   - Khi truy vấn DB thất bại: trả HTTP `503` với `{ status: 'degraded', database: 'error: ...' }` để Docker `healthcheck` nhận diện đúng trạng thái mất kết nối CSDL.

5. **Hoàn thiện nhỏ phía Frontend (`frontend/src/services/auth.service.js`, `frontend/src/pages/auth/LoginPage.jsx`, `frontend/src/services/api.js`):**
   - Trên `LoginPage.jsx`: khởi tạo trạng thái hiển thị khung *"Tài khoản Demo kiểm thử nhanh"* từ `Boolean(import.meta.env.DEV)` và gọi `authService.getPublicConfig()` (`GET /api/v1/auth/public-config`) khi mở trang để bật/tắt khung Demo động theo cấu hình runtime trên VPS mà không cần build lại giao diện.
   - Trên `frontend/src/services/api.js`: bổ sung đầy đủ các prefix route dùng `idempotencyGuard()` vào `IDEMPOTENT_FINANCIAL_ENDPOINTS` để đảm bảo không sót bất kỳ endpoint ghi dữ liệu nào yêu cầu `Idempotency-Key` khi `NODE_ENV=production`.

### 5.3 Đóng gói Docker Production & Khởi tạo Dữ liệu Gốc

Để không ảnh hưởng tới `api/Dockerfile`, `frontend/Dockerfile` và `docker-compose.yml` đang phục vụ phát triển cục bộ, toàn bộ cấu hình Production được tách riêng minh bạch:

1. **Script đồng bộ RLS & Khởi tạo Production (`api/src/db/bootstrapProd.js`):**
   - Sử dụng `pg_advisory_lock` trong lúc khởi động để đảm bảo nếu `api` và `worker` cùng bật lên thì không tranh chấp.
   - **Bước 1 (Đồng bộ mật khẩu RLS):** Nếu có biến `APP_DB_PASSWORD`, thực thi câu lệnh an toàn cập nhật mật khẩu cho role `resihub_app` trong PostgreSQL khớp với `APP_DB_PASSWORD` (dùng `format('ALTER ROLE resihub_app WITH LOGIN PASSWORD %L', $1)` qua `adminPool`).
   - **Bước 2 (Khởi tạo Tổ chức & Vai trò chuẩn):** Nếu bảng `organization` đang trống, tạo mới 1 bản ghi `organization` từ `INIT_ORG_NAME` (mặc định `'Ban Quản Lý Tòa Nhà ResiHub'`). Luôn đảm bảo đủ 4 vai trò chuẩn (`SYS_ADMIN`, `OWNER`, `MANAGER`, `RESIDENT`) trong bảng `role` cho tổ chức đó (`ON CONFLICT (org_id, code) DO NOTHING`).
   - **Bước 3 (Khởi tạo tài khoản `SYS_ADMIN` đầu tiên):** Nếu chưa tồn tại bất kỳ user nào mang quyền `SYS_ADMIN` và đã khai báo `INIT_ADMIN_EMAIL` + `INIT_ADMIN_PASSWORD`, tạo bản ghi `person`, `app_user` (mật khẩu băm bằng `bcryptjs` cost 10) và gán vai trò `SYS_ADMIN`. Nếu đã có `SYS_ADMIN` trong DB thì bỏ qua hoàn toàn (idempotent, không bao giờ ghi đè mật khẩu admin đã đổi sau này).

2. **`api/Dockerfile.prod` & `api/docker-entrypoint.sh`:**
   - Base image: `node:22-alpine`. Cài `su-exec` để xử lý quyền thư mục volume trước khi hạ quyền.
   - Chạy `npm ci --omit=dev && npm cache clean --force`.
   - `api/docker-entrypoint.sh`:
     - Đảm bảo `/app/uploads` tồn tại và `chown -R node:node /app/uploads` (khi entrypoint bắt đầu ở quyền root), sau đó chuyển sang thực thi dưới user `node` bằng `su-exec node`.
     - Nếu `RUN_MIGRATIONS_ON_BOOT=true` (bật trên `api`, tắt trên `worker`): chạy `node src/db/migrate.js`; nếu `SEED_DEMO_ON_FIRST_BOOT=true` và bảng `organization` đang trống (`0` bản ghi) thì nạp 1 lần dữ liệu mẫu Vinhomes (`node src/db/seed_vinhomes.js`); tiếp theo luôn chạy `node src/db/bootstrapProd.js` để đồng bộ mật khẩu `resihub_app` và đảm bảo đủ dữ liệu nền.
     - Cuối cùng `exec su-exec node "$@"` (`node src/server.js` cho `api`, `node src/jobs/worker.js` cho `worker`).
   - Kèm tiện ích `deploy/demo-mode.sh` (`on [--seed]` | `off` | `status`) giúp quản trị viên trên VPS bật/tắt `SHOW_DEMO_ACCOUNTS` + `OTP_DEMO_MODE` (và tùy chọn nạp dữ liệu mẫu Vinhomes) chỉ bằng 1 lệnh.

3. **`frontend/Dockerfile.prod` & `deploy/Caddyfile`:**
   - **Stage 1 (`build` trên `node:22-alpine`):** Chạy `npm ci` và `npm run build` xuất ra `/app/dist` (một bản build duy nhất dùng cho cả chế độ vận hành sạch lẫn chế độ trình diễn Demo nhờ đọc cờ runtime từ `/api/v1/auth/public-config`).
   - **Stage 2 (`caddy:2-alpine`):** Copy `/app/dist` vào `/srv` và `deploy/Caddyfile` vào `/etc/caddy/Caddyfile`.
   - **Nội dung `deploy/Caddyfile`:**
     - Sử dụng địa chỉ site `{$APP_DOMAIN::80}`:
       - Khi `APP_DOMAIN=:80` (mặc định khi chưa có tên miền): Caddy lắng nghe HTTP trên cổng `80` cho mọi địa chỉ IP của VPS, không cố xin chứng chỉ SSL.
       - Khi `APP_DOMAIN=resihub-uat.duckdns.org` (hoặc tên miền `.vn`): Caddy tự động xin chứng chỉ Let's Encrypt, lắng nghe HTTPS `443` và tự động chuyển hướng `HTTP :80 -> HTTPS :443`.
     - `request_body { max_size 25MB }`.
     - `encode zstd gzip`.
     - Header bảo mật: `X-Content-Type-Options "nosniff"`, `X-Frame-Options "SAMEORIGIN"`, `Referrer-Policy "strict-origin-when-cross-origin"`.
     - `handle /api/* { reverse_proxy api:5000 }`.
     - `handle`: phục vụ tĩnh từ `/srv`, đặt `Cache-Control "public, max-age=31536000, immutable"` cho `/assets/*` và `Cache-Control "no-cache"` cho fallback `/index.html` (`try_files {path} /index.html`).

4. **Tổ chức `docker-compose.prod.yml` & `.env.production.example`:**
   - Chỉ duy nhất service `web` mở port `"80:80"`, `"443:443"`, `"443:443/udp"` ra ngoài máy chủ.
   - `postgres`, `api`, `worker`, `backup` nằm trong mạng nội bộ `resihub_internal`, không mở `ports` ra host.
   - Thứ tự khởi động có điều kiện sức khỏe chặt chẽ:
     - `postgres` có `healthcheck` (`pg_isready`).
     - `api` chờ `postgres` (`service_healthy`), tự chạy migration + bootstrap, và có `healthcheck` gọi `http://127.0.0.1:5000/api/health`.
     - `worker` và `web` chờ `api` (`service_healthy`) — đảm bảo `worker` chỉ bắt đầu chạy sau khi `api` đã chạy xong toàn bộ migrations và đồng bộ mật khẩu `resihub_app`!
   - Cấu hình xoay vòng log Docker (`logging: driver: json-file, options: { max-size: "10m", max-file: "3" }`) cho tất cả services để chống đầy ổ cứng SSD của VPS.
   - Named volumes: `pgdata`, `api_uploads`, `caddy_data` (lưu giữ chứng chỉ SSL qua các lần khởi động lại), `caddy_config`.

### 5.4 Sao lưu Tự động & Diễn tập Khôi phục (`deploy/backup.sh`, `deploy/restore.sh`)

1. **`deploy/backup.sh` (chạy tự động lúc `02:00` sáng hằng ngày trong container `backup` và có thể gọi tay bất kỳ lúc nào):**
   - Dùng `pg_dump -Fc` xuất file `/backups/db_YYYYMMDD_HHMMSS.dump` kèm kiểm tra mã thoát và kích thước tệp `> 0`.
   - Nén toàn bộ thư mục `/uploads` thành `/backups/uploads_YYYYMMDD_HHMMSS.tar.gz`.
   - Dọn dẹp các file `.dump` và `.tar.gz` trong `/backups` có tuổi vượt quá `${BACKUP_RETENTION_DAYS:-30}` ngày.
2. **`deploy/restore.sh`:**
   - **Chế độ `--Verify-Only` (Phục vụ tiêu chí Diễn tập khôi phục Go/No-Go #4 & NFR-006):** Tự động tạo database nháp `resihub_restore_drill`, nạp bản `.dump` mới nhất vào DB nháp bằng `pg_restore`, đếm kiểm tra số bảng và số dòng dữ liệu chính (`organization`, `building`, `apartment`, `contract`, `invoice`), in biên bản kết quả thành công rồi tự xóa `resihub_restore_drill` — **không làm gián đoạn hay ghi đè dữ liệu thật đang chạy**.
   - **Chế độ `--Apply` (Khôi phục thật khi có sự cố):** Yêu cầu xác nhận rõ ràng, dừng tạm thời `api` và `worker`, nạp lại DB bằng `pg_restore --clean --if-exists` + giải nén lại `uploads`, đồng bộ lại mật khẩu `resihub_app` và bật lại dịch vụ.

### 5.5 Kịch bản Thiết lập Ubuntu VPS (`deploy/setup-ubuntu-vps.sh`) & Tài liệu Hướng dẫn

- **`deploy/setup-ubuntu-vps.sh`:** Script tự động hóa chạy 1 lệnh trên Ubuntu 22.04 / 24.04 mới cài:
  1. Cập nhật gói hệ thống và đặt múi giờ `timedatectl set-timezone Asia/Ho_Chi_Minh`.
  2. Kiểm tra bộ nhớ Swap: nếu tổng Swap `< 1GB`, tự động cấp phát và kích hoạt `/swapfile` `2GB` vĩnh viễn trong `/etc/fstab` (bảo vệ VPS giá rẻ không bị treo cứng lúc chạy `docker compose build`).
  3. Cài đặt Docker Engine & Docker Compose plugin chính thức (nếu chưa có).
  4. Cấu hình tường lửa `ufw`: mở `22/tcp` (SSH), `80/tcp` (HTTP), `443/tcp` & `443/udp` (HTTPS), đóng toàn bộ các cổng khác.
- **`deploy/HUONG_DAN_DEPLOY_UBUNTU.md`:** Tài liệu tiếng Việt từng bước ngắn gọn cho người vận hành:
  1. Cách cài lại OS sang Ubuntu 22.04/24.04 trên trang quản trị VPS và SSH vào máy chủ.
  2. Cách chạy `setup-ubuntu-vps.sh`, tạo `.env.production` (kèm lệnh sinh khóa ngẫu nhiên an toàn) và khởi chạy bằng IP trần.
  3. Cách đăng ký tên miền miễn phí `DuckDNS` trong 2 phút để lên thẳng HTTPS ổ khóa xanh.
  4. Cách nạp dữ liệu mẫu (nếu muốn demo) vs. giữ DB sạch để nhập 50 căn hộ thật, cách bật/tắt `OTP_DEMO_MODE`, và cách chạy diễn tập sao lưu/khôi phục.

---

## 6. Phần để lại cho Người thực thi (What's Left to the Builder)

- Cấu trúc chi tiết các thông báo log tiếng Việt trong `bootstrapProd.js`, `worker.js` và các script `.sh`.
- Bộ unit/integration test kiểm chứng các thay đổi nhỏ ở Backend (`isOtpDemoEnabled`, `health.js` trả `503` khi lỗi DB, `startDailyJobs({ keepAlive: true })`, tính idempotent của `bootstrapProd.js`).
- Định dạng trình bày cụ thể trong `deploy/HUONG_DAN_DEPLOY_UBUNTU.md` và các lệnh tiện ích bổ trợ (ví dụ Makefile hoặc npm scripts rút gọn cho lệnh compose prod).

