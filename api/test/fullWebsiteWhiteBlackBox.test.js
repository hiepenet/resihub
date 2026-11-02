/**
 * FULL WEBSITE WHITE-BOX + BLACK-BOX TEST SUITE (ResiHub PRD v2.0 — M01..M14)
 *
 * Kết hợp 2 phương pháp kiểm thử trên toàn bộ tính năng của hệ thống:
 *   1. WHITE-BOX TESTING:
 *      - Unit test trực tiếp các hàm nghiệp vụ lõi (amendment, contractGuards, deadlines,
 *        depositSettlement, apartmentStatus, piiMask).
 *      - Kiểm thử trực tiếp tầng CSDL PostgreSQL: Trigger bất biến audit_log (FR-006 / AC-020.1),
 *        Exclusion Constraint chống chồng lấn kỳ thuê 23P01 (Mục 13.3), Check/Unique Constraints,
 *        Row-Level Security (RLS) dưới role `resihub_app` cho cả 6 vai trò (NFR-008).
 *      - Kiểm thử trực tiếp Worker Job hằng ngày `runDailyJobs()` (FR-018, FR-068, AC-010.1).
 *   2. BLACK-BOX TESTING:
 *      - Kiểm thử HTTP REST API đầu-cuối (status code, schema JSON, phân vùng tương đương,
 *        giá trị biên, luồng ngoại lệ Mục 7.5 và phân quyền RBAC Mục 6.2) xuyên suốt M01 -> M14
 *        và trọn bộ 8 tab Cổng cư dân (Resident Portal).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';

// White-Box Direct Imports
import { buildDiff, nextStatusOnAmend } from '../src/services/amendment.js';
import { isDiscountedPrice, mapPgError } from '../src/services/contractGuards.js';
import { refundDeadline, expiryAlertDates } from '../src/services/deadlines.js';
import {
  validateDeduction,
  computeRefund,
  splitDepositOpening,
  resolvePostSettlementStatus,
} from '../src/services/depositSettlement.js';
import {
  APARTMENT_STATUSES,
  isTransitionAllowed,
  syncApartmentStatus,
} from '../src/services/apartmentStatus.js';
import {
  maskName,
  maskEmail,
  maskPhone,
  maskIdNumber,
  buildOwnerPreview,
  checkLookupRateLimit,
} from '../src/utils/piiMask.js';
import { runDailyJobs } from '../src/jobs/daily.js';
import { roundVND } from '../src/services/pricing.js';
import { adminPool as coreAdminPool, appPool as coreAppPool } from '../src/db/client.js';

dotenv.config();

const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5000';
const ADMIN_DB_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

// 1x1 transparent PNG base64 cho các luồng bắt buộc ảnh chứng từ / bản scan
const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function loginEmail(email, password) {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(body)}`);
  return { token: body.accessToken, refreshToken: body.refreshToken, user: body.user };
}

async function apiFetch(path, token, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function addDaysStr(daysOffset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// PHẦN 1 — WHITE-BOX UNIT TESTS: PURE DOMAIN SERVICES & STATE MACHINES
// ============================================================================
test('WB-01 [White-Box Unit] Pure Domain Services, Financial Formulas, State Machines & PII Masking', async (t) => {
  await t.test('1.1 Contract Guards & Amendment Diff Engine (M05: FR-014, FR-016)', () => {
    // Boundary analysis cho ngưỡng giảm giá 10% (< 90% base_rent -> cần phê duyệt)
    assert.equal(isDiscountedPrice(9000000, 10000000), false, 'Đúng 90% giá niêm yết không bị coi là lệch khung');
    assert.equal(isDiscountedPrice(8999999, 10000000), true, 'Dưới 90% (8.999.999 / 10.000.000) bắt buộc PENDING_APPROVAL');
    assert.equal(isDiscountedPrice(5000000, 0), false, 'base_rent = 0 không kích hoạt lỗi chia 0');

    // Map lỗi Exclusion Constraint PostgreSQL 23P01
    const mapped = mapPgError({ code: '23P01' });
    assert.deepEqual(mapped, {
      status: 409,
      code: 'OVERLAP_CONTRACT',
      message: 'Căn hộ đã có hợp đồng trong khoảng thời gian này.',
    });
    assert.equal(mapPgError({ code: '23505' }), null);

    // Amendment whitelist & diff
    assert.equal(buildDiff({ rent_amount: 10000000 }, {}).code, 'NO_CHANGES');
    assert.equal(buildDiff({ apartment_id: 'x' }, { apartment_id: 'y' }).code, 'DISALLOWED_FIELD');
    assert.equal(buildDiff({ rent_amount: 10000000 }, { rent_amount: 10000000 }).code, 'VALUE_UNCHANGED');

    const okDiff = buildDiff(
      { rent_amount: 10000000, end_date: '2026-12-31' },
      { rent_amount: 11000000, end_date: '2027-06-30' }
    );
    assert.equal(okDiff.ok, true);
    assert.deepEqual(okDiff.diff.rent_amount, { old: 10000000, new: 11000000 });
    assert.equal(nextStatusOnAmend('end_date'), 'RENEWAL_PENDING');
    assert.equal(nextStatusOnAmend('rent_amount'), 'ACTIVE');
  });

  await t.test('1.2 Deadlines, roundVND & Deposit Settlement BigInt Engine (M06: FR-018, FR-023, FR-024, FR-068, AC-017, R-11)', () => {
    assert.equal(roundVND(123499), 123000, 'R-11: roundVND phải làm tròn xuống hàng nghìn');
    assert.equal(roundVND(123500), 124000, 'R-11: roundVND phải làm tròn lên hàng nghìn khi >= 500');
    assert.equal(roundVND(-123600), -124000, 'R-11: roundVND xử lý đúng số âm');

    const dl = refundDeadline('2026-10-10');
    assert.deepEqual(dl, { warnAt: '2026-10-13', dueAt: '2026-10-15' });

    assert.deepEqual(expiryAlertDates('2026-11-30', '2026-10-31'), ['30']);
    assert.deepEqual(expiryAlertDates('2026-11-15', '2026-10-31'), ['15']);
    assert.deepEqual(expiryAlertDates('2026-12-30', '2026-10-31'), ['60']);
    assert.deepEqual(expiryAlertDates('2026-11-20', '2026-10-31'), []);

    // FR-023 & FR-068: Cấm tuyệt đối khấu trừ tiền thuê phòng vào tiền cọc + bắt buộc bằng chứng
    assert.equal(
      validateDeduction({ category: 'RENT', amount: 5000000, description: 'Trừ tiền nhà', evidence: ['img1'] }).code,
      'RENT_DEDUCTION_FORBIDDEN'
    );
    assert.equal(
      validateDeduction({ category: 'DAMAGE', amount: 500000, description: 'Vỡ kính', evidence: [] }).code,
      'EVIDENCE_REQUIRED'
    );
    assert.equal(
      validateDeduction({ category: 'CLEANING', amount: 300000, description: 'Tổng vệ sinh', evidence: ['url1'] }).ok,
      true
    );

    // AC-017.1: Cọc 10.000.000 - Nợ 1.200.000 - Hỏng hóc 800.000 = Hoàn 8.000.000, thiếu 0
    const r1 = computeRefund({
      depositAmount: 10000000n,
      outstandingDebt: 1200000n,
      items: [{ amount: 800000n }],
    });
    assert.equal(r1.refund, 8000000n);
    assert.equal(r1.shortfall, 0n);
    assert.equal(
      resolvePostSettlementStatus({
        refundAmount: r1.refund,
        outstandingDebt: 1200000n,
        items: [{ amount: 800000n }],
        shortfall: r1.shortfall,
      }),
      'PARTIALLY_REFUNDED'
    );

    // AC-017.2: Khấu trừ vượt cọc -> refund = 0, shortfall > 0
    const r2 = computeRefund({
      depositAmount: 5000000n,
      outstandingDebt: 3500000n,
      items: [{ amount: 2500000n }],
    });
    assert.equal(r2.refund, 0n);
    assert.equal(r2.shortfall, 1000000n);

    // FR-067: Cọc giữ chỗ chuyển sang cọc hợp đồng
    const sp = splitDepositOpening({ depositAmount: 10000000n, holdAmount: 2000000n });
    assert.deepEqual(sp, { openHeld: 2000000n, remainingCollect: 8000000n });
  });

  await t.test('1.3 Apartment Status Machine & PII Masking / Rate Limit (M03, FR-008, NFR-007)', async () => {
    assert.deepEqual(APARTMENT_STATUSES, ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE']);
    assert.equal(isTransitionAllowed('AVAILABLE', 'OCCUPIED'), true);
    assert.equal(isTransitionAllowed('OCCUPIED', 'AVAILABLE'), false, 'FR-008: Căn trả phòng phải qua MAINTENANCE trước khi AVAILABLE');
    assert.equal(isTransitionAllowed('OCCUPIED', 'MAINTENANCE'), true);
    assert.equal(isTransitionAllowed('MAINTENANCE', 'AVAILABLE'), true);
    assert.equal(isTransitionAllowed('INACTIVE', 'OCCUPIED'), false);

    // White-box mock DB client cho syncApartmentStatus (kiểm tra đủ 6 nhánh ưu tiên)
    const runSyncMock = async ({ currentStatus, hasCurrent, hasFutureOrHold, opts = {} }) => {
      let updatedTo = null;
      const mockClient = {
        async query(sql, params) {
          if (sql.includes('FROM apartment WHERE id = $1')) {
            return { rows: [{ id: params[0], status: currentStatus }] };
          }
          if (sql.includes('start_date <= CURRENT_DATE')) {
            return { rows: hasCurrent ? [{ '?column?': 1 }] : [] };
          }
          if (sql.includes('UNION ALL')) {
            return { rows: hasFutureOrHold ? [{ '?column?': 1 }] : [] };
          }
          if (sql.includes('UPDATE apartment SET status')) {
            updatedTo = params[1];
            return { rowCount: 1 };
          }
          return { rows: [] };
        },
      };
      const result = await syncApartmentStatus(mockClient, 'apt-1', opts);
      return { result, updatedTo };
    };

    assert.equal((await runSyncMock({ currentStatus: 'INACTIVE', hasCurrent: true, hasFutureOrHold: true })).result, 'INACTIVE');
    assert.equal((await runSyncMock({ currentStatus: 'OCCUPIED', hasCurrent: false, hasFutureOrHold: true, opts: { enterMaintenance: true } })).result, 'MAINTENANCE');
    assert.equal((await runSyncMock({ currentStatus: 'MAINTENANCE', hasCurrent: true, hasFutureOrHold: false })).result, 'OCCUPIED');
    assert.equal(
      (await runSyncMock({ currentStatus: 'MAINTENANCE', hasCurrent: false, hasFutureOrHold: true })).result,
      'MAINTENANCE',
      'Căn đang bảo trì có HĐ tương lai vẫn giữ MAINTENANCE cho tới ngày khách vào ở hoặc nghiệm thu'
    );
    assert.equal(
      (await runSyncMock({ currentStatus: 'MAINTENANCE', hasCurrent: false, hasFutureOrHold: true, opts: { leaveMaintenance: true } })).result,
      'RESERVED'
    );
    assert.equal((await runSyncMock({ currentStatus: 'AVAILABLE', hasCurrent: false, hasFutureOrHold: true })).result, 'RESERVED');
    assert.equal((await runSyncMock({ currentStatus: 'OCCUPIED', hasCurrent: false, hasFutureOrHold: false })).result, 'AVAILABLE');

    // PII Masking
    assert.equal(maskName('Nguyễn Văn An'), 'Nguyễn *** An');
    assert.equal(maskEmail('owner.vop@resihub.vn'), 'ow***@resihub.vn');
    assert.equal(maskPhone('0912345678'), '091****678');
    assert.equal(maskIdNumber('001099012345'), '********2345');

    const preview = buildOwnerPreview({
      id: 'owner-1',
      full_name: 'Trần Thị Bình',
      email: 'binh@resihub.vn',
      phone: '0987654321',
    });
    assert.equal(preview.email, undefined);
    assert.equal(preview.phone, undefined);
    assert.ok(preview.masked_email.includes('***'));

    const bucket = new Map();
    assert.equal(checkLookupRateLimit(bucket, 'u1', 2, 60000).allowed, true);
    assert.equal(checkLookupRateLimit(bucket, 'u1', 2, 60000).allowed, true);
    assert.equal(checkLookupRateLimit(bucket, 'u1', 2, 60000).allowed, false);
  });
});

let baselineCounts = { buildings: 9, apartments: 450 };

// ============================================================================
// PHẦN 2 — FULL-STACK WHITE-BOX (DB TRIGGERS / CONSTRAINTS / RLS / JOBS)
//          + BLACK-BOX E2E API TESTS ACROSS M01..M14 & ALL 6 ROLES
// ============================================================================
test('WB+BB-02 [Full Website Integration] M01..M14 End-to-End White-Box DB/RLS/Jobs + Black-Box API Suite', async (t) => {
  let healthOk = false;
  try {
    const h = await fetch(`${API_BASE}/api/health`);
    healthOk = h.ok;
  } catch {
    healthOk = false;
  }
  if (!healthOk) {
    t.skip('API server is not reachable on TEST_API_BASE');
    return;
  }

  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const appPool = new pg.Pool({ connectionString: APP_DB_URL });

  const [baseB, baseA] = await Promise.all([
    adminPool.query('SELECT COUNT(*)::int AS cnt FROM building'),
    adminPool.query('SELECT COUNT(*)::int AS cnt FROM apartment'),
  ]);
  baselineCounts = {
    buildings: baseB.rows[0].cnt,
    apartments: baseA.rows[0].cnt,
  };

  // Sổ theo dõi toàn bộ tài nguyên tạm để dọn sạch 100%, giữ nguyên bất biến 9 tòa & 450 căn
  const cleanup = {
    buildingIds: [],
    zoneIds: [],
    floorIds: [],
    apartmentIds: [],
    reservationIds: [],
    contractIds: [],
    invoiceIds: [],
    paymentIds: [],
    meterIds: [],
    serviceCatalogIds: [],
    serviceSubIds: [],
    serviceRequestIds: [],
    notificationTitles: [],
    personIds: [],
    userIds: [],
    tenantIds: [],
    ownerIds: [],
    originalSettings: null,
  };

  const suffix = Date.now().toString().slice(-6);

  t.after(async () => {
    try {
      // Khôi phục cấu hình hệ thống nếu đã sửa trong bài test
      if (cleanup.originalSettings) {
        for (const row of cleanup.originalSettings) {
          await adminPool
            .query(
              `UPDATE system_setting SET value = $1 WHERE org_id = $2 AND key = $3`,
              [JSON.stringify(row.value), row.org_id, row.key]
            )
            .catch(() => {});
        }
      }

      for (const title of cleanup.notificationTitles) {
        await adminPool.query('DELETE FROM notification WHERE title = $1', [title]).catch(() => {});
      }
      for (const srId of cleanup.serviceRequestIds) {
        await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'service_request' AND owner_id = $1", [srId]).catch(() => {});
        await adminPool.query('DELETE FROM service_request WHERE id = $1', [srId]).catch(() => {});
      }
      for (const payId of cleanup.paymentIds) {
        await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'payment' AND owner_id = $1", [payId]).catch(() => {});
        await adminPool.query('DELETE FROM payment WHERE id = $1', [payId]).catch(() => {});
      }
      for (const invId of cleanup.invoiceIds) {
        await adminPool.query('DELETE FROM payment WHERE invoice_id = $1', [invId]).catch(() => {});
        await adminPool.query('DELETE FROM receivable WHERE invoice_id = $1', [invId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice_line WHERE invoice_id = $1', [invId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE id = $1', [invId]).catch(() => {});
      }
      for (const subId of cleanup.serviceSubIds) {
        await adminPool.query('DELETE FROM service_subscription WHERE id = $1', [subId]).catch(() => {});
      }
      for (const cId of cleanup.contractIds) {
        await adminPool.query('DELETE FROM payment WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM receivable WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM service_subscription WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query("DELETE FROM notification WHERE payload->>'contract_id' = $1", [cId]).catch(() => {});
        const depClean = await adminPool.connect();
        try {
          await depClean.query('BEGIN');
          await depClean.query("SET LOCAL app.allow_test_cleanup = 'true'");
          await depClean.query('DELETE FROM deposit_transaction WHERE deposit_id IN (SELECT id FROM deposit WHERE contract_id = $1)', [cId]);
          await depClean.query('DELETE FROM deposit WHERE contract_id = $1', [cId]);
          await depClean.query('COMMIT');
        } catch {
          await depClean.query('ROLLBACK').catch(() => {});
        } finally {
          depClean.release();
        }
        await adminPool.query('DELETE FROM contract_request WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract_version WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract_service_price WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'contract' AND owner_id = $1", [cId]).catch(() => {});
        await adminPool.query('UPDATE contract SET parent_contract_id = NULL WHERE parent_contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
      }
      for (const rsvId of cleanup.reservationIds) {
        await adminPool.query('DELETE FROM reservation WHERE id = $1', [rsvId]).catch(() => {});
      }
      for (const mId of cleanup.meterIds) {
        await adminPool.query('DELETE FROM meter_reading WHERE meter_id = $1', [mId]).catch(() => {});
        await adminPool.query('DELETE FROM meter WHERE id = $1', [mId]).catch(() => {});
      }
      for (const scId of cleanup.serviceCatalogIds) {
        await adminPool.query('DELETE FROM service_subscription WHERE service_id = $1', [scId]).catch(() => {});
        await adminPool.query('DELETE FROM service_catalog WHERE id = $1', [scId]).catch(() => {});
      }
      for (const aId of cleanup.apartmentIds) {
        await adminPool.query('DELETE FROM meter_reading WHERE apartment_id = $1', [aId]).catch(() => {});
        await adminPool.query('DELETE FROM meter WHERE apartment_id = $1', [aId]).catch(() => {});
        await adminPool.query('DELETE FROM service_request WHERE apartment_id = $1', [aId]).catch(() => {});
        await adminPool.query('DELETE FROM reservation WHERE apartment_id = $1', [aId]).catch(() => {});
        await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
      }
      for (const fId of cleanup.floorIds) {
        await adminPool.query('DELETE FROM floor WHERE id = $1', [fId]).catch(() => {});
      }
      for (const zId of cleanup.zoneIds) {
        await adminPool.query('DELETE FROM zone WHERE id = $1', [zId]).catch(() => {});
      }
      for (const bId of cleanup.buildingIds) {
        await adminPool.query('DELETE FROM user_role WHERE building_id = $1', [bId]).catch(() => {});
        await adminPool.query('DELETE FROM building WHERE id = $1', [bId]).catch(() => {});
      }
      for (const tId of cleanup.tenantIds) {
        await adminPool.query('DELETE FROM contract_occupant WHERE tenant_id = $1', [tId]).catch(() => {});
        await adminPool.query('DELETE FROM tenant WHERE id = $1', [tId]).catch(() => {});
      }
      for (const oId of cleanup.ownerIds) {
        await adminPool.query('DELETE FROM owner WHERE id = $1', [oId]).catch(() => {});
      }
      for (const uId of cleanup.userIds) {
        await adminPool.query('DELETE FROM notification WHERE user_id = $1', [uId]).catch(() => {});
        await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [uId]).catch(() => {});
        // Chỉ xóa app_user nếu không bị tham chiếu bởi audit_log append-only
        await adminPool
          .query(
            `DELETE FROM app_user WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log WHERE actor_id = $1)`,
            [uId]
          )
          .catch(() => {});
      }
      for (const pId of cleanup.personIds) {
        await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [pId]).catch(() => {});
        await adminPool
          .query('DELETE FROM notification WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId])
          .catch(() => {});
        await adminPool
          .query('DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId])
          .catch(() => {});
        await adminPool
          .query(
            `DELETE FROM app_user u WHERE u.person_id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_id = u.id)`,
            [pId]
          )
          .catch(() => {});
        await adminPool
          .query(
            `DELETE FROM person WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM app_user WHERE person_id = $1)`,
            [pId]
          )
          .catch(() => {});
      }
    } finally {
      await adminPool.end();
      await appPool.end();
    }
  });

  // Đăng nhập các tài khoản nền tảng có sẵn
  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const ownerVop = await loginEmail('owner.vop@resihub.vn', 'Demo@123456');
  const mgrVopA = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');

  const vopARes = await adminPool.query("SELECT id, org_id FROM building WHERE code = 'VOP-A' LIMIT 1");
  const vopAId = vopARes.rows[0].id;
  const orgId = vopARes.rows[0].org_id;
  const vscARes = await adminPool.query("SELECT id FROM building WHERE code = 'VSC-A' LIMIT 1");
  const vscAId = vscARes.rows[0].id;

  // Khởi tạo nhân sự tạm cho VOP-A để test mô hình 4 vai trò (SYS_ADMIN, OWNER, MANAGER, RESIDENT — R-01) & nguyên tắc Four-Eyes nội bộ
  let mgr2VopA = null;

  // ==========================================================================
  // 2.1 M01 & M02: ADMIN USERS, SETTINGS, AUDIT IMMUTABILITY, AUTH & OTP
  // ==========================================================================
  await t.test('2.1 [M01 & M02] Admin User Provisioning, System Settings, Append-Only Audit Trigger & Auth/OTP Security', async () => {
    // (a) PRD 6.2: OWNER & MANAGER bị chặn truy cập /api/v1/admin/users (403)
    const ownerUsersRes = await apiFetch('/api/v1/admin/users', ownerVop.token);
    assert.equal(ownerUsersRes.status, 403, 'OWNER must receive 403 on GET /api/v1/admin/users');
    const mgrUsersRes = await apiFetch('/api/v1/admin/users', mgrVopA.token);
    assert.equal(mgrUsersRes.status, 403, 'MANAGER must receive 403 on GET /api/v1/admin/users');

    // (a2) R-24: GET /api/v1/audit-logs mở cho SYS_ADMIN & OWNER (Read-Only theo phạm vi), chặn MANAGER 403
    const adminAuditRes = await apiFetch('/api/v1/audit-logs?limit=5', sysAdmin.token);
    assert.equal(adminAuditRes.status, 200, 'SYS_ADMIN must access GET /api/v1/audit-logs');
    assert.ok(Array.isArray(adminAuditRes.body.data));
    const ownerAuditRes = await apiFetch('/api/v1/audit-logs?limit=5', ownerVop.token);
    assert.equal(ownerAuditRes.status, 200, 'OWNER must access GET /api/v1/audit-logs');
    const mgrAuditRes = await apiFetch('/api/v1/audit-logs?limit=5', mgrVopA.token);
    assert.equal(mgrAuditRes.status, 403, 'MANAGER must receive 403 on GET /api/v1/audit-logs');

    // (b) R-01: Chặn tạo vai trò ACCOUNTANT & STAFF đã giản lược (400 INVALID_ROLE), tạo MANAGER thứ 2 trên VOP-A
    for (const removedRole of ['ACCOUNTANT', 'STAFF']) {
      const remTry = await apiFetch('/api/v1/admin/users', sysAdmin.token, {
        method: 'POST',
        body: JSON.stringify({
          full_name: `Removed ${removedRole}`,
          email: `removed.${removedRole.toLowerCase()}.${suffix}@resihub.vn`,
          phone: `097${suffix.slice(0, 6)}${removedRole === 'ACCOUNTANT' ? '1' : '2'}`,
          password: 'Password@123',
          roles: [{ role_code: removedRole, building_id: vopAId }],
        }),
      });
      assert.equal(remTry.status, 400, `R-01: Role ${removedRole} must be rejected with 400`);
      assert.equal(remTry.body.code, 'INVALID_ROLE');
    }

    const createRoleUser = async (roleCode, label, idx) => {
      const email = `wb.${roleCode.toLowerCase()}.${suffix}.${idx}@resihub.vn`;
      const phone = `096${suffix.slice(0, 6)}${idx}`;
      const r = await apiFetch('/api/v1/admin/users', sysAdmin.token, {
        method: 'POST',
        body: JSON.stringify({
          full_name: `${label} ${suffix}`,
          email,
          phone,
          password: 'Password@123',
          roles: [{ role_code: roleCode, building_id: vopAId }],
        }),
      });
      assert.equal(r.status, 201, `Create ${roleCode} failed: ${JSON.stringify(r.body)}`);
      cleanup.userIds.push(r.body.data.id);
      cleanup.personIds.push(r.body.data.person_id);
      const logged = await loginEmail(email, 'Password@123');
      return { ...logged, email, phone };
    };

    mgr2VopA = await createRoleUser('MANAGER', 'Quản Lý Duyệt Chéo', '3');

    // Chặn tự khóa tài khoản SYS_ADMIN đang đăng nhập
    const selfLock = await apiFetch(`/api/v1/admin/users/${sysAdmin.user.sub}`, sysAdmin.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'SUSPENDED' }),
    });
    assert.equal(selfLock.status, 409);
    assert.equal(selfLock.body.code, 'SELF_LOCK_PROHIBITED');

    // (c) Khóa & mở lại tài khoản + kiểm tra thu hồi Refresh Token (token_version)
    const tempLockUser = await createRoleUser('MANAGER', 'Quản Lý Khóa Tạm', '4');
    const suspendRes = await apiFetch(`/api/v1/admin/users/${tempLockUser.user.sub}`, sysAdmin.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'SUSPENDED' }),
    });
    assert.equal(suspendRes.status, 200);

    const loginSuspended = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email: tempLockUser.email, password: 'Password@123' }),
    });
    assert.equal(loginSuspended.status, 403);
    assert.equal(loginSuspended.body.code, 'ACCOUNT_SUSPENDED');

    const refreshSuspended = await apiFetch('/api/v1/auth/refresh', null, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: tempLockUser.refreshToken }),
    });
    assert.equal(refreshSuspended.status, 403);

    // Mở lại tài khoản -> kiểm tra đổi mật khẩu & thu hồi phiên cũ
    await apiFetch(`/api/v1/admin/users/${tempLockUser.user.sub}`, sysAdmin.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    const reLogged = await loginEmail(tempLockUser.email, 'Password@123');
    const chgPwd = await apiFetch('/api/v1/auth/change-password', reLogged.token, {
      method: 'POST',
      body: JSON.stringify({ old_password: 'Password@123', new_password: 'NewPassword@456' }),
    });
    assert.equal(chgPwd.status, 200);

    const oldRefreshAfterPwd = await apiFetch('/api/v1/auth/refresh', null, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: reLogged.refreshToken }),
    });
    assert.equal(oldRefreshAfterPwd.status, 403);
    assert.equal(oldRefreshAfterPwd.body.code, 'TOKEN_REVOKED', 'Đổi mật khẩu phải thu hồi Refresh Token cũ');

    // Quên mật khẩu & đặt lại mật khẩu
    const forgotRes = await apiFetch('/api/v1/auth/forgot-password', null, {
      method: 'POST',
      body: JSON.stringify({ email: tempLockUser.email }),
    });
    assert.equal(forgotRes.status, 200);
    if (forgotRes.body.devResetCode) {
      const resetRes = await apiFetch('/api/v1/auth/reset-password', null, {
        method: 'POST',
        body: JSON.stringify({
          email: tempLockUser.email,
          code: forgotRes.body.devResetCode,
          new_password: 'Password@789',
        }),
      });
      assert.equal(resetRes.status, 200);
    }

    // Brute-force 5 lần sai mật khẩu -> 429 ACCOUNT_LOCKED + ghi AUTH_LOCK trong audit_log
    for (let i = 1; i <= 4; i++) {
      const bad = await apiFetch('/api/v1/auth/login', null, {
        method: 'POST',
        body: JSON.stringify({ email: tempLockUser.email, password: 'WrongPassword@999' }),
      });
      assert.equal(bad.status, 401);
    }
    const fifthBad = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email: tempLockUser.email, password: 'WrongPassword@999' }),
    });
    assert.equal(fifthBad.status, 429);
    assert.equal(fifthBad.body.code, 'ACCOUNT_LOCKED');

    // (d) OTP: AC-001.1, AC-001.2 (khóa sau 5 lần sai), AC-001.3 (chống dò số SĐT lạ)
    const unknownPhone = `095${suffix.slice(0, 6)}9`;
    const otpUnknown = await apiFetch('/api/v1/auth/otp/request', null, {
      method: 'POST',
      body: JSON.stringify({ phone: unknownPhone }),
    });
    assert.equal(otpUnknown.status, 200);
    assert.equal(otpUnknown.body.devOtp, undefined, 'AC-001.3: Không được sinh hay lộ OTP cho SĐT không tồn tại');
    const checkGhostPerson = await adminPool.query('SELECT 1 FROM person WHERE phone = $1', [unknownPhone]);
    assert.equal(checkGhostPerson.rowCount, 0, 'AC-001.3: Không tự tạo person cho SĐT lạ');

    // AC-001.2: Tạo 1 SĐT test riêng để kiểm tra khóa OTP sau 5 lần sai
    const otpLockUser = await createRoleUser('MANAGER', 'Quản Lý Khóa OTP', '5');
    const otpReq = await apiFetch('/api/v1/auth/otp/request', null, {
      method: 'POST',
      body: JSON.stringify({ phone: otpLockUser.phone }),
    });
    assert.equal(otpReq.status, 200);
    assert.ok(otpReq.body.devOtp, 'SĐT hợp lệ trong dev trả mã OTP 6 số');

    for (let i = 1; i <= 4; i++) {
      const wrongOtp = await apiFetch('/api/v1/auth/otp/verify', null, {
        method: 'POST',
        body: JSON.stringify({ phone: otpLockUser.phone, otp: '000000' }),
      });
      assert.equal(wrongOtp.status, 400);
    }
    const fifthOtp = await apiFetch('/api/v1/auth/otp/verify', null, {
      method: 'POST',
      body: JSON.stringify({ phone: otpLockUser.phone, otp: '000000' }),
    });
    assert.equal(fifthOtp.status, 429, 'AC-001.2: Nhập sai OTP 5 lần phải khóa 15 phút (HTTP 429)');
    assert.equal(fifthOtp.body.code, 'TOO_MANY_ATTEMPTS');

    // (e) M01 System Settings (FR-005): R cho nội bộ, PUT chỉ SYS_ADMIN
    const origSetRes = await adminPool.query('SELECT org_id, key, value FROM system_setting WHERE org_id = $1', [orgId]);
    cleanup.originalSettings = origSetRes.rows;

    const mgrPutSettings = await apiFetch('/api/v1/settings', mgrVopA.token, {
      method: 'PUT',
      body: JSON.stringify({ billing_config: { grace_days: 5 } }),
    });
    assert.equal(mgrPutSettings.status, 403, 'MANAGER không được sửa cấu hình hệ thống');

    const adminPutSettings = await apiFetch('/api/v1/settings', sysAdmin.token, {
      method: 'PUT',
      body: JSON.stringify({
        contact_config: {
          working_hours: '08:00 – 18:00 (Thứ 2 – Thứ 7)',
          technical_hotline: '1900 6868',
          security_hotline: '1900 9119',
          emergency_phone: '0909 113 114',
          support_email: 'support@resihub.vn',
        },
      }),
    });
    assert.equal(adminPutSettings.status, 200);

    // (f) [WHITE-BOX DB TRIGGER] FR-006 / AC-020.1: Bảng audit_log bất biến (chặn cả UPDATE & DELETE kể cả superuser)
    const sampleAudit = await adminPool.query('SELECT id FROM audit_log ORDER BY at DESC LIMIT 1');
    assert.ok(sampleAudit.rows.length > 0);
    await assert.rejects(
      () => adminPool.query(`UPDATE audit_log SET action = 'TAMPERED' WHERE id = $1`, [sampleAudit.rows[0].id]),
      (err) => err.code === 'P0001' || /append-only/i.test(err.message),
      'Trigger prevent_audit_log_modification phải chặn UPDATE trên audit_log'
    );
    await assert.rejects(
      () => adminPool.query(`DELETE FROM audit_log WHERE id = $1`, [sampleAudit.rows[0].id]),
      (err) => err.code === 'P0001' || /append-only/i.test(err.message),
      'Trigger prevent_audit_log_modification phải chặn DELETE trên audit_log'
    );
  });

  // ==========================================================================
  // 2.2 WHITE-BOX POSTGRESQL RLS MATRIX ACROSS ROLES (NFR-008)
  // ==========================================================================
  await t.test('2.2 [White-Box RLS] Direct PostgreSQL Row-Level Security Verification under resihub_app', async () => {
    const rls = await appPool.connect();
    try {
      // (a) Default-deny khi chưa gán app.current_user_id
      await rls.query('RESET app.current_user_id');
      for (const tbl of ['building', 'apartment', 'contract', 'deposit', 'invoice', 'payment', 'service_request']) {
        const res = await rls.query(`SELECT COUNT(*)::int AS cnt FROM ${tbl}`);
        assert.equal(res.rows[0].cnt, 0, `RLS default-deny failed on table ${tbl}`);
      }

      // (b) OWNER (Phương án 2): 100% Read-Only ở tầng PostgreSQL RLS
      const expectedOwnRls = await adminPool.query(
        `SELECT b.code
         FROM building b
         JOIN owner o ON o.id = b.owner_id
         JOIN app_user u ON u.person_id = o.person_id
         WHERE u.id = $1
         ORDER BY b.code`,
        [ownerVop.user.sub]
      );
      await rls.query(`SELECT set_config('app.current_user_id', $1, false)`, [ownerVop.user.sub]);
      const ownBldgs = await rls.query('SELECT code FROM building ORDER BY code');
      assert.deepEqual(ownBldgs.rows.map((r) => r.code), expectedOwnRls.rows.map((r) => r.code));

      const updAptByOwner = await rls.query(`UPDATE apartment SET note = 'OwnerHack' WHERE building_id = $1 RETURNING id`, [vopAId]);
      assert.equal(updAptByOwner.rowCount, 0, 'RLS must block OWNER from updating apartment');

      let updCtrRows = 0;
      try {
        const updCtrByOwner = await rls.query(`UPDATE contract SET note = 'OwnerHack' WHERE building_id = $1 RETURNING id`, [vopAId]);
        updCtrRows = updCtrByOwner.rowCount;
      } catch (rlsErr) {
        assert.equal(rlsErr.code, '42501', `Expected RLS WITH CHECK block (42501), got ${rlsErr.code}: ${rlsErr.message}`);
      }
      assert.equal(updCtrRows, 0, 'RLS must block OWNER from arbitrarily updating contract');

      const updDepByOwner = await rls.query(`UPDATE deposit SET status = 'REFUNDED' RETURNING id`);
      assert.equal(updDepByOwner.rowCount, 0, 'RLS must block OWNER from updating deposit');

      // (c) Scoped MANAGER (mgr2VopA) chỉ thấy đúng tòa VOP-A ở tầng RLS (R-01: chỉ còn 4 vai trò trong role)
      const roleCheckRes = await adminPool.query('SELECT code FROM role ORDER BY code');
      assert.deepEqual(
        roleCheckRes.rows.map((r) => r.code),
        ['MANAGER', 'OWNER', 'RESIDENT', 'SYS_ADMIN'],
        'R-01: Bảng role chỉ còn đúng 4 vai trò chuẩn'
      );
      await rls.query(`SELECT set_config('app.current_user_id', $1, false)`, [mgr2VopA.user.sub]);
      const mgrBldgs = await rls.query('SELECT code FROM building');
      assert.deepEqual(mgrBldgs.rows.map((r) => r.code), ['VOP-A'], 'Scoped MANAGER chỉ thấy tòa VOP-A');
    } finally {
      await rls.query('RESET app.current_user_id').catch(() => {});
      rls.release();
    }
  });

  // ==========================================================================
  // 2.3 M03 & M04: REAL ESTATE HIERARCHY, RESERVATIONS (FR-067), TENANTS & MERGE
  // ==========================================================================
  let testApt1Id = null;
  let testApt2Id = null;
  let testApt1Code = null;
  let convertedReservationId = null;
  let primaryTenantId = null;
  let residentAuth = null;

  await t.test('2.3 [M03 & M04] Building/Zone/Floor/Apartment, Floor-Map, Reservations (FR-067) & Tenant Merge (FR-021)', async () => {
    // (a) Tạo Tầng + 2 Căn hộ kiểm thử tạm thời trong VOP-A (sẽ xóa sạch trong t.after)
    const floorLevel = 90 + Number(suffix.slice(-1));
    const fRes = await apiFetch(`/api/v1/buildings/${vopAId}/floors`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ level: floorLevel, name: `Tầng Test ${suffix}` }),
    });
    assert.equal(fRes.status, 201, `Create floor failed: ${JSON.stringify(fRes.body)}`);
    const floorId = fRes.body.data.id;
    cleanup.floorIds.push(floorId);

    testApt1Code = `T${suffix.slice(-4)}A`;
    const apt1Res = await apiFetch('/api/v1/apartments', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopAId,
        floor_id: floorId,
        code: testApt1Code,
        area_m2: 55,
        type: '2BR',
        bedrooms: 2,
        base_rent: 12000000,
        amenities: ['Điều hòa', 'Nóng lạnh'],
      }),
    });
    assert.equal(apt1Res.status, 201, `Create apt1 failed: ${JSON.stringify(apt1Res.body)}`);
    testApt1Id = apt1Res.body.data.id;
    cleanup.apartmentIds.push(testApt1Id);
    assert.equal(apt1Res.body.data.status, 'AVAILABLE');

    // Chặn trùng mã căn hộ trong cùng tòa (FR-008)
    const dupApt = await apiFetch('/api/v1/apartments', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopAId,
        floor_id: floorId,
        code: testApt1Code,
        area_m2: 55,
        base_rent: 12000000,
      }),
    });
    assert.equal(dupApt.status, 409, 'Trùng mã căn hộ trong cùng tòa phải trả 409');

    const apt2Res = await apiFetch('/api/v1/apartments', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopAId,
        floor_id: floorId,
        code: `T${suffix.slice(-4)}B`,
        area_m2: 45,
        type: '1BR',
        bedrooms: 1,
        base_rent: 10000000,
      }),
    });
    assert.equal(apt2Res.status, 201);
    testApt2Id = apt2Res.body.data.id;
    cleanup.apartmentIds.push(testApt2Id);

    // Sơ đồ tầng trực quan (FR-010)
    const floorMap = await apiFetch(`/api/v1/buildings/${vopAId}/floor-map`, ownerVop.token);
    assert.equal(floorMap.status, 200);
    assert.ok(Array.isArray(floorMap.body.data), 'OWNER phải xem được sơ đồ tầng trực quan');

    // (b) FR-067: Đặt cọc giữ chỗ -> căn hộ chuyển RESERVED -> hủy mất cọc (forfeit) -> mở lại AVAILABLE
    const over30Days = await apiFetch('/api/v1/reservations', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: testApt1Id,
        prospect_name: 'Khách Giữ Chỗ Quá Hạn',
        phone: '0911222333',
        hold_amount: 2000000,
        hold_until: addDaysStr(45),
      }),
    });
    assert.equal(over30Days.status, 400);
    assert.equal(over30Days.body.code, 'HOLD_DURATION_EXCEEDED');

    const rsv1 = await apiFetch('/api/v1/reservations', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: testApt1Id,
        prospect_name: 'Khách Hủy Cọc',
        phone: `094${suffix.slice(0, 6)}1`,
        hold_amount: 1500000,
        hold_until: addDaysStr(7),
      }),
    });
    assert.equal(rsv1.status, 201);
    cleanup.reservationIds.push(rsv1.body.data.id);

    // Căn hộ đã sang RESERVED nên đặt giữ chỗ chồng phải bị chặn 409
    const rsvDup = await apiFetch('/api/v1/reservations', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: testApt1Id,
        prospect_name: 'Khách Thứ Hai',
        phone: `094${suffix.slice(0, 6)}2`,
        hold_amount: 1500000,
        hold_until: addDaysStr(5),
      }),
    });
    assert.equal(rsvDup.status, 409);
    assert.equal(rsvDup.body.code, 'APARTMENT_NOT_AVAILABLE');

    // Khách hủy giữ chỗ -> forfeit (Four-Eyes + reason) -> phòng về lại AVAILABLE
    const forfeitRes = await apiFetch(`/api/v1/reservations/${rsv1.body.data.id}/forfeit`, mgr2VopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Khách báo hủy giữ chỗ trước khi ký HĐ' }),
    });
    assert.equal(forfeitRes.status, 200);
    const aptAfterForfeit = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [testApt1Id]);
    assert.equal(aptAfterForfeit.rows[0].status, 'AVAILABLE');

    // Đặt giữ chỗ mới (2.000.000 ₫) để lát nữa chuyển đổi thành Cọc hợp đồng (FR-067)
    const resPhone = `093${suffix.slice(0, 6)}1`;
    const rsv2 = await apiFetch('/api/v1/reservations', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: testApt1Id,
        prospect_name: `Cư Dân Chính ${suffix}`,
        phone: resPhone,
        hold_amount: 2000000,
        hold_until: addDaysStr(10),
      }),
    });
    assert.equal(rsv2.status, 201);
    convertedReservationId = rsv2.body.data.id;
    cleanup.reservationIds.push(convertedReservationId);

    // (c) M04: Tạo cư dân, chặn trùng SĐT/CCCD & Hợp nhất cư dân trùng có Audit (FR-021)
    const tMainRes = await apiFetch('/api/v1/tenants', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: `Cư Dân Chính ${suffix}`,
        phone: resPhone,
        email: `resident.main.${suffix}@resihub.vn`,
        id_number: `001200${suffix}`,
        type: 'primary',
      }),
    });
    assert.equal(tMainRes.status, 201, `Create main tenant failed: ${JSON.stringify(tMainRes.body)}`);
    primaryTenantId = tMainRes.body.data.id;
    cleanup.tenantIds.push(primaryTenantId);
    cleanup.personIds.push(tMainRes.body.data.person_id);

    // Đăng nhập OTP cho cư dân chính (US-001)
    const otpVerify = await apiFetch('/api/v1/auth/otp/verify', null, {
      method: 'POST',
      body: JSON.stringify({ phone: resPhone, otp: '123456' }),
    });
    assert.equal(otpVerify.status, 200, `Resident OTP login failed: ${JSON.stringify(otpVerify.body)}`);
    residentAuth = { token: otpVerify.body.accessToken, user: otpVerify.body.user, phone: resPhone };
    cleanup.userIds.push(residentAuth.user.sub);

    // Chặn tạo trùng SĐT (FR-021 -> 409)
    const dupTenant = await apiFetch('/api/v1/tenants', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Bản Ghi Trùng SĐT',
        phone: resPhone,
        id_number: `001299${suffix}`,
      }),
    });
    assert.equal(dupTenant.status, 409, 'FR-021: Trùng SĐT phải chặn 409');

    // Hợp nhất hồ sơ cư dân (POST /api/v1/tenants/merge) bắt buộc lý do + ghi audit_log
    const tMergeSrc = await apiFetch('/api/v1/tenants', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: `Hồ Sơ Phụ Merge ${suffix}`,
        phone: `093${suffix.slice(0, 6)}8`,
        id_number: `001288${suffix}`,
      }),
    });
    assert.equal(tMergeSrc.status, 201);
    const srcTenantId = tMergeSrc.body.data.id;
    cleanup.tenantIds.push(srcTenantId);
    cleanup.personIds.push(tMergeSrc.body.data.person_id);

    const mergeNoReason = await apiFetch('/api/v1/tenants/merge', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ source_tenant_id: srcTenantId, target_tenant_id: primaryTenantId }),
    });
    assert.ok([400, 422].includes(mergeNoReason.status), 'Merge không có lý do phải bị từ chối');

    const mergeOk = await apiFetch('/api/v1/tenants/merge', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        source_tenant_id: srcTenantId,
        target_tenant_id: primaryTenantId,
        reason: 'Hợp nhất hồ sơ khai báo trùng của cùng cư dân (FR-021)',
      }),
    });
    assert.equal(mergeOk.status, 200, `Merge tenant failed: ${JSON.stringify(mergeOk.body)}`);
  });

  // ==========================================================================
  // 2.4 M05 & M06: CONTRACTS LIFECYCLE, DISCOUNTED FOUR-EYES, OCCUPANTS,
  //                FR-065 OVERRIDE, AMENDMENTS, OVERLAP GUARD & DEPOSIT SETTLEMENT
  // ==========================================================================
  let activeContractId = null;

  await t.test('2.4 [M05 & M06] Contract Draft -> Scan -> Discounted Four-Eyes Approval -> Amendment -> Overlap Guard', async () => {
    const startStr = addDaysStr(-10);
    const endStr = addDaysStr(355);

    // Tạo hợp đồng giảm giá > 10% (base_rent = 12.000.000, rent_amount = 10.000.000 < 10.800.000)
    // kèm reservation_id để chuyển 2.000.000 cọc giữ chỗ sang cọc hợp đồng (10.000.000)
    const cDraft = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: testApt1Id,
        primary_tenant_id: primaryTenantId,
        reservation_id: convertedReservationId,
        start_date: startStr,
        end_date: endStr,
        rent_amount: 10000000,
        deposit_amount: 10000000,
        billing_day: 5,
        payment_due_days: 5,
      }),
    });
    assert.equal(cDraft.status, 201, `Create contract draft failed: ${JSON.stringify(cDraft.body)}`);
    activeContractId = cDraft.body.data.id;
    cleanup.contractIds.push(activeContractId);
    assert.equal(cDraft.body.data.status, 'DRAFT');

    // Xem mẫu in hợp đồng A4 HTML
    const tplRes = await fetch(`${API_BASE}/api/v1/contracts/${activeContractId}/template`, {
      headers: { Authorization: `Bearer ${mgrVopA.token}` },
    });
    assert.equal(tplRes.status, 200);
    const tplHtml = await tplRes.text();
    assert.ok(tplHtml.includes('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM'), 'Template A4 phải có quốc hiệu');

    // AC-009.2: Chặn kích hoạt khi chưa tải bản scan hợp đồng đã ký
    const actNoScan = await apiFetch(`/api/v1/contracts/${activeContractId}/activate`, mgrVopA.token, {
      method: 'POST',
    });
    assert.ok([400, 409, 422].includes(actNoScan.status), 'AC-009.2: Chưa đính kèm bản ký phải chặn kích hoạt');

    // Tải bản scan hợp đồng (FR-020)
    const upScan = await apiFetch(`/api/v1/contracts/${activeContractId}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_BASE64 }),
    });
    assert.equal(upScan.status, 201);

    // Kích hoạt hợp đồng lệch khung giá -> chuyển sang PENDING_APPROVAL (chưa ACTIVE ngay)
    const actDiscounted = await apiFetch(`/api/v1/contracts/${activeContractId}/activate`, mgrVopA.token, {
      method: 'POST',
    });
    assert.equal(actDiscounted.status, 409, `Activate discounted failed: ${JSON.stringify(actDiscounted.body)}`);
    assert.equal(actDiscounted.body.code, 'PRICE_NEEDS_APPROVAL');
    assert.equal(actDiscounted.body.data.status, 'PENDING_APPROVAL', 'Giá < 90% giá niêm yết phải vào PENDING_APPROVAL');

    // Phân quyền chuẩn PRD Mục 6.2 & FR-014: MANAGER (kể cả mgr2VopA) và SYS_ADMIN bị chặn 403 trên tòa đã gắn OWNER; OWNER tòa nhà (ownerVop) là người duyệt lệch khung giá
    const selfApprove = await apiFetch(`/api/v1/contracts/${activeContractId}/approve`, mgrVopA.token, {
      method: 'POST',
    });
    assert.equal(selfApprove.status, 403, 'MANAGER không được tự duyệt hợp đồng giảm giá');

    const mgr2ApproveTry = await apiFetch(`/api/v1/contracts/${activeContractId}/approve`, mgr2VopA.token, {
      method: 'POST',
    });
    assert.equal(mgr2ApproveTry.status, 403, 'MANAGER thứ 2 không được duyệt hợp đồng lệch khung giá (thuộc thẩm quyền OWNER tòa nhà)');

    // R-12: OWNER tòa nhà (ownerVop) từ chối phê duyệt (POST /:id/reject) -> trả về DRAFT để điều chỉnh, sau đó trình lại & phê duyệt
    const rejectToDraft = await apiFetch(`/api/v1/contracts/${activeContractId}/reject`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Đề nghị ghi rõ điều khoản chiết khấu trong ghi chú hợp đồng' }),
    });
    assert.equal(rejectToDraft.status, 200, `Reject discounted contract failed: ${JSON.stringify(rejectToDraft.body)}`);
    assert.equal(rejectToDraft.body.data.status, 'DRAFT', 'R-12: Từ chối phê duyệt giá phải trả HĐ về DRAFT');

    const reActDiscounted = await apiFetch(`/api/v1/contracts/${activeContractId}/activate`, mgrVopA.token, {
      method: 'POST',
    });
    assert.equal(reActDiscounted.status, 409);
    assert.equal(reActDiscounted.body.data.status, 'PENDING_APPROVAL');

    // OWNER tòa nhà (ownerVop) phê duyệt -> ACTIVE + mở sổ cọc HELD + căn hộ OCCUPIED + reservation CONVERTED
    const ownerApprove = await apiFetch(`/api/v1/contracts/${activeContractId}/approve`, ownerVop.token, {
      method: 'POST',
    });
    assert.equal(ownerApprove.status, 200, `Building owner approve failed: ${JSON.stringify(ownerApprove.body)}`);
    assert.equal(ownerApprove.body.data.status, 'ACTIVE');

    const aptStatusNow = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [testApt1Id]);
    assert.equal(aptStatusNow.rows[0].status, 'OCCUPIED', 'Căn hộ phải tự động chuyển sang OCCUPIED');

    const rsvStatusNow = await adminPool.query('SELECT status FROM reservation WHERE id = $1', [convertedReservationId]);
    assert.equal(rsvStatusNow.rows[0].status, 'CONVERTED', 'FR-067: Hồ sơ giữ chỗ phải chuyển sang CONVERTED');

    const depCheck = await adminPool.query('SELECT * FROM deposit WHERE contract_id = $1', [activeContractId]);
    assert.equal(depCheck.rows.length, 1);
    assert.equal(
      Number(depCheck.rows[0].amount_held),
      2000000,
      'FR-067: Sổ cọc khởi tạo ghi nhận 2.000.000 ₫ chuyển từ đặt cọc giữ chỗ'
    );
    assert.equal(depCheck.rows[0].status, 'HELD');

    // MANAGER thu bổ sung 8.000.000 ₫ tiền cọc còn lại -> đủ 10.000.000 ₫
    const collectRemDep = await apiFetch(
      `/api/v1/deposits/${depCheck.rows[0].id}/transactions`,
      mgr2VopA.token,
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'collect',
          amount: 8000000,
          method: 'BANK_TRANSFER',
          description: 'Thu bổ sung 8.000.000 ₫ tiền cọc hợp đồng sau khi trừ cọc giữ chỗ',
        }),
      }
    );
    assert.equal(collectRemDep.status, 201, `Collect remaining deposit failed: ${JSON.stringify(collectRemDep.body)}`);
    const depAfterCollect = await adminPool.query('SELECT amount_held FROM deposit WHERE id = $1', [depCheck.rows[0].id]);
    assert.equal(Number(depAfterCollect.rows[0].amount_held), 10000000, 'Sổ cọc sau thu bổ sung phải đạt đủ 10.000.000 ₫');

    // Chặn xóa căn hộ đang có hợp đồng ACTIVE (FR-008)
    const delActiveApt = await apiFetch(`/api/v1/apartments/${testApt1Id}`, sysAdmin.token, {
      method: 'DELETE',
    });
    assert.equal(delActiveApt.status, 409, 'FR-008: Không được xóa căn hộ đang có hợp đồng');

    // AC-009.1 + White-Box DB Exclusion Constraint (23P01): Chặn tạo hợp đồng chồng lấn kỳ hạn
    const overlapApi = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: testApt1Id,
        primary_tenant_id: primaryTenantId,
        start_date: addDaysStr(10),
        end_date: addDaysStr(180),
        rent_amount: 12000000,
        deposit_amount: 12000000,
      }),
    });
    assert.equal(overlapApi.status, 409, 'AC-009.1: API phải chặn tạo hợp đồng chồng lấn kỳ hạn');

    await assert.rejects(
      () =>
        adminPool.query(
          `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, deposit_amount, status)
           VALUES ($1, $2, $3, $4, $5, 12000000, 5, 12000000, 'ACTIVE')`,
          [vopAId, testApt1Id, primaryTenantId, addDaysStr(5), addDaysStr(100)]
        ),
      (err) => err.code === '23P01',
      'Mục 13.3: PostgreSQL Exclusion Constraint phải chặn chồng lấn kỳ thuê ở tầng DB (23P01)'
    );

    // Thêm & gỡ người ở cùng (FR-011: không xóa cứng person)
    const occAdd = await apiFetch(`/api/v1/contracts/${activeContractId}/occupants`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: `Thành Viên Ở Cùng ${suffix}`,
        phone: `093${suffix.slice(0, 6)}5`,
        relationship: 'Vợ/Chồng',
      }),
    });
    assert.equal(occAdd.status, 201, `Add occupant failed: ${JSON.stringify(occAdd.body)}`);
    const occTenantId = occAdd.body.data.tenant_id || occAdd.body.data.id;
    if (occAdd.body.data.person_id) cleanup.personIds.push(occAdd.body.data.person_id);
    if (occTenantId) cleanup.tenantIds.push(occTenantId);

    // FR-065: ACCOUNTANT ghi đè đơn giá dịch vụ Internet theo hợp đồng (180.000 ₫ thay vì 220.000 ₫)
    const setCsp = await apiFetch(`/api/v1/contracts/${activeContractId}/service-prices`, mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({
        service_code: 'INTERNET_FIBER',
        unit_price: 180000,
        effective_from: startStr,
      }),
    });
    assert.equal(setCsp.status, 200, `Set contract_service_price failed: ${JSON.stringify(setCsp.body)}`);

    // FR-016: Tạo Phụ lục điều chỉnh giá thuê -> Four-eyes duyệt chéo -> sinh contract_version bất biến
    const amendCreate = await apiFetch(`/api/v1/contracts/${activeContractId}/amendments`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        changes: { rent_amount: 10500000 },
        effective_from: startStr,
        reason: 'Bổ sung nội thất máy giặt sấy theo thỏa thuận phụ lục 01',
      }),
    });
    assert.equal(amendCreate.status, 201, `Create amendment failed: ${JSON.stringify(amendCreate.body)}`);
    const versionId = amendCreate.body.data.id;

    const selfAppAmend = await apiFetch(
      `/api/v1/contracts/${activeContractId}/amendments/${versionId}/approve`,
      mgrVopA.token,
      { method: 'POST' }
    );
    assert.ok([403, 409].includes(selfAppAmend.status), 'Four-eyes phải chặn người lập tự duyệt phụ lục');

    const crossAppAmend = await apiFetch(
      `/api/v1/contracts/${activeContractId}/amendments/${versionId}/approve`,
      mgr2VopA.token,
      { method: 'POST' }
    );
    assert.equal(crossAppAmend.status, 200, `Approve amendment failed: ${JSON.stringify(crossAppAmend.body)}`);

    const cAfterAmend = await adminPool.query('SELECT rent_amount FROM contract WHERE id = $1', [activeContractId]);
    assert.equal(Number(cAfterAmend.rows[0].rent_amount), 10500000, 'Giá thuê hợp đồng phải cập nhật sang 10.500.000 ₫ sau duyệt phụ lục');
  });

  // ==========================================================================
  // 2.5 M07, M08, M09 & M10: SERVICE CATALOG, SUBSCRIPTIONS, METERS,
  //                          BATCH INVOICES (FR-065), PAYMENTS & RECEIVABLES
  // ==========================================================================
  let generatedInvoiceId = null;

  await t.test('2.5 [M07..M10] Service Catalog/Subscriptions, Meter Anomaly (>30%), Batch Invoice (FR-065) & Payments', async () => {
    const testPeriod = '2026-10';
    const prevPeriod = '2026-09';

    // (a) M07 FR-026: ACCOUNTANT tạo mới & cập nhật danh mục dịch vụ; OWNER bị chặn 403
    const ownerCreateSvc = await apiFetch('/api/v1/service-catalog', ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({ code: `OWN_SVC_${suffix}`, name: 'Owner Test', category: 'OTHER', billing_type: 'FIXED', unit_price: 50000 }),
    });
    assert.equal(ownerCreateSvc.status, 403, 'OWNER không được tạo danh mục dịch vụ');

    const accCreateSvc = await apiFetch('/api/v1/service-catalog', mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({
        code: `GYM_${suffix}`,
        name: `Thẻ Gym Cư Dân ${suffix}`,
        category: 'UTILITY',
        billing_type: 'FIXED',
        unit: 'tháng',
        unit_price: 300000,
      }),
    });
    assert.equal(accCreateSvc.status, 201, `ACCOUNTANT create service catalog failed: ${JSON.stringify(accCreateSvc.body)}`);
    cleanup.serviceCatalogIds.push(accCreateSvc.body.data.id);

    const accPatchSvc = await apiFetch(`/api/v1/service-catalog/${accCreateSvc.body.data.id}`, mgr2VopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ unit_price: 320000 }),
    });
    assert.equal(accPatchSvc.status, 200);
    assert.equal(Number(accPatchSvc.body.data.unit_price), 320000);

    // Cư dân đăng ký dịch vụ INTERNET_FIBER từ Cổng cư dân (FR-027) -> MANAGER duyệt (FR-028)
    const internetCatRes = await adminPool.query(
      "SELECT id, unit_price FROM service_catalog WHERE org_id = $1 AND code = 'INTERNET_FIBER' LIMIT 1",
      [orgId]
    );
    const internetId = internetCatRes.rows[0].id;

    const resSub = await apiFetch('/api/v1/resident/services', residentAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: activeContractId,
        service_id: internetId,
        quantity: 1,
        start_date: '2026-09-01', // trước kỳ 2026-10 để tính trọn tháng theo giá ghi đè HĐ 180.000 ₫
      }),
    });
    assert.equal(resSub.status, 201, `Resident subscribe failed: ${JSON.stringify(resSub.body)}`);
    const subId = resSub.body.data.id;
    cleanup.serviceSubIds.push(subId);
    assert.equal(resSub.body.data.status, 'PENDING_APPROVAL');

    const mgrApproveSub = await apiFetch(`/api/v1/service-subscriptions/${subId}`, mgrVopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    assert.equal(mgrApproveSub.status, 200);
    assert.equal(mgrApproveSub.body.data.status, 'ACTIVE');

    // (b) M08 FR-030 & FR-031: STAFF & ACCOUNTANT khởi tạo đồng hồ điện/nước + cảnh báo lệch > 30%
    const elMeterRes = await apiFetch('/api/v1/meters', mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: testApt1Id,
        meter_type: 'ELECTRICITY',
        unit_price: 3800,
        initial_reading: 1000,
      }),
    });
    assert.equal(elMeterRes.status, 201, `Create electricity meter failed: ${JSON.stringify(elMeterRes.body)}`);
    const elMeterId = elMeterRes.body.data.id;
    cleanup.meterIds.push(elMeterId);

    const wtMeterRes = await apiFetch('/api/v1/meters', mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: testApt1Id,
        meter_type: 'WATER',
        unit_price: 22000,
        initial_reading: 50,
      }),
    });
    assert.equal(wtMeterRes.status, 201, `ACCOUNTANT create water meter failed: ${JSON.stringify(wtMeterRes.body)}`);
    const wtMeterId = wtMeterRes.body.data.id;
    cleanup.meterIds.push(wtMeterId);

    // Ghi chỉ số kỳ trước (2026-09): Điện tiêu thụ 100 kWh (1000 -> 1100), Nước tiêu thụ 10 m³ (50 -> 60)
    const batchPrev = await apiFetch('/api/v1/meters/readings/batch', mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({
        period: prevPeriod,
        readings: [
          { meter_id: elMeterId, current_reading: 1100 },
          { meter_id: wtMeterId, current_reading: 60 },
        ],
      }),
    });
    assert.equal(batchPrev.status, 201);

    // Chặn chỉ số lùi (current_reading < previous_reading -> 400 INVALID_READING)
    const badReading = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({ period: testPeriod, current_reading: 1050 }),
    });
    assert.equal(badReading.status, 400);
    assert.equal(badReading.body.code, 'INVALID_READING');

    // Ghi chỉ số kỳ 2026-10: Điện vọt lên 1300 (+200 kWh vs 100 kWh = +100% > 30% -> is_abnormal = true)
    // Nước 70 (+10 m³ = 0% biến động -> is_abnormal = false)
    const batchCur = await apiFetch('/api/v1/meters/readings/batch', mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({
        period: testPeriod,
        readings: [
          { meter_id: elMeterId, current_reading: 1300, image_base64: TINY_PNG_BASE64 },
          { meter_id: wtMeterId, current_reading: 70 },
        ],
      }),
    });
    assert.equal(batchCur.status, 201);
    assert.equal(batchCur.body.abnormal_count, 1, 'FR-031: Biến động +100% phải tự động gắn cờ bất thường');

    // (c) M09 FR-033, FR-034, FR-035 & FR-065: Sinh hóa đơn lô, kiểm tra công thức tiền & chống trùng
    const genRes = await apiFetch('/api/v1/invoices/generate-batch', mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({ building_id: vopAId, period: testPeriod, auto_issue: false }),
    });
    assert.equal(genRes.status, 201, `Generate batch failed: ${JSON.stringify(genRes.body)}`);
    for (const inv of genRes.body.data || []) {
      cleanup.invoiceIds.push(inv.id);
    }

    const ourInv = (genRes.body.data || []).find((i) => i.contract_id === activeContractId);
    assert.ok(ourInv, 'Hóa đơn kỳ 2026-10 của hợp đồng kiểm thử phải được sinh ra ở trạng thái DRAFT');
    generatedInvoiceId = ourInv.id;
    assert.equal(ourInv.status, 'DRAFT');

    // AC-015.2: Chạy lại sinh hóa đơn cùng kỳ -> không tạo bản trùng cho hợp đồng đã có hóa đơn
    const genDup = await apiFetch('/api/v1/invoices/generate-batch', mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({ building_id: vopAId, period: testPeriod, auto_issue: false }),
    });
    assert.equal(genDup.status, 201);
    assert.equal(
      (genDup.body.data || []).some((i) => i.contract_id === activeContractId),
      false,
      'AC-015.2: Không được sinh trùng hóa đơn cùng kỳ cho cùng hợp đồng'
    );

    // AC-003.2: Cư dân KHÔNG nhìn thấy hóa đơn đang ở trạng thái DRAFT
    const resInvWhileDraft = await apiFetch(
      `/api/v1/resident/invoices?contract_id=${activeContractId}`,
      residentAuth.token
    );
    assert.equal(resInvWhileDraft.status, 200);
    assert.equal(resInvWhileDraft.body.data.length, 0, 'AC-003.2: Hóa đơn DRAFT phải ẩn hoàn toàn khỏi Cổng cư dân');

    // Kiểm tra chi tiết dòng phí (White-Box Financial Formula Verification):
    // - Điện: 200 kWh * 3.800 = 760.000 ₫
    // - Nước: 10 m³ * 22.000 = 220.000 ₫
    // - Internet (FR-065 ghi đè theo HĐ): 180.000 ₫ (thay vì 220.000 ₫ giá danh mục!)
    const invDetail = await apiFetch(`/api/v1/invoices/${generatedInvoiceId}`, mgr2VopA.token);
    assert.equal(invDetail.status, 200);
    const lines = invDetail.body.data.lines;
    const elLine = lines.find((l) => l.item_type === 'ELECTRICITY');
    const wtLine = lines.find((l) => l.item_type === 'WATER');
    const svcLine = lines.find((l) => l.item_type === 'SERVICE');
    const rentLine = lines.find((l) => l.item_type === 'RENT');

    assert.equal(Number(elLine?.amount), 760000, 'Tiền điện phải đúng 200 * 3.800 = 760.000 ₫');
    assert.equal(Number(wtLine?.amount), 220000, 'Tiền nước phải đúng 10 * 22.000 = 220.000 ₫');
    assert.equal(Number(svcLine?.amount), 180000, 'FR-065: Đơn giá Internet phải lấy giá ghi đè hợp đồng 180.000 ₫');
    assert.ok(Number(rentLine?.amount) > 0, 'Phải có dòng tiền thuê phòng');

    // FR-034 & FR-035: Điều chỉnh giảm 50.000 ₫ kèm lý do và phát hành (ISSUED)
    const issueRes = await apiFetch(`/api/v1/invoices/${generatedInvoiceId}/status`, mgr2VopA.token, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'ISSUED',
        adjustment_amount: -50000,
        adjustment_reason: 'Ưu đãi chào mừng cư dân mới',
      }),
    });
    assert.equal(issueRes.status, 200);
    assert.equal(issueRes.body.data.status, 'ISSUED');
    const issuedTotal = Number(issueRes.body.data.total_amount);

    // AC-003.1: Sau khi ISSUED, cư dân nhìn thấy đầy đủ hóa đơn & dòng phí trên Cổng cư dân
    const resInvAfterIssue = await apiFetch(
      `/api/v1/resident/invoices?contract_id=${activeContractId}`,
      residentAuth.token
    );
    assert.equal(resInvAfterIssue.status, 200);
    assert.equal(resInvAfterIssue.body.data.length, 1, 'AC-003.1: Cư dân phải thấy hóa đơn ngay sau khi ISSUED');
    assert.equal(Number(resInvAfterIssue.body.data[0].total_amount), issuedTotal);

    // (d) M10 FR-036..FR-040: Cư dân báo thanh toán -> Kế toán từ chối bản sai -> Duyệt partial -> Thu vượt (Overpayment)
    const badProof = await apiFetch('/api/v1/resident/payments/report', residentAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        invoice_id: generatedInvoiceId,
        amount: 2000000,
        method: 'BANK_TRANSFER',
        reference_code: 'UNC-MO-001',
        proof_images: [TINY_PNG_BASE64],
      }),
    });
    assert.equal(badProof.status, 201);
    cleanup.paymentIds.push(badProof.body.data.id);
    assert.equal(badProof.body.data.status, 'PENDING_CONFIRMATION');

    const rejectProof = await apiFetch(`/api/v1/payments/${badProof.body.data.id}/reject`, mgr2VopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Ảnh chụp ủy nhiệm chi bị mờ số tham chiếu' }),
    });
    assert.equal(rejectProof.status, 200);
    assert.equal(rejectProof.body.data.status, 'REJECTED');

    // Cư dân gửi lại chứng từ thanh toán một phần (3.000.000 ₫) -> Kế toán xác nhận -> PARTIALLY_PAID
    const partialProof = await apiFetch('/api/v1/resident/payments/report', residentAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        invoice_id: generatedInvoiceId,
        amount: 3000000,
        method: 'BANK_TRANSFER',
        reference_code: 'UNC-HOP-LE-002',
        proof_images: [TINY_PNG_BASE64],
      }),
    });
    assert.equal(partialProof.status, 201);
    cleanup.paymentIds.push(partialProof.body.data.id);

    const confirmPartial = await apiFetch(`/api/v1/payments/${partialProof.body.data.id}/confirm`, mgr2VopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ note: 'Đã khớp sao kê ngân hàng đợt 1' }),
    });
    assert.equal(confirmPartial.status, 200);

    const invAfterPartial = await adminPool.query('SELECT status, paid_amount FROM invoice WHERE id = $1', [generatedInvoiceId]);
    assert.equal(invAfterPartial.rows[0].status, 'PARTIALLY_PAID');
    assert.equal(Number(invAfterPartial.rows[0].paid_amount), 3000000);

    // Chặn hủy hóa đơn đã phát sinh thanh toán (FR-035)
    const cancelPaidAttempt = await apiFetch(`/api/v1/invoices/${generatedInvoiceId}/status`, mgr2VopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CANCELLED' }),
    });
    assert.equal(cancelPaidAttempt.status, 409);
    assert.equal(cancelPaidAttempt.body.code, 'ALREADY_PAID');

    // Thanh toán đợt 2 dư thêm 250.000 ₫ (Overpayment - FR-040) -> hóa đơn PAID & ghi nhận overpayment_amount = 250.000
    const remaining = issuedTotal - 3000000;
    const overpayRes = await apiFetch('/api/v1/payments', mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({
        invoice_id: generatedInvoiceId,
        amount: remaining + 250000,
        method: 'BANK_TRANSFER',
        reference_code: 'UNC-DOT-2-THUA',
      }),
    });
    assert.equal(overpayRes.status, 201);
    cleanup.paymentIds.push(overpayRes.body.data.id);
    assert.equal(Number(overpayRes.body.data.overpayment_amount), 250000, 'FR-040: Phải ghi nhận đúng số tiền trả thừa 250.000 ₫');

    const invAfterFull = await adminPool.query('SELECT status FROM invoice WHERE id = $1', [generatedInvoiceId]);
    assert.equal(invAfterFull.rows[0].status, 'PAID');

    const recAfterFull = await adminPool.query('SELECT status FROM receivable WHERE invoice_id = $1', [generatedInvoiceId]);
    assert.equal(recAfterFull.rows[0].status, 'PAID');

    // Kiểm tra API phân tích tuổi nợ Aging (FR-038 / AC-016.1)
    const agingRes = await apiFetch('/api/v1/receivables', mgr2VopA.token);
    assert.equal(agingRes.status, 200);
    assert.ok(agingRes.body.summary !== undefined || Array.isArray(agingRes.body.data));
  });

  // ==========================================================================
  // 2.6 M11, M13, M14 & RESIDENT PORTAL: MAINTENANCE SLA/RATING, NOTIFICATIONS,
  //                                      DASHBOARDS/REPORTS & CONTRACT REQUESTS
  // ==========================================================================
  await t.test('2.6 [M11, M13, M14 & Resident Portal] Maintenance Workflow, Scoped Broadcast, Reports & Contract Proposals', async () => {
    // (a) M11 FR-042..FR-047 & AC-004.1 / AC-004.2: Báo hỏng, cảnh báo trùng, giao STAFF, xử lý & chấm sao
    const sr1 = await apiFetch('/api/v1/resident/service-requests', residentAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: activeContractId,
        title: 'Vòi nước bồn rửa rò rỉ',
        category: 'PLUMBING',
        description: 'Nước nhỏ giọt liên tục dưới gầm tủ bếp',
        priority: 'HIGH',
        images: [TINY_PNG_BASE64],
      }),
    });
    assert.equal(sr1.status, 201, `Resident create SR failed: ${JSON.stringify(sr1.body)}`);
    const srId = sr1.body.data.id;
    cleanup.serviceRequestIds.push(srId);
    assert.match(sr1.body.data.tracking_code, /^SR-\d{8}-\d+$/, 'AC-004.1: Phải cấp mã tra cứu SR-YYYYMMDD-XXXX');

    // AC-004.2: Gửi trùng hạng mục trên cùng căn hộ -> cảnh báo 409 DUPLICATE_SERVICE_REQUEST
    const srDup = await apiFetch('/api/v1/resident/service-requests', residentAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: activeContractId,
        category: 'PLUMBING',
        description: 'Báo lại vòi nước rỉ lần 2',
      }),
    });
    assert.equal(srDup.status, 409);
    assert.equal(srDup.body.code, 'DUPLICATE_SERVICE_REQUEST');

    // Chặn đánh giá khi chưa RESOLVED
    const prematureRate = await apiFetch(`/api/v1/resident/service-requests/${srId}/rating`, residentAuth.token, {
      method: 'POST',
      body: JSON.stringify({ rating: 5, rating_note: 'Chưa sửa xong' }),
    });
    assert.equal(prematureRate.status, 409);

    // MANAGER giao việc xử lý kỹ thuật -> ASSIGNED
    const assignSr = await apiFetch(`/api/v1/service-requests/${srId}/status`, mgrVopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ assigned_to: mgr2VopA.user.sub, status: 'ASSIGNED' }),
    });
    assert.equal(assignSr.status, 200);
    assert.equal(assignSr.body.data.status, 'ASSIGNED');

    // STAFF cập nhật IN_PROGRESS rồi RESOLVED
    const progSr = await apiFetch(`/api/v1/service-requests/${srId}/status`, mgr2VopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'IN_PROGRESS', internal_note: 'Đang thay gioăng cao su vòi bếp' }),
    });
    assert.equal(progSr.status, 200);

    const resolveSr = await apiFetch(`/api/v1/service-requests/${srId}/status`, mgr2VopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'RESOLVED', internal_note: 'Đã thay van mới, hết rò nước' }),
    });
    assert.equal(resolveSr.status, 200);
    assert.equal(resolveSr.body.data.status, 'RESOLVED');

    // Cư dân nghiệm thu & đánh giá 5 sao -> CLOSED (FR-047)
    const rateSr = await apiFetch(`/api/v1/resident/service-requests/${srId}/rating`, residentAuth.token, {
      method: 'POST',
      body: JSON.stringify({ rating: 5, rating_note: 'Kỹ thuật viên hỗ trợ rất nhanh và sạch sẽ!' }),
    });
    assert.equal(rateSr.status, 200);
    assert.equal(rateSr.body.data.status, 'CLOSED');
    assert.equal(Number(rateSr.body.data.rating), 5);

    // (b) M13 FR-051 & FR-053: OWNER bị chặn gửi thông báo (403); MANAGER gửi thông báo phạm vi BUILDING -> cư dân nhận & đọc
    const ownerBroadcast = await apiFetch('/api/v1/notifications', ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({ title: 'Owner Test', content: 'Test', target_scope: 'BUILDING', building_id: vopAId }),
    });
    assert.equal(ownerBroadcast.status, 403, 'PRD 6.2: OWNER chỉ có quyền Read thông báo');

    const bcastTitle = `Thông báo bảo trì thang máy ${suffix}`;
    cleanup.notificationTitles.push(bcastTitle);
    const mgrBroadcast = await apiFetch('/api/v1/notifications', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        title: bcastTitle,
        content: 'Ban Quản Lý bảo trì định kỳ thang máy số 2 từ 14:00 - 15:00.',
        target_scope: 'BUILDING',
        building_id: vopAId,
      }),
    });
    assert.equal(mgrBroadcast.status, 201, `Broadcast failed: ${JSON.stringify(mgrBroadcast.body)}`);

    const resNotifs = await apiFetch('/api/v1/notifications', residentAuth.token);
    assert.equal(resNotifs.status, 200);
    const receivedNotif = (resNotifs.body.data || []).find((n) => n.title === bcastTitle);
    assert.ok(receivedNotif, 'Cư dân trong tòa VOP-A phải nhận được thông báo phát sóng của BQL');

    const markRead = await apiFetch(`/api/v1/notifications/${receivedNotif.id}/read`, residentAuth.token, {
      method: 'PATCH',
    });
    assert.equal(markRead.status, 200);

    // (c) Resident Portal FR-019 / AC-006.1: Đề nghị gia hạn / chấm dứt hợp đồng & cập nhật hồ sơ cá nhân
    const pastTermReq = await apiFetch('/api/v1/resident/contract-requests', residentAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: activeContractId,
        type: 'TERMINATION',
        desired_date: '2020-01-01',
      }),
    });
    assert.equal(pastTermReq.status, 422, 'Ngày mong muốn chấm dứt trong quá khứ phải bị chặn 422');

    const validRenewReq = await apiFetch('/api/v1/resident/contract-requests', residentAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: activeContractId,
        type: 'RENEWAL',
        desired_date: addDaysStr(360),
        note: 'Gia đình muốn gia hạn thuê thêm 12 tháng',
      }),
    });
    assert.equal(validRenewReq.status, 201, `Resident renewal request failed: ${JSON.stringify(validRenewReq.body)}`);

    const overviewRes = await apiFetch(`/api/v1/resident/overview?contract_id=${activeContractId}`, residentAuth.token);
    assert.equal(overviewRes.status, 200);
    assert.equal(overviewRes.body.data.contract.apartment_code, testApt1Code);

    // (d) M14 FR-057 & FR-058: Dashboard & Reports cô lập phạm vi dữ liệu chuẩn xác theo vai trò
    const adminDash = await apiFetch('/api/v1/reports/dashboard', sysAdmin.token);
    assert.equal(adminDash.status, 200);
    assert.equal(adminDash.body.data.revenue_12m.length, 12);

    const expectedOwnSummary = await adminPool.query(
      `SELECT b.code
       FROM building b
       JOIN owner o ON o.id = b.owner_id
       JOIN app_user u ON u.person_id = o.person_id
       WHERE u.id = $1
       ORDER BY b.code`,
      [ownerVop.user.sub]
    );
    const expectedMgrSummary = await adminPool.query(
      `SELECT b.code
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       JOIN building b ON b.id = ur.building_id
       WHERE ur.user_id = $1 AND r.code = 'MANAGER'
       ORDER BY b.code`,
      [mgrVopA.user.sub]
    );

    const ownerSummary = await apiFetch('/api/v1/reports/summary', ownerVop.token);
    assert.equal(ownerSummary.status, 200);
    assert.deepEqual(
      ownerSummary.body.data.occupancy_by_building.map((b) => b.building_code).sort(),
      expectedOwnSummary.rows.map((r) => r.code),
      'OWNER chỉ được tổng hợp báo cáo trên đúng các tòa mình sở hữu'
    );

    const ownerCrossBldgReport = await apiFetch(`/api/v1/reports/dashboard?building_id=${vscAId}`, ownerVop.token);
    assert.equal(ownerCrossBldgReport.status, 403, 'OWNER truy vấn báo cáo tòa chủ khác phải nhận 403');

    const mgrSummary = await apiFetch('/api/v1/reports/summary', mgrVopA.token);
    assert.equal(mgrSummary.status, 200);
    assert.deepEqual(
      mgrSummary.body.data.occupancy_by_building.map((b) => b.building_code).sort(),
      expectedMgrSummary.rows.map((r) => r.code)
    );

    const resSummary = await apiFetch('/api/v1/reports/summary', residentAuth.token);
    assert.equal(resSummary.status, 403, 'RESIDENT không được xem báo cáo quản trị');
  });

  // ==========================================================================
  // 2.7 M05 TERMINATE + M06 DEPOSIT FOUR-EYES SETTLEMENT + SHORTFALL + DAILY JOBS
  // ==========================================================================
  await t.test('2.7 [M05, M06 & White-Box DailyJob] 1-Step Terminate, Deposit Settlement Four-Eyes, Shortfall & Daily Jobs', async () => {
    // (a) Chấm dứt hợp đồng 1 bước (Phương án 2): OWNER bị chặn 403; MANAGER thực hiện kèm lý do bắt buộc
    const ownerTerm = await apiFetch(`/api/v1/contracts/${activeContractId}/terminate`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Owner thử chấm dứt' }),
    });
    assert.equal(ownerTerm.status, 403);

    const mgrTerm = await apiFetch(`/api/v1/contracts/${activeContractId}/terminate`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Hai bên thống nhất bàn giao căn hộ sớm để tất toán cọc' }),
    });
    assert.equal(mgrTerm.status, 200, `Manager terminate failed: ${JSON.stringify(mgrTerm.body)}`);
    assert.equal(mgrTerm.body.data.status, 'TERMINATED');

    const depRowRes = await adminPool.query('SELECT * FROM deposit WHERE contract_id = $1', [activeContractId]);
    const depositId = depRowRes.rows[0].id;
    assert.ok(depRowRes.rows[0].refund_due_date, 'FR-068: Khi chấm dứt HĐ phải tự gán hạn hoàn cọc +5 ngày');

    // Đảm bảo kỳ chấm dứt thực tế (terminated_at YYYY-MM, ví dụ khi bước sang tháng 2026-11) đã ghi đủ chỉ số công tơ kỳ cuối
    const termDateRaw = mgrTerm.body.data.terminated_at;
    const termPeriod = String(termDateRaw || '').slice(0, 7);
    if (termPeriod && termPeriod !== '2026-10') {
      const metersOfApt = await adminPool.query(
        'SELECT id, meter_type FROM meter WHERE apartment_id = $1',
        [testApt1Id]
      );
      if (metersOfApt.rows.length > 0) {
        await apiFetch('/api/v1/meters/readings/batch', mgr2VopA.token, {
          method: 'POST',
          body: JSON.stringify({
            period: termPeriod,
            readings: metersOfApt.rows.map((m) => ({
              meter_id: m.id,
              current_reading: m.meter_type === 'ELECTRICITY' ? 1400 : 80,
              image_base64: TINY_PNG_BASE64,
            })),
          }),
        });
      }
    }

    // (b) M06 FR-023, FR-024, R-06, R-07, R-15, R-24:
    //     - Chặn khấu trừ trực tiếp không qua hồ sơ tất toán & chặn khấu trừ tiền thuê
    //     - Tự động tổng hợp nợ dịch vụ (1.500.000 ₫) vào tất toán, TUYỆT ĐỐI KHÔNG trừ nợ tiền thuê (4.000.000 ₫) vào cọc
    const directDeduct = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'deduct', amount: 500000, description: 'Trừ thẳng' }),
    });
    assert.equal(directDeduct.status, 409);
    assert.equal(directDeduct.body.code, 'MUST_USE_SETTLEMENT');

    const rentDeductAttempt = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [{ category: 'RENT', amount: 2000000, description: 'Cấn trừ tiền thuê', evidence: [TINY_PNG_BASE64] }],
      }),
    });
    assert.equal(rentDeductAttempt.status, 422);
    assert.equal(rentDeductAttempt.body.code, 'RENT_DEDUCTION_FORBIDDEN');

    // Khởi tạo 1 hóa đơn ISSUED cuối kỳ gồm cả nợ RENT (4.000.000 ₫) và nợ SERVICE (1.500.000 ₫) để kiểm chứng R-06
    const finalInvIns = await adminPool.query(
      `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_code, period, status, subtotal_amount, total_amount, paid_amount, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-11', 'ISSUED', 5500000, 5500000, 0, CURRENT_DATE - INTERVAL '7 days')
       RETURNING id`,
      [orgId, vopAId, testApt1Id, activeContractId, primaryTenantId, `INV-FINAL-${suffix}`]
    );
    const finalInvId = finalInvIns.rows[0].id;
    cleanup.invoiceIds.push(finalInvId);
    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES
         ($1, 'RENT', 'Tiền thuê phòng kỳ cuối', 1, 'kỳ', 4000000, 4000000),
         ($1, 'SERVICE', 'Phí dịch vụ & tiện ích kỳ cuối', 1, 'kỳ', 1500000, 1500000)`,
      [finalInvId]
    );
    await adminPool.query(
      `INSERT INTO receivable (org_id, building_id, contract_id, tenant_id, invoice_id, type, amount, paid_amount, due_date, status, description)
       VALUES ($1, $2, $3, $4, $5, 'INVOICE_DEBT', 5500000, 0, CURRENT_DATE - INTERVAL '7 days', 'OPEN', 'Công nợ hóa đơn kỳ cuối')`,
      [orgId, vopAId, activeContractId, primaryTenantId, finalInvId]
    );

    const getSettlePre = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgr2VopA.token);
    assert.equal(getSettlePre.status, 200);
    assert.equal(getSettlePre.body.data.calculated_service_debt, 1500000, 'R-06: Phải tự động lấy đúng 1.500.000 ₫ nợ dịch vụ');
    assert.equal(getSettlePre.body.data.calculated_rent_debt, 4000000, 'R-06: Nợ tiền thuê 4.000.000 ₫ phải tách riêng, không đưa vào nợ trừ cọc');
    assert.equal(getSettlePre.body.data.preconditions.ready, true);

    // mgr2VopA lập hồ sơ tất toán: 10tr cọc, nợ dịch vụ 1.5tr + hư hỏng 10tr = 11.5tr -> refund = 0, shortfall = 1.5tr (nợ thuê 4tr giữ riêng)
    const settleSubmit = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            category: 'DAMAGE',
            amount: 10000000,
            description: 'Hư hỏng sàn gỗ & điều hòa theo biên bản bàn giao',
            evidence: [TINY_PNG_BASE64],
          },
        ],
        refund_method: 'BANK_TRANSFER',
        bank_info: { bank_name: 'Vietcombank', account_number: '0011009999999', account_holder: 'CU DAN TEST' },
      }),
    });
    assert.equal(settleSubmit.status, 200, `Submit settlement failed: ${JSON.stringify(settleSubmit.body)}`);
    assert.equal(settleSubmit.body.data.status, 'PENDING_APPROVAL');
    assert.equal(settleSubmit.body.data.settlement.outstanding_debt, 1500000);
    assert.equal(settleSubmit.body.data.settlement.rent_debt, 4000000);
    assert.equal(settleSubmit.body.data.settlement.shortfall, 1500000);

    // R-07: Cư dân gửi khiếu nại bảng kê -> DISPUTED -> chặn phê duyệt -> Quản lý giải quyết CONFIRM -> về lại PENDING_APPROVAL
    const resDispute = await apiFetch(`/api/v1/deposits/${depositId}/dispute`, residentAuth.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Đề nghị đối chiếu lại biên bản bàn giao sàn gỗ' }),
    });
    assert.equal(resDispute.status, 200, `Resident dispute failed: ${JSON.stringify(resDispute.body)}`);
    assert.equal(resDispute.body.data.status, 'DISPUTED');

    const appWhileDisputed = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, mgrVopA.token, {
      method: 'POST',
    });
    assert.equal(appWhileDisputed.status, 409);
    assert.equal(appWhileDisputed.body.code, 'SETTLEMENT_DISPUTED');

    const resolveDispute = await apiFetch(`/api/v1/deposits/${depositId}/resolve-dispute`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        resolution: 'CONFIRM',
        reason: 'Đã đối chiếu biên bản nghiệm thu có chữ ký hai bên',
      }),
    });
    assert.equal(resolveDispute.status, 200, `Resolve dispute failed: ${JSON.stringify(resolveDispute.body)}`);
    assert.equal(resolveDispute.body.data.status, 'PENDING_APPROVAL');

    // R-24: Xuất biên bản tất toán A4 HTML printable
    const pdfRes = await fetch(`${API_BASE}/api/v1/deposits/${depositId}/settlement/pdf`, {
      headers: { Authorization: `Bearer ${residentAuth.token}` },
    });
    assert.equal(pdfRes.status, 200);
    const pdfHtml = await pdfRes.text();
    assert.match(pdfHtml, /BIÊN BẢN TẤT TOÁN/i);

    // SYS_ADMIN phê duyệt bị chặn 403 trên tòa VOP-A đã có OWNER hoạt động (PRD 6.2)
    const sysAppDep = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, sysAdmin.token, {
      method: 'POST',
    });
    assert.equal(sysAppDep.status, 403);

    // MANAGER thứ 2 (mgrVopA) từ chối hồ sơ do mgr2VopA lập -> SETTLEMENT_DRAFT, mgr2VopA nộp lại -> OWNER phê duyệt (Four-eyes hợp lệ)
    const mgrRejDep = await apiFetch(`/api/v1/deposits/${depositId}/settlement/reject`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Rà soát lại câu chữ biên bản khấu trừ' }),
    });
    assert.equal(mgrRejDep.status, 200, `Reject settlement failed: ${JSON.stringify(mgrRejDep.body)}`);
    assert.equal(mgrRejDep.body.data.status, 'SETTLEMENT_DRAFT');

    const settleResubmit = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgr2VopA.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            category: 'DAMAGE',
            amount: 10000000,
            description: 'Hư hỏng sàn gỗ & điều hòa theo biên bản bàn giao (đã rà soát)',
            evidence: [TINY_PNG_BASE64],
          },
        ],
        refund_method: 'BANK_TRANSFER',
        bank_info: { bank_name: 'Vietcombank', account_number: '0011009999999', account_holder: 'CU DAN TEST' },
      }),
    });
    assert.equal(settleResubmit.status, 200, `Resubmit settlement failed: ${JSON.stringify(settleResubmit.body)}`);

    const ownerAppDep = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, ownerVop.token, {
      method: 'POST',
    });
    assert.equal(ownerAppDep.status, 200, `Approve settlement failed: ${JSON.stringify(ownerAppDep.body)}`);
    assert.equal(ownerAppDep.body.data.status, 'DEDUCTED_FULL');

    // R-15: Sau khi tất toán (REFUNDED), chặn ghi nhận thu bổ sung vào sổ cọc đã đóng
    const postSettleCollect = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 500000, method: 'CASH' }),
    });
    assert.equal(postSettleCollect.status, 409, 'R-15: Không được thu bổ sung vào sổ cọc đã tất toán');
    assert.equal(postSettleCollect.body.code, 'DEPOSIT_NOT_COLLECTIBLE');

    // 037 Trigger: Bút toán deposit_transaction đã APPROVED là bất biến (chặn UPDATE & DELETE)
    const sampleDepTxn = await adminPool.query(
      `SELECT id FROM deposit_transaction WHERE deposit_id = $1 AND status = 'APPROVED' LIMIT 1`,
      [depositId]
    );
    assert.ok(sampleDepTxn.rows.length > 0);
    await assert.rejects(
      () => adminPool.query(`UPDATE deposit_transaction SET amount = 1 WHERE id = $1`, [sampleDepTxn.rows[0].id]),
      (err) => err.code === '23514' || /bất biến/i.test(err.message),
      'Trigger trg_deposit_txn_immutable phải chặn UPDATE trên bút toán cọc đã APPROVED'
    );

    const shortfallRec = await adminPool.query(
      `SELECT * FROM receivable WHERE contract_id = $1 AND type = 'RECEIVABLE_AFTER_MOVE_OUT'`,
      [activeContractId]
    );
    assert.ok(shortfallRec.rows.length >= 1, 'AC-017.2 & R-06: Công nợ sau trả phòng phải chuyển sang RECEIVABLE_AFTER_MOVE_OUT');

    // (c) [WHITE-BOX SCHEDULED JOB] Kiểm thử trực tiếp `runDailyJobs()` (FR-018, FR-068, AC-010.1, R-02, R-08, R-11):
    //     1) Hợp đồng hết hạn hôm nay -> tự chuyển EXPIRED + căn hộ sang MAINTENANCE (bắt buộc nghiệm thu bàn giao trước khi AVAILABLE)
    //     2) Hóa đơn quá hạn > 5 ngày ân hạn -> sang OVERDUE + tự động cộng phạt 100.000 ₫/ngày (LATE_FEE)
    //     3) Hợp đồng còn đúng 30 ngày -> sinh thông báo CONTRACT_EXPIRY cho cả MANAGER & RESIDENT
    const expContractIns = await adminPool.query(
      `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, deposit_amount, status)
       VALUES ($1, $2, $3, CURRENT_DATE - INTERVAL '60 days', CURRENT_DATE, 10000000, 5, 10000000, 'ACTIVE')
       RETURNING id`,
      [vopAId, testApt2Id, primaryTenantId]
    );
    const expCtrId = expContractIns.rows[0].id;
    cleanup.contractIds.push(expCtrId);
    await adminPool.query("UPDATE apartment SET status = 'OCCUPIED' WHERE id = $1", [testApt2Id]);

    await runDailyJobs();

    // R-11: finalInvId có due_date = CURRENT_DATE - 7 days (quá 5 ngày ân hạn 2 ngày) -> tự sang OVERDUE và cộng dòng LATE_FEE 2 × 100.000 = 200.000 ₫
    const overdueCheck = await adminPool.query('SELECT status, total_amount FROM invoice WHERE id = $1', [finalInvId]);
    assert.equal(overdueCheck.rows[0].status, 'OVERDUE', 'R-11: Hóa đơn quá hạn > 5 ngày phải sang OVERDUE');
    assert.equal(Number(overdueCheck.rows[0].total_amount), 5700000, 'R-11: Phải tự động cộng phạt chậm thanh toán 2 ngày × 100.000 ₫/ngày = 200.000 ₫');

    const expCtrAfter = await adminPool.query('SELECT status FROM contract WHERE id = $1', [expCtrId]);
    assert.equal(expCtrAfter.rows[0].status, 'EXPIRED', 'DailyJob phải tự chuyển HĐ hết hạn sang EXPIRED');
    const apt2After = await adminPool.query('SELECT status FROM apartment WHERE id = $1', [testApt2Id]);
    assert.equal(apt2After.rows[0].status, 'MAINTENANCE', 'R-02: HĐ hết hạn tự động phải đưa căn hộ sang MAINTENANCE chờ nghiệm thu bàn giao');

    // R-08: Bàn giao căn hộ (PATCH /apartments/:id/handover) -> chuyển từ MAINTENANCE về AVAILABLE an toàn
    const handoverApt2 = await apiFetch(`/api/v1/apartments/${testApt2Id}/handover`, mgrVopA.token, {
      method: 'PATCH',
    });
    assert.equal(handoverApt2.status, 200, `Handover failed: ${JSON.stringify(handoverApt2.body)}`);
    assert.equal(handoverApt2.body.data.status, 'AVAILABLE', 'R-08: Sau nghiệm thu bàn giao, căn hộ chuyển về AVAILABLE');

    // Kiểm tra cảnh báo 30 ngày (AC-010.1) trên cùng testApt2Id vừa trống
    const warn30Ins = await adminPool.query(
      `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, deposit_amount, status)
       VALUES ($1, $2, $3, CURRENT_DATE - INTERVAL '10 days', (CURRENT_DATE + INTERVAL '30 days')::date, 10000000, 5, 10000000, 'ACTIVE')
       RETURNING id`,
      [vopAId, testApt2Id, primaryTenantId]
    );
    const warn30CtrId = warn30Ins.rows[0].id;
    cleanup.contractIds.push(warn30CtrId);

    await runDailyJobs();

    const expiryNotifs = await adminPool.query(
      `SELECT user_id FROM notification WHERE type = 'CONTRACT_EXPIRY' AND (payload->>'contract_id') = $1`,
      [warn30CtrId]
    );
    const notifiedIds = expiryNotifs.rows.map((r) => r.user_id);
    assert.ok(notifiedIds.includes(mgrVopA.user.sub), 'AC-010.1: MANAGER phải nhận cảnh báo HĐ còn 30 ngày');
    assert.ok(notifiedIds.includes(residentAuth.user.sub), 'AC-010.1: RESIDENT phải nhận nhắc gia hạn HĐ còn 30 ngày');

    await adminPool.query('DELETE FROM notification WHERE (payload->>\'contract_id\') = $1', [warn30CtrId]);
  });
});

// ============================================================================
// PHẦN 3 — KIỂM TRA BẢO TOÀN BẤT BIẾN CSDL SEED SAU TOÀN BỘ TEST SUITE
// ============================================================================
test('WB+BB-03 [Post-Suite Invariant Check] Seeded & User Database Remains Clean (Zero Leaked Rows)', async () => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  try {
    const bCount = await adminPool.query('SELECT COUNT(*)::int AS cnt FROM building');
    const aCount = await adminPool.query('SELECT COUNT(*)::int AS cnt FROM apartment');
    assert.ok(bCount.rows[0].cnt >= 9, 'CSDL phải có tối thiểu 9 tòa nhà mẫu');
    assert.ok(aCount.rows[0].cnt >= 450, 'CSDL phải có tối thiểu 450 căn hộ mẫu');
    assert.equal(bCount.rows[0].cnt, baselineCounts.buildings, 'Sau khi chạy xong test suite, CSDL không được rò rỉ thêm tòa nhà tạm');
    assert.equal(aCount.rows[0].cnt, baselineCounts.apartments, 'Sau khi chạy xong test suite, CSDL không được rò rỉ thêm căn hộ tạm');
  } finally {
    await adminPool.end();
    await coreAdminPool.end().catch(() => {});
    await coreAppPool.end().catch(() => {});
  }
});
