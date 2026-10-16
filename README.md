# 🏢 ResiHub — Hệ thống Quản lý Căn hộ & Cho thuê Bất động sản

[![Node.js](https://img.shields.io/badge/Node.js-v20+-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-v19-blue.svg)](https://react.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-v16-336791.svg)](https://www.postgresql.org/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-v3.4-38B2AC.svg)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-amber.svg)](LICENSE)

**ResiHub** là nền tảng quản lý vận hành bất động sản, căn hộ dịch vụ và nhà cho thuê chuyên nghiệp. Hệ thống số hóa toàn diện quy trình từ khâu tiếp thị, đặt cọc giữ chỗ, lập hợp đồng thuê, quản lý sổ cọc, hồ sơ cư dân đến cổng dịch vụ số tương tác 2 chiều giữa Ban Quản Lý (BQL) và Cư dân.

---

## 📑 Mục lục

1. [Giới thiệu dự án](#1-giới-thiệu-dự-án)
2. [Công nghệ sử dụng (Tech Stack)](#2-công-nghệ-sử-dụng-tech-stack)
3. [Cấu trúc thư mục](#3-cấu-trúc-thư-mục)
4. [Yêu cầu môi trường](#4-yêu-cầu-môi-trường)
5. [Hướng dẫn cài đặt và chạy](#5-hướng-dẫn-cài-đặt-và-chạy)
6. [Cấu hình hệ thống (.env)](#6-cấu-hình-hệ-thống)
7. [Kiến trúc & Danh mục API](#7-kiến-trúc--danh-mục-api)
8. [Kiểm thử và Xử lý lỗi](#8-kiểm-thử-và-xử-lý-lỗi)
9. [Quy chuẩn đóng góp & Giấy phép](#9-quy-chuẩn-đóng-góp--giấy-phép)

---

## 1. Giới thiệu dự án

### 1.1. Mục đích dự án
Xây dựng một nền tảng quản lý tập trung, hiện đại, loại bỏ các bất cập của việc quản lý bằng sổ tay, file Excel truyền thống; đảm bảo dữ liệu minh bạch, tài chính chuẩn xác và tối ưu hóa tỷ lệ lấp đầy phòng.

### 1.2. Bài toán dự án giải quyết
- **Chống chồng lấn hợp đồng (Overlap Contract):** Ngăn chặn triệt để tình trạng 2 hợp đồng thuê cùng hiệu lực trên một căn hộ trong cùng một khoảng thời gian.
- **Minh bạch sổ cọc (Deposit Ledger):** Tách biệt số dư tiền cọc bảo lưu với dòng tiền doanh thu thuê nhà; cấm tuyệt đối việc cấn trừ tiền cọc vào tiền thuê nhà sai quy định.
- **Cô lập dữ liệu đa cấp (Data Scoping & RLS):** Đảm bảo Quản lý chỉ được thao tác trên các tòa nhà mình quản lý; Cư dân chỉ xem được hợp đồng và căn hộ của chính mình.
- **Trải nghiệm cư dân thông minh (Resident Onboarding):** Tách biệt rõ 2 luồng: Khách thuê mới chưa ký hợp đồng (xem cọc giữ chỗ, khám phá căn hộ trống, tự khai CCCD nhận nhà) và Cư dân đang cư trú (quản lý tiền thuê, báo hỏng thiết bị, liên hệ BQL).

### 1.3. Đối tượng sử dụng (Actors & Roles)
Hệ thống chuẩn hóa 3 vai trò cố định:
1. **Chủ sở hữu / Chủ đầu tư (`OWNER`):**
   - Xem báo cáo, thống kê doanh thu, tỷ lệ lấp đầy của toàn bộ các tòa nhà thuộc sở hữu trong tổ chức (Quyền `R` - Read-only).
2. **Quản lý vận hành (`MANAGER`):**
   - Toàn quyền khởi tạo, theo dõi, cập nhật tòa nhà, tầng, căn hộ trong phạm vi được phân công (Quyền `CRU` - Create, Read, Update).
   - Lập hợp đồng thuê, thu tiền cọc, duyệt hồ sơ cư dân và xử lý yêu cầu báo hỏng.
3. **Cư dân thuê (`RESIDENT`):**
   - **Chưa có HĐ:** Theo dõi phiếu đặt cọc giữ chỗ, khai báo CCCD nhận phòng, xem danh mục phòng trống.
   - **Đã ký HĐ:** Theo dõi tiền thuê, số dư cọc đang giữ, báo hỏng thiết bị 24/7 và đăng ký dịch vụ.

### 1.4. Các chức năng chính (Modules)
- **M01 — Xác thực OTP & Mật khẩu:** Đăng nhập OTP qua SĐT (chống rò rỉ dữ liệu) và đăng nhập nội bộ qua Email/Password.
- **M02 — Phân quyền RBAC & RLS:** Bảo mật 2 lớp: Middleware API và Row Level Security trong PostgreSQL.
- **M03 — Quản lý Bất động sản:** Quản lý Tòa nhà, Tầng hầm/trệt/lầu, Căn hộ, Sơ đồ trạng thái phòng thời gian thực (Floor-map).
- **M04 — Cọc giữ chỗ & Hồ sơ cư dân:** Quản lý khách tiềm năng, đặt cọc giữ chỗ tự động khóa căn hộ (`HELD` -> `RESERVED`), khai báo PII cư dân (CCCD, SĐT).
- **M05 — Quản lý Hợp đồng thuê:** Lập hợp đồng, quản lý chu kỳ thu tiền, gia hạn và thanh lý hợp đồng.
- **M06 — Sổ cọc độc lập:** Theo dõi cọc đang giữ (`HELD`), lịch sử khấu trừ hư hại tài sản và hoàn cọc minh bạch.
- **M07 — Cổng Cư Dân (Resident Portal):** Giao diện chuyên biệt cho cư dân, tương thích thiết bị di động.
- **M08 — Trung tâm Thông báo:** Tiếp nhận và xử lý thông báo biến động hợp đồng, sự cố tòa nhà theo thời gian thực.

---

## 2. Công nghệ sử dụng (Tech Stack)

| Tầng hệ thống | Công nghệ / Thư viện | Vai trò |
| :--- | :--- | :--- |
| **Frontend** | **React 19** | Thư viện UI hiện đại |
| | **Vite 8** | Build tool siêu tốc với HMR |
| | **Zustand 5** | Quản lý global state (Auth, Session) |
| | **React Router DOM v7** | Điều hướng Single Page Application |
| | **TailwindCSS v3.4** | Utility-first CSS framework |
| | **Lucide React** | Bộ icon SVG hiện đại, sắc nét |
| | **Chart.js & React-Chartjs-2**| Biểu đồ trực quan hóa dữ liệu Dashboard |
| | **Axios** | HTTP client kết nối Backend RESTful API |
| **Backend** | **Node.js (ES Modules)** | Nền tảng thực thi server-side |
| | **Express.js 4** | Web framework xây dựng REST API |
| | **jsonwebtoken (JWT)** | Xác thực Access Token (15m) & Refresh Token (7d) |
| | **bcryptjs** | Mã hóa an toàn mật khẩu người dùng |
| | **express-rate-limit** | Chống tấn công brute-force & DoS API |
| | **Morgan** | Logging HTTP request |
| **Database** | **PostgreSQL 16** | Cơ sở dữ liệu quan hệ ACID mạnh mẽ |
| | **pg (node-postgres)** | Native connection pool driver cho Node.js |
| | **PostgreSQL RLS** | Row Level Security cô lập dữ liệu theo org & tòa nhà |
| **DevOps & Tooling** | **Docker & Docker Compose** | Đóng gói môi trường đồng nhất một lệnh chạy |
| | **Nodemon** | Auto-reload server backend trong môi trường phát triển |

---

## 3. Cấu trúc thư mục

```
resihub2/
├── .env.example                     # Mẫu biến môi trường dùng chung
├── docker-compose.yml               # Cấu hình khởi chạy trọn gói Docker (DB, API, Frontend)
├── docker-compose.dev.yml           # Cấu hình Docker dành cho môi trường dev
├── PRD - Quan ly Can ho va Nha cho thue v2.0.md  # Tài liệu đặc tả yêu cầu phần mềm chuẩn (PRD)
├── Phase1_Plan_Chi_Tiet.md          # Kế hoạch chi tiết và ma trận nghiệm thu Phase 1
│
├── api/                             # MÃ NGUỒN BACKEND (Node.js/Express)
│   ├── package.json                 # Cấu hình dependency & scripts backend
│   ├── remove_deprecated_roles.js   # Script dọn dẹp các vai trò cũ khỏi DB
│   ├── setup_resident_test_accounts.js # Script khởi tạo tài khoản test cư dân
│   ├── test_crud_scoping.mjs        # Bộ kiểm thử tự động phân quyền CRUD tòa nhà/căn hộ (21 test)
│   ├── test_phase1_compliance.mjs   # Bộ kiểm thử nghiệp vụ toàn diện Phase 1 PRD (39 test)
│   └── src/
│       ├── server.js                # Điểm khởi động Express server & đăng ký route
│       ├── db/
│       │   ├── client.js            # Khởi tạo PostgreSQL Connection Pool
│       │   ├── migrate.js           # Bộ chạy migration tự động theo thứ tự
│       │   ├── seed.js              # Khởi tạo dữ liệu mẫu (Tòa nhà, tầng, căn hộ, users)
│       │   └── migrations/          # 12 bản migration SQL khởi tạo schema & RLS
│       │       ├── 001_extensions.sql
│       │       ├── 002_organization_users.sql
│       │       ├── 003_real_estate.sql
│       │       ├── 004_tenants_reservations.sql
│       │       ├── 005_contracts.sql
│       │       ├── 006_deposits.sql
│       │       ├── 007_audit_attachments.sql
│       │       ├── 008_indexes.sql
│       │       ├── 009_rls.sql
│       │       ├── 010_rls_policies.sql
│       │       ├── 011_notifications.sql
│       │       └── 012_remove_deprecated_roles.sql
│       ├── middleware/
│       │   ├── auth.js              # Middleware xác thực JWT token
│       │   ├── rbac.js              # Middleware kiểm tra quyền theo vai trò (requireRole)
│       │   └── rateLimiter.js       # Giới hạn tần suất gọi API
│       └── routes/                  # Các RESTful API routes
│           ├── auth.js              # Đăng nhập OTP, Email/Password, Refresh token
│           ├── buildings.js         # CRUD Tòa nhà, Tầng (Floors), Sơ đồ căn hộ
│           ├── apartments.js        # CRUD Căn hộ, cập nhật giá thuê, trạng thái
│           ├── tenants.js           # Quản lý hồ sơ cư dân & duplicate check
│           ├── contracts.js         # Lập HĐ, gia hạn, chống trùng lặp, thanh lý
│           ├── deposits.js          # Sổ cọc, thu cọc, cấm cấn trừ, khấu trừ hư hại
│           ├── reservations.js      # Đặt cọc giữ chỗ khách tiềm năng
│           ├── resident.js          # Cổng Cư Dân: tổng quan, khai báo CCCD, báo hỏng
│           ├── notifications.js     # Danh sách thông báo, đánh dấu đã đọc
│           └── health.js            # Health-check endpoint hệ thống
│
└── frontend/                        # MÃ NGUỒN FRONTEND (React 19 + Vite)
    ├── package.json                 # Dependency & scripts frontend
    ├── vite.config.js               # Cấu hình Vite dev server và build
    ├── tailwind.config.js           # Cấu hình theme, màu sắc và typography Tailwind
    └── src/
        ├── main.jsx                 # Điểm gắn kết React DOM
        ├── App.jsx                  # Root App component
        ├── constants/
        │   └── navigation.js        # Menu điều hướng theo phân quyền RBAC
        ├── services/
        │   └── api.js               # Axios instance tự động đính kèm Bearer Token
        ├── stores/
        │   └── authStore.js         # Zustand store lưu thông tin user, role, token
        ├── router/
        │   └── index.jsx            # Định tuyến thông minh, Route Guards theo Role
        ├── components/
        │   ├── layout/
        │   │   ├── AdminLayout.jsx  # Layout dành riêng cho OWNER và MANAGER
        │   │   ├── ResidentLayout.jsx # Layout dành riêng cho RESIDENT
        │   │   ├── Sidebar.jsx      # Thanh điều hướng phân hệ quản trị
        │   │   └── TopBar.jsx       # Header quản trị, chuông thông báo, chọn tòa
        │   └── common/
        │       └── AccessDenied.jsx # Màn hình thông báo phân quyền 403
        └── pages/
            ├── auth/
            │   └── LoginPage.jsx    # Trang đăng nhập OTP & Mật khẩu (Quick-fill test)
            ├── admin/
            │   ├── dashboard/       # Báo cáo tổng quan theo vai trò Owner / Manager
            │   ├── buildings/       # Quản trị Tòa nhà, Tầng, Căn hộ
            │   ├── tenants/         # Quản trị danh sách Cư dân
            │   ├── contracts/       # Quản trị Hợp đồng thuê
            │   └── deposits/        # Quản trị Sổ cọc & Khấu trừ
            └── resident/
                └── ResidentPortalPage.jsx # Cổng Cư Dân (Đã ký HĐ & Chưa ký HĐ)
```

---

## 4. Yêu cầu môi trường

Để chạy dự án ổn định, máy tính của bạn cần đáp ứng các điều kiện tiên quyết sau:

| Công cụ | Phiên bản yêu cầu | Ghi chú |
| :--- | :--- | :--- |
| **Node.js** | `>= 18.18.0` (Khuyến nghị **v20.x** hoặc **v22.x LTS**) | Kiểm tra bằng: `node -v` |
| **npm** | `>= 9.x` | Đi kèm khi cài Node.js |
| **PostgreSQL** | `>= 15.x` (Khuyến nghị **v16**) | Chạy local hoặc qua Docker |
| **Docker & Compose** | Docker Desktop 4.x+ | *(Tùy chọn)* Nếu muốn chạy container |
| **Git** | `>= 2.30` | Quản lý phiên bản mã nguồn |

---

## 5. Hướng dẫn cài đặt và chạy

### Cách 1: Chạy trực tiếp trên máy cục bộ (Khuyến nghị cho Lập trình viên)

#### Bước 1: Clone mã nguồn
```bash
git clone https://github.com/your-username/resihub.git
cd resihub
```

#### Bước 2: Thiết lập Cơ sở dữ liệu PostgreSQL
1. Đảm bảo PostgreSQL đang chạy trên cổng `5433` (hoặc `5432` theo cấu hình của bạn).
2. Tạo cơ sở dữ liệu `resihub`:
```sql
CREATE DATABASE resihub;
```

#### Bước 3: Cài đặt và Khởi tạo Backend (API)
```bash
# 1. Di chuyển vào thư mục api
cd api

# 2. Cài đặt các thư viện phụ thuộc
npm install

# 3. Tạo file cấu hình biến môi trường
cp ../.env.example .env
# (Chỉnh sửa file .env cho đúng thông tin kết nối PostgreSQL của bạn)

# 4. Chạy migration tạo bảng và chính sách bảo mật RLS
npm run migrate

# 5. Khởi tạo dữ liệu mẫu ban đầu
npm run seed

# 6. Thiết lập tài khoản test cho cư dân
node setup_resident_test_accounts.js

# 7. Khởi động server backend (chạy trên port 5000)
npm run dev
```

#### Bước 4: Cài đặt và Khởi động Frontend
Mở một cửa sổ Terminal mới:
```bash
# 1. Di chuyển vào thư mục frontend
cd frontend

# 2. Cài đặt các thư viện phụ thuộc
npm install

# 3. Khởi động Vite dev server (chạy trên port 3000)
npm run dev
```

#### Bước 5: Truy cập ứng dụng
- Mở trình duyệt tại địa chỉ: **[http://localhost:3000](http://localhost:3000)**
- Kiểm tra trạng thái Backend API: **[http://localhost:5000/api/health](http://localhost:5000/api/health)**

---

### Cách 2: Khởi chạy nhanh bằng Docker Compose

Nếu bạn đã cài đặt sẵn Docker Desktop, chỉ cần chạy 1 lệnh duy nhất:
```bash
# Khởi chạy toàn bộ PostgreSQL, Backend API và Frontend
docker compose up --build -d
```
Docker sẽ tự động kích hoạt container PostgreSQL (port 5433), Backend (port 5000) và Frontend (port 3000).

---

## 6. Cấu hình hệ thống

Tạo file `.env` tại thư mục gốc hoặc trong thư mục `api/` dựa trên mẫu sau:

```env
# ==============================================================================
# CẤU HÌNH KẾT NỐI POSTGRESQL DATABASE
# ==============================================================================
POSTGRES_DB=resihub
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_secure_password_here
DB_HOST=localhost
DB_PORT=5433
DATABASE_URL=postgres://postgres:your_secure_password_here@localhost:5433/resihub

# ==============================================================================
# CẤU HÌNH BACKEND SERVER
# ==============================================================================
PORT=5000
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000

# ==============================================================================
# BẢO MẬT & MÃ HÓA TOKEN (JWT)
# ==============================================================================
# Khóa bí mật dùng để ký Access Token (15 phút)
JWT_SECRET=replace_with_your_super_secret_jwt_key_here
# Khóa bí mật dùng để ký Refresh Token (7 ngày)
JWT_REFRESH_SECRET=replace_with_your_super_secret_refresh_key_here
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_IN=7d

# ==============================================================================
# CẤU HÌNH FRONTEND (Vite)
# ==============================================================================
VITE_API_URL=http://localhost:5000
```

> [!WARNING]
> **Quy tắc an toàn:** Tuyệt đối không commit file `.env` chứa mật khẩu thật lên GitHub/GitLab. File `.env` đã được cấu hình trong `.gitignore`.

---

## 7. Kiến trúc & Danh mục API

### 7.1. Kiến trúc hệ thống
ResiHub được thiết kế theo kiến trúc **3-Tier**:
1. **Client Tier (Presentation):** React 19 SPA, TailwindCSS, Axios interceptor tự động bắt mã lỗi `401` để làm mới token.
2. **Application Tier (Business Logic):** Express.js REST API, kiến trúc Controller-Route-Middleware, áp dụng quy chuẩn phân quyền RBAC 2 lớp.
3. **Data Tier (Persistence):** PostgreSQL 16 với tính năng **Row Level Security (RLS)** để cô lập dữ liệu theo tổ chức (`org_id`) và tòa nhà (`building_id`).

### 7.2. Danh mục tài khoản thử nghiệm có sẵn

Tại màn hình đăng nhập, hệ thống cung cấp các nút bấm nhanh:

| Vai trò | Email đăng nhập | Mật khẩu | Số điện thoại | Quyền hạn & Chức năng |
| :--- | :--- | :--- | :--- | :--- |
| **OWNER** | `owner@resihub.vn` | `password123` | `0900000002` | Xem báo cáo toàn bộ 25+ tòa nhà; chế độ Read-only. |
| **MANAGER** | `manager@resihub.vn` | `password123` | `0901234567` | Quản lý tòa Thảo Điền; CRU tòa nhà, tầng, căn hộ, hợp đồng, cọc. |
| **RESIDENT (Chưa HĐ)** | `resident@resihub.vn` | `password123` | `0900000005` | Khách mới; có phiếu cọc giữ chỗ căn A202; khai báo CCCD; xem phòng trống. |
| **RESIDENT (Đã ký HĐ)** | `resident_active@resihub.vn` | `password123` | `0907778899` | Đang thuê căn A102; xem tiền thuê, tiền cọc 18 triệu; báo hỏng thiết bị. |
| **Đăng nhập OTP** | Nhập SĐT bất kỳ | *Mã test:* `123456` | — | Đăng nhập an toàn theo chuẩn số điện thoại Việt Nam. |

### 7.3. Các API Endpoints chính

#### Xác thực (`/api/v1/auth`)
- `POST /api/v1/auth/otp/request` — Yêu cầu gửi mã OTP về số điện thoại (Dev: log console).
- `POST /api/v1/auth/otp/verify` — Xác thực OTP, sinh Access Token & Refresh Token.
- `POST /api/v1/auth/login` — Đăng nhập bằng Email & Mật khẩu cho nhân sự nội bộ.
- `POST /api/v1/auth/refresh` — Cấp lại Access Token mới từ Refresh Token.

#### Bất động sản (`/api/v1/buildings` & `/api/v1/apartments`)
- `GET /api/v1/buildings` — Lấy danh sách tòa nhà (Owner: xem toàn bộ; Manager: chỉ tòa được gán).
- `POST /api/v1/buildings` — Tạo tòa nhà mới (Chỉ Manager; tự động gán quyền quản lý).
- `GET /api/v1/buildings/:id/floor-map` — Lấy sơ đồ phân tầng và trạng thái từng căn hộ.
- `POST /api/v1/buildings/:id/floors` — Thêm tầng hầm, trệt, lầu (Chặn trùng level).
- `GET /api/v1/apartments` — Danh sách căn hộ có lọc theo tòa nhà và trạng thái (`AVAILABLE`, `OCCUPIED`, `RESERVED`).
- `POST /api/v1/apartments` — Tạo căn hộ mới với giá thuê định dạng BigInt.
- `PATCH /api/v1/apartments/:id` — Cập nhật thông tin căn hộ, giá thuê, tiện nghi.

#### Cọc & Hợp đồng (`/api/v1/reservations`, `/api/v1/contracts`, `/api/v1/deposits`)
- `POST /api/v1/reservations` — Đặt cọc giữ chỗ (Tự động khóa căn hộ sang `RESERVED`).
- `POST /api/v1/contracts` — Lập hợp đồng thuê mới (Kiểm tra chặn chống chồng lấn kỳ hạn).
- `POST /api/v1/contracts/:id/terminate` — Chấm dứt hợp đồng (Tự động mở lại căn hộ sang `AVAILABLE`).
- `GET /api/v1/deposits` — Truy vấn sổ cọc độc lập của các hợp đồng.
- `POST /api/v1/deposits/:id/deduct` — Khấu trừ hư hại tài sản vào cọc (Cấm cấn trừ tiền thuê).

#### Cổng Cư Dân (`/api/v1/resident`)
- `GET /api/v1/resident/overview` — Lấy toàn bộ dữ liệu cá nhân hóa cho cư dân (HĐ đang thuê, cọc giữ chỗ, danh sách phòng trống).
- `POST /api/v1/resident/rental-application` — Khai báo hồ sơ cư dân tự nhận phòng (FR-012).
- `POST /api/v1/resident/service-requests` — Báo hỏng, gửi yêu cầu sửa chữa thiết bị (FR-042).

---

## 8. Kiểm thử và Xử lý lỗi

### 8.1. Chạy các bộ kiểm thử tự động
Dự án được trang bị 2 bộ kiểm thử tích hợp chuyên sâu, kiểm tra toàn bộ luồng nghiệp vụ:

```bash
cd api

# 1. Chạy kiểm thử tuân thủ 100% tài liệu PRD Phase 1 (11 nhóm nghiệp vụ lớn)
node test_phase1_compliance.mjs

# 2. Chạy kiểm thử ma trận phân quyền CRUD Tòa nhà/Căn hộ và Scoping
node test_crud_scoping.mjs
```

**Kết quả kỳ vọng:**
- `test_phase1_compliance.mjs`: **39/39 PASS (100%)**
- `test_crud_scoping.mjs`: **21/21 PASS (100%)**

### 8.2. Kiểm thử Frontend Build
```bash
cd frontend
npm run build
```
Đảm bảo bản build Vite production hoàn tất không có bất kỳ cảnh báo lỗi cú pháp nào.

### 8.3. Xử lý các sự cố thường gặp (Troubleshooting)

| Sự cố | Nguyên nhân | Hướng khắc phục |
| :--- | :--- | :--- |
| `ECONNREFUSED 127.0.0.1:5433` | PostgreSQL chưa được bật hoặc đang chạy ở cổng khác (`5432`). | Kiểm tra dịch vụ PostgreSQL trong Services của Windows hoặc Docker. Nếu PostgreSQL chạy ở cổng 5432, cập nhật `DB_PORT=5432` trong file `.env`. |
| `relation "..." does not exist` | Chưa chạy migration cơ sở dữ liệu. | Chạy lệnh `npm run migrate` trong thư mục `api/`. |
| `Mã OTP không chính xác` | Nhập sai OTP trong môi trường phát triển. | Sử dụng mã OTP Master mặc định cho môi trường Dev: `123456` hoặc xem log tại terminal server backend. |
| `Lỗi 403 - Khu vực hạn chế quyền` | Truy cập trang không thuộc thẩm quyền vai trò. | Hệ thống sử dụng RBAC nghiêm ngặt: `RESIDENT` chỉ vào được `/resident`; `OWNER` và `MANAGER` quản trị tại `/admin/*`. |
| `Port 5000 / 3000 already in use` | Tiến trình cũ chưa tắt hẳn. | Trên Windows PowerShell: `Get-Process node \| Stop-Process -Force` để giải phóng cổng. |

---

## 9. Quy chuẩn đóng góp & Giấy phép

### 9.1. Quy trình phát triển (Git Workflow)
- **Branch chính:**
  - `main`: Nhánh ổn định, sẵn sàng triển khai Production.
  - `develop`: Nhánh tích hợp các tính năng mới trong quá trình phát triển.
- **Quy ước đặt tên nhánh (Branch Naming):**
  - `feat/feature-name`: Phát triển tính năng mới.
  - `fix/bug-description`: Sửa lỗi.
  - `refactor/code-optimization`: Tối ưu hóa cấu trúc mã nguồn.

### 9.2. Quy ước thông điệp Commit (Conventional Commits)
Tuân thủ định dạng chuẩn quốc tế:
```
<type>(<scope>): <mô tả ngắn gọn bằng tiếng Anh hoặc tiếng Việt>
```
Ví dụ:
- `feat(resident): implement dedicated resident portal for uncontracted and contracted tenants`
- `feat(rbac): refactor roles to MANAGER, OWNER, RESIDENT and enforce building CRUD scoping`
- `fix(contracts): prevent overlapping rental dates on same apartment`
- `docs(readme): add comprehensive system documentation`

### 9.3. Giấy phép (License)
Dự án được phân phối dưới giấy phép **MIT License**. Bạn được toàn quyền sử dụng, sửa đổi và đóng gói cho mục đích học tập hoặc thương mại.

---

<p align="center">
  Phát triển với ❤️ bởi <strong>ResiHub Engineering Team</strong>
</p>
