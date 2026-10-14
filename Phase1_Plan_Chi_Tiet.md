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

#### Ngày 8-9: Backend Auth
- [ ] Cài: `jsonwebtoken`, `bcryptjs`, `express-rate-limit`, `ioredis`
- [ ] Viết `POST /auth/otp/request` (mock OTP log console)
- [ ] Viết `POST /auth/otp/verify` + tạo JWT
- [ ] Viết `POST /auth/login` (email/password)
- [ ] Viết `POST /auth/refresh` + `POST /auth/logout`
- [ ] Middleware `auth.js` (verify JWT → `req.user`)
- [ ] Middleware `rbac.js` (requireRole)

#### Ngày 10-11: Frontend Auth
- [ ] Trang `/login`: input SĐT → send OTP → input OTP → redirect
- [ ] Zustand `authStore`: `{ user, tokens, login(), logout(), refresh() }`
- [ ] Axios instance với interceptor gắn Bearer + auto-refresh khi 401
- [ ] Protected route (redirect `/login` nếu chưa auth)
- [ ] Sidebar render nav items theo role từ JWT

#### Ngày 12-13: RLS + Seed Data
- [ ] Seed: 1 org, 5 roles, 4 test users (OWNER, MANAGER, ACCOUNTANT, RESIDENT)
- [ ] Viết RLS policies cho 5 bảng
- [ ] Viết SQL test script, chạy và verify từng policy
- [ ] **Zero data leak:** mỗi user chỉ thấy dữ liệu đúng scope

#### Ngày 14: Integration & Review
- [ ] E2E: Đăng nhập → sidebar đúng role → gọi API protected → 200
- [ ] Test 403: role không đủ quyền → message đúng
- [ ] Audit trigger cho app_user INSERT/UPDATE
- [ ] Code review naming + folder structure

#### 📦 Deliverable Tuần 2
> ✅ OTP mock login · ✅ JWT hoạt động · ✅ Sidebar đúng role · ✅ RLS có test pass · ✅ 0 data leak

---

## 📅 TUẦN 3: MODULE BẤT ĐỘNG SẢN (M03) + CƯ DÂN (M04)
> **Ngày 15–21** | Mục tiêu: CRUD tòa/tầng/căn hộ + sơ đồ tầng + hồ sơ cư dân

### 🏢 M03 — API Endpoints

```
GET    /api/v1/buildings                    → Danh sách (theo scope)
POST   /api/v1/buildings                    → Tạo tòa
PATCH  /api/v1/buildings/:id
GET    /api/v1/buildings/:id/floors         → Danh sách tầng
POST   /api/v1/buildings/:id/floors         → Tạo tầng
GET    /api/v1/buildings/:id/apartments     → Danh sách căn (?status=)
POST   /api/v1/buildings/:id/apartments     → Tạo căn
PATCH  /api/v1/apartments/:id
GET    /api/v1/buildings/:id/floor-map      → [{floor, apartments:[{id,code,status}]}]
```

### 🏢 M03 — Sơ đồ tầng (FR-010)

```
Tab "Sơ đồ tầng" trong trang Buildings:

TẦNG 3  [ A301 🟢 ] [ A302 🔵 ] [ A303 🟡 ] [ A304 🔵 ]
TẦNG 2  [ A201 🟢 ] [ A202 🔵 ] [ A203 🟢 ] [ A204 ⚫ ]
TẦNG 1  [ A101 🔵 ] [ A102 🔵 ] [ A103 🟢 ] [ A104 🔴 ]

🟢 Có sẵn  🔵 Đang thuê  🟡 Đã đặt  🔴 Bảo trì  ⚫ Không KD

→ Click vào ô: mở slide-over panel chi tiết căn hộ
```

### 👤 M04 — API Endpoints

```
GET    /api/v1/tenants                  → Danh sách cư dân (scope tòa)
POST   /api/v1/tenants                  → Tạo hồ sơ
GET    /api/v1/tenants/:id
PATCH  /api/v1/tenants/:id
GET    /api/v1/tenants/check-dup        → ?phone=&id_number= (FR-021)
POST   /api/v1/tenants/:id/merge        → Hợp nhất trùng

POST   /api/v1/reservations             → Đặt cọc giữ chỗ
PATCH  /api/v1/reservations/:id/convert → Chuyển → cọc HĐ
PATCH  /api/v1/reservations/:id/forfeit → Hủy (mất cọc)
PATCH  /api/v1/reservations/:id/refund  → Hoàn cọc giữ chỗ
```

### 👤 M04 — Duplicate Check (FR-021)

```
Khi nhập SĐT trên form tạo cư dân:
→ Real-time check: GET /tenants/check-dup?phone=09...
→ Nếu tồn tại: hiển thị banner cảnh báo + thông tin người trùng
→ User chọn:
   (A) Dùng người đã có → không tạo mới
   (B) Tạo mới (nhập lý do) → audit log ghi rõ
   (C) Merge → dialog hợp nhất field-by-field + audit
```

### ✅ Task List Tuần 3

#### Ngày 15-16: M03 Backend
- [ ] Controller + service cho buildings, floors, apartments
- [ ] `GET /floor-map` → grouped by floor, mảng apartments
- [ ] Validation: mã căn unique trong tòa, area > 0, base_rent >= 0
- [ ] Audit trigger cho apartment

#### Ngày 17-18: M03 Frontend
- [ ] Trang danh sách buildings (DataTable + filter)
- [ ] Form tạo/sửa building (Drawer)
- [ ] Trang apartments: Tab "Danh sách" + Tab "Sơ đồ tầng"
- [ ] Sơ đồ tầng: Grid màu theo status, click → slide-over chi tiết
- [ ] Chi tiết căn hộ: tab Thông tin + tab Lịch sử Audit

#### Ngày 19-20: M04 Backend + Frontend
- [ ] API tenants CRUD + check-dup + merge
- [ ] API reservations CRUD + convert/forfeit/refund
- [ ] Trang danh sách cư dân (search: tên, SĐT)
- [ ] Form tạo cư dân + duplicate check real-time
- [ ] Hiển thị cảnh báo trùng + 3 lựa chọn xử lý
- [ ] Form đặt cọc giữ chỗ (chọn căn + thông tin khách)

#### Ngày 21: Test & Integration
- [ ] E2E: Tạo tòa → tầng → căn → xem sơ đồ tầng
- [ ] Test trùng SĐT → cảnh báo đúng
- [ ] Test RLS: MANAGER tòa A không thấy tòa B
- [ ] Responsive: sơ đồ tầng trên tablet (1024px)

#### 📦 Deliverable Tuần 3
> ✅ CRUD tòa/tầng/căn · ✅ Sơ đồ tầng màu sắc · ✅ Cư dân + duplicate check · ✅ Đặt cọc giữ chỗ

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
> Ký hiệu trạng thái: `[DRAFT]` `[ACTIVE]` `[TERMINATED]` v.v. theo đúng PRD mục 12–13

---

## NV-01 — ĐĂNG NHẬP OTP (Cư dân & Nhân viên qua SĐT)
> **FR-001, FR-002** · Actor: Tất cả · Module: M02

### Luồng tổng quan
```
Người dùng nhập SĐT  →  Hệ thống gửi OTP (mock: log console)
     →  Nhập OTP 6 số  →  Nhận JWT + Refresh Token
     →  Redirect vào app theo role
```

### UI Steps
```
Bước 1 — Trang /login
  [Logo ResiHub]
  Nhập số điện thoại: [ 09xxxxxxxx    ]
                      [ Gửi mã OTP   ] ← button

Bước 2 — Trang /login/otp (sau khi gửi)
  Đã gửi OTP đến 09xx xxxx xx
  Nhập mã 6 số:  [ _ _ _ _ _ _ ]   ← auto-focus từng ô
  Còn hiệu lực:  04:32             ← countdown 5 phút
  [Xác nhận]      [Gửi lại sau 60s]

Bước 3 — Thành công
  Redirect theo role:
  → RESIDENT     : /resident/apartment
  → MANAGER      : /admin/dashboard
  → ACCOUNTANT   : /admin/dashboard
  → STAFF        : /admin/dashboard
  → SYS_ADMIN    : /admin/buildings
```

### API Flow
```
POST /api/v1/auth/otp/request
  Body: { "phone": "0901234567" }
  Rate limit: 3 req/giờ/SĐT  +  10 req/phút/IP
  Dev: log OTP ra console   |   Prod: gọi SMS provider
  Response: { "message": "OTP đã được gửi" }   ← không tiết lộ OTP

POST /api/v1/auth/otp/verify
  Body: { "phone": "0901234567", "otp": "123456" }
  → Max 5 lần thử sai → lock 15 phút
  → OTP hết hạn sau 5 phút
  Response 200: { "accessToken": "...", "refreshToken": "...", "user": { id, roles, ... } }
  Response 401: { "code": "OTP_INVALID", "message": "Mã OTP không đúng" }
  Response 429: { "code": "TOO_MANY_ATTEMPTS", "message": "Quá nhiều lần thử. Thử lại sau 15 phút." }

POST /api/v1/auth/refresh
  Body: { "refreshToken": "..." }
  Response: { "accessToken": "..." }

POST /api/v1/auth/logout
  Header: Authorization: Bearer <token>
  → Invalidate refresh token trên server
```

### Validation Rules
```
SĐT:
  ✅ Đúng định dạng VN: 10 số, bắt đầu 0
  ✅ Chỉ chứa chữ số
  ❌ SĐT chưa tồn tại trong system → thông báo trung lập "OTP đã gửi" (không tiết lộ)

OTP:
  ✅ Đúng 6 chữ số
  ✅ Còn hiệu lực (< 5 phút)
  ✅ Khớp với SĐT vừa request
  ❌ Sai → "Mã OTP không đúng, còn X lần thử"
  ❌ Hết 5 lần → khóa 15 phút, hiển thị countdown
```

### Test Cases
```
TC-NV01-01: Đăng nhập thành công → nhận JWT, redirect đúng role
TC-NV01-02: OTP sai 5 lần → bị khóa, không thể thử tiếp
TC-NV01-03: OTP hết hạn → "Mã OTP đã hết hạn, gửi lại"
TC-NV01-04: Gửi lại OTP quá 3 lần/giờ → 429
TC-NV01-05: Gọi /auth/otp/request với SĐT không tồn tại → vẫn trả "OTP đã gửi" (không leak)
```

---

## NV-02 — ĐĂNG NHẬP EMAIL/MẬT KHẨU (Nhân viên nội bộ)
> **FR-003** · Actor: MANAGER, ACCOUNTANT, STAFF, SYS_ADMIN · Module: M02

### Luồng
```
/login → Tab "Nhân viên" → Nhập email + mật khẩu → Nhận JWT
```

### API
```
POST /api/v1/auth/login
  Body: { "email": "manager@resihub.vn", "password": "..." }
  → bcrypt.compare password
  → Trả JWT + refresh token (session ngắn hơn: accessToken 15 phút)
  Response 401: { "code": "INVALID_CREDENTIALS", "message": "Email hoặc mật khẩu không đúng" }
```

### Validation
```
✅ Email hợp lệ
✅ Mật khẩu ≥ 8 ký tự
✅ Tài khoản status = ACTIVE (nếu SUSPENDED → "Tài khoản đã bị tạm khóa")
```

---

## NV-03 — TẠO TÒA NHÀ MỚI
> **FR-007** · Actor: SYS_ADMIN · Module: M03  
> *(Xem tài liệu chi tiết riêng: Quy_Trinh_Tao_Toa_Nha.md)*

### Tóm tắt nhanh
```
/admin/buildings → [+ Thêm tòa] → Drawer form → Submit → 201 → Redirect chi tiết tòa

Fields bắt buộc: name, code (unique/org, A-Z/0-9/-)
Fields tùy chọn: address, owner_id, payment_account, lease_terms

Sau khi tạo: tòa ở ACTIVE, chưa có tầng → hiển thị checklist "Hoàn thiện cấu hình"
Không xóa cứng: chỉ đổi status = INACTIVE
```

### State Machine
```
[Tạo mới] → ACTIVE ──[SYS_ADMIN deactivate]──► INACTIVE
                   ◄──[SYS_ADMIN reactivate]───
Không thể INACTIVE khi đang có HĐ ACTIVE trên tòa đó
```

---

## NV-04 — THÊM TẦNG VÀO TÒA
> **FR-007** · Actor: MANAGER, SYS_ADMIN · Module: M03

### UI Steps
```
/admin/buildings/:id → Tab "Tầng & Căn hộ"
→ [+ Thêm tầng] → Mini form inline hoặc modal:
   Số tầng (level):  [ 1  ]   ← số nguyên > 0
   Tên tầng:         [ Tầng 1 ]  ← tùy chọn, tự điền nếu để trống
   [Lưu]

→ Thêm nhiều tầng liên tiếp không cần reload
→ Hiển thị danh sách tầng theo level tăng dần
```

### API
```
POST /api/v1/buildings/:building_id/floors
  Body: { "level": 1, "name": "Tầng 1" }
  → UNIQUE(building_id, level): mỗi tầng chỉ 1 lần
  Response 201: { id, building_id, level, name, created_at }
  Response 409: { "code": "FLOOR_EXISTS", "message": "Tầng 1 đã tồn tại" }

GET /api/v1/buildings/:building_id/floors
  Response: [{ id, level, name, apartment_count }]
  Sắp xếp: ORDER BY level ASC
```

### Validation
```
level: số nguyên ≥ 1, không âm, không trùng trong tòa
name:  tùy chọn, max 50 ký tự, nếu trống → tự gen "Tầng {level}"
```

---

## NV-05 — TẠO CĂN HỘ
> **FR-008** · Actor: MANAGER, SYS_ADMIN · Module: M03

### UI Steps
```
/admin/buildings/:id/apartments → [+ Thêm căn hộ]
→ Drawer form:
   Tầng:         [ Tầng 1 ▼ ]    ← dropdown các tầng đã tạo
   Mã căn:       [ A101    ]     ← unique trong tòa, real-time check
   Diện tích:    [ 35      ] m²
   Loại:         [ Studio ▼ ]    ← Studio / 1PN / 2PN / 3PN / Khác
   Số phòng ngủ: [ 0       ]
   Giá niêm yết: [ 6,500,000 ] ₫ ← BIGINT, format với dấu phân cách
   Ghi chú:      [              ]
   [Lưu]
```

### API
```
POST /api/v1/buildings/:building_id/apartments
  Body: {
    "floor_id": "uuid",
    "code": "A101",
    "area_m2": 35,
    "type": "studio",
    "bedrooms": 0,
    "base_rent": 6500000,   ← BIGINT VND
    "note": ""
  }
  Response 201: apartment object với status = "AVAILABLE"
  Response 409: { "code": "APARTMENT_CODE_EXISTS" }
  Response 422: validation errors

PATCH /api/v1/apartments/:id
  → Chỉ sửa được khi status ≠ OCCUPIED (hoặc cảnh báo rõ ràng)
  → Sửa diện tích khi đang có HĐ ACTIVE → cảnh báo ảnh hưởng tính phí + ghi audit
```

### State Machine căn hộ
```
         [Tạo mới]
              │
              ▼
         AVAILABLE ◄────────────────────────────────────┐
              │                                          │
    [HĐ ACTIVE]│              [Đặt cọc giữ chỗ]         │
              ▼                      │                   │
          OCCUPIED             RESERVED                  │
              │                      │                   │
  [TERMINATED +      [Hủy giữ chỗ / Chuyển sang HĐ]    │
   bàn giao]  │                      │                   │
              ▼                      ▼                   │
         (bàn giao ─────────────────────────────────────►)
              │
   [Cần sửa chữa]
              ▼
        MAINTENANCE ──[Sửa xong]──► AVAILABLE
              │
   [Không khai thác]
              ▼
          INACTIVE
```

### Validation
```
code:      Unique trong tòa (không cần unique toàn system)
area_m2:   > 0
base_rent: ≥ 0, BIGINT (không dùng float)
bedrooms:  ≥ 0
type:      Enum: studio, 1pn, 2pn, 3pn, other
```

### Test Cases
```
TC-NV05-01: Tạo căn A101 thành công → status = AVAILABLE
TC-NV05-02: Tạo căn trùng mã A101 trong cùng tòa → 409
TC-NV05-03: Tạo căn A201 trong tòa khác → OK (mã tòa-căn unique)
TC-NV05-04: Sửa diện tích căn đang OCCUPIED → cảnh báo + audit log
TC-NV05-05: Xóa căn đang có HĐ ACTIVE → 409 (không được xóa)
```

---

## NV-06 — ĐẶT CỌC GIỮ CHỖ (Khách tiềm năng — Reservation)
> **FR từ phản hồi chủ đầu tư** · Actor: MANAGER · Module: M04

### Bối cảnh
> Khách xem phòng, chưa ký HĐ nhưng muốn giữ căn → thu tiền giữ chỗ.  
> Căn hộ chuyển sang `RESERVED`. Sau đó: ký HĐ → chuyển cọc, hoặc hủy.

### UI Steps
```
/admin/buildings/:id/apartments → Chọn căn AVAILABLE → [Đặt giữ chỗ]
→ Drawer:
   Tên khách:     [ Nguyễn Văn A      ]
   SĐT:           [ 0901234567        ]
   Tiền giữ chỗ:  [ 1,000,000         ] ₫
   Giữ đến ngày:  [ 2026-10-21        ] ← hạn tối đa (cần chủ đầu tư chốt)
   Ghi chú:       [                   ]
   [Xác nhận giữ chỗ]

→ Thành công: căn → RESERVED, hiện trong danh sách "Đang giữ chỗ"
```

### API
```
POST /api/v1/reservations
  Body: {
    "apartment_id": "uuid",
    "prospect_name": "Nguyễn Văn A",
    "phone": "0901234567",
    "hold_amount": 1000000,
    "hold_until": "2026-10-21",
    "note": ""
  }
  → Cập nhật apartment.status = RESERVED
  Response 201: reservation object (status = HELD)
  Response 409: { "code": "APARTMENT_NOT_AVAILABLE" }

PATCH /api/v1/reservations/:id/convert
  → Khi khách chính thức ký HĐ
  → deposit.source_reservation_id = reservation.id
  → reservation.status = CONVERTED
  → apartment.status vẫn RESERVED (sẽ → OCCUPIED khi HĐ ACTIVE)

PATCH /api/v1/reservations/:id/forfeit
  → Khách hủy, mất tiền giữ chỗ (theo chính sách)
  → reservation.status = FORFEITED
  → apartment.status = AVAILABLE

PATCH /api/v1/reservations/:id/refund
  → Khách hủy, được hoàn tiền
  → reservation.status = REFUNDED
  → apartment.status = AVAILABLE

PATCH /api/v1/reservations/:id/expire   ← job tự động
  → Quá hold_until mà không convert
  → reservation.status = EXPIRED
  → apartment.status = AVAILABLE
```

### State Machine Reservation
```
HELD ──[convert]──► CONVERTED (→ sang Deposit của HĐ)
     ──[forfeit]──► FORFEITED (mất cọc giữ chỗ)
     ──[refund] ──► REFUNDED  (hoàn lại)
     ──[auto expire]► EXPIRED  (quá hold_until)
```

---

## NV-07 — TẠO HỒ SƠ CƯ DÂN
> **FR-011, FR-021** · Actor: MANAGER · Module: M04

### UI Steps
```
/admin/tenants → [+ Thêm cư dân]
→ Form (Drawer hoặc trang riêng):
   Họ tên (*):        [ Nguyễn Thị B          ]
   SĐT (*):           [ 0912345678            ] ← real-time duplicate check
   Email:             [ b@email.com           ]
   Ngày sinh:         [ 01/01/1995            ]
   Số CCCD:           [ 012345678901          ] ← mã hóa khi lưu
   Ảnh giấy tờ:       [📎 Upload CCCD mặt trước]
                      [📎 Upload CCCD mặt sau  ]
   Vai trò thuê:      [ Cư dân chính ▼ ]  (primary / occupant)
   [Lưu hồ sơ]
```

### Duplicate Check (FR-021) — Quan trọng
```
Khi người dùng rời field SĐT:
→ Gọi: GET /api/v1/tenants/check-dup?phone=0912345678
→ Nếu trùng: hiển thị banner vàng:
  ┌──────────────────────────────────────────────────────────┐
  │ ⚠️  SĐT này đã tồn tại trong hệ thống                   │
  │  Nguyễn Thị B · 09123xxxxx · Căn A201 (HĐ đang hiệu lực)│
  │  [Dùng người này] [Tạo mới - nhập lý do] [Hợp nhất]     │
  └──────────────────────────────────────────────────────────┘
```

### API
```
GET  /api/v1/tenants/check-dup?phone=&id_number=
  Response: { "duplicate": true/false, "existing": { id, name, phone, ... } }

POST /api/v1/tenants
  Body: { person_data: { full_name, phone, email, dob, id_number }, type: "primary" }
  → Tạo person + tenant record
  Response 201: tenant object (status = PENDING → MANAGER confirm → APPROVED)
  Response 409: { "code": "DUPLICATE_PHONE" }  ← nếu không xử lý trùng

POST /api/v1/tenants/:id/merge
  Body: { target_id: "uuid", merge_fields: { ... }, reason: "..." }
  → Gộp 2 hồ sơ, giữ lại target_id
  → Ghi audit_log chi tiết (before/after toàn bộ)
```

### Validation
```
full_name: bắt buộc, 2-100 ký tự
phone:     10 số VN, bắt đầu 0
email:     format email hoặc để trống
dob:       không trong tương lai, không quá 120 tuổi
id_number: 9 hoặc 12 số (CMND/CCCD), mã hóa khi lưu DB
```

### Test Cases
```
TC-NV07-01: Tạo cư dân hợp lệ → status APPROVED
TC-NV07-02: Nhập SĐT trùng → hiện duplicate warning đúng người
TC-NV07-03: Chọn "Dùng người này" → không tạo bản ghi mới
TC-NV07-04: Merge 2 hồ sơ → audit_log ghi đủ before/after
TC-NV07-05: STAFF không thấy CCCD trên UI (chỉ thấy name+phone)
```

---

## NV-08 — TẠO HỢP ĐỒNG THUÊ (Wizard 3 bước)
> **FR-014** · Actor: MANAGER (tạo) · OWNER/APPROVER (duyệt nếu giá lệch) · Module: M05

### Điều kiện trước khi tạo
```
✅ Căn hộ ở trạng thái AVAILABLE hoặc RESERVED
✅ Cư dân đại diện (primary tenant) đã có hồ sơ APPROVED
✅ Người tạo ≠ người duyệt (four-eyes nếu cần approve)
```

### UI — Wizard 3 bước

#### Bước 1 — Căn hộ & Cư dân
```
[Step 1: Căn hộ & Cư dân] ──── Step 2 ──── Step 3

  Chọn căn hộ:
  🔍 [ Tìm mã căn...   ]
  → Dropdown chỉ hiện AVAILABLE và RESERVED
  → Sau khi chọn: hiển thị thông tin căn (diện tích, giá niêm yết, tầng)

  Cư dân đại diện (primary tenant) (*):
  🔍 [ Tìm tên / SĐT... ]
  → Chọn từ danh sách tenant APPROVED
  → Hoặc [+ Tạo cư dân mới] (mở drawer inline)

  Thành viên hộ (occupants):
  [+ Thêm thành viên]
  → Mỗi thành viên: Họ tên + Quan hệ (vợ/chồng/con/cha mẹ/khác)

[Tiếp theo →]
```

#### Bước 2 — Điều khoản hợp đồng
```
◄ Bước 1  [Step 2: Điều khoản] ──── Step 3

  Ngày bắt đầu (*):   [ 01/11/2026 📅 ]
  Ngày kết thúc (*):  [ 31/10/2027 📅 ]
  (Thời hạn: 12 tháng)

  Tiền thuê (*):      [ 6,500,000 ] ₫/tháng
  ⚠️ Cảnh báo: Giá niêm yết là 7.000.000 ₫ (thấp hơn 7.1%) → [Yêu cầu phê duyệt]

  Ngày chốt kỳ (billing_day) (*):  [ 1 ]  (ngày 1 hằng tháng)
  Số ngày ân hạn (*):               [ 5 ]  ngày (sau billing_day)
  → Hạn thanh toán = ngày 1 + 5 = ngày 6 hằng tháng

  Tiền cọc (*):       [ 13,000,000 ] ₫  (= 2 tháng tiền thuê)

[← Quay lại]  [Tiếp theo →]
```

#### Bước 3 — Dịch vụ & Xem trước
```
◄ Bước 1  ◄ Bước 2  [Step 3: Dịch vụ & Xác nhận]

  Dịch vụ đi kèm:
  ☑ Điện          Giá tòa: 3.500 ₫/kWh  [ Ghi đè: 3.500 ₫ ]
  ☑ Nước          Giá tòa: 15.000 ₫/m³   [ Ghi đè: 15.000 ₫]
  ☑ Gửi xe máy   Giá tòa: 100.000 ₫/xe  [ Ghi đè: 100.000 ₫]
  ☐ Internet      200.000 ₫/tháng
  ☐ Dọn phòng

  ─────────── XEM TRƯỚC ───────────
  Căn:           A101 · Tầng 1 · 35m² · Studio
  Cư dân:        Nguyễn Thị B + 0 thành viên
  Kỳ hạn:        01/11/2026 → 31/10/2027 (12 tháng)
  Tiền thuê:     6.500.000 ₫/tháng
  Tiền cọc:      13.000.000 ₫
  Ngày chốt kỳ:  Ngày 1 hằng tháng
  Hạn thanh toán: Ngày 6 hằng tháng

  [← Quay lại]         [💾 Lưu bản nháp (DRAFT)]
```

### Sau khi lưu DRAFT
```
/admin/contracts/:id (status = DRAFT)

Tab "Đính kèm" → [📎 Upload hợp đồng đã ký] → Chọn file PDF/JPG
→ Sau khi upload: [✅ Kích hoạt hợp đồng]
→ Confirm dialog: "Kích hoạt hợp đồng HĐ-001? Căn A101 sẽ chuyển sang Đang thuê."
→ Xác nhận → status = ACTIVE, apartment = OCCUPIED
```

### API Flow
```
POST /api/v1/contracts
  Body: {
    "apartment_id": "uuid",
    "primary_tenant_id": "uuid",
    "occupants": [{ "tenant_id": "uuid", "relationship": "spouse" }],
    "start_date": "2026-11-01",
    "end_date":   "2027-10-31",
    "rent_amount": 6500000,
    "billing_day": 1,
    "payment_due_days": 5,
    "deposit_amount": 13000000,
    "services": [
      { "service_code": "ELECTRICITY", "unit_price": 3500 },
      { "service_code": "WATER",       "unit_price": 15000 },
      { "service_code": "PARKING_MOTO","unit_price": 100000 }
    ]
  }
  Response 201: { id, status: "DRAFT", ... }
  Response 409: { "code": "OVERLAP_CONTRACT" }  ← chồng lấn kỳ thuê
  Response 422: validation errors

POST /api/v1/contracts/:id/activate
  Body: { } (file đã upload vào storage trước)
  → Kiểm tra: contract ở DRAFT, đã có file đính kèm, người activate ≠ người tạo (four-eyes)
  → apartment.status = OCCUPIED
  → contract.status = ACTIVE
  → Sinh lịch hóa đơn dự kiến (preview)
  → Tạo deposit record (PENDING → HELD khi thu tiền)
  → Gửi thông báo cư dân: "HĐ đã kích hoạt, đây là link đăng nhập"
  Response 200: { contract updated }
  Response 403: { "code": "SELF_APPROVE" }  ← four-eyes violation
```

### Validation Business Rules
```
end_date > start_date                          ✅ DB CHECK constraint
rent_amount > 0                                ✅
billing_day ∈ [1, 31]                          ✅
Chồng lấn kỳ thuê cùng căn:                   ✅ Exclusion constraint btree_gist
Giá < X% niêm yết → PENDING_APPROVAL          ⚙️ Cần chốt ngưỡng X% với chủ đầu tư
Thiếu giấy tờ CCCD → DRAFT OK, ACTIVE blocked ✅
```

### Test Cases
```
TC-NV08-01: Tạo HĐ đầy đủ → DRAFT, chưa có DEPOSIT
TC-NV08-02: Activate → contract ACTIVE, apartment OCCUPIED, audit log
TC-NV08-03: Tạo 2 HĐ chồng kỳ cùng căn → 409 OVERLAP_CONTRACT
TC-NV08-04: end_date ≤ start_date → 422
TC-NV08-05: Người tạo tự activate → 403 SELF_APPROVE
TC-NV08-06: RESIDENT gọi API tạo HĐ → 403 FORBIDDEN
TC-NV08-07: Giá thuê thấp hơn ngưỡng → status = PENDING_APPROVAL, không tự ACTIVE
```

---

## NV-09 — GIA HẠN HỢP ĐỒNG
> **FR-015** · Actor: MANAGER (tạo) + OWNER/APPROVER (duyệt) · Module: M05

### UI Steps
```
/admin/contracts/:id (status = ACTIVE hoặc RENEWAL_PENDING)
→ [↻ Gia hạn hợp đồng]
→ Form gia hạn:
   Ngày bắt đầu mới: [ 01/11/2027 ] ← tự điền = end_date cũ + 1 ngày
   Ngày kết thúc:    [ 31/10/2028 ]
   Tiền thuê mới:    [ 7,000,000  ] ₫  ← có thể điều chỉnh
   Ghi chú:          [ Gia hạn năm 2 ]
   [Tạo hợp đồng gia hạn]

→ Tạo contract mới với parent_contract_id = HĐ cũ
→ HĐ cũ → RENEWAL_PENDING (chờ HĐ mới ACTIVE)
→ Khi HĐ mới ACTIVE: HĐ cũ → EXPIRED (tự động)
```

### API
```
POST /api/v1/contracts/:id/renew
  Body: { "start_date", "end_date", "rent_amount", "note" }
  → Tạo contract mới với parent_contract_id
  → Kế thừa: apartment_id, tenants, services từ HĐ cũ
  → Deposit: chuyển tiếp (không yêu cầu cọc mới nếu không thay đổi)
  Response 201: new_contract (DRAFT)
```

### Business Rules
```
HĐ gốc phải ở ACTIVE hoặc RENEWAL_PENDING mới tạo được gia hạn
Ngày bắt đầu HĐ gia hạn phải ≥ end_date HĐ gốc
Không chồng lấn kỳ (exclusion constraint vẫn áp dụng)
Cọc: giữ nguyên nếu cọc đang HELD; không thu thêm (trừ khi có thỏa thuận khác)
```

---

## NV-10 — CHẤM DỨT / HỦY HỢP ĐỒNG
> **FR-017** · Actor: MANAGER (tạo yêu cầu) + OWNER/APPROVER (duyệt) · Module: M05

### Luồng tổng quan
```
Yêu cầu chấm dứt → Duyệt → Kiểm tra căn → Chốt chỉ số cuối
→ Hóa đơn cuối kỳ → Quyết toán cọc → Hoàn cọc/Ghi nợ
```

### UI Steps
```
/admin/contracts/:id (status = ACTIVE)
→ [🔴 Chấm dứt hợp đồng]
→ Form:
   Ngày chấm dứt:  [ 15/11/2026 ]
   Lý do:          [ Cư dân chuyển đi ▼ ]
                   (Hết kỳ / Chuyển đi / Vi phạm HĐ / Thỏa thuận)
   Ghi chú:        [                   ]
   [Gửi yêu cầu chấm dứt]

→ contract.status = TERMINATED (sau khi duyệt)
→ apartment.status = AVAILABLE (sau khi xác nhận bàn giao)
```

### API
```
POST /api/v1/contracts/:id/terminate
  Body: { "termination_date": "2026-11-15", "reason": "tenant_moved", "note": "..." }
  → contract.status → PENDING_TERMINATION (chờ duyệt)
  Response 200

POST /api/v1/contracts/:id/terminate/approve
  Body: { "approved": true, "note": "Đồng ý" }
  → contract.status = TERMINATED
  → apartment.status = MAINTENANCE (chờ kiểm tra) hoặc AVAILABLE
  Response 200

POST /api/v1/contracts/:id/terminate/reject
  Body: { "reason": "..." }
  → contract.status = ACTIVE lại
  Response 200
```

### Sau khi TERMINATED — Checklist bàn giao
```
/admin/contracts/:id/handover

  ☐ Đã kiểm tra tình trạng căn hộ (có ảnh kèm)
  ☐ Đã chốt chỉ số điện cuối kỳ
  ☐ Đã chốt chỉ số nước cuối kỳ
  ☐ Đã phát hành hóa đơn kỳ cuối
  ☐ Đã xác nhận không còn tài sản cư dân trong căn

→ Khi tick hết: căn hộ → AVAILABLE
→ Mở quy trình quyết toán cọc (NV-13)
```

---

## NV-11 — THU CỌC
> **FR-022** · Actor: ACCOUNTANT · Module: M06

### Bối cảnh
> Sau khi HĐ ACTIVE, ACCOUNTANT ghi nhận tiền cọc đã thu thực tế.  
> Cọc KHÔNG được cấn trừ vào tiền thuê (quy tắc cứng từ chủ đầu tư).

### UI Steps
```
/admin/contracts/:id → Tab "Cọc"
→ [+ Ghi nhận thu cọc]
→ Form:
   Số tiền:          [ 13,000,000 ] ₫
   Ngày thu:         [ 01/11/2026 📅 ]
   Phương thức:      [ Chuyển khoản ▼ ] (Tiền mặt / CK / Khác)
   Số tham chiếu:    [ CK20261101001  ]
   Ảnh chứng từ:     [📎 Upload]
   [Xác nhận thu cọc]
```

### API
```
POST /api/v1/deposits
  Body: {
    "contract_id": "uuid",
    "amount_held": 13000000,
    "collected_at": "2026-11-01",
    "method": "transfer",
    "reference": "CK20261101001",
    "evidence_url": "storage/path/..."
  }
  → Tạo deposit record (status = HELD)
  → Tạo deposit_transaction (type = collect)
  Response 201: { deposit_id, status: "HELD", amount_held: 13000000 }
```

### Validation
```
amount_held > 0
contract phải ở ACTIVE
Không được thu cọc quá 1 lần cho cùng HĐ (kiểm tra deposit đã tồn tại)
Nếu đã có reservation.hold_amount → suggest chuyển từ cọc giữ chỗ (NV-06)
```

---

## NV-12 — GHI KHẤU TRỪ CỌC
> **FR-023** · Actor: MANAGER (tạo) + OWNER/APPROVER (duyệt) · Module: M06

### Bối cảnh
> Khi cư dân gây hư hỏng hoặc vi phạm, khấu trừ một phần cọc.  
> **Bắt buộc: có bằng chứng + lý do + phê duyệt APPROVER.**

### UI Steps
```
/admin/deposits/:id → [+ Ghi khấu trừ]
→ Form:
   Loại khấu trừ:  [ Hư hỏng tài sản ▼ ]
                   (Hư hỏng / Vi phạm HĐ / Chi phí dọn dẹp / Tiền điện nước còn nợ / Khác)
   Mô tả chi tiết: [ Thay kính cửa sổ bị vỡ... ]
   Số tiền:        [ 2,000,000 ] ₫
   Bằng chứng:     [📎 Upload ảnh hư hỏng]
                   [📎 Upload hóa đơn sửa chữa]
   [Gửi yêu cầu khấu trừ]

→ Chờ APPROVER duyệt → deposit_transaction (type = deduct) ghi vào sổ
```

### API
```
POST /api/v1/deposits/:id/transactions
  Body: {
    "type": "deduct",
    "amount": 2000000,
    "description": "Thay kính cửa sổ bị vỡ",
    "evidence": ["url1", "url2"],
    "category": "property_damage"
  }
  → Tạo transaction ở PENDING_APPROVAL
  Response 201: { transaction_id, status: "PENDING_APPROVAL" }

POST /api/v1/deposit-transactions/:id/approve
  → approved_by ≠ created_by (four-eyes)
  → transaction.status = APPROVED
  → deposit.amount_held giảm đi
  Response 200

POST /api/v1/deposit-transactions/:id/reject
  Body: { "reason": "..." }
  → transaction.status = REJECTED
  Response 200
```

### Validation
```
amount > 0
amount ≤ deposit.amount_held (không cho khấu trừ vượt số cọc đang giữ)
evidence: bắt buộc tối thiểu 1 file
approved_by ≠ created_by (four-eyes enforcement)
```

---

## NV-13 — QUYẾT TOÁN & HOÀN CỌC
> **FR-024** · Actor: ACCOUNTANT (lập) + OWNER/APPROVER (duyệt) · Module: M06

### Điều kiện trước khi quyết toán
```
✅ contract.status = TERMINATED hoặc EXPIRED
✅ Đã chốt chỉ số điện nước cuối kỳ
✅ Đã phát hành và xác nhận hóa đơn cuối kỳ
✅ Đã có biên bản kiểm tra căn hộ (có ảnh)
```

### UI Steps
```
/admin/deposits/:id → [Tạo quyết toán cọc]
→ Hệ thống tự tính toán và hiển thị bảng:

  ┌─────────────────────────────────────────────────────────┐
  │ BẢNG QUYẾT TOÁN CỌC — Căn A101 — HĐ-2026-001           │
  ├─────────────────────────────────────────────────────────┤
  │ Tổng cọc đang giữ:          13.000.000 ₫               │
  ├─────────────────────────────────────────────────────────┤
  │ Công nợ còn lại:                                        │
  │  - Hóa đơn tháng 11 (chưa trả):  6.500.000 ₫           │
  │  - Phí phạt chậm (3 ngày):          300.000 ₫           │
  ├─────────────────────────────────────────────────────────┤
  │ Khấu trừ đã duyệt:                                      │
  │  - Thay kính cửa sổ:             2.000.000 ₫  [📎 ảnh] │
  ├─────────────────────────────────────────────────────────┤
  │ Tổng trừ:                         8.800.000 ₫           │
  │ SỐ TIỀN HOÀN LẠI:                4.200.000 ₫           │
  ├─────────────────────────────────────────────────────────┤
  │ Hạn hoàn (3-5 ngày):  đến ngày 20/11/2026               │
  │ Thông tin chuyển khoản:                                  │
  │  STK: [ 9876543210 ]  Ngân hàng: [ VCB ]                │
  │  Tên: [ Nguyen Thi B             ]                      │
  ├─────────────────────────────────────────────────────────┤
  │ [Gửi duyệt quyết toán]                                  │
  └─────────────────────────────────────────────────────────┘
```

### Các trường hợp đặc biệt
```
Trường hợp 1 — Hoàn đủ:
  Khấu trừ + Công nợ < Cọc → Hoàn phần dư → deposit.status = REFUNDED

Trường hợp 2 — Không hoàn được gì:
  Khấu trừ + Công nợ ≥ Cọc → Số hoàn = 0 → deposit.status = PARTIALLY_REFUNDED
  Phần thiếu → ghi receivable (công nợ phải thu sau bàn giao)

Trường hợp 3 — Tranh chấp:
  Cư dân không đồng ý → DISPUTED
  Khóa mọi thao tác chi cho đến khi giải quyết
  Mở thread khiếu nại
```

### API
```
POST /api/v1/deposits/:id/settlement
  Body: {
    "deduction_items": [
      { "category": "property_damage", "amount": 2000000, "description": "...", "evidence": ["url"] }
    ],
    "outstanding_invoices": ["invoice_id_1"],
    "refund_account": { "bank": "VCB", "account_no": "9876543210", "account_name": "NGUYEN THI B" },
    "refund_due_date": "2026-11-20"
  }
  → Tạo settlement record (SETTLEMENT_DRAFT)
  → Tính toán: refund_amount = amount_held - sum(deductions) - outstanding
  Response 201: { settlement_id, refund_amount, status: "SETTLEMENT_DRAFT" }

POST /api/v1/deposits/:id/settlement/approve
  Body: { "approved": true, "note": "" }
  → approved_by ≠ created_by (four-eyes)
  → deposit.status = REFUNDED (hoặc PARTIALLY_REFUNDED)
  → Gửi bảng kê cho cư dân qua thông báo
  → deposit.refund_due_date = ngày cam kết
  Response 200

POST /api/v1/deposits/:id/settlement/reject
  Body: { "reason": "Cần bổ sung bằng chứng hư hỏng" }
  → Trả về ACCOUNTANT để chỉnh sửa
  Response 200
```

### Test Cases
```
TC-NV13-01: Quyết toán bình thường → refund_amount đúng
TC-NV13-02: Khấu trừ > cọc → refund_amount = 0, phần thiếu → receivable
TC-NV13-03: Người lập quyết toán tự approve → 403 SELF_APPROVE
TC-NV13-04: Cư dân không đồng ý → DISPUTED, khóa thao tác chi
TC-NV13-05: Hoàn cọc trước khi có hóa đơn cuối → 409 (điều kiện trước chưa đủ)
```

---

## 📊 MA TRẬN LUỒNG NGHIỆP VỤ — GIAI ĐOẠN 1

| # | Nghiệp vụ | Actor | Module | Tuần | Phụ thuộc |
|---|-----------|-------|--------|------|-----------|
| NV-01 | Đăng nhập OTP | Tất cả | M02 | 2 | — |
| NV-02 | Đăng nhập email/password | Nhân viên | M02 | 2 | — |
| NV-03 | Tạo tòa nhà | SYS_ADMIN | M03 | 3 | NV-01 |
| NV-04 | Thêm tầng | MANAGER | M03 | 3 | NV-03 |
| NV-05 | Tạo căn hộ | MANAGER | M03 | 3 | NV-04 |
| NV-06 | Đặt cọc giữ chỗ | MANAGER | M04 | 3 | NV-05 |
| NV-07 | Tạo hồ sơ cư dân | MANAGER | M04 | 3 | NV-01 |
| NV-08 | Tạo hợp đồng thuê | MANAGER | M05 | 4 | NV-05, NV-07 |
| NV-09 | Gia hạn hợp đồng | MANAGER | M05 | 4 | NV-08 |
| NV-10 | Chấm dứt hợp đồng | MANAGER | M05 | 4 | NV-08 |
| NV-11 | Thu cọc | ACCOUNTANT | M06 | 4 | NV-08 |
| NV-12 | Ghi khấu trừ cọc | MANAGER | M06 | 4 | NV-11 |
| NV-13 | Quyết toán & hoàn cọc | ACCOUNTANT | M06 | 4 | NV-10, NV-11, NV-12 |

### Chuỗi nghiệp vụ đầy đủ (Happy Path)

```
NV-01 Đăng nhập
  → NV-03 Tạo tòa → NV-04 Thêm tầng → NV-05 Tạo căn hộ
  → NV-07 Tạo cư dân
  → NV-08 Tạo HĐ (DRAFT) → [Activate] (ACTIVE)
  → NV-11 Thu cọc
  → [Vận hành tháng... Giai đoạn 2: sinh hóa đơn, thanh toán...]
  → NV-10 Chấm dứt HĐ → [Bàn giao căn]
  → NV-12 Khấu trừ cọc (nếu có hư hỏng)
  → NV-13 Quyết toán & hoàn cọc
```

---

*Phần II — Quy trình nghiệp vụ chi tiết. Cập nhật: 2026-10-14.*

