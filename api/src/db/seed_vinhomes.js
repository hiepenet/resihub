/**
 * seed_vinhomes.js — Seed dữ liệu test Vinhomes Ocean Park 1, 2, 3 cho ResiHub
 *
 * Cấu trúc dữ liệu:
 *   1. Xóa toàn bộ dữ liệu cũ (TRUNCATE CASCADE)
 *   2. Organization, 4 Roles (OWNER, MANAGER, RESIDENT, SYS_ADMIN), System Settings, 7 Service Catalog
 *   3. 1 Owner dùng chung + 3 Tòa nhà (Vinhomes Ocean Park 1, 2, 3) + 3 Manager riêng biệt + 1 SYS_ADMIN
 *   4. Mỗi tòa: 3 Khu (Khu A, Khu B, Khu C), 10 Tầng (Tầng 1..10), 80 căn hộ/tòa (8 căn/tầng) = 240 căn hộ
 *   5. Hồ sơ dân cư (~261 cư dân tên tiếng Việt thực tế, CCCD, SĐT, tài khoản RESIDENT)
 *   6. Hợp đồng thuê nhà (~260 hợp đồng từ 01/01/2025 -> 06/11/2026, kiểm tra chồng lấn kỳ hạn, chọn dịch vụ)
 *      + Sổ cọc & giao dịch thu/hoàn cọc (cọc không cấn trừ vào tiền thuê, hoàn trong 3-5 ngày sau chấm dứt)
 *   7. Đồng hồ điện/nước & chỉ số hàng tháng đến hết tháng 10/2026 (CONFIRMED)
 *   8. Hóa đơn hàng tháng từ tháng 01/2025 đến hết tháng 10/2026 (tính pro-rata chính xác theo ngày)
 *      — Chưa sinh hóa đơn tháng 11/2026 để người dùng tự click Sinh hóa đơn hàng loạt tháng 11 trên UI.
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

// Deterministic pseudo-random helper for reproducible test data
let rngState = 20261106;
export function seededRandom() {
  rngState = (rngState * 1664525 + 1013904223) % 4294967296;
  return rngState / 4294967296;
}

export function randomInt(a, b) {
  return Math.floor(seededRandom() * (b - a + 1)) + a;
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
    console.log('  ResiHub — Vinhomes Ocean Park 1, 2, 3 Full Test Data Seed');
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
      { id: '33333333-3333-4333-8333-000000000001', mgPersonId: '22222222-2222-4222-9222-000000000011', mgUserId: '22222222-2222-4222-8222-000000000011', code: 'VOP-1', name: 'Vinhomes Ocean Park 1', address: 'Đại đô thị Vinhomes Ocean Park 1, Đa Tốn, Gia Lâm, Hà Nội', num: 1, mgName: 'Nguyễn Minh Quản Lý VOP1', mgEmail: 'manager.vop1@resihub.vn', mgPhone: phone(5000011), mgIdNo: idNumber(5000011) },
      { id: '33333333-3333-4333-8333-000000000002', mgPersonId: '22222222-2222-4222-9222-000000000012', mgUserId: '22222222-2222-4222-8222-000000000012', code: 'VOP-2', name: 'Vinhomes Ocean Park 2', address: 'Đại đô thị Vinhomes Ocean Park 2 - The Empire, Văn Giang, Hưng Yên', num: 2, mgName: 'Trần Hoàng Quản Lý VOP2', mgEmail: 'manager.vop2@resihub.vn', mgPhone: phone(5000012), mgIdNo: idNumber(5000012) },
      { id: '33333333-3333-4333-8333-000000000003', mgPersonId: '22222222-2222-4222-9222-000000000013', mgUserId: '22222222-2222-4222-8222-000000000013', code: 'VOP-3', name: 'Vinhomes Ocean Park 3', address: 'Đại đô thị Vinhomes Ocean Park 3 - The Crown, Văn Lâm, Hưng Yên', num: 3, mgName: 'Lê Thanh Quản Lý VOP3', mgEmail: 'manager.vop3@resihub.vn', mgPhone: phone(5000013), mgIdNo: idNumber(5000013) },
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

      buildings.push({ id: bldg.id, code: bm.code, name: bm.name, num: bm.num });
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
      { zone: 'A', no: 1, bedrooms: 1, area: 42, rentBase: 7000000 },
      { zone: 'A', no: 2, bedrooms: 2, area: 58, rentBase: 9500000 },
      { zone: 'A', no: 3, bedrooms: 1, area: 40, rentBase: 6800000 },
      { zone: 'B', no: 1, bedrooms: 2, area: 65, rentBase: 10500000 },
      { zone: 'B', no: 2, bedrooms: 3, area: 85, rentBase: 14000000 },
      { zone: 'B', no: 3, bedrooms: 2, area: 60, rentBase: 9800000 },
      { zone: 'C', no: 1, bedrooms: 1, area: 45, rentBase: 7500000 },
      { zone: 'C', no: 2, bedrooms: 2, area: 70, rentBase: 11000000 },
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
          const baseRent = spec.rentBase + floor.level * 100000;

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

    // Mỗi tòa cần: 18 tenant cho HĐ lịch sử (đã kết thúc trong 2025) + 52 tenant cho HĐ đang ACTIVE = 70 tenant/tòa (tổng 210)
    // Tạo 87 tenant/tòa = 261 cư dân (bao gồm cả cư dân dự phòng / occupant)
    for (const bldg of buildings) {
      tenantsByBuilding[bldg.id] = [];
      const mgUserId = managerByBuilding[bldg.id];

      for (let i = 0; i < 87; i++) {
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

    // ── TASK 6: Hợp đồng thuê (>150 HĐ, 01/01/2025 -> 06/11/2026) + Deposits + Subscriptions ─
    console.log('\n[6/8] Tạo Hợp đồng thuê (>150 HĐ), Sổ cọc (thu/hoàn 3-5 ngày) & Đăng ký dịch vụ...');

    const existingContracts = [];
    const contractList = [];
    let overlapCheckedCount = 0;
    let contractCounter = 0;

    // Chọn các mốc ngày bắt đầu đa dạng (cả ngày mùng 1 và ngày lẻ giữa tháng để kiểm chứng pro-rata)
    const lote1StartDates = [
      '2025-01-01', '2025-01-10', '2025-01-15', '2025-02-01', '2025-02-12',
      '2025-03-01', '2025-03-15', '2025-04-01', '2025-04-10', '2025-05-01',
      '2025-05-20', '2025-06-01',
    ];
    const lote2StartDates = [
      '2025-01-01', '2025-01-05', '2025-01-15', '2025-02-01',
    ];
    const lote2EndDates = [
      { endDate: '2025-07-01', lastActiveDay: '2025-06-30', nextStartDate: '2025-07-01' },
      { endDate: '2025-07-16', lastActiveDay: '2025-07-15', nextStartDate: '2025-07-16' },
      { endDate: '2025-08-01', lastActiveDay: '2025-07-31', nextStartDate: '2025-08-01' },
      { endDate: '2025-09-01', lastActiveDay: '2025-08-31', nextStartDate: '2025-09-01' },
    ];

    let heldDepositCount = 0;
    let refundedDepositCount = 0;
    let subscriptionCount = 0;
    let overridePriceCount = 0;

    for (const bldg of buildings) {
      const apts = aptsByBuilding[bldg.id];
      const bTenants = tenantsByBuilding[bldg.id];
      const mgUserId = managerByBuilding[bldg.id];
      let bTenantCursor = 0;

      // Nhóm A (Căn 0..33 = 34 căn/tòa): 1 Hợp đồng ACTIVE xuyên suốt từ đầu/giữa 2025 -> 2026-11-06
      for (let i = 0; i < 34; i++) {
        const apt = apts[i];
        const tenant = bTenants[bTenantCursor++];
        const startDate = lote1StartDates[i % lote1StartDates.length];
        const endDate = '2026-11-06';
        const effectiveEndDate = '2026-11-05';
        const billingDay = (i % 10) + 1;

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
          status: 'ACTIVE',
          contractIndex: ++contractCounter,
          serviceCatalogMap,
        });

        existingContracts.push({
          apartmentId: apt.id,
          startDate,
          endDate,
          effectiveEndDate,
        });
        contractList.push(created);
        heldDepositCount++;
        subscriptionCount += created.subscriptions.length;
        overridePriceCount += created.servicePrices.length;
      }

      // Nhóm B (Căn 34..51 = 18 căn/tòa):
      //   - Đợt 1: Hợp đồng lịch sử trong năm 2025 (EXPIRED / TERMINATED) -> đã hoàn cọc trong 3-5 ngày
      //   - Đợt 2: Hợp đồng ACTIVE nối tiếp từ 2025 -> 2026-11-06 (không chồng lấn kỳ hạn)
      for (let i = 34; i < 52; i++) {
        const apt = apts[i];
        const splitSpec = lote2EndDates[i % lote2EndDates.length];
        const start1 = lote2StartDates[i % lote2StartDates.length];
        const end1 = splitSpec.endDate;
        const lastActive1 = splitSpec.lastActiveDay;
        const isTerminatedEarly = i % 3 === 0;
        const status1 = isTerminatedEarly ? 'TERMINATED' : 'EXPIRED';
        const terminatedAt1 = isTerminatedEarly ? lastActive1 : null;
        const tenant1 = bTenants[bTenantCursor++];
        const billingDay1 = (i % 8) + 1;

        overlapCheckedCount++;
        if (hasOverlap(existingContracts, apt.id, start1, lastActive1)) {
          throw new Error(`Phát hiện chồng lấn kỳ hạn hợp đồng đợt 1 trên căn hộ ${apt.code}`);
        }

        const created1 = await insertContractWithDepositAndServices(client, {
          orgId,
          apt,
          tenant: tenant1,
          managerId: mgUserId,
          startDate: start1,
          endDate: end1,
          effectiveEndDate: lastActive1,
          terminatedAt: terminatedAt1,
          terminationReason: isTerminatedEarly ? 'Khách thuê chuyển công tác, thỏa thuận chấm dứt hợp đồng' : null,
          billingDay: billingDay1,
          status: status1,
          contractIndex: ++contractCounter,
          serviceCatalogMap,
        });

        // Cập nhật trạng thái tenant cũ sang MOVED_OUT
        await client.query(`UPDATE tenant SET status = 'MOVED_OUT' WHERE id = $1`, [tenant1.tenantId]);

        existingContracts.push({
          apartmentId: apt.id,
          startDate: start1,
          endDate: end1,
          effectiveEndDate: lastActive1,
        });
        contractList.push(created1);
        refundedDepositCount++;
        subscriptionCount += created1.subscriptions.length;
        overridePriceCount += created1.servicePrices.length;

        // Đợt 2: Hợp đồng ACTIVE kế tiếp trên cùng căn hộ
        const start2 = splitSpec.nextStartDate;
        const end2 = '2026-11-06';
        const lastActive2 = '2026-11-05';
        const tenant2 = bTenants[bTenantCursor++];
        const billingDay2 = ((i + 3) % 10) + 1;

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
          status: 'ACTIVE',
          contractIndex: ++contractCounter,
          serviceCatalogMap,
        });

        existingContracts.push({
          apartmentId: apt.id,
          startDate: start2,
          endDate: end2,
          effectiveEndDate: lastActive2,
        });
        contractList.push(created2);
        heldDepositCount++;
        subscriptionCount += created2.subscriptions.length;
        overridePriceCount += created2.servicePrices.length;
      }

      // Cập nhật trạng thái căn hộ có hợp đồng ACTIVE sang OCCUPIED
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
    }

    const activeContractsCount = contractList.filter((c) => c.status === 'ACTIVE').length;
    const endedContractsCount = contractList.length - activeContractsCount;
    console.log(
      `   ✓ Đã tạo ${contractList.length} hợp đồng (ACTIVE: ${activeContractsCount}, EXPIRED/TERMINATED: ${endedContractsCount}) — Kiểm tra chống chồng lấn: ${overlapCheckedCount} lần (0 xung đột).`
    );
    console.log(
      `   ✓ Sổ cọc: ${heldDepositCount} HELD, ${refundedDepositCount} REFUNDED (hoàn trong 3-5 ngày, không cấn trừ tiền thuê).`
    );
    console.log(
      `   ✓ Dịch vụ đăng ký: ${subscriptionCount} gói | Giá ghi đè cấp HĐ: ${overridePriceCount} mục.`
    );

    // ── TASK 7: Đồng hồ Điện/Nước & Chỉ số hàng tháng đến hết tháng 10/2026 ─
    console.log('\n[7/8] Tạo Đồng hồ Điện/Nước & Chỉ số hàng tháng (đến hết tháng 10/2026)...');

    // Nhóm hợp đồng theo căn hộ theo thứ tự thời gian để chuỗi chỉ số (previous -> current) liên tục
    const contractsByApt = new Map();
    for (const c of contractList) {
      if (!contractsByApt.has(c.apartmentId)) contractsByApt.set(c.apartmentId, []);
      contractsByApt.get(c.apartmentId).push(c);
    }
    for (const list of contractsByApt.values()) {
      list.sort((a, b) => a.startDate.localeCompare(b.startDate));
    }

    const meterByApt = {};
    // Key: `${contractId}_${period}` -> { elReading, wtReading }
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

      let elPrev = randomInt(500, 1500);
      let wtPrev = randomInt(40, 120);

      for (const c of aptContracts) {
        // Ghi chỉ số đến hết tháng 10/2026 cho hợp đồng kết thúc trước 11/2026,
        // và ghi sẵn chỉ số kỳ 2026-11 (CONFIRMED) cho các hợp đồng ACTIVE để người dùng có thể click Sinh hóa đơn hàng loạt tháng 11 trên UI ngay!
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

          const elCons = randomInt(110, 240);
          const wtCons = randomInt(6, 16);
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

    // Tạo đồng hồ cho cả các căn hộ đang trống (AVAILABLE) để tổng đồng hồ đủ 480 công tơ (240 căn x 2)
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

    // ── TASK 8: Hóa đơn hàng tháng (01/2025 -> 10/2026, Pro-rata chính xác) ─
    console.log('\n[8/8] Tạo Hóa đơn hàng tháng (01/2025 -> 10/2026, tính Pro-rata theo ngày) & Thanh toán...');
    console.log('      (Không sinh hóa đơn tháng 11/2026 để người dùng tự click Sinh hóa đơn hàng loạt trên UI)');

    let invoiceSeq = 1;
    let paidInvoiceCount = 0;
    let issuedInvoiceCount = 0;
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
        const dueDate = addDays(issueDate, 5);
        const invCode = `INV-${period.replace('-', '')}-${c.buildingCode}-${c.apartmentCode}-${String(invoiceSeq++).padStart(4, '0')}`;

        // Tất cả các kỳ lịch sử (< 2026-10) và hầu hết kỳ 2026-10 đã thanh toán PAID;
        // Để lại một số hóa đơn kỳ 2026-10 của HĐ ACTIVE ở trạng thái ISSUED (còn công nợ OPEN) để báo cáo công nợ sinh động
        const isUnpaidOct2026 =
          period === '2026-10' && c.status === 'ACTIVE' && c.contractIndex % 9 === 0;
        const invStatus = isUnpaidOct2026 ? 'ISSUED' : 'PAID';
        const paidAmount = isUnpaidOct2026 ? 0 : subtotal;

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

        if (invStatus === 'PAID') {
          const paidDate = addDays(issueDate, 2);
          await client.query(
            `INSERT INTO payment (
               org_id, building_id, invoice_id, contract_id, tenant_id,
               payment_code, amount, method, reference_code, status,
               paid_at, note, reported_by, confirmed_by, confirmed_at, created_at
             )
             VALUES (
               $1, $2, $3, $4, $5,
               $6, $7, 'BANK_TRANSFER', $8, 'CONFIRMED',
               ($9::date)::timestamptz, 'Thanh toán hóa đơn kỳ ' || $10, $11, $11, ($9::date)::timestamptz, ($9::date)::timestamptz
             );`,
            [
              orgId,
              c.buildingId,
              invRow.id,
              c.contractId,
              c.tenantId,
              `PAY-${invCode}`,
              subtotal,
              `VCB${period.replace('-', '')}${String(invoiceSeq).padStart(5, '0')}`,
              paidDate,
              period,
              c.managerId,
            ]
          );
          await client.query(
            `INSERT INTO receivable (
               org_id, building_id, contract_id, tenant_id, invoice_id,
               type, amount, paid_amount, due_date, status, description, created_at, updated_at
             )
             VALUES (
               $1, $2, $3, $4, $5,
               'INVOICE_DEBT', $6, $6, $7::date, 'PAID', $8, ($7::date)::timestamptz, ($7::date)::timestamptz
             );`,
            [
              orgId,
              c.buildingId,
              c.contractId,
              c.tenantId,
              invRow.id,
              subtotal,
              dueDate,
              `Công nợ hóa đơn ${invCode} kỳ ${period}`,
            ]
          );
          paidInvoiceCount++;
          paymentCount++;
          receivableCount++;
        } else {
          await client.query(
            `INSERT INTO receivable (
               org_id, building_id, contract_id, tenant_id, invoice_id,
               type, amount, paid_amount, due_date, status, description, created_at, updated_at
             )
             VALUES (
               $1, $2, $3, $4, $5,
               'INVOICE_DEBT', $6, 0, $7::date, 'OPEN', $8, ($7::date)::timestamptz, ($7::date)::timestamptz
             );`,
            [
              orgId,
              c.buildingId,
              c.contractId,
              c.tenantId,
              invRow.id,
              subtotal,
              dueDate,
              `Công nợ hóa đơn ${invCode} kỳ ${period}`,
            ]
          );
          issuedInvoiceCount++;
          receivableCount++;
        }
      }
    }

    console.log(
      `   ✓ Đã tạo ${paidInvoiceCount + issuedInvoiceCount} hóa đơn (PAID: ${paidInvoiceCount}, ISSUED kỳ 10/2026: ${issuedInvoiceCount}, Pro-rata: ${proratedInvoiceCount} kỳ).`
    );
    console.log(
      `   ✓ Chi tiết dòng hóa đơn: ${invoiceLineCount} | Giao dịch thanh toán: ${paymentCount} | Khoản phải thu: ${receivableCount}.`
    );

    // Đánh dấu cron_job_run SUCCEEDED cho hôm nay để startDailyJobs() khi boot server không tự chạy catch-up làm thay đổi dữ liệu vừa seed
    await client.query(`
      INSERT INTO cron_job_run (job_name, run_date, status, attempt_count, started_at, finished_at)
      VALUES
        ('DAILY_BILLING_SYNC', '2026-11-06'::date, 'SUCCEEDED', 1, NOW(), NOW()),
        ('DAILY_BILLING_SYNC', '2026-11-07'::date, 'SUCCEEDED', 1, NOW(), NOW()),
        ('DAILY_BILLING_SYNC', (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'SUCCEEDED', 1, NOW(), NOW());
    `);

    await client.query('COMMIT');

    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('  ✅ SEED HOÀN TẤT — SẴN SÀNG TEST SINH HÓA ĐƠN HÀNG LOẠT THÁNG 11');
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
       $6, 'monthly', $7, 5,
       $8, $9, $10::date, $11,
       $12, ($4::date)::timestamptz, NOW()
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
  if (contractIndex % 6 === 0) {
    chosenSubs.push({
      sc: serviceCatalogMap.CAR_PARKING,
      qty: 1,
      plates: [`30H-${String(20000 + contractIndex).slice(0, 5)}`],
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
    status,
    subscriptions,
    servicePrices,
  };
}

seed().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
