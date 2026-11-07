/**
 * seed_vinhomes.js — Seed dữ liệu thực tế Vinhomes Ocean Park 1, 2, 3 cho ResiHub
 *
 * Cấu trúc dữ liệu:
 *   1. Xóa toàn bộ dữ liệu cũ (TRUNCATE CASCADE)
 *   2. Organization, 4 Roles (OWNER, MANAGER, RESIDENT, SYS_ADMIN), System Settings, 7 Service Catalog
 *   3. 1 Owner dùng chung + 3 Tòa nhà (Vinhomes Ocean Park 1, 2, 3) + 3 Manager riêng biệt + 1 SYS_ADMIN
 *   4. Mỗi tòa: 3 Khu (Khu A, Khu B, Khu C), 10 Tầng (Tầng 1..10), 80 căn hộ/tòa (8 căn/tầng) = 240 căn hộ
 *      — Tỷ lệ lấp đầy khác nhau tự nhiên giữa 3 tòa (VOP-1 ~80%, VOP-2 ~71.3%, VOP-3 ~62.5%)
 *      — Có đầy đủ trạng thái OCCUPIED, AVAILABLE, RESERVED, MAINTENANCE
 *   5. Hồ sơ dân cư (~270 cư dân tên tiếng Việt thực tế, CCCD, SĐT, tài khoản RESIDENT)
 *   6. Hợp đồng thuê nhà (~245 hợp đồng trải dài 2025 -> 2027, không chồng lấn kỳ hạn):
 *      — Toàn bộ hợp đồng ACTIVE có end_date random ngày & tháng trong năm 2027
 *      — Lịch sử ký mới / hết hạn / chấm dứt sớm phân bổ tự nhiên qua các tháng giúp biểu đồ lấp đầy 12 kỳ uốn lượn chân thực
 *      — Sổ cọc & giao dịch thu/hoàn cọc (hoàn trong 3-5 ngày sau chấm dứt, không cấn trừ tiền thuê)
 *   7. Đồng hồ điện/nước & chỉ số hàng tháng biến thiên theo mùa (đông thấp, hè cao điểm) đến hết 10/2026 & 11/2026 (CONFIRMED)
 *   8. Hóa đơn hàng tháng từ 01/2025 đến hết 10/2026 (tính đúng công thức + pro-rata chính xác theo ngày):
 *      — Có độ trễ thanh toán thực tế giữa Phát hành, Tất toán HĐ và Thực thu
 *      — Công nợ phân bổ đầy đủ cả 5 nhóm tuổi nợ (Chưa đến hạn, 1-15 ngày, 16-30 ngày, 31-60 ngày, >60 ngày)
 *      — Chưa sinh hóa đơn tháng 11/2026 để người dùng tự click Sinh hóa đơn hàng loạt tháng 11 trên UI
 *      — Kèm dữ liệu Phiếu giữ chỗ (reservation) & Yêu cầu bảo trì SLA (service_request) chân thực
 */

import pg from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import {
  roundVND,
  calcProrata,
} from '../services/pricing.js';
import {
  toDateOnlyYmd,
  addDaysYmd,
  diffDaysYmd,
  getMonthBoundsYmd,
  resolveContractLastActiveDay,
  computeContractRentPeriodCharge,
  computeSubscriptionPeriodCharge,
  resolveUtilityUnitPrice,
} from '../services/serviceBilling.js';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    `postgres://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'postgres'}@${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || '5433'}/${process.env.POSTGRES_DB || 'resihub'}`,
});

// ─── Helpers ────────────────────────────────────────────────────────────────

export function phone(n) {
  return `09${String(n).padStart(8, '0')}`;
}

export function idNumber(n) {
  return `07900${String(n).padStart(7, '0')}`;
}

export async function hashPwd(plain) {
  return bcrypt.hash(plain, 10);
}

export function getDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(ymd, n) {
  return addDaysYmd(ymd, n);
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

// Deterministic pseudo-random helper for reproducible, organic test data
let rngState = 20261107;
export function seededRandom() {
  rngState = (rngState * 1664525 + 1013904223) % 4294967296;
  return rngState / 4294967296;
}

export function randomInt(a, b) {
  return Math.floor(seededRandom() * (b - a + 1)) + a;
}

/**
 * Sinh ngày kết thúc hợp đồng ACTIVE ngẫu nhiên trong năm 2027 (random tháng 01..12, random ngày 01..28)
 */
export function randomActiveEndDate2027() {
  const month = randomInt(1, 12);
  const maxDay = getDaysInMonth(2027, month);
  const day = randomInt(1, maxDay);
  return `2027-${pad2(month)}-${pad2(day)}`;
}

export function eachMonth(startYmd, endYm) {
  const months = [];
  let [y, m] = startYmd.slice(0, 7).split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push({ year: y, month: m, period: `${y}-${pad2(m)}` });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return months;
}

/**
 * Hệ số thời tiết miền Bắc (Hà Nội / Hưng Yên) cho tiêu thụ Điện & Nước
 * Giúp biểu đồ doanh thu có nhịp điệu mùa vụ tự nhiên (Đông thấp - Hè nắng nóng cao điểm)
 */
export function getSeasonalMultipliers(year, month) {
  const elByMonth = {
    1: 0.78,
    2: 0.74,
    3: 0.86,
    4: 0.98,
    5: 1.28,
    6: 1.56,
    7: 1.62,
    8: 1.48,
    9: 1.24,
    10: 0.96,
    11: 0.85,
    12: 0.80,
  };
  const wtByMonth = {
    1: 0.88,
    2: 0.84,
    3: 0.92,
    4: 1.00,
    5: 1.15,
    6: 1.28,
    7: 1.32,
    8: 1.25,
    9: 1.12,
    10: 0.98,
    11: 0.92,
    12: 0.90,
  };
  // Năm 2026 nhu cầu sinh hoạt tăng nhẹ ~4% so với 2025
  const yearFactor = year >= 2026 ? 1.04 : 1.0;
  return {
    elFactor: (elByMonth[month] || 1.0) * yearFactor,
    wtFactor: (wtByMonth[month] || 1.0) * yearFactor,
  };
}

/**
 * Kiểm tra chồng lấn kỳ hạn hợp đồng trên cùng 1 căn hộ:
 * Khoảng hiệu lực của hợp đồng là [startDate, effectiveEndDate] (inclusive ngày hiệu lực cuối).
 */
export function hasOverlap(existingContracts, aptId, startDate, effectiveEndDate) {
  return existingContracts.some(
    (c) =>
      c.apartmentId === aptId &&
      c.startDate <= effectiveEndDate &&
      c.effectiveEndDate >= startDate
  );
}

const LAST_NAMES = [
  'Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Vũ', 'Đặng',
  'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý', 'Đinh', 'Phan', 'Trịnh', 'Cao', 'Tô', 'Lưu',
];
const MID_NAMES = [
  'Văn', 'Thị', 'Hữu', 'Minh', 'Thanh', 'Quốc', 'Ngọc', 'Kim', 'Đức', 'Xuân', 'Gia', 'Bảo',
];
const FIRST_NAMES = [
  'An', 'Bình', 'Chi', 'Dung', 'Giang', 'Hà', 'Khoa', 'Lan', 'Minh', 'Nam',
  'Phúc', 'Quân', 'Sơn', 'Thành', 'Uyên', 'Việt', 'Xuân', 'Yến', 'Hùng', 'Linh', 'Tâm', 'Khánh',
];

export function randomName(i) {
  const ln = LAST_NAMES[i % LAST_NAMES.length];
  const mn = MID_NAMES[(i * 3 + 1) % MID_NAMES.length];
  const fn = FIRST_NAMES[(i * 7 + 2) % FIRST_NAMES.length];
  return `${ln} ${mn} ${fn}`;
}

// ─── Main Seed ──────────────────────────────────────────────────────────────

export async function seed() {
  const client = await pool.connect();
  try {
    console.log('══════════════════════════════════════════════════════════════════');
    console.log('  ResiHub — Vinhomes Ocean Park 1, 2, 3 Realistic Data Seed');
    console.log('══════════════════════════════════════════════════════════════════');

    await client.query('BEGIN');
    await client.query("SET LOCAL app.allow_test_cleanup = 'true'");

    // ── TASK 1: Xóa dữ liệu cũ ─────────────────────────────────────────────
    console.log('\n[1/8] Xóa dữ liệu cũ...');
    await client.query(`
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
        ai_suggestion, idempotency_key, cron_job_run,
        system_setting, service_catalog,
        apartment, zone, floor, building,
        person, owner, role, organization
      RESTART IDENTITY CASCADE;
    `);
    console.log('   ✓ Đã xóa toàn bộ dữ liệu cũ.');

    // ── TASK 2: Organization, Roles, System Settings & Service Catalog ─────
    console.log('\n[2/8] Tạo Organization, Roles, System Settings & Service Catalog...');

    const { rows: [org] } = await client.query(`
      INSERT INTO organization (id, name, tax_code, settings, payment_account)
      VALUES (
        '11111111-1111-4111-8111-111111111111',
        'Tập đoàn Quản lý Bất động sản ResiHub',
        '0312345678',
        '{"currency": "VND", "timezone": "Asia/Ho_Chi_Minh"}',
        '{"bank": "Vietcombank", "account_no": "99988877766", "account_name": "RESIHUB CORP", "type": "corporate"}'
      )
      RETURNING id;
    `);
    const orgId = org.id;

    const rolesMeta = [
      { code: 'OWNER',     name: 'Chủ đầu tư / Chủ nhà', scope: 'org' },
      { code: 'MANAGER',   name: 'Quản lý tòa nhà',        scope: 'building' },
      { code: 'RESIDENT',  name: 'Cư dân',                  scope: 'building' },
      { code: 'SYS_ADMIN', name: 'Quản trị hệ thống',      scope: 'org' },
    ];
    const roleIdMap = {};
    for (const r of rolesMeta) {
      const { rows: [row] } = await client.query(
        `INSERT INTO role (org_id, code, name, scope) VALUES ($1, $2, $3, $4) RETURNING id;`,
        [orgId, r.code, r.name, r.scope]
      );
      roleIdMap[r.code] = row.id;
    }

    // System Settings
    await client.query(
      `INSERT INTO system_setting (org_id, key, value, description)
       SELECT $1::uuid, s.key, s.val::jsonb, s.descr
       FROM (VALUES
         ('billing_config', '{"billing_day": 1, "payment_due_days": 5, "due_date_offset_days": 5, "late_fee_grace_days": 5, "late_fee_per_day": 100000, "late_fee_cap": null, "meter_anomaly_threshold_pct": 30, "reminder_days": [3, 7, 15], "late_fee_percent": 0, "electricity_default_price": 3800, "water_default_price": 22000}', 'Cấu hình chu kỳ chốt chỉ số, phát hành hóa đơn và nhắc nợ (FR-005, FR-030..FR-036)'),
         ('sla_config', '{"response_hours": 2, "normal_resolve_hours": 24, "urgent_resolve_hours": 4, "deposit_refund_days": 5, "reopen_window_days": 3}', 'Cam kết thời gian xử lý sự cố (SLA) và tất toán cọc (3-5 ngày)'),
         ('contact_config', '{"working_hours": "08:00 – 18:00 (Thứ 2 – Thứ 7)", "technical_hotline": "1900 6868", "security_hotline": "1900 9119", "emergency_phone": "0909 113 114", "support_email": "support@resihub.vn"}', 'Thông tin liên hệ Ban quản lý, kỹ thuật và khẩn cấp hiển thị trên Cổng cư dân'),
         ('approval_config', '{"allow_self_approval": false}', 'Cấu hình quy tắc phê duyệt 4 mắt (Four-eyes)'),
         ('reservation_cancel_policy', '{"max_hold_days":30,"public_max_hold_days":7,"full_refund_before_days":3,"partial_refund_pct":50,"default_hold_amount":2000000}', 'Chính sách đặt cọc và hủy giữ chỗ'),
         ('ai_config', '{"enabled": true, "cccd_extract_enabled": true, "contract_extract_enabled": true, "meter_ocr_enabled": true, "ticket_triage_enabled": true, "model": "gemini-2.5-flash", "confidence_threshold": 0.75, "meter_ocr_threshold": 0.8, "triage_threshold": 0.7, "monthly_budget_vnd": 500000, "monthly_token_limit": 2000000, "warn_percent": 80, "suggestion_ttl_hours": 72}', 'Cấu hình AI Gateway')
       ) AS s(key, val, descr);`,
      [orgId]
    );

    // Service Catalog
    const catalogServicesMeta = [
      { code: 'ELECTRICITY',       name: 'Điện sinh hoạt',          category: 'ELECTRICITY', billing_type: 'METERED',  unit: 'kWh',       unit_price: 3800,    description: 'Tính theo chỉ số công tơ điện hàng tháng' },
      { code: 'WATER',             name: 'Nước sạch sinh hoạt',     category: 'WATER',       billing_type: 'METERED',  unit: 'm³',        unit_price: 22000,   description: 'Tính theo đồng hồ nước từng căn hộ' },
      { code: 'INTERNET_FIBER',    name: 'Internet Cáp quang 300M', category: 'INTERNET',    billing_type: 'FIXED',    unit: 'tháng',     unit_price: 220000,  description: 'Đường truyền tốc độ cao ổn định riêng cho căn hộ' },
      { code: 'MOTORBIKE_PARKING', name: 'Gửi xe máy hầm B1',       category: 'PARKING',     billing_type: 'QUANTITY', unit: 'xe/tháng',  unit_price: 120000,  description: 'Thẻ từ gửi xe máy định danh tại tầng hầm' },
      { code: 'CAR_PARKING',       name: 'Đỗ xe ô tô hầm B2',       category: 'PARKING',     billing_type: 'QUANTITY', unit: 'xe/tháng',  unit_price: 1250000, description: 'Vị trí đỗ ô tô có mái che tại hầm B2' },
      { code: 'CLEANING_WEEKLY',   name: 'Dọn vệ sinh căn hộ',      category: 'CLEANING',    billing_type: 'QUANTITY', unit: 'lần/tháng', unit_price: 150000,  description: 'Dịch vụ dọn phòng định kỳ theo yêu cầu cư dân' },
      { code: 'MANAGEMENT_FEE',    name: 'Phí quản lý vận hành',    category: 'MANAGEMENT',  billing_type: 'FIXED',    unit: 'tháng',     unit_price: 350000,  description: 'An ninh 24/7, lễ tân, chiếu sáng và vệ sinh khu chung' },
    ];
    const serviceCatalogMap = {};
    const catalogItems = [];
    for (const sc of catalogServicesMeta) {
      const { rows: [row] } = await client.query(
        `INSERT INTO service_catalog (org_id, code, name, category, billing_type, unit, unit_price, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *;`,
        [orgId, sc.code, sc.name, sc.category, sc.billing_type, sc.unit, sc.unit_price, sc.description]
      );
      serviceCatalogMap[sc.code] = row;
      catalogItems.push({ ...row, is_active: true });
    }
    console.log('   ✓ Org, Roles, System Settings & Service Catalog (7 dịch vụ) đã tạo.');

    // ── TASK 3: 1 Owner + 3 Tòa nhà Vinhomes Ocean Park + 3 Manager + Admin ─
    console.log('\n[3/8] Tạo 1 Owner, 3 Tòa nhà Vinhomes Ocean Park 1/2/3, 3 Manager & Admin...');

    const defaultPassword = await hashPwd('Demo@123456');
    const adminPassword = await hashPwd('Admin@123456');

    // 1. SYS_ADMIN
    const { rows: [adminPerson] } = await client.query(
      `INSERT INTO person (id, org_id, full_name, phone, email, id_number, nationality, address)
       VALUES ('22222222-2222-4222-9222-000000000001', $1, 'Quản trị viên ResiHub', '0900000001', 'admin@resihub.vn', '079000000001', 'Việt Nam', 'Hà Nội')
       RETURNING id;`,
      [orgId]
    );
    const { rows: [adminUser] } = await client.query(
      `INSERT INTO app_user (id, person_id, auth_uid, password_hash, status)
       VALUES ('22222222-2222-4222-8222-000000000001', $1, 'admin-resihub', $2, 'ACTIVE')
       RETURNING id;`,
      [adminPerson.id, adminPassword]
    );
    await client.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, NULL);`,
      [adminUser.id, roleIdMap.SYS_ADMIN]
    );

    // 2. 1 Owner chung cho cả 3 tòa
    const { rows: [ownerPerson] } = await client.query(
      `INSERT INTO person (id, org_id, full_name, phone, email, id_number, nationality, address)
       VALUES ('22222222-2222-4222-9222-000000000002', $1, 'Chủ đầu tư Vinhomes Ocean Park', $2, 'owner.vop@resihub.vn', $3, 'Việt Nam', 'Khu đô thị Vinhomes Ocean Park, Gia Lâm, Hà Nội')
       RETURNING id;`,
      [orgId, phone(5000001), idNumber(5000001)]
    );
    const { rows: [ownerRec] } = await client.query(
      `INSERT INTO owner (id, org_id, person_id, full_name, phone, email)
       VALUES ('22222222-2222-4222-7222-000000000002', $1, $2, 'Chủ đầu tư Vinhomes Ocean Park', $3, 'owner.vop@resihub.vn')
       RETURNING id;`,
      [orgId, ownerPerson.id, phone(5000001)]
    );
    const ownerId = ownerRec.id;

    const { rows: [ownerUser] } = await client.query(
      `INSERT INTO app_user (id, person_id, auth_uid, password_hash, status)
       VALUES ('22222222-2222-4222-8222-000000000002', $1, 'owner-vop', $2, 'ACTIVE')
       RETURNING id;`,
      [ownerPerson.id, defaultPassword]
    );
    await client.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, NULL);`,
      [ownerUser.id, roleIdMap.OWNER]
    );

    // 3. 3 Tòa nhà Vinhomes Ocean Park 1, 2, 3 & 3 Manager riêng biệt
    const buildingsMeta = [
      { id: '33333333-3333-4333-8333-000000000001', mgPersonId: '22222222-2222-4222-9222-000000000011', mgUserId: '22222222-2222-4222-8222-000000000011', code: 'VOP-1', name: 'Vinhomes Ocean Park 1', address: 'Đại đô thị Vinhomes Ocean Park 1, Đa Tốn, Gia Lâm, Hà Nội', num: 1, rentPremium: 400000, mgName: 'Nguyễn Minh Quản Lý VOP1', mgEmail: 'manager.vop1@resihub.vn', mgPhone: phone(5000011), mgIdNo: idNumber(5000011) },
      { id: '33333333-3333-4333-8333-000000000002', mgPersonId: '22222222-2222-4222-9222-000000000012', mgUserId: '22222222-2222-4222-8222-000000000012', code: 'VOP-2', name: 'Vinhomes Ocean Park 2', address: 'Đại đô thị Vinhomes Ocean Park 2 - The Empire, Văn Giang, Hưng Yên', num: 2, rentPremium: 100000, mgName: 'Trần Hoàng Quản Lý VOP2', mgEmail: 'manager.vop2@resihub.vn', mgPhone: phone(5000012), mgIdNo: idNumber(5000012) },
      { id: '33333333-3333-4333-8333-000000000003', mgPersonId: '22222222-2222-4222-9222-000000000013', mgUserId: '22222222-2222-4222-8222-000000000013', code: 'VOP-3', name: 'Vinhomes Ocean Park 3', address: 'Đại đô thị Vinhomes Ocean Park 3 - The Crown, Văn Lâm, Hưng Yên', num: 3, rentPremium: -200000, mgName: 'Lê Thanh Quản Lý VOP3', mgEmail: 'manager.vop3@resihub.vn', mgPhone: phone(5000013), mgIdNo: idNumber(5000013) },
    ];

    const buildings = [];
    const managerByBuilding = {};

    for (const bm of buildingsMeta) {
      const { rows: [bldg] } = await client.query(
        `INSERT INTO building (id, org_id, owner_id, name, code, address, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
         RETURNING id;`,
        [bm.id, orgId, ownerId, bm.name, bm.code, bm.address]
      );

      const { rows: [mgPerson] } = await client.query(
        `INSERT INTO person (id, org_id, full_name, phone, email, id_number, nationality, address)
         VALUES ($1, $2, $3, $4, $5, $6, 'Việt Nam', $7)
         RETURNING id;`,
        [bm.mgPersonId, orgId, bm.mgName, bm.mgPhone, bm.mgEmail, bm.mgIdNo, bm.address]
      );

      const { rows: [mgUser] } = await client.query(
        `INSERT INTO app_user (id, person_id, auth_uid, password_hash, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')
         RETURNING id;`,
        [bm.mgUserId, mgPerson.id, `manager-vop-${bm.num}`, defaultPassword]
      );

      await client.query(
        `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3);`,
        [mgUser.id, roleIdMap.MANAGER, bldg.id]
      );

      buildings.push({ id: bldg.id, code: bm.code, name: bm.name, num: bm.num, rentPremium: bm.rentPremium });
      managerByBuilding[bldg.id] = mgUser.id;
      console.log(`   ✓ [${bm.code}] ${bm.name} — Owner: owner.vop@resihub.vn | Manager: ${bm.mgEmail}`);
    }

    // ── TASK 4: Zones (Khu A, B, C) + Floors (1..10) + Apartments (80/tòa) ──
    console.log('\n[4/8] Tạo 3 Khu (A, B, C), 10 Tầng và 80 Căn hộ mỗi tòa (Tổng 240 căn)...');

    const zoneMeta = [
      { code: 'A', name: 'Khu A' },
      { code: 'B', name: 'Khu B' },
      { code: 'C', name: 'Khu C' },
    ];
    const aptLayoutPerFloor = [
      { zone: 'A', no: 1, bedrooms: 1, area: 43, rentBase: 6900000 },
      { zone: 'A', no: 2, bedrooms: 2, area: 59, rentBase: 9600000 },
      { zone: 'A', no: 3, bedrooms: 1, area: 40, rentBase: 6600000 },
      { zone: 'B', no: 1, bedrooms: 2, area: 66, rentBase: 10800000 },
      { zone: 'B', no: 2, bedrooms: 3, area: 88, rentBase: 14500000 },
      { zone: 'B', no: 3, bedrooms: 2, area: 62, rentBase: 9900000 },
      { zone: 'C', no: 1, bedrooms: 1, area: 46, rentBase: 7400000 },
      { zone: 'C', no: 2, bedrooms: 2, area: 72, rentBase: 11400000 },
    ];

    const zonesMap = {};
    const floorsMap = {};
    const aptsByBuilding = {};

    for (const bldg of buildings) {
      zonesMap[bldg.id] = {};
      for (const zm of zoneMeta) {
        const { rows: [zRow] } = await client.query(
          `INSERT INTO zone (org_id, building_id, code, name)
           VALUES ($1, $2, $3, $4)
           RETURNING id;`,
          [orgId, bldg.id, zm.code, zm.name]
        );
        zonesMap[bldg.id][zm.code] = zRow.id;
      }

      floorsMap[bldg.id] = [];
      for (let level = 1; level <= 10; level++) {
        const { rows: [fRow] } = await client.query(
          `INSERT INTO floor (building_id, level, name)
           VALUES ($1, $2, $3)
           RETURNING id;`,
          [bldg.id, level, level === 1 ? 'Tầng 1 (Trệt)' : `Tầng ${level}`]
        );
        floorsMap[bldg.id].push({ id: fRow.id, level });
      }

      aptsByBuilding[bldg.id] = [];
      for (const floor of floorsMap[bldg.id]) {
        for (const spec of aptLayoutPerFloor) {
          const aptCode = `${bldg.num}${floor.level}${spec.zone}${pad2(spec.no)}`;
          const zoneId = zonesMap[bldg.id][spec.zone];
          // Giá thuê biến thiên tự nhiên theo tòa, tầng, view hồ/nội thất (làm tròn 100.000đ)
          const viewBonus = (floor.level >= 6 && (spec.no === 1 || spec.no === 2)) ? 300000 : 0;
          const furnitureVar = ((floor.level + spec.no + bldg.num) % 3 - 1) * 100000;
          const baseRent = spec.rentBase + bldg.rentPremium + floor.level * 100000 + viewBonus + furnitureVar;

          const { rows: [aptRec] } = await client.query(
            `INSERT INTO apartment (
               building_id, floor_id, zone_id, code, area_m2, type, bedrooms, base_rent, status, amenities
             )
             VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, 'AVAILABLE',
               '{"wifi": true, "air_conditioner": true, "water_heater": true, "kitchen": true, "balcony": true}'
             )
             RETURNING id;`,
            [bldg.id, floor.id, zoneId, aptCode, spec.area, `${spec.bedrooms}PN`, spec.bedrooms, baseRent]
          );

          aptsByBuilding[bldg.id].push({
            id: aptRec.id,
            code: aptCode,
            buildingId: bldg.id,
            buildingCode: bldg.code,
            floorId: floor.id,
            floorLevel: floor.level,
            zoneCode: spec.zone,
            zoneId,
            bedrooms: spec.bedrooms,
            baseRent,
          });
        }
      }
    }

    const totalApts = Object.values(aptsByBuilding).reduce((s, arr) => s + arr.length, 0);
    console.log(`   ✓ Đã tạo ${buildings.length * 3} khu, ${buildings.length * 10} tầng, ${totalApts} căn hộ (80 căn/tòa).`);

    // ── TASK 5: Hồ sơ dân cư (Tenants) ──────────────────────────────────────
    console.log('\n[5/8] Tạo hồ sơ dân cư (Tenants & Resident Accounts)...');

    let phoneCounter = 7000001;
    let idNoCounter = 7000001;
    let tenantIdx = 1;
    const tenantsByBuilding = {};

    // Tạo 92 tenant/tòa = 276 cư dân để đủ gán cho tất cả hợp đồng lịch sử & đang hiệu lực
    for (const bldg of buildings) {
      tenantsByBuilding[bldg.id] = [];
      const mgUserId = managerByBuilding[bldg.id];

      for (let i = 0; i < 92; i++) {
        const fullName = randomName(tenantIdx);
        const tPhone = phone(phoneCounter++);
        const tIdNo = idNumber(idNoCounter++);
        const tEmail = `tenant${tenantIdx}@resihub.vn`;
        const birthYear = 1978 + (tenantIdx % 25);
        const birthMonth = pad2((tenantIdx % 12) + 1);
        const birthDay = pad2((tenantIdx % 28) + 1);
        const dob = `${birthYear}-${birthMonth}-${birthDay}`;

        const { rows: [pRow] } = await client.query(
          `INSERT INTO person (
             org_id, full_name, phone, email, dob, id_number, nationality, address, created_by
           )
           VALUES ($1, $2, $3, $4, $5::date, $6, 'Việt Nam', 'Hà Nội', $7)
           RETURNING id;`,
          [orgId, fullName, tPhone, tEmail, dob, tIdNo, mgUserId]
        );

        const { rows: [tRow] } = await client.query(
          `INSERT INTO tenant (
             person_id, org_id, type, status, desired_building_id, created_by
           )
           VALUES ($1, $2, 'primary', 'APPROVED', $3, $4)
           RETURNING id;`,
          [pRow.id, orgId, bldg.id, mgUserId]
        );

        const { rows: [uRow] } = await client.query(
          `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
           VALUES ($1, $2, $3, 'ACTIVE')
           RETURNING id;`,
          [pRow.id, `resident-${tenantIdx}`, defaultPassword]
        );

        await client.query(
          `INSERT INTO user_role (user_id, role_id, building_id)
           VALUES ($1, $2, $3);`,
          [uRow.id, roleIdMap.RESIDENT, bldg.id]
        );

        tenantsByBuilding[bldg.id].push({
          tenantId: tRow.id,
          personId: pRow.id,
          userId: uRow.id,
          name: fullName,
          phone: tPhone,
          email: tEmail,
          buildingId: bldg.id,
        });

        tenantIdx++;
      }
    }

    const totalTenants = Object.values(tenantsByBuilding).reduce((s, arr) => s + arr.length, 0);
    console.log(`   ✓ Đã tạo ${totalTenants} hồ sơ dân cư (tenant1..tenant${tenantIdx - 1}@resihub.vn).`);

    // ── TASK 6: Hợp đồng thuê (2025 -> 2027) + Deposits + Subscriptions + Reservations ─
    console.log('\n[6/8] Tạo Hợp đồng thuê (ACTIVE kết thúc random trong 2027), Sổ cọc & Đăng ký dịch vụ...');

    const existingContracts = [];
    const contractList = [];
    let overlapCheckedCount = 0;
    let contractCounter = 0;

    // Cấu hình số lượng căn hộ theo kịch bản riêng cho từng tòa để tỷ lệ lấp đầy khác nhau tự nhiên:
    // - VOP-1: 64 căn OCCUPIED (80.0%), 3 RESERVED, 2 MAINTENANCE, 11 AVAILABLE
    // - VOP-2: 57 căn OCCUPIED (71.3%), 2 RESERVED, 2 MAINTENANCE, 19 AVAILABLE
    // - VOP-3: 50 căn OCCUPIED (62.5%), 3 RESERVED, 1 MAINTENANCE, 26 AVAILABLE
    const buildingScenarioConfig = {
      1: { longTermCount: 24, rolloverCount: 16, rampUp2026Count: 24, vacated2026Count: 7, reservedCount: 3, maintenanceCount: 2 },
      2: { longTermCount: 20, rolloverCount: 15, rampUp2026Count: 22, vacated2026Count: 8, reservedCount: 2, maintenanceCount: 2 },
      3: { longTermCount: 16, rolloverCount: 14, rampUp2026Count: 20, vacated2026Count: 8, reservedCount: 3, maintenanceCount: 1 },
    };

    const longTermStarts = [
      '2025-01-01', '2025-01-08', '2025-01-15', '2025-02-01', '2025-02-10',
      '2025-03-01', '2025-03-18', '2025-04-01', '2025-04-12', '2025-05-01',
      '2025-05-15', '2025-06-01', '2025-06-20', '2025-07-01', '2025-08-01',
      '2025-08-15', '2025-09-01', '2025-09-10', '2025-10-01', '2025-10-15',
      '2025-11-01', '2025-11-12', '2025-12-01', '2025-12-10',
    ];

    // Kịch bản nối tiếp 2 HĐ (có khoảng trống 10-45 ngày hoặc nối tiếp, trải từ giữa 2025 sang 2026)
    const rolloverSpecs = [
      { start1: '2025-01-01', end1: '2025-07-01', last1: '2025-06-30', start2: '2025-07-15' },
      { start1: '2025-01-10', end1: '2025-08-01', last1: '2025-07-31', start2: '2025-08-01' },
      { start1: '2025-02-01', end1: '2025-08-16', last1: '2025-08-15', start2: '2025-09-01' },
      { start1: '2025-02-15', end1: '2025-09-01', last1: '2025-08-31', start2: '2025-10-01' },
      { start1: '2025-03-01', end1: '2025-10-01', last1: '2025-09-30', start2: '2025-10-15' },
      { start1: '2025-03-12', end1: '2025-11-01', last1: '2025-10-31', start2: '2025-12-01' },
      { start1: '2025-04-01', end1: '2025-12-16', last1: '2025-12-15', start2: '2026-01-10' },
      { start1: '2025-04-15', end1: '2026-01-20', last1: '2026-01-19', start2: '2026-03-01' },
      { start1: '2025-05-01', end1: '2026-02-01', last1: '2026-01-31', start2: '2026-03-10' },
      { start1: '2025-05-10', end1: '2026-02-15', last1: '2026-02-14', start2: '2026-04-01' },
      { start1: '2025-06-01', end1: '2026-02-20', last1: '2026-02-19', start2: '2026-04-12' },
      { start1: '2025-06-15', end1: '2026-03-01', last1: '2026-02-28', start2: '2026-05-01' },
      { start1: '2025-07-01', end1: '2026-04-01', last1: '2026-03-31', start2: '2026-05-15' },
      { start1: '2025-07-15', end1: '2026-05-01', last1: '2026-04-30', start2: '2026-06-01' },
      { start1: '2025-08-01', end1: '2026-06-16', last1: '2026-06-15', start2: '2026-07-01' },
      { start1: '2025-09-01', end1: '2026-07-01', last1: '2026-06-30', start2: '2026-08-05' },
    ];

    // Kịch bản các căn mới lấp đầy dần qua các tháng của năm 2026 (tạo đường cong tăng trưởng tự nhiên)
    const rampUp2026Starts = [
      '2026-01-01', '2026-01-15', '2026-02-05', '2026-03-01', '2026-03-12',
      '2026-03-20', '2026-04-01', '2026-04-10', '2026-04-18', '2026-05-01',
      '2026-05-12', '2026-05-22', '2026-06-01', '2026-06-10', '2026-06-18',
      '2026-07-01', '2026-07-14', '2026-08-01', '2026-08-16', '2026-09-01',
      '2026-09-12', '2026-10-05', '2026-10-18', '2026-11-01',
    ];

    // Kịch bản các căn có HĐ lịch sử đã trả phòng trong 2026 (tạo nhịp giảm nhẹ ở một vài tháng như tháng 2 Tết, tháng 8 & tháng 10)
    const vacated2026Specs = [
      { start: '2025-02-01', end: '2026-02-01', last: '2026-01-31' },
      { start: '2025-03-01', end: '2026-02-15', last: '2026-02-14' },
      { start: '2025-04-10', end: '2026-04-10', last: '2026-04-09' },
      { start: '2025-05-01', end: '2026-05-01', last: '2026-04-30' },
      { start: '2025-07-01', end: '2026-07-20', last: '2026-07-19' },
      { start: '2025-08-01', end: '2026-08-15', last: '2026-08-14' },
      { start: '2025-09-01', end: '2026-09-25', last: '2026-09-24' },
      { start: '2025-10-01', end: '2026-10-20', last: '2026-10-19' },
    ];

    let heldDepositCount = 0;
    let refundedDepositCount = 0;
    let subscriptionCount = 0;
    let overridePriceCount = 0;
    const reservedApts = [];
    const maintenanceApts = [];

    for (const bldg of buildings) {
      const apts = aptsByBuilding[bldg.id];
      const bTenants = tenantsByBuilding[bldg.id];
      const mgUserId = managerByBuilding[bldg.id];
      const cfg = buildingScenarioConfig[bldg.num];
      let bTenantCursor = 0;
      let aptCursor = 0;

      // 1. Nhóm HĐ ổn định dài hạn (2025 -> 2027)
      for (let i = 0; i < cfg.longTermCount; i++) {
        const apt = apts[aptCursor++];
        const tenant = bTenants[bTenantCursor++];
        const startDate = longTermStarts[i % longTermStarts.length];
        const endDate = randomActiveEndDate2027();
        const effectiveEndDate = addDays(endDate, -1);
        const billingDay = ((i * 3) % 28) + 1;
        const paymentDueDays = billingDay >= 23 ? 15 : 5;

        overlapCheckedCount++;
        if (hasOverlap(existingContracts, apt.id, startDate, effectiveEndDate)) {
          throw new Error(`Phát hiện chồng lấn kỳ hạn hợp đồng trên căn hộ ${apt.code}`);
        }

        const created = await insertContractWithDepositAndServices(client, {
          orgId,
          apt,
          tenant,
          managerId: mgUserId,
          startDate,
          endDate,
          effectiveEndDate,
          billingDay,
          paymentDueDays,
          status: 'ACTIVE',
          contractIndex: ++contractCounter,
          serviceCatalogMap,
        });

        existingContracts.push({ apartmentId: apt.id, startDate, endDate, effectiveEndDate });
        contractList.push(created);
        heldDepositCount++;
        subscriptionCount += created.subscriptions.length;
        overridePriceCount += created.servicePrices.length;
      }

      // 2. Nhóm căn hộ có 2 đời hợp đồng (HĐ 1 đã kết thúc + HĐ 2 đang ACTIVE đến 2027)
      for (let i = 0; i < cfg.rolloverCount; i++) {
        const apt = apts[aptCursor++];
        const spec = rolloverSpecs[i % rolloverSpecs.length];
        const isTerminatedEarly = i % 3 === 0;
        const status1 = isTerminatedEarly ? 'TERMINATED' : 'EXPIRED';
        const terminatedAt1 = isTerminatedEarly ? spec.last1 : null;
        const tenant1 = bTenants[bTenantCursor++];
        const billingDay1 = ((i * 2) % 20) + 1;

        overlapCheckedCount++;
        if (hasOverlap(existingContracts, apt.id, spec.start1, spec.last1)) {
          throw new Error(`Phát hiện chồng lấn kỳ hạn hợp đồng đợt 1 trên căn hộ ${apt.code}`);
        }

        const created1 = await insertContractWithDepositAndServices(client, {
          orgId,
          apt,
          tenant: tenant1,
          managerId: mgUserId,
          startDate: spec.start1,
          endDate: spec.end1,
          effectiveEndDate: spec.last1,
          terminatedAt: terminatedAt1,
          terminationReason: isTerminatedEarly ? 'Khách thuê chuyển công tác, thỏa thuận chấm dứt hợp đồng' : null,
          billingDay: billingDay1,
          paymentDueDays: 5,
          status: status1,
          contractIndex: ++contractCounter,
          serviceCatalogMap,
        });

        await client.query(`UPDATE tenant SET status = 'MOVED_OUT' WHERE id = $1`, [tenant1.tenantId]);
        existingContracts.push({ apartmentId: apt.id, startDate: spec.start1, endDate: spec.end1, effectiveEndDate: spec.last1 });
        contractList.push(created1);
        refundedDepositCount++;
        subscriptionCount += created1.subscriptions.length;
        overridePriceCount += created1.servicePrices.length;

        // Đợt 2: Hợp đồng ACTIVE sang năm 2027
        const start2 = spec.start2;
        const end2 = randomActiveEndDate2027();
        const lastActive2 = addDays(end2, -1);
        const tenant2 = bTenants[bTenantCursor++];
        const billingDay2 = ((i * 5 + 3) % 28) + 1;
        const paymentDueDays2 = billingDay2 >= 25 ? 14 : 5;

        overlapCheckedCount++;
        if (hasOverlap(existingContracts, apt.id, start2, lastActive2)) {
          throw new Error(`Phát hiện chồng lấn kỳ hạn hợp đồng đợt 2 trên căn hộ ${apt.code}`);
        }

        const created2 = await insertContractWithDepositAndServices(client, {
          orgId,
          apt,
          tenant: tenant2,
          managerId: mgUserId,
          startDate: start2,
          endDate: end2,
          effectiveEndDate: lastActive2,
          billingDay: billingDay2,
          paymentDueDays: paymentDueDays2,
          status: 'ACTIVE',
          contractIndex: ++contractCounter,
          serviceCatalogMap,
        });

        existingContracts.push({ apartmentId: apt.id, startDate: start2, endDate: end2, effectiveEndDate: lastActive2 });
        contractList.push(created2);
        heldDepositCount++;
        subscriptionCount += created2.subscriptions.length;
        overridePriceCount += created2.servicePrices.length;
      }

      // 3. Nhóm căn hộ mới lấp đầy dần trong năm 2026 (ACTIVE sang năm 2027)
      for (let i = 0; i < cfg.rampUp2026Count; i++) {
        const apt = apts[aptCursor++];
        const tenant = bTenants[bTenantCursor++];
        const startDate = rampUp2026Starts[i % rampUp2026Starts.length];
        const endDate = randomActiveEndDate2027();
        const effectiveEndDate = addDays(endDate, -1);
        const billingDay = ((i * 4 + bldg.num) % 28) + 1;
        const paymentDueDays = billingDay >= 24 ? 12 : 5;

        overlapCheckedCount++;
        if (hasOverlap(existingContracts, apt.id, startDate, effectiveEndDate)) {
          throw new Error(`Phát hiện chồng lấn kỳ hạn hợp đồng ramp-up trên căn hộ ${apt.code}`);
        }

        const created = await insertContractWithDepositAndServices(client, {
          orgId,
          apt,
          tenant,
          managerId: mgUserId,
          startDate,
          endDate,
          effectiveEndDate,
          billingDay,
          paymentDueDays,
          status: 'ACTIVE',
          contractIndex: ++contractCounter,
          serviceCatalogMap,
        });

        existingContracts.push({ apartmentId: apt.id, startDate, endDate, effectiveEndDate });
        contractList.push(created);
        heldDepositCount++;
        subscriptionCount += created.subscriptions.length;
        overridePriceCount += created.servicePrices.length;
      }

      // 4. Nhóm căn hộ đã có khách ở năm 2025 - giữa 2026 nhưng hiện đã trả phòng
      for (let i = 0; i < cfg.vacated2026Count; i++) {
        const apt = apts[aptCursor++];
        const spec = vacated2026Specs[i % vacated2026Specs.length];
        const isTerminatedEarly = i % 2 === 1;
        const status1 = isTerminatedEarly ? 'TERMINATED' : 'EXPIRED';
        const terminatedAt1 = isTerminatedEarly ? spec.last : null;
        const tenant1 = bTenants[bTenantCursor++];
        const billingDay1 = ((i * 3 + 2) % 20) + 1;

        overlapCheckedCount++;
        if (hasOverlap(existingContracts, apt.id, spec.start, spec.last)) {
          throw new Error(`Phát hiện chồng lấn kỳ hạn hợp đồng vacated trên căn hộ ${apt.code}`);
        }

        const created1 = await insertContractWithDepositAndServices(client, {
          orgId,
          apt,
          tenant: tenant1,
          managerId: mgUserId,
          startDate: spec.start,
          endDate: spec.end,
          effectiveEndDate: spec.last,
          terminatedAt: terminatedAt1,
          terminationReason: isTerminatedEarly ? 'Khách hoàn tất dự án công tác, bàn giao căn hộ trước hạn' : null,
          billingDay: billingDay1,
          paymentDueDays: 5,
          status: status1,
          contractIndex: ++contractCounter,
          serviceCatalogMap,
        });

        await client.query(`UPDATE tenant SET status = 'MOVED_OUT' WHERE id = $1`, [tenant1.tenantId]);
        existingContracts.push({ apartmentId: apt.id, startDate: spec.start, endDate: spec.end, effectiveEndDate: spec.last });
        contractList.push(created1);
        refundedDepositCount++;
        subscriptionCount += created1.subscriptions.length;
        overridePriceCount += created1.servicePrices.length;
      }

      // 5. Cập nhật trạng thái căn hộ OCCUPIED cho các căn có HĐ ACTIVE
      await client.query(
        `UPDATE apartment a
         SET status = 'OCCUPIED', updated_at = NOW()
         WHERE a.building_id = $1
           AND EXISTS (
             SELECT 1 FROM contract c
             WHERE c.apartment_id = a.id AND c.status = 'ACTIVE'
           );`,
        [bldg.id]
      );

      // 6. Đánh dấu một số căn trống sang RESERVED (có phiếu đặt cọc giữ chỗ) và MAINTENANCE (đang bảo trì)
      for (let i = 0; i < cfg.reservedCount; i++) {
        const apt = apts[aptCursor++];
        await client.query(`UPDATE apartment SET status = 'RESERVED', updated_at = NOW() WHERE id = $1`, [apt.id]);
        reservedApts.push({ apt, managerId: mgUserId, tenant: bTenants[bTenantCursor++] });
      }
      for (let i = 0; i < cfg.maintenanceCount; i++) {
        const apt = apts[aptCursor++];
        await client.query(`UPDATE apartment SET status = 'MAINTENANCE', updated_at = NOW() WHERE id = $1`, [apt.id]);
        maintenanceApts.push({ apt, managerId: mgUserId });
      }
    }

    // Tạo phiếu giữ chỗ (Reservation) cho các căn RESERVED + một vài phiếu lịch sử
    for (let i = 0; i < reservedApts.length; i++) {
      const { apt, managerId, tenant } = reservedApts[i];
      const holdAmount = 2000000 + (i % 3) * 1000000;
      const holdFrom = `2026-11-0${(i % 5) + 1}`;
      const holdUntil = addDays(holdFrom, 14);
      const rsvStatus = i % 4 === 3 ? 'PENDING_CONFIRM' : 'HELD';
      await client.query(
        `INSERT INTO reservation (
           org_id, building_id, apartment_id, prospect_name, phone, hold_amount,
           hold_from, hold_until, status, source, method, confirmed_by, confirmed_at, note, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, 'INTERNAL', 'BANK_TRANSFER', $10, NOW(), $11, $10)`,
        [
          orgId,
          apt.buildingId,
          apt.id,
          tenant.name,
          tenant.phone,
          holdAmount,
          holdFrom,
          holdUntil,
          rsvStatus,
          rsvStatus === 'HELD' ? managerId : null,
          `Khách đặt cọc giữ chỗ căn ${apt.code} hẹn ký hợp đồng trong tháng 11/2026`,
        ]
      );
    }

    const activeContractsCount = contractList.filter((c) => c.status === 'ACTIVE').length;
    const endedContractsCount = contractList.length - activeContractsCount;
    console.log(
      `   ✓ Đã tạo ${contractList.length} hợp đồng (ACTIVE sang 2027: ${activeContractsCount}, EXPIRED/TERMINATED: ${endedContractsCount}) — Kiểm tra chống chồng lấn: ${overlapCheckedCount} lần (0 xung đột).`
    );
    console.log(
      `   ✓ Sổ cọc: ${heldDepositCount} HELD, ${refundedDepositCount} REFUNDED | Giữ chỗ: ${reservedApts.length} căn RESERVED | Bảo trì: ${maintenanceApts.length} căn MAINTENANCE.`
    );
    console.log(
      `   ✓ Dịch vụ đăng ký: ${subscriptionCount} gói | Giá ghi đè cấp HĐ: ${overridePriceCount} mục.`
    );

    // ── TASK 7: Đồng hồ Điện/Nước & Chỉ số hàng tháng theo mùa đến 10/2026 & 11/2026 ─
    console.log('\n[7/8] Tạo Đồng hồ Điện/Nước & Chỉ số hàng tháng biến thiên theo mùa (đến hết tháng 10 & 11/2026)...');

    const contractsByApt = new Map();
    for (const c of contractList) {
      if (!contractsByApt.has(c.apartmentId)) contractsByApt.set(c.apartmentId, []);
      contractsByApt.get(c.apartmentId).push(c);
    }
    for (const list of contractsByApt.values()) {
      list.sort((a, b) => a.startDate.localeCompare(b.startDate));
    }

    const meterByApt = {};
    const readingsByContractPeriod = {};
    let meterCount = 0;
    let readingCount = 0;

    for (const [aptId, aptContracts] of contractsByApt.entries()) {
      const sampleContract = aptContracts[0];
      const elCode = `EL-${sampleContract.buildingCode}-${sampleContract.apartmentCode}`;
      const wtCode = `WT-${sampleContract.buildingCode}-${sampleContract.apartmentCode}`;

      const { rows: [elMeter] } = await client.query(
        `INSERT INTO meter (
           org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading, status, created_at
         )
         VALUES ($1, $2, $3, 'ELECTRICITY', $4, 'kWh', 3800, 0, 'ACTIVE', '2025-01-01T00:00:00+07:00')
         RETURNING id, meter_code, unit, unit_price;`,
        [orgId, sampleContract.buildingId, aptId, elCode]
      );

      const { rows: [wtMeter] } = await client.query(
        `INSERT INTO meter (
           org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading, status, created_at
         )
         VALUES ($1, $2, $3, 'WATER', $4, 'm³', 22000, 0, 'ACTIVE', '2025-01-01T00:00:00+07:00')
         RETURNING id, meter_code, unit, unit_price;`,
        [orgId, sampleContract.buildingId, aptId, wtCode]
      );

      meterByApt[aptId] = { elMeter, wtMeter };
      meterCount += 2;

      let elPrev = randomInt(450, 1600);
      let wtPrev = randomInt(35, 130);
      const bedrooms = sampleContract.bedrooms || 2;

      for (const c of aptContracts) {
        const lastPeriod =
          c.status === 'ACTIVE'
            ? '2026-11'
            : c.effectiveEndDate.slice(0, 7) < '2026-10'
            ? c.effectiveEndDate.slice(0, 7)
            : '2026-10';
        const months = eachMonth(c.startDate, lastPeriod);

        for (const { year, month, period } of months) {
          const dim = getDaysInMonth(year, month);
          const recordedDay = period === '2026-11' ? 5 : Math.min(28, dim);
          const recordedAt = `${period}-${pad2(recordedDay)}T10:00:00+07:00`;

          // Mức tiêu thụ cơ sở theo số phòng ngủ + biến thiên mùa vụ miền Bắc + tỷ lệ số ngày ở trong tháng
          const { monthStart, monthEnd } = getMonthBoundsYmd(period);
          const activeStart = c.startDate > monthStart ? c.startDate : monthStart;
          const activeEnd = c.effectiveEndDate < monthEnd ? c.effectiveEndDate : monthEnd;
          const activeDays = Math.max(1, diffDaysYmd(activeStart, activeEnd) + 1);
          const stayRatio = Math.min(1, activeDays / dim);

          const { elFactor, wtFactor } = getSeasonalMultipliers(year, month);
          const baseEl = bedrooms === 1 ? randomInt(115, 175) : bedrooms === 2 ? randomInt(185, 275) : randomInt(260, 380);
          const baseWt = bedrooms === 1 ? randomInt(6, 11) : bedrooms === 2 ? randomInt(10, 17) : randomInt(15, 24);

          const elCons = Math.max(18, Math.round(baseEl * elFactor * stayRatio));
          const wtCons = Math.max(2, Math.round(baseWt * wtFactor * stayRatio));
          const elCurr = elPrev + elCons;
          const wtCurr = wtPrev + wtCons;

          const { rows: [elRead] } = await client.query(
            `INSERT INTO meter_reading (
               org_id, building_id, meter_id, apartment_id, contract_id, period,
               previous_reading, current_reading, consumption, is_abnormal,
               status, confirmed_by, confirmed_at, baseline_avg_consumption,
               source, recorded_by, recorded_at
             )
             VALUES (
               $1, $2, $3, $4, $5, $6,
               $7, $8, $9, FALSE,
               'CONFIRMED', $10, $11::timestamptz, $9,
               'MANUAL', $10, $11::timestamptz
             )
             RETURNING id;`,
            [
              orgId,
              c.buildingId,
              elMeter.id,
              aptId,
              c.contractId,
              period,
              elPrev,
              elCurr,
              elCons,
              c.managerId,
              recordedAt,
            ]
          );

          const { rows: [wtRead] } = await client.query(
            `INSERT INTO meter_reading (
               org_id, building_id, meter_id, apartment_id, contract_id, period,
               previous_reading, current_reading, consumption, is_abnormal,
               status, confirmed_by, confirmed_at, baseline_avg_consumption,
               source, recorded_by, recorded_at
             )
             VALUES (
               $1, $2, $3, $4, $5, $6,
               $7, $8, $9, FALSE,
               'CONFIRMED', $10, $11::timestamptz, $9,
               'MANUAL', $10, $11::timestamptz
             )
             RETURNING id;`,
            [
              orgId,
              c.buildingId,
              wtMeter.id,
              aptId,
              c.contractId,
              period,
              wtPrev,
              wtCurr,
              wtCons,
              c.managerId,
              recordedAt,
            ]
          );

          readingsByContractPeriod[`${c.contractId}_${period}`] = {
            el: {
              id: elRead.id,
              meter_id: elMeter.id,
              meter_code: elMeter.meter_code,
              unit: elMeter.unit,
              unit_price: Number(elMeter.unit_price),
              previous_reading: elPrev,
              current_reading: elCurr,
              consumption: elCons,
            },
            wt: {
              id: wtRead.id,
              meter_id: wtMeter.id,
              meter_code: wtMeter.meter_code,
              unit: wtMeter.unit,
              unit_price: Number(wtMeter.unit_price),
              previous_reading: wtPrev,
              current_reading: wtCurr,
              consumption: wtCons,
            },
          };

          elPrev = elCurr;
          wtPrev = wtCurr;
          readingCount += 2;
        }
      }
    }

    // Tạo đồng hồ cho cả các căn hộ chưa có lịch sử hợp đồng để đủ 480 công tơ (240 căn x 2)
    for (const bldg of buildings) {
      for (const apt of aptsByBuilding[bldg.id]) {
        if (meterByApt[apt.id]) continue;
        const elCode = `EL-${bldg.code}-${apt.code}`;
        const wtCode = `WT-${bldg.code}-${apt.code}`;

        const { rows: [elMeter] } = await client.query(
          `INSERT INTO meter (
             org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading, status, created_at
           )
           VALUES ($1, $2, $3, 'ELECTRICITY', $4, 'kWh', 3800, 0, 'ACTIVE', '2025-01-01T00:00:00+07:00')
           RETURNING id, meter_code, unit, unit_price;`,
          [orgId, bldg.id, apt.id, elCode]
        );
        const { rows: [wtMeter] } = await client.query(
          `INSERT INTO meter (
             org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading, status, created_at
           )
           VALUES ($1, $2, $3, 'WATER', $4, 'm³', 22000, 0, 'ACTIVE', '2025-01-01T00:00:00+07:00')
           RETURNING id, meter_code, unit, unit_price;`,
          [orgId, bldg.id, apt.id, wtCode]
        );
        meterByApt[apt.id] = { elMeter, wtMeter };
        meterCount += 2;
      }
    }

    console.log(`   ✓ Đã tạo ${meterCount} đồng hồ điện/nước & ${readingCount} bản ghi chỉ số CONFIRMED (đến hết kỳ 2026-10 & 2026-11).`);

    // ── TASK 8: Hóa đơn hàng tháng (01/2025 -> 10/2026, Pro-rata chính xác) + Công nợ 5 nhóm + Bảo trì SLA ─
    console.log('\n[8/8] Tạo Hóa đơn hàng tháng (01/2025 -> 10/2026, tính Pro-rata theo ngày), Công nợ 5 nhóm & Yêu cầu SLA...');
    console.log('      (Không sinh hóa đơn tháng 11/2026 để người dùng tự click Sinh hóa đơn hàng loạt trên UI)');

    let invoiceSeq = 1;
    let paidInvoiceCount = 0;
    let partialInvoiceCount = 0;
    let unpaidInvoiceCount = 0;
    let invoiceLineCount = 0;
    let paymentCount = 0;
    let receivableCount = 0;
    let proratedInvoiceCount = 0;

    for (const c of contractList) {
      const lastInvoicePeriod =
        c.effectiveEndDate.slice(0, 7) < '2026-10' ? c.effectiveEndDate.slice(0, 7) : '2026-10';
      const months = eachMonth(c.startDate, lastInvoicePeriod);

      for (const { year, month, period } of months) {
        const { monthEnd } = getMonthBoundsYmd(period);
        const effectivePeriodEndYmd =
          c.effectiveEndDate < monthEnd ? c.effectiveEndDate : monthEnd;

        // 1. Tiền thuê phòng (Pro-rata chính xác theo hàm chuẩn của hệ thống)
        const rentCharge = computeContractRentPeriodCharge({
          contract: {
            start_date: c.startDate,
            end_date: c.endDate,
            terminated_at: c.terminatedAt,
            rent_amount: c.rentAmount,
          },
          periodYm: period,
          lastActiveDayYmd: c.effectiveEndDate,
        });

        if (rentCharge.isProrated) {
          proratedInvoiceCount++;
        }

        const lines = [];
        if (rentCharge.amount > 0) {
          lines.push({
            item_type: 'RENT',
            description: rentCharge.description,
            quantity: rentCharge.isProrated
              ? Number((rentCharge.activeDays / rentCharge.daysInMonth).toFixed(4))
              : 1,
            unit: 'tháng',
            unit_price: rentCharge.unitPrice,
            amount: rentCharge.amount,
            subscription_id: null,
            formula_meta: rentCharge.formulaMeta,
          });
        }

        // 2. Tiền điện & nước từ chỉ số đồng hồ kỳ đó
        const pairReadings = readingsByContractPeriod[`${c.contractId}_${period}`];
        if (pairReadings) {
          for (const [mType, mr] of [
            ['ELECTRICITY', pairReadings.el],
            ['WATER', pairReadings.wt],
          ]) {
            const { unitPrice: uPrice, priceSource } = resolveUtilityUnitPrice({
              meterType: mType,
              meterUnitPrice: mr.unit_price,
              contractBuildingId: c.buildingId,
              periodEndYmd: effectivePeriodEndYmd,
              contractServicePrices: c.servicePrices,
              catalogItems,
            });
            const uAmt = roundVND(mr.consumption * uPrice);
            if (uAmt > 0) {
              lines.push({
                item_type: mType,
                description: `${mType === 'ELECTRICITY' ? 'Tiền điện' : 'Tiền nước'} (${mr.previous_reading} → ${mr.current_reading} ${mr.unit})${priceSource === 'CONTRACT_OVERRIDE' ? ' (Giá HĐ)' : ''}`,
                quantity: mr.consumption,
                unit: mr.unit,
                unit_price: uPrice,
                amount: uAmt,
                subscription_id: null,
                formula_meta: {
                  meter_id: mr.meter_id,
                  meter_code: mr.meter_code,
                  reading_id: mr.id,
                  contract_id: c.contractId,
                  meter_type: mType,
                  previous_reading: mr.previous_reading,
                  current_reading: mr.current_reading,
                  consumption: mr.consumption,
                  unit_price: uPrice,
                  amount: uAmt,
                  price_source: priceSource,
                },
              });
            }
          }
        }

        // 3. Tiền dịch vụ đăng ký (Pro-rata nếu kỳ đầu/kỳ cuối lẻ ngày)
        for (const sub of c.subscriptions) {
          const subCharge = computeSubscriptionPeriodCharge({
            subscription: sub,
            periodYm: period,
            boundEndYmd: effectivePeriodEndYmd,
            contractBuildingId: c.buildingId,
            contractServicePrices: c.servicePrices,
            catalogItems,
          });
          if (subCharge.amount > 0) {
            lines.push({
              item_type: 'SERVICE',
              description: subCharge.description,
              quantity: subCharge.quantity,
              unit: sub.unit || 'tháng',
              unit_price: subCharge.unitPrice,
              amount: subCharge.amount,
              subscription_id: sub.id,
              formula_meta: subCharge.formulaMeta,
            });
          }
        }

        const subtotal = roundVND(lines.reduce((s, l) => s + l.amount, 0));
        if (subtotal <= 0) continue;

        const dim = getDaysInMonth(year, month);
        const clampedIssueDay = Math.min(c.billingDay, dim);
        const rawIssueDate = `${period}-${pad2(clampedIssueDay)}`;
        const issueDate =
          period === c.startDate.slice(0, 7) && rawIssueDate < c.startDate
            ? c.startDate
            : rawIssueDate;
        const dueDate = addDays(issueDate, c.paymentDueDays || 5);
        const invCode = `INV-${period.replace('-', '')}-${c.buildingCode}-${c.apartmentCode}-${String(invoiceSeq++).padStart(4, '0')}`;

        // Phân bổ trạng thái thanh toán & công nợ chân thực qua cả 5 nhóm tuổi nợ (tính tại mốc 2026-11-07):
        // - >60 ngày (due_date < 2026-09-08): một vài HĐ ACTIVE kỳ 2026-08 còn nợ / trả 1 phần
        // - 31-60 ngày (due_date 2026-09-08 .. 2026-10-07): một số HĐ ACTIVE kỳ 2026-09 còn nợ / trả 1 phần
        // - 16-30 ngày (due_date 2026-10-08 .. 2026-10-22): HĐ ACTIVE kỳ 2026-10 có billingDay 3..17
        // - 1-15 ngày (due_date 2026-10-23 .. 2026-11-06): HĐ ACTIVE kỳ 2026-10 có billingDay 18..24
        // - Chưa đến hạn (due_date >= 2026-11-07): HĐ ACTIVE kỳ 2026-10 có billingDay >= 25 & paymentDueDays 12..14
        let invStatus = 'PAID';
        let paidAmount = subtotal;
        let rcvStatus = 'PAID';

        if (c.status === 'ACTIVE') {
          if (period === '2026-08' && c.contractIndex % 37 === 0 && dueDate < '2026-09-08') {
            // Nhóm >60 ngày
            if (c.contractIndex % 2 === 0) {
              invStatus = 'PARTIALLY_PAID';
              paidAmount = roundVND(subtotal * 0.5);
              rcvStatus = 'PARTIALLY_PAID';
            } else {
              invStatus = 'OVERDUE';
              paidAmount = 0;
              rcvStatus = 'OPEN';
            }
          } else if (period === '2026-09' && c.contractIndex % 19 === 0 && dueDate >= '2026-09-08' && dueDate <= '2026-10-07') {
            // Nhóm 31-60 ngày
            if (c.contractIndex % 3 === 0) {
              invStatus = 'PARTIALLY_PAID';
              paidAmount = roundVND(subtotal * 0.4);
              rcvStatus = 'PARTIALLY_PAID';
            } else {
              invStatus = 'OVERDUE';
              paidAmount = 0;
              rcvStatus = 'OPEN';
            }
          } else if (period === '2026-10') {
            if (dueDate >= '2026-11-07' && c.contractIndex % 2 === 0) {
              // Nhóm Chưa đến hạn (due_date >= 2026-11-07)
              invStatus = 'ISSUED';
              paidAmount = 0;
              rcvStatus = 'OPEN';
            } else if (dueDate >= '2026-10-23' && dueDate <= '2026-11-06' && c.contractIndex % 5 === 0) {
              // Nhóm 1-15 ngày
              if (c.contractIndex % 10 === 0) {
                invStatus = 'PARTIALLY_PAID';
                paidAmount = roundVND(subtotal * 0.6);
                rcvStatus = 'PARTIALLY_PAID';
              } else {
                invStatus = 'OVERDUE';
                paidAmount = 0;
                rcvStatus = 'OPEN';
              }
            } else if (dueDate >= '2026-10-08' && dueDate <= '2026-10-22' && c.contractIndex % 7 === 0) {
              // Nhóm 16-30 ngày
              if (c.contractIndex % 14 === 0) {
                invStatus = 'PARTIALLY_PAID';
                paidAmount = roundVND(subtotal * 0.5);
                rcvStatus = 'PARTIALLY_PAID';
              } else {
                invStatus = 'OVERDUE';
                paidAmount = 0;
                rcvStatus = 'OPEN';
              }
            } else if (dueDate <= '2026-10-07' && c.contractIndex % 11 === 0) {
              // Bổ sung thêm vào nhóm 31-60 ngày từ đầu tháng 10
              invStatus = 'OVERDUE';
              paidAmount = 0;
              rcvStatus = 'OPEN';
            }
          }
        }

        const { rows: [invRow] } = await client.query(
          `INSERT INTO invoice (
             org_id, building_id, apartment_id, contract_id, tenant_id,
             invoice_code, period, issue_date, due_date,
             subtotal_amount, adjustment_amount, total_amount, paid_amount,
             status, created_by, issued_by, issued_at, created_at, updated_at
           )
           VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8::date, $9::date,
             $10, 0, $10, $11,
             $12, $13, $13, ($8::date)::timestamptz, ($8::date)::timestamptz, ($8::date)::timestamptz
           )
           RETURNING id;`,
          [
            orgId,
            c.buildingId,
            c.apartmentId,
            c.contractId,
            c.tenantId,
            invCode,
            period,
            issueDate,
            dueDate,
            subtotal,
            paidAmount,
            invStatus,
            c.managerId,
          ]
        );

        for (const l of lines) {
          await client.query(
            `INSERT INTO invoice_line (
               invoice_id, subscription_id, item_type, description, quantity, unit, unit_price, amount, formula_meta
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb);`,
            [
              invRow.id,
              l.subscription_id,
              l.item_type,
              l.description,
              l.quantity,
              l.unit,
              l.unit_price,
              l.amount,
              JSON.stringify(l.formula_meta || {}),
            ]
          );
          invoiceLineCount++;
        }

        if (paidAmount > 0) {
          // Tạo độ trễ ngày thực thu tự nhiên: một số HĐ chốt cuối tháng thanh toán sang đầu tháng kế tiếp
          const payDelayDays =
            c.status === 'ACTIVE' && period < '2026-10' && c.contractIndex % 6 === 0
              ? randomInt(6, 12)
              : randomInt(1, 4);
          const rawPaidDate = addDays(issueDate, payDelayDays);
          const paidDate = rawPaidDate > '2026-11-06' ? '2026-11-05' : rawPaidDate;

          await client.query(
            `INSERT INTO payment (
               org_id, building_id, invoice_id, contract_id, tenant_id,
               payment_code, amount, method, reference_code, status,
               paid_at, note, reported_by, confirmed_by, confirmed_at, created_at
             )
             VALUES (
               $1, $2, $3, $4, $5,
               $6, $7, 'BANK_TRANSFER', $8, 'CONFIRMED',
               ($9::date)::timestamptz, $10, $11, $11, ($9::date)::timestamptz, ($9::date)::timestamptz
             );`,
            [
              orgId,
              c.buildingId,
              invRow.id,
              c.contractId,
              c.tenantId,
              `PAY-${invCode}`,
              paidAmount,
              `VCB${period.replace('-', '')}${String(invoiceSeq).padStart(5, '0')}`,
              paidDate,
              invStatus === 'PARTIALLY_PAID'
                ? `Thanh toán một phần hóa đơn kỳ ${period}`
                : `Thanh toán hóa đơn kỳ ${period}`,
              c.managerId,
            ]
          );
          paymentCount++;
        }

        await client.query(
          `INSERT INTO receivable (
             org_id, building_id, contract_id, tenant_id, invoice_id,
             type, amount, paid_amount, due_date, status, description, created_at, updated_at
           )
           VALUES (
             $1, $2, $3, $4, $5,
             'INVOICE_DEBT', $6, $7, $8::date, $9, $10, ($8::date)::timestamptz, ($8::date)::timestamptz
           );`,
          [
            orgId,
            c.buildingId,
            c.contractId,
            c.tenantId,
            invRow.id,
            subtotal,
            paidAmount,
            dueDate,
            rcvStatus,
            `Công nợ hóa đơn ${invCode} kỳ ${period}`,
          ]
        );
        receivableCount++;

        if (invStatus === 'PAID') paidInvoiceCount++;
        else if (invStatus === 'PARTIALLY_PAID') partialInvoiceCount++;
        else unpaidInvoiceCount++;
      }
    }

    // Tạo dữ liệu Yêu cầu bảo trì / báo hỏng (service_request) cho cả 3 tòa để bảng SLA và Dashboard sống động
    const srTemplates = [
      { category: 'HVAC',       priority: 'HIGH',   title: 'Điều hòa phòng khách làm mát yếu, cần vệ sinh nạp gas', desc: 'Điều hòa bật 20 độ nhưng gió thổi ra không mát, nhờ kỹ thuật kiểm tra.', resolveHours: 6.5, rating: 5 },
      { category: 'PLUMBING',   priority: 'URGENT', title: 'Rò rỉ nước dưới bồn rửa bát khu bếp', desc: 'Ống xả chữ P dưới chậu rửa bị rỉ nước khi xả mạnh.', resolveHours: 2.8, rating: 5 },
      { category: 'ELECTRICAL', priority: 'NORMAL', title: 'Đèn âm trần hànhlang nhấp nháy', desc: 'Bóng LED downlight gần cửa ra vào bị chập chờn.', resolveHours: 14.0, rating: 4 },
      { category: 'APPLIANCE',  priority: 'NORMAL', title: 'Bình nóng lạnh phòng tắm chính báo lỗi đèn đỏ', desc: 'Bật công tắc bình nóng lạnh 15 phút nhưng nước không ấm.', resolveHours: 18.5, rating: 5 },
      { category: 'FURNITURE',  priority: 'LOW',    title: 'Bản lề tủ quần áo phòng ngủ bị xệ', desc: 'Cánh tủ bên phải đóng mở hơi kẹt, cần chỉnh lại bản lề giảm chấn.', resolveHours: 28.0, rating: 4, breached: true },
      { category: 'CLEANING',   priority: 'LOW',    title: 'Đăng ký tổng vệ sinh ban công và kính mặt ngoài', desc: 'Nhờ đội vệ sinh hỗ trợ làm sạch khe cửa lùa ban công.', resolveHours: 12.0, rating: 5 },
      { category: 'PLUMBING',   priority: 'NORMAL', title: 'Vòi sen tắm áp lực nước yếu', desc: 'Nước chảy yếu vào giờ cao điểm buổi tối, cần vệ sinh lưới lọc.', resolveHours: 9.5, rating: 5 },
      { category: 'ELECTRICAL', priority: 'HIGH',   title: 'Ổ cắm khu vực bàn làm việc mất nguồn', desc: 'Aptomat nhánh ổ cắm phòng ngủ nhỏ bị nhảy.', resolveHours: 3.2, rating: 5 },
      { category: 'HVAC',       priority: 'NORMAL', title: 'Bảo dưỡng định kỳ điều hòa Multi 2 chiều', desc: 'Vệ sinh lưới lọc bụi và kiểm tra đường ống thoát nước ngưng.', openStatus: 'IN_PROGRESS' },
      { category: 'APPLIANCE',  priority: 'HIGH',   title: 'Bếp từ đôi báo lỗi E2 khi đun nấu', desc: 'Quạt tản nhiệt dưới đáy bếp từ không quay.', openStatus: 'ASSIGNED' },
      { category: 'PLUMBING',   priority: 'NORMAL', title: 'Thay phao cơ bồn cầu phòng vệ sinh phụ', desc: 'Phao ngắt nước chậm gây tiếng ồn nhỏ.', openStatus: 'NEW' },
    ];

    let srSeq = 1001;
    const activeContractsByBldg = {};
    for (const c of contractList.filter((x) => x.status === 'ACTIVE')) {
      if (!activeContractsByBldg[c.buildingId]) activeContractsByBldg[c.buildingId] = [];
      activeContractsByBldg[c.buildingId].push(c);
    }

    for (const bldg of buildings) {
      const bContracts = activeContractsByBldg[bldg.id] || [];
      const mgUserId = managerByBuilding[bldg.id];
      for (let i = 0; i < srTemplates.length; i++) {
        const tpl = srTemplates[i];
        const sampleC = bContracts[i % bContracts.length];
        if (!sampleC) continue;

        const createdDaysAgo = tpl.openStatus ? randomInt(0, 2) : randomInt(4, 45);
        const createdDateStr = addDays('2026-11-07', -createdDaysAgo);
        const createdAt = `${createdDateStr}T09:${pad2((i * 7) % 50)}:00+07:00`;
        const trackingCode = `SR-202611-${srSeq++}`;
        const slaHours = tpl.priority === 'URGENT' ? 4 : 24;

        if (tpl.openStatus) {
          await client.query(
            `INSERT INTO service_request (
               org_id, building_id, apartment_id, created_by, assigned_to,
               title, category, description, location_detail, preferred_slot,
               priority, status, tracking_code,
               sla_response_due_at, sla_due_at, created_at, updated_at
             )
             VALUES (
               $1, $2, $3, $4, $5,
               $6, $7, $8, 'Trong căn hộ', 'MORNING',
               $9, $10, $11,
               ($12::timestamptz + INTERVAL '2 hours'),
               ($12::timestamptz + ($13 || ' hours')::interval),
               $12::timestamptz, NOW()
             )`,
            [
              orgId,
              bldg.id,
              sampleC.apartmentId,
              mgUserId,
              tpl.openStatus === 'NEW' ? null : mgUserId,
              tpl.title,
              tpl.category,
              tpl.desc,
              tpl.priority,
              tpl.openStatus,
              trackingCode,
              createdAt,
              String(slaHours),
            ]
          );
        } else {
          const resolveHours = tpl.resolveHours + (bldg.num - 1) * 1.2;
          const status = i % 2 === 0 ? 'CLOSED' : 'RESOLVED';
          await client.query(
            `INSERT INTO service_request (
               org_id, building_id, apartment_id, created_by, assigned_to, resolved_by,
               title, category, description, location_detail, preferred_slot,
               priority, status, tracking_code,
               sla_response_due_at, sla_due_at, sla_breached_at,
               resolved_at, rating, resolution_note, created_at, updated_at
             )
             VALUES (
               $1, $2, $3, $4, $4, $4,
               $5, $6, $7, 'Trong căn hộ', 'AFTERNOON',
               $8, $9, $10,
               ($11::timestamptz + INTERVAL '2 hours'),
               ($11::timestamptz + ($12 || ' hours')::interval),
               CASE WHEN $13::boolean THEN ($11::timestamptz + ($12 || ' hours')::interval) ELSE NULL END,
               ($11::timestamptz + ($14 || ' hours')::interval),
               $15, 'Đã kiểm tra, thay thế linh kiện và bàn giao nghiệm thu ổn định.',
               $11::timestamptz, ($11::timestamptz + ($14 || ' hours')::interval)
             )`,
            [
              orgId,
              bldg.id,
              sampleC.apartmentId,
              mgUserId,
              tpl.title,
              tpl.category,
              tpl.desc,
              tpl.priority,
              status,
              trackingCode,
              createdAt,
              String(slaHours),
              Boolean(tpl.breached),
              String(resolveHours.toFixed(1)),
              tpl.rating,
            ]
          );
        }
      }
    }

    console.log(
      `   ✓ Đã tạo ${paidInvoiceCount + partialInvoiceCount + unpaidInvoiceCount} hóa đơn (PAID: ${paidInvoiceCount}, PARTIALLY_PAID: ${partialInvoiceCount}, UNPAID: ${unpaidInvoiceCount}, Pro-rata: ${proratedInvoiceCount} kỳ).`
    );
    console.log(
      `   ✓ Chi tiết dòng hóa đơn: ${invoiceLineCount} | Giao dịch thanh toán: ${paymentCount} | Khoản phải thu: ${receivableCount}.`
    );
    console.log(
      `   ✓ Đã tạo ${srTemplates.length * buildings.length} yêu cầu bảo trì / báo hỏng (service_request) có đầy đủ SLA & đánh giá.`
    );

    // Đánh dấu cron_job_run SUCCEEDED cho hôm nay để startDailyJobs() khi boot server không tự chạy catch-up làm thay đổi dữ liệu vừa seed
    await client.query(`
      INSERT INTO cron_job_run (job_name, run_date, status, attempt_count, started_at, finished_at)
      VALUES
        ('DAILY_BILLING_SYNC', '2026-11-06'::date, 'SUCCEEDED', 1, NOW(), NOW()),
        ('DAILY_BILLING_SYNC', (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'SUCCEEDED', 1, NOW(), NOW());
    `);

    await client.query('COMMIT');

    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('  ✅ SEED HOÀN TẤT — DỮ LIỆU CHÂN THỰC & SẴN SÀNG TEST THÁNG 11');
    console.log('══════════════════════════════════════════════════════════════════');
    console.log('\nThông tin đăng nhập:');
    console.log('  • SYS_ADMIN : admin@resihub.vn        | Mật khẩu: Admin@123456');
    console.log('  • OWNER     : owner.vop@resihub.vn    | Mật khẩu: Demo@123456 (Sở hữu cả 3 tòa)');
    console.log('  • MANAGER 1 : manager.vop1@resihub.vn | Mật khẩu: Demo@123456 (Vinhomes Ocean Park 1)');
    console.log('  • MANAGER 2 : manager.vop2@resihub.vn | Mật khẩu: Demo@123456 (Vinhomes Ocean Park 2)');
    console.log('  • MANAGER 3 : manager.vop3@resihub.vn | Mật khẩu: Demo@123456 (Vinhomes Ocean Park 3)');
    console.log(`  • RESIDENT  : tenant1..tenant${tenantIdx - 1}@resihub.vn | Mật khẩu: Demo@123456`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ LỖI SEED:', err.message);
    console.error(err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function insertContractWithDepositAndServices(
  client,
  {
    orgId,
    apt,
    tenant,
    managerId,
    startDate,
    endDate,
    effectiveEndDate,
    terminatedAt = null,
    terminationReason = null,
    billingDay,
    paymentDueDays = 5,
    status,
    contractIndex,
    serviceCatalogMap,
  }
) {
  const depositAmt = apt.baseRent; // 1 tháng tiền thuê

  const { rows: [cRow] } = await client.query(
    `INSERT INTO contract (
       apartment_id, building_id, primary_tenant_id,
       start_date, end_date,
       rent_amount, billing_cycle, billing_day, payment_due_days,
       deposit_amount, status, terminated_at, note,
       created_by, created_at, updated_at
     )
     VALUES (
       $1, $2, $3,
       $4::date, $5::date,
       $6, 'monthly', $7, $8,
       $9, $10, $11::date, $12,
       $13, ($4::date)::timestamptz, NOW()
     )
     RETURNING id;`,
    [
      apt.id,
      apt.buildingId,
      tenant.tenantId,
      startDate,
      endDate,
      apt.baseRent,
      billingDay,
      paymentDueDays,
      depositAmt,
      status,
      terminatedAt,
      terminationReason || '',
      managerId,
    ]
  );
  const contractId = cRow.id;

  // Sổ cọc & giao dịch thu/hoàn cọc
  // Quy tắc PRD FR-024: Cọc KHÔNG được cấn trừ vào tiền thuê, hoàn trong 3-5 ngày sau chấm dứt
  if (status === 'ACTIVE') {
    const { rows: [depRow] } = await client.query(
      `INSERT INTO deposit (contract_id, amount_held, currency, status, created_at, updated_at)
       VALUES ($1, $2, 'VND', 'HELD', ($3::date)::timestamptz, ($3::date)::timestamptz)
       RETURNING id;`,
      [contractId, depositAmt, startDate]
    );

    await client.query(
      `INSERT INTO deposit_transaction (
         deposit_id, type, method, amount, status, description,
         reference_code, approved_by, approved_at, created_by, created_at
       )
       VALUES (
         $1, 'collect', 'BANK_TRANSFER', $2, 'APPROVED', 'Thu tiền cọc bảo đảm hợp đồng đầu kỳ (không cấn trừ tiền thuê)',
         $3, $4, ($5::date)::timestamptz, $4, ($5::date)::timestamptz
       );`,
      [depRow.id, depositAmt, `DEP-COL-${String(contractIndex).padStart(4, '0')}`, managerId, startDate]
    );
  } else {
    // Hợp đồng đã kết thúc (EXPIRED / TERMINATED): hoàn cọc trong 3-5 ngày sau ngày kết thúc
    const refundOffsetDays = 3 + (contractIndex % 3); // 3, 4 hoặc 5 ngày
    const refundDueDate = addDays(effectiveEndDate, 5);
    const refundPaidDate = addDays(effectiveEndDate, refundOffsetDays);

    const settlementJson = {
      settled_at: `${refundPaidDate}T10:00:00+07:00`,
      deposit_held_before_settlement: depositAmt,
      outstanding_debt: 0,
      rent_debt: 0,
      items: [],
      refund_amount: depositAmt,
      shortfall_amount: 0,
      refund_method: 'BANK_TRANSFER',
      refund_bank_info: {
        bank_name: 'Vietcombank',
        account_number: `001100${String(contractIndex).padStart(6, '0')}`,
        account_holder: tenant.name.toUpperCase(),
      },
      note: `Hoàn trả 100% tiền cọc sau ${refundOffsetDays} ngày bàn giao phòng (không cấn trừ tiền thuê)`,
    };

    const { rows: [depRow] } = await client.query(
      `INSERT INTO deposit (
         contract_id, amount_held, currency, refund_due_date, status, settlement, created_at, updated_at
       )
       VALUES ($1, 0, 'VND', $2::date, 'REFUNDED', $3::jsonb, ($4::date)::timestamptz, ($5::date)::timestamptz)
       RETURNING id;`,
      [contractId, refundDueDate, JSON.stringify(settlementJson), startDate, refundPaidDate]
    );

    // Giao dịch 1: Thu cọc đầu kỳ
    await client.query(
      `INSERT INTO deposit_transaction (
         deposit_id, type, method, amount, status, description,
         reference_code, approved_by, approved_at, created_by, created_at
       )
       VALUES (
         $1, 'collect', 'BANK_TRANSFER', $2, 'APPROVED', 'Thu tiền cọc bảo đảm hợp đồng đầu kỳ',
         $3, $4, ($5::date)::timestamptz, $4, ($5::date)::timestamptz
       );`,
      [depRow.id, depositAmt, `DEP-COL-${String(contractIndex).padStart(4, '0')}`, managerId, startDate]
    );

    // Giao dịch 2: Hoàn cọc trong 3-5 ngày sau chấm dứt
    await client.query(
      `INSERT INTO deposit_transaction (
         deposit_id, type, method, amount, status, description,
         reference_code, approved_by, approved_at, created_by, created_at
       )
       VALUES (
         $1, 'refund', 'BANK_TRANSFER', $2, 'APPROVED', $3,
         $4, $5, ($6::date)::timestamptz, $5, ($6::date)::timestamptz
       );`,
      [
        depRow.id,
        depositAmt,
        `Hoàn trả tiền cọc sau ${refundOffsetDays} ngày kết thúc hợp đồng (hạn hoàn 3-5 ngày)`,
        `DEP-REF-${String(contractIndex).padStart(4, '0')}`,
        managerId,
        refundPaidDate,
      ]
    );
  }

  // Giá dịch vụ ghi đè theo hợp đồng (~20% hợp đồng có ưu đãi giá Internet hoặc Phí quản lý)
  const servicePrices = [];
  if (contractIndex % 5 === 0) {
    const { rows: [csp] } = await client.query(
      `INSERT INTO contract_service_price (contract_id, service_code, unit_price, effective_from)
       VALUES ($1, 'MANAGEMENT_FEE', 300000, $2::date)
       RETURNING service_code, unit_price, effective_from;`,
      [contractId, startDate]
    );
    servicePrices.push(csp);
  }
  if (contractIndex % 7 === 0) {
    const { rows: [csp] } = await client.query(
      `INSERT INTO contract_service_price (contract_id, service_code, unit_price, effective_from)
       VALUES ($1, 'INTERNET_FIBER', 180000, $2::date)
       RETURNING service_code, unit_price, effective_from;`,
      [contractId, startDate]
    );
    servicePrices.push(csp);
  }

  // Đăng ký dịch vụ cho hợp đồng
  const subStatus = status === 'ACTIVE' ? 'ACTIVE' : 'TERMINATED';
  const subEndDate = status === 'ACTIVE' ? null : effectiveEndDate;
  const chosenSubs = [
    { sc: serviceCatalogMap.MANAGEMENT_FEE, qty: 1, plates: [] },
  ];
  if (contractIndex % 5 !== 1) {
    chosenSubs.push({ sc: serviceCatalogMap.INTERNET_FIBER, qty: 1, plates: [] });
  }
  if (contractIndex % 2 === 0) {
    chosenSubs.push({
      sc: serviceCatalogMap.MOTORBIKE_PARKING,
      qty: (contractIndex % 3 === 0) ? 2 : 1,
      plates: [`29A1-${String(10000 + contractIndex).slice(0, 5)}`],
    });
  }
  if (contractIndex % 4 === 0 || apt.bedrooms >= 3) {
    chosenSubs.push({
      sc: serviceCatalogMap.CAR_PARKING,
      qty: 1,
      plates: [`30H-${String(20000 + contractIndex).slice(0, 5)}`],
    });
  }
  if (contractIndex % 6 === 0) {
    chosenSubs.push({
      sc: serviceCatalogMap.CLEANING_WEEKLY,
      qty: (contractIndex % 12 === 0) ? 4 : 2,
      plates: [],
    });
  }

  const subscriptions = [];
  for (const item of chosenSubs) {
    const override = servicePrices.find((p) => p.service_code === item.sc.code);
    const unitPrice = override ? Number(override.unit_price) : Number(item.sc.unit_price);

    const { rows: [subRow] } = await client.query(
      `INSERT INTO service_subscription (
         org_id, building_id, apartment_id, contract_id, service_id,
         quantity, unit_price, vehicle_plates, start_date, end_date,
         status, is_price_locked, requested_by, approved_by, created_at
       )
       VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8::text[], $9::date, $10::date,
         $11, FALSE, $12, $12, ($9::date)::timestamptz
       )
       RETURNING *;`,
      [
        orgId,
        apt.buildingId,
        apt.id,
        contractId,
        item.sc.id,
        item.qty,
        unitPrice,
        item.plates,
        startDate,
        subEndDate,
        subStatus,
        managerId,
      ]
    );

    subscriptions.push({
      ...subRow,
      service_code: item.sc.code,
      service_category: item.sc.category,
      service_name: item.sc.name,
      unit: item.sc.unit,
      billing_type: item.sc.billing_type,
    });
  }

  return {
    contractId,
    contractIndex,
    apartmentId: apt.id,
    apartmentCode: apt.code,
    bedrooms: apt.bedrooms,
    buildingId: apt.buildingId,
    buildingCode: apt.buildingCode,
    tenantId: tenant.tenantId,
    managerId,
    startDate,
    endDate,
    effectiveEndDate,
    terminatedAt,
    rentAmount: apt.baseRent,
    billingDay,
    paymentDueDays,
    status,
    subscriptions,
    servicePrices,
  };
}

seed().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
