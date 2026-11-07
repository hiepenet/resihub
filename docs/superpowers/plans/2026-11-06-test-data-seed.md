# Test Data Seed – Vinhomes Ocean Park 1/2/3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tạo một script seed dữ liệu test toàn diện (`seed_vinhomes.js`) cho hệ thống ResiHub, bao gồm 3 tòa nhà Vinhomes Ocean Park 1/2/3 (cùng 1 owner, 3 manager riêng biệt), 70–100 căn hộ/tòa chia theo khu (A, B, C) và tầng, hồ sơ dân cư, >150 hợp đồng thuê (1/1/2025→6/11/2026, kiểm tra chồng lấn kỳ hạn), cọc/hoàn cọc theo PRD, và hóa đơn thanh toán từng tháng với tính phí pro-rata chính xác.

**Architecture:** Script Node.js ES module chạy trực tiếp qua `node src/db/seed_vinhomes.js` trong thư mục `api/`, kết nối PostgreSQL qua `DATABASE_URL` (port 5433), thực hiện tất cả thao tác trong 1 transaction lớn với rollback an toàn. Script kế thừa toàn bộ pattern từ `seed_demo.js` (TRUNCATE → tạo org/roles → buildings → apartments → tenants → contracts → deposits → invoices).

**Tech Stack:** Node.js 20+ ES modules, `pg` (PostgreSQL client), `bcryptjs`, PostgreSQL 15 (port 5433), timezone `Asia/Ho_Chi_Minh`

**Spec:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (tại gốc repo), `api/src/db/migrations/002_core_tables.sql`, `api/src/services/pricing.js`, `api/src/services/invoiceSchedule.js`

## Global Constraints

- Tất cả số tiền VND làm tròn đến hàng nghìn gần nhất (`ROUND(x, -3)`)
- Tiền cọc **không** được cấn trừ vào tiền thuê (PRD FR-024)
- Hoàn cọc trong 3–5 ngày sau chấm dứt hợp đồng (refund_due_date = terminated_at + 3..5 ngày)
- Hóa đơn tính phí pro-rata theo ngày: `ROUND(monthlyPrice * activeDays / daysInMonth, -3)` (FR-063)
- Phí phạt chậm: 100.000 đ/ngày sau 5 ngày quá hạn (FR-064)
- Không có 2 hợp đồng ACTIVE trên cùng 1 căn hộ cùng thời điểm (kiểm tra chồng lấn kỳ hạn)
- Mật khẩu demo: `Demo@123456` (bcrypt hash), Admin: `Admin@123456`
- Seed chạy hoàn toàn với `DATABASE_URL=postgres://postgres:postgres@localhost:5433/resihub`
- File seed tại: `api/src/db/seed_vinhomes.js`
- Khoảng thời gian hợp đồng: 1/1/2025 → 6/11/2026 (ngày hiện tại)
- Tòa nhà: Vinhomes Ocean Park 1, 2, 3 — cùng 1 owner, 3 manager riêng biệt
- Mỗi tòa: 3 khu (A, B, C), 10 tầng (tầng 1–10), tổng 80 căn/tòa (8 căn/tầng × 10 tầng: 3 căn Khu A, 3 căn Khu B, 2 căn Khu C)
- Tổng căn hộ: 240 căn (3 tòa × 80 căn)
- Tổng hợp đồng mục tiêu: **>150** → đảm bảo bằng cách cho ~65% căn hộ có ≥1 hợp đồng (nhiều căn có hợp đồng lịch sử + hiện tại)

## Review Focus

1. **Chồng lấn kỳ hạn hợp đồng** trên cùng 1 căn hộ → kiểm tra `CHECK_OVERLAP` trước khi INSERT contract
2. **Pro-rata đúng tháng đầu/cuối** khi start_date không phải ngày 1 tháng → `activeDays = daysInMonth - startDay + 1`
3. **Cọc không cấn trừ vào tiền thuê** → deposit.status = 'HELD' suốt kỳ HĐ ACTIVE; hoàn cọc dùng type='refund'
4. **Hóa đơn ISSUED vs PAID** → hóa đơn tháng 11/2026 status='ISSUED', tháng cũ status='PAID'
5. **Meter reading** phải có `previous_reading < current_reading` và tạo đủ cho mỗi tháng có HĐ ACTIVE

---

## Task 1: Xóa dữ liệu cũ & Khung script

**Files:**
- Create: `api/src/db/seed_vinhomes.js`

**Interfaces:**
- Produces: `seed()` async function; helpers `phone(n)`, `idNumber(n)`, `hashPwd(plain)`, `roundVND(amount)`, `calcProrata({monthlyPrice, activeDays, daysInMonth})`

- [ ] **Step 1: Tạo file `api/src/db/seed_vinhomes.js` với skeleton ES module**

```js
import pg from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    `postgres://postgres:postgres@127.0.0.1:5433/resihub`,
});

function phone(n) { return `09${String(n).padStart(8, '0')}`; }
function idNumber(n) { return `07900${String(n).padStart(7, '0')}`; }
async function hashPwd(plain) { return bcrypt.hash(plain, 10); }
function roundVND(amount) {
  const num = Number(amount || 0);
  if (!Number.isFinite(num) || num === 0) return 0;
  const sign = num < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(num) / 1000) * 1000;
}
function calcProrata({ monthlyPrice, activeDays, daysInMonth }) {
  if (activeDays <= 0 || daysInMonth <= 0) return 0;
  if (activeDays >= daysInMonth) return roundVND(monthlyPrice);
  return roundVND((monthlyPrice * activeDays) / daysInMonth);
}
function getDaysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function randomInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function eachMonth(startYmd, endYm) {
  const months = [];
  let [y, m] = startYmd.slice(0, 7).split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push({ year: y, month: m, period: `${y}-${pad2(m)}` });
    m++; if (m > 12) { m = 1; y++; }
  }
  return months;
}
function hasOverlap(existingContracts, aptId, startDate, endDate) {
  return existingContracts.some(c =>
    c.apartmentId === aptId && c.startDate < endDate && c.endDate > startDate
  );
}

async function seed() { /* được triển khai ở Task 2–8 */ }

seed().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
```

- [ ] **Step 2: Thêm block TRUNCATE trong hàm `seed()`**

```sql
TRUNCATE TABLE
  late_fee_accrual_tracker,
  receivable,
  invoice_line, invoice_adjustment, payment, credit_balance, invoice,
  meter_reading, meter,
  service_subscription, contract_service_price,
  deposit_transaction, deposit,
  contract_version, contract_occupant, contract_request, contract,
  service_request,
  reservation,
  tenant,
  user_role, app_user,
  notification, announcement, zalo_group, attachment, audit_log,
  system_setting, service_catalog,
  apartment, zone, floor, building,
  person, owner, role, organization
RESTART IDENTITY CASCADE;
```

- [ ] **Step 3: Chạy thử script để xác nhận kết nối DB và TRUNCATE OK**

```bash
cd d:\resihub\api && node src/db/seed_vinhomes.js
```
Expected: Không lỗi FK, in `[1/8] Xóa dữ liệu cũ... ✓`

---

## Task 2: Organization, Roles, System Settings & Service Catalog

**Files:**
- Modify: `api/src/db/seed_vinhomes.js`

**Interfaces:**
- Produces: `orgId` (UUID), `roleIdMap: { OWNER, MANAGER, RESIDENT, SYS_ADMIN }`, `serviceCatalogMap: { ELECTRICITY, WATER, INTERNET_FIBER, MANAGEMENT_FEE, MOTORBIKE_PARKING, CAR_PARKING, CLEANING_WEEKLY }`

- [ ] **Step 1: INSERT organization**

Name: `Tập đoàn Quản lý Bất động sản ResiHub`, tax_code: `0312345678`

- [ ] **Step 2: INSERT 4 roles** — OWNER(org), MANAGER(building), RESIDENT(building), SYS_ADMIN(org)

- [ ] **Step 3: INSERT system_setting** — 5 keys: `billing_config` (late_fee_per_day=100000, grace=5 ngày), `sla_config` (deposit_refund_days=5), `contact_config`, `approval_config`, `ai_config`

- [ ] **Step 4: INSERT service_catalog** — 7 dịch vụ tiêu chuẩn từ `008_seeds.sql`

Lưu map `serviceCatalogMap` với id của từng service code.

- [ ] **Step 5: Chạy kiểm tra partial**

Expected: `[2/8] Org, Roles, System Settings, Service Catalog... ✓`

---

## Task 3: Owner + 3 Tòa nhà + 3 Manager riêng biệt + Admin

**Files:**
- Modify: `api/src/db/seed_vinhomes.js`

**Interfaces:**
- Produces: `buildings: [{ id, code, name, num }]` (3 items), `ownerId`, `adminUserId`, `managerByBuilding: { buildingId → { userId, managerId } }`, `defaultPassword`

- [ ] **Step 1: Hash mật khẩu mặc định**

```js
const defaultPassword = await hashPwd('Demo@123456');
const adminPassword   = await hashPwd('Admin@123456');
```

- [ ] **Step 2: Tạo 1 owner dùng chung cho cả 3 tòa**

```
person:   full_name='Chủ đầu tư Vinhomes Ocean Park', phone=phone(5000001), email='owner.vop@resihub.vn'
owner:    org_id, person_id, full_name, phone, email
app_user: auth_uid='owner-vop', password=defaultPassword
user_role: role=OWNER, building_id=NULL
```

- [ ] **Step 3: INSERT 3 buildings (Vinhomes Ocean Park 1/2/3)**

```js
const buildingsMeta = [
  { code:'VOP-1', name:'Vinhomes Ocean Park 1', address:'Vinhomes Ocean Park 1, Gia Lâm, Hà Nội', num:1 },
  { code:'VOP-2', name:'Vinhomes Ocean Park 2', address:'Vinhomes Ocean Park 2, Gia Lâm, Hà Nội', num:2 },
  { code:'VOP-3', name:'Vinhomes Ocean Park 3', address:'Vinhomes Ocean Park 3, Gia Lâm, Hà Nội', num:3 },
];
```

- [ ] **Step 4: Tạo 3 Manager riêng biệt, mỗi manager gán đúng 1 building_id**

```
manager VOP-1: email='manager.vop1@resihub.vn', auth_uid='manager-vop-1'
manager VOP-2: email='manager.vop2@resihub.vn', auth_uid='manager-vop-2'
manager VOP-3: email='manager.vop3@resihub.vn', auth_uid='manager-vop-3'
user_role: role=MANAGER, building_id=<tòa tương ứng>
```

- [ ] **Step 5: Tạo SYS_ADMIN**

```
person:   full_name='Quản trị viên ResiHub', phone='0900000001', email='admin@resihub.vn'
app_user: auth_uid='admin-resihub', password=adminPassword
user_role: role=SYS_ADMIN, building_id=NULL
```

- [ ] **Step 6: Chạy kiểm tra**

Expected: 1 owner + 3 buildings + 3 managers + 1 admin được tạo thành công.

---

## Task 4: Zones (A, B, C) + Floors (1–10) + Apartments (80 căn/tòa)

**Files:**
- Modify: `api/src/db/seed_vinhomes.js`

**Interfaces:**
- Produces: `aptsByBuilding: { buildingId → [{ id, code, buildingId, floorId, floorLevel, zoneCode, zoneId, bedrooms, baseRent }] }`, `zonesMap: { buildingId → { A: id, B: id, C: id } }`, `floorsMap: { buildingId → [{ id, level }] }`

- [ ] **Step 1: Tạo 3 zones cho mỗi tòa (Khu A, Khu B, Khu C)**

```js
const zoneMeta = [
  { code:'A', name:'Khu A' },
  { code:'B', name:'Khu B' },
  { code:'C', name:'Khu C' },
];
// zonesMap[building.id] = { A: uuid, B: uuid, C: uuid }
```

- [ ] **Step 2: Tạo 10 tầng (level 1–10) cho mỗi tòa**

```js
// name = level===1 ? 'Tầng 1 (Trệt)' : `Tầng ${level}`
// floorsMap[building.id] = [{ id, level }, ...]
```

- [ ] **Step 3: Tạo 80 căn hộ/tòa — 8 căn/tầng × 10 tầng**

Phân bổ 8 căn/tầng vào 3 khu:
- Căn 1–3: Khu A | Căn 4–6: Khu B | Căn 7–8: Khu C

Mã căn hộ: `{tòa_num}{floor_level}{zone_code}{aptNo_in_zone}` → vd Tòa1/T3/KhuA/căn2 = `13A02`

```js
const aptLayoutPerFloor = [
  { zone:'A', no:1, bedrooms:1, area:42, rentBase:7000000 },
  { zone:'A', no:2, bedrooms:2, area:58, rentBase:9500000 },
  { zone:'A', no:3, bedrooms:1, area:40, rentBase:6800000 },
  { zone:'B', no:1, bedrooms:2, area:65, rentBase:10500000 },
  { zone:'B', no:2, bedrooms:3, area:85, rentBase:14000000 },
  { zone:'B', no:3, bedrooms:2, area:60, rentBase: 9800000 },
  { zone:'C', no:1, bedrooms:1, area:45, rentBase: 7500000 },
  { zone:'C', no:2, bedrooms:2, area:70, rentBase:11000000 },
];
// base_rent = rentBase + floor.level * 100000
// code = `${building.num}${floor.level}${zone}${pad2(no)}`
```

- [ ] **Step 4: Chạy kiểm tra**

Expected: 240 căn hộ được tạo, log `✓ 240 căn hộ đã tạo`

---

## Task 5: Hồ sơ dân cư (Tenants)

**Files:**
- Modify: `api/src/db/seed_vinhomes.js`

**Interfaces:**
- Consumes: `buildings`, `orgId`, `roleIdMap`
- Produces: `tenantPool: [{ tenantId, personId, userId, name, buildingId }]` (pool ~260 tenant)

- [ ] **Step 1: Định nghĩa helper tên tiếng Việt ngẫu nhiên**

```js
const lastNames  = ['Nguyễn','Trần','Lê','Phạm','Hoàng','Vũ','Đặng','Bùi','Đỗ','Hồ','Ngô','Dương','Lý','Đinh','Phan'];
const midNames   = ['Văn','Thị','Hữu','Minh','Thanh','Quốc','Ngọc','Kim','Đức','Xuân'];
const firstNames = ['An','Bình','Chi','Dung','Giang','Hà','Khoa','Lan','Minh','Nam','Phúc','Quân','Sơn','Thành','Yến','Hùng','Linh'];
function randomName(i) {
  return `${lastNames[i%lastNames.length]} ${midNames[(i*3)%midNames.length]} ${firstNames[(i*7)%firstNames.length]}`;
}
```

- [ ] **Step 2: Tạo ~260 tenant (đủ cho 206 HĐ cần + dự phòng)**

Phân bổ tenant cho từng building (87 tenant/building):
```js
let phoneCounter = 7000001, idNoCounter = 7000001, tenantIdx = 1;
// Với mỗi building, tạo 87 tenant:
//   person: { org_id, full_name: randomName(tenantIdx), phone: phone(phoneCounter++),
//             email: `tenant${tenantIdx}@resihub.vn`, id_number: idNumber(idNoCounter++),
//             nationality:'Việt Nam', address:'Hà Nội', dob: `${1980+(tenantIdx%20)}-01-01` }
//   tenant: { person_id, org_id, type:'primary', status:'APPROVED', consent_given:true, consent_given_at:NOW() }
//   app_user: { auth_uid:`resident-${tenantIdx}`, password:defaultPassword }
//   user_role: { role_id:RESIDENT, building_id:building.id }
```

- [ ] **Step 3: Chạy kiểm tra**

Expected: `[5/8] Tenants: 261 cư dân đã tạo. ✓`

---

## Task 6: Hợp đồng (>150) + Deposits + Subscriptions

**Files:**
- Modify: `api/src/db/seed_vinhomes.js`

**Interfaces:**
- Consumes: `aptsByBuilding`, `tenantPool`, `managerByBuilding`, `serviceCatalogMap`
- Produces: `contractList: [{ contractId, apartmentId, buildingId, startDate, endDate, rentAmount, billingDay, tenantId, depositId, managerId, status }]`

- [ ] **Step 1: Khởi tạo tracking set chống chồng lấn**

```js
const existingContracts = []; // Accumulate as we insert
// hasOverlap(existingContracts, aptId, startDate, endDate) → bool
```

- [ ] **Step 2: Lô 1 — 156 HĐ ACTIVE cho 52 căn/tòa**

```js
// Với mỗi tòa, chọn các căn theo index i%3===0 (mỗi căn thứ 3 → 80/3 ≈ 26 căn/tòa... không đủ)
// Thay vào đó: lấy 52 căn đầu tiên của mỗi tòa (aptsByBuilding[bId].slice(0, 52))
// Tháng bắt đầu: ngẫu nhiên [2025-01-01 .. 2025-06-01] (đầu tháng)
//   startDate = `2025-${pad2(randomInt(1,6))}-01`
// Kỳ hạn: 18-24 tháng → endDate = addMonths(startDate, randomInt(18,24))
//   nhưng cần chắc endDate >= '2026-11-06' → clamp về '2026-11-30' hoặc '2027-03-31'
// billing_day: randomInt(1, 10)
// deposit_amount = rent_amount (1 tháng tiền thuê)
// status: 'ACTIVE'
```

- [ ] **Step 3: Lô 2 — 50 HĐ EXPIRED lịch sử**

```js
// 50 căn tiếp theo: aptsByBuilding[bId].slice(52, 70) → ~18 căn/tòa × 3 = 54
// startDate = `2024-${pad2(randomInt(1,6))}-01`
// endDate = `2024-12-31`
// status: 'EXPIRED'
// Kiểm tra hasOverlap() → không chồng vì chưa có HĐ nào trên căn này
```

- [ ] **Step 4: Lô 3 — 50 HĐ ACTIVE cho các căn ở Lô 2**

```js
// Căn đã có HĐ EXPIRED → tạo HĐ ACTIVE mới
// startDate = '2025-01-01' (sau khi EXPIRED kết thúc 2024-12-31)
// hasOverlap() sẽ OK vì '2025-01-01' > '2024-12-31'
```

> Tổng: 156 + 50 + 54 ≈ **260 hợp đồng** (>150 ✓)

- [ ] **Step 5: INSERT contract cho mỗi HĐ**

```sql
INSERT INTO contract (apartment_id, building_id, primary_tenant_id,
  start_date, end_date, rent_amount, billing_cycle, billing_day,
  payment_due_days, deposit_amount, status, created_by, approved_by)
VALUES (..., 'monthly', $billingDay, 5, $depositAmt, $status, $managerId, $managerId)
RETURNING id;
```

Sau INSERT: push vào `existingContracts` và update apartment status nếu cần.

- [ ] **Step 6: Tạo Deposit + Deposit Transaction**

```js
// ACTIVE contracts:
//   deposit: status='HELD', refund_due_date=NULL
//   deposit_transaction: type='collect', status='APPROVED'

// EXPIRED contracts:
//   deposit: status='REFUNDED', refund_due_date = addDays(endDate, randomInt(3,5))
//   deposit_transaction 1: type='collect' (thu cọc ban đầu)
//   deposit_transaction 2: type='refund', amount=depositAmt, description='Hoàn cọc sau kết thúc hợp đồng'
```

- [ ] **Step 7: Tạo Service Subscriptions cho HĐ ACTIVE**

```js
// 100% HĐ ACTIVE: MANAGEMENT_FEE (350.000/tháng, unit_price from serviceCatalogMap)
// 80% HĐ ACTIVE: INTERNET_FIBER (220.000/tháng) — if contractIdx % 5 !== 0
// 40% HĐ ACTIVE: MOTORBIKE_PARKING (120.000/xe, quantity=1) — if contractIdx % 2 === 0
// Tất cả: start_date = contract.start_date, end_date = contract.end_date, status='ACTIVE'
```

- [ ] **Step 8: Tạo contract_service_price ghi đè cho ~20% HĐ**

```js
// if contractIdx % 5 === 0: ghi đè MANAGEMENT_FEE = 300.000 (discount 50k)
// if contractIdx % 7 === 0: ghi đè INTERNET_FIBER = 180.000
```

- [ ] **Step 9: Chạy kiểm tra**

Expected: >150 HĐ, không có lỗi FK, log số HĐ theo status.

---

## Task 7: Meters + Meter Readings

**Files:**
- Modify: `api/src/db/seed_vinhomes.js`

**Interfaces:**
- Consumes: `contractList` (ACTIVE), `orgId`
- Produces: `meterByApt: { aptId → { elId, wtId } }`, `readingsByAptMonth: { aptId_period → { elCurr, wtCurr } }`

- [ ] **Step 1: INSERT electricity và water meters cho mỗi căn ACTIVE**

```sql
INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading, status)
VALUES ($orgId, $bldgId, $aptId, 'ELECTRICITY', 'EL-' || $bCode || '-' || $aptCode, 'kWh', 3800, 0, 'ACTIVE')
ON CONFLICT (apartment_id, meter_type) DO NOTHING RETURNING id;
```

Tương tự cho WATER (unit='m³', unit_price=22000, meter_code='WT-...')

- [ ] **Step 2: Tạo Meter Readings theo từng tháng (từ start_date đến 2026-11)**

```js
// Với mỗi HĐ ACTIVE:
let elPrev = randomInt(1000, 5000), wtPrev = randomInt(100, 500);
for (const { year, month, period } of eachMonth(contract.startDate, '2026-11')) {
  const elConsumption = randomInt(100, 250);
  const wtConsumption = Number((randomInt(5, 15) + Math.random()).toFixed(1));
  const elCurr = elPrev + elConsumption;
  const wtCurr = wtPrev + wtConsumption;
  // INSERT meter_reading (electricity): previous=elPrev, current=elCurr, consumption=elConsumption
  // INSERT meter_reading (water):       previous=wtPrev, current=wtCurr
  // Lưu: readingsByAptMonth[`${aptId}_${period}`] = { elConsumption, wtConsumption, elCurr, wtCurr }
  elPrev = elCurr; wtPrev = wtCurr;
}
```

`period` field format: `'YYYY-MM'` (TEXT NOT NULL trong schema)
`contract_id` field: gắn contract_id vào meter_reading

- [ ] **Step 3: Chạy kiểm tra**

Expected: Không có `CHECK (current_reading >= previous_reading)` violation.

---

## Task 8: Hóa đơn hàng tháng (Pro-rata chính xác) + Payments + Receivables

**Files:**
- Modify: `api/src/db/seed_vinhomes.js`

**Interfaces:**
- Consumes: `contractList`, `meterByApt`, `readingsByAptMonth`, `serviceCatalogMap`
- Produces: `invoiceList: [{ invoiceId, contractId, period, status, totalAmount }]`

- [ ] **Step 1: Tạo invoice sequence helper**

```js
let invoiceSeq = 1;
function nextInvoiceCode(bldgCode, period) {
  const ym = period.replace('-', '');
  return `INV-${bldgCode}-${ym}-${String(invoiceSeq++).padStart(4, '0')}`;
}
```

- [ ] **Step 2: Với mỗi HĐ ACTIVE, duyệt từng tháng và tạo invoice**

```js
const TODAY = '2026-11-06';
const CURRENT_PERIOD = '2026-11';

for (const contract of activeContracts) {
  for (const { year, month, period } of eachMonth(contract.startDate, '2026-11')) {
    const dim = getDaysInMonth(year, month);
    const periodStart = `${period}-01`;
    // activeDays: đầu tháng (không full) hay cuối tháng (không full)
    const startBound = contract.startDate > periodStart ? contract.startDate : periodStart;
    const endBound   = contract.endDate < addDays(`${period}-${pad2(dim)}`, 1)
                       ? contract.endDate
                       : addDays(`${period}-${pad2(dim)}`, 1);
    const activeDays = Math.max(0, (new Date(endBound) - new Date(startBound)) / 86400000);
    const isProrated = activeDays < dim;

    // Rent (pro-rata)
    const rentAmt = calcProrata({ monthlyPrice: contract.rentAmount, activeDays, daysInMonth: dim });

    // Electricity / Water
    const reading = readingsByAptMonth[`${contract.apartmentId}_${period}`];
    const elAmt = reading ? roundVND(reading.elConsumption * 3800) : 0;
    const wtAmt = reading ? roundVND(reading.wtConsumption * 22000) : 0;

    // Fixed services (tính pro-rata nếu tháng đầu/cuối)
    let svcAmt = 0;
    for (const sub of contract.subscriptions || []) {
      const subPrice = getEffectiveServicePrice(sub, contract.contractServicePrices);
      svcAmt += calcProrata({ monthlyPrice: subPrice * sub.quantity, activeDays, daysInMonth: dim });
    }

    const subtotal = rentAmt + elAmt + wtAmt + svcAmt;
    const issueDay = Math.min(contract.billingDay, dim);
    const issueDate = period === contract.startDate.slice(0,7)
                     ? contract.startDate
                     : `${period}-${pad2(issueDay)}`;
    const dueDate = addDays(issueDate, 5);

    // Status
    let status;
    if (period < CURRENT_PERIOD) status = 'PAID';
    else if (issueDate <= TODAY) status = 'ISSUED';
    else status = 'DRAFT';
  }
}
```

- [ ] **Step 3: INSERT invoice**

```sql
INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id,
  invoice_code, period, issue_date, due_date,
  subtotal_amount, total_amount, status, issued_at, issued_by)
VALUES (...) RETURNING id;
```

- [ ] **Step 4: INSERT invoice_lines**

```
RENT line: item_type='RENT', description='Tiền thuê tháng {period}[ (pro-rata {activeDays}/{dim} ngày)]'
ELECTRICITY: item_type='ELECTRICITY', quantity={consumption}, unit='kWh', unit_price=3800
WATER:       item_type='WATER', quantity={consumption}, unit='m³', unit_price=22000
SERVICE:     item_type='SERVICE', description='Phí {service.name} tháng {period}', unit_price=subPrice
```

- [ ] **Step 5: INSERT payment cho hóa đơn PAID**

```sql
INSERT INTO payment (org_id, building_id, invoice_id, contract_id, tenant_id,
  payment_code, amount, method, status, paid_at, confirmed_by, confirmed_at)
VALUES ($..., 'PAY-' || $invoiceCode, $totalAmount, 'BANK_TRANSFER', 'CONFIRMED',
  $dueDate::timestamptz, $managerId, $dueDate::timestamptz);

UPDATE invoice SET paid_amount=$totalAmount, status='PAID' WHERE id=$invoiceId;
```

- [ ] **Step 6: INSERT receivable cho hóa đơn ISSUED**

```sql
INSERT INTO receivable (org_id, building_id, contract_id, tenant_id, invoice_id,
  type, amount, paid_amount, due_date, status, description)
VALUES (..., 'INVOICE_DEBT', $totalAmount, 0, $dueDate, 'OPEN', 'Công nợ ' || $invoiceCode || ' tháng ' || $period);
```

- [ ] **Step 7: COMMIT transaction và in bảng tóm tắt**

```js
await client.query('COMMIT');
console.log('\n✅ SEED HOÀN TẤT');
console.log('Số liệu tổng hợp:');
console.log(`  • Tòa nhà: 3 (Vinhomes Ocean Park 1, 2, 3)`);
console.log(`  • Owner: 1, Manager: 3, Admin: 1`);
console.log(`  • Căn hộ: ${totalApts} (80/tòa, 3 khu A/B/C, 10 tầng)`);
console.log(`  • Hợp đồng: ${totalContracts} (ACTIVE: ${activeCount}, EXPIRED: ${expiredCount})`);
console.log(`  • Deposits HELD: ${heldCount}, REFUNDED: ${refundedCount}`);
console.log(`  • Invoices PAID: ${paidCount}, ISSUED: ${issuedCount}`);
console.log(`  • Payments: ${paymentCount}`);
console.log(`  • Receivables: ${receivableCount}`);
```

- [ ] **Step 8: Thêm script npm**

Trong `api/package.json`:
```json
"seed:vinhomes": "node src/db/seed_vinhomes.js"
```

- [ ] **Step 9: Chạy full seed và xác nhận**

```bash
cd d:\resihub\api && npm run seed:vinhomes
```

Expected: Toàn bộ hoàn thành, không lỗi, stats hợp lệ.

---

## Checklist tự kiểm tra trước khi done

- [ ] Script chạy từ đầu đến cuối không lỗi
- [ ] Không có hợp đồng chồng lấn trên cùng 1 căn hộ
- [ ] Deposit của HĐ ACTIVE: status='HELD', chỉ có transaction type='collect'
- [ ] Deposit của HĐ EXPIRED: status='REFUNDED', có cả 'collect' và 'refund', refund_due_date = end_date + 3..5 ngày
- [ ] Pro-rata đúng cho tháng đầu và tháng cuối (activeDays < daysInMonth → isProrated=true)
- [ ] Tháng < 2026-11: invoice status='PAID' + payment tương ứng
- [ ] Tháng = 2026-11 và issueDate ≤ 2026-11-06: invoice status='ISSUED' + receivable
- [ ] Meter readings: `current_reading >= previous_reading` luôn đúng (reading tăng đều)
- [ ] Service giá lấy từ contract_service_price (nếu có) trước service_catalog
- [ ] `npm run seed:vinhomes` hoạt động trong thư mục `api/`

---

## Tài khoản demo sau khi seed

| Role | Email | Mật khẩu | Phạm vi |
|------|-------|-----------|---------|
| SYS_ADMIN | admin@resihub.vn | Admin@123456 | Toàn hệ thống |
| OWNER | owner.vop@resihub.vn | Demo@123456 | 3 tòa (VOP-1,2,3) |
| MANAGER | manager.vop1@resihub.vn | Demo@123456 | VOP-1 |
| MANAGER | manager.vop2@resihub.vn | Demo@123456 | VOP-2 |
| MANAGER | manager.vop3@resihub.vn | Demo@123456 | VOP-3 |
| RESIDENT | tenant1@resihub.vn | Demo@123456 | Căn hộ của cư dân |

