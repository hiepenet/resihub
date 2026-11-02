import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
}
if (!process.env.APP_DATABASE_URL) {
  process.env.APP_DATABASE_URL =
    'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';
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

test('M06 Migration 047 — Room-Transfer Unique Index, Reservation Approval/Payout RLS & SECURITY DEFINER RPCs', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');

  async function withRlsCommit(userId, fn) {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(userId)]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const suffix = `${String(Date.now()).slice(-6)}`;
  const cleanup = {
    reservationIds: [],
    contractIds: [],
    apartmentIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
  };

  t.after(async () => {
    for (const rId of cleanup.reservationIds) {
      await adminPool.query('DELETE FROM notification WHERE payload::text LIKE $1', [`%${rId}%`]).catch(() => {});
      await adminPool.query('DELETE FROM reservation WHERE id = $1', [rId]).catch(() => {});
    }
    for (const cId of [...cleanup.contractIds].reverse()) {
      await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
    }
    for (const tId of cleanup.tenantIds) {
      await adminPool.query('DELETE FROM tenant WHERE id = $1', [tId]).catch(() => {});
    }
    for (const uId of cleanup.userIds) {
      await adminPool.query('DELETE FROM notification WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM app_user WHERE id = $1', [uId]).catch(() => {});
    }
    for (const pId of cleanup.personIds) {
      await adminPool.query('DELETE FROM person WHERE id = $1', [pId]).catch(() => {});
    }
    await appPool.end().catch(() => {});
    await adminPool.end().catch(() => {});
  });

  const bRes = await adminPool.query(
    `SELECT b.id, b.org_id, f.id AS floor_id
     FROM building b
     JOIN floor f ON f.building_id = b.id
     WHERE b.code = 'VOP-A'
     ORDER BY f.level ASC
     LIMIT 1`
  );
  const vopAId = bRes.rows[0].id;
  const orgId = bRes.rows[0].org_id;
  const floorId = bRes.rows[0].floor_id;

  const ownerRow = await adminPool.query(
    `SELECT au.id FROM app_user au JOIN person p ON p.id = au.person_id WHERE p.email = 'owner.vop@resihub.vn'`
  );
  const ownerId = ownerRow.rows[0].id;

  const mgrRow = await adminPool.query(
    `SELECT au.id FROM app_user au JOIN person p ON p.id = au.person_id WHERE p.email = 'manager.vop.a@resihub.vn'`
  );
  const mgrId = mgrRow.rows[0].id;

  const resRoleRes = await adminPool.query(
    `SELECT id FROM role WHERE org_id = $1 AND code = 'RESIDENT' LIMIT 1`,
    [orgId]
  );
  const residentRoleId = resRoleRes.rows[0].id;
  const pwHash = await bcrypt.hash('Demo@123456', 4);

  async function createTestResident(phoneSuffix) {
    const phone = `0961${phoneSuffix}`;
    const pIns = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [orgId, `Khach M047 ${phoneSuffix}`, phone, `m047.${phoneSuffix}@resihub.test`, `079047${phoneSuffix}`]
    );
    cleanup.personIds.push(pIns.rows[0].id);
    const uIns = await adminPool.query(
      `INSERT INTO app_user (person_id, password_hash, status)
       VALUES ($1, $2, 'ACTIVE')
       RETURNING id`,
      [pIns.rows[0].id, pwHash]
    );
    cleanup.userIds.push(uIns.rows[0].id);
    await adminPool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [
      uIns.rows[0].id,
      residentRoleId,
    ]);
    const tIns = await adminPool.query(
      `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
      [orgId, pIns.rows[0].id]
    );
    cleanup.tenantIds.push(tIns.rows[0].id);
    return { userId: uIns.rows[0].id, tenantId: tIns.rows[0].id, phone };
  }

  const resMatch = await createTestResident(`${suffix.slice(-5)}1`);
  const resOther = await createTestResident(`${suffix.slice(-5)}2`);

  const apt1Ins = await adminPool.query(
    `INSERT INTO apartment (building_id, floor_id, code, area_m2, bedrooms, base_rent, status)
     VALUES ($1, $2, $3, 45, 1, 9000000, 'OCCUPIED')
     RETURNING id`,
    [vopAId, floorId, `M47-A1-${suffix}`]
  );
  const apt1Id = apt1Ins.rows[0].id;
  cleanup.apartmentIds.push(apt1Id);

  const apt2Ins = await adminPool.query(
    `INSERT INTO apartment (building_id, floor_id, code, area_m2, bedrooms, base_rent, status)
     VALUES ($1, $2, $3, 50, 1, 10000000, 'AVAILABLE')
     RETURNING id`,
    [vopAId, floorId, `M47-A2-${suffix}`]
  );
  const apt2Id = apt2Ins.rows[0].id;
  cleanup.apartmentIds.push(apt2Id);

  const apt3Ins = await adminPool.query(
    `INSERT INTO apartment (building_id, floor_id, code, area_m2, bedrooms, base_rent, status)
     VALUES ($1, $2, $3, 55, 2, 11000000, 'RESERVED')
     RETURNING id`,
    [vopAId, floorId, `M47-A3-${suffix}`]
  );
  const apt3Id = apt3Ins.rows[0].id;
  cleanup.apartmentIds.push(apt3Id);

  await t.test('1. uq_contract_open_room_transfer blocks duplicate open room-transfer drafts on same parent', async () => {
    const parentIns = await adminPool.query(
      `INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, deposit_amount, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 9000000, 1, 9000000, 'ACTIVE', $6)
       RETURNING id`,
      [apt1Id, vopAId, resMatch.tenantId, isoDaysFromToday(-10), isoDaysFromToday(180), mgrId]
    );
    const parentId = parentIns.rows[0].id;
    cleanup.contractIds.push(parentId);

    const tr1 = await adminPool.query(
      `INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, deposit_amount, status, parent_contract_id, is_room_transfer, transfer_deposit, created_by)
       VALUES ($1, $2, $3, $4, $5, 10000000, 1, 10000000, 'DRAFT', $6, TRUE, TRUE, $7)
       RETURNING id`,
      [apt2Id, vopAId, resMatch.tenantId, isoDaysFromToday(1), isoDaysFromToday(180), parentId, mgrId]
    );
    cleanup.contractIds.push(tr1.rows[0].id);

    await assert.rejects(
      () =>
        adminPool.query(
          `INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, deposit_amount, status, parent_contract_id, is_room_transfer, transfer_deposit, created_by)
           VALUES ($1, $2, $3, $4, $5, 10000000, 1, 10000000, 'DRAFT', $6, TRUE, FALSE, $7)`,
          [apt2Id, vopAId, resMatch.tenantId, isoDaysFromToday(2), isoDaysFromToday(180), parentId, mgrId]
        ),
      (err) => err.code === '23505'
    );

    await adminPool.query(`UPDATE contract SET status = 'CANCELLED' WHERE id = $1`, [tr1.rows[0].id]);

    const tr2 = await adminPool.query(
      `INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, deposit_amount, status, parent_contract_id, is_room_transfer, transfer_deposit, created_by)
       VALUES ($1, $2, $3, $4, $5, 10000000, 1, 10000000, 'DRAFT', $6, TRUE, FALSE, $7)
       RETURNING id`,
      [apt2Id, vopAId, resMatch.tenantId, isoDaysFromToday(2), isoDaysFromToday(180), parentId, mgrId]
    );
    cleanup.contractIds.push(tr2.rows[0].id);
    assert.ok(tr2.rows[0].id);
  });

  await t.test('2 & 3 & 4. Reservation RLS blocks OWNER from direct REFUNDED/PARTIALLY_REFUNDED, syncs apartment on APPROVED_PENDING_PAYOUT, and enforces fn_update_reservation_refund_bank_info', async () => {
    const rsvIns = await adminPool.query(
      `INSERT INTO reservation (org_id, building_id, apartment_id, prospect_name, phone, hold_amount, hold_from, hold_until, status, created_by, refunded_amount, forfeited_amount, refund_method, cancel_settlement)
       VALUES ($1, $2, $3, 'Khach Giu Cho', $4, 2000000, $5, $6, 'CANCEL_PENDING_APPROVAL', $7, 1200000, 800000, 'BANK_TRANSFER', $8::jsonb)
       RETURNING id`,
      [
        orgId,
        vopAId,
        apt3Id,
        resMatch.phone,
        isoDaysFromToday(0),
        isoDaysFromToday(5),
        mgrId,
        JSON.stringify({ proposed_by: mgrId }),
      ]
    );
    const rsvId = rsvIns.rows[0].id;
    cleanup.reservationIds.push(rsvId);

    // While CANCEL_PENDING_APPROVAL, apartment stays RESERVED
    const syncWhilePending = await withRlsCommit(mgrId, (c) =>
      c.query(`SELECT fn_sync_apartment_status_after_reservation($1) AS st`, [apt3Id])
    );
    assert.equal(syncWhilePending.rows[0].st, 'RESERVED');

    // OWNER attempting to bypass payout and jump straight to PARTIALLY_REFUNDED or REFUNDED must fail RLS WITH CHECK
    await assert.rejects(
      () =>
        withRlsCommit(ownerId, (c) =>
          c.query(`UPDATE reservation SET status = 'PARTIALLY_REFUNDED' WHERE id = $1`, [rsvId])
        ),
      (err) => err.code === '42501'
    );
    await assert.rejects(
      () =>
        withRlsCommit(ownerId, (c) =>
          c.query(`UPDATE reservation SET status = 'REFUNDED' WHERE id = $1`, [rsvId])
        ),
      (err) => err.code === '42501'
    );

    // Wrong status: RESIDENT cannot update bank info while still CANCEL_PENDING_APPROVAL
    await assert.rejects(
      () =>
        withRlsCommit(resMatch.userId, (c) =>
          c.query(`SELECT * FROM fn_update_reservation_refund_bank_info($1, $2::jsonb)`, [
            rsvId,
            JSON.stringify({
              bank_name: 'VCB',
              account_number: '123456789',
              account_holder: 'KHACH GIU CHO',
            }),
          ])
        )
    );

    // OWNER approves cancellation -> APPROVED_PENDING_PAYOUT succeeds & releases apartment to AVAILABLE
    const ownerApprove = await withRlsCommit(ownerId, async (c) => {
      const u = await c.query(
        `UPDATE reservation SET status = 'APPROVED_PENDING_PAYOUT' WHERE id = $1 RETURNING status`,
        [rsvId]
      );
      const s = await c.query(`SELECT fn_sync_apartment_status_after_reservation($1) AS st`, [
        apt3Id,
      ]);
      await c.query(
        `SELECT fn_notify_reservation_staff($1, 'BUILDING_MANAGERS', 'RESERVATION_CANCEL_APPROVED_FOR_PAYOUT', 'Duyệt hủy giữ chỗ', 'Vui lòng chi hoàn và tải UNC')`,
        [rsvId]
      );
      return { status: u.rows[0]?.status, aptStatus: s.rows[0]?.st };
    });
    assert.equal(ownerApprove.status, 'APPROVED_PENDING_PAYOUT');
    assert.equal(ownerApprove.aptStatus, 'AVAILABLE');

    // Unrelated RESIDENT cannot update bank info -> 42501
    await assert.rejects(
      () =>
        withRlsCommit(resOther.userId, (c) =>
          c.query(`SELECT * FROM fn_update_reservation_refund_bank_info($1, $2::jsonb)`, [
            rsvId,
            JSON.stringify({
              bank_name: 'VCB',
              account_number: '999999999',
              account_holder: 'KE GIAN',
            }),
          ])
        ),
      (err) => err.code === '42501'
    );

    // Matching-phone RESIDENT updates bank info via SECURITY DEFINER RPC -> succeeds
    const rpcUpdate = await withRlsCommit(resMatch.userId, (c) =>
      c.query(`SELECT * FROM fn_update_reservation_refund_bank_info($1, $2::jsonb)`, [
        rsvId,
        JSON.stringify({
          bank_name: 'Techcombank',
          bank_code: 'TCB',
          bank_logo: 'https://api.vietqr.io/img/TCB.png',
          account_number: '1903888999',
          account_holder: 'KHACH GIU CHO',
        }),
      ])
    );
    assert.equal(rpcUpdate.rows[0].refund_bank_info.account_number, '1903888999');
    assert.equal(rpcUpdate.rows[0].refund_bank_info.bank_logo, 'https://api.vietqr.io/img/TCB.png');
  });
});
