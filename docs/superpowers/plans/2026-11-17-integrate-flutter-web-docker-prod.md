# Tích Hợp flutter_web Vào docker-compose.prod.yml Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bổ sung service `flutter_web` (Flutter Web Client v2) vào `docker-compose.prod.yml` chạy trên cổng 3001, đồng thời cập nhật script cài đặt VPS và tài liệu triển khai.

**Architecture:** Thêm container `flutter_web` sử dụng Dockerfile multi-stage đóng gói Nginx phục vụ tĩnh và reverse proxy `/api/` vào `api:5000` qua mạng nội bộ `resihub_internal`. Mở cổng máy chủ `${FLUTTER_PORT:-3001}:80`, áp dụng healthcheck Nginx và logging json-file nhất quán. Cập nhật rule UFW trên script chuẩn hóa Ubuntu VPS và tài liệu vận hành.

**Tech Stack:** Docker Compose v2, Nginx Alpine, Flutter Web, UFW, Bash, Dotenv.

**Spec:** [docs/superpowers/specs/2026-11-17-integrate-flutter-web-docker-prod-design.md](file:///d:/resihub/docs/superpowers/specs/2026-11-17-integrate-flutter-web-docker-prod-design.md)

## Global Constraints
- `flutter_web` phải kết nối vào cả 2 mạng: `default` (cho publish port) và `resihub_internal` (để gọi `api:5000`).
- Biến môi trường cổng mặc định là `3001` thông qua cú pháp `${FLUTTER_PORT:-3001}:80`.
- Sử dụng tag image `resihub-flutter-web:prod` với `pull_policy: never` và `restart: unless-stopped`.
- Healthcheck sử dụng `wget -qO- http://127.0.0.1:80/ >/dev/null || exit 1`.
- Không làm xáo trộn các service hiện có: `postgres`, `api`, `worker`, `web`, `backup`.

## Review Focus
1. Cú pháp Compose file hợp lệ khi kiểm tra bằng `docker compose -f docker-compose.prod.yml --env-file .env.production.example config`.
2. Service `flutter_web` phụ thuộc đúng `api: condition: service_healthy`.
3. Tường lửa UFW trong `deploy/setup-ubuntu-vps.sh` được bổ sung rule mở cổng `3001/tcp`.
4. File mẫu `.env.production.example` có chú thích rõ ràng cho `FLUTTER_PORT`.
5. Tài liệu `deploy/HUONG_DAN_DEPLOY_UBUNTU.md` phản ánh kiến trúc 6 container và đường dẫn truy cập cổng 3001.

---

### Task 1: Cập nhật service `flutter_web` trong `docker-compose.prod.yml`

**Files:**
- Modify: `docker-compose.prod.yml`

**Interfaces:**
- Consumes: `api:5000` (service healthy), `./flutter_resihub/Dockerfile`
- Produces: Service `flutter_web` expose port `${FLUTTER_PORT:-3001}:80`

- [ ] **Step 1: Viết cấu hình `flutter_web` vào `docker-compose.prod.yml`**
Thêm block `flutter_web` ngay sau service `web` (trước service `backup`):
```yaml
  flutter_web:
    image: resihub-flutter-web:prod
    build:
      context: ./flutter_resihub
      dockerfile: Dockerfile
    pull_policy: never
    restart: unless-stopped
    ports:
      - "${FLUTTER_PORT:-3001}:80"
    networks:
      - default
      - resihub_internal
    depends_on:
      api:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:80/ >/dev/null || exit 1"]
      interval: 20s
      timeout: 5s
      retries: 3
      start_period: 15s
    logging: *default-logging
```

- [ ] **Step 2: Chạy kiểm tra cú pháp Compose**
Run: `docker compose -f docker-compose.prod.yml --env-file .env.production.example config`
Expected: Return code 0, hiển thị đầy đủ 6 services (`api`, `backup`, `flutter_web`, `postgres`, `web`, `worker`).

- [ ] **Step 3: Commit**
```bash
git add docker-compose.prod.yml
git commit -m "build(docker): add flutter_web service to production compose stack"
```

---

### Task 2: Cập nhật `.env.production.example` và `deploy/setup-ubuntu-vps.sh`

**Files:**
- Modify: `.env.production.example`
- Modify: `deploy/setup-ubuntu-vps.sh`

**Interfaces:**
- Consumes: Cổng `FLUTTER_PORT=3001`
- Produces: Biến môi trường mẫu và rule tường lửa UFW mở cổng `3001/tcp`

- [ ] **Step 1: Cập nhật `.env.production.example`**
Thêm phần cấu hình cổng `FLUTTER_PORT` vào mục 1 (Tên miền & Mạng):
```dotenv
# Cổng truy cập ứng dụng cư dân Flutter Web (mặc định 3001)
FLUTTER_PORT=3001
```

- [ ] **Step 2: Cập nhật `deploy/setup-ubuntu-vps.sh`**
Thêm rule UFW mở cổng `3001/tcp`:
```bash
ufw allow 3001/tcp comment 'Flutter Web HTTP'
```

- [ ] **Step 3: Kiểm tra tính hợp lệ của bash script**
Run: `bash -n deploy/setup-ubuntu-vps.sh` (kiểm tra cú pháp bash)
Expected: Return code 0 không có lỗi cú pháp.

- [ ] **Step 4: Commit**
```bash
git add .env.production.example deploy/setup-ubuntu-vps.sh
git commit -m "chore(deploy): document FLUTTER_PORT and allow ufw port 3001 in vps setup"
```

---

### Task 3: Cập nhật tài liệu hướng dẫn triển khai `deploy/HUONG_DAN_DEPLOY_UBUNTU.md`

**Files:**
- Modify: `deploy/HUONG_DAN_DEPLOY_UBUNTU.md`

**Interfaces:**
- Consumes: Kiến trúc 6 container và cổng 3001
- Produces: Hướng dẫn quản trị viên cập nhật cho phiên bản có Flutter Web

- [ ] **Step 1: Cập nhật tài liệu `deploy/HUONG_DAN_DEPLOY_UBUNTU.md`**
- Cập nhật mục 1: mở cổng `22`, `80`, `443`, và `3001`.
- Cập nhật ghi chú kiến trúc: "Kiến trúc bảo mật 6 container" (thêm `flutter_web` cổng 3001).
- Cập nhật mục 4 (Khởi chạy): kiểm tra 6 dịch vụ (`postgres`, `api`, `worker`, `web`, `flutter_web`, `backup`). Hướng dẫn truy cập React Web qua `http://<IP_VPS>` và Flutter Web qua `http://<IP_VPS>:3001`.

- [ ] **Step 2: Commit**
```bash
git add deploy/HUONG_DAN_DEPLOY_UBUNTU.md
git commit -m "docs(deploy): update deployment guide for 6-container stack with flutter web"
```

---

### Task 4: Kiểm thử và xác minh toàn diện (Verification)

**Files:**
- Read-only verification

- [ ] **Step 1: Xác minh `docker-compose.prod.yml` bằng Compose validator**
Run: `docker compose -f docker-compose.prod.yml --env-file .env.production.example config`
Kiểm tra:
- `flutter_web` xuất hiện với image `resihub-flutter-web:prod`.
- Port published: `3001`, target: `80`.
- Mạng nối: `default` và `resihub_internal`.
- Healthcheck định nghĩa chính xác.

- [ ] **Step 2: Kiểm tra diff tổng thể**
Run: `git diff --stat`
Xác nhận đúng 4 file đã được cập nhật: `docker-compose.prod.yml`, `.env.production.example`, `deploy/setup-ubuntu-vps.sh`, `deploy/HUONG_DAN_DEPLOY_UBUNTU.md`.
