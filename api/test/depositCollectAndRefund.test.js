/**
 * DEPOSIT COLLECTION & REFUND END-TO-END AUDIT SUITE
 * Kiểm thử chuyên sâu toàn bộ vòng đời Thu cọc / Kết chuyển / Khấu trừ / Tất toán & Hoàn cọc:
 *  1. Đặt cọc giữ chỗ (Reservation): tạo giữ chỗ, chặn tự duyệt hoàn 4 mắt, duyệt hoàn cọc giữ chỗ (REFUNDED), bỏ cọc (FORFEITED).
 *  2. Kết chuyển cọc giữ chỗ sang Sổ cọc hợp đồng + Thu bổ sung cọc (Collect) + Kiểm tra bất biến sổ cái (trg_deposit_txn_immutable) + OWNER đọc audit_log.
 *  3. Chuyển phòng không kết chuyển cọc (transfer_deposit = false) & Gia hạn hợp đồng giảm mức cọc (giữ phần dư cọc cũ chờ hoàn).
 *  4. Lập tất toán cọc: chặn các điều kiện tiên quyết, cấm khấu trừ RENT, bắt buộc ảnh bằng chứng, bóc tách chuẩn serviceDebt vs rentDebt (kể cả khi hóa đơn có chiết khấu âm & thanh toán một phần).
 *  5. Duyệt 4 mắt (Approve / Reject), Khiếu nại & Giải quyết tranh chấp (ADJUST / CONFIRM), Hoàn 100% (REFUNDED), Hoàn 1 phần (PARTIALLY_REFUNDED), Vượt cọc (Shortfall -> RECEIVABLE_AFTER_MOVE_OUT), và Xuất biên bản A4.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5000';
const ADMIN_DB_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL || 'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function apiFetch(path, token, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  let body = null;
  if (contentType.includes('application/json')) {
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
  } else {
    body = { raw: text };
  }
  return { status: res.status, contentType, body };
}

async function loginEmail(email, password) {
  const res = await apiFetch('/api/v1/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken, user: res.body.user };
}

function isoDaysFromToday(offsetDays) {
  const vnTodayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = vnTodayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

test('Deposit Collection & Refund Full Lifecycle Suite', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const appPool = new pg.Pool({ connectionString: APP_DB_URL });
  const suffix = String(Date.now()).slice(-6);

  const cleanup = {
    contractIds: [],
    apartmentIds: [],
    reservationIds: [],
    invoiceIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
  };

  const bRes = await adminPool.query(
    `SELECT b.id, b.org_id, f.id AS floor_id
     FROM building b
     JOIN floor f ON f.building_id = b.id
     WHERE b.code = 'VOP-A'
     ORDER BY f.level ASC
     LIMIT 1`
  );
  const buildingId = bRes.rows[0].id;
  const orgId = bRes.rows[0].org_id;
  const floorId = bRes.rows[0].floor_id;

  t.after(async () => {
    try {
      for (const invId of cleanup.invoiceIds) {
        await adminPool.query('DELETE FROM receivable WHERE invoice_id = $1', [invId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice_line WHERE invoice_id = $1', [invId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE id = $1', [invId]).catch(() => {});
      }
      for (const cId of cleanup.contractIds) {
        await adminPool.query('DELETE FROM receivable WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query(
          'DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)',
          [cId]
        ).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM notification WHERE payload::text LIKE $1', [`%${cId}%`]).catch(() => {});
        const depClean = await adminPool.connect();
        try {
          await depClean.query('BEGIN');
          await depClean.query("SET LOCAL app.allow_test_cleanup = 'true'");
          await depClean.query(
            'DELETE FROM deposit_transaction WHERE deposit_id IN (SELECT id FROM deposit WHERE contract_id = $1)',
            [cId]
          );
          await depClean.query('DELETE FROM deposit WHERE contract_id = $1', [cId]);
          await depClean.query('COMMIT');
        } catch {
          await depClean.query('ROLLBACK').catch(() => {});
        } finally {
          depClean.release();
        }
        await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'contract' AND owner_id = $1", [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('UPDATE contract SET parent_contract_id = NULL WHERE parent_contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
      }
      for (const rId of cleanup.reservationIds) {
        await adminPool.query('DELETE FROM reservation WHERE id = $1', [rId]).catch(() => {});
      }
      for (const aId of cleanup.apartmentIds) {
        await adminPool.query('DELETE FROM reservation WHERE apartment_id = $1', [aId]).catch(() => {});
        await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
      }
      for (const tId of cleanup.tenantIds) {
        await adminPool.query('DELETE FROM contract_occupant WHERE tenant_id = $1', [tId]).catch(() => {});
        await adminPool.query('DELETE FROM tenant WHERE id = $1', [tId]).catch(() => {});
      }
      for (const uId of cleanup.userIds) {
        await adminPool.query('DELETE FROM notification WHERE user_id = $1', [uId]).catch(() => {});
        await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [uId]).catch(() => {});
        await adminPool
          .query(`DELETE FROM app_user WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log WHERE actor_id = $1)`, [uId])
          .catch(() => {});
      }
      for (const pId of cleanup.personIds) {
        await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId]).catch(() => {});
        await adminPool
          .query(`DELETE FROM app_user u WHERE u.person_id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_id = u.id)`, [pId])
          .catch(() => {});
        await adminPool
          .query(`DELETE FROM person WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM app_user WHERE person_id = $1)`, [pId])
          .catch(() => {});
      }
    } finally {
      await appPool.end();
      await adminPool.end();
    }
  });

  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const owner = await loginEmail('owner.vop@resihub.vn', 'Demo@123456');
  const manager = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');

  async function createTestApartment(codePrefix, baseRent = 10000000) {
    const res = await apiFetch('/api/v1/apartments', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: buildingId,
        floor_id: floorId,
        code: `${codePrefix}-${suffix}`,
        area_m2: 50,
        bedrooms: 1,
        type: '1PN',
        base_rent: baseRent,
      }),
    });
    assert.equal(res.status, 201, `Create apartment failed: ${JSON.stringify(res.body)}`);
    cleanup.apartmentIds.push(res.body.data.id);
    return res.body.data;
  }

  async function trackNewResident(phone) {
    const pRes = await adminPool.query('SELECT id FROM person WHERE phone = $1 LIMIT 1', [phone]);
    if (pRes.rows[0]) {
      const pId = pRes.rows[0].id;
      if (!cleanup.personIds.includes(pId)) cleanup.personIds.push(pId);
      const tRes = await adminPool.query('SELECT id FROM tenant WHERE person_id = $1', [pId]);
      tRes.rows.forEach((r) => {
        if (!cleanup.tenantIds.includes(r.id)) cleanup.tenantIds.push(r.id);
      });
      const uRes = await adminPool.query('SELECT id FROM app_user WHERE person_id = $1', [pId]);
      uRes.rows.forEach((r) => {
        if (!cleanup.userIds.includes(r.id)) cleanup.userIds.push(r.id);
      });
    }
  }

  // =========================================================================
  // 1. CỌC GIỮ CHỖ (RESERVATION): TẠO, CHẶN TỰ HOÀN 4 MẮT, HOÀN CỌC, BỎ CỌC
  // =========================================================================
  const apt1 = await createTestApartment('DEP-A1', 10000000);
  const todayStr = isoDaysFromToday(0);
  const plus7Str = isoDaysFromToday(7);

  const rsv1Res = await apiFetch('/api/v1/reservations', manager.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: apt1.id,
      prospect_name: `Khách Giữ Chỗ 1 ${suffix}`,
      phone: `0961${suffix}`,
      hold_amount: 3000000,
      hold_from: todayStr,
      hold_until: plus7Str,
      note: 'Test hoàn cọc giữ chỗ 4 mắt',
    }),
  });
  assert.equal(rsv1Res.status, 201);
  const rsv1Id = rsv1Res.body.data.id;
  cleanup.reservationIds.push(rsv1Id);

  // Người tạo tự duyệt hoàn cọc giữ chỗ -> bị chặn 403 FOUR_EYES_VIOLATION
  const selfRefundRsv = await apiFetch(`/api/v1/reservations/${rsv1Id}/refund`, manager.token, {
    method: 'PATCH',
    body: JSON.stringify({ reason: 'Tự hoàn cọc giữ chỗ' }),
  });
  assert.equal(selfRefundRsv.status, 403);
  assert.equal(selfRefundRsv.body.code, 'FOUR_EYES_VIOLATION');

  // OWNER duyệt hoàn cọc giữ chỗ -> 200 APPROVED_PENDING_PAYOUT -> MANAGER chi hoàn -> 200 REFUNDED
  const okRefundRsv = await apiFetch(`/api/v1/reservations/${rsv1Id}/refund`, owner.token, {
    method: 'PATCH',
    body: JSON.stringify({ reason: 'Hoàn cọc giữ chỗ theo thỏa thuận', refund_method: 'CASH' }),
  });
  assert.equal(okRefundRsv.status, 200);
  assert.equal(okRefundRsv.body.data.status, 'APPROVED_PENDING_PAYOUT');

  const payoutRsv1 = await apiFetch(`/api/v1/reservations/${rsv1Id}/cancel-payout`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ refund_method: 'CASH', note: 'Chi tiền mặt hoàn cọc giữ chỗ' }),
  });
  assert.equal(payoutRsv1.status, 200);
  assert.equal(payoutRsv1.body.data.status, 'REFUNDED');

  // Khách 2 đặt giữ chỗ rồi bỏ cọc -> FORFEITED (Four-Eyes + reason)
  const rsv2Res = await apiFetch('/api/v1/reservations', manager.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: apt1.id,
      prospect_name: `Khách Bỏ Cọc ${suffix}`,
      phone: `0962${suffix}`,
      hold_amount: 2000000,
      hold_from: todayStr,
      hold_until: plus7Str,
    }),
  });
  assert.equal(rsv2Res.status, 201);
  cleanup.reservationIds.push(rsv2Res.body.data.id);

  const selfForfeitRsv = await apiFetch(`/api/v1/reservations/${rsv2Res.body.data.id}/forfeit`, manager.token, {
    method: 'PATCH',
    body: JSON.stringify({ reason: 'Tự tịch thu cọc' }),
  });
  assert.equal(selfForfeitRsv.status, 403);
  assert.equal(selfForfeitRsv.body.code, 'FOUR_EYES_VIOLATION');

  const forfeitRes = await apiFetch(`/api/v1/reservations/${rsv2Res.body.data.id}/forfeit`, owner.token, {
    method: 'PATCH',
    body: JSON.stringify({ reason: 'Khách hủy giữ chỗ quá hạn ký HĐ' }),
  });
  assert.equal(forfeitRes.status, 200);
  assert.equal(forfeitRes.body.data.status, 'FORFEITED');

  // =========================================================================
  // 2. KẾT CHUYỂN CỌC GIỮ CHỖ + THU BỔ SUNG + BẤT BIẾN SỔ CÁI + TẤT TOÁN CÓ NỢ HỖN HỢP
  // =========================================================================
  const resPhone = `0963${suffix}`;
  const resEmail = `dep.resident.${suffix}@resihub.test`;
  const rsv3Res = await apiFetch('/api/v1/reservations', manager.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: apt1.id,
      prospect_name: `Cư Dân Cọc ${suffix}`,
      phone: resPhone,
      hold_amount: 2000000,
      hold_from: todayStr,
      hold_until: plus7Str,
    }),
  });
  assert.equal(rsv3Res.status, 201);
  const rsv3Id = rsv3Res.body.data.id;
  cleanup.reservationIds.push(rsv3Id);

  const c1Res = await apiFetch('/api/v1/contracts', manager.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: apt1.id,
      reservation_id: rsv3Id,
      start_date: todayStr,
      end_date: isoDaysFromToday(180),
      rent_amount: 10000000,
      deposit_amount: 10000000,
      billing_day: 1,
      new_tenant: {
        full_name: `Cư Dân Cọc ${suffix}`,
        phone: resPhone,
        email: resEmail,
        id_number: `079200${suffix}`,
        password: 'Password@123',
      },
    }),
  });
  assert.equal(c1Res.status, 201, `Create c1 failed: ${JSON.stringify(c1Res.body)}`);
  const c1Id = c1Res.body.data.id;
  cleanup.contractIds.push(c1Id);
  await trackNewResident(resPhone);

  await apiFetch(`/api/v1/contracts/${c1Id}/scan`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ image_base64: TINY_PNG_BASE64 }),
  });

  const act1 = await apiFetch(`/api/v1/contracts/${c1Id}/activate`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ reservation_id: rsv3Id }),
  });
  assert.equal(act1.status, 200, `Activate c1 failed: ${JSON.stringify(act1.body)}`);
  assert.equal(act1.body.remaining_collect, 8000000);

  const depList = await apiFetch('/api/v1/deposits', manager.token);
  const dep1 = depList.body.data.find((d) => d.contract_id === c1Id);
  assert.ok(dep1, 'Sổ cọc phải được mở khi kích hoạt hợp đồng');
  assert.equal(Number(dep1.amount_held), 2000000);
  assert.equal(dep1.status, 'HELD');

  // Chặn gọi trực tiếp deduct/refund qua POST /:id/transactions
  const badDeduct = await apiFetch(`/api/v1/deposits/${dep1.id}/transactions`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'deduct', amount: 500000, method: 'CASH' }),
  });
  assert.equal(badDeduct.status, 409);
  assert.equal(badDeduct.body.code, 'MUST_USE_SETTLEMENT');

  // Chặn thiếu method khi thu bổ sung
  const noMethod = await apiFetch(`/api/v1/deposits/${dep1.id}/transactions`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'collect', amount: 8000000 }),
  });
  assert.equal(noMethod.status, 400);
  assert.equal(noMethod.body.code, 'METHOD_REQUIRED');

  // Chặn OWNER thu bổ sung (100% Read-Only)
  const ownerCollect = await apiFetch(`/api/v1/deposits/${dep1.id}/transactions`, owner.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'collect', amount: 8000000, method: 'BANK_TRANSFER' }),
  });
  assert.equal(ownerCollect.status, 403);

  // MANAGER thu bổ sung đủ 8.000.000 ₫ -> tổng cọc = 10.000.000 ₫
  const okCollect = await apiFetch(`/api/v1/deposits/${dep1.id}/transactions`, manager.token, {
    method: 'POST',
    body: JSON.stringify({
      type: 'collect',
      amount: 8000000,
      method: 'BANK_TRANSFER',
      description: 'Thu đủ phần cọc còn lại theo HĐ',
      evidence: ['https://example.com/receipt-collect.png'],
    }),
  });
  assert.equal(okCollect.status, 201);
  const collectTxnId = okCollect.body.data.id;

  // Kiểm tra OWNER đọc được cả giao dịch thu cọc trong AuditLogs
  const ownerAudit = await apiFetch(`/api/v1/audit-logs?entity=deposit_transaction&search=${collectTxnId}`, owner.token);
  assert.equal(ownerAudit.status, 200);
  assert.ok(ownerAudit.body.data.some((row) => row.entity_id === collectTxnId), 'OWNER phải xem được nhật ký thu cọc của tòa sở hữu');

  // Kiểm tra bất biến sổ cái 2 lớp (RLS + Trigger trg_deposit_txn_immutable):
  // - Lớp 1 (RLS): resihub_app bị chặn hoàn toàn UPDATE/DELETE dòng APPROVED (rowCount = 0)
  // - Lớp 2 (Trigger): ngay cả superuser adminPool cũng bị trigger chặn UPDATE/DELETE trực tiếp
  const appClient = await appPool.connect();
  try {
    await appClient.query('BEGIN');
    await appClient.query(`SELECT set_config('app.current_user_id', $1, true)`, [sysAdmin.user.id]);
    const updAttempt = await appClient.query('UPDATE deposit_transaction SET amount = 1 WHERE id = $1', [collectTxnId]);
    assert.equal(updAttempt.rowCount, 0, 'RLS phải chặn resihub_app sửa bút toán APPROVED');
    const delAttempt = await appClient.query('DELETE FROM deposit_transaction WHERE id = $1', [collectTxnId]);
    assert.equal(delAttempt.rowCount, 0, 'RLS phải chặn resihub_app xóa bút toán APPROVED');
    await appClient.query('ROLLBACK');
  } finally {
    appClient.release();
  }
  await assert.rejects(
    () => adminPool.query('UPDATE deposit_transaction SET amount = 1 WHERE id = $1', [collectTxnId]),
    /bất biến|không được phép|immutable/i
  );

  // Chặn lập tất toán khi hợp đồng còn ACTIVE
  const earlySubmit = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ items: [], refund_method: 'BANK_TRANSFER' }),
  });
  assert.equal(earlySubmit.status, 409);
  assert.equal(earlySubmit.body.code, 'CONTRACT_NOT_TERMINATED_OR_EXPIRED');

  // Tạo hóa đơn hỗn hợp:
  //   Inv A: RENT = 10.000.000 + ELECTRICITY = 1.200.000, chiết khấu = -200.000 -> total = 11.000.000, đã trả = 10.300.000
  //          => remaining = 700.000 (tiền thuê đã trả đủ 10M, chỉ còn nợ dịch vụ đúng 700.000, KHÔNG bị vọt lên 900.000!)
  //   Inv B: RENT = 5.000.000 + SERVICE = 500.000 -> total = 5.500.000, đã trả = 0
  //          => nợ RENT = 5.000.000 (KHÔNG ĐƯỢC CẤN TRỪ VÀO CỌC), nợ dịch vụ = 500.000 (ĐỐI TRỪ VÀO CỌC)
  // => Tổng nợ dịch vụ đối trừ = 700.000 + 500.000 = 1.200.000; Tổng nợ tiền thuê giữ riêng = 5.000.000!
  const c1Meta = await adminPool.query('SELECT primary_tenant_id FROM contract WHERE id = $1', [c1Id]);
  const primaryTenantId = c1Meta.rows[0].primary_tenant_id;

  const invARes = await adminPool.query(
    `INSERT INTO invoice (
       org_id, building_id, apartment_id, contract_id, tenant_id,
       invoice_code, period, issue_date, due_date,
       subtotal_amount, adjustment_amount, total_amount, paid_amount, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, '2026-09', CURRENT_DATE, CURRENT_DATE + 5, 11200000, -200000, 11000000, 10300000, 'PARTIALLY_PAID')
     RETURNING id`,
    [orgId, buildingId, apt1.id, c1Id, primaryTenantId, `INV-DEPA-${suffix}`]
  );
  const invAId = invARes.rows[0].id;
  cleanup.invoiceIds.push(invAId);
  await adminPool.query(
    `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
     VALUES ($1, 'RENT', 'Tiền thuê T9', 1, 'tháng', 10000000, 10000000),
            ($1, 'ELECTRICITY', 'Tiền điện T9', 300, 'kWh', 4000, 1200000)`,
    [invAId]
  );

  const invBRes = await adminPool.query(
    `INSERT INTO invoice (
       org_id, building_id, apartment_id, contract_id, tenant_id,
       invoice_code, period, issue_date, due_date,
       subtotal_amount, adjustment_amount, total_amount, paid_amount, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, '2026-10', CURRENT_DATE, CURRENT_DATE + 5, 5500000, 0, 5500000, 0, 'ISSUED')
     RETURNING id`,
    [orgId, buildingId, apt1.id, c1Id, primaryTenantId, `INV-DEPB-${suffix}`]
  );
  const invBId = invBRes.rows[0].id;
  cleanup.invoiceIds.push(invBId);
  await adminPool.query(
    `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
     VALUES ($1, 'RENT', 'Tiền thuê T10', 1, 'kỳ', 5000000, 5000000),
            ($1, 'SERVICE', 'Phí dịch vụ T10', 1, 'kỳ', 500000, 500000)`,
    [invBId]
  );

  // Chấm dứt hợp đồng -> mở hạn hoàn cọc +5 ngày
  const term1 = await apiFetch(`/api/v1/contracts/${c1Id}/terminate`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ terminated_date: todayStr, reason: 'Khách trả phòng kiểm thử tất toán cọc' }),
  });
  assert.equal(term1.status, 200);
  assert.ok(term1.body.refund_due_date, 'Phải sinh hạn hoàn cọc +5 ngày');

  // Ghi nhận biên bản kiểm tra bàn giao phòng kèm hình ảnh (FR-024, R-12) trước khi kiểm tra điều kiện tiên quyết
  const hoApt1 = await apiFetch(`/api/v1/apartments/${apt1.id}/handover`, manager.token, {
    method: 'PATCH',
    body: JSON.stringify({
      note: 'Nghiệm thu bàn giao',
      evidence: ['https://example.com/handover-apt1.png'],
      keep_maintenance: true,
    }),
  });
  assert.equal(hoApt1.status, 200);

  // Kiểm tra GET /settlement bóc tách đúng serviceDebt = 1.200.000 và rentDebt = 5.000.000
  const preSettle = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement`, manager.token);
  assert.equal(preSettle.status, 200);
  assert.equal(preSettle.body.data.calculated_service_debt, 1200000);
  assert.equal(preSettle.body.data.calculated_rent_debt, 5000000);
  assert.equal(preSettle.body.data.preconditions.ready, true);

  // Chặn khấu trừ danh mục RENT (422) & thiếu ảnh bằng chứng (422)
  const rentDeduct = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement`, manager.token, {
    method: 'POST',
    body: JSON.stringify({
      items: [{ category: 'RENT', amount: 5000000, description: 'Cố trừ tiền thuê', evidence: ['https://example.com/a.png'] }],
    }),
  });
  assert.equal(rentDeduct.status, 422);
  assert.equal(rentDeduct.body.code, 'RENT_DEDUCTION_FORBIDDEN');

  const noEvidDeduct = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement`, manager.token, {
    method: 'POST',
    body: JSON.stringify({
      items: [{ category: 'CLEANING', amount: 300000, description: 'Vệ sinh phòng', evidence: [] }],
    }),
  });
  assert.equal(noEvidDeduct.status, 422);
  assert.equal(noEvidDeduct.body.code, 'EVIDENCE_REQUIRED');

  // Lập biên bản hợp lệ: khấu trừ DAMAGE 800.000 + nợ dịch vụ tự động 1.200.000 => hoàn trả 8.000.000 (cọc 10M), nợ RENT 5.000.000 giữ riêng!
  const submit1 = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement`, manager.token, {
    method: 'POST',
    body: JSON.stringify({
      items: [
        {
          category: 'DAMAGE',
          amount: 800000,
          description: 'Sơn dặm tường phòng ngủ',
          evidence: ['https://example.com/wall-damage.png'],
        },
      ],
      refund_method: 'BANK_TRANSFER',
      bank_info: {
        bank_name: 'Vietcombank',
        account_number: '001100999888',
        account_holder: 'CU DAN COC',
      },
    }),
  });
  assert.equal(submit1.status, 200);
  assert.equal(submit1.body.data.status, 'PENDING_APPROVAL');
  assert.equal(submit1.body.data.settlement.refund_amount, 8000000);
  assert.equal(submit1.body.data.settlement.rent_debt, 5000000);

  // Chặn người lập tự duyệt / tự từ chối (403 SELF_APPROVAL)
  const selfApprove = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement/approve`, manager.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(selfApprove.status, 403);
  assert.equal(selfApprove.body.code, 'SELF_APPROVAL');

  const selfReject = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement/reject`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Tự từ chối' }),
  });
  assert.equal(selfReject.status, 403);
  assert.equal(selfReject.body.code, 'SELF_APPROVAL');

  // OWNER từ chối -> về SETTLEMENT_DRAFT -> MANAGER trình lại
  const sysReject = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement/reject`, owner.token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Kiểm tra lại ghi chú số tài khoản khách thuê' }),
  });
  assert.equal(sysReject.status, 200);
  assert.equal(sysReject.body.data.status, 'SETTLEMENT_DRAFT');

  const resubmit1 = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement`, manager.token, {
    method: 'POST',
    body: JSON.stringify({
      items: [
        {
          category: 'DAMAGE',
          amount: 800000,
          description: 'Sơn dặm tường phòng ngủ (đã đối chiếu)',
          evidence: ['https://example.com/wall-damage.png'],
        },
      ],
      refund_method: 'BANK_TRANSFER',
      bank_info: {
        bank_name: 'Vietcombank',
        account_number: '001100999888',
        account_holder: 'CU DAN COC',
      },
    }),
  });
  assert.equal(resubmit1.status, 200);

  // Cư dân đăng nhập xem bảng kê & gửi khiếu nại -> DISPUTED -> khóa phê duyệt
  const residentAuth = await loginEmail(resEmail, 'Password@123');
  const resDispute1 = await apiFetch(`/api/v1/deposits/${dep1.id}/dispute`, residentAuth.token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Đề nghị xem lại chi phí sơn dặm 800k' }),
  });
  assert.equal(resDispute1.status, 200);
  assert.equal(resDispute1.body.data.status, 'DISPUTED');

  const blockedApprove = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement/approve`, owner.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(blockedApprove.status, 409);
  assert.equal(blockedApprove.body.code, 'SETTLEMENT_DISPUTED');

  // Quản lý giải quyết CONFIRM -> quay về PENDING_APPROVAL -> OWNER phê duyệt
  const resolveConfirm1 = await apiFetch(`/api/v1/deposits/${dep1.id}/resolve-dispute`, manager.token, {
    method: 'POST',
    body: JSON.stringify({
      resolution: 'CONFIRM',
      reason: 'Đã gửi biên bản nghiệm thu có chữ ký xác nhận của cư dân',
    }),
  });
  assert.equal(resolveConfirm1.status, 200);
  assert.equal(resolveConfirm1.body.data.status, 'PENDING_APPROVAL');

  const approve1 = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement/approve`, owner.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(approve1.status, 200);
  assert.equal(approve1.body.data.status, 'APPROVED_PENDING_PAYOUT');
  assert.equal(String(approve1.body.data.amount_held), '10000000');
  assert.equal(approve1.body.data.settlement.refund_amount, 8000000);
  assert.equal(approve1.body.data.settlement.covered_service_debt, 1200000);
  assert.equal(approve1.body.data.settlement.rent_debt, 5000000);

  const payout1 = await apiFetch(`/api/v1/deposits/${dep1.id}/payout`, manager.token, {
    method: 'POST',
    body: JSON.stringify({
      evidence: ['https://example.com/unc-dep1.png'],
      reference_code: 'UNC-DEP1',
    }),
  });
  assert.equal(payout1.status, 200);
  assert.equal(payout1.body.data.status, 'PARTIALLY_REFUNDED');
  assert.equal(String(payout1.body.data.amount_held), '0');

  // Đối chiếu DB sau khi phê duyệt hoàn cọc:
  // - Inv A (còn 700k dịch vụ) được gạch nợ thành PAID (11.000.000)
  // - Inv B (5M RENT + 500k dịch vụ) chỉ được gạch nợ đúng 500k dịch vụ -> paid_amount = 500.000, status = PARTIALLY_PAID,
  //   còn 5.000.000 tiền thuê KHÔNG bị trừ cọc và sinh RECEIVABLE_AFTER_MOVE_OUT!
  const invAAfter = await adminPool.query('SELECT paid_amount, status FROM invoice WHERE id = $1', [invAId]);
  assert.equal(Number(invAAfter.rows[0].paid_amount), 11000000);
  assert.equal(invAAfter.rows[0].status, 'PAID');

  const invBAfter = await adminPool.query('SELECT paid_amount, status FROM invoice WHERE id = $1', [invBId]);
  assert.equal(Number(invBAfter.rows[0].paid_amount), 500000);
  assert.equal(invBAfter.rows[0].status, 'PARTIALLY_PAID');

  const recAfter = await adminPool.query(
    `SELECT type, amount, paid_amount, status FROM receivable WHERE invoice_id = $1`,
    [invBId]
  );
  assert.equal(recAfter.rows.length, 1);
  assert.equal(recAfter.rows[0].type, 'RECEIVABLE_AFTER_MOVE_OUT');
  assert.equal(Number(recAfter.rows[0].amount) - Number(recAfter.rows[0].paid_amount), 5000000);

  // Khiếu nại sau khi đã chi hoàn hết (amount_held = 0) -> chặn ADJUST (409 ALREADY_PAID_OUT), cho phép CONFIRM -> PARTIALLY_REFUNDED
  const postDispute = await apiFetch(`/api/v1/deposits/${dep1.id}/dispute`, residentAuth.token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Hỏi lại sao tiền thuê T10 chưa trừ vào cọc' }),
  });
  assert.equal(postDispute.status, 200);

  const postAdjust = await apiFetch(`/api/v1/deposits/${dep1.id}/resolve-dispute`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ resolution: 'ADJUST', reason: 'Thử mở lại sau khi đã chi hoàn' }),
  });
  assert.equal(postAdjust.status, 409);
  assert.equal(postAdjust.body.code, 'ALREADY_PAID_OUT');

  const postConfirm = await apiFetch(`/api/v1/deposits/${dep1.id}/resolve-dispute`, owner.token, {
    method: 'POST',
    body: JSON.stringify({
      resolution: 'CONFIRM',
      reason: 'Theo quy định hợp đồng, tiền đặt cọc không cấn trừ vào tiền thuê phòng.',
    }),
  });
  assert.equal(postConfirm.status, 200);
  assert.equal(postConfirm.body.data.status, 'PARTIALLY_REFUNDED');

  // Xuất biên bản tất toán chuẩn A4 (GET /settlement/pdf)
  const pdfRes = await apiFetch(`/api/v1/deposits/${dep1.id}/settlement/pdf`, residentAuth.token);
  assert.equal(pdfRes.status, 200);
  assert.match(pdfRes.contentType, /text\/html/i);
  assert.match(pdfRes.body.raw, /BIÊN BẢN TẤT TOÁN/i);
  assert.match(pdfRes.body.raw, /KHÔNG trừ vào tiền cọc/i);

  // =========================================================================
  // 3. CHUYỂN PHÒNG KHÔNG KẾT CHUYỂN CỌC (transfer_deposit: false) + VƯỢT CỌC (SHORTFALL) + GIA HẠN GIẢM CỌC
  // =========================================================================
  const apt2 = await createTestApartment('DEP-A2', 8000000);
  const apt3 = await createTestApartment('DEP-A3', 9000000);
  const res2Phone = `0964${suffix}`;

  const c2Res = await apiFetch('/api/v1/contracts', manager.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: apt2.id,
      start_date: todayStr,
      end_date: isoDaysFromToday(120),
      rent_amount: 8000000,
      deposit_amount: 5000000,
      billing_day: 1,
      new_tenant: {
        full_name: `Cư Dân Shortfall ${suffix}`,
        phone: res2Phone,
        email: `dep.sf.${suffix}@resihub.test`,
        id_number: `079201${suffix}`,
        password: 'Password@123',
      },
    }),
  });
  assert.equal(c2Res.status, 201);
  const c2Id = c2Res.body.data.id;
  cleanup.contractIds.push(c2Id);
  await trackNewResident(res2Phone);

  await apiFetch(`/api/v1/contracts/${c2Id}/scan`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ image_base64: TINY_PNG_BASE64 }),
  });
  await apiFetch(`/api/v1/contracts/${c2Id}/activate`, manager.token, { method: 'POST' });

  const depList2 = await apiFetch('/api/v1/deposits', manager.token);
  const dep2 = depList2.body.data.find((d) => d.contract_id === c2Id);
  assert.ok(dep2);
  await apiFetch(`/api/v1/deposits/${dep2.id}/transactions`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'collect', amount: 5000000, method: 'CASH', description: 'Thu cọc căn A2' }),
  });

  // Chuyển phòng sang apt3 với transfer_deposit = false (4-step: DRAFT -> scan -> PENDING_APPROVAL -> OWNER approve):
  // - Sổ cọc cũ (dep2) phải có refund_due_date (+5 ngày) để tất toán độc lập
  // - Sổ cọc mới trên c3 phải được mở tự động (status = HELD, amount_held = 0)
  const transferRes = await apiFetch(`/api/v1/contracts/${c2Id}/transfer-room`, manager.token, {
    method: 'POST',
    body: JSON.stringify({
      new_apartment_id: apt3.id,
      new_start_date: todayStr,
      new_end_date: isoDaysFromToday(150),
      new_rent_amount: 9000000,
      transfer_deposit: false,
      note: 'Tách tất toán cọc căn cũ, thu mới căn mới',
    }),
  });
  assert.equal(transferRes.status, 201, `Transfer room failed: ${JSON.stringify(transferRes.body)}`);
  const c3Id = transferRes.body.data.new_contract.id;
  cleanup.contractIds.push(c3Id);
  assert.equal(transferRes.body.data.new_contract.status, 'DRAFT');

  await apiFetch(`/api/v1/contracts/${c3Id}/scan`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ image_base64: TINY_PNG_BASE64 }),
  });
  const c3Act = await apiFetch(`/api/v1/contracts/${c3Id}/activate`, manager.token, { method: 'POST', body: '{}' });
  assert.equal(c3Act.status, 409);
  assert.equal(c3Act.body.code, 'TRANSFER_NEEDS_APPROVAL');

  const c3App = await apiFetch(`/api/v1/contracts/${c3Id}/approve`, owner.token, { method: 'POST', body: '{}' });
  assert.equal(c3App.status, 200, `Approve transfer failed: ${JSON.stringify(c3App.body)}`);
  assert.ok(c3App.body.transferred_deposit?.id, 'HĐ mới phải được mở sổ cọc HELD (0 ₫) khi transfer_deposit=false');
  assert.equal(Number(c3App.body.transferred_deposit.amount_held), 0);

  const dep2Check = await adminPool.query('SELECT status, refund_due_date FROM deposit WHERE id = $1', [dep2.id]);
  assert.equal(dep2Check.rows[0].status, 'HELD');
  assert.ok(dep2Check.rows[0].refund_due_date, 'Sổ cọc phòng cũ phải có refund_due_date khi transfer_deposit=false');

  // Lập tất toán VƯỢT CỌC trên dep2: cọc 5.000.000, hư hỏng nội thất 6.500.000 => refund = 0, shortfall = 1.500.000 -> sinh RECEIVABLE_AFTER_MOVE_OUT!
  const sfSubmit = await apiFetch(`/api/v1/deposits/${dep2.id}/settlement`, manager.token, {
    method: 'POST',
    body: JSON.stringify({
      items: [
        {
          category: 'DAMAGE',
          amount: 6500000,
          description: 'Hỏng điều hòa & tủ lạnh khi bàn giao phòng cũ',
          evidence: ['https://example.com/ac-broken.png'],
        },
      ],
      inspection_evidence: ['https://example.com/handover-apt2.png'],
      refund_method: 'CASH',
    }),
  });
  assert.equal(sfSubmit.status, 200);
  assert.equal(sfSubmit.body.data.settlement.refund_amount, 0);
  assert.equal(sfSubmit.body.data.settlement.shortfall, 1500000);

  const sfApprove = await apiFetch(`/api/v1/deposits/${dep2.id}/settlement/approve`, owner.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(sfApprove.status, 200);
  assert.equal(sfApprove.body.data.status, 'DEDUCTED_FULL');

  const sfDeductSum = await adminPool.query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS total_deduct
     FROM deposit_transaction
     WHERE deposit_id = $1 AND type = 'deduct'`,
    [dep2.id]
  );
  assert.equal(Number(sfDeductSum.rows[0].total_deduct), 5000000);

  const sfReceivable = await adminPool.query(
    `SELECT amount, type, status FROM receivable WHERE deposit_id = $1`,
    [dep2.id]
  );
  assert.equal(sfReceivable.rows.length, 1);
  assert.equal(sfReceivable.rows[0].type, 'RECEIVABLE_AFTER_MOVE_OUT');
  assert.equal(Number(sfReceivable.rows[0].amount), 1500000);

  // Trên c3: Thu cọc 9.000.000 -> Gia hạn sang c4 với mức cọc giảm xuống 6.000.000 -> chuyển 6M sang c4, giữ 3M ở c3 chờ hoàn!
  const dep3Id = c3App.body.transferred_deposit.id;
  await apiFetch(`/api/v1/deposits/${dep3Id}/transactions`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ type: 'collect', amount: 9000000, method: 'BANK_TRANSFER', description: 'Thu cọc HĐ căn A3' }),
  });

  const renewRes = await apiFetch(`/api/v1/contracts/${c3Id}/renew`, manager.token, {
    method: 'POST',
    body: JSON.stringify({
      new_end_date: isoDaysFromToday(365),
      rent_amount: 9000000,
      deposit_amount: 6000000,
      note: 'Gia hạn giảm mức cọc ưu đãi khách thân thiết',
    }),
  });
  assert.equal(renewRes.status, 201);
  const c4Id = renewRes.body.data.id;
  cleanup.contractIds.push(c4Id);

  await apiFetch(`/api/v1/contracts/${c4Id}/scan`, manager.token, {
    method: 'POST',
    body: JSON.stringify({ image_base64: TINY_PNG_BASE64 }),
  });
  const act4 = await apiFetch(`/api/v1/contracts/${c4Id}/activate`, manager.token, { method: 'POST' });
  assert.equal(act4.status, 200);
  assert.equal(act4.body.remaining_collect, 0);

  const dep3After = await adminPool.query('SELECT amount_held, status, refund_due_date FROM deposit WHERE id = $1', [dep3Id]);
  assert.equal(Number(dep3After.rows[0].amount_held), 3000000, 'Phần cọc dôi dư 3M phải được giữ lại ở sổ cũ chờ hoàn');
  assert.equal(dep3After.rows[0].status, 'HELD');
  assert.ok(dep3After.rows[0].refund_due_date);

  const dep4After = await adminPool.query('SELECT amount_held, status FROM deposit WHERE contract_id = $1', [c4Id]);
  assert.equal(Number(dep4After.rows[0].amount_held), 6000000, 'Sổ cọc HĐ gia hạn nhận đúng 6M');
  assert.equal(dep4After.rows[0].status, 'HELD');
});
