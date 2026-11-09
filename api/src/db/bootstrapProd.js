import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { adminPool } from './client.js';

const __filename = fileURLToPath(import.meta.url);

export const BOOTSTRAP_ADVISORY_LOCK_KEY = 73918202;

const STANDARD_ROLES = [
  { code: 'OWNER', name: 'Chủ đầu tư / Chủ nhà', scope: 'org' },
  { code: 'MANAGER', name: 'Quản lý tòa nhà', scope: 'building' },
  { code: 'RESIDENT', name: 'Cư dân', scope: 'building' },
  { code: 'SYS_ADMIN', name: 'Quản trị hệ thống', scope: 'org' },
];

const STANDARD_SERVICE_CATALOG = [
  {
    code: 'ELECTRICITY',
    name: 'Điện sinh hoạt',
    category: 'ELECTRICITY',
    billing_type: 'METERED',
    unit: 'kWh',
    unit_price: 3800,
    description: 'Tính theo chỉ số công tơ điện hàng tháng',
  },
  {
    code: 'WATER',
    name: 'Nước sạch sinh hoạt',
    category: 'WATER',
    billing_type: 'METERED',
    unit: 'm³',
    unit_price: 22000,
    description: 'Tính theo đồng hồ nước từng căn hộ',
  },
  {
    code: 'INTERNET_FIBER',
    name: 'Internet Cáp quang 300M',
    category: 'INTERNET',
    billing_type: 'FIXED',
    unit: 'tháng',
    unit_price: 220000,
    description: 'Đường truyền tốc độ cao ổn định riêng cho căn hộ',
  },
  {
    code: 'MOTORBIKE_PARKING',
    name: 'Gửi xe máy hầm B1',
    category: 'PARKING',
    billing_type: 'QUANTITY',
    unit: 'xe/tháng',
    unit_price: 120000,
    description: 'Thẻ từ gửi xe máy định danh tại tầng hầm',
  },
  {
    code: 'CAR_PARKING',
    name: 'Đỗ xe ô tô hầm B2',
    category: 'PARKING',
    billing_type: 'QUANTITY',
    unit: 'xe/tháng',
    unit_price: 1250000,
    description: 'Vị trí đỗ ô tô có mái che tại hầm B2',
  },
  {
    code: 'CLEANING_WEEKLY',
    name: 'Dọn vệ sinh căn hộ',
    category: 'CLEANING',
    billing_type: 'QUANTITY',
    unit: 'lần/tháng',
    unit_price: 150000,
    description: 'Dịch vụ dọn phòng định kỳ theo yêu cầu cư dân',
  },
  {
    code: 'MANAGEMENT_FEE',
    name: 'Phí quản lý vận hành',
    category: 'MANAGEMENT',
    billing_type: 'FIXED',
    unit: 'tháng',
    unit_price: 350000,
    description: 'An ninh 24/7, lễ tân, chiếu sáng và vệ sinh khu chung',
  },
];

const STANDARD_SYSTEM_SETTINGS = [
  {
    key: 'billing_config',
    value: {
      billing_day: 1,
      payment_due_days: 5,
      due_date_offset_days: 5,
      late_fee_grace_days: 5,
      late_fee_per_day: 100000,
      late_fee_cap: null,
      meter_anomaly_threshold_pct: 30,
      reminder_days: [3, 7, 15],
      late_fee_percent: 0,
      electricity_default_price: 3800,
      water_default_price: 22000,
    },
    description: 'Cấu hình chu kỳ chốt chỉ số, phát hành hóa đơn và nhắc nợ (FR-005, FR-030..FR-036)',
  },
  {
    key: 'sla_config',
    value: {
      response_hours: 2,
      normal_resolve_hours: 24,
      urgent_resolve_hours: 4,
      deposit_refund_days: 5,
      reopen_window_days: 3,
    },
    description: 'Cam kết thời gian xử lý sự cố (SLA) và tất toán cọc',
  },
  {
    key: 'contact_config',
    value: {
      working_hours: '08:00 – 18:00 (Thứ 2 – Thứ 7)',
      technical_hotline: '1900 6868',
      security_hotline: '1900 9119',
      emergency_phone: '0909 113 114',
      support_email: 'support@resihub.vn',
    },
    description: 'Thông tin liên hệ Ban quản lý, kỹ thuật và khẩn cấp hiển thị trên Cổng cư dân',
  },
  {
    key: 'approval_config',
    value: {
      allow_self_approval: false,
    },
    description: 'Cấu hình quy tắc phê duyệt 4 mắt (Four-eyes)',
  },
  {
    key: 'reservation_cancel_policy',
    value: {
      max_hold_days: 30,
      public_max_hold_days: 7,
      full_refund_before_days: 3,
      partial_refund_pct: 50,
      default_hold_amount: 2000000,
    },
    description: 'Chính sách đặt cọc và hủy giữ chỗ (FR-005 / FR-067, làm tròn hàng nghìn VND theo PRD 10.3)',
  },
  {
    key: 'ai_config',
    value: {
      enabled: true,
      cccd_extract_enabled: true,
      contract_extract_enabled: true,
      meter_ocr_enabled: true,
      ticket_triage_enabled: true,
      model: 'gemini-2.5-flash',
      confidence_threshold: 0.75,
      meter_ocr_threshold: 0.8,
      triage_threshold: 0.7,
      monthly_budget_vnd: 500000,
      monthly_token_limit: 2000000,
      warn_percent: 80,
      suggestion_ttl_hours: 72,
    },
    description: 'Cấu hình AI Gateway (Kill switch, ngưỡng độ tin cậy, trần ngân sách tháng — M15)',
  },
];

export async function runProductionBootstrap({
  poolInstance = adminPool,
  envObj = process.env,
  closePool = false,
} = {}) {
  const client = await poolInstance.connect();
  let locked = false;
  let inTx = false;
  let syncedAppRole = false;
  let createdAdmin = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [BOOTSTRAP_ADVISORY_LOCK_KEY]);
    locked = true;

    await client.query('BEGIN');
    inTx = true;

    // 1. Sync RLS role password safely via PostgreSQL format(%L)
    if (envObj.APP_DB_PASSWORD && String(envObj.APP_DB_PASSWORD).trim() !== '') {
      const { rows } = await client.query(
        "SELECT format('ALTER ROLE resihub_app WITH LOGIN PASSWORD %L', $1::text) AS ddl",
        [String(envObj.APP_DB_PASSWORD)]
      );
      if (rows[0]?.ddl) {
        await client.query(rows[0].ddl);
        syncedAppRole = true;
      }
    }

    // 2. Ensure Organization exists
    let orgId = null;
    const orgRes = await client.query('SELECT id FROM organization ORDER BY created_at ASC LIMIT 1');
    if (orgRes.rows.length > 0) {
      orgId = orgRes.rows[0].id;
    } else {
      const orgName = String(envObj.INIT_ORG_NAME || 'Ban Quản Lý Tòa Nhà ResiHub').trim();
      const insOrg = await client.query(
        `INSERT INTO organization (name, settings)
         VALUES ($1, '{"currency":"VND","timezone":"Asia/Ho_Chi_Minh"}'::jsonb)
         RETURNING id`,
        [orgName]
      );
      orgId = insOrg.rows[0].id;
    }

    // 3. Ensure 4 standard roles exist
    for (const r of STANDARD_ROLES) {
      await client.query(
        `INSERT INTO role (org_id, code, name, scope)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, code) DO NOTHING`,
        [orgId, r.code, r.name, r.scope]
      );
    }
    const rolesRes = await client.query('SELECT id, code FROM role WHERE org_id = $1', [orgId]);
    const roleMap = Object.fromEntries(rolesRes.rows.map((row) => [row.code, row.id]));

    // 4. Ensure 7 standard service_catalog items and 6 system_setting keys exist without overwriting edits
    for (const sc of STANDARD_SERVICE_CATALOG) {
      await client.query(
        `INSERT INTO service_catalog (org_id, code, name, category, billing_type, unit, unit_price, description)
         SELECT $1, $2::varchar, $3, $4, $5, $6, $7, $8
         WHERE NOT EXISTS (
           SELECT 1 FROM service_catalog
           WHERE org_id = $1 AND building_id IS NULL AND lower(code) = lower($2)
         )`,
        [orgId, sc.code, sc.name, sc.category, sc.billing_type, sc.unit, sc.unit_price, sc.description]
      );
    }

    for (const st of STANDARD_SYSTEM_SETTINGS) {
      await client.query(
        `INSERT INTO system_setting (org_id, key, value, description)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (org_id, key) DO NOTHING`,
        [orgId, st.key, JSON.stringify(st.value), st.description]
      );
    }

    // 5. Ensure at least one SYS_ADMIN account exists if INIT_ADMIN_EMAIL + INIT_ADMIN_PASSWORD provided
    const sysCheck = await client.query(
      `SELECT 1 AS exists
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       WHERE r.code = 'SYS_ADMIN'
       LIMIT 1`
    );

    const adminEmail = String(envObj.INIT_ADMIN_EMAIL || '').trim().toLowerCase();
    const adminPassword = String(envObj.INIT_ADMIN_PASSWORD || '');

    if (sysCheck.rows.length === 0 && adminEmail && adminPassword) {
      if (adminPassword.length < 8) {
        throw new Error('INIT_ADMIN_PASSWORD phải có ít nhất 8 ký tự.');
      }
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      const adminPhone = String(envObj.INIT_ADMIN_PHONE || '0900000001').trim();

      const personRes = await client.query(
        `INSERT INTO person (org_id, full_name, phone, email)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [orgId, 'Quản trị hệ thống', adminPhone, adminEmail]
      );
      const personId = personRes.rows[0].id;

      const userRes = await client.query(
        `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
         VALUES ($1, $2, $3, 'ACTIVE')
         RETURNING id`,
        [personId, 'sys-admin-init', passwordHash]
      );
      const userId = userRes.rows[0].id;

      await client.query(
        `INSERT INTO user_role (user_id, role_id, building_id)
         VALUES ($1, $2, NULL)`,
        [userId, roleMap.SYS_ADMIN]
      );
      createdAdmin = true;
    }

    await client.query('COMMIT');
    inTx = false;

    console.log(
      `[Bootstrap] Completed (orgId=${orgId}, syncedAppRole=${syncedAppRole}, createdAdmin=${createdAdmin}).`
    );
    return { orgId, createdAdmin, syncedAppRole };
  } catch (err) {
    if (inTx) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw err;
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [BOOTSTRAP_ADVISORY_LOCK_KEY]).catch(() => {});
    }
    client.release();
    if (closePool) {
      await poolInstance.end();
    }
  }
}

const isDirectCli =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectCli) {
  runProductionBootstrap({ closePool: true }).catch((err) => {
    console.error('[Bootstrap] Fatal error:', err.message);
    process.exit(1);
  });
}
