# 🏢 ResiHub — Hệ thống Quản lý Căn hộ & Cho thuê Bất động sản (v2.0)

[![Node.js](https://img.shields.io/badge/Node.js-v20%2B%20%7C%20v22_LTS-339933.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-v19.2-61DAFB.svg)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-v8.3-646CFF.svg)](https://vite.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v16_(Native_RLS)-336791.svg)](https://www.postgresql.org/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-v3.4-38B2AC.svg)](https://tailwindcss.com/)
[![Gemini AI](https://img.shields.io/badge/AI_Gateway-Google_Gemini-4285F4.svg)](https://ai.google.dev/)

**ResiHub** là nền tảng Full-Stack quản lý tập trung vận hành chuỗi căn hộ dịch vụ, chung cư mini và nhà cho thuê đa tòa nhà / đa chủ sở hữu. Hệ thống số hóa khép kín toàn bộ vòng đời khai thác bất động sản: **Khám phá phòng trống & Đặt giữ chỗ online → Hồ sơ cư dân → Hợp đồng thuê → Sổ cọc độc lập → Dịch vụ & Đồng hồ điện/nước → Động cơ tính tiền & Hóa đơn kỳ → Thanh toán & Tuổi nợ → Báo hỏng SLA → Thông báo Zalo Rich Text → Dashboard phân tích & AI Gateway hỗ trợ tác nghiệp**.

---

## 📑 Mục lục

1. [Giới thiệu dự án](#1-giới-thiệu-dự-án)
2. [Công nghệ sử dụng (Tech Stack)](#2-công-nghệ-sử-dụng-tech-stack)
3. [Cấu trúc thư mục](#3-cấu-trúc-thư-mục)
4. [Yêu cầu môi trường](#4-yêu-cầu-môi-trường)
5. [Hướng dẫn cài đặt và khởi chạy](#5-hướng-dẫn-cài-đặt-và-khởi-chạy)
6. [Cấu hình hệ thống (`.env`)](#6-cấu-hình-hệ-thống-env)
7. [Kiến trúc bảo mật, Tài khoản Demo & Danh mục API](#7-kiến-trúc-bảo-mật-tài-khoản-demo--danh-mục-api)
8. [Kiểm thử & Xử lý sự cố (Testing & Troubleshooting)](#8-kiểm-thử--xử-lý-sự-cố-testing--troubleshooting)
9. [Tài liệu kỹ thuật & Quy chuẩn đóng góp](#9-tài-liệu-kỹ-thuật--quy-chuẩn-đóng-góp)

---

## 1. Giới thiệu dự án

### 1.1. Mục tiêu cốt lõi
Thay thế triệt để phương thức quản lý rời rạc bằng sổ tay, file Excel và tin nhắn Zalo thủ công; thiết lập một hệ thống chuẩn xác về tài chính, minh bạch về pháp lý/sổ cọc, bảo vệ dữ liệu cá nhân (PII) và sẵn sàng mở rộng quy mô nhiều tòa nhà thuộc nhiều chủ đầu tư khác nhau.

### 1.2. Các nguyên tắc nghiệp vụ trọng tâm
- **Chống chồng lấn hợp đồng 2 lớp (`contract_no_overlap`):** Kiểm tra xung đột ở tầng API và khóa cứng tại PostgreSQL bằng ràng buộc `EXCLUDE USING gist` trên nửa khoảng thời gian `[start_date, end_date)`, cho phép ký hợp đồng nối tiếp ngày mượt mà nhưng chặn tuyệt đối trùng kỳ hạn dù thao tác đồng thời.
- **Sổ cọc độc lập & Quy tắc 4 mắt (`Four-Eyes Approval`):** Tách bạch hoàn toàn tiền cọc bảo đảm với doanh thu tiền thuê; **cấm tuyệt đối cấn trừ tiền cọc vào nợ tiền thuê (`RENT_DEDUCTION_FORBIDDEN`)**, theo dõi cam kết hoàn cọc trong **3–5 ngày** sau khi chấm dứt hợp đồng và bắt buộc người phê duyệt độc lập với người lập phiếu.
- **Động cơ tính tiền chính xác & Hóa đơn bất biến:** Tự động tính tiền thuê và dịch vụ *pro-rata* theo số ngày thực tế (làm tròn hàng nghìn VND), áp dụng thứ tự ưu tiên đơn giá 3 tầng (*Ghi đè theo Hợp đồng → Khóa giá Đăng ký / Danh mục Tòa nhà → Danh mục Tổ chức*). Hóa đơn đã phát hành được bảo vệ bất biến; phí phạt chậm thanh toán (`100.000 ₫/ngày` sau `5 ngày` ân hạn) được tích lũy riêng trong `late_fee_accrual_tracker` để kết chuyển sang kỳ sau hoặc lập hóa đơn tất toán phí phạt.
- **Cô lập dữ liệu đa tầng bằng Native PostgreSQL RLS:** Kết hợp RBAC Middleware tại Express và `FORCE ROW LEVEL SECURITY` dưới PostgreSQL thông qua role chuyên biệt `resihub_app` gắn ngữ cảnh người dùng trên từng HTTP request.
- **AI đề xuất – Người quyết định (`Human-in-the-Loop`):** Google Gemini AI chỉ sinh bản ghi gợi ý (`PENDING`) cho trích xuất CCCD/Hợp đồng, đọc ảnh công tơ điện/nước hàng loạt và phân loại báo hỏng kèm lưới an toàn sinh mạng; mọi thay đổi dữ liệu chính thức đều phải qua con người rà soát xác nhận.

### 1.3. Mô hình Vai trò & Đối tượng sử dụng
Hệ thống chuẩn hóa **4 vai trò định danh** kết hợp **luồng khách vãng lai công khai**:

| Vai trò | Mã (`role.code`) | Phạm vi & Quyền hạn chính |
| :--- | :--- | :--- |
| **Quản trị hệ thống** | `SYS_ADMIN` | Quản trị người dùng & phân quyền toàn tổ chức, cấu hình tham số hệ thống & ngân sách AI, giám sát Cron jobs, xem Audit Log và thực hiện **Xóa có điều kiện (`Guarded Hard Delete`)** đối với danh mục rỗng chưa phát sinh lịch sử tài chính. |
| **Chủ đầu tư / Chủ nhà** | `OWNER` | Xem Dashboard, báo cáo doanh thu, tỷ lệ lấp đầy, tuổi nợ trên các tòa nhà thuộc sở hữu (chế độ `Read-only`, tự động ẩn PII nhạy cảm) và thực hiện quyền **Phê duyệt 4 mắt (`Approve`)** cho hợp đồng giảm giá, quyết toán hoàn cọc, điều chỉnh hóa đơn, hoàn tiền thừa. |
| **Quản lý tòa nhà** | `MANAGER` | Toàn quyền tác nghiệp **Tạo – Đọc – Sửa (`CRU`)** trong phạm vi tòa nhà được gán: quản lý khu/tầng/phòng, giữ chỗ, cư dân, hợp đồng, thu/quyết toán cọc, chốt điện/nước, phát hành hóa đơn, thu tiền, điều phối bảo trì SLA và gửi thông báo Zalo. |
| **Cư dân** | `RESIDENT` | Sử dụng **Cổng Cư Dân Mobile-First (`/resident`)** với 2 trạng thái:<br>• *Khách mới đặt giữ chỗ:* Theo dõi phiếu giữ chỗ, tải CCCD 2 mặt, gửi hồ sơ đăng ký thuê.<br>• *Cư dân đang thuê (hỗ trợ đa căn hộ):* Xem hợp đồng & sổ cọc, tra cứu hóa đơn & báo đã chuyển khoản VietQR, đăng ký/hủy dịch vụ, gửi báo hỏng & đánh giá sao. |
| **Khách tiềm năng** | *(Public `/explore`)* | Không cần tài khoản trước: tìm kiếm căn hộ trống theo tòa/số phòng ngủ/khoảng giá, xác thực SĐT qua OTP và gửi yêu cầu đặt cọc giữ chỗ trực tuyến. |

### 1.4. Các phân hệ chức năng (Modules M01 – M15)
- **M01 & M02 — Xác thực, Người dùng, RBAC & RLS:** Đăng nhập SĐT + OTP 6 số (chống dò quét danh tính), Email + Mật khẩu, Quên mật khẩu, JWT Access/Refresh Token (`token_version`), Idempotency-Key chống gửi trùng giao dịch tài chính và Nhật ký kiểm toán bất biến (`audit_log`).
- **M03 — Quản lý Bất động sản & Sơ đồ tầng:** Quản lý Tòa nhà (cấu hình VietQR nhận tiền), Khu (`zone`), Tầng (tạo lẻ & dải tầng hàng loạt `floors/bulk`), Căn hộ (tạo lẻ & theo mẫu tầng `apartments/bulk`), máy trạng thái tự động 5 trạng thái (`AVAILABLE`, `RESERVED`, `OCCUPIED`, `MAINTENANCE`, `INACTIVE`), nghiệm thu bàn giao phòng và Sơ đồ mặt bằng trực quan (`FloorPlanPage`).
- **M04 — Hồ sơ Cư dân & Đặt cọc Giữ chỗ:** Mô hình định danh 2 tầng (`person` + `tenant`), kiểm tra trùng SĐT/CCCD, tra cứu liên kết khách thuê liên tòa bảo vệ PII (`SHARED_PROFILE_LOCKED`), gộp hồ sơ trùng (`merge`) và quản lý phiếu giữ chỗ nội bộ / trực tuyến (`reservation`).
- **M05 — Quản lý Hợp đồng thuê:** Lập hợp đồng nháp, xuất bản in mẫu HTML/PDF, đính kèm bản scan đã ký, phê duyệt hợp đồng ưu đãi giá (>10%), quản lý thành viên ở cùng, phụ lục phiên bản hóa (`contract_version`), gia hạn nối tiếp và chuyển phòng kết chuyển cọc (`transfer-room`).
- **M06 — Quản lý Sổ cọc độc lập:** Mở sổ cọc tự động khi kích hoạt hợp đồng, kết chuyển tiền giữ chỗ, thu bổ sung cọc, khấu trừ hư hại có ảnh bằng chứng, luồng quyết toán hoàn cọc 4 mắt, xử lý tranh chấp (`DISPUTED`) và lệnh chi hoàn trả (`RETURNED`).
- **M07 — Danh mục & Đăng ký Dịch vụ:** Quản lý biểu phí dịch vụ (`METERED`, `FIXED`, `QUANTITY`, `ONE_TIME`), đăng ký dịch vụ gắn biển số xe gửi hầm, khóa giá hoặc ghi đè đơn giá riêng theo từng hợp đồng, xử lý đăng ký/hủy dịch vụ giữa tháng tính pro-rata tự động.
- **M08 — Đồng hồ Điện / Nước:** Tự động khởi tạo công tơ Điện/Nước cho hợp đồng hiệu lực, ghi chỉ số lẻ/hàng loạt, hỗ trợ tách chỉ số khi đổi khách thuê giữa tháng trên cùng công tơ, cảnh báo tiêu thụ tăng đột biến (>30%) và nhập ảnh công tơ hàng loạt qua AI OCR.
- **M09 — Động cơ Tính tiền & Hóa đơn kỳ:** Sinh hóa đơn tự động theo `billing_day` riêng của từng hợp đồng hoặc sinh hàng loạt theo tòa, quản lý dòng chi tiết hóa đơn nháp, phát hành bất biến, quy trình điều chỉnh hóa đơn 4 mắt và theo dõi phí phạt quá hạn.
- **M10 — Thanh toán, Công nợ & Số dư Tín dụng:** Ghi nhận & xác nhận thanh toán chuyển khoản/VietQR/tiền mặt, phân tích công nợ theo **5 nhóm tuổi nợ**, tự động bù trừ tiền thừa theo cơ chế FIFO (`credit_balance`) và hoàn tiền thừa có phê duyệt.
- **M11 — Yêu cầu Bảo trì / Báo hỏng & SLA:** Cấp mã phiếu `SR-YYYYMMDD-XXXX`, cảnh báo trùng trong 24h, theo dõi cam kết SLA phản hồi (2h) & xử lý (4h khẩn cấp / 24h thường), tự động leo thang cảnh báo khi quá hạn SLA, cư dân nghiệm thu đóng phiếu hoặc mở lại trong 3 ngày.
- **M12 — Cổng Cư Dân Đa thiết bị:** Giao diện tự phục vụ 8 phân mục (`P1..P8`) tối ưu chuyên sâu cho Mobile (Bottom Navigation 5 ô + Bottom-Sheet), Tablet (Sticky Sub-Header) và Desktop (Sidebar).
- **M13 — Thông báo & Tích hợp Nhóm Zalo:** Phát hành thông báo theo phạm vi Tòa/Tầng/Phòng, quản lý danh bạ nhóm Zalo tòa nhà & từng căn hộ (`zalo_group`), 5 mẫu thông báo vận hành dựng sẵn và sao chép **Zalo Rich Text** giữ nguyên định dạng in đậm khi dán sang Zalo PC/Web.
- **M14 — Dashboard Chart.js & Báo cáo:** Trực quan hóa Xu hướng Phát hành vs Thực thu, Cơ cấu Doanh thu theo nguồn, Tuổi nợ 5 nhóm (hỗ trợ click *drill-down*) và Biểu đồ Tỷ lệ lấp đầy 6/12/24 tháng; xuất dữ liệu báo cáo CSV.
- **M15 — AI Gateway (Google Gemini):** Cổng AI phía server với Kill Switch, kiểm soát trần ngân sách VND & Token hàng tháng, kiểm tra magic bytes tệp tải lên và che giấu PII cho 3 nghiệp vụ: `CCCD_EXTRACT` / `CONTRACT_EXTRACT`, `METER_OCR` và `TICKET_TRIAGE`.
- **Hệ thống Cron Jobs Hằng ngày (`daily.js`):** Tự động kích hoạt lúc `00:05` giờ Việt Nam với khóa phân tán `pg_try_advisory_lock`, tự động đồng bộ hết hạn hợp đồng/giữ chỗ, chuyển trạng thái phòng, đánh dấu hóa đơn `OVERDUE`, tích lũy phí phạt chậm, sinh hóa đơn nháp định kỳ, leo thang SLA và dọn gợi ý AI hết hạn.

---

## 2. Công nghệ sử dụng (Tech Stack)

| Tầng hệ thống | Công nghệ / Thư viện | Phiên bản | Vai trò trong kiến trúc |
| :--- | :--- | :--- | :--- |
| **Frontend** | **React** | `^19.2.8` | Xây dựng giao diện người dùng (Admin Portal, Resident Portal, Public Explore) |
| | **Vite** | `^8.3.0` | Bundler tốc độ cao, HMR và tách gói vendor (`react`, `chart`, `icons`) |
| | **React Router DOM** | `^7.18.4` | Điều hướng SPA, Lazy-loading Preloader & Route Guards theo vai trò |
| | **Zustand** | `^5.0.15` | Quản lý trạng thái toàn cục (`authStore`, `notificationStore`, `toastStore`) |
| | **TailwindCSS** | `^3.4.19` | Thiết kế UI responsive, hệ màu chuẩn và hỗ trợ vùng an toàn di động (`pb-safe`) |
| | **Chart.js & react-chartjs-2** | `^4.5.1` / `^5.3.1` | Hệ thống biểu đồ phân tích doanh thu, tuổi nợ và tỷ lệ lấp đầy |
| | **Lucide React** | `^1.57.0` | Bộ biểu tượng vector đồng bộ |
| | **Axios** | `^1.20.0` | HTTP client tích hợp tự động làm mới JWT, Cache truy vấn & `Idempotency-Key` |
| | **Oxlint** | `^1.81.0` | Công cụ kiểm tra tĩnh mã nguồn JavaScript/JSX siêu tốc |
| **Backend** | **Node.js (ES Modules)** | `v20+` / `v22 LTS` | Môi trường thực thi bất đồng bộ phía máy chủ |
| | **Express.js** | `^4.21.2` | RESTful API framework kèm middleware nén Gzip tự động cho JSON payload |
| | **pg (`node-postgres`)** | `^8.13.1` | Quản lý Dual Connection Pool (`adminPool` & `appPool`) + `AsyncLocalStorage` |
| | **jsonwebtoken & bcryptjs** | `^9.0.2` / `^2.4.3` | Ký xác thực Access/Refresh Token và băm mật khẩu người dùng |
| | **express-rate-limit** | `^7.5.0` | Bảo vệ chống brute-force OTP, đăng nhập và giới hạn tần suất gọi API |
| | **Google Gemini REST Client** | `v1beta` | Trích xuất dữ liệu có cấu trúc (Structured Outputs JSON Schema) phía server |
| **Database** | **PostgreSQL** | `v16` | CSDL quan hệ ACID với `uuid-ossp`, `pgcrypto`, `btree_gist` |
| | **PostgreSQL Native RLS** | `v16` | `ENABLE` & `FORCE ROW LEVEL SECURITY` trên toàn bộ bảng nghiệp vụ |
| **DevOps & Test** | **Docker & Docker Compose** | Compose v2 | Đóng gói đồng nhất PostgreSQL 16, Backend API và Frontend |
| | **Node.js Test Runner** | Built-in (`node:test`) | Chạy 16 bộ kiểm thử Unit, Integration và UAT Performance |

---

## 3. Cấu trúc thư mục

```text
resihub/
├── .env.example                          # Mẫu biến môi trường chuẩn tại thư mục gốc
├── docker-compose.yml                    # Khởi chạy trọn gói PostgreSQL 16, Backend API & Frontend
├── docker-compose.dev.yml                # Ghi đè lệnh hot-reload cho môi trường phát triển Docker
├── PRD - Quan ly Can ho va Nha cho thue v2.0.md  # Tài liệu đặc tả yêu cầu sản phẩm (PRD v2.0)
├── FRONTEND DEVELOPER Roadmap (Hiep).md  # Lộ trình triển khai dự án theo 3 giai đoạn (12 tuần)
│
├── docs/                                 # Tài liệu kỹ thuật, báo cáo nghiệm thu & thiết kế chi tiết
│   ├── BAO_CAO_GIAI_DOAN_1_TUAN_1_4.md   # Báo cáo kỹ thuật & Schema Giai đoạn 1 (M01–M06)
│   ├── BAO_CAO_GIAI_DOAN_2_TUAN_5_8.md   # Báo cáo kỹ thuật & Schema Giai đoạn 2 (M07–M15)
│   ├── BAO_CAO_RA_SOAT_THU_HOAN_COC_M06.md
│   ├── BAO_CAO_TUAN_THU_PRD_M03_M06.md
│   ├── superpowers/                      # Hồ sơ thiết kế (specs/) & kế hoạch triển khai (plans/)
│   └── test-samples/cccd/                # Bộ ảnh mẫu CCCD phục vụ kiểm thử AI OCR
│
├── api/                                  # MÃ NGUỒN BACKEND (Node.js + Express + PostgreSQL)
│   ├── Dockerfile                        # Cấu hình đóng gói container API (node:22-alpine)
│   ├── .env.example                      # Mẫu cấu hình biến môi trường chi tiết cho Backend
│   ├── package.json                      # Scripts (dev, start, migrate, seed, test, test:ui)
│   ├── scripts/
│   │   └── devtools-ui-suite.mjs         # Kịch bản kiểm thử giao diện tự động qua Chrome DevTools
│   ├── src/
│   │   ├── server.js                     # Khởi tạo Express, Gzip, CORS, Rate Limit, Routes & Cron
│   │   ├── config/
│   │   │   └── env.js                    # Kiểm tra biến môi trường bắt buộc (JWT, Gemini)
│   │   ├── db/
│   │   │   ├── client.js                 # Quản lý adminPool, appPool (RLS) & AsyncLocalStorage
│   │   │   ├── migrate.js                # Bộ thực thi migration tự động có bảng theo dõi _migrations
│   │   │   ├── seed_vinhomes.js          # Seed mặc định: 3 tòa Vinhomes Ocean Park (240 căn, 2025–2027)
│   │   │   ├── seed_demo.js              # Seed tùy chọn: 3 Chủ đầu tư, 9 tòa nhà (450 căn)
│   │   │   ├── seed.js                   # Seed tối giản khởi tạo nhanh tổ chức & vai trò
│   │   │   └── migrations/               # 9 bản migration SQL hợp nhất toàn bộ 29 bảng & RLS
│   │   │       ├── 001_extensions_and_roles.sql
│   │   │       ├── 002_core_tables.sql
│   │   │       ├── 003_constraints_and_indexes.sql
│   │   │       ├── 004_helper_functions.sql
│   │   │       ├── 005_rls_enable_and_policies.sql
│   │   │       ├── 006_triggers.sql
│   │   │       ├── 007_grants.sql
│   │   │       ├── 008_seeds.sql
│   │   │       └── 009_cron_jobs.sql
│   │   ├── jobs/
│   │   │   └── daily.js                  # Tiến trình nền hằng ngày (HĐ, giữ chỗ, hóa đơn, phạt, SLA)
│   │   ├── middleware/                   # auth.js, rbac.js, idempotency.js, rateLimiter.js
│   │   ├── routes/                       # 22 module định tuyến RESTful API (/api/health & /api/v1/*)
│   │   ├── services/                     # 26 module xử lý nghiệp vụ cốt lõi (Billing, AI, Deposit, v.v.)
│   │   └── utils/                        # Tiện ích xuất CSV (csv.js) & che giấu dữ liệu cá nhân (piiMask.js)
│   └── test/                             # 16 bộ kiểm thử tự động (504 test assertions)
│
└── frontend/                             # MÃ NGUỒN FRONTEND (React 19 + Vite 8 + TailwindCSS)
    ├── Dockerfile                        # Cấu hình đóng gói container Frontend (node:22-alpine)
    ├── package.json                      # Scripts (dev, build, lint, preview)
    ├── vite.config.js                    # Cấu hình proxy /api -> :5000 & tách gói manualChunks
    ├── tailwind.config.js                # Cấu hình bảng màu thương hiệu, font chữ & giao diện
    └── src/
        ├── main.jsx & App.jsx            # Điểm khởi chạy ứng dụng React
        ├── constants/                    # Cấu hình vai trò (roles.js), menu (navigation.js), trạng thái
        ├── hooks/                        # usePermission, useNotificationAction, useVietQrBanks, useToast
        ├── router/                       # Định tuyến SPA, RoleGuard & cơ chế nạp trước routePreloaders
        ├── services/                     # 17 module gọi API & bộ nhớ đệm truy vấn (queryCache.js)
        ├── stores/                       # Zustand stores: authStore, notificationStore, toastStore
        ├── utils/                        # Định dạng tiền tệ, biểu đồ, VietQR, Zalo Rich Text, AI helpers
        ├── components/
        │   ├── ui/                       # 14 UI Primitives (Modal, MoneyInput, FileUpload, Select, v.v.)
        │   ├── common/                   # DataTable, NotificationBell, BankSelect, ConfirmDialog, v.v.
        │   ├── layout/                   # AdminLayout, ResidentLayout, Sidebar, TopBar
        │   ├── meters/                   # MeterBatchPhotoImportModal (Nhập ảnh đồng hồ OCR hàng loạt)
        │   └── settings/                 # AiGatewayConfigCard (Quản trị cấu hình & ngân sách AI)
        └── pages/
            ├── public/                   # PublicExplorePage (/explore — Khám phá phòng & giữ chỗ online)
            ├── auth/                     # LoginPage, ForgotPasswordPage
            ├── admin/                    # 14 phân khu quản trị (dashboard, buildings, apartments, tenants,
            │                             #   contracts, deposits, meters, services, invoices, payments,
            │                             #   maintenance, notifications, reports, audit, users, settings)
            └── resident/                 # ResidentPortalPage & 8 tab nghiệp vụ cư dân (tabs/*)
```

---

## 4. Yêu cầu môi trường

| Công cụ | Phiên bản yêu cầu | Ghi chú |
| :--- | :--- | :--- |
| **Node.js** | `>= 20.x` (Khuyến nghị **v22.x LTS**) | Bắt buộc hỗ trợ sẵn `fetch` và `node --test` |
| **npm** | `>= 10.x` | Đi kèm khi cài đặt Node.js |
| **PostgreSQL** | `>= 15.x` (Khuyến nghị **PostgreSQL 16**) | Chạy trực tiếp trên máy hoặc thông qua Docker |
| **Docker & Compose** | Docker Desktop `4.x+` | *(Tùy chọn)* Khuyến nghị để dựng nhanh PostgreSQL đúng cổng `5433` |
| **Google Gemini API Key** | Gemini API (`v1beta`) | *(Tùy chọn)* Cần thiết nếu muốn trải nghiệm thực tế tính năng AI (M15) |

---

## 5. Hướng dẫn cài đặt và khởi chạy

### Cách 1: Chạy trực tiếp trên máy cục bộ (Khuyến nghị khi phát triển)

#### Bước 1: Chuẩn bị Cơ sở dữ liệu PostgreSQL
Bạn có thể bật nhanh riêng container PostgreSQL 16 trên cổng `5433` bằng Docker:
```bash
docker compose up -d postgres
```
*(Nếu dùng PostgreSQL cài sẵn trên máy ở cổng `5432`, hãy tạo database `CREATE DATABASE resihub;` và chỉnh `DB_PORT=5432` cùng chuỗi kết nối trong file `.env` ở Bước 2).*

#### Bước 2: Cài đặt, Migrate & Seed dữ liệu cho Backend (`api/`)
```bash
# 1. Di chuyển vào thư mục backend
cd api

# 2. Cài đặt dependencies
npm install

# 3. Khởi tạo file cấu hình môi trường
cp .env.example .env
# (Cập nhật thông tin kết nối DB hoặc GEMINI_API_KEY trong api/.env nếu cần)

# 4. Chạy 9 bản migration khởi tạo 29 bảng, role resihub_app và chính sách RLS
npm run migrate

# 5. Nạp bộ dữ liệu thực tế Vinhomes Ocean Park 1, 2, 3 (240 căn hộ, ~245 hợp đồng)
npm run seed

# 6. Khởi chạy server Backend ở chế độ phát triển (http://localhost:5000)
npm run dev
```

> [!TIP]
> **Các chế độ nạp dữ liệu mẫu (`seed`):**
> - `npm run seed` *(mặc định — chạy `src/db/seed_vinhomes.js`)*: Tạo dữ liệu thực tế cho 3 tòa **Vinhomes Ocean Park 1, 2, 3** (240 căn hộ, 276 cư dân, lịch sử hợp đồng & hóa đơn từ `01/2025` đến `10/2026`, đầy đủ chỉ số điện/nước tháng `11/2026` đã chốt để bạn trải nghiệm ngay nút **Sinh hóa đơn hàng loạt kỳ 2026-11** trên giao diện).
> - `node src/db/seed_demo.js`: Tạo mô hình đa chủ sở hữu gồm 3 Chủ đầu tư × 3 tòa = 9 tòa nhà (450 căn hộ).
> - `node src/db/seed.js`: Chỉ khởi tạo Tổ chức, 4 Vai trò chuẩn và tài khoản mẫu tối giản.

#### Bước 3: Cài đặt và Khởi chạy Frontend (`frontend/`)
Mở một cửa sổ Terminal mới tại thư mục gốc dự án:
```bash
# 1. Di chuyển vào thư mục frontend
cd frontend

# 2. Cài đặt dependencies
npm install

# 3. Khởi động Vite dev server (http://localhost:3000)
npm run dev
```

#### Bước 4: Truy cập hệ thống
- **Cổng Khám phá công khai (Khách tìm phòng):** http://localhost:3000/explore
- **Trang Đăng nhập (Quản trị & Cư dân):** http://localhost:3000/login
- **Kiểm tra trạng thái Backend Health-check:** http://localhost:5000/api/health

---

### Cách 2: Khởi chạy toàn bộ bằng Docker Compose

```bash
# 1. Tạo file .env tại thư mục gốc từ file mẫu
cp .env.example .env

# 2. Dựng đồng bộ 3 container: postgres (5433), api (5000), frontend (3000)
docker compose up --build -d

# 3. Chạy migration và nạp dữ liệu mẫu vào container api (lần đầu tiên)
docker exec -it resihub-api npm run migrate
docker exec -it resihub-api npm run seed
```

---

## 6. Cấu hình hệ thống (`.env`)

Hệ thống đọc biến môi trường từ `api/.env` (hoặc `.env` tại thư mục gốc). Tham khảo đầy đủ từ [`api/.env.example`](api/.env.example):

```env
# ==============================================================================
# 1. CẤU HÌNH POSTGRESQL & ROW-LEVEL SECURITY POOL
# ==============================================================================
POSTGRES_DB=resihub
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
DB_HOST=localhost
DB_PORT=5433

# Kết nối Superuser/Owner (chỉ dùng cho migration, seed & tra cứu xác thực ban đầu)
DATABASE_URL=postgres://postgres:postgres@localhost:5433/resihub

# Kết nối ứng dụng chịu sự kiểm soát của FORCE ROW LEVEL SECURITY (role resihub_app)
# BẮT BUỘC phải khai báo khi NODE_ENV=production
APP_DATABASE_URL=postgres://resihub_app:resihub_app_secret@localhost:5433/resihub

# ==============================================================================
# 2. CẤU HÌNH SERVER & BẢO MẬT JWT
# ==============================================================================
PORT=5000
NODE_ENV=development

# Bắt buộc khai báo (server sẽ dừng ngay lúc khởi động nếu để trống)
JWT_SECRET=replace_with_your_strong_jwt_secret
JWT_REFRESH_SECRET=replace_with_your_strong_refresh_secret
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_IN=7d

# Bắt buộc header Idempotency-Key cho API ghi dữ liệu (mặc định tự bật khi NODE_ENV=production)
# REQUIRE_IDEMPOTENCY_KEY=true

# ==============================================================================
# 3. TÍCH HỢP VIETQR & GOOGLE GEMINI AI GATEWAY (TÙY CHỌN)
# ==============================================================================
VIETQR_CLIENT_ID=
VIETQR_API_KEY=

# Khóa Gemini chỉ gọi từ Backend (NFR-007), tuyệt đối không đặt biến VITE_* cho khóa này
GEMINI_API_KEY=
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_TIMEOUT_MS=20000

# ==============================================================================
# 4. CẤU HÌNH FRONTEND (VITE)
# ==============================================================================
VITE_API_URL=http://localhost:5000
```

> [!WARNING]
> **An toàn bảo mật:** Không bao giờ commit file `.env` chứa khóa thật lên kho mã nguồn, và tuyệt đối không đưa `GEMINI_API_KEY` hay `JWT_SECRET` vào các biến có tiền tố `VITE_` của Frontend.

---

## 7. Kiến trúc bảo mật, Tài khoản Demo & Danh mục API

### 7.1. Điểm nhấn kiến trúc Backend & Database
1. **Dual Connection Pool & RLS Context (`api/src/db/client.js` & `middleware/auth.js`):**
   - `adminPool`: Dành riêng cho chạy migration, tiến trình nền hệ thống và bước kiểm tra định danh lúc đăng nhập.
   - `appPool`: Kết nối qua role `resihub_app` (không có quyền bypass RLS). Mỗi request hợp lệ được cấp kết nối riêng trong `AsyncLocalStorage`, gắn `SELECT set_config('app.current_user_id', userId, false)` và tự động `ROLLBACK` + `RESET` ngay khi kết thúc response.
2. **Bảo vệ chống gửi trùng (`middleware/idempotency.js`):** Các thao tác nhạy cảm (lập/kích hoạt/chấm dứt hợp đồng, thu/hoàn cọc, phát hành hóa đơn, ghi nhận thanh toán, gửi thông báo) kiểm tra băm SHA-256 của payload theo `Idempotency-Key` và phát lại kết quả an toàn (`Idempotent-Replayed: true`) nếu mạng chập chờn.
3. **Truy cập tệp đính kèm bảo mật (`routes/attachments.js`):** Ảnh CCCD, bản scan hợp đồng, biên lai chuyển khoản và ảnh nghiệm thu không phơi trực tiếp qua static URL công khai mà phải đi qua `/api/v1/attachments/:id/view` có kiểm tra quyền sở hữu/tòa nhà và ghi nhận nhật ký truy cập.

### 7.2. Danh sách tài khoản Demo (Sau khi chạy `npm run seed`)

Màn hình đăng nhập (`/login`) đã tích hợp sẵn hộp chọn nhanh các tài khoản dưới đây:

| Vai trò | Email đăng nhập | Mật khẩu | SĐT nhận OTP | Phạm vi dữ liệu & Quyền hạn |
| :--- | :--- | :--- | :--- | :--- |
| **SYS_ADMIN** | `admin@resihub.vn` | `Admin@123456` | `0900000001` | Quản trị toàn tổ chức, cấu hình hệ thống/AI, quản lý người dùng, xóa danh mục rỗng. |
| **OWNER** | `owner.vop@resihub.vn` | `Demo@123456` | `0905000001` | Chủ đầu tư sở hữu cả 3 tòa Vinhomes Ocean Park 1, 2, 3; xem báo cáo tổng hợp & duyệt 4 mắt. |
| **MANAGER (Tòa 1)** | `manager.vop1@resihub.vn` | `Demo@123456` | `0905000011` | Quản lý vận hành riêng tòa **Vinhomes Ocean Park 1 (`VOP-1`)** — 80 căn hộ. |
| **MANAGER (Tòa 2)** | `manager.vop2@resihub.vn` | `Demo@123456` | `0905000012` | Quản lý vận hành riêng tòa **Vinhomes Ocean Park 2 (`VOP-2`)** — 80 căn hộ. |
| **MANAGER (Tòa 3)** | `manager.vop3@resihub.vn` | `Demo@123456` | `0905000013` | Quản lý vận hành riêng tòa **Vinhomes Ocean Park 3 (`VOP-3`)** — 80 căn hộ. |
| **RESIDENT** | `tenant1@resihub.vn` *(..`tenant276`)* | `Demo@123456` | `0907000001` *(..`0907000276`)* | Cư dân truy cập Cổng Cư Dân (`/resident`): xem hợp đồng, hóa đơn, báo hỏng, đăng ký dịch vụ. |

> [!NOTE]
> **Lưu ý khi đăng nhập bằng Số điện thoại (OTP) ở môi trường Dev:**
> Để chống dò quét danh tính (*Anti-Enumeration*), hệ thống chỉ sinh mã OTP cho số điện thoại đã tồn tại trong hồ sơ `person` (ví dụ `0907000001` hoặc SĐT vừa đặt giữ chỗ tại `/explore`). Khi `NODE_ENV !== 'production'`, mã OTP sẽ hiển thị ngay trên hộp gợi ý giao diện đăng nhập, in ra terminal Backend, đồng thời chấp nhận mã kiểm thử nhanh `123456`.

### 7.3. Tổng quan các nhóm API Endpoints (`/api/v1/*`)

| Phân hệ | Tiền tố Endpoint | Chức năng tiêu biểu |
| :--- | :--- | :--- |
| **Health & Public** | `/api/health`<br>`/api/v1/public` | Kiểm tra trạng thái hệ thống; tra cứu căn hộ trống công khai (`GET /apartments`), gửi OTP & tạo phiếu giữ chỗ trực tuyến (`POST /reservations`). |
| **Xác thực & Hồ sơ** | `/api/v1/auth` | Yêu cầu & xác thực OTP (`/otp/request`, `/otp/verify`), đăng nhập Email (`/login`), làm mới phiên (`/refresh`), quên/đổi mật khẩu, cập nhật hồ sơ cá nhân (`/profile`). |
| **Bất động sản (M03)** | `/api/v1/buildings`<br>`/api/v1/apartments` | CRUD tòa nhà, khu (`/zones`), tầng & tạo tầng hàng loạt (`/floors/bulk`), sơ đồ tầng (`/floor-map`), danh mục ngân hàng VietQR (`/banks`); tạo căn hộ lẻ/hàng loạt theo mẫu tầng (`/apartments/bulk`), nghiệm thu bàn giao (`/handover`). |
| **Cư dân & Giữ chỗ (M04)** | `/api/v1/tenants`<br>`/api/v1/reservations` | Hồ sơ cư dân, kiểm tra trùng (`/check-dup`), tra cứu liên tòa (`/lookup`), gộp hồ sơ (`/merge`), ảnh CCCD (`/id-images`); quản lý giữ chỗ, xác nhận sao kê, hủy/quyết toán hoàn tiền giữ chỗ 4 mắt, chuyển thành hợp đồng (`/convert`). |
| **Hợp đồng thuê (M05)** | `/api/v1/contracts` | Lập hợp đồng, xuất bản in mẫu (`/template`), tải bản scan (`/scan`), kích hoạt (`/activate`), duyệt giảm giá (`/approve`), thành viên ở cùng (`/occupants`), đơn giá riêng (`/service-prices`), phụ lục (`/amendments`), gia hạn (`/renew`), chuyển phòng (`/transfer-room`), chấm dứt (`/terminate`). |
| **Sổ cọc độc lập (M06)** | `/api/v1/deposits` | Truy vấn sổ cọc, ghi nhận thu/khấu trừ (`/:id/transactions`), lập & xuất PDF quyết toán (`/:id/settlement`, `/:id/settlement/pdf`), phê duyệt 4 mắt, chi hoàn (`/:id/payout`), xử lý khiếu nại (`/:id/dispute`) & hoàn trả ngân hàng (`/:id/payout-returned`). |
| **Dịch vụ & Điện nước (M07, M08)** | `/api/v1/service-catalog`<br>`/api/v1/service-subscriptions`<br>`/api/v1/meters` | Quản lý danh mục dịch vụ & gói đăng ký theo hợp đồng; quản lý công tơ, chốt chỉ số lẻ/hàng loạt (`/readings/batch`), xác nhận chỉ số (`/readings/confirm-batch`). |
| **Hóa đơn & Công nợ (M09, M10)** | `/api/v1/invoices`<br>`/api/v1/payments`<br>`/api/v1/receivables` | Sinh hóa đơn kỳ hàng loạt (`/generate-batch`), quản lý dòng thu nháp, phát hành (`/:id/issue`), điều chỉnh 4 mắt (`/:id/adjust`); ghi nhận & duyệt thanh toán, theo dõi 5 nhóm tuổi nợ (`/receivables`), quản lý & hoàn số dư tín dụng (`/payments/credits`). |
| **Bảo trì & Thông báo (M11, M13)** | `/api/v1/service-requests`<br>`/api/v1/announcements`<br>`/api/v1/zalo-groups`<br>`/api/v1/notifications` | Tiếp nhận, điều phối trạng thái SLA, áp dụng phân loại AI (`/:id/apply-triage`) & đánh giá sao báo hỏng; soạn gửi thông báo đa phạm vi, đánh dấu đã gửi Zalo (`/:id/mark-zalo-sent`), quản lý nhóm Zalo & hộp thư thông báo in-app. |
| **Cổng Cư Dân (M12)** | `/api/v1/resident` | Tổng quan cá nhân hóa (`/overview`), nộp hồ sơ thuê (`/rental-application`), tra cứu hóa đơn & báo đã thanh toán (`/payments/report`), đăng ký/hủy dịch vụ, gửi/hủy/mở lại/đánh giá báo hỏng, gửi yêu cầu gia hạn/trả phòng (`/contract-requests`). |
| **AI Gateway (M15)** | `/api/v1/ai` | Trích xuất CCCD & Hợp đồng (`POST /extract`), đọc chỉ số đồng hồ từ ảnh (`POST /meter-ocr`), phân loại báo hỏng (`POST /classify`), duyệt gợi ý AI (`POST /suggestions/:id/review`) và thống kê chi phí/KPI G6 (`GET /usage`). |
| **Báo cáo & Quản trị** | `/api/v1/reports`<br>`/api/v1/admin/users`<br>`/api/v1/audit-logs`<br>`/api/v1/settings`<br>`/api/v1/attachments` | Dữ liệu Dashboard & xuất CSV (`/dashboard`, `/summary`, `/deposit-ledger`); quản lý tài khoản & vai trò; tra cứu nhật ký kiểm toán; cấu hình tham số hệ thống, xem lịch sử & kích hoạt thủ công Cron job (`/cron-runs`, `/cron-runs/trigger`); xem tệp bảo mật (`/:id/view`). |

---

## 8. Kiểm thử & Xử lý sự cố (Testing & Troubleshooting)

### 8.1. Kiểm thử tự động Backend (`api/test/`)
Dự án có **16 bộ kiểm thử tự động (504 test assertions)** sử dụng `node:test`:

```bash
cd api

# Chạy toàn bộ 16 bộ kiểm thử (Unit + Integration/UAT) — Yêu cầu PostgreSQL đang chạy và đã migrate/seed
npm test

# Chỉ chạy riêng 11 bộ Unit Test thuần logic (477 test cases — KHÔNG cần kết nối PostgreSQL)
node --test test/bugs_*.test.js test/floorBulk.test.js
```

- **11 bộ Unit Test thuần logic (`477 assertions`):** Kiểm thử toàn diện biên tính tiền pro-rata, năm nhuận, sai số dấu phẩy động, ưu tiên giá 3 tầng, đổi khách giữa tháng trên cùng đồng hồ, quy tắc AI Gateway & ngân sách, lưới an toàn báo hỏng, phân quyền 4 mắt, che giấu PII và định dạng Zalo.
- **5 bộ Integration & Performance Test (`27 assertions`):** Kiểm thử trực tiếp với PostgreSQL RLS cho tạo tầng hàng loạt nguyên tử, xóa có điều kiện của `SYS_ADMIN`, hiệu năng phản hồi `< 500ms` và đối soát chu kỳ thu phí UAT quy mô lớn.

### 8.2. Kiểm thử Lint, Build Frontend & Giao diện tự động
```bash
# Kiểm tra lỗi tĩnh với Oxlint và đóng gói bản Production trên Frontend
cd frontend
npm run lint
npm run build

# (Tùy chọn) Chạy bộ kiểm thử giao diện tự động đa vai trò & mobile viewport (yêu cầu DB + API + Frontend đang chạy)
cd ../api
npm run test:ui
```

### 8.3. Xử lý các sự cố thường gặp (Troubleshooting)

| Sự cố / Mã lỗi | Nguyên nhân phổ biến | Cách khắc phục |
| :--- | :--- | :--- |
| `ECONNREFUSED 127.0.0.1:5433` | Container PostgreSQL chưa bật hoặc PostgreSQL trên máy đang chạy ở cổng `5432`. | Chạy `docker compose up -d postgres` (cổng `5433`), hoặc đổi `DB_PORT=5432` và cổng trong `DATABASE_URL` / `APP_DATABASE_URL` tại `api/.env`. |
| `JWT_SECRET / JWT_REFRESH_SECRET bắt buộc` | Chưa tạo file `.env` trong `api/` hoặc để trống khóa ký token. | Chạy `cp api/.env.example api/.env` và điền giá trị cho `JWT_SECRET`, `JWT_REFRESH_SECRET`. |
| `role "resihub_app" does not exist` hoặc `relation "..." does not exist` | Database mới tạo nhưng chưa chạy migration. | Chạy `cd api && npm run migrate` để khởi tạo role `resihub_app`, 29 bảng và chính sách RLS. |
| Không nhận được OTP hoặc báo `OTP_NOT_FOUND` khi thử SĐT ngẫu nhiên | Cơ chế chống dò quét danh tính chỉ phát sinh OTP cho SĐT đã có trong bảng `person`. | Dùng SĐT của tài khoản đã seed (VD: `0907000001`, `0905000011`) hoặc đặt giữ chỗ mới tại `/explore` trước khi đăng nhập OTP. |
| `IDEMPOTENCY_KEY_REQUIRED` (`400`) | Bật `NODE_ENV=production` hoặc `REQUIRE_IDEMPOTENCY_KEY=true` khi gọi API thủ công qua Postman/cURL. | Đính kèm header `Idempotency-Key: <uuid-duy-nhất>` vào các request ghi dữ liệu (trên Frontend Axios đã tự động đính kèm). |
| Tính năng AI báo lỗi cấu hình / không trích xuất được | Chưa khai báo `GEMINI_API_KEY` hợp lệ hoặc tính năng AI đang tắt trong Cấu hình hệ thống. | Điền `GEMINI_API_KEY` vào `api/.env`, khởi động lại Backend và kiểm tra công tắc AI tại trang **Người dùng & Cấu hình** (`SYS_ADMIN`). |
| `Port 5000 / 3000 already in use` | Tiến trình Node.js của phiên chạy trước chưa đóng hoàn toàn. | Tắt terminal cũ hoặc giải phóng tiến trình đang chiếm cổng `3000` / `5000` trước khi chạy lại `npm run dev`. |

---

## 9. Tài liệu kỹ thuật & Quy chuẩn đóng góp

### 9.1. Hệ thống tài liệu trong kho mã nguồn
- **Đặc tả sản phẩm gốc:** [`PRD - Quan ly Can ho va Nha cho thue v2.0.md`](PRD%20-%20Quan%20ly%20Can%20ho%20va%20Nha%20cho%20thue%20v2.0.md)
- **Báo cáo kỹ thuật Giai đoạn 1 (M01 – M06):** [`docs/BAO_CAO_GIAI_DOAN_1_TUAN_1_4.md`](docs/BAO_CAO_GIAI_DOAN_1_TUAN_1_4.md)
- **Báo cáo kỹ thuật Giai đoạn 2 (M07 – M15):** [`docs/BAO_CAO_GIAI_DOAN_2_TUAN_5_8.md`](docs/BAO_CAO_GIAI_DOAN_2_TUAN_5_8.md)
- **Thiết kế chi tiết & Kế hoạch triển khai từng tính năng:** [`docs/superpowers/specs/`](docs/superpowers/specs/) & [`docs/superpowers/plans/`](docs/superpowers/plans/)

### 9.2. Quy ước phát triển & Commit (Conventional Commits)
- **Nhánh phát triển:** `feat/<ten-tinh-nang>`, `fix/<mo-ta-loi>`, `refactor/<pham-vi>`, `docs/<noi-dung>`.
- **Định dạng thông điệp Commit:**
  ```text
  <type>(<scope>): <mô tả ngắn gọn thay đổi>
  ```
  *Ví dụ:*
  - `feat(billing): support mid-month service registration invoice sync and next-period pro-rata arrears`
  - `feat(admin,db): add SYS_ADMIN guarded delete, bulk floor creation, and consolidate RLS migrations`
  - `docs(readme): update project architecture, modules M01-M15, setup and test instructions`

### 9.3. Giấy phép (License)
Mã nguồn dự án được sử dụng cho mục đích phát triển, đào tạo và vận hành hệ thống **ResiHub**.

---

<p align="center">
  Phát triển với ❤️ bởi <strong>ResiHub Engineering Team</strong>
</p>
