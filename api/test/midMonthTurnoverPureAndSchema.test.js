import { test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';

dotenv.config();

const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

test('Task 1: Pure Turnover Chaining Helpers & Migration 052 Schema + RLS Isolation', async (t) => {
  const billingMod = await import('../src/services/serviceBilling.js');
  const {
    FINALIZED_SETTLEMENT_DEPOSIT_STATUSES,
    roundReadingValue,
    buildPeriodOverlappingContracts,
    selectTargetPeriodContract,
    resolveChainedReadingBounds,
    validateChainedReadingInput,
  } = billingMod;

  await t.test('1. Pure helpers: excludes non-billable/pre-move-in contracts, handles 3-contract turnover & room-transfer TRANSFERRED deposit', () => {
    assert.equal(typeof roundReadingValue, 'function', 'roundReadingValue must be exported');
    assert.equal(typeof buildPeriodOverlappingContracts, 'function', 'buildPeriodOverlappingContracts must be exported');
    assert.equal(typeof selectTargetPeriodContract, 'function', 'selectTargetPeriodContract must be exported');
    assert.ok(Array.isArray(FINALIZED_SETTLEMENT_DEPOSIT_STATUSES));
    assert.equal(FINALIZED_SETTLEMENT_DEPOSIT_STATUSES.includes('TRANSFERRED'), false);
    assert.equal(FINALIZED_SETTLEMENT_DEPOSIT_STATUSES.includes('HELD'), false);

    const rawContracts = [
      // Pre-move-in cancelled contract -> must be excluded
      {
        id: 'c-pre-cancel',
        code: 'HD-PRE',
        status: 'TERMINATED',
        start_date: '2026-12-05',
        end_date: '2027-12-05',
        terminated_at: '2026-12-03',
        apartment_id: 'apt-1',
        building_id: 'bld-1',
      },
      // Non-active statuses -> must be excluded
      {
        id: 'c-draft',
        code: 'HD-DRAFT',
        status: 'DRAFT',
        start_date: '2026-12-01',
        end_date: '2027-12-01',
        apartment_id: 'apt-1',
        building_id: 'bld-1',
      },
      {
        id: 'c-cancelled',
        code: 'HD-CAN',
        status: 'CANCELLED',
        start_date: '2026-12-01',
        end_date: '2027-12-01',
        apartment_id: 'apt-1',
        building_id: 'bld-1',
      },
      // Slot 1: Room-transfer parent contract (01/12..08/12) with TRANSFERRED deposit, NOT yet invoiced
      {
        id: 'c-1',
        code: 'HD-001',
        tenant_name: 'Nguyen Van A',
        status: 'TERMINATED',
        start_date: '2026-11-01',
        end_date: '2027-11-01',
        terminated_at: '2026-12-09',
        room_transfer_child_start_date: '2026-12-09',
        deposit_status: 'TRANSFERRED',
        has_finalized_invoice: false,
        apartment_id: 'apt-1',
        building_id: 'bld-1',
      },
      // Slot 2: Mid-month short stay (10/12..18/12)
      {
        id: 'c-2',
        code: 'HD-002',
        tenant_name: 'Tran Thi B',
        status: 'TERMINATED',
        start_date: '2026-12-10',
        end_date: '2027-06-10',
        terminated_at: '2026-12-18',
        deposit_status: 'HELD',
        has_finalized_invoice: false,
        apartment_id: 'apt-1',
        building_id: 'bld-1',
      },
      // Slot 3: Incoming active tenant (20/12..31/12)
      {
        id: 'c-3',
        code: 'HD-003',
        tenant_name: 'Le Van C',
        status: 'ACTIVE',
        start_date: '2026-12-20',
        end_date: '2027-12-20',
        deposit_status: 'HELD',
        has_finalized_invoice: false,
        apartment_id: 'apt-1',
        building_id: 'bld-1',
      },
    ];

    const list1 = buildPeriodOverlappingContracts(rawContracts, '2026-12');
    assert.deepEqual(
      list1.map((c) => c.contract_id),
      ['c-1', 'c-2', 'c-3'],
      'Only the 3 billable overlapping contracts should be included in chronological order'
    );
    assert.equal(list1[0].overlap_start, '2026-12-01');
    assert.equal(list1[0].overlap_end, '2026-12-08');
    assert.equal(list1[0].is_period_finalized, false, 'TRANSFERRED deposit must NOT mark c-1 finalized before invoice issue');

    // Auto-select starts at Slot 1/3
    const sel1 = selectTargetPeriodContract(list1);
    assert.equal(sel1.targetContract.contract_id, 'c-1');
    assert.equal(sel1.slotIndex, 1);
    assert.equal(sel1.totalSlots, 3);

    // Once c-1 issues invoice -> advances to Slot 2/3
    rawContracts.find((c) => c.id === 'c-1').has_finalized_invoice = true;
    const list2 = buildPeriodOverlappingContracts(rawContracts, '2026-12');
    const sel2 = selectTargetPeriodContract(list2);
    assert.equal(sel2.targetContract.contract_id, 'c-2');
    assert.equal(sel2.slotIndex, 2);
    assert.equal(sel2.totalSlots, 3);

    // Once c-2 enters deposit settlement (PENDING_APPROVAL) -> advances to Slot 3/3
    rawContracts.find((c) => c.id === 'c-2').deposit_status = 'PENDING_APPROVAL';
    const list3 = buildPeriodOverlappingContracts(rawContracts, '2026-12');
    const sel3 = selectTargetPeriodContract(list3);
    assert.equal(sel3.targetContract.contract_id, 'c-3');
    assert.equal(sel3.slotIndex, 3);
    assert.equal(sel3.totalSlots, 3);

    // Once c-3 also issues invoice -> all finalized, stays on last contract (Slot 3/3)
    rawContracts.find((c) => c.id === 'c-3').has_finalized_invoice = true;
    const list4 = buildPeriodOverlappingContracts(rawContracts, '2026-12');
    const sel4 = selectTargetPeriodContract(list4);
    assert.equal(sel4.targetContract.contract_id, 'c-3');
    assert.equal(sel4.slotIndex, 3);

    // Explicit valid contract_id override
    const selExplicit = selectTargetPeriodContract(list4, 'c-1');
    assert.equal(selExplicit.targetContract.contract_id, 'c-1');
    assert.equal(selExplicit.slotIndex, 1);

    // Invalid contract_id override -> 400 VALIDATION_ERROR
    assert.throws(
      () => selectTargetPeriodContract(list4, '00000000-0000-0000-0000-000000000999'),
      (err) => err.status === 400 && err.code === 'VALIDATION_ERROR'
    );
  });

  await t.test('2. Pure helpers: 2-decimal precision chaining & monotonic/billed nextReading guards', () => {
    assert.equal(typeof resolveChainedReadingBounds, 'function');
    assert.equal(typeof validateChainedReadingInput, 'function');

    const overlappingContracts = [
      { contract_id: 'c-a', overlap_start: '2026-12-01' },
      { contract_id: 'c-b', overlap_start: '2026-12-20' },
    ];
    const priorPeriodReading = { id: 'r-nov', period: '2026-11', current_reading: 1000.25 };

    // Slot 1 bounds (before Slot 2 recorded)
    const boundsA = resolveChainedReadingBounds({
      priorPeriodReading,
      samePeriodReadings: [],
      nextPeriodReading: null,
      overlappingContracts,
      targetContractId: 'c-a',
      existingReadingId: null,
      initialReading: 0,
    });
    assert.equal(boundsA.previousReading, 1000.25);
    assert.equal(boundsA.nextReading, null);

    const valA = validateChainedReadingInput({
      currentReading: 1015.75,
      previousReading: boundsA.previousReading,
      nextReading: boundsA.nextReading,
    });
    assert.equal(valA.currentVal, 1015.75);
    assert.equal(valA.consumption, 15.5);

    // Slot 2 bounds chain from Slot 1 (1015.75 -> 1040.50 = 24.75)
    const rA = {
      id: 'r-dec-a',
      period: '2026-12',
      contract_id: 'c-a',
      previous_reading: 1000.25,
      current_reading: 1015.75,
      is_billed: true,
    };
    const boundsB = resolveChainedReadingBounds({
      priorPeriodReading,
      samePeriodReadings: [rA],
      nextPeriodReading: null,
      overlappingContracts,
      targetContractId: 'c-b',
      existingReadingId: null,
      initialReading: 0,
    });
    assert.equal(boundsB.previousReading, 1015.75);
    const valB = validateChainedReadingInput({
      currentReading: 1040.5,
      previousReading: boundsB.previousReading,
      nextReading: boundsB.nextReading,
    });
    assert.equal(valB.currentVal, 1040.5);
    assert.equal(valB.consumption, 24.75);

    // Editing unbilled Slot 1 when Slot 2 is unlocked vs billed
    const rBUnlocked = {
      id: 'r-dec-b',
      period: '2026-12',
      contract_id: 'c-b',
      previous_reading: 1015.75,
      current_reading: 1040.5,
      is_billed: false,
    };
    const boundsAWithNext = resolveChainedReadingBounds({
      priorPeriodReading,
      samePeriodReadings: [{ ...rA, is_billed: false }, rBUnlocked],
      nextPeriodReading: null,
      overlappingContracts,
      targetContractId: 'c-a',
      existingReadingId: 'r-dec-a',
      initialReading: 0,
    });
    assert.equal(boundsAWithNext.previousReading, 1000.25);
    assert.equal(boundsAWithNext.nextReading?.id, 'r-dec-b');

    // Exceeding unlocked nextReading.current_reading -> 400 INVALID_READING
    assert.throws(
      () =>
        validateChainedReadingInput({
          currentReading: 1050,
          previousReading: 1000.25,
          nextReading: rBUnlocked,
        }),
      (err) => err.status === 400 && err.code === 'INVALID_READING'
    );

    // Changing currentReading when nextReading is billed -> 409 READING_ALREADY_BILLED
    assert.throws(
      () =>
        validateChainedReadingInput({
          currentReading: 1020,
          previousReading: 1000.25,
          nextReading: { ...rBUnlocked, is_billed: true },
        }),
      (err) => err.status === 409 && err.code === 'READING_ALREADY_BILLED'
    );
  });

  await t.test('3. Migration 052 DB schema: partial unique indexes & RESIDENT per-contract RLS + attachment isolation', async () => {
    const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
    const rlsPool = new pg.Pool({ connectionString: APP_DB_URL });

    const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
    const cleanup = {
      attachmentIds: [],
      readingIds: [],
      meterId: null,
      contractIds: [],
      apartmentId: null,
      tenantIds: [],
      userIds: [],
      personIds: [],
    };

    async function queryAsUser(userId, sql, params = []) {
      const client = await rlsPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
        const res = await client.query(sql, params);
        await client.query('COMMIT');
        return res;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {}
        throw err;
      } finally {
        client.release();
      }
    }

    try {
      const colRes = await adminPool.query(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'meter_reading' AND column_name = 'contract_id'`
      );
      assert.equal(colRes.rows.length, 1, 'meter_reading.contract_id column must exist');
      assert.equal(colRes.rows[0].is_nullable, 'YES');

      const bldgRes = await adminPool.query(
        `SELECT id, org_id FROM building WHERE code = 'VOP-A' LIMIT 1`
      );
      const vopAId = bldgRes.rows[0].id;
      const orgId = bldgRes.rows[0].org_id;
      const mgrRes = await adminPool.query(
        `SELECT u.id
         FROM app_user u
         JOIN person p ON p.id = u.person_id
         WHERE p.email = 'manager.vop.a@resihub.vn'
         LIMIT 1`
      );
      const mgrUserId = mgrRes.rows[0].id;
      const roleRes = await adminPool.query(
        `SELECT id FROM role WHERE org_id = $1 AND code = 'RESIDENT' LIMIT 1`,
        [orgId]
      );
      const residentRoleId = roleRes.rows[0].id;

      // Seed isolated apartment + meter + 2 residents & 2 contracts in 2028-12
      const aptIns = await adminPool.query(
        `INSERT INTO apartment (building_id, code, area_m2, base_rent, status)
         VALUES ($1, $2, 45, 8000000, 'OCCUPIED') RETURNING id`,
        [vopAId, `T52-${suffix}`]
      );
      cleanup.apartmentId = aptIns.rows[0].id;

      const pwHash = await bcrypt.hash('Test@123456', 4);
      const createResPair = async (tag, startYmd, endYmd, status, termYmd) => {
        const p = await adminPool.query(
          `INSERT INTO person (org_id, full_name, phone, email)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [orgId, `Res ${tag}`, `097${tag}${suffix.slice(0, 6)}`, `res_${tag}_${suffix}@test.vn`]
        );
        cleanup.personIds.push(p.rows[0].id);

        const u = await adminPool.query(
          `INSERT INTO app_user (person_id, password_hash, status)
           VALUES ($1, $2, 'ACTIVE') RETURNING id`,
          [p.rows[0].id, pwHash]
        );
        cleanup.userIds.push(u.rows[0].id);

        await adminPool.query(
          `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
          [u.rows[0].id, residentRoleId, vopAId]
        );

        const tn = await adminPool.query(
          `INSERT INTO tenant (org_id, person_id, type, status)
           VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
          [orgId, p.rows[0].id]
        );
        cleanup.tenantIds.push(tn.rows[0].id);

        const c = await adminPool.query(
          `INSERT INTO contract (
             building_id, apartment_id, primary_tenant_id, start_date, end_date,
             rent_amount, deposit_amount, billing_day, status, terminated_at
           )
           VALUES ($1, $2, $3, $4, $5, 8000000, 8000000, 1, $6, $7) RETURNING id`,
          [vopAId, cleanup.apartmentId, tn.rows[0].id, startYmd, endYmd, status, termYmd]
        );
        cleanup.contractIds.push(c.rows[0].id);
        return { userId: u.rows[0].id, contractId: c.rows[0].id };
      };

      const resA = await createResPair('1', '2028-11-01', '2029-11-01', 'TERMINATED', '2028-12-15');
      const resB = await createResPair('2', '2028-12-20', '2029-12-20', 'ACTIVE', null);

      const mIns = await adminPool.query(
        `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading)
         VALUES ($1, $2, $3, 'ELECTRICITY', $4, 'kWh', 3800, 900) RETURNING id`,
        [orgId, vopAId, cleanup.apartmentId, `EL-T52-${suffix}`]
      );
      cleanup.meterId = mIns.rows[0].id;

      // Legacy null-contract row in 2028-11
      const rNull = await adminPool.query(
        `INSERT INTO meter_reading (
           org_id, building_id, meter_id, apartment_id, contract_id, period,
           previous_reading, current_reading, consumption, status
         )
         VALUES ($1, $2, $3, $4, NULL, '2028-11', 900, 1000, 100, 'CONFIRMED') RETURNING id`,
        [orgId, vopAId, cleanup.meterId, cleanup.apartmentId]
      );
      cleanup.readingIds.push(rNull.rows[0].id);

      // Duplicate null-contract in 2028-11 must fail 23505
      await assert.rejects(
        () =>
          adminPool.query(
            `INSERT INTO meter_reading (
               org_id, building_id, meter_id, apartment_id, contract_id, period,
               previous_reading, current_reading, consumption, status
             )
             VALUES ($1, $2, $3, $4, NULL, '2028-11', 900, 1005, 105, 'CONFIRMED')`,
            [orgId, vopAId, cleanup.meterId, cleanup.apartmentId]
          ),
        (err) => err.code === '23505'
      );

      // Two readings in SAME period 2028-12 with distinct contract_ids MUST succeed
      const rA = await adminPool.query(
        `INSERT INTO meter_reading (
           org_id, building_id, meter_id, apartment_id, contract_id, period,
           previous_reading, current_reading, consumption, status
         )
         VALUES ($1, $2, $3, $4, $5, '2028-12', 1000, 1100, 100, 'CONFIRMED') RETURNING id`,
        [orgId, vopAId, cleanup.meterId, cleanup.apartmentId, resA.contractId]
      );
      cleanup.readingIds.push(rA.rows[0].id);

      const rB = await adminPool.query(
        `INSERT INTO meter_reading (
           org_id, building_id, meter_id, apartment_id, contract_id, period,
           previous_reading, current_reading, consumption, status
         )
         VALUES ($1, $2, $3, $4, $5, '2028-12', 1100, 1185, 85, 'CONFIRMED') RETURNING id`,
        [orgId, vopAId, cleanup.meterId, cleanup.apartmentId, resB.contractId]
      );
      cleanup.readingIds.push(rB.rows[0].id);

      // Duplicate (meter_id, period, contract_id) MUST fail 23505
      await assert.rejects(
        () =>
          adminPool.query(
            `INSERT INTO meter_reading (
               org_id, building_id, meter_id, apartment_id, contract_id, period,
               previous_reading, current_reading, consumption, status
             )
             VALUES ($1, $2, $3, $4, $5, '2028-12', 1000, 1110, 110, 'CONFIRMED')`,
            [orgId, vopAId, cleanup.meterId, cleanup.apartmentId, resA.contractId]
          ),
        (err) => err.code === '23505'
      );

      // Seed attachments for rA and rB
      const attA = await adminPool.query(
        `INSERT INTO attachment (owner_entity, owner_id, storage_path, mime, size_bytes, uploaded_by)
         VALUES ('meter_reading', $1, '/uploads/meters/a.png', 'image/png', 100, $2) RETURNING id`,
        [rA.rows[0].id, mgrUserId]
      );
      cleanup.attachmentIds.push(attA.rows[0].id);

      const attB = await adminPool.query(
        `INSERT INTO attachment (owner_entity, owner_id, storage_path, mime, size_bytes, uploaded_by)
         VALUES ('meter_reading', $1, '/uploads/meters/b.png', 'image/png', 100, $2) RETURNING id`,
        [rB.rows[0].id, mgrUserId]
      );
      cleanup.attachmentIds.push(attB.rows[0].id);

      // Verify RLS isolation for Resident B: sees rB & legacy rNull, CANNOT see rA or attA
      const visibleToB = await queryAsUser(
        resB.userId,
        `SELECT id FROM meter_reading WHERE meter_id = $1 ORDER BY period ASC, current_reading ASC`,
        [cleanup.meterId]
      );
      assert.deepEqual(
        visibleToB.rows.map((r) => r.id),
        [rNull.rows[0].id, rB.rows[0].id],
        'Resident B must see legacy null row and own contract row rB, NOT Resident A row rA'
      );

      const attVisibleToB = await queryAsUser(
        resB.userId,
        `SELECT id FROM attachment WHERE id = ANY($1::uuid[])`,
        [[attA.rows[0].id, attB.rows[0].id]]
      );
      assert.deepEqual(
        attVisibleToB.rows.map((r) => r.id),
        [attB.rows[0].id],
        'Resident B must NOT be able to select Resident A meter reading attachment'
      );

      // Verify RLS isolation for Resident A: sees rA & legacy rNull, CANNOT see rB or attB
      const visibleToA = await queryAsUser(
        resA.userId,
        `SELECT id FROM meter_reading WHERE meter_id = $1 ORDER BY period ASC, current_reading ASC`,
        [cleanup.meterId]
      );
      assert.deepEqual(
        visibleToA.rows.map((r) => r.id),
        [rNull.rows[0].id, rA.rows[0].id],
        'Resident A must see legacy null row and own contract row rA, NOT Resident B row rB'
      );
    } finally {
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.allow_test_cleanup', 'true', true)`);
        if (cleanup.attachmentIds.length > 0) {
          await c.query(`DELETE FROM attachment WHERE id = ANY($1::uuid[])`, [cleanup.attachmentIds]);
        }
        if (cleanup.meterId) {
          await c.query(`DELETE FROM meter_reading WHERE meter_id = $1`, [cleanup.meterId]);
          await c.query(`DELETE FROM meter WHERE id = $1`, [cleanup.meterId]);
        }
        if (cleanup.contractIds.length > 0) {
          await c.query(`DELETE FROM contract WHERE id = ANY($1::uuid[])`, [cleanup.contractIds]);
        }
        if (cleanup.apartmentId) {
          await c.query(`DELETE FROM apartment WHERE id = $1`, [cleanup.apartmentId]);
        }
        if (cleanup.tenantIds.length > 0) {
          await c.query(`DELETE FROM tenant WHERE id = ANY($1::uuid[])`, [cleanup.tenantIds]);
        }
        if (cleanup.userIds.length > 0) {
          await c.query(`DELETE FROM user_role WHERE user_id = ANY($1::uuid[])`, [cleanup.userIds]);
          await c.query(`DELETE FROM app_user WHERE id = ANY($1::uuid[])`, [cleanup.userIds]);
        }
        if (cleanup.personIds.length > 0) {
          await c.query(`DELETE FROM person WHERE id = ANY($1::uuid[])`, [cleanup.personIds]);
        }
        await c.query('COMMIT');
      } finally {
        c.release();
        await adminPool.end();
        await rlsPool.end();
      }
    }
  });
});
