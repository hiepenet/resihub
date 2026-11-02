/**
 * REMEDIATION SUITE R-01 -> R-24 (Audit Plan Verification)
 * Kiểm thử đầu-cuối các quy tắc nghiệp vụ bổ sung trong cả 3 đợt khắc phục:
 *  - R-03: Khớp đúng đặt cọc giữ chỗ (reservation) theo khách/khoảng giữ chỗ khi căn hộ có nhiều người giữ chỗ
 *  - R-04, R-11, R-16: Trả phòng giữa kỳ (ngày 10 của tháng 30 ngày) -> tính đúng 10 ngày inclusive,
 *                      kèm dịch vụ đã hủy trong kỳ & làm tròn ROUND(x, -3)
 *  - R-10: Ghi đè đơn giá ELECTRICITY / WATER theo hợp đồng (contract_service_price)
 *  - R-19: Kết chuyển cọc tự động khi kích hoạt hợp đồng gia hạn nối tiếp (parent_contract_id -> TRANSFERRED)
 *  - R-06: Điều kiện tiên quyết tất toán cọc (chặn thiếu chỉ số công tơ cuối kỳ & chặn còn hóa đơn DRAFT)
 *  - R-07: Giải quyết tranh chấp ADJUST -> mở lại SETTLEMENT_DRAFT để chỉnh sửa bảng kê
 *  - R-20: Thành viên ở cùng (contract_occupant) được quyền đọc Tòa nhà & Căn hộ đang lưu trú
 *  - R-23: Cấu hình allow_self_approval = true cho phép tự phê duyệt kèm ghi cảnh báo SELF_APPROVAL_WARNING vào audit_log
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5000';
const ADMIN_DB_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/resihub';

const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function apiFetch(path, token, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function loginEmail(email, password) {
  const res = await apiFetch('/api/v1/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken, user: res.body.user };
}

test('R-01..R-24 Specialized Business Logic Remediation Suite', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const suffix = String(Date.now()).slice(-6);

  const cleanup = {
    contractIds: [],
    apartmentIds: [],
    reservationIds: [],
    meterIds: [],
    invoiceIds: [],
    serviceSubIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
    originalApprovalCfg: null,
  };

  const vopARes = await adminPool.query(
    `SELECT b.id, b.org_id, f.id AS floor_id
     FROM building b
     JOIN floor f ON f.building_id = b.id
     WHERE b.code = 'VOP-A'
     ORDER BY f.level ASC
     LIMIT 1`
  );
  const vopAId = vopARes.rows[0].id;
  const orgId = vopARes.rows[0].org_id;
  const floorId = vopARes.rows[0].floor_id;

  const origCfgRes = await adminPool.query(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'approval_config' LIMIT 1`,
    [orgId]
  );
  cleanup.originalApprovalCfg = { allow_self_approval: false };

  t.after(async () => {
    try {
      await adminPool.query(
        `INSERT INTO system_setting (org_id, key, value, updated_at)
         VALUES ($1, 'approval_config', $2, NOW())
         ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [orgId, JSON.stringify(cleanup.originalApprovalCfg)]
      ).catch(() => {});

      for (const invId of cleanup.invoiceIds) {
        await adminPool.query('DELETE FROM receivable WHERE invoice_id = $1', [invId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice_line WHERE invoice_id = $1', [invId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE id = $1', [invId]).catch(() => {});
      }
      for (const cId of cleanup.contractIds) {
        await adminPool.query('DELETE FROM receivable WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM service_subscription WHERE contract_id = $1', [cId]).catch(() => {});
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
      for (const aId of cleanup.apartmentIds) {
        await adminPool.query('DELETE FROM meter_reading WHERE apartment_id = $1', [aId]).catch(() => {});
        await adminPool.query('DELETE FROM meter WHERE apartment_id = $1', [aId]).catch(() => {});
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
      await adminPool.end();
    }
  });

  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const ownerVop = await loginEmail('owner.vop@resihub.vn', 'Demo@123456');
  const mgrVopA = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');

  // Tạo căn hộ tạm & khách thuê tạm
  const aptRes = await apiFetch('/api/v1/apartments', sysAdmin.token, {
    method: 'POST',
    body: JSON.stringify({
      building_id: vopAId,
      floor_id: floorId,
      code: `RM-${suffix}`,
      area_m2: 60,
      bedrooms: 2,
      type: '2PN',
      base_rent: 30000000,
    }),
  });
  assert.equal(aptRes.status, 201, `Create temp apartment failed: ${JSON.stringify(aptRes.body)}`);
  const aptId = aptRes.body.data.id;
  cleanup.apartmentIds.push(aptId);

  const phoneA = `091${suffix}1`;
  const phoneB = `091${suffix}2`;
  const tenantCreate = await apiFetch('/api/v1/tenants', mgrVopA.token, {
    method: 'POST',
    body: JSON.stringify({
      full_name: `Khách A ${suffix}`,
      phone: phoneA,
      email: `tenanta.${suffix}@resihub.vn`,
      id_number: `001199${suffix}`,
      status: 'APPROVED',
      create_account: true,
      password: 'Password@123',
    }),
  });
  assert.equal(tenantCreate.status, 201, `Create tenant A failed: ${JSON.stringify(tenantCreate.body)}`);
  const tenantAId = tenantCreate.body.data.id;
  cleanup.tenantIds.push(tenantAId);
  cleanup.personIds.push(tenantCreate.body.data.person_id);
  if (tenantCreate.body.account?.user_id) cleanup.userIds.push(tenantCreate.body.account.user_id);

  const residentA = await loginEmail(`tenanta.${suffix}@resihub.vn`, 'Password@123');

  const today = new Date();
  const addDays = (d) => {
    const dt = new Date(today);
    dt.setUTCDate(dt.getUTCDate() + d);
    return dt.toISOString().slice(0, 10);
  };

  await t.test('1) [R-03, R-19, R-20] Exact Reservation Matching, Co-Resident Building/Apartment Access & Renewal Deposit Rollover', async () => {
    // 2 khách A và B giữ chỗ 2 khoảng ngày khác nhau trên cùng căn hộ
    const rsvA = await apiFetch('/api/v1/reservations', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptId,
        prospect_name: `Khách A ${suffix}`,
        phone: phoneA,
        hold_amount: 3000000,
        hold_from: addDays(1),
        hold_until: addDays(6),
      }),
    });
    assert.equal(rsvA.status, 201, `Create rsvA failed: ${JSON.stringify(rsvA.body)}`);
    cleanup.reservationIds.push(rsvA.body.data.id);

    const rsvB = await apiFetch('/api/v1/reservations', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptId,
        prospect_name: `Khách B ${suffix}`,
        phone: phoneB,
        hold_amount: 4500000,
        hold_from: addDays(10),
        hold_until: addDays(15),
      }),
    });
    assert.equal(rsvB.status, 201, `Create rsvB failed: ${JSON.stringify(rsvB.body)}`);
    cleanup.reservationIds.push(rsvB.body.data.id);

    // Tạo HĐ cho Khách A (không cần truyền reservation_id — tự khớp theo SĐT của Khách A, KHÔNG nuốt cọc của Khách B!)
    const ctrCreate = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptId,
        primary_tenant_id: tenantAId,
        start_date: addDays(1),
        end_date: addDays(8),
        rent_amount: 30000000,
        deposit_amount: 10000000,
      }),
    });
    assert.equal(ctrCreate.status, 201, `Create contract A failed: ${JSON.stringify(ctrCreate.body)}`);
    const ctrAId = ctrCreate.body.data.id;
    cleanup.contractIds.push(ctrAId);

    const scanUp = await apiFetch(`/api/v1/contracts/${ctrAId}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_BASE64 }),
    });
    assert.equal(scanUp.status, 201);

    const actA = await apiFetch(`/api/v1/contracts/${ctrAId}/activate`, mgrVopA.token, { method: 'POST' });
    assert.equal(actA.status, 200, `Activate contract A failed: ${JSON.stringify(actA.body)}`);

    const rsvACheck = await adminPool.query('SELECT status FROM reservation WHERE id = $1', [rsvA.body.data.id]);
    const rsvBCheck = await adminPool.query('SELECT status FROM reservation WHERE id = $1', [rsvB.body.data.id]);
    assert.equal(rsvACheck.rows[0].status, 'CONVERTED', 'R-03: Phải chuyển đúng đặt cọc giữ chỗ của Khách A');
    assert.equal(rsvBCheck.rows[0].status, 'HELD', 'R-03: Tuyệt đối KHÔNG được chiếm đoạt đặt cọc giữ chỗ của Khách B');

    // R-14: OWNER duyệt hoàn tiền giữ chỗ của Khách B (APPROVED_PENDING_PAYOUT) để giải phóng lịch cho gia hạn nối tiếp
    const refundRsvB = await apiFetch(`/api/v1/reservations/${rsvB.body.data.id}/refund`, ownerVop.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Hoàn cọc giữ chỗ cho Khách B theo thỏa thuận' }),
    });
    assert.equal(refundRsvB.status, 200, `R-14: OWNER refund reservation failed: ${JSON.stringify(refundRsvB.body)}`);
    assert.equal(refundRsvB.body.data.status, 'APPROVED_PENDING_PAYOUT');

    // R-20: Thêm thành viên ở cùng có tài khoản Cổng cư dân -> kiểm tra đọc được Tòa nhà & Căn hộ
    const occPhone = `092${suffix}3`;
    const occEmail = `occ.${suffix}@resihub.vn`;
    const occAdd = await apiFetch(`/api/v1/contracts/${ctrAId}/occupants`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: `Người Ở Cùng ${suffix}`,
        phone: occPhone,
        email: occEmail,
        relationship: 'Anh/Chị/Em',
      }),
    });
    assert.equal(occAdd.status, 201);
    const occPersonId = occAdd.body.data.person_id;
    cleanup.personIds.push(occPersonId);
    if (occAdd.body.data.tenant_id) cleanup.tenantIds.push(occAdd.body.data.tenant_id);

    // Cấp tài khoản RESIDENT cho người ở cùng
    const occUserCreate = await apiFetch('/api/v1/admin/users', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: `Người Ở Cùng ${suffix}`,
        email: occEmail,
        phone: occPhone,
        password: 'Password@123',
        roles: [{ role_code: 'RESIDENT', building_id: null }],
      }),
    });
    if (occUserCreate.status === 201) {
      cleanup.userIds.push(occUserCreate.body.data.id);
      const occLogin = await loginEmail(occEmail, 'Password@123');
      const occBldgs = await apiFetch('/api/v1/buildings', occLogin.token);
      assert.equal(occBldgs.status, 200);
      assert.ok((occBldgs.body.data || []).some((b) => b.id === vopAId), 'R-20: Thành viên ở cùng phải đọc được tòa nhà đang ở');

      const occApts = await apiFetch('/api/v1/apartments', occLogin.token);
      assert.equal(occApts.status, 200);
      assert.ok((occApts.body.data || []).some((a) => a.id === aptId), 'R-20: Thành viên ở cùng phải đọc được căn hộ đang ở');
    }

    // R-19: Gia hạn nối tiếp (POST /:id/renew) -> kích hoạt HĐ mới -> tự động kết chuyển 3.000.000 ₫ cọc từ HĐ cha sang HĐ con (TRANSFERRED)
    const renewRes = await apiFetch(`/api/v1/contracts/${ctrAId}/renew`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        new_end_date: addDays(40),
        rent_amount: 30000000,
        deposit_amount: 10000000,
      }),
    });
    assert.equal(renewRes.status, 201, `Renew failed: ${JSON.stringify(renewRes.body)}`);
    const childCtrId = renewRes.body.data.id;
    cleanup.contractIds.push(childCtrId);

    await apiFetch(`/api/v1/contracts/${childCtrId}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_BASE64 }),
    });
    const actChild = await apiFetch(`/api/v1/contracts/${childCtrId}/activate`, mgrVopA.token, { method: 'POST' });
    assert.equal(actChild.status, 200, `Activate renewed contract failed: ${JSON.stringify(actChild.body)}`);
    assert.equal(actChild.body.remaining_collect, 7000000, 'R-19: Cọc yêu cầu 10tr - kết chuyển 3tr = cần thu thêm 7tr');

    const parentDepRow = await adminPool.query('SELECT status, amount_held FROM deposit WHERE contract_id = $1', [ctrAId]);
    const childDepRow = await adminPool.query('SELECT status, amount_held FROM deposit WHERE contract_id = $1', [childCtrId]);
    assert.equal(parentDepRow.rows[0].status, 'TRANSFERRED', 'R-19: Sổ cọc HĐ cũ phải chuyển sang TRANSFERRED');
    assert.equal(Number(parentDepRow.rows[0].amount_held), 0);
    assert.equal(childDepRow.rows[0].status, 'HELD');
    assert.equal(Number(childDepRow.rows[0].amount_held), 3000000, 'R-19: Sổ cọc HĐ gia hạn phải nhận đúng 3.000.000 ₫ kết chuyển');

    // Đóng cả 2 HĐ này trước khi sang kịch bản tiếp theo trên căn hộ
    await adminPool.query("UPDATE contract SET status = 'TERMINATED', terminated_at = start_date WHERE id = ANY($1::uuid[])", [
      [ctrAId, childCtrId],
    ]);
    await adminPool.query("UPDATE apartment SET status = 'AVAILABLE' WHERE id = $1", [aptId]);
  });

  await t.test('2) [R-04, R-10, R-11, R-16] 10-Day Inclusive Move-Out Pro-Rata, Cancelled Subscription Billing & ELECTRICITY Contract Price Override', async () => {
    // Mở HĐ tháng 04/2028 (30 ngày: 2028-04-01 -> 2028-04-30), giá thuê 30.000.000 ₫/tháng
    const ctrIns = await adminPool.query(
      `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, deposit_amount, status)
       VALUES ($1, $2, $3, '2028-04-01', '2028-04-30', 30000000, 1, 10000000, 'ACTIVE')
       RETURNING id`,
      [vopAId, aptId, tenantAId]
    );
    const aprCtrId = ctrIns.rows[0].id;
    cleanup.contractIds.push(aprCtrId);

    const depIns = await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status) VALUES ($1, 10000000, 'HELD') RETURNING id`,
      [aprCtrId]
    );
    const aprDepId = depIns.rows[0].id;

    // R-10: Ghi đè đơn giá ELECTRICITY theo hợp đồng = 4.500 ₫/kWh (trong khi đồng hồ mặc định 3.800 ₫/kWh)
    const setElPrice = await apiFetch(`/api/v1/contracts/${aprCtrId}/service-prices`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        service_code: 'ELECTRICITY',
        unit_price: 4500,
        effective_from: '2028-04-01',
      }),
    });
    assert.equal(setElPrice.status, 200, `Override ELECTRICITY contract price failed: ${JSON.stringify(setElPrice.body)}`);

    // Tạo đồng hồ điện & ghi 100 kWh cho kỳ 2028-04 -> tiền điện phải là 100 * 4.500 = 450.000 ₫
    const meterRes = await apiFetch('/api/v1/meters', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptId,
        meter_type: 'ELECTRICITY',
        unit_price: 3800,
        initial_reading: 500,
      }),
    });
    assert.equal(meterRes.status, 201);
    const elMeterId = meterRes.body.data.id;
    cleanup.meterIds.push(elMeterId);

    // R-06 Pre-condition 1: Chấm dứt HĐ vào ngày 2028-04-10 khi CHƯA ghi công tơ kỳ 2028-04 -> chặn tất toán 409 MISSING_FINAL_METER_READING
    await adminPool.query(
      `UPDATE contract SET status = 'TERMINATED', terminated_at = '2028-04-10' WHERE id = $1`,
      [aprCtrId]
    );
    // Đảm bảo meter.created_at <= 2028-04-10 (vì ngày hiện tại là 2026 < 2028 nên thỏa mãn tự nhiên)
    const blockedNoMeter = await apiFetch(`/api/v1/deposits/${aprDepId}/settlement`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(blockedNoMeter.status, 409, 'R-06: Phải chặn tất toán khi chưa ghi chỉ số công tơ kỳ cuối');
    assert.equal(blockedNoMeter.body.code, 'MISSING_FINAL_METER_READING');

    // Ghi chỉ số công tơ kỳ 2028-04 (+100 kWh)
    const recReading = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-04', current_reading: 600 }),
    });
    assert.equal(recReading.status, 201);

    // Tạo 1 đăng ký dịch vụ đã CANCELLED vào ngày 2028-04-10 (10/30 ngày của gói 300.000 ₫ = 100.000 ₫)
    const catRes = await adminPool.query(
      "SELECT id FROM service_catalog WHERE org_id = $1 AND billing_type != 'METERED' LIMIT 1",
      [orgId]
    );
    await adminPool.query(
      `INSERT INTO service_subscription (org_id, building_id, apartment_id, contract_id, service_id, quantity, unit_price, prorata_amount, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, 1, 300000, 100000, '2028-04-01', '2028-04-10', 'TERMINATED')`,
      [orgId, vopAId, aptId, aprCtrId, catRes.rows[0].id]
    );

    // Sinh hóa đơn kỳ 2028-04 cho HĐ vừa TERMINATED trong kỳ (R-04, R-10, R-11, R-16)
    const genFinal = await apiFetch('/api/v1/invoices/generate-batch', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ building_id: vopAId, period: '2028-04', auto_issue: false }),
    });
    assert.equal(genFinal.status, 201);
    for (const inv of genFinal.body.data || []) cleanup.invoiceIds.push(inv.id);

    const finalInv = (genFinal.body.data || []).find((i) => i.contract_id === aprCtrId);
    assert.ok(finalInv, 'R-04: Phải sinh được hóa đơn kỳ cuối cho hợp đồng đã TERMINATED trong kỳ');

    const invDet = await apiFetch(`/api/v1/invoices/${finalInv.id}`, mgrVopA.token);
    const lines = invDet.body.data.lines;
    const rentLine = lines.find((l) => l.item_type === 'RENT');
    const elLine = lines.find((l) => l.item_type === 'ELECTRICITY');
    const svcLine = lines.find((l) => l.item_type === 'SERVICE');

    assert.equal(Number(rentLine?.amount), 10000000, 'R-16: Trả phòng ngày 10 tháng 30 ngày phải tính tròn 10 ngày = 10.000.000 ₫');
    assert.equal(Number(elLine?.amount), 450000, 'R-10: Tiền điện phải áp dụng đơn giá hợp đồng 4.500 * 100 = 450.000 ₫');
    assert.equal(Number(svcLine?.amount), 100000, 'R-04: Phải thu phí pro-rata của dịch vụ đã hủy giữa kỳ');

    // R-06 Pre-condition 2: Khi hóa đơn kỳ cuối vẫn đang ở trạng thái DRAFT -> chặn tất toán 409 UNPUBLISHED_INVOICE
    const blockedDraftInv = await apiFetch(`/api/v1/deposits/${aprDepId}/settlement`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(blockedDraftInv.status, 409, 'R-06: Phải chặn tất toán khi còn hóa đơn DRAFT');
    assert.equal(blockedDraftInv.body.code, 'UNPUBLISHED_INVOICE');

    // Phát hành hóa đơn kỳ cuối -> đủ điều kiện lập tất toán -> kiểm thử R-07 ADJUST + R-23 allow_self_approval = true
    await apiFetch(`/api/v1/invoices/${finalInv.id}/status`, mgrVopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ISSUED' }),
    });

    const subSettle1 = await apiFetch(`/api/v1/deposits/${aprDepId}/settlement`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ items: [], inspection_evidence: [TINY_PNG_BASE64], refund_method: 'CASH' }),
    });
    assert.equal(subSettle1.status, 200);
    // Nợ dịch vụ + điện = 450.000 + 100.000 = 550.000 ₫; Nợ thuê = 10.000.000 ₫ (KHÔNG trừ vào cọc 10.000.000 ₫!) -> Hoàn cọc = 9.450.000 ₫!
    assert.equal(subSettle1.body.data.settlement.outstanding_debt, 550000, 'R-06: Chỉ đối trừ 550.000 ₫ điện + dịch vụ vào cọc');
    assert.equal(subSettle1.body.data.settlement.rent_debt, 10000000, 'R-06: 10.000.000 ₫ tiền thuê tách riêng');
    assert.equal(subSettle1.body.data.settlement.refund_amount, 9450000, 'R-06: Cọc 10tr - 550k dịch vụ = hoàn 9.450.000 ₫');

    // R-07: Cư dân khiếu nại -> Quản lý giải quyết ADJUST -> mở lại SETTLEMENT_DRAFT -> nộp lại
    const disp1 = await apiFetch(`/api/v1/deposits/${aprDepId}/dispute`, residentA.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Xin kiểm tra lại phí dịch vụ tháng 4' }),
    });
    assert.equal(disp1.status, 200);

    const resolveAdjust = await apiFetch(`/api/v1/deposits/${aprDepId}/resolve-dispute`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ resolution: 'ADJUST', reason: 'Mở lại bảng kê để bổ sung ghi chú chi tiết' }),
    });
    assert.equal(resolveAdjust.status, 200);
    assert.equal(resolveAdjust.body.data.status, 'SETTLEMENT_DRAFT', 'R-07: Giải quyết ADJUST phải trả về SETTLEMENT_DRAFT');

    const subSettle2 = await apiFetch(`/api/v1/deposits/${aprDepId}/settlement`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ items: [], inspection_evidence: [TINY_PNG_BASE64], refund_method: 'CASH' }),
    });
    assert.equal(subSettle2.status, 200);

    // R-23: Bật allow_self_approval = true -> cho phép mgrVopA tự phê duyệt kèm ghi cảnh báo SELF_APPROVAL_WARNING vào audit_log
    const enableSelf = await apiFetch('/api/v1/settings', sysAdmin.token, {
      method: 'PUT',
      body: JSON.stringify({ approval_config: { allow_self_approval: true } }),
    });
    assert.equal(enableSelf.status, 200);

    const selfAppAllowed = await apiFetch(`/api/v1/deposits/${aprDepId}/settlement/approve`, mgrVopA.token, {
      method: 'POST',
    });
    assert.equal(selfAppAllowed.status, 200, `Self-approval with allow_self_approval=true failed: ${JSON.stringify(selfAppAllowed.body)}`);
    assert.equal(selfAppAllowed.body.data.status, 'APPROVED_PENDING_PAYOUT');

    const warnAudit = await adminPool.query(
      `SELECT * FROM audit_log WHERE entity = 'deposit' AND entity_id = $1 AND action = 'SELF_APPROVAL_WARNING'`,
      [aprDepId]
    );
    assert.equal(warnAudit.rows.length, 1, 'R-23: Tự phê duyệt khi allow_self_approval=true bắt buộc ghi SELF_APPROVAL_WARNING');

    // Khôi phục allow_self_approval = false ngay lập tức
    await apiFetch('/api/v1/settings', sysAdmin.token, {
      method: 'PUT',
      body: JSON.stringify({ approval_config: { allow_self_approval: false } }),
    });
  });
});

