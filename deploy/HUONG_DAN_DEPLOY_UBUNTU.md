# Hướng Dẫn Triển Khai & Vận Hành ResiHub Trên Ubuntu VPS (Production)

Tài liệu thực chiến dành cho Quản trị viên triển khai hệ thống Quản lý Tòa nhà & Căn hộ cho thuê **ResiHub v2.0** lên máy chủ ảo Ubuntu VPS tại Việt Nam.

---

## 1. Yêu Cầu Cấu Hình Máy Chủ VPS

| Hạng mục | Cấu hình tối thiểu | Cấu hình khuyến nghị (1–5 tòa nhà) |
| :--- | :--- | :--- |
| **Hệ điều hành** | Ubuntu 22.04 LTS hoặc Ubuntu 24.04 LTS (64-bit) | Ubuntu 24.04 LTS |
| **CPU / RAM** | 2 vCPU / 2 GB RAM (script tự tạo thêm 2 GB Swap) | 2–4 vCPU / 4 GB RAM |
| **Ổ cứng** | 25 GB NVMe/SSD | 40+ GB NVMe SSD |
| **Mạng** | 1 địa chỉ IPv4 Public, mở cổng `22`, `80`, `443` | Hạ tầng datacenter tại Việt Nam (Viettel IDC, VNPT, Vietnix, Azdigi, GreenCloud HN/HCM...) |

> **Kiến trúc bảo mật 5 container:** Chỉ duy nhất container `web` (Caddy 2) mở cổng `80`/`443` ra Internet. Cổng PostgreSQL (`5432`), Backend API (`5000`), tiến trình `worker` (cron 00:05) và `backup` (cron 02:00) nằm hoàn toàn trong mạng nội bộ cô lập `resihub_internal`.

---

## 2. Bước 1 — Chuẩn Bị Máy Chủ Ubuntu Mới Thuê

Đăng nhập SSH vào VPS và tải mã nguồn về `/opt/resihub`, sau đó chạy script chuẩn hóa tự động:

```bash
ssh root@<IP_VPS>

apt-get update && apt-get install -y git
git clone <URL_GIT_REPO_RESIHUB> /opt/resihub
cd /opt/resihub

sudo bash deploy/setup-ubuntu-vps.sh
```

Script `setup-ubuntu-vps.sh` hoàn toàn **idempotent** (chạy lại nhiều lần không lỗi), tự động thực hiện:
1. Chuyển múi giờ máy chủ sang `Asia/Ho_Chi_Minh` (`UTC+7`).
2. Khởi tạo `/swapfile` `2GB` nếu VPS chưa có Swap (chống tràn RAM khi biên dịch giao diện Vite).
3. Cài đặt **Docker Engine** và **Docker Compose v2** chính chủ từ kho gói Docker.
4. Bật tường lửa **UFW** (tự động nhận diện cổng SSH hiện tại để không bao giờ khóa nhầm phiên SSH, đồng thời chỉ mở cổng `80/tcp`, `443/tcp`, `443/udp`).

---

## 3. Bước 2 — Thiết Lập Biến Môi Trường `.env.production`

Tạo tệp `.env.production` từ tệp mẫu và sinh tự động 4 khóa mật mã ngẫu nhiên (64 ký tự hex, không chứa ký tự đặc biệt làm hỏng chuỗi kết nối URI):

```bash
cd /opt/resihub
cp .env.production.example .env.production
chmod 600 .env.production

# Tự động điền 4 khóa ngẫu nhiên an toàn bằng openssl
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 32)|" .env.production
sed -i "s|^APP_DB_PASSWORD=.*|APP_DB_PASSWORD=$(openssl rand -hex 32)|" .env.production
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env.production
sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -hex 32)|" .env.production
```

Mở tệp `nano .env.production` để kiểm tra và chỉnh các thông tin khởi tạo:
- `INIT_ORG_NAME`: Tên đơn vị vận hành / Ban quản lý tòa nhà.
- `INIT_ADMIN_EMAIL` & `INIT_ADMIN_PASSWORD`: Email và mật khẩu quản trị viên cấp cao (`SYS_ADMIN`, tối thiểu 8 ký tự).
- **Tùy chọn nếu muốn dựng máy chủ Demo Vinhomes ngay từ đầu:** đặt `SHOW_DEMO_ACCOUNTS=true`, `OTP_DEMO_MODE=true`, và `SEED_DEMO_ON_FIRST_BOOT=true` (chỉ tự nạp 3 tòa Vinhomes Ocean Park / 240 căn hộ khi CSDL đang trống hoàn toàn).
- **Tùy chọn tích hợp ngoài:** điền `GEMINI_API_KEY` (trợ lý AI OCR CCCD/công tơ M15) và `VIETQR_CLIENT_ID` / `VIETQR_API_KEY` nếu có.

---

## 4. Bước 3 — Khởi Chạy Giai Đoạn 1 (Truy Cập Trực Tiếp Qua IP Trần HTTP)

Khi mới thuê VPS và chưa mua tên miền, giữ nguyên `APP_DOMAIN=:80` trong `.env.production` và khởi chạy toàn cụm:

```bash
cd /opt/resihub
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Kiểm tra trạng thái 5 dịch vụ (`postgres`, `api`, `worker`, `web`, `backup`):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production ps
curl -fsS http://127.0.0.1/api/health
```

Kết quả trả về `{"status":"ok","database":"connected",...}` là hệ thống đã sẵn sàng. Mở trình duyệt truy cập `http://<IP_VPS>` và đăng nhập bằng tài khoản `INIT_ADMIN_EMAIL`.

---

## 5. Bước 4 — Gắn Tên Miền & Bật HTTPS Tự Động (Let's Encrypt)

Bạn có thể dùng tên miền riêng của doanh nghiệp (ví dụ `quanly.tenmien.vn`) hoặc tạo tên miền miễn phí tại [DuckDNS.org](https://www.duckdns.org) trỏ bản ghi **A** về `<IP_VPS>`.

Sau khi `ping ten-mien-cua-ban` đã trả về đúng `<IP_VPS>`, mở `.env.production` sửa đúng 2 dòng:

```dotenv
APP_DOMAIN=quanly.tenmien.vn
CORS_ORIGIN=https://quanly.tenmien.vn
```

Áp dụng cấu hình mà không làm gián đoạn CSDL:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d web api
```

Caddy 2 sẽ tự động xin chứng chỉ SSL Let's Encrypt trong vài giây, tự động chuyển hướng `HTTP -> HTTPS` và tự động gia hạn chứng chỉ trọn đời.

---

## 6. Bật / Tắt Tức Thì Giao Diện Demo Trên VPS (`deploy/demo-mode.sh`)

ResiHub hỗ trợ công tắc bật/tắt khung **"Tài khoản Demo kiểm thử nhanh"** trên trang `/login` theo thời gian thực (**mất ~2 giây, không cần build lại Frontend**):

```bash
# 1. Xem trạng thái Demo hiện tại
./deploy/demo-mode.sh status

# 2. Bật khung chọn nhanh Tài khoản Demo & OTP Demo để trình diễn
./deploy/demo-mode.sh on

# 3. (Tùy chọn) Bật Demo KÈM nạp bộ dữ liệu mẫu Vinhomes Ocean Park (3 tòa, 240 căn)
#    Lưu ý: --seed sẽ xóa dữ liệu hiện có trong DB và yêu cầu gõ xác nhận
./deploy/demo-mode.sh on --seed

# 4. Tắt hoàn toàn khung Tài khoản Demo & OTP Demo khi vận hành chính thức
./deploy/demo-mode.sh off
```

---

## 7. Sao Lưu Tự Động 02:00 Sáng & Diễn Tập Khôi Phục (NFR-006)

Container `backup` tự động chạy lúc **02:00 sáng hàng ngày (giờ Việt Nam)**, xuất tệp nén CSDL (`backups/db_YYYYMMDD_HHMMSS.dump`) kèm toàn bộ tệp đính kèm hợp đồng/CCCD (`backups/uploads_YYYYMMDD_HHMMSS.tar.gz`) và tự động xóa bản cũ quá `BACKUP_RETENTION_DAYS` (mặc định 30 ngày).

```bash
# Tạo ngay 1 bản sao lưu thủ công bất kỳ lúc nào (nên chạy trước mỗi đợt nâng cấp)
./deploy/backup.sh

# Diễn tập khôi phục AN TOÀN trên CSDL nháp resihub_restore_drill (không đụng dữ liệu thật)
./deploy/restore.sh --verify-only

# Khôi phục khẩn cấp vào CSDL Production (yêu cầu gõ xác nhận KHOI_PHUC_PRODUCTION)
./deploy/restore.sh --apply backups/db_20261110_020000.dump backups/uploads_20261110_020000.tar.gz
```

> **Khuyến nghị an toàn 3-2-1:** Định kỳ đồng bộ thư mục `/opt/resihub/backups` ra lưu trữ đám mây bên ngoài VPS (Google Drive / S3 / Backblaze B2 bằng `rclone`) để phòng trường hợp hỏng ổ cứng vật lý.

---

## 8. Bảng Tra Cứu Lệnh Vận Hành & Xử Lý Sự Cố Thường Gặp

| Nhu cầu vận hành | Câu lệnh thực thi tại `/opt/resihub` |
| :--- | :--- |
| **Xem trạng thái toàn cụm** | `docker compose -f docker-compose.prod.yml --env-file .env.production ps` |
| **Xem log trực tiếp API & Worker** | `docker compose -f docker-compose.prod.yml --env-file .env.production logs -f api worker` |
| **Xem log chứng chỉ HTTPS (Caddy)** | `docker compose -f docker-compose.prod.yml --env-file .env.production logs -f web` |
| **Cập nhật phiên bản phần mềm mới** | `./deploy/backup.sh && git pull && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build` |
| **Khởi động lại tiến trình API** | `docker compose -f docker-compose.prod.yml --env-file .env.production restart api worker` |

### Xử lý nhanh một số tình huống:
- **Lỗi đăng nhập CSDL của `resihub_app` sau khi đổi `APP_DB_PASSWORD`:** Chỉ cần chạy `docker compose -f docker-compose.prod.yml --env-file .env.production restart api` — tiến trình `bootstrapProd.js` sẽ tự động đồng bộ lại mật khẩu role `resihub_app` khớp với `.env.production`.
- **Caddy chưa cấp được HTTPS khi mới đổi tên miền:** Kiểm tra `ufw status` đã mở cổng `80/tcp` và `443/tcp` chưa (cả trên tường lửa giao diện quản trị của nhà cung cấp VPS nếu có Cloud Firewall riêng).
- **Tải ảnh CCCD / PDF hợp đồng dung lượng lớn bị ngắt:** Cấu hình `deploy/Caddyfile` đã mở sẵn `max_size 25MB`; đảm bảo tệp tải lên tuân thủ giới hạn định dạng & kích thước của từng phân hệ.
