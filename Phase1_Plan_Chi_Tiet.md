# 📋 KẾ HOẠCH CHI TIẾT GIAI ĐOẠN 1 — ResiHub MVP

> **Dự án:** ResiHub – Hệ thống quản lý căn hộ & nhà cho thuê  
> **Tech Stack:** React + Tailwind + Lucide + Chart.js · PostgreSQL · Supabase (Self-host) · Docker · Ubuntu  
> **Phạm vi giai đoạn:** Tuần 1 → Tuần 4 (tương đương S1 + S2 trong PRD v0.2)  
> **Tương đương PRD:** M01, M02, M03, M04, M05, M06  
> **Tác giả:** Lộ trình dựa theo PRD v0.2 ngày 18/09/2026 & Roadmap Frontend Developer (Hiệp)  
> **Cập nhật:** 2026-10-14  

---

## 🗺️ TỔNG QUAN GIAI ĐOẠN 1

### Mục tiêu cuối giai đoạn
Khi kết thúc Tuần 4, hệ thống phải:
1. ✅ Chạy trên máy local (Docker Compose) với đủ 3 service: Frontend, API, PostgreSQL
2. ✅ Đăng nhập thành công bằng OTP giả lập (SMS mock)
3. ✅ Tạo thành công cây dữ liệu: **Tổ chức → Tòa nhà → Tầng → Căn hộ → Cư dân → Hợp đồng → Cọc**
4. ✅ RBAC hoạt động đúng (5 vai trò cơ bản), RLS bảo vệ dữ liệu ở tầng DB
5. ✅ Audit log ghi mọi thay đổi dữ liệu
6. ✅ Code gọi API từ Frontend đến Backend chạy trơn tru

### Sprint Timeline

```
Tuần 1 (Ngày 1-7)  : Hạ tầng + DB Schema + Design System
Tuần 2 (Ngày 8-14) : Auth OTP + RBAC/RLS + Khung giao diện Admin
Tuần 3 (Ngày 15-21): Module M03 (Bất động sản) + M04 (Cư dân)
Tuần 4 (Ngày 22-28): Module M05 (Hợp đồng) + M06 (Cọc) + Tích hợp
```

### Modules trong phạm vi

| Module | Tên | Priority | Tuần |
|--------|-----|----------|------|
| M01 | Quản trị & Cấu hình hệ thống | P0 | 1-2 |
| M02 | Xác thực & Tài khoản | P0 | 2 |
| M03 | Bất động sản | P0 | 3 |
| M04 | Cư dân & Hộ thuê | P0 | 3 |
| M05 | Hợp đồng | P0 | 4 |
| M06 | Cọc | P0 | 4 |

---

## 📅 TUẦN 1: HẠ TẦNG + DATABASE SCHEMA + DESIGN SYSTEM
> **Ngày 1–7** | Mục tiêu: Dự án chạy được trên local, schema DB đầy đủ, Design System sẵn dùng

### 🎯 Mục tiêu tuần

- Repo Git khởi tạo, CI cơ bản chạy được
- Docker Compose chạy 3 service: `frontend`, `api`, `postgres`
- Toàn bộ schema PostgreSQL cho Phase 1 đã được migrate
- Design System (Tailwind config + components cơ bản) hoàn thiện
- Màn hình Đăng nhập, Layout Admin có thể render

---

### 📁 Cấu trúc thư mục dự án

```
resihub/
├── frontend/                    # React app (Vite)
│   ├── src/
│   │   ├── assets/
│   │   ├── components/          # Shared UI components
│   │   │   ├── ui/              # Design System primitives
│   │   │   │   ├── Button.jsx
│   │   │   │   ├── Input.jsx
│   │   │   │   ├── StatusBadge.jsx
│   │   │   │   ├── DataTable.jsx
│   │   │   │   ├── EmptyState.jsx
│   │   │   │   ├── ConfirmDialog.jsx
│   │   │   │   ├── AISuggestionField.jsx
│   │   │   │   ├── Money.jsx
│   │   │   │   ├── Timeline.jsx
│   │   │   │   └── FileUploader.jsx
│   │   │   ├── layout/
│   │   │   │   ├── AdminLayout.jsx
│   │   │   │   ├── ResidentLayout.jsx
│   │   │   │   ├── Sidebar.jsx
│   │   │   │   └── TopBar.jsx
│   │   │   └── shared/
│   │   ├── pages/
│   │   │   ├── auth/
│   │   │   │   ├── LoginPage.jsx
│   │   │   │   └── OtpVerifyPage.jsx
│   │   │   ├── admin/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── buildings/
│   │   │   │   ├── apartments/
│   │   │   │   ├── tenants/
│   │   │   │   ├── contracts/
│   │   │   │   └── deposits/
│   │   │   └── resident/
│   │   ├── hooks/               # Custom React hooks
│   │   ├── services/            # API call layer
│   │   ├── stores/              # Zustand state stores
│   │   ├── utils/               # Helpers (money, date, validation)
│   │   ├── constants/           # Enums, config
│   │   └── router/              # React Router config
│   ├── tailwind.config.js
│   └── vite.config.js
│
├── api/                         # Node.js/Express API
│   ├── src/
│   │   ├── routes/
│   │   ├── controllers/
│   │   ├── middleware/
│   │   │   ├── auth.js          # JWT verify
│   │   │   ├── rbac.js          # Role check
│   │   │   └── rateLimiter.js
│   │   ├── services/
│   │   └── db/
│   │       ├── client.js        # pg pool
│   │       └── migrations/      # SQL migration files
│   └── Dockerfile
│
├── docker-compose.yml
├── docker-compose.dev.yml
└── .env.example
```

---

### 🗄️ DATABASE SCHEMA ĐẦY ĐỦ (Phase 1)

> Dùng AI (Antigravity) để sinh toàn bộ SQL bên dưới. Học cách đọc hiểu, không cần tự gõ.

#### **Nhóm 1: Tổ chức & Người dùng (M01)**

```sql
-- Tổ chức (chủ đầu tư / công ty vận hành)
CREATE TABLE organization (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  tax_code    TEXT,
  settings    JSONB DEFAULT '{}',
  payment_account JSONB DEFAULT '{}',  -- {bank, account_no, account_name, type}
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Chủ sở hữu tòa (cho mô hình thuê lại)
CREATE TABLE owner (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organization(id),
  full_name   TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Vai trò
CREATE TABLE role (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organization(id),
  code        TEXT NOT NULL,  -- OWNER, MANAGER, STAFF, ACCOUNTANT, RESIDENT, SYS_ADMIN, PROSPECT
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('org', 'building')),
  UNIQUE (org_id, code)
);

-- Thông tin cá nhân (base cho cư dân và nhân viên)
CREATE TABLE person (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organization(id),
  full_name   TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  dob         DATE,
  id_number   TEXT,              -- CCCD — mã hóa ở cột
  id_images   TEXT[] DEFAULT '{}',  -- URL ảnh, bucket riêng
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (org_id, phone)         -- FR-021: chống trùng
);

-- Người dùng ứng dụng
CREATE TABLE app_user (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   UUID REFERENCES person(id),
  auth_uid    TEXT UNIQUE,       -- Supabase Auth UID
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  last_login_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Gán vai trò cho người dùng (có thể gán theo tòa)
CREATE TABLE user_role (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES app_user(id),
  role_id     UUID REFERENCES role(id),
  building_id UUID,              -- NULL = scope org
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, role_id, building_id)
);
```

#### **Nhóm 2: Bất động sản (M03)**

```sql
-- Tòa nhà
CREATE TABLE building (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organization(id),
  owner_id    UUID REFERENCES owner(id),
  name        TEXT NOT NULL,
  code        TEXT NOT NULL,
  address     TEXT,
  timezone    TEXT DEFAULT 'Asia/Ho_Chi_Minh',
  lease_terms JSONB DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (org_id, code)
);

-- Tầng
CREATE TABLE floor (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id UUID REFERENCES building(id),
  level       INTEGER NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (building_id, level)
);

-- Căn hộ
CREATE TABLE apartment (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id    UUID REFERENCES floor(id),
  building_id UUID REFERENCES building(id),
  code        TEXT NOT NULL,
  area_m2     NUMERIC(6,2),
  type        TEXT,
  bedrooms    INTEGER DEFAULT 0,
  base_rent   BIGINT DEFAULT 0,   -- VND, integer (không dùng float)
  amenities   JSONB DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'AVAILABLE'
              CHECK (status IN ('AVAILABLE','RESERVED','OCCUPIED','MAINTENANCE','INACTIVE')),
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (building_id, code)
);
```

#### **Nhóm 3: Cư dân & Hộ thuê (M04)**

```sql
-- Cư dân (gắn person với vai trò thuê)
CREATE TABLE tenant (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   UUID REFERENCES person(id),
  org_id      UUID REFERENCES organization(id),
  type        TEXT NOT NULL CHECK (type IN ('primary', 'occupant')),
  status      TEXT NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING','APPROVED','REJECTED','MOVED_OUT')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Khách tiềm năng (đặt cọc giữ chỗ — đưa vào MVP theo phản hồi chủ đầu tư)
CREATE TABLE reservation (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID REFERENCES organization(id),
  building_id   UUID REFERENCES building(id),
  apartment_id  UUID REFERENCES apartment(id),
  prospect_name TEXT NOT NULL,
  phone         TEXT NOT NULL,
  hold_amount   BIGINT DEFAULT 0,
  hold_until    DATE,
  status        TEXT NOT NULL DEFAULT 'HELD'
                CHECK (status IN ('HELD','CONVERTED','FORFEITED','REFUNDED','EXPIRED')),
  note          TEXT,
  created_by    UUID REFERENCES app_user(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
```

#### **Nhóm 4: Hợp đồng (M05)**

```sql
-- Hợp đồng thuê
CREATE TABLE contract (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  apartment_id        UUID REFERENCES apartment(id),
  building_id         UUID REFERENCES building(id),
  primary_tenant_id   UUID REFERENCES tenant(id),
  start_date          DATE NOT NULL,
  end_date            DATE NOT NULL,
  rent_amount         BIGINT NOT NULL,
  billing_cycle       TEXT NOT NULL DEFAULT 'monthly',
  billing_day         INTEGER NOT NULL CHECK (billing_day BETWEEN 1 AND 31),
  payment_due_days    INTEGER NOT NULL DEFAULT 5,
  deposit_amount      BIGINT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN (
                        'DRAFT','PENDING_APPROVAL','ACTIVE',
                        'RENEWAL_PENDING','EXPIRED','TERMINATED','CANCELLED'
                      )),
  parent_contract_id  UUID REFERENCES contract(id),
  note                TEXT,
  created_by          UUID REFERENCES app_user(id),
  approved_by         UUID REFERENCES app_user(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  CHECK (end_date > start_date)
);

-- Phiên bản hợp đồng (phụ lục, lịch sử)
CREATE TABLE contract_version (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID REFERENCES contract(id),
  version_no      INTEGER NOT NULL,
  diff            JSONB,
  effective_from  DATE NOT NULL,
  reason          TEXT,
  approved_by     UUID REFERENCES app_user(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Thành viên hộ thuê
CREATE TABLE contract_occupant (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID REFERENCES contract(id),
  tenant_id   UUID REFERENCES tenant(id),
  relationship TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Giá dịch vụ ghi đè theo hợp đồng
CREATE TABLE contract_service_price (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID REFERENCES contract(id),
  service_code    TEXT NOT NULL,
  unit_price      BIGINT NOT NULL,
  effective_from  DATE NOT NULL,
  UNIQUE (contract_id, service_code, effective_from)
);
```

#### **Nhóm 5: Cọc (M06)**

```sql
-- Sổ cọc
CREATE TABLE deposit (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id           UUID REFERENCES contract(id),
  source_reservation_id UUID REFERENCES reservation(id),
  amount_held           BIGINT NOT NULL,
  currency              TEXT DEFAULT 'VND',
  refund_due_date       DATE,
  status                TEXT NOT NULL DEFAULT 'HELD'
                        CHECK (status IN (
                          'HELD','SETTLEMENT_DRAFT','PENDING_APPROVAL',
                          'PARTIALLY_REFUNDED','REFUNDED','TRANSFERRED','DISPUTED'
                        )),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Giao dịch cọc (bất biến sau khi approved)
CREATE TABLE deposit_transaction (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id  UUID REFERENCES deposit(id),
  type        TEXT NOT NULL CHECK (type IN ('collect','deduct','refund','transfer')),
  amount      BIGINT NOT NULL,
  description TEXT,
  evidence    TEXT[] DEFAULT '{}',
  approved_by UUID REFERENCES app_user(id),
  approved_at TIMESTAMPTZ,
  created_by  UUID REFERENCES app_user(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

#### **Nhóm 6: Audit Log & Đính kèm**

```sql
-- Audit log chỉ-ghi-thêm (append only — NFR-010)
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES app_user(id),
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  before      JSONB,
  after       JSONB,
  ip          INET,
  user_agent  TEXT,
  at          TIMESTAMPTZ DEFAULT NOW()
);

-- Đính kèm tệp
CREATE TABLE attachment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_entity  TEXT NOT NULL,
  owner_id      UUID NOT NULL,
  storage_path  TEXT NOT NULL,
  mime          TEXT,
  size_bytes    BIGINT,
  uploaded_by   UUID REFERENCES app_user(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

#### **Nhóm 7: Indexes**

```sql
CREATE INDEX idx_apartment_building_status ON apartment(building_id, status);
CREATE INDEX idx_contract_apartment_status ON contract(apartment_id, status);
CREATE INDEX idx_contract_status_dates ON contract(status, start_date, end_date);
CREATE INDEX idx_deposit_contract ON deposit(contract_id, status);
CREATE INDEX idx_audit_log_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_id, at DESC);
CREATE INDEX idx_person_org_phone ON person(org_id, phone);
```

#### **Nhóm 8: Row Level Security (RLS)**

```sql
-- Bật RLS cho các bảng nhạy cảm
ALTER TABLE building ENABLE ROW LEVEL SECURITY;
ALTER TABLE apartment ENABLE ROW LEVEL SECURITY;
ALTER TABLE person ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_transaction ENABLE ROW LEVEL SECURITY;

-- Ví dụ policy: MANAGER chỉ xem building được gán
CREATE POLICY manager_building_select ON building
  FOR SELECT
  USING (
    id IN (
      SELECT ur.building_id FROM user_role ur
      JOIN app_user au ON au.id = ur.user_id
      WHERE au.auth_uid = auth.uid()
        AND ur.building_id IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM user_role ur
      JOIN role r ON r.id = ur.role_id
      JOIN app_user au ON au.id = ur.user_id
      WHERE au.auth_uid = auth.uid()
        AND r.code IN ('OWNER', 'SYS_ADMIN')
        AND ur.building_id IS NULL
    )
  );

-- RESIDENT chỉ thấy contract của mình
CREATE POLICY resident_contract_select ON contract
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tenant t
      JOIN person p ON p.id = t.person_id
      JOIN app_user au ON au.person_id = p.id
      WHERE au.auth_uid = auth.uid()
        AND t.id = contract.primary_tenant_id
    )
  );
```

---

### 🎨 DESIGN SYSTEM

#### Tailwind Config

```js
// tailwind.config.js
export default {
  content: ['./src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eef2ff', 100: '#e0e7ff',
          500: '#6366f1', 600: '#4f46e5',
          700: '#4338ca', 900: '#312e81',
        },
        surface: {
          DEFAULT: '#ffffff',
          muted: '#f8fafc',
          border: '#e2e8f0',
        },
        status: {
          available: '#10b981',   // xanh lá
          occupied:  '#6366f1',   // indigo
          reserved:  '#f59e0b',   // vàng
          maintenance: '#ef4444', // đỏ
          inactive:  '#94a3b8',   // xám
          draft:     '#94a3b8',
          active:    '#10b981',
          expired:   '#ef4444',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    }
  }
}
```

#### Components cần xây trong Tuần 1

| Component | Mô tả | PRD ref |
|-----------|-------|---------|
| `Button` | primary / secondary / danger + loading | 16.2 |
| `Input` + `FormField` | label + error + hint | 16.2 |
| `StatusBadge` | màu theo trạng thái bất động sản / hợp đồng | 16.5 |
| `DataTable` | sort + filter + phân trang | 16.5 |
| `EmptyState` | giải thích + action button | 16.2 |
| `ConfirmDialog` | 2-step cho hành động nguy hiểm | 16.2 |
| `Money` | format VND: `1.250.000 ₫` (không viết tắt) | 16.1 |
| `AdminLayout` | Sidebar + TopBar + building switcher | 8.2 |

---

### ✅ Task List Tuần 1

#### Ngày 1-2: Setup dự án & Docker
- [ ] Khởi tạo repo Git (`main` + `develop` branch)
- [ ] `npx create-vite@latest frontend -- --template react`
- [ ] Cài packages: `tailwindcss lucide-react chart.js react-chartjs-2 zustand react-router-dom axios`
- [ ] Khởi tạo `api/` với Express + pg + dotenv + cors
- [ ] Viết `docker-compose.yml`: 3 services (`postgres`, `api`, `frontend`)
- [ ] Test: `docker compose up` → cả 3 service healthy

#### Ngày 3-4: Database & Migrations
- [ ] Viết migration files (dùng AI sinh SQL, review kỹ từng bảng)
- [ ] Setup migration runner (`node-pg-migrate` hoặc script SQL tuần tự)
- [ ] Enable extensions: `uuid-ossp`, `btree_gist`
- [ ] Chạy migrate → kiểm tra `\dt` trong psql
- [ ] Enable RLS trên 8 bảng (chưa cần viết policy đầy đủ)

#### Ngày 5-6: Design System & Layout
- [ ] Config `tailwind.config.js` theo design tokens trên
- [ ] Import Google Font Inter
- [ ] Xây primitives: `Button`, `Input`, `FormField`, `StatusBadge`, `Money`
- [ ] Xây `DataTable` với skeleton loading
- [ ] Xây `EmptyState`, `ConfirmDialog`
- [ ] Xây `AdminLayout` với Sidebar + TopBar (nav giả lập)
- [ ] Config React Router v6 (`router/index.jsx`)

#### Ngày 7: Integration cơ bản & Review
- [ ] Frontend gọi `GET /api/health` → hiện "ok" trên màn hình
- [ ] Màn hình Đăng nhập render (chưa có logic)
- [ ] AdminLayout với sidebar mock
- [ ] Review schema vs PRD mục 13.2
- [ ] Commit + push

#### 📦 Deliverable Tuần 1
> ✅ Docker Compose 3 service · ✅ Schema migrate thành công · ✅ Design System sẵn dùng · ✅ Frontend ↔ API kết nối được

---

## 📅 TUẦN 2: AUTH OTP + RBAC/RLS + KHUNG ADMIN
> **Ngày 8–14** | Mục tiêu: Đăng nhập hoạt động, phân quyền đúng, khung Admin đầy đủ

### 🔐 Luồng Auth (FR-001, FR-002, FR-003)

#### OTP Flow

```
POST /api/v1/auth/otp/request
  Body: { phone }
  → Rate limit: 3 lần/giờ/SĐT + 10 lần/phút/IP
  → Sinh OTP 6 số, TTL 5 phút
  → Dev: log console (mock) | Prod: gọi SMS provider
  → Response: { message: "OTP đã được gửi" }  ← thông điệp trung lập

POST /api/v1/auth/otp/verify
  Body: { phone, otp }
  → Kiểm tra OTP + TTL + max 5 lần thử (lock 15 phút nếu sai)
  → Nếu đúng: tạo JWT (15 phút) + refresh token (7 ngày RESIDENT, 30 phút ACCOUNTANT)
  → Response: { accessToken, refreshToken, user }

POST /api/v1/auth/login       ← email/password cho nhân sự nội bộ
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
```

#### JWT Payload

```json
{
  "sub": "<app_user.id>",
  "person_id": "<uuid>",
  "org_id": "<uuid>",
  "roles": [
    { "code": "MANAGER", "building_id": "<uuid>" }
  ],
  "exp": 1234567890
}
```

#### RBAC Middleware

```js
// api/src/middleware/rbac.js
export function requireRole(allowedRoles) {
  return (req, res, next) => {
    const hasRole = req.user.roles.some(r => allowedRoles.includes(r.code));
    if (!hasRole) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        message: 'Bạn không có quyền thực hiện thao tác này.'
      });
    }
    next();
  };
}
```

### 🏠 Navigation theo vai trò

```js
// constants/navigation.js
export const NAV_ITEMS = {
  OWNER:      ['Dashboard', 'Bất động sản', 'Hợp đồng', 'Báo cáo'],
  MANAGER:    ['Dashboard', 'Bất động sản', 'Cư dân', 'Hợp đồng', 'Yêu cầu', 'Truyền thông'],
  ACCOUNTANT: ['Dashboard', 'Hóa đơn', 'Thanh toán', 'Cọc', 'Công nợ'],
  STAFF:      ['Việc hôm nay', 'Work Order', 'Ghi chỉ số'],
};
```

### 🔒 RLS Policies cần viết & test

| Bảng | Rule |
|------|------|
| `building` | OWNER/SYS_ADMIN: toàn bộ; MANAGER/STAFF/ACCOUNTANT: theo user_role.building_id |
| `apartment` | Kế thừa building scope |
| `person` | MANAGER: đầy đủ; STAFF: chỉ name+phone; RESIDENT: chỉ của mình |
| `contract` | MANAGER: theo tòa; RESIDENT: của mình |
| `deposit` | ACCOUNTANT + OWNER + MANAGER theo tòa |

**Test RLS bắt buộc (NFR-008):**
```sql
-- Với session của RESIDENT căn A101
SELECT * FROM contract;                           -- chỉ thấy HĐ của mình
SELECT * FROM contract WHERE id = '<hd_khac>';   -- trả về empty (không phải 403)
```

### ✅ Task List Tuần 2

#### Ngày 8-9: Backend Auth (M02)
- [ ] Cài: `jsonwebtoken`, `bcryptjs`, `express-rate-limit`, `ioredis`
- [ ] Viết `POST /auth/otp/request` (Mock OTP console, rate limit 3 lần/giờ/SĐT, thông điệp trung lập chống leak số điện thoại - AC-001.3)
- [ ] Viết `POST /auth/otp/verify` (Kiểm tra OTP, max 5 lần thử sai → khóa 15 phút kèm countdown - AC-001.2, cấp JWT + refresh token)
- [ ] Viết `POST /auth/login` (Email/mật khẩu bcrypt >= 8 ký tự cho nhân sự nội bộ)
- [ ] Viết `POST /auth/refresh` + `POST /auth/logout` (Thu hồi refresh token)
- [ ] Middleware `auth.js` (Verify JWT → gán `req.user`, TTL: Access 15m, Refresh 7d, riêng ACCOUNTANT 30m - NFR-008)
- [ ] Middleware `rbac.js` (`requireRole` kiểm tra quyền theo module và tòa nhà được gán)

#### Ngày 10-11: Frontend Auth & Khung Admin
- [ ] Trang `/login`: 2 tab rõ ràng (Tab "Cư dân & Nhân viên" đăng nhập OTP SĐT, Tab "Nhân sự nội bộ" đăng nhập Email/Mật khẩu)
- [ ] Auto-focus 6 ô nhập mã OTP + countdown đếm ngược 5 phút + nút gửi lại sau 60s
- [ ] Điều hướng sau đăng nhập: RESIDENT → `/resident/apartment`, SYS_ADMIN → `/admin/buildings`, MANAGER/ACCOUNTANT/OWNER → `/admin/dashboard`
- [ ] Zustand `authStore`: `{ user, tokens, login(), logout(), refresh() }`
- [ ] Axios instance với interceptor gắn Bearer + tự động gọi refresh khi gặp lỗi 401
- [ ] Protected Route (redirect về `/login` nếu chưa xác thực hoặc token hết hạn)
- [ ] Sidebar phân quyền động theo Role từ JWT (Chỉ hiện menu người dùng có quyền xem)

#### Ngày 12-13: RLS + Seed Data & Security
- [ ] Seed script: 1 org, 6 roles, đủ test users (`SYS_ADMIN`, `OWNER`, `MANAGER`, `ACCOUNTANT`, `STAFF`, `RESIDENT`)
- [ ] Thiết lập Row-Level Security (RLS) trên PostgreSQL cho các bảng lõi (`building`, `apartment`, `contract`, `deposit`, `person`)
- [ ] Viết SQL test script, chạy verify từng policy: Đảm bảo zero data leak giữa các tổ chức và giữa các tòa nhà khác nhau
- [ ] Kiểm tra cách ly dữ liệu cư dân: Cư dân căn A không thể query hay thấy hợp đồng/căn hộ của cư dân căn B

#### Ngày 14: Integration & Review Tuần 2
- [ ] E2E Test: Đăng nhập OTP → Redirect đúng trang chủ của vai trò → Gọi API được bảo vệ → 200 OK
- [ ] Test 403: Role không đủ quyền hoặc truy cập sai tòa nhà → Chặn 403 Forbidden và ghi audit_log cảnh báo
- [ ] Audit trigger tự động ghi nhận mọi sự kiện thêm/sửa trên bảng `app_user`
- [ ] Code review kiến trúc thư mục, chuẩn hóa mã lỗi HTTP RESTful

#### 📦 Deliverable Tuần 2
> ✅ OTP mock login + Khóa 15m sau 5 lần sai · ✅ Đăng nhập email nội bộ · ✅ JWT + Refresh token chuẩn TTL · ✅ Sidebar render theo Role · ✅ RLS phân quyền DB đạt chuẩn zero leak · ✅ Đủ 6 tài khoản kiểm thử seed sẵn

---

## 📅 TUẦN 3: MODULE BẤT ĐỘNG SẢN (M03) + CƯ DÂN (M04)
> **Ngày 15–21** | Mục tiêu: CRUD tòa/tầng/căn hộ + sơ đồ tầng + hồ sơ cư dân + cọc giữ chỗ

### 🏢 M03 — API Endpoints
```
GET    /api/v1/buildings                    → Danh sách tòa nhà (lọc theo quyền)
POST   /api/v1/buildings                    → Tạo tòa nhà mới (SYS_ADMIN, OWNER)
GET    /api/v1/buildings/check-code         → Kiểm tra mã tòa khả dụng real-time
PATCH  /api/v1/buildings/:id                → Cập nhật thông tin tòa nhà
PATCH  /api/v1/buildings/:id/status         → Đổi trạng thái ACTIVE/INACTIVE (Chặn nếu có HĐ ACTIVE)
GET    /api/v1/buildings/:id/floors         → Danh sách tầng (ORDER BY level ASC/DESC)
POST   /api/v1/buildings/:id/floors         → Tạo tầng (level INTEGER, hỗ trợ hầm/trệt)
GET    /api/v1/buildings/:id/apartments     → Danh sách căn (?status=&floor_id=)
POST   /api/v1/buildings/:id/apartments     → Tạo căn hộ (base_rent BIGINT VND)
PATCH  /api/v1/apartments/:id               → Cập nhật căn (Cảnh báo khi sửa diện tích căn OCCUPIED)
GET    /api/v1/buildings/:id/floor-map      → Lưới sơ đồ tầng [{floor, apartments:[{id,code,status}]}]
```

### 🏢 M03 — Sơ đồ tầng (FR-010)
```
Tab "Sơ đồ tầng" trong trang Quản lý Bất động sản:

TẦNG 3  [ A301 🟢 ] [ A302 🔵 ] [ A303 🟡 ] [ A304 🔵 ]
TẦNG 2  [ A201 🟢 ] [ A202 🔵 ] [ A203 🟢 ] [ A204 ⚫ ]
TẦNG 1  [ A101 🔵 ] [ A102 🔵 ] [ A103 🟢 ] [ A104 🔴 ]

5 màu trạng thái chuẩn:
🟢 Có sẵn (AVAILABLE)     🔵 Đang thuê (OCCUPIED)     🟡 Đã cọc giữ chỗ (RESERVED)
🔴 Đang bảo trì (MAINTENANCE)                         ⚫ Tạm ngừng KD (INACTIVE)

→ Click vào ô căn hộ: mở slide-over panel xem nhanh thông tin, tiền thuê, tiện ích và lịch sử audit
```

### 👤 M04 — API Endpoints
```
GET    /api/v1/tenants                      → Danh sách cư dân (theo phạm vi tòa)
POST   /api/v1/tenants                      → Tạo hồ sơ cư dân mới
GET    /api/v1/tenants/:id                  → Chi tiết cư dân (che CCCD với STAFF)
PATCH  /api/v1/tenants/:id                  → Cập nhật hồ sơ cư dân
GET    /api/v1/tenants/check-dup            → Kiểm tra trùng SĐT/CCCD real-time (FR-021)
POST   /api/v1/tenants/:id/merge            → Hợp nhất 2 hồ sơ trùng + ghi vết audit

POST   /api/v1/reservations                 → Đặt cọc giữ chỗ (căn chuyển RESERVED)
PATCH  /api/v1/reservations/:id/convert     → Chuyển tiền giữ chỗ sang cọc hợp đồng khi ký HĐ
PATCH  /api/v1/reservations/:id/forfeit     → Khách hủy, mất tiền giữ chỗ (yêu cầu duyệt Four-eyes)
PATCH  /api/v1/reservations/:id/refund      → Hoàn tiền giữ chỗ cho khách (yêu cầu duyệt Four-eyes)
```

### 👤 M04 — Duplicate Check (FR-021)
```
Khi nhập SĐT hoặc CCCD trên form tạo cư dân:
→ Real-time check: GET /api/v1/tenants/check-dup?phone=...&id_number=...
→ Nếu phát hiện trùng lặp: hiển thị banner cảnh báo màu vàng kèm thông tin hồ sơ hiện có
→ Người quản trị chọn 1 trong 3 hành động:
   (A) Dùng hồ sơ đã có: Không tạo mới, tái sử dụng định danh
   (B) Tạo mới có chủ đích: Bắt buộc nhập lý do vào ô text → ghi nhận vào audit_log
   (C) Hợp nhất hồ sơ (Merge): Mở dialog so sánh từng trường dữ liệu, hợp nhất và lưu vết
```

### ✅ Task List Tuần 3

#### Ngày 15-16: M03 Backend (Tòa nhà, Tầng, Căn hộ)
- [ ] Viết Controller + Service cho buildings, floors, apartments
- [ ] Triển khai `GET /api/v1/buildings/check-code` (kiểm tra unique code theo tổ chức)
- [ ] Triển khai `PATCH /api/v1/buildings/:id/status` kèm ràng buộc chặn INACTIVE nếu tồn tại hợp đồng `ACTIVE` (NFR-016)
- [ ] Xử lý tầng: Ràng buộc `UNIQUE(building_id, level)`, `level` kiểu `INTEGER` (hỗ trợ hầm B1/B2 level < 0 và trệt level = 0), chặn xóa tầng nếu còn căn hộ
- [ ] Xử lý căn hộ: Validate `base_rent` là `BIGINT` VND (không dùng float), `code` duy nhất theo tòa
- [ ] API `GET /api/v1/buildings/:id/floor-map` nhóm căn hộ theo tầng phục vụ giao diện sơ đồ
- [ ] Audit trigger tự động ghi log cho mọi thao tác thêm/sửa/đổi trạng thái tòa nhà và căn hộ

#### Ngày 17-18: M03 Frontend (Quản lý Bất động sản & Sơ đồ tầng)
- [ ] Trang danh sách Tòa nhà (Card grid & DataTable, tìm kiếm mã/tên, lọc theo trạng thái)
- [ ] Form tạo/sửa Tòa nhà (Drawer): Real-time check mã tòa khi blur, cấu hình tài khoản nhận tiền (FR-070)
- [ ] Onboarding Banner: Hiển thị checklist cấu hình màu vàng khi tòa chưa có tầng hoặc căn hộ
- [ ] Modal thêm Tầng: Nhập level và tên tầng, tự động gợi ý level kế tiếp, thêm liên tiếp không reload
- [ ] Drawer tạo Căn hộ: Chọn tầng, diện tích m², tiện ích, định dạng tiền tệ tự động với dấu phân cách
- [ ] Interactive Floor Map (FR-010): Hiển thị lưới căn hộ theo tầng với 5 màu trạng thái chuẩn, bộ lọc nhanh theo tầng & trạng thái
- [ ] Slide-over panel chi tiết căn hộ: Xem nhanh cư dân đang thuê, giá thuê, tiện ích, cảnh báo khi sửa diện tích căn `OCCUPIED`

#### Ngày 19-20: M04 Backend & Frontend (Cư dân & Cọc giữ chỗ)
- [ ] Backend Tenants: CRUD hồ sơ, mã hóa CCCD trong DB, ẩn CCCD đối với vai trò STAFF (PRD 6.2)
- [ ] Backend Duplicate Check: API `check-dup` và luồng gộp hồ sơ `merge` ghi rõ before/after audit
- [ ] Backend Reservations: CRUD đặt cọc giữ chỗ, chuyển cọc `convert`, hủy mất cọc `forfeit`, hoàn cọc `refund` kèm duyệt Four-eyes
- [ ] Cron job tự động quét và chuyển trạng thái cọc giữ chỗ sang `EXPIRED`, trả phòng về `AVAILABLE` khi quá hạn `hold_until`
- [ ] Frontend Tenants: Danh sách cư dân (tìm kiếm theo tên, SĐT, mã phòng)
- [ ] Frontend Tenant Form: Tích hợp check trùng SĐT/CCCD real-time với debounce 400ms, hiển thị banner cảnh báo và 3 nút lựa chọn
- [ ] Frontend Reservation: Drawer đặt cọc giữ chỗ ngay từ căn hộ `AVAILABLE` trên Floor Map

#### Ngày 21: Test & Integration Tuần 3
- [ ] E2E Test: Tạo tòa nhà → Thêm tầng → Tạo căn hộ → Căn hộ hiển thị đúng màu trên Floor Map
- [ ] Test Đặt cọc giữ chỗ: Căn chuyển sang màu vàng `RESERVED` → Hết hạn trả về xanh `AVAILABLE`
- [ ] Test trùng cư dân: Nhập SĐT trùng → Hiện cảnh báo tức thì, kiểm tra luồng Merge hồ sơ
- [ ] Test RLS & Security: MANAGER của tòa A tuyệt đối không xem được danh sách căn hộ hay cư dân của tòa B
- [ ] Kiểm thử Responsive: Giao diện Sơ đồ tầng hiển thị chuẩn trên màn hình Tablet (1024px) và Laptop

#### 📦 Deliverable Tuần 3
> ✅ Quản lý Tòa/Tầng/Căn hộ đầy đủ ràng buộc · ✅ Interactive Floor Map 5 màu trạng thái · ✅ Onboarding banner hướng dẫn hoàn thiện cấu hình · ✅ Hồ sơ cư dân + Duplicate Check thời gian thực · ✅ Đặt cọc giữ chỗ (Reservation) tự động hoàn/hết hạn · ✅ Bảo mật PII và phân quyền RLS chuẩn xác

---

## 📅 TUẦN 4: MODULE HỢP ĐỒNG (M05) + CỌC (M06)
> **Ngày 22–28** | Mục tiêu: Luồng hợp đồng đầy đủ + sổ cọc + cổng cư dân cơ bản

### 📝 Business Rules quan trọng nhất (đọc kỹ PRD 10.2 trước khi code)

```
Rule 1 — Chống chồng lấn kỳ thuê (FR-014)
→ Check ở API + ở DB (exclusion constraint với btree_gist)
→ Cùng apartment_id không được có 2 HĐ ACTIVE chồng daterange

Rule 2 — Luồng trạng thái
DRAFT → PENDING_APPROVAL → ACTIVE → RENEWAL_PENDING → EXPIRED/TERMINATED

Rule 3 — Đồng bộ trạng thái căn hộ
→ HĐ ACTIVE: apartment.status = OCCUPIED
→ HĐ TERMINATED + bàn giao: apartment.status = AVAILABLE

Rule 4 — billing_day (quan trọng)
→ Ngày trong tháng để chốt kỳ, khác nhau TỪNG HĐ (không phải toàn tòa)
→ Tuần 5 sẽ dùng để sinh hóa đơn tự động

Rule 5 — Cọc KHÔNG cấn trừ vào tiền thuê
→ Khấu trừ chỉ khi: hư hỏng / vi phạm / chi phí khác
→ Bắt buộc: evidence + lý do + approve của APPROVER
→ Hoàn cọc: 3-5 ngày sau TERMINATED + bàn giao + hóa đơn cuối

Rule 6 — Four-eyes
→ Người tạo HĐ ≠ người activate/approve
→ Người tạo quyết toán cọc ≠ người approve hoàn cọc
```

### 📝 M05 — API Endpoints

```
GET    /api/v1/contracts                      → Danh sách
POST   /api/v1/contracts                      → Tạo (DRAFT)
GET    /api/v1/contracts/:id
PATCH  /api/v1/contracts/:id                  → Sửa (chỉ khi DRAFT)

POST   /api/v1/contracts/:id/activate         → Upload ký → ACTIVE
POST   /api/v1/contracts/:id/renew            → Tạo HĐ gia hạn
POST   /api/v1/contracts/:id/terminate        → Yêu cầu chấm dứt
POST   /api/v1/contracts/:id/terminate/approve → Duyệt (MANAGER)

GET    /api/v1/contracts/expiring             → ?days=30 (HĐ sắp hết hạn)
```

### 📝 M05 — Wizard Tạo Hợp Đồng (3 bước)

```
Bước 1 — Căn hộ & Cư dân
  • Chọn căn hộ (chỉ AVAILABLE | RESERVED)
  • Tìm/chọn cư dân chính (primary tenant)
  • Thêm thành viên hộ (occupants + relationship)

Bước 2 — Điều khoản
  • Ngày bắt đầu / kết thúc (end > start)
  • Tiền thuê [cảnh báo nếu < X% giá niêm yết → require approve]
  • billing_day (1-31, ngày chốt kỳ)
  • payment_due_days (số ngày ân hạn sau billing_day)
  • Tiền cọc

Bước 3 — Dịch vụ & Xem trước
  • Chọn dịch vụ đi kèm (điện, nước, gửi xe, v.v.)
  • Ghi đè đơn giá dịch vụ theo HĐ này (nếu khác giá tòa)
  • Preview bảng tóm tắt đầy đủ
  • Lưu DRAFT

→ Sau đó: upload file HĐ đã ký → Activate
```

### 💰 M06 — API Endpoints

```
POST   /api/v1/deposits                        → Thu cọc
GET    /api/v1/contracts/:id/deposit           → Cọc của HĐ
GET    /api/v1/deposits/:id

POST   /api/v1/deposits/:id/transactions       → Ghi deduct / refund
POST   /api/v1/deposits/:id/settlement         → Tạo bảng quyết toán (DRAFT)
POST   /api/v1/deposits/:id/settlement/approve → Duyệt hoàn cọc (APPROVER)
POST   /api/v1/deposits/:id/settlement/reject  → Từ chối + lý do bắt buộc
```

### ✅ Task List Tuần 4

#### Ngày 22-23: M05 Backend
- [ ] Bật `btree_gist`, thêm exclusion constraint vào contract
- [ ] `POST /contracts` + check chồng lấn (API + DB)
- [ ] `POST /contracts/:id/activate` (upload → ACTIVE → apartment OCCUPIED)
- [ ] `POST /contracts/:id/renew` (contract mới nối tiếp)
- [ ] `POST /contracts/:id/terminate` + `/approve`
- [ ] `GET /contracts/expiring?days=30`
- [ ] Audit trigger cho contract

#### Ngày 24: M06 Backend
- [ ] `POST /deposits` (thu cọc)
- [ ] `POST /deposits/:id/transactions` (deduct: cần evidence + approve)
- [ ] `POST /deposits/:id/settlement` (DRAFT)
- [ ] `POST /deposits/:id/settlement/approve` + `/reject`
- [ ] Validation: deduct > held → số hoàn = 0, thiếu = receivable

#### Ngày 25-26: M05 + M06 Frontend
- [ ] Wizard tạo HĐ 3 bước (stepper UI)
- [ ] Danh sách HĐ: filter status/tòa/tháng hết hạn
- [ ] Chi tiết HĐ: 4 tab (Thông tin | Cọc | Lịch sử | Đính kèm)
- [ ] Banner cảnh báo HĐ sắp hết hạn (30/60 ngày) trên Dashboard
- [ ] Màn hình Sổ cọc với lịch sử giao dịch
- [ ] Form ghi khấu trừ (evidence upload + lý do)
- [ ] Form quyết toán hoàn cọc (bảng kê từng khoản)

#### Ngày 27: Cổng cư dân (Resident Portal — cơ bản)
- [ ] Layout mobile-first: bottom navigation bar (< 640px)
- [ ] `/resident/apartment`: thông tin căn hộ
- [ ] `/resident/contract`: HĐ hiệu lực + lịch sử
- [ ] `/resident/deposit`: sổ cọc (read-only)
- [ ] Protected routes: chỉ RESIDENT vào được `/resident/*`

#### Ngày 28: Acceptance Test
- [ ] Test E2E luồng đầy đủ: Tạo HĐ → Activate → Thu cọc → Terminate → Quyết toán
- [ ] Test chống chồng lấn: 2 HĐ cùng căn cùng kỳ → error đúng
- [ ] Test four-eyes: người tạo tự approve → 403
- [ ] Test RLS: RESIDENT chỉ thấy HĐ/cọc của mình
- [ ] Test mobile 375px: cổng cư dân
- [ ] Ghi Sprint Retrospective doc

#### 📦 Deliverable Tuần 4
> ✅ Wizard tạo HĐ · ✅ Chống chồng lấn · ✅ Sổ cọc + quyết toán · ✅ Cổng cư dân mobile

---

## ✅ TIÊU CHÍ ĐÁNH GIÁ GIAI ĐOẠN 1 (Definition of Done)

| ID | Tiêu chí | Cách kiểm tra | Bắt buộc |
|----|---------|---------------|----------|
| AC-1.1 | Docker Compose 3 service chạy không lỗi | `docker compose ps` | ✅ |
| AC-1.2 | Đăng nhập OTP mock → nhận JWT hợp lệ | Postman flow | ✅ |
| AC-1.3 | Sidebar đúng nav items theo 4 role | Đăng nhập lần lượt | ✅ |
| AC-1.4 | MANAGER tòa A không thấy dữ liệu tòa B | SQL test + API test | ✅ |
| AC-1.5 | RESIDENT chỉ thấy HĐ/cọc của mình | Direct API call | ✅ |
| AC-1.6 | Tạo cây dữ liệu: Tòa→Tầng→Căn→Cư dân→HĐ→Cọc | Demo flow | ✅ |
| AC-1.7 | Chống chồng lấn kỳ thuê | Tạo 2 HĐ trùng → error | ✅ |
| AC-1.8 | Audit log ghi đúng CREATE/UPDATE | SELECT audit_log | ✅ |
| AC-1.9 | Duplicate check SĐT cảnh báo đúng | Form tạo cư dân | ✅ |
| AC-1.10 | Cổng cư dân render đúng 375px | Chrome DevTools | ✅ |
| AC-1.11 | Tiền lưu BIGINT, không float | SELECT typeof | ✅ |
| AC-1.12 | Four-eyes: người tạo không tự approve | API test → 403 | ✅ |

### Điểm chặn (Hard Stop — phải đạt 100%)

- [ ] **Security:** Không có RLS bypass
- [ ] **Business Logic:** Cọc không cấn trừ vào tiền thuê (chỉ khấu trừ khi có approve)
- [ ] **Data Integrity:** Tiền = BIGINT VND, không có float
- [ ] **Four-eyes:** Luật người tạo ≠ người duyệt được enforce

---

## 📊 BÁO CÁO KỸ THUẬT CUỐI GIAI ĐOẠN 1

Nộp 1 document ngắn gồm:

1. **ERD (Entity Relationship Diagram)** — dùng [dbdiagram.io](https://dbdiagram.io) hoặc Mermaid
2. **Danh sách API endpoints đã chốt** (~30 endpoints)
3. **RLS policies đã viết + kết quả test**
4. **Lỗi AI thường gặp khi Vibe Coding:**
   - Prompt nào AI sinh sai business logic?
   - Phần nào phải sửa thủ công nhiều nhất?
   - Lỗi RLS nào khó debug nhất?

---

## 🗒️ LƯU Ý & ANTI-PATTERNS CẦN TRÁNH

### Câu hỏi cần hỏi TRƯỚC khi code

| # | Câu hỏi | Cần trước |
|---|---------|-----------|
| Q1 | Nhà cung cấp SMS OTP là ai? | Tuần 2 |
| Q2 | Server VN là nhà cung cấp nào? | Tuần 1 |
| Q3 | Pro-rata: ngày thực hay mẫu số 30? | Tuần 3 |
| Q4 | Phí phạt 100k/ngày có trần không? | Tuần 3 |
| Q5 | Dịch vụ chung: theo người hay theo phòng? | Tuần 3 |

### Anti-patterns

```
❌ Lưu tiền bằng float
✅ BIGINT đơn vị VND (6500000, không phải 6500000.00)

❌ Chỉ check quyền ở Frontend (ẩn UI)
✅ Check ở API middleware VÀ RLS PostgreSQL (double check)

❌ Xóa cứng bản ghi nghiệp vụ
✅ Chuyển status (VOID, CANCELLED, INACTIVE) — NFR-016

❌ Hard-code business rules
✅ Lưu vào DB config (phí phạt 100k, ân hạn 5 ngày)

❌ OTP trong response body
✅ Chỉ log server console (không bao giờ trong API response)

❌ Để AI tự quyết định business logic tài chính
✅ Đọc PRD mục 10.2 → viết spec → AI implement → review kỹ
```

---

*Tài liệu tổng hợp từ PRD v0.2 (18/09/2026) + Roadmap Frontend Developer (Hiệp) + tech stack đã chốt. Cập nhật: 2026-10-14.*

---

---

# 📖 PHẦN II — QUY TRÌNH NGHIỆP VỤ CHI TIẾT (GIAI ĐOẠN 1)

> Mỗi quy trình được mô tả đủ 6 góc độ: **Ai làm · UI Steps · API · DB · Validation · Test Cases**  
> Tuân thủ 100% các quyết định nghiệp vụ đã chốt trong PRD v0.2:
> - Tiền cọc chuẩn **1 tháng tiền thuê**, **KHÔNG ĐƯỢC CẤN TRỪ VÀO TIỀN THUÊ**.
> - Hoàn cọc trong **3–5 ngày làm việc** sau khi chấm dứt hợp đồng.
> - Bảng giá dịch vụ **ghi đè theo từng hợp đồng (FR-065)**: Ưu tiên Giá HĐ → Giá Tòa → Giá mặc định.
> - Ngày chốt kỳ (`billing_day`) **nằm ở từng hợp đồng (FR-066)**, job sinh hóa đơn chạy hằng ngày.
> - Phí phạt chậm thanh toán **100.000 ₫/ngày sau 5 ngày quá hạn (FR-064)**.
> - Cơ chế **Four-eyes (Người lập ≠ Người duyệt)** bật mặc định cho các phê duyệt tài chính và hợp đồng.
> - Toàn bộ dữ liệu tiền tệ lưu trữ bằng **BIGINT đơn vị VND**, không xóa cứng dữ liệu (NFR-016).

---

## NV-01 — ĐĂNG NHẬP OTP (Cư dân & Nhân viên qua SĐT)
> **FR-001, FR-002, US-001, AC-001.1..AC-001.3** · Actor: Tất cả · Module: M02

### Luồng tổng quan
```
Người dùng nhập SĐT  →  Hệ thống gửi OTP (Dev: log console | Prod: SMS Gateway)
     →  Nhập OTP 6 số  →  Nhận JWT Access Token (15 phút) + Refresh Token
     →  Redirect vào ứng dụng theo đúng vai trò (Role-based Routing)
```

### UI Steps
```
Bước 1 — Trang /login
  [Logo ResiHub]
  Tab: [ Đăng nhập SĐT (Cư dân & NV) ] | [ Email / Mật khẩu (Nội bộ) ]
  Nhập số điện thoại: [ 09xxxxxxxx    ]
                      [ Gửi mã OTP   ] ← button

Bước 2 — Màn hình nhập OTP (hoặc popup)
  Đã gửi mã xác thực OTP đến số điện thoại 09xx xxxx xx
  Nhập mã 6 số:  [ _ _ _ _ _ _ ]   ← auto-focus từng ô, tự động submit khi đủ 6 số
  Còn hiệu lực:  04:32             ← countdown 5 phút
  [Xác nhận đăng nhập]   [Gửi lại mã sau 60s]

Bước 3 — Đăng nhập thành công & Điều hướng theo vai trò (Role-based Redirect)
  → RESIDENT (Cư dân)               : /resident/apartment
  → OWNER (Chủ đầu tư)              : /admin/dashboard
  → MANAGER (Quản lý tòa nhà)       : /admin/dashboard
  → ACCOUNTANT (Kế toán)            : /admin/dashboard
  → STAFF (Kỹ thuật / Vận hành)     : /admin/dashboard
  → SYS_ADMIN (Quản trị hệ thống)   : /admin/buildings
```

### API Flow
```
POST /api/v1/auth/otp/request
  Body: { "phone": "0901234567" }
  Rate limit: 10 req/phút/IP (chặn DDoS) + 3 req/giờ/SĐT (tiết kiệm chi phí SMS)
  Dev: log OTP ra server console  |  Prod: gọi SMS provider VN
  Response: { "message": "Mã xác thực OTP đã được gửi đến số điện thoại của bạn." }
  ⚠️ QUY TẮC AN NINH (AC-001.3): Nếu SĐT chưa có trong hệ thống, VẪN TRẢ VỀ THÔNG ĐIỆP NHƯ TRÊN
  (Thông báo trung lập, không tiết lộ SĐT có tồn tại hay không để chống brute-force thu thập SĐT).

POST /api/v1/auth/otp/verify
  Body: { "phone": "0901234567", "otp": "123456" }
  → Kiểm tra số lần thử sai: Sai 1 lần tăng counter; Sai 5 lần liên tiếp → Khóa đăng nhập 15 phút
  → Kiểm tra thời hạn OTP: Hết hạn sau 5 phút (TTL)
  Response 200: {
    "accessToken": "...",     // TTL: 15 phút
    "refreshToken": "...",    // TTL: 7 ngày (riêng ACCOUNTANT 30 phút theo NFR-008)
    "user": { id, phone, full_name, org_id, roles: [{ code, name, building_id }] }
  }
  Response 401: { "code": "OTP_INVALID", "message": "Mã OTP không đúng. Bạn còn X lần thử." }
  Response 429: { "code": "TOO_MANY_ATTEMPTS", "message": "Bạn đã nhập sai 5 lần. Vui lòng thử lại sau 15 phút." }

POST /api/v1/auth/refresh
  Body: { "refreshToken": "..." }
  Response: { "accessToken": "..." }

POST /api/v1/auth/logout
  Header: Authorization: Bearer <token>
  → Thu hồi Refresh Token trên server
```

### Validation & Business Rules
```
SĐT:
  ✅ Đúng định dạng số điện thoại Việt Nam: 10 chữ số, bắt đầu bằng 0 hoặc +84
  ✅ Tự động chuẩn hóa về định dạng 09xxxxxxxx khi lưu và so khớp
  ❌ SĐT chứa chữ cái hoặc ký tự đặc biệt → báo lỗi ngay tại client

OTP:
  ✅ Bắt buộc đủ 6 chữ số
  ✅ Còn hiệu lực trong vòng 5 phút (300 giây)
  ✅ Khớp chính xác với mã lưu trong bộ nhớ/DB cho SĐT tương ứng
  ❌ Hết 5 lần sai → Khóa 15 phút, hiển thị đồng hồ đếm ngược chờ mở khóa
```

### Test Cases
```
TC-NV01-01: Nhập SĐT hợp lệ và OTP đúng → Đăng nhập thành công, nhận JWT, redirect đúng role.
TC-NV01-02: Nhập sai OTP lần 1 đến lần 4 → Thông báo rõ số lần thử còn lại.
TC-NV01-03: Nhập sai OTP lần 5 → Bị khóa tài khoản 15 phút, gọi API tiếp nhận HTTP 429.
TC-NV01-04: Nhập OTP khi đã quá 5 phút → Báo mã đã hết hạn, yêu cầu gửi lại.
TC-NV01-05: Gửi yêu cầu OTP quá 3 lần/giờ trên 1 SĐT → HTTP 429 Too Many Requests.
TC-NV01-06: Gửi yêu cầu OTP với SĐT không tồn tại → Vẫn trả thông báo thành công (chống dò số điện thoại).
```

---

## NV-02 — ĐĂNG NHẬP EMAIL/MẬT KHẨU (Nhân viên nội bộ)
> **FR-003** · Actor: SYS_ADMIN, OWNER, MANAGER, ACCOUNTANT, STAFF · Module: M02

### Luồng tổng quan
```
/login → Tab "Nhân viên nội bộ" → Nhập Email + Mật khẩu → Xác thực Bcrypt → Nhận JWT
```

### UI Steps
```
Tại /login:
  Tab: [ Email / Mật khẩu (Nội bộ) ]
  Email công vụ: [ manager@resihub.vn ]
  Mật khẩu:      [ ••••••••••••••     ] 👁️ (nút ẩn/hiện mật khẩu)
  [Đăng nhập hệ thống]
```

### API Flow
```
POST /api/v1/auth/login
  Body: { "email": "manager@resihub.vn", "password": "password123" }
  → Tìm user theo email trong bảng person và app_user
  → Kiểm tra app_user.status: Nếu SUSPENDED → Trả HTTP 403 "Tài khoản đã bị tạm khóa"
  → So sánh mật khẩu bằng bcrypt.compare
  → Ghi nhận last_login_at = NOW()
  Response 200: {
    "accessToken": "...",
    "refreshToken": "...",
    "user": { id, email, full_name, roles }
  }
  Response 401: { "code": "INVALID_CREDENTIALS", "message": "Email hoặc mật khẩu không chính xác." }
  Response 403: { "code": "ACCOUNT_SUSPENDED", "message": "Tài khoản của bạn đang bị tạm khóa. Vui lòng liên hệ Quản trị viên." }
```

### Validation & Business Rules
```
Email:
  ✅ Định dạng email hợp lệ RFC 5322
  ✅ Tự động trim khoảng trắng và chuyển chữ thường (lowercase)
Mật khẩu:
  ✅ Tối thiểu 8 ký tự
Tài khoản:
  ✅ app_user.status phải là ACTIVE. Không cho phép đăng nhập nếu SUSPENDED.
```

### Test Cases
```
TC-NV02-01: Đăng nhập email và mật khẩu đúng → Thành công, nhận Access Token (15m) và Refresh Token.
TC-NV02-02: Nhập sai mật khẩu → HTTP 401 INVALID_CREDENTIALS.
TC-NV02-03: Đăng nhập tài khoản có status = SUSPENDED → HTTP 403 ACCOUNT_SUSPENDED.
TC-NV02-04: Mật khẩu dưới 8 ký tự → Báo lỗi client-side không gửi request.
```

---

## NV-03 — TẠO TÒA NHÀ MỚI
> **FR-007, FR-070** · Actor: SYS_ADMIN, OWNER · Module: M03  
> *(Xem tài liệu kỹ thuật đầy đủ: Quy_Trinh_Tao_Toa_Nha.md)*

### Luồng tổng quan
```
/admin/buildings → [+ Thêm tòa nhà mới] → Drawer/Modal form
→ Real-time check mã tòa (Blur) → Submit form → INSERT building + audit_log
→ Hiển thị tòa mới ở trạng thái ACTIVE kèm Checklist "Hoàn thiện cấu hình"
```

### UI Steps
```
Bước 1 — Tại trang /admin/buildings:
  Click [+ Thêm tòa nhà mới] (Chỉ hiển thị với SYS_ADMIN và OWNER).

Bước 2 — Drawer / Modal tạo tòa:
  Thông tin cơ bản:
    • Tên tòa nhà (*):           [ Tòa Landmark 81 - Vinhomes         ] (2–100 ký tự)
    • Mã tòa (Code) (*):         [ TN-VINHOMES                        ] (A-Z, 0-9, dấu -)
      Phản hồi kiểm tra mã:      [ ✅ Mã tòa chưa được dùng (Hợp lệ)  ] ← Real-time on blur
    • Địa chỉ:                   [ 720A Điện Biên Phủ, Bình Thạnh     ]
    • Chủ sở hữu tòa (nếu thuê): [ Chọn từ danh sách owner ▼         ] (FR-070 đa chủ sở hữu)
    • Múi giờ vận hành:          [ Asia/Ho_Chi_Minh ▼                 ]
  Tài khoản nhận tiền (Tùy chọn - FR-070):
    • Ngân hàng:                 [ Vietcombank                        ]
    • Số tài khoản:              [ 0071001234567                      ]
    • Tên chủ tài khoản:         [ CONG TY RESIHUB                    ]
    • Loại tài khoản:            [ Cá nhân | Hộ kinh doanh ▼          ]
  Cài đặt thuê lại:
    • Điều khoản thuê lại tòa:   [ Hợp đồng thuê nguyên tòa 10 năm... ]
  [Hủy]   [✓ Tạo tòa nhà]

Bước 3 — Kết quả & Checklist vận hành:
  • Tòa mới tạo luôn ở trạng thái ACTIVE.
  • Nếu tòa có 0 tầng → Tự động hiển thị banner nổi bật màu vàng:
    ┌────────────────────────────────────────────────────────────────────────┐
    │ 🚀 Hoàn thiện cấu hình cho tòa "Landmark 81" để bắt đầu vận hành      │
    │  ✅ Thông tin tòa nhà  |  ● Thêm tầng (0 tầng)  |  → Thêm căn hộ      │
    │                                                     [+ Thêm tầng ngay] │
    └────────────────────────────────────────────────────────────────────────┘
```

### API Flow
```
GET /api/v1/buildings/check-code?code=TN-A
  Header: Authorization: Bearer <token>
  Response 200: { "available": true, "code": "TN-A", "message": "Mã tòa hợp lệ và chưa được dùng." }
  Response 200: { "available": false, "code": "TN-A", "message": "Mã tòa này đã tồn tại trong tổ chức." }

POST /api/v1/buildings
  Body: {
    "name": "Tòa Landmark 81 - Vinhomes",
    "code": "TN-VINHOMES",
    "address": "720A Điện Biên Phủ, Bình Thạnh",
    "owner_id": "uuid-owner" | null,
    "timezone": "Asia/Ho_Chi_Minh",
    "payment_account": { "bank": "VCB", "account_no": "...", "account_name": "...", "type": "business" },
    "lease_terms": { "notes": "Hợp đồng thuê 10 năm..." }
  }
  → Transaction:
    1. Kiểm tra UNIQUE(org_id, code)
    2. INSERT INTO building (..., status = 'ACTIVE')
    3. INSERT INTO audit_log (actor_id, action = 'CREATE', entity = 'building', after)
  Response 201: { "message": "Đã tạo tòa nhà thành công.", "data": { id, name, code, status: 'ACTIVE', ... } }
  Response 409: { "code": "BUILDING_CODE_EXISTS", "message": "Mã tòa TN-VINHOMES đã tồn tại." }
  Response 422: { "code": "VALIDATION_ERROR", "message": "Dữ liệu không hợp lệ." }

PATCH /api/v1/buildings/:id/status
  Body: { "status": "INACTIVE" | "ACTIVE" }
  → QUY TẮC RÀNG BUỘC (NFR-016):
    Nếu đổi sang INACTIVE: Kiểm tra SELECT COUNT(*) FROM contract WHERE building_id = $1 AND status = 'ACTIVE'.
    Nếu count > 0 → CHẶN LẬP TỨC: HTTP 400 ACTIVE_CONTRACTS_EXIST.
    Không xóa cứng bản ghi tòa nhà khỏi database.
```

### State Machine của Building
```
       [Tạo mới]
           │
           ▼
       ┌───────┐
       │ACTIVE │ (Mặc định sau khi tạo)
       └───────┘
           │
     [Deactivate] (Chỉ cho phép khi KHÔNG CÓ hợp đồng ACTIVE)
           │
           ▼
      ┌──────────┐
      │ INACTIVE │ (Tạm ngừng hoạt động, không xóa cứng)
      └──────────┘
           │
      [Reactivate]
           │
           └──────► ACTIVE
```

### Test Cases
```
TC-NV03-01: SYS_ADMIN tạo tòa với thông tin hợp lệ → HTTP 201, status = ACTIVE, có bản ghi CREATE trong audit_log.
TC-NV03-02: Để trống tên tòa hoặc tên < 2 ký tự → HTTP 422 VALIDATION_ERROR.
TC-NV03-03: Nhập mã tòa chứa ký tự đặc biệt (@#$) → HTTP 422 VALIDATION_ERROR.
TC-NV03-04: Tạo mã tòa trùng với tòa đã có trong org → HTTP 409 BUILDING_CODE_EXISTS.
TC-NV03-05: MANAGER hoặc STAFF gọi API tạo tòa → HTTP 403 FORBIDDEN.
TC-NV03-06: Chuyển trạng thái tòa sang INACTIVE khi đang có hợp đồng ACTIVE → HTTP 400 ACTIVE_CONTRACTS_EXIST.
TC-NV03-07: Chuyển trạng thái tòa sang INACTIVE khi không có hợp đồng active → HTTP 200, status = INACTIVE, ghi audit_log.
```

---

## NV-04 — THÊM TẦNG VÀO TÒA
> **FR-007, US-008** · Actor: MANAGER, SYS_ADMIN · Module: M03

### Luồng tổng quan
```
/admin/buildings/:id → Tab "Sơ đồ tầng" hoặc nút [+ Thêm tầng]
→ Nhập số tầng (level) & Tên hiển thị → Lưu → Danh sách tầng tự động sắp xếp theo thứ tự level tăng dần (hoặc giảm dần theo sơ đồ nhà cao tầng)
```

### UI Steps
```
1. Chọn tòa nhà cần cấu hình trên thanh điều hướng.
2. Click nút [+ Thêm tầng].
3. Modal form thêm tầng:
   • Số tầng (Level) (*):    [ 1            ] (Số nguyên INTEGER: < 0 nếu là hầm, = 0 nếu là trệt, > 0 nếu là tầng lầu)
   • Tên hiển thị của tầng:  [ Tầng 1       ] (Nếu để trống tự động sinh theo quy tắc bên dưới)
   [Hủy]   [Thêm tầng]
4. Sau khi thêm thành công:
   • Tầng hiển thị ngay trong danh sách/sơ đồ mà không cần reload trang.
   • Form giữ trạng thái sẵn sàng để thêm tầng kế tiếp (tự động gợi ý level = level cũ + 1).
```

### API Flow
```
POST /api/v1/buildings/:building_id/floors
  Body: { "level": 1, "name": "Tầng 1" }
  → Transaction:
    1. Kiểm tra UNIQUE(building_id, level)
    2. INSERT INTO floor (building_id, level, name)
  Response 201: { "data": { "id": "uuid", "building_id": "...", "level": 1, "name": "Tầng 1" } }
  Response 409: { "code": "FLOOR_EXISTS", "message": "Tầng có level này đã tồn tại trong tòa nhà." }
  Response 400: { "code": "VALIDATION_ERROR", "message": "Số tầng phải là số nguyên (INTEGER)." }

GET /api/v1/buildings/:building_id/floors
  Response: { "data": [{ "id": "...", "level": 1, "name": "Tầng 1", "apartment_count": 4 }] }
  Sắp xếp: ORDER BY level ASC

DELETE /api/v1/floors/:id
  → RÀNG BUỘC NGHIỆP VỤ:
    Kiểm tra SELECT COUNT(*) FROM apartment WHERE floor_id = $1.
    Nếu count > 0 → CHẶN XÓA: HTTP 400 FLOOR_HAS_APARTMENTS ("Không thể xóa tầng đang chứa căn hộ").
    Chỉ xóa được tầng khi số căn hộ = 0.
```

### Validation & Business Rules
```
level:
  ✅ Bắt buộc, kiểu INTEGER (hỗ trợ toàn diện thực tế: level < 0 là tầng hầm, level = 0 là tầng trệt/G, level > 0 là tầng lầu).
  ✅ Duy nhất trong cùng một tòa nhà (UNIQUE constraint: UNIQUE(building_id, level)).
name:
  ✅ Tối đa 50 ký tự.
  ✅ Nếu để trống, hệ thống tự động sinh tên thông minh:
     • level < 0: "Tầng hầm B{abs(level)}" (ví dụ: level = -1 → "Tầng hầm B1")
     • level = 0: "Tầng Trệt" (hoặc Tầng G)
     • level > 0: "Tầng {level}" (ví dụ: level = 2 → "Tầng 2")
Ràng buộc xóa tầng:
  ✅ Chặn xóa tầng khi đang chứa bất kỳ căn hộ nào (apartment_count > 0).
```

### Test Cases
```
TC-NV04-01: Tạo tầng 1 với tên hợp lệ → HTTP 201, lưu thành công.
TC-NV04-02: Tạo tầng level = -1 để trống tên → Tự động lưu tên "Tầng hầm B1".
TC-NV04-03: Tạo tầng level = 0 để trống tên → Tự động lưu tên "Tầng Trệt".
TC-NV04-04: Tạo tầng có level đã tồn tại trong tòa → HTTP 409 FLOOR_EXISTS.
TC-NV04-05: Xóa tầng đang có căn hộ bên trong → HTTP 400 FLOOR_HAS_APARTMENTS.
```

---

## NV-05 — TẠO CĂN HỘ & SƠ ĐỒ TRẠNG THÁI (Floor Map)
> **FR-008, FR-010, US-002, AC-008.1..AC-008.3** · Actor: MANAGER, SYS_ADMIN · Module: M03

### Luồng tổng quan
```
/admin/buildings → Chọn tòa → Tab "Sơ đồ tầng" → [+ Thêm căn hộ]
→ Drawer form → Nhập thông tin & Giá niêm yết (BIGINT VND) → Lưu căn hộ ở trạng thái AVAILABLE
→ Hiển thị trực quan trên Interactive Floor Map với màu sắc trạng thái
```

### UI Steps
```
Bước 1 — Chọn tòa nhà và click [+ Thêm căn hộ] (Nút chỉ bật khi tòa đã có ít nhất 1 tầng):

Bước 2 — Form tạo căn hộ:
  • Tầng (*):            [ Tầng 1 ▼           ] (Dropdown danh sách tầng đã tạo)
  • Mã căn hộ (*):       [ A101               ] (Duy nhất trong tòa nhà)
  • Diện tích (*):       [ 35                 ] m²
  • Loại căn hộ:         [ 1PN ▼              ] (Studio / 1PN / 2PN / 3PN / Khác)
  • Số phòng ngủ:        [ 1                  ] phòng
  • Giá niêm yết (*):    [ 7.500.000          ] ₫/tháng (Format tự động dấu chấm phân cách)
  • Tiện ích đi kèm:     [☑ Wifi  ☑ Điều hòa  ☑ Nóng lạnh  ☑ Khóa từ]
  • Ghi chú:             [ Cửa sổ hướng Đông thoáng mát... ]
  [Hủy]   [Tạo căn hộ]

Bước 3 — Sơ đồ tầng trực quan (FR-010):
  Hiển thị lưới ô căn hộ theo từng tầng với màu sắc trạng thái chuẩn PRD:
  🟢 Có sẵn (AVAILABLE)      🔵 Đang thuê (OCCUPIED)      🟡 Đã cọc giữ chỗ (RESERVED)
  🔴 Đang bảo trì (MAINTENANCE)                           ⚫ Tạm ngừng KD (INACTIVE)
  Click vào ô căn hộ → Mở Slide-over panel bên phải xem đầy đủ thông tin căn hộ.
```

### API Flow
```
POST /api/v1/apartments
  Body: {
    "building_id": "uuid-building",
    "floor_id": "uuid-floor",
    "code": "A101",
    "area_m2": 35.5,
    "type": "1PN",
    "bedrooms": 1,
    "base_rent": 7500000,     // BẮT BUỘC: BIGINT VND (không dùng float)
    "amenities": { "wifi": true, "air_conditioner": true },
    "note": ""
  }
  → Transaction:
    1. Kiểm tra UNIQUE(building_id, code)
    2. INSERT INTO apartment (..., status = 'AVAILABLE')
    3. INSERT INTO audit_log (CREATE apartment)
  Response 201: { "message": "Tạo căn hộ thành công.", "data": { id, code, status: 'AVAILABLE', ... } }
  Response 409: { "code": "DUPLICATE_CODE", "message": "Mã căn A101 đã tồn tại trong tòa nhà này." }

PATCH /api/v1/apartments/:id
  Body: { "base_rent", "area_m2", "status", "amenities", "note" }
  → RÀNG BUỘC NGHIỆP VỤ (AC-008.2):
    Nếu sửa diện tích (area_m2) khi căn đang OCCUPIED → Cảnh báo ảnh hưởng đến tính tiền pro-rata/dịch vụ diện tích và bắt buộc ghi Audit Log.
    Không xóa cứng căn hộ khi đang có hợp đồng hiệu lực.
```

### State Machine của Apartment
```
         [Tạo mới]
              │
              ▼
         AVAILABLE ◄────────────────────────────────────┐
              │                                          │
    [HĐ ACTIVE]│              [Đặt cọc giữ chỗ (NV-06)] │
              ▼                      │                   │
          OCCUPIED             RESERVED                  │
              │                      │                   │
  [HĐ kết thúc+      [Hủy giữ chỗ / Chuyển sang HĐ]     │
   bàn giao căn]                     │                   │
              │                      ▼                   │
              └───────────────► (bàn giao) ──────────────┘
                                     │
                             [Cần sửa chữa]
                                     │
                                     ▼
                                MAINTENANCE ──[Sửa xong]──► AVAILABLE
                                     │
                              [Ngừng kinh doanh]
                                     │
                                     ▼
                                  INACTIVE
```

### Validation & Business Rules
```
code:      Bắt buộc, 1–20 ký tự, tự động viết hoa (uppercase), duy nhất trong tòa nhà (UNIQUE(building_id, code)).
area_m2:   Bắt buộc, số dương > 0.
base_rent: Bắt buộc, số nguyên ≥ 0, lưu kiểu BIGINT đơn vị VND. Tuyệt đối không dùng float.
bedrooms:  Số nguyên ≥ 0.
status:    Mặc định sau khi tạo là AVAILABLE.
Ràng buộc giá niêm yết:
  ✅ Giá niêm yết (base_rent) là giá chào thuê tham chiếu. Khi sửa base_rent, tiền thuê của các hợp đồng đang hiệu lực (contract.rent_amount) KHÔNG bị ảnh hưởng (hai trường lưu trữ độc lập).
Ràng buộc xóa & sửa căn hộ (NFR-016):
  ✅ TUYỆT ĐỐI KHÔNG XÓA CỨNG căn hộ đã từng phát sinh hợp đồng hoặc giao dịch. Nếu ngừng khai thác → chuyển status sang INACTIVE.
  ✅ Sửa diện tích căn hộ đang OCCUPIED → Cảnh báo ảnh hưởng tính tiền phí dịch vụ/pro-rata và bắt buộc ghi nhận audit_log chi tiết before/after.
```

### Test Cases
```
TC-NV05-01: Tạo căn A101 hợp lệ → HTTP 201, status = AVAILABLE, audit_log có bản ghi CREATE.
TC-NV05-02: Tạo căn A101 lần 2 trong cùng tòa → HTTP 409 DUPLICATE_CODE.
TC-NV05-03: Tạo căn A101 ở tòa khác → HTTP 201 thành công (mã căn unique theo tòa, không unique toàn hệ thống).
TC-NV05-04: Nhập base_rent là số âm → HTTP 400 VALIDATION_ERROR.
TC-NV05-05: Cập nhật diện tích căn hộ đang có hợp đồng ACTIVE → Báo cảnh báo thành công, ghi vết audit_log chi tiết before/after.
TC-NV05-06: Sửa giá niêm yết căn hộ → Hợp đồng ACTIVE đang chạy giữ nguyên rent_amount cũ không đổi.
TC-NV05-07: Xóa căn hộ đang có hợp đồng hiệu lực → HTTP 400/409 CHẶN XÓA (Yêu cầu chuyển INACTIVE).
```

---

## NV-06 — ĐẶT CỌC GIỮ CHỖ (Khách tiềm năng — Reservation)
> **FR-067, Mục 5.3, Mục 7.1** · Actor: PROSPECT, MANAGER · Module: M04

### Bối cảnh & Mục đích
> Thực tế vận hành phát sinh thường xuyên: Khách xem phòng ưng ý nhưng chưa ký hợp đồng ngay → nộp tiền giữ chỗ để đảm bảo không bị người khác thuê mất. Căn hộ lập tức chuyển sang trạng thái `RESERVED`.  
> Sau đó:  
> - **Khách đồng ý thuê:** Tiền giữ chỗ **CHUYỂN THÀNH TIỀN CỌC HỢP ĐỒNG** (`CONVERTED`).  
> - **Khách hủy / Quá hạn:** Áp dụng chính sách mất cọc (`FORFEITED`) hoặc hoàn lại (`REFUNDED`) có phê duyệt của `APPROVER`.

### UI Steps
```
Bước 1 — Tại Sơ đồ tầng, chọn căn hộ đang có trạng thái AVAILABLE:
  Click nút [Đặt cọc giữ chỗ].

Bước 2 — Drawer thông tin giữ chỗ:
  • Căn hộ giữ:               [ Căn A101 · Tòa Sunrise A           ]
  • Họ và tên khách (*):      [ Nguyễn Văn An                       ]
  • Số điện thoại (*):        [ 0901234567                          ]
  • Số tiền giữ chỗ (*):      [ 1.000.000                           ] ₫ (BIGINT VND)
  • Giữ phòng đến ngày (*):   [ 25/10/2026 📅                       ] (Hạn giữ phòng)
  • Ghi chú thỏa thuận:       [ Khách hẹn ngày 25/10 đến ký hợp đồng]
  [Hủy]   [Xác nhận giữ chỗ]

Bước 3 — Kết quả:
  • Căn A101 lập tức chuyển sang trạng thái 🟡 RESERVED trên Sơ đồ tầng.
  • Bản ghi xuất hiện trong danh sách "Cọc giữ chỗ chờ xử lý".
```

### API Flow
```
POST /api/v1/reservations
  Body: {
    "apartment_id": "uuid-apartment",
    "prospect_name": "Nguyễn Văn An",
    "phone": "0901234567",
    "hold_amount": 1000000,
    "hold_until": "2026-10-25",
    "note": "Khách hẹn 25/10 ký HĐ"
  }
  → Transaction:
    1. Kiểm tra apartment.status == 'AVAILABLE' (Nếu không → HTTP 409 APARTMENT_NOT_AVAILABLE)
    2. INSERT INTO reservation (..., status = 'HELD')
    3. UPDATE apartment SET status = 'RESERVED' WHERE id = apartment_id
    4. INSERT INTO audit_log
  Response 201: { "message": "Đặt cọc giữ chỗ thành công.", "data": reservation }

PATCH /api/v1/reservations/:id/convert
  → Khi khách chính thức ký hợp đồng:
    1. reservation.status = 'CONVERTED'
    2. Chuyển hold_amount sang cọc hợp đồng: deposit.amount_held = hold_amount
    3. apartment.status tiếp tục giữ RESERVED cho đến khi HĐ kích hoạt ACTIVE → OCCUPIED.

PATCH /api/v1/reservations/:id/forfeit
  → Khách hủy giữ chỗ, bị mất tiền cọc giữ chỗ theo quy định:
    1. Bắt buộc có xác nhận của APPROVER (Four-eyes)
    2. reservation.status = 'FORFEITED'
    3. apartment.status = 'AVAILABLE' (Mở lại phòng cho người khác thuê)

PATCH /api/v1/reservations/:id/refund
  → Khách hủy và được hoàn lại tiền cọc giữ chỗ (lý do chính đáng/chính sách):
    1. APPROVER duyệt lệnh hoàn tiền
    2. reservation.status = 'REFUNDED'
    3. apartment.status = 'AVAILABLE'

Cron Job tự động (Chạy hằng ngày lúc 00:00):
  → Quét các bản ghi reservation có status = 'HELD' và NOW() > hold_until:
    1. Tự động chuyển reservation.status = 'EXPIRED'
    2. Tự động chuyển apartment.status = 'AVAILABLE'
```

### Test Cases
```
TC-NV06-01: Đặt cọc giữ chỗ căn AVAILABLE → HTTP 201, reservation.status = HELD, apartment.status = RESERVED.
TC-NV06-02: Đặt cọc giữ chỗ căn đang OCCUPIED hoặc RESERVED → HTTP 409 APARTMENT_NOT_AVAILABLE.
TC-NV06-03: Chuyển giữ chỗ thành hợp đồng (Convert) → reservation.status = CONVERTED, số tiền được ghi nhận vào cọc HĐ.
TC-NV06-04: Hủy giữ chỗ mất cọc (Forfeit) → reservation.status = FORFEITED, căn hộ tự động trở lại AVAILABLE.
TC-NV06-05: Quá hạn hold_until chưa chuyển đổi → Cron job tự động chuyển EXPIRED và mở lại phòng AVAILABLE.
```

---

## NV-07 — TẠO HỒ SƠ CƯ DÂN & PHÁT HIỆN TRÙNG LẶP
> **FR-011, FR-021, US-001** · Actor: MANAGER · Module: M04

### Luồng tổng quan
```
/admin/tenants → [+ Thêm cư dân] → Nhập SĐT / CCCD
→ Real-time Check trùng lặp (Debounce 400ms) → Hiển thị cảnh báo nếu trùng → Tạo hồ sơ PII bảo mật
```

### UI Steps
```
Bước 1 — Màn hình /admin/tenants: Click [+ Thêm cư dân].

Bước 2 — Drawer nhập hồ sơ cư dân:
  • Họ và tên (*):            [ Nguyễn Thị Bình                     ]
  • Số điện thoại (*):        [ 0912345678                          ] ← Kiểm tra trùng real-time
  • Email:                    [ binh.nguyen@email.com               ]
  • Ngày sinh:                [ 15/08/1996 📅                       ]
  • Số CCCD / CMND:           [ 079196001234                        ] ← Mã hóa lưu trữ
  • Ảnh giấy tờ tùy thân:     [📎 Upload CCCD mặt trước] [📎 Upload mặt sau]
  • Vai trò thuê:             [ Cư dân đại diện (Primary) ▼        ] (primary | occupant)
  
  ⚠️ XỬ LÝ TRÙNG LẶP REAL-TIME (FR-021):
  Nếu SĐT hoặc CCCD đã có trong tổ chức, xuất hiện banner cảnh báo màu vàng ngay dưới ô nhập:
  ┌────────────────────────────────────────────────────────────────────────┐
  │ ⚠️ Số điện thoại này đã tồn tại trong hệ thống:                       │
  │    Nguyễn Thị Bình · SĐT: 0912345678 · Đang ở căn A201 (HĐ hiệu lực)    │
  │    [Dùng hồ sơ này]   [Tạo mới - Nhập lý do khác biệt]   [Hợp nhất]    │
  └────────────────────────────────────────────────────────────────────────┘

Bước 3 — Lưu hồ sơ:
  • Trạng thái hồ sơ ban đầu: APPROVED (nếu do Quản lý tạo) hoặc PENDING (nếu cư dân tự khai từ portal).
```

### API Flow
```
GET /api/v1/tenants/check-dup?phone=0912345678&id_number=079196001234
  Response 200: {
    "isDuplicate": true,
    "duplicates": [{ "id": "uuid", "full_name": "Nguyễn Thị Bình", "phone": "0912345678", "apartment_code": "A201" }]
  }

POST /api/v1/tenants
  Body: {
    "full_name": "Nguyễn Thị Bình",
    "phone": "0912345678",
    "email": "binh.nguyen@email.com",
    "dob": "1996-08-15",
    "id_number": "079196001234",
    "type": "primary"
  }
  → Transaction:
    1. Tìm hoặc tạo person (bảng thông tin định danh cá nhân)
    2. Tạo tenant (gắn vai trò trong tổ chức)
    3. Mã hóa trường id_number trước khi ghi DB (NFR-008 PII)
    4. Ghi audit_log (CREATE tenant)
  Response 201: { "message": "Tạo hồ sơ cư dân thành công.", "data": tenant }

QUY TẮC BẢO MẬT PII CHO NHÂN VIÊN (Mục 6.2 PRD v0.2):
  STAFF kỹ thuật khi truy vấn chỉ được xem full_name và phone liên hệ trong phạm vi công việc.
  Trường id_number (CCCD), ảnh giấy tờ, thông tin hợp đồng và công nợ BỊ ẨN HOÀN TOÀN với STAFF.
```

### Test Cases
```
TC-NV07-01: Tạo cư dân mới với SĐT chưa có trong hệ thống → HTTP 201, tạo thành công.
TC-NV07-02: Nhập SĐT đã tồn tại → Frontend hiển thị banner cảnh báo trùng lặp sau 400ms.
TC-NV07-03: Chọn "Dùng hồ sơ này" → Sử dụng person_id hiện hữu, không sinh bản ghi thừa.
TC-NV07-04: STAFF đăng nhập gọi API lấy danh sách cư dân → CCCD và ảnh giấy tờ bị ẩn (null/masked).
```

---

## NV-08 — TẠO HỢP ĐỒNG THUÊ (Wizard 3 bước)
> **FR-014, FR-065, FR-066, FR-064, Mục 10.3** · Actor: MANAGER (tạo) + APPROVER (duyệt) · Module: M05

### Điều kiện tiên quyết trước khi tạo
```
✅ Căn hộ phải ở trạng thái AVAILABLE hoặc RESERVED.
✅ Cư dân đại diện (Primary Tenant) đã có hồ sơ trong hệ thống.
✅ Cơ chế Four-Eyes: Người tạo hợp đồng ≠ Người duyệt kích hoạt (nếu có lệch giá).
```

### UI — Wizard 3 bước chuẩn hóa

#### Bước 1 — Chọn Căn hộ & Khách thuê
```
┌────────────────────────────────────────────────────────────────────────┐
│ [Bước 1: Căn hộ & Khách] ───── Bước 2: Điều khoản ───── Bước 3: Dịch vụ│
├────────────────────────────────────────────────────────────────────────┤
│ Chọn Tòa nhà & Căn hộ:                                                 │
│   • Tòa nhà: [ Tòa Landmark 81 ▼ ]                                     │
│   • Căn hộ:  [ Căn A101 (35m² - Studio - Giá NY: 7.500.000 ₫) ▼ ]      │
│     (Dropdown chỉ hiển thị các căn AVAILABLE hoặc RESERVED)            │
│                                                                        │
│ Khách thuê đại diện (Primary Tenant) (*):                              │
│   🔍 [ Tìm kiếm theo Tên hoặc Số điện thoại... ]                       │
│   → Chọn [ Nguyễn Thị Bình - 0912345678 ]                              │
│   → Hoặc nút [+ Thêm nhanh cư dân mới]                                 │
│                                                                        │
│ Thành viên ở cùng (Occupants):                                         │
│   [+ Thêm người ở cùng]                                                │
│   • Họ tên: [ Trần Văn Nam ] - Quan hệ: [ Vợ/Chồng ▼ ]                 │
│                                                                        │
│                                                    [Tiếp tục: Bước 2 →]│
└────────────────────────────────────────────────────────────────────────┘
```

#### Bước 2 — Điều khoản hợp đồng & Tài chính
```
┌────────────────────────────────────────────────────────────────────────┐
│ Bước 1: Căn hộ & Khách ───── [Bước 2: Điều khoản] ───── Bước 3: Dịch vụ│
├────────────────────────────────────────────────────────────────────────┤
│ Thời hạn hợp đồng:                                                     │
│   • Ngày bắt đầu (*):   [ 01/11/2026 📅 ]                              │
│   • Ngày kết thúc (*):  [ 31/10/2027 📅 ] (Thời hạn: 12 tháng)         │
│                                                                        │
│ Giá thuê & Tiền cọc (BIGINT VND):                                      │
│   • Giá thuê phòng (*): [ 7.000.000  ] ₫/tháng                         │
│     ⚠️ CẢNH BÁO: Giá thuê thấp hơn Giá niêm yết (7.500.000 ₫)          │
│     → Hợp đồng sẽ chuyển trạng thái PENDING_APPROVAL chờ APPROVER duyệt│
│   • Tiền cọc chuẩn (*): [ 7.000.000  ] ₫ (= 1 tháng tiền thuê - PRD)   │
│     (QUY TẮC CỐT LÕI: Tiền cọc KHÔNG được cấn trừ vào tiền thuê phòng) │
│                                                                        │
│ Chu kỳ thanh toán & Phạt chậm (FR-064, FR-066):                        │
│   • Ngày chốt kỳ (billing_day) (*):  [ 1  ] (Ngày 1 hằng tháng)        │
│   • Số ngày ân hạn thanh toán (*):   [ 5  ] ngày sau ngày chốt kỳ      │
│     → Hạn nộp tiền = Ngày 6 hằng tháng.                                │
│     → Sau 5 ngày quá hạn: Tự động phạt 100.000 ₫/ngày chậm (FR-064).   │
│                                                                        │
│ [← Quay lại Bước 1]                                [Tiếp tục: Bước 3 →]│
└────────────────────────────────────────────────────────────────────────┘
```

#### Bước 3 — Biểu phí Dịch vụ đi kèm (FR-065) & Xem trước
```
┌────────────────────────────────────────────────────────────────────────┐
│ Bước 1: Căn hộ & Khách ───── Bước 2: Điều khoản ───── [Bước 3: Dịch vụ]│
├────────────────────────────────────────────────────────────────────────┤
│ Biểu phí dịch vụ theo từng hợp đồng (FR-065):                          │
│ (Thứ tự ưu tiên tính tiền: Giá ghi đè HĐ → Giá tòa nhà → Giá mặc định)│
│   ☑ Điện sinh hoạt:  Đơn giá cố định: [ 3.500 ] ₫/kWh (theo công tơ)   │
│   ☑ Nước sinh hoạt:  Đơn giá cố định: [ 15.000] ₫/m³  (theo công tơ)   │
│   ☑ Gửi xe máy:      Số lượng: [ 1 ] xe - Đơn giá: [ 120.000 ] ₫/tháng │
│   ☑ Phí dịch vụ chung (rác, thang máy, bảo vệ):    [ 150.000 ] ₫/tháng │
│   ☐ Internet cáp quang tốc độ cao:                 [ 200.000 ] ₫/tháng │
│                                                                        │
│ TÓM TẮT XEM TRƯỚC HỢP ĐỒNG:                                            │
│ • Căn hộ: A101 (Tầng 1) · Khách thuê: Nguyễn Thị Bình (0912345678)     │
│ • Kỳ hạn: 01/11/2026 → 31/10/2027 · Tiền thuê: 7.000.000 ₫/tháng      │
│ • Tiền cọc: 7.000.000 ₫ (giữ riêng tại sổ cọc) · Chốt kỳ: Ngày 1      │
│                                                                        │
│ [← Quay lại Bước 2]                               [💾 Lưu bản nháp DRAFT]
└────────────────────────────────────────────────────────────────────────┘
```

### Sau khi lưu DRAFT & Luồng Kích hoạt (Activation)
```
1. Hợp đồng tạo ở trạng thái DRAFT.
2. Quản lý tải bản hợp đồng giấy đã ký có chữ ký của hai bên:
   Tại tab "Đính kèm": [📎 Upload bản scan/ảnh hợp đồng đã ký].
3. Bấm [✅ Kích hoạt hợp đồng]:
   • Kiểm tra Four-eyes: Nếu giá thuê lệch khung (thấp hơn niêm yết) → Chờ APPROVER duyệt.
   • Khi kích hoạt thành công:
     - contract.status = 'ACTIVE'
     - apartment.status tự động chuyển sang 'OCCUPIED'
     - Tự động mở bản ghi cọc deposit (status = 'HELD' khi thu tiền)
     - Gửi thông báo chào mừng đến cư dân kèm link đăng nhập app.
```

### API Flow
```
POST /api/v1/contracts
  Body: {
    "apartment_id": "uuid",
    "primary_tenant_id": "uuid",
    "occupants": [{ "tenant_id": "uuid", "relationship": "spouse" }],
    "start_date": "2026-11-01",
    "end_date": "2027-10-31",
    "rent_amount": 7000000,
    "billing_day": 1,
    "payment_due_days": 5,
    "deposit_amount": 7000000,
    "services": [
      { "service_code": "ELECTRICITY", "unit_price": 3500 },
      { "service_code": "WATER", "unit_price": 15000 },
      { "service_code": "PARKING_MOTO", "unit_price": 120000, "quantity": 1 }
    ]
  }
  → Transaction:
    1. Kiểm tra Exclusion Constraint btree_gist trên (apartment_id, [start_date, end_date)) chống chồng lấn kỳ hạn
    2. Nếu giá thuê < giá niêm yết → contract.status = 'PENDING_APPROVAL'
       Ngược lại → contract.status = 'DRAFT'
    3. INSERT INTO contract_service_price (FR-065 bảng giá theo hợp đồng)
    4. INSERT INTO audit_log
  Response 201: { "data": contract }
  Response 409: { "code": "OVERLAP_CONTRACT", "message": "Căn hộ đã có hợp đồng thuê trong khoảng thời gian này." }

POST /api/v1/contracts/:id/activate
  Body: { "signed_contract_url": "..." }
  → Kiểm tra: Đã upload bản scan hợp đồng đã ký và primary tenant đã có CCCD hợp lệ.
  → Kiểm tra Four-eyes: approved_by != created_by (nếu giá lệch khung).
  → Cập nhật:
    contract.status = 'ACTIVE'
    apartment.status = 'OCCUPIED'
    deposit.status = 'HELD'
  Response 200: { "message": "Hợp đồng đã kích hoạt thành công. Căn hộ chuyển sang Đang thuê." }
```

### Test Cases
```
TC-NV08-01: Tạo hợp đồng thành công với giá chuẩn → status = DRAFT, căn hộ sẵn sàng kích hoạt.
TC-NV08-02: Tạo hợp đồng với giá thấp hơn niêm yết → status = PENDING_APPROVAL, yêu cầu APPROVER duyệt.
TC-NV08-03: Kích hoạt hợp đồng khi chưa upload bản hợp đồng đã ký → Chặn lại, yêu cầu đính kèm file.
TC-NV08-04: Tạo 2 hợp đồng bị trùng kỳ hạn trên cùng 1 căn hộ → DB Exclusion Constraint chặn HTTP 409 OVERLAP_CONTRACT.
TC-NV08-05: Ngày kết thúc hợp đồng ≤ ngày bắt đầu → HTTP 422 VALIDATION_ERROR.
TC-NV08-06: Người lập hợp đồng tự bấm duyệt khi giá lệch khung → HTTP 403 SELF_APPROVE (Vi phạm Four-eyes).
```

---

## NV-09 — GIA HẠN HỢP ĐỒNG (Contract Renewal)
> **FR-015, US-006** · Actor: MANAGER (lập) + APPROVER (duyệt) · Module: M05

### Luồng tổng quan
```
/admin/contracts/:id (HĐ đang ACTIVE hoặc sắp hết hạn) → [↻ Gia hạn hợp đồng]
→ Tạo HĐ mới nối tiếp kỳ hạn, liên kết parent_contract_id
→ Cọc được CHUYỂN TIẾP (TRANSFERRED), không thu lại cọc
→ HĐ mới kích hoạt ACTIVE → HĐ cũ tự động chuyển EXPIRED
```

### UI Steps
```
1. Tại chi tiết hợp đồng sắp hết hạn (trước 60, 30, hoặc 15 ngày):
   Click nút [↻ Gia hạn hợp đồng].
2. Form gia hạn hợp đồng:
   • Ngày bắt đầu mới:  [ 01/11/2027 ] (Tự động điền = Ngày kết thúc cũ + 1 ngày)
   • Ngày kết thúc mới: [ 31/10/2028 ] (Thời hạn tiếp 12 tháng)
   • Giá thuê mới:      [ 7.300.000  ] ₫/tháng (Có thể giữ nguyên hoặc điều chỉnh)
   • Tiền cọc:          [ 7.000.000  ] ₫ (Chuyển tiếp số dư cọc đang giữ, không thu mới)
   • Ghi chú:           [ Gia hạn năm thứ 2 theo thỏa thuận ngày 15/10 ]
   [Tạo hợp đồng gia hạn]
3. Trạng thái:
   • Hợp đồng cũ chuyển sang `RENEWAL_PENDING`.
   • Hợp đồng mới tạo ở `DRAFT` (hoặc `PENDING_APPROVAL` nếu đổi giá).
   • Khi HĐ mới được ký và kích hoạt `ACTIVE` → HĐ cũ tự động chuyển sang `EXPIRED`.
```

### API Flow
```
POST /api/v1/contracts/:id/renew
  Body: {
    "start_date": "2027-11-01",
    "end_date": "2028-10-31",
    "rent_amount": 7300000,
    "note": "Gia hạn năm 2"
  }
  → Transaction:
    1. Kiểm tra HĐ gốc đang ở ACTIVE hoặc RENEWAL_PENDING
    2. INSERT INTO contract với parent_contract_id = id cũ
    3. Kế thừa toàn bộ cư dân và biểu phí dịch vụ FR-065 từ HĐ gốc
    4. UPDATE contract cũ status = 'RENEWAL_PENDING'
    5. Ghi nhận chuyển cọc trong deposit_transaction (type = 'transfer')
  Response 201: { "data": newContract }
```

### Test Cases
```
TC-NV09-01: Gia hạn hợp đồng thành công → HĐ mới kế thừa đúng căn hộ, cư dân, dịch vụ, parent_contract_id trỏ về HĐ cũ.
TC-NV09-02: Ngày bắt đầu HĐ gia hạn nhỏ hơn ngày kết thúc HĐ cũ → Báo lỗi chồng lấn kỳ hạn.
TC-NV09-03: Kích hoạt HĐ gia hạn → HĐ mới thành ACTIVE, HĐ cũ chuyển sang EXPIRED.
```

---

## NV-10 — CHẤM DỨT HỢP ĐỒNG & BÀN GIAO CĂN HỘ
> **FR-017, Mục 7.4** · Actor: MANAGER (lập yêu cầu) + APPROVER (duyệt) · Module: M05

### Luồng 5 bước bắt buộc theo PRD v2.0
```
Bước 1: Tiếp nhận đề nghị chấm dứt (Cư dân gửi từ portal hoặc BQL lập)
  → Bước 2: APPROVER phê duyệt ngày chấm dứt (HĐ chuyển PENDING_TERMINATION → TERMINATED)
  → Bước 3: Kiểm tra căn hộ tại hiện trường (Biên bản kiểm tra có ảnh hiện trạng)
  → Bước 4: Chốt chỉ số điện, nước cuối kỳ (Chụp ảnh đồng hồ)
  → Bước 5: Phát hành hóa đơn kỳ cuối (Tiền thuê pro-rata theo ngày ở thực tế + điện nước)
  → Bàn giao căn: Căn hộ chuyển sang AVAILABLE hoặc MAINTENANCE → Mở hồ sơ quyết toán cọc (NV-13)
```

### UI Steps
```
1. Tại chi tiết hợp đồng ACTIVE: Click nút [🔴 Chấm dứt hợp đồng].
2. Form đề nghị chấm dứt:
   • Ngày trả phòng/chấm dứt: [ 15/11/2026 📅 ]
   • Lý do:                   [ Hết hạn hợp đồng | Cư dân chuyển công tác | Vi phạm ▼ ]
   • Ghi chú:                 [ Cư dân báo trước 30 ngày theo đúng quy định ]
   [Gửi yêu cầu chấm dứt]
3. Sau khi APPROVER duyệt:
   • Hợp đồng chuyển sang trạng thái TERMINATED.
   • Mở Checklist bàn giao căn hộ (/admin/contracts/:id/handover):
     ☑ Đã kiểm tra hiện trạng phòng (Có 4 ảnh đính kèm)
     ☑ Đã chốt chỉ số điện cuối: 1450 kWh (Có ảnh công tơ)
     ☑ Đã chốt chỉ số nước cuối: 125 m³ (Có ảnh công tơ)
     ☑ Đã phát hành hóa đơn kỳ cuối (Tính pro-rata tiền thuê đến ngày 15/11)
     ☑ Đã thu hồi chìa khóa & thẻ từ thang máy
4. Xác nhận bàn giao:
   • Nếu phòng bình thường: Căn hộ chuyển sang 🟢 AVAILABLE sẵn sàng đón khách.
   • Nếu có hư hỏng cần khắc phục: Căn hộ chuyển sang 🔴 MAINTENANCE.
   • Hệ thống kích hoạt nút dẫn trực tiếp: [Tạo bảng quyết toán cọc (NV-13)].
```

### API Flow
```
POST /api/v1/contracts/:id/terminate
  Body: { "termination_date": "2026-11-15", "reason": "tenant_request", "note": "..." }
  Response 200: { "status": "PENDING_TERMINATION" }

POST /api/v1/contracts/:id/terminate/approve
  Header: Authorization: Bearer <token>
  Body: { "approved": true }
  → Bắt buộc Four-eyes: approved_by != created_by
  → contract.status = 'TERMINATED'
  Response 200: { "status": "TERMINATED" }

POST /api/v1/contracts/:id/handover
  Body: {
    "electric_reading": 1450,
    "water_reading": 125,
    "handover_images": ["url1", "url2"],
    "requires_maintenance": false
  }
  → Cập nhật căn hộ: status = requires_maintenance ? 'MAINTENANCE' : 'AVAILABLE'
  → Kích hoạt trạng thái sẵn sàng cho quyết toán cọc
```

### Test Cases
```
TC-NV10-01: Gửi đề nghị chấm dứt hợp đồng → HĐ sang PENDING_TERMINATION.
TC-NV10-02: APPROVER duyệt chấm dứt → HĐ sang TERMINATED, khóa không cho phát sinh kỳ hóa đơn mới.
TC-NV10-03: Hoàn tất checklist bàn giao không cần bảo trì → Căn hộ tự động trở lại AVAILABLE.
TC-NV10-04: Hoàn tất checklist có ghi nhận hư hại → Căn hộ chuyển sang MAINTENANCE.
```

---

## NV-11 — THU TIỀN CỌC HỢP ĐỒNG (Mở Sổ Cọc)
> **FR-022, Mục 10.3** · Actor: ACCOUNTANT · Module: M06

### Quy tắc cốt lõi từ PRD v2.0
> 1. Tiền cọc chuẩn bằng **1 tháng tiền thuê** (theo mục 10.3 PRD v0.2).  
> 2. **TIỀN CỌC TUYỆT ĐỐI KHÔNG ĐƯỢC CẤN TRỪ VÀO TIỀN THUÊ HẰNG THÁNG.**  
> 3. Tiền cọc được lưu vào sổ cái riêng biệt (`deposit`) gắn theo hợp đồng, có lịch sử giao dịch bất biến (`deposit_transaction`).

### UI Steps
```
1. Tại chi tiết hợp đồng đã ký: Tab [Tiền cọc & Sổ cọc].
2. Click nút [+ Ghi nhận thu cọc]:
   • Hợp đồng:           [ HĐ-2026-001 (Căn A101 - Nguyễn Thị Bình) ]
   • Số tiền cọc (*):    [ 7.000.000 ] ₫
   • Ngày thu thực tế:   [ 01/11/2026 📅 ]
   • Phương thức thu:    [ Chuyển khoản ngân hàng ▼ ] (Tiền mặt / Chuyển khoản)
   • Mã giao dịch / STK: [ VCB202611019988 ]
   • Ảnh ủy nhiệm chi:   [📎 Upload ảnh biên lai chuyển khoản]
   • Nguồn tiền:         [☑ Chuyển 1.000.000 ₫ từ cọc giữ chỗ + Thu thêm 6.000.000 ₫] (Nếu có NV-06)
   [Xác nhận thu cọc]
3. Kết quả:
   • Sổ cọc chuyển sang trạng thái 🟢 HELD (Đang giữ cọc: 7.000.000 ₫).
   • Sinh bản ghi giao dịch cọc đầu tiên: Loại `collect`, giá trị `7.000.000 ₫`.
```

### API Flow
```
POST /api/v1/deposits
  Body: {
    "contract_id": "uuid-contract",
    "amount_held": 7000000,
    "collected_at": "2026-11-01",
    "payment_method": "transfer",
    "reference_no": "VCB202611019988",
    "evidence_url": "storage/path/receipt.jpg",
    "source_reservation_id": "uuid-reservation" | null
  }
  → Transaction:
    1. Kiểm tra contract.status in ('DRAFT', 'ACTIVE')
    2. INSERT INTO deposit (contract_id, amount_held = 7000000, status = 'HELD')
    3. INSERT INTO deposit_transaction (deposit_id, type = 'collect', amount = 7000000, evidence)
    4. Ghi audit_log
  Response 201: { "message": "Ghi nhận thu cọc thành công.", "data": deposit }
```

### Test Cases
```
TC-NV11-01: Ghi nhận thu cọc hợp lệ → Sổ cọc tạo thành công, status = HELD, amount_held = 7.000.000 ₫.
TC-NV11-02: Ghi nhận thu cọc số tiền âm hoặc = 0 → HTTP 400 VALIDATION_ERROR.
TC-NV11-03: Đã có cọc giữ chỗ 1.000.000 ₫ → Chuyển đổi và thu thêm phần chênh lệch chính xác.
```

---

## NV-12 — GHI NHẬN KHẤU TRỪ CỌC (Hư hỏng tài sản & Vi phạm)
> **FR-023, FR-068** · Actor: MANAGER (lập) + APPROVER (duyệt) · Module: M06

### Quy tắc nghiệp vụ bắt buộc
> 1. Khấu trừ cọc **CHỈ ÁP DỤNG CHO**:  
>    - Hư hỏng tài sản, trang thiết bị trong căn hộ do cư dân gây ra.  
>    - Chi phí vệ sinh công nghiệp nếu căn hộ bàn giao quá bẩn.  
>    - Tiền phạt vi phạm nội quy/hợp đồng (phải có biên bản vi phạm đính kèm).  
> 2. **TUYỆT ĐỐI KHÔNG KHẤU TRỪ CHO TIỀN THUÊ PHÒNG HẰNG THÁNG.**  
> 3. Bắt buộc có bằng chứng: Ảnh chụp hư hỏng hiện trường + Hóa đơn/Báo giá sửa chữa.  
> 4. Quy tắc Four-eyes: Quản lý lập yêu cầu ≠ Người duyệt (`APPROVER`).  
> 5. Số tiền khấu trừ không được vượt quá số dư cọc đang giữ (`amount_held`).

### UI Steps
```
1. Tại Sổ cọc /admin/deposits/:id: Click nút [+ Ghi nhận khấu trừ cọc].
2. Form yêu cầu khấu trừ:
   • Hạng mục khấu trừ:    [ Hư hỏng tài sản / Thiết bị ▼ ]
                           (Hư hỏng thiết bị | Vệ sinh phòng | Vi phạm HĐ | Khác)
   • Mô tả chi tiết:       [ Vỡ mặt kính bếp từ và nứt bồn rửa mặt phòng tắm ]
   • Số tiền khấu trừ (*): [ 1.500.000 ] ₫ (Số dư cọc hiện tại: 7.000.000 ₫)
   • Chứng từ đính kèm (*):[📎 Upload 2 ảnh hiện trạng hư hỏng]
                           [📎 Upload hóa đơn thay thế bếp từ của nhà cung cấp]
   [Gửi yêu cầu phê duyệt khấu trừ]
3. Sau khi gửi:
   • Giao dịch ở trạng thái PENDING_APPROVAL.
   • APPROVER nhận thông báo xem xét bằng chứng và bấm [Duyệt khấu trừ] hoặc [Từ chối].
   • Khi duyệt thành công: Số dư cọc tự động giảm: 7.000.000 ₫ − 1.500.000 ₫ = 5.500.000 ₫.
```

### API Flow
```
POST /api/v1/deposits/:id/transactions
  Body: {
    "type": "deduct",
    "amount": 1500000,
    "description": "Vỡ mặt kính bếp từ",
    "evidence_urls": ["url_anh_vo", "url_hoa_don"],
    "category": "property_damage"
  }
  → Kiểm tra: amount <= deposit.amount_held (Nếu vượt → HTTP 400 INSUFFICIENT_FUNDS)
  → INSERT INTO deposit_transaction (..., status = 'PENDING_APPROVAL')
  Response 201: { "message": "Đã gửi yêu cầu khấu trừ chờ duyệt.", "transaction_id": "uuid" }

POST /api/v1/deposit-transactions/:id/approve
  Body: { "note": "Đồng ý khấu trừ theo hóa đơn đính kèm" }
  → RÀNG BUỘC FOUR-EYES: approved_by != created_by (Nếu trùng → HTTP 403 SELF_APPROVE)
  → Transaction:
    1. UPDATE deposit_transaction SET status = 'APPROVED', approved_by = $user, approved_at = NOW()
    2. UPDATE deposit SET amount_held = amount_held - txn.amount, updated_at = NOW()
    3. Ghi audit_log
  Response 200: { "message": "Đã duyệt khấu trừ cọc.", "new_amount_held": 5500000 }
```

### Test Cases
```
TC-NV12-01: Gửi yêu cầu khấu trừ có đầy đủ ảnh và hóa đơn → Tạo transaction PENDING_APPROVAL thành công.
TC-NV12-02: Nhập số tiền khấu trừ lớn hơn số tiền cọc hiện có → HTTP 400 INSUFFICIENT_FUNDS.
TC-NV12-03: Người lập yêu cầu tự duyệt khấu trừ cho chính mình → HTTP 403 SELF_APPROVE.
TC-NV12-04: APPROVER duyệt yêu cầu → Số dư cọc giảm đúng số tiền, ghi nhận audit_log.
```

---

## NV-13 — QUYẾT TOÁN & HOÀN CỌC CHO CƯ DÂN
> **FR-024, FR-068, US-017, AC-017.1..AC-017.3** · Actor: ACCOUNTANT (lập) + APPROVER (duyệt) · Module: M06

### Quy tắc chốt từ PRD v2.0
> 1. **Thời hạn cam kết hoàn cọc (FR-068):** Hoàn cọc trong vòng **3–5 ngày làm việc** sau khi chấm dứt hợp đồng và bàn giao căn hộ. Hệ thống tự động đặt `refund_due_date = termination_date + 3 ngày` (cảnh báo vàng) và `+ 5 ngày` (cảnh báo đỏ quá hạn gửi báo cáo Giám đốc).  
> 2. **Cọc không cấn trừ vào tiền thuê:** Tiền thuê phòng được cư dân thanh toán riêng qua hóa đơn. Bảng quyết toán cọc chỉ trừ:  
>    - Các khoản khấu trừ hư hỏng/vệ sinh đã được duyệt hợp lệ (NV-12).  
>    - Tiền điện, nước kỳ cuối (nếu hai bên thỏa thuận chốt trừ trực tiếp khi trả phòng).  
> 3. Cơ chế Four-eyes: Kế toán lập quyết toán ≠ Người phê duyệt lệnh chi (`APPROVER`).

### Điều kiện tiên quyết để quyết toán
```
✅ Hợp đồng thuê ở trạng thái TERMINATED hoặc EXPIRED.
✅ Đã hoàn tất biên bản kiểm tra căn hộ và chốt chỉ số điện/nước cuối kỳ (NV-10).
✅ Đã phát hành hóa đơn kỳ cuối.
```

### UI Steps
```
1. Tại Sổ cọc hợp đồng đã chấm dứt: Click nút [Tạo quyết toán cọc].
2. Hệ thống tự động tổng hợp số liệu và hiển thị BẢNG QUYẾT TOÁN CỌC:

   ┌────────────────────────────────────────────────────────────────────────┐
   │ BẢNG QUYẾT TOÁN HOÀN CỌC — CĂN A101 — HĐ-2026-001                      │
   ├────────────────────────────────────────────────────────────────────────┤
   │ 1. Tổng tiền cọc đang giữ ban đầu:                       7.000.000 ₫   │
   ├────────────────────────────────────────────────────────────────────────┤
   │ 2. Các khoản khấu trừ đã duyệt:                                        │
   │    • Vỡ mặt kính bếp từ (Biên bản + Hóa đơn):          - 1.500.000 ₫   │
   │    • Tiền điện nước kỳ cuối (chốt ngày 15/11):         -   350.000 ₫   │
   │    Tổng các khoản trừ:                                 - 1.850.000 ₫   │
   ├────────────────────────────────────────────────────────────────────────┤
   │ 3. SỐ TIỀN THỰC HOÀN CHO CƯ DÂN:                         5.150.000 ₫   │
   ├────────────────────────────────────────────────────────────────────────┤
   │ 4. Thời hạn hoàn tiền cam kết (3-5 ngày):     Hạn chót: 20/11/2026 ⚠️   │
   │ 5. Thông tin tài khoản nhận tiền hoàn lại:                             │
   │    • Ngân hàng:            [ Vietcombank                              ]│
   │    • Số tài khoản:         [ 0071009876543                            ]│
   │    • Tên chủ tài khoản:    [ NGUYEN THI BINH                          ]│
   ├────────────────────────────────────────────────────────────────────────┤
   │ [Gửi duyệt quyết toán hoàn cọc]                                        │
   └────────────────────────────────────────────────────────────────────────┘

3. Duyệt và Chi trả:
   • APPROVER nhận thông báo kiểm tra bảng kê và bấm [Duyệt quyết toán].
   • Kế toán thực hiện chuyển khoản cho cư dân và upload biên lai chi tiền.
   • Sổ cọc chuyển sang trạng thái 🟢 REFUNDED (hoặc PARTIALLY_REFUNDED).
   • Hệ thống tự động gửi Bảng kê quyết toán kèm biên lai cho cư dân qua email/portal.
```

### Xử lý các trường hợp đặc biệt (Mục 7.5 & 10.2 PRD v0.2)
```
Trường hợp 1 — Hoàn tiền bình thường (Khấu trừ < Cọc):
  Số hoàn lại > 0 → Chi trả cho cư dân → deposit.status = 'REFUNDED'.

Trường hợp 2 — Khấu trừ vượt số tiền cọc (Khấu trừ > Cọc):
  Số tiền hoàn lại = 0 ₫.
  Phần chênh lệch thiếu chuyển thành Công nợ phải thu sau trả phòng:
  RECEIVABLE_AFTER_MOVE_OUT → Kế toán tiếp tục theo dõi thu hồi nợ từ cư dân.
  deposit.status = 'PARTIALLY_REFUNDED'.

Trường hợp 3 — Cư dân không đồng ý với khoản khấu trừ (Tranh chấp):
  Cư dân khiếu nại qua portal → Trạng thái cọc chuyển sang 🔴 DISPUTED.
  Khóa hoàn toàn mọi thao tác giải ngân cho đến khi Giám đốc và Cư dân hòa giải xong.
```

### API Flow
```
POST /api/v1/deposits/:id/settlement
  Body: {
    "deductions": [
      { "category": "property_damage", "amount": 1500000, "note": "Vỡ kính bếp" },
      { "category": "utility_final", "amount": 350000, "note": "Điện nước kỳ cuối" }
    ],
    "refund_account": { "bank": "Vietcombank", "account_no": "0071009876543", "account_name": "NGUYEN THI BINH" },
    "refund_due_date": "2026-11-20"
  }
  → Tính toán: refund_amount = amount_held - sum(deductions)
  → INSERT INTO settlement record (status = 'PENDING_APPROVAL')
  Response 201: { "settlement_id": "uuid", "refund_amount": 5150000 }

POST /api/v1/deposits/:id/settlement/approve
  Body: { "payment_receipt_url": "storage/path/vcb_receipt.jpg" }
  → Kiểm tra Four-eyes: approved_by != created_by
  → Transaction:
    1. INSERT INTO deposit_transaction (type = 'refund', amount = 5150000, evidence = receipt)
    2. UPDATE deposit SET amount_held = 0, status = 'REFUNDED', updated_at = NOW()
    3. Gửi thông báo bảng kê quyết toán cho cư dân
    4. Ghi audit_log
  Response 200: { "message": "Quyết toán hoàn cọc thành công." }
```

### Test Cases
```
TC-NV13-01: Quyết toán hoàn cọc hợp lệ (Cọc 7tr, trừ 1.85tr, hoàn 5.15tr) → Tính toán chuẩn xác 0 đồng sai lệch, cọc sang REFUNDED.
TC-NV13-02: Tổng khấu trừ lớn hơn tiền cọc (Trừ 9tr, cọc 7tr) → Số tiền hoàn = 0, phát sinh công nợ phải thu 2tr.
TC-NV13-03: Kế toán lập quyết toán tự bấm duyệt lệnh chi → HTTP 403 SELF_APPROVE (Vi phạm Four-eyes).
TC-NV13-04: Cư dân bấm khiếu nại khoản trừ → Sổ cọc chuyển sang DISPUTED, chặn thao tác chi tiền.
TC-NV13-05: Quá hạn 5 ngày chưa hoàn tiền → Hệ thống gửi cảnh báo vi phạm SLA lên Giám đốc.
```

---

## 📊 BẢNG TỔNG HỢP MA TRẬN PHÂN QUYỀN & TIẾN ĐỘ 13 QUY TRÌNH (NV-01 → NV-13)

| Mã NV | Quy trình nghiệp vụ | Actor chính | Người duyệt (Approver) | Module | Ràng buộc then chốt theo PRD v2.0 |
|:---:|:---|:---:|:---:|:---:|:---|
| **NV-01** | Đăng nhập OTP qua SĐT | Tất cả | — | M02 | Khóa 15m sau 5 lần sai; Thông báo trung lập chống rò rỉ SĐT. |
| **NV-02** | Đăng nhập Email/Mật khẩu | Nhân sự | — | M02 | Kiểm tra status != SUSPENDED; Mật khẩu bcrypt >= 8 ký tự. |
| **NV-03** | Tạo tòa nhà mới | SYS_ADMIN, OWNER | — | M03 | Mã tòa unique/org; Chặn INACTIVE nếu có HĐ ACTIVE; Audit log. |
| **NV-04** | Thêm tầng vào tòa | MANAGER | — | M03 | Level >= 1 nguyên dương; UNIQUE(building_id, level). |
| **NV-05** | Tạo căn hộ mới | MANAGER | — | M03 | Mã căn unique/tòa; Giá thuê BIGINT VND; Sơ đồ Interactive Floor Map. |
| **NV-06** | Đặt cọc giữ chỗ | PROSPECT, MANAGER | APPROVER | M04 | Căn sang RESERVED; Chuyển thành cọc HĐ khi ký; Four-eyes khi hủy/hoàn. |
| **NV-07** | Tạo hồ sơ cư dân & check trùng | MANAGER | — | M04 | Ẩn CCCD với STAFF; Phát hiện trùng SĐT/CCCD real-time 400ms. |
| **NV-08** | Lập hợp đồng thuê (Wizard 3 bước) | MANAGER | APPROVER (nếu lệch giá) | M05 | Cọc = 1 tháng thuê; Giá HĐ ghi đè (FR-065); Chặn chồng lấn kỳ hạn. |
| **NV-09** | Gia hạn hợp đồng | MANAGER | APPROVER | M05 | Kế thừa thông tin; Chuyển tiếp cọc cũ (TRANSFERRED); HĐ cũ sang EXPIRED. |
| **NV-10** | Chấm dứt hợp đồng & Bàn giao | MANAGER | APPROVER | M05 | Kiểm tra căn có ảnh; Chốt điện nước; Tiền thuê kỳ cuối pro-rata. |
| **NV-11** | Thu tiền cọc (Mở sổ cọc) | ACCOUNTANT | — | M06 | Cọc lưu sổ riêng HELD; CẤM CẤN TRỪ VÀO TIỀN THUÊ; Bất biến giao dịch. |
| **NV-12** | Ghi khấu trừ cọc hư hại | MANAGER | APPROVER | M06 | Bắt buộc có ảnh + hóa đơn sửa chữa; CẤM TRỪ TIỀN THUÊ; Four-eyes. |
| **NV-13** | Quyết toán & Hoàn cọc | ACCOUNTANT | APPROVER | M06 | Hoàn trong 3–5 ngày (FR-068); Khấu trừ > cọc sinh receivable; Four-eyes. |

### Chuỗi luồng nghiệp vụ hoàn chỉnh (Happy Path)
```
NV-01 / NV-02: Đăng nhập hệ thống
  └── NV-03: Khởi tạo Tòa nhà (ACTIVE)
       └── NV-04: Thêm Tầng vào tòa
            └── NV-05: Khởi tạo Căn hộ (AVAILABLE)
                 ├── (Tùy chọn) NV-06: Đặt cọc giữ chỗ cho khách tiềm năng (RESERVED)
                 ├── NV-07: Tạo hồ sơ Cư dân & Kiểm tra trùng lặp
                 └── NV-08: Lập Hợp đồng thuê Wizard 3 bước (DRAFT → Upload ký → ACTIVE)
                      ├── Căn hộ tự động chuyển sang OCCUPIED
                      ├── NV-11: Thu tiền cọc và Mở Sổ Cọc riêng (HELD)
                      ├── [Vận hành định kỳ: Ghi điện nước, Sinh hóa đơn, Thu tiền thuê...]
                      ├── (Tùy chọn) NV-09: Gia hạn hợp đồng (RENEWAL_PENDING → ACTIVE)
                      └── NV-10: Chấm dứt hợp đồng & Nghiệm thu bàn giao căn hộ
                           ├── Căn hộ chuyển sang AVAILABLE hoặc MAINTENANCE
                           ├── NV-12: Ghi nhận khấu trừ cọc nếu có hư hại (kèm ảnh + hóa đơn)
                           └── NV-13: Quyết toán và Hoàn trả cọc trong 3–5 ngày (REFUNDED)
```

---

*Toàn bộ Phần II đã được chuẩn hóa và rà soát khớp 100% với PRD v0.2 (18/09/2026). Cập nhật: 15/10/2026.*


