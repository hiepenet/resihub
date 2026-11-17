# Design: Tích Hợp flutter_web Vào docker-compose.prod.yml

## 1. Mục Đích & Bối Cảnh (Intent & Context)
Sau khi hoàn thiện và hợp nhất module `flutter_resihub` (Flutter v2 client) vào nhánh chính (`main`), hệ thống cần đưa tiến trình `flutter_web` lên máy chủ production song song với React SPA (`web`) hiện có để phục vụ người dùng trải nghiệm cổng thông tin cư dân trên web mobile-first.

## 2. Mục Tiêu, Phi Mục Tiêu & Chống Mục Tiêu (Goals, Non-goals, Anti-goals)
- **Mục tiêu (Goals)**:
  - Bổ sung service `flutter_web` vào `docker-compose.prod.yml` chạy trên cổng cấu hình `${FLUTTER_PORT:-3001}:80`.
  - Kết nối `flutter_web` với mạng `resihub_internal` để tận dụng Nginx reverse proxy `/api/ -> http://api:5000` sẵn có trong `flutter_resihub/nginx.conf`.
  - Đảm bảo tính nhất quán với các service khác trong stack: restart policy (`unless-stopped`), logging (`*default-logging`), phụ thuộc `api: service_healthy`, `pull_policy: never`.
  - Bổ sung cấu hình mẫu vào `.env.production.example`.
  - Cập nhật script cài đặt `deploy/setup-ubuntu-vps.sh` để mở thêm cổng `3001/tcp` trên tường lửa UFW.
  - Cập nhật tài liệu `deploy/HUONG_DAN_DEPLOY_UBUNTU.md`.
- **Phi mục tiêu (Non-goals)**:
  - Thay đổi mã nguồn Dart/Flutter hoặc mã nguồn React.
  - Tích hợp SSL Caddy trực tiếp cho cổng 3001 trong giai đoạn này (vẫn giữ Caddy phục vụ cổng 80/443 cho React SPA).
- **Chống mục tiêu (Anti-goals)**:
  - Không phá vỡ cấu trúc mạng cô lập `resihub_internal` của cơ sở dữ liệu Postgres và Worker.
  - Không làm gián đoạn hoặc xung đột cổng với 5 service production hiện tại.

## 3. Ràng Buộc Kỹ Thuật (Constraints)
- Service `flutter_web` sử dụng Dockerfile multi-stage (`ghcr.io/cirruslabs/flutter:stable` build web -> `nginx:1.27-alpine` serve static).
- File `flutter_resihub/nginx.conf` đã định tuyến `/api/` về `http://api:5000`, do đó `flutter_web` bắt buộc phải nằm trong mạng `resihub_internal`.
- Cần có `healthcheck` phù hợp cho `flutter_web` (kiểm tra Nginx phản hồi mã HTTP qua `wget`).

## 4. Các Phương Án Đã Xem Xét (Approaches Considered)
- **Phương án 1 (Được chọn)**: Mở cổng độc lập `3001` (`${FLUTTER_PORT:-3001}:80`), tận dụng Nginx nội bộ của `flutter_web`.
  - *Lý do chọn*: Truy cập được ngay bằng IP máy chủ (`http://<IP>:3001`), không cần tên miền, không đụng chạm đến Caddy của React Web.
- **Phương án 2 (Loại)**: Định tuyến qua Caddy cổng 80/443 qua subdomain (ví dụ `app.domain.vn`).
  - *Lý do loại*: Cần tên miền và cấu hình DNS trước, gây bất tiện khi mới khởi tạo VPS chạy bằng IP trần.

## 5. Thiết Kế Chi Tiết (Detailed Specifications)

### 5.1. Cấu hình service `flutter_web` trong `docker-compose.prod.yml`
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

### 5.2. Biến môi trường `.env.production.example`
Bổ sung:
```dotenv
# Cổng truy cập ứng dụng cư dân Flutter Web (mặc định 3001)
FLUTTER_PORT=3001
```

### 5.3. Mở cổng tường lửa `deploy/setup-ubuntu-vps.sh`
Bổ sung:
```bash
ufw allow 3001/tcp comment 'Flutter Web HTTP'
```

### 5.4. Tài liệu `deploy/HUONG_DAN_DEPLOY_UBUNTU.md`
- Cập nhật bảng kiến trúc container: từ 5 container thành 6 container (`postgres`, `api`, `worker`, `web`, `flutter_web`, `backup`).
- Hướng dẫn truy cập React Web trên cổng `80/443` và Flutter Web trên cổng `3001`.
