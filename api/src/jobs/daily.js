// Job hằng ngày (B5, R-01, R-02, R-05, R-11, R-15, R-22, FR-064, FR-066, PRD 14.5):
// 1. Hết hạn hợp đồng -> EXPIRED + chuyển căn sang MAINTENANCE chờ bàn giao (trừ khi có HĐ gia hạn con nối tiếp ngay) + gán hạn hoàn cọc +5 ngày
// 2. Đồng bộ trạng thái căn hộ (HĐ tới ngày bắt đầu, giữ chỗ quá hạn, RESERVED mồ côi)
// 3. Tự động sinh hóa đơn nháp hàng tháng theo billing_day (FR-066) + cảnh báo BQL khi thiếu chỉ số đồng hồ CONFIRMED (AC-015.1)
// 4. Tự động chuyển hóa đơn quá hạn sang OVERDUE & cộng phạt chậm thanh toán có khóa dòng FOR UPDATE (FR-064)
// 5. Cảnh báo sắp hết hạn HĐ: 60 ngày chỉ gửi MANAGER; 30 & 15 ngày gửi MANAGER + RESIDENT (FR-018)
// 6. Cảnh báo hạn hoàn cọc cho cả HĐ TERMINATED và EXPIRED trên mọi trạng thái chưa tất toán xong (FR-068)
// 7. Đảm bảo pg_try_advisory_lock(73918205), retry tối đa 3 lần, ghi nhận cron_job_run & cảnh báo SYS_ADMIN khi lỗi (PRD 14.5)
import { adminPool } from '../db/client.js';
import { syncApartmentStatus } from '../services/apartmentStatus.js';
import { refundDeadline, getOrgDepositRefundDays } from '../services/deadlines.js';
import { generateInvoicesCore } from '../routes/invoices.js';
import { roundVND } from '../services/pricing.js';
import { getTodayVnDateStr } from '../services/depositSettlement.js';
import {
  closeContractBillingAndSubscriptionsInTx,
  transferContractCreditsInTx,
} from '../services/invoiceLifecycle.js';
import {
  todayVietnamYmd,
  resolveBillingDaysForDate,
  computeNextVietnamDailyRunMs,
  computeLateFeeAccrual,
} from '../services/serviceBilling.js';
import { fanOutAnnouncementInTx } from '../routes/announcements.js';

export const DAILY_JOB_ADVISORY_LOCK_KEY = 73918205;

function sleepMs(ms) {
  const wait = Math.max(0, Number(ms) || 0);
  if (wait <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, wait));
}

async function notifySysAdminsCronFailure({
  effectiveDateYmd,
  attempts,
  errorMessage,
  buildingId = null,
}) {
  let targetOrgId = null;
  if (buildingId) {
    const bRes = await adminPool.query(
      `SELECT org_id FROM building WHERE id = $1 LIMIT 1`,
      [buildingId]
    );
    targetOrgId = bRes.rows[0]?.org_id || null;
  }

  const sysUsersRes = await adminPool.query(
    `SELECT DISTINCT ur.user_id, COALESCE(p.org_id, r.org_id) AS org_id
     FROM user_role ur
     JOIN role r ON r.id = ur.role_id
     JOIN app_user au ON au.id = ur.user_id
     LEFT JOIN person p ON p.id = au.person_id
     WHERE au.status = 'ACTIVE'
       AND r.code = 'SYS_ADMIN'
       AND ($1::uuid IS NULL OR COALESCE(p.org_id, r.org_id) = $1::uuid)`,
    [targetOrgId]
  );

  const title = `[CẢNH BÁO HỆ THỐNG] Cron job hằng ngày thất bại (${effectiveDateYmd})`;
  const content = `Tiến trình đồng bộ hóa đơn & công nợ hằng ngày (${effectiveDateYmd}) đã thất bại sau ${attempts} lần thử: ${errorMessage}`;
  const payload = {
    job_name: 'DAILY_BILLING_SYNC',
    run_date: effectiveDateYmd,
    attempts,
    error_message: String(errorMessage || '').slice(0, 500),
    building_id: buildingId || null,
    link: '/admin/settings',
  };

  for (const row of sysUsersRes.rows) {
    if (!row.org_id || !row.user_id) continue;
    await adminPool.query(
      `INSERT INTO notification (org_id, user_id, title, content, type, payload)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'CRON_JOB_FAILED', $5::jsonb)`,
      [row.org_id, row.user_id, title, content, JSON.stringify(payload)]
    );
  }
}

async function executeDailySteps({ effectiveDateYmd, buildingId = null }) {
  const expiredAptIds = new Set();
  const otherAffectedAptIds = new Set();
  const orgRefundDaysCache = new Map();

  async function resolveBuildingRefundDays(targetBuildingId) {
    if (!targetBuildingId) return 5;
    const bRes = await adminPool.query(
      `SELECT org_id FROM building WHERE id = $1 LIMIT 1`,
      [targetBuildingId]
    );
    const orgId = bRes.rows[0]?.org_id;
    if (!orgId) return 5;
    if (!orgRefundDaysCache.has(orgId)) {
      orgRefundDaysCache.set(orgId, await getOrgDepositRefundDays(adminPool, orgId));
    }
    return orgRefundDaysCache.get(orgId);
  }

  // 1a. Hợp đồng đang chờ bàn giao chấm dứt (TERMINATION_PENDING) đã đến ngày hẹn trả phòng -> tự động chuyển sang TERMINATED
  const candidateTerminated = await adminPool.query(
    `SELECT id, building_id, apartment_id, start_date, COALESCE(terminated_at, end_date) AS eff_end_date
     FROM contract
     WHERE status = 'TERMINATION_PENDING'
       AND COALESCE(terminated_at, end_date) <= $1::date
       AND ($2::uuid IS NULL OR building_id = $2::uuid)`,
    [effectiveDateYmd, buildingId]
  );
  let finalizedCount = 0;
  for (const cand of candidateTerminated.rows) {
    const txClient = await adminPool.connect();
    let row = null;
    try {
      await txClient.query('BEGIN');
      const updRes = await txClient.query(
        `UPDATE contract
         SET status = 'TERMINATED',
             terminated_at = COALESCE(terminated_at, end_date),
             updated_at = NOW()
         WHERE id = $1 AND status = 'TERMINATION_PENDING'
         RETURNING *, COALESCE(terminated_at, end_date) AS eff_end_date`,
        [cand.id]
      );
      if (updRes.rows.length === 0) {
        await txClient.query('ROLLBACK');
        continue;
      }
      row = updRes.rows[0];
      const termStr = getTodayVnDateStr(row.eff_end_date);
      const refundDays = await resolveBuildingRefundDays(row.building_id);
      const { dueAt } = refundDeadline(termStr, refundDays);
      await txClient.query(
        `UPDATE deposit
         SET refund_due_date = $1, updated_at = NOW()
         WHERE contract_id = $2
           AND status NOT IN ('REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED')
           AND refund_due_date IS NULL`,
        [dueAt, row.id]
      );

      // 6A Sync: đồng bộ hóa đơn & đóng subscription cho hợp đồng kết thúc lịch trả phòng
      await closeContractBillingAndSubscriptionsInTx(txClient, {
        contract: row,
        explicitEndYmd: termStr,
        actorId: null,
        reason: 'Kết thúc hợp đồng theo lịch trả phòng (TERMINATION_PENDING)',
      });

      await txClient.query('COMMIT');
      finalizedCount++;
    } catch (closeErr) {
      await txClient.query('ROLLBACK').catch(() => {});
      console.error('[DailyJob] Step 1a closeContract error:', closeErr.message);
    } finally {
      txClient.release();
    }

    if (row && row.apartment_id) {
      const termStr = getTodayVnDateStr(row.eff_end_date);
      const sDateStr = getTodayVnDateStr(row.start_date);
      const movedIn = Boolean(sDateStr && termStr >= sDateStr);
      if (!movedIn) {
        otherAffectedAptIds.add(row.apartment_id);
      } else {
        const childContinue = await adminPool.query(
          `SELECT 1 FROM contract
           WHERE parent_contract_id = $1
             AND apartment_id = $2
             AND status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
             AND start_date <= $3::date
             AND COALESCE(terminated_at, end_date) > $3::date
           LIMIT 1`,
          [row.id, row.apartment_id, effectiveDateYmd]
        );
        if (childContinue.rows.length > 0) {
          otherAffectedAptIds.add(row.apartment_id);
        } else {
          expiredAptIds.add(row.apartment_id);
        }
      }
    }
  }
  if (finalizedCount > 0) {
    console.log(`[DailyJob] scheduled contract terminations finalized: ${finalizedCount}`);
  }

  // 1b. Hợp đồng đến/quá ngày kết thúc (nửa mở [start_date, end_date) -> end_date <= effectiveDateYmd là đã kết thúc) (R-02)
  const candidateExpired = await adminPool.query(
    `SELECT id, building_id, apartment_id, end_date
     FROM contract
     WHERE status IN ('ACTIVE', 'RENEWAL_PENDING')
       AND end_date <= $1::date
       AND ($2::uuid IS NULL OR building_id = $2::uuid)`,
    [effectiveDateYmd, buildingId]
  );
  let expiredCount = 0;
  for (const cand of candidateExpired.rows) {
    const txClient = await adminPool.connect();
    let row = null;
    try {
      await txClient.query('BEGIN');
      const updRes = await txClient.query(
        `UPDATE contract SET status = 'EXPIRED', updated_at = NOW()
         WHERE id = $1 AND status IN ('ACTIVE', 'RENEWAL_PENDING')
         RETURNING *`,
        [cand.id]
      );
      if (updRes.rows.length === 0) {
        await txClient.query('ROLLBACK');
        continue;
      }
      row = updRes.rows[0];
      const endDateStr = getTodayVnDateStr(row.end_date);
      const refundDays = await resolveBuildingRefundDays(row.building_id);
      const { dueAt } = refundDeadline(endDateStr, refundDays);
      await txClient.query(
        `UPDATE deposit
         SET refund_due_date = $1, updated_at = NOW()
         WHERE contract_id = $2
           AND status NOT IN ('REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED')
           AND refund_due_date IS NULL`,
        [dueAt, row.id]
      );

      // 6A Sync: đồng bộ hóa đơn & đóng subscription khi hợp đồng hết hạn tự nhiên
      await closeContractBillingAndSubscriptionsInTx(txClient, {
        contract: row,
        explicitEndYmd: endDateStr,
        isNaturalExpiry: true,
        actorId: null,
        reason: 'Hết hạn hợp đồng tự nhiên',
      });

      // Kết chuyển credit_balance sang hợp đồng gia hạn con (nếu có)
      const childRenewRes = await txClient.query(
        `SELECT id, building_id FROM contract
         WHERE parent_contract_id = $1
           AND status IN ('ACTIVE', 'RENEWAL_PENDING')
         ORDER BY created_at DESC LIMIT 1`,
        [row.id]
      );
      if (childRenewRes.rows.length > 0) {
        await transferContractCreditsInTx(txClient, {
          fromContractId: row.id,
          toContractId: childRenewRes.rows[0].id,
          toBuildingId: childRenewRes.rows[0].building_id,
          actorId: null,
          reason: 'Kết chuyển số dư tín dụng khi hợp đồng cũ hết hạn',
        });
      }

      await txClient.query('COMMIT');
      expiredCount++;
    } catch (closeErr) {
      await txClient.query('ROLLBACK').catch(() => {});
      console.error('[DailyJob] Step 1b closeContract/transferCredits error:', closeErr.message);
    } finally {
      txClient.release();
    }

    if (row && row.apartment_id) {
      // Nếu có HĐ gia hạn con nối tiếp bắt đầu hôm nay (cùng khách ở tiếp), không ép sang MAINTENANCE
      const childContinue = await adminPool.query(
        `SELECT 1 FROM contract
         WHERE parent_contract_id = $1
           AND apartment_id = $2
           AND status IN ('ACTIVE', 'RENEWAL_PENDING')
           AND start_date <= $3::date
           AND COALESCE(terminated_at, end_date) > $3::date
         LIMIT 1`,
        [row.id, row.apartment_id, effectiveDateYmd]
      );
      if (childContinue.rows.length > 0) {
        otherAffectedAptIds.add(row.apartment_id);
      } else {
        expiredAptIds.add(row.apartment_id);
      }
    }
  }
  console.log(`[DailyJob] contract expired: ${expiredCount}`);

  // 2. Các căn hộ đang RESERVED/AVAILABLE nhưng HĐ ACTIVE đã tới ngày bắt đầu (start_date <= effectiveDateYmd)
  const dueStartApts = await adminPool.query(
    `SELECT DISTINCT a.id AS apartment_id
     FROM apartment a
     JOIN contract c ON c.apartment_id = a.id
     WHERE a.status IN ('RESERVED', 'AVAILABLE')
       AND c.status IN ('ACTIVE', 'RENEWAL_PENDING')
       AND c.start_date <= $1::date
       AND COALESCE(c.terminated_at, c.end_date) > $1::date
       AND ($2::uuid IS NULL OR a.building_id = $2::uuid)`,
    [effectiveDateYmd, buildingId]
  );
  dueStartApts.rows.forEach((r) => {
    if (!expiredAptIds.has(r.apartment_id)) otherAffectedAptIds.add(r.apartment_id);
  });

  // 3a. Giữ chỗ công khai chờ xác nhận sao kê (PENDING_CONFIRM) quá hạn -> chuyển sang REJECTED (không sang EXPIRED)
  const rsvPendingRejected = await adminPool.query(
    `UPDATE reservation
     SET status = 'REJECTED',
         rejected_reason = COALESCE(rejected_reason, 'Quá thời hạn đối chiếu sao kê xác nhận thanh toán'),
         updated_at = NOW()
     WHERE status = 'PENDING_CONFIRM'
       AND hold_until IS NOT NULL
       AND hold_until < $1::date
       AND ($2::uuid IS NULL OR apartment_id IN (SELECT id FROM apartment WHERE building_id = $2::uuid))
     RETURNING id`,
    [effectiveDateYmd, buildingId]
  );
  if (rsvPendingRejected.rowCount > 0) {
    console.log(`[DailyJob] unconfirmed public reservations rejected: ${rsvPendingRejected.rowCount}`);
  }

  // 3b. Giữ chỗ đã xác nhận tiền (HELD) quá hạn -> chuyển sang EXPIRED
  const rsvExpired = await adminPool.query(
    `UPDATE reservation SET status = 'EXPIRED', updated_at = NOW()
     WHERE status = 'HELD'
       AND hold_until IS NOT NULL
       AND hold_until < $1::date
       AND ($2::uuid IS NULL OR apartment_id IN (SELECT id FROM apartment WHERE building_id = $2::uuid))
     RETURNING apartment_id`,
    [effectiveDateYmd, buildingId]
  );
  rsvExpired.rows.forEach((r) => {
    if (!expiredAptIds.has(r.apartment_id)) otherAffectedAptIds.add(r.apartment_id);
  });
  console.log(`[DailyJob] reservation expired: ${rsvExpired.rowCount}`);

  // 4. Các căn đang RESERVED mồ côi (không còn giữ chỗ HELD / CANCEL_PENDING_APPROVAL hay HĐ mở)
  const orphanReserved = await adminPool.query(
    `SELECT a.id AS apartment_id
     FROM apartment a
     WHERE a.status = 'RESERVED'
       AND ($2::uuid IS NULL OR a.building_id = $2::uuid)
       AND NOT EXISTS (
         SELECT 1 FROM reservation r
         WHERE r.apartment_id = a.id
           AND r.status IN ('HELD', 'CANCEL_PENDING_APPROVAL')
           AND (r.hold_until IS NULL OR r.hold_until >= $1::date)
       )
       AND NOT EXISTS (
         SELECT 1 FROM contract c
         WHERE c.apartment_id = a.id
           AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
           AND COALESCE(c.terminated_at, c.end_date) > $1::date
       )`,
    [effectiveDateYmd, buildingId]
  );
  orphanReserved.rows.forEach((r) => {
    if (!expiredAptIds.has(r.apartment_id)) otherAffectedAptIds.add(r.apartment_id);
  });

  for (const aptId of expiredAptIds) {
    if (aptId) {
      await syncApartmentStatus(adminPool, aptId, { enterMaintenance: true });
    }
  }
  for (const aptId of otherAffectedAptIds) {
    if (aptId) {
      await syncApartmentStatus(adminPool, aptId);
    }
  }
  console.log(`[DailyJob] synced apartment statuses: expired->maintenance=${expiredAptIds.size}, other=${otherAffectedAptIds.size}`);

  // 5. FR-066, R-05 & AC-015.1: Tự động sinh hóa đơn nháp định kỳ theo billing_day (xử lý ngày 29/30/31 vào cuối tháng ngắn)
  let autoCreatedInvoices = 0;
  let skippedMeterContracts = 0;
  try {
    const matchDays = resolveBillingDaysForDate(effectiveDateYmd);
    const currentPeriod = effectiveDateYmd.slice(0, 7);

    const orgsRes = buildingId
      ? await adminPool.query(`SELECT DISTINCT org_id AS id FROM building WHERE id = $1`, [buildingId])
      : await adminPool.query(`SELECT id FROM organization`);

    for (const orgRow of orgsRes.rows) {
      const txClient = await adminPool.connect();
      let skippedList = [];
      try {
        await txClient.query('BEGIN');
        const genRes = await generateInvoicesCore(txClient, {
          orgId: orgRow.id,
          buildingId: buildingId || null,
          targetPeriod: currentPeriod,
          matchBillingDays: matchDays,
          onlyOngoingContracts: false,
          excludeSettledDeposits: true,
          autoIssue: false,
          actorId: null,
          issueDateYmd: effectiveDateYmd,
        });
        await txClient.query('COMMIT');
        autoCreatedInvoices += (genRes.createdInvoices || []).length;
        skippedList = genRes.skipped_contracts || [];
      } catch (genErr) {
        await txClient.query('ROLLBACK').catch(() => {});
        console.error('[DailyJob] auto-billing org error:', genErr.message);
      } finally {
        txClient.release();
      }

      // AC-015.1: Gửi thông báo cho BQL phụ trách tòa nhà khi hợp đồng bị bỏ qua do thiếu chỉ số đồng hồ CONFIRMED
      for (const skipItem of skippedList) {
        if (skipItem.reason_code !== 'MISSING_CONFIRMED_METER_READING') continue;
        skippedMeterContracts += 1;

        const mgrsRes = await adminPool.query(
          `SELECT DISTINCT ur.user_id
           FROM user_role ur
           JOIN role r ON r.id = ur.role_id
           JOIN app_user au ON au.id = ur.user_id
           WHERE ur.building_id = $1
             AND r.code = 'MANAGER'
             AND au.status = 'ACTIVE'`,
          [skipItem.building_id]
        );

        const missingTypesLabel = Array.isArray(skipItem.missing_meter_types)
          ? skipItem.missing_meter_types.join(', ')
          : '';
        const notifTitle = `[CHƯA CHỐT CHỈ SỐ] Tạm hoãn tạo hóa đơn căn ${skipItem.apartment_code} kỳ ${currentPeriod}`;
        const notifContent = `Hợp đồng căn ${skipItem.apartment_code} đến ngày tạo hóa đơn (${effectiveDateYmd}) nhưng chưa có chỉ số đồng hồ đã xác nhận (${missingTypesLabel || 'Điện/Nước'}) cho kỳ ${currentPeriod}. Vui lòng chốt chỉ số để tạo hóa đơn.`;
        const notifPayload = {
          contract_id: skipItem.contract_id,
          apartment_id: skipItem.apartment_id,
          apartment_code: skipItem.apartment_code,
          building_id: skipItem.building_id,
          period: currentPeriod,
          missing_meter_types: skipItem.missing_meter_types || [],
          link: '/admin/meters',
        };

        for (const mgr of mgrsRes.rows) {
          await adminPool.query(
            `INSERT INTO notification (org_id, user_id, title, content, type, payload)
             SELECT $1::uuid, $2::uuid, $3::text, $4::text, 'MISSING_METER_READING', $5::jsonb
             WHERE NOT EXISTS (
               SELECT 1 FROM notification n
               WHERE n.user_id = $2::uuid
                 AND n.type = 'MISSING_METER_READING'
                 AND n.payload->>'contract_id' = $6::text
                 AND n.payload->>'period' = $7::text
             )`,
            [
              orgRow.id,
              mgr.user_id,
              notifTitle,
              notifContent,
              JSON.stringify(notifPayload),
              String(skipItem.contract_id),
              currentPeriod,
            ]
          );
        }
      }
    }

    if (autoCreatedInvoices > 0) {
      console.log(`[DailyJob] auto-generated invoices for billing_day=${matchDays.join(',')}: ${autoCreatedInvoices}`);
    }
  } catch (autoBillErr) {
    console.error('[DailyJob] auto-billing step failed:', autoBillErr.message);
  }

  // 6. R-05: Tự động chuyển hóa đơn quá hạn sang OVERDUE (hỗ trợ cả ADJUSTED khi paid_amount < total_amount)
  const overdueInvoices = await adminPool.query(
    `UPDATE invoice
     SET status = 'OVERDUE', updated_at = NOW()
     WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'ADJUSTED')
       AND paid_amount < total_amount
       AND due_date < $1::date
       AND ($2::uuid IS NULL OR building_id = $2::uuid)
     RETURNING id, org_id, total_amount, paid_amount`,
    [effectiveDateYmd, buildingId]
  );
  for (const row of overdueInvoices.rows) {
    await adminPool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES (NULL, 'MARK_INVOICE_OVERDUE', 'invoice', $1, NULL, $2)`,
      [row.id, JSON.stringify({ status: 'OVERDUE', id: row.id, as_of_date: effectiveDateYmd })]
    );
  }
  const overdueMarked = overdueInvoices.rowCount || 0;
  if (overdueMarked > 0) {
    console.log(`[DailyJob] invoices marked OVERDUE: ${overdueMarked}`);
  }

  // Tải cấu hình billing_config theo từng org cho cả bước 7 (phí phạt chậm) và bước 8 (nhắc nợ)
  const billingConfigsRes = await adminPool.query(
    `SELECT org_id, value FROM system_setting WHERE key = 'billing_config'`
  );
  const orgBillingConfigMap = new Map();
  for (const r of billingConfigsRes.rows) {
    const val = r.value || {};
    orgBillingConfigMap.set(r.org_id, {
      graceDays:
        val.late_fee_grace_days !== undefined && val.late_fee_grace_days !== null
          ? Math.max(0, Math.trunc(Number(val.late_fee_grace_days)))
          : 5,
      feePerDay:
        val.late_fee_per_day !== undefined && val.late_fee_per_day !== null
          ? Math.max(0, roundVND(Number(val.late_fee_per_day)))
          : 100000,
      lateFeeCap:
        val.late_fee_cap !== undefined && val.late_fee_cap !== null && Number(val.late_fee_cap) > 0
          ? roundVND(Number(val.late_fee_cap))
          : null,
      reminderDays: Array.isArray(val.reminder_days) ? val.reminder_days.map(Number) : [3, 7, 15],
    });
  }

  // 7. R-11 & FR-064: Tự động cộng phí phạt chậm thanh toán append-only có khóa dòng FOR UPDATE
  // Bảo toàn dòng miễn giảm LATE_FEE, tôn trọng late_fee_cap và dừng cộng khi nợ gốc (principal) đã thanh toán đủ
  let lateFeeUpdated = 0;
  const lateCandidates = await adminPool.query(
    `SELECT i.id, i.org_id
     FROM invoice i
     WHERE i.status IN ('OVERDUE', 'ISSUED', 'PARTIALLY_PAID', 'ADJUSTED')
       AND i.paid_amount < i.total_amount
       AND i.due_date < $1::date
       AND ($2::uuid IS NULL OR i.building_id = $2::uuid)`,
    [effectiveDateYmd, buildingId]
  );

  for (const cand of lateCandidates.rows) {
    const cfg = orgBillingConfigMap.get(cand.org_id) || {
      graceDays: 5,
      feePerDay: 100000,
      lateFeeCap: null,
    };

    const txClient = await adminPool.connect();
    try {
      await txClient.query('BEGIN');
      const lockedRes = await txClient.query(
        `SELECT * FROM invoice WHERE id = $1 FOR UPDATE`,
        [cand.id]
      );
      const lockedInv = lockedRes.rows[0];
      if (
        !lockedInv ||
        !['OVERDUE', 'ISSUED', 'PARTIALLY_PAID', 'ADJUSTED'].includes(lockedInv.status) ||
        Number(lockedInv.paid_amount || 0) >= Number(lockedInv.total_amount || 0)
      ) {
        await txClient.query('ROLLBACK');
        continue;
      }

      const lineAggRes = await txClient.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE il.item_type <> 'LATE_FEE'
               AND il.credit_id IS NULL
               AND NOT (
                 il.item_type = 'ADJUSTMENT'
                 AND (
                   ia.adjustment_target = 'LATE_FEE'
                   OR COALESCE(il.formula_meta->>'adjusts_item_type', '') = 'LATE_FEE'
                 )
               )
           )::int AS non_lf_line_count,
           COALESCE(SUM(il.amount) FILTER (
             WHERE il.item_type <> 'LATE_FEE'
               AND il.credit_id IS NULL
               AND NOT (
                 il.item_type = 'ADJUSTMENT'
                 AND (
                   ia.adjustment_target = 'LATE_FEE'
                   OR COALESCE(il.formula_meta->>'adjusts_item_type', '') = 'LATE_FEE'
                 )
               )
           ), 0)::bigint AS principal_from_lines,
           COALESCE(SUM(il.amount) FILTER (
             WHERE il.item_type = 'LATE_FEE' AND il.amount > 0
           ), 0)::bigint AS gross_accrued_late_fee,
           COALESCE(SUM(il.amount) FILTER (
             WHERE il.item_type = 'ADJUSTMENT'
               AND il.credit_id IS NULL
               AND (
                 ia.adjustment_target = 'LATE_FEE'
                 OR COALESCE(il.formula_meta->>'adjusts_item_type', '') = 'LATE_FEE'
               )
           ), 0)::bigint AS late_fee_adjustment
         FROM invoice_line il
         LEFT JOIN invoice_adjustment ia ON ia.id = il.adjustment_id
         WHERE il.invoice_id = $1`,
        [lockedInv.id]
      );
      const agg = lineAggRes.rows[0] || {};
      const grossAccruedFee = Number(agg.gross_accrued_late_fee || 0);
      let principalAmount;
      if (Number(agg.non_lf_line_count || 0) > 0) {
        principalAmount = Math.max(0, Number(agg.principal_from_lines || 0));
      } else {
        const nonLateFeeAdj =
          Number(lockedInv.adjustment_amount || 0) - Number(agg.late_fee_adjustment || 0);
        principalAmount = Math.max(
          0,
          Number(lockedInv.subtotal_amount || 0) -
            grossAccruedFee +
            nonLateFeeAdj
        );
      }

      const accrual = computeLateFeeAccrual({
        dueDateYmd: lockedInv.due_date,
        asOfDateYmd: effectiveDateYmd,
        totalAmount: Number(lockedInv.total_amount || 0),
        paidAmount: Number(lockedInv.paid_amount || 0),
        creditOffsetAmount: Number(lockedInv.credit_offset_amount || 0),
        principalAmount,
        grossAccruedLateFee: grossAccruedFee,
        graceDays: cfg.graceDays,
        lateFeePerDay: cfg.feePerDay,
        maxLateFeeCap: cfg.lateFeeCap,
      });

      if (accrual.deltaFee <= 0) {
        await txClient.query('ROLLBACK');
        continue;
      }

      const deltaDays =
        cfg.feePerDay > 0
          ? Math.max(1, Math.round(accrual.deltaFee / cfg.feePerDay))
          : 1;
      const formulaMeta = {
        overdue_days: accrual.overdueDays,
        grace_days: cfg.graceDays,
        billable_days: accrual.chargeableDays,
        fee_per_day: cfg.feePerDay,
        late_fee_cap: cfg.lateFeeCap,
        expected_gross_fee: accrual.expectedTotalLateFee,
        gross_accrued_before: grossAccruedFee,
        delta_fee: accrual.deltaFee,
        principal_amount: principalAmount,
        as_of_date: effectiveDateYmd,
      };

      await txClient.query(
        `INSERT INTO invoice_line (
           invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta
         )
         VALUES ($1, 'LATE_FEE', $2, $3, 'ngày', $4, $5, $6::jsonb)`,
        [
          lockedInv.id,
          `Phạt chậm thanh toán (${accrual.chargeableDays} ngày sau ${cfg.graceDays} ngày ân hạn × ${cfg.feePerDay.toLocaleString('vi-VN')} ₫/ngày)`,
          deltaDays,
          cfg.feePerDay,
          accrual.deltaFee,
          JSON.stringify(formulaMeta),
        ]
      );
      await txClient.query(
        `UPDATE invoice
         SET subtotal_amount = subtotal_amount + $1,
             total_amount = total_amount + $1,
             status = CASE WHEN status = 'ISSUED' THEN 'OVERDUE' ELSE status END,
             updated_at = NOW()
         WHERE id = $2`,
        [accrual.deltaFee, lockedInv.id]
      );
      await txClient.query(
        `UPDATE receivable
         SET amount = amount + $1,
             updated_at = NOW()
         WHERE invoice_id = $2
           AND status IN ('OPEN', 'PARTIALLY_PAID')`,
        [accrual.deltaFee, lockedInv.id]
      );
      await txClient.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES (NULL, 'ACCRUE_LATE_FEE', 'invoice', $1, NULL, $2::jsonb)`,
        [
          lockedInv.id,
          JSON.stringify({
            delta_fee: accrual.deltaFee,
            expected_fee: accrual.expectedTotalLateFee,
            gross_accrued_fee: grossAccruedFee,
            penalty_days: accrual.chargeableDays,
            as_of_date: effectiveDateYmd,
          }),
        ]
      );

      await txClient.query('COMMIT');
      lateFeeUpdated += 1;
    } catch (lfErr) {
      await txClient.query('ROLLBACK').catch(() => {});
      console.error('[DailyJob] late fee error:', lfErr.message);
    } finally {
      txClient.release();
    }
  }

  // 8. FR-039 & PRD Mục 10.1 & 12.4: Nhắc nợ tự động đa mốc (-3, 0, +3, +7, +15 ngày)
  try {
    const unpaidInvoicesRes = await adminPool.query(
      `SELECT i.id,
              i.org_id,
              i.contract_id,
              i.invoice_code,
              i.period,
              i.total_amount,
              i.paid_amount,
              i.due_date,
              ($1::date - i.due_date)::int AS days_diff,
              c.building_id,
              b.name AS building_name,
              a.code AS apartment_code,
              au.id AS resident_user_id
       FROM invoice i
       JOIN contract c ON c.id = i.contract_id
       JOIN building b ON b.id = c.building_id
       JOIN apartment a ON a.id = c.apartment_id
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN person p ON p.id = t.person_id
       JOIN app_user au ON au.person_id = p.id
       WHERE i.status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED')
         AND i.paid_amount < i.total_amount
         AND au.status = 'ACTIVE'
         AND ($2::uuid IS NULL OR c.building_id = $2::uuid)`,
      [effectiveDateYmd, buildingId]
    );

    let remindersSent = 0;
    for (const inv of unpaidInvoicesRes.rows) {
      const daysDiff = Number(inv.days_diff);
      const reminderDays = orgBillingConfigMap.get(inv.org_id)?.reminderDays || [3, 7, 15];

      let stageKey = null;
      let title = null;
      let content = null;
      const remainingAmount = Number(inv.total_amount) - Number(inv.paid_amount);
      const dueDateStr = getTodayVnDateStr(inv.due_date);

      if (daysDiff === -3) {
        stageKey = 'PRE_DUE_3D';
        title = `Nhắc thanh toán hóa đơn ${inv.invoice_code} (còn 3 ngày)`;
        content = `Hóa đơn kỳ ${inv.period} căn hộ ${inv.apartment_code} (${remainingAmount.toLocaleString('vi-VN')} ₫) sẽ đến hạn vào ngày ${dueDateStr}. Vui lòng thanh toán đúng hạn.`;
      } else if (daysDiff === 0) {
        stageKey = 'DUE_TODAY';
        title = `Hóa đơn ${inv.invoice_code} đến hạn thanh toán hôm nay`;
        content = `Hóa đơn kỳ ${inv.period} căn hộ ${inv.apartment_code} (${remainingAmount.toLocaleString('vi-VN')} ₫) đến hạn thanh toán hôm nay (${dueDateStr}). Vui lòng thanh toán để tránh phát sinh phí phạt chậm.`;
      } else if (daysDiff > 0 && reminderDays.includes(daysDiff)) {
        stageKey = `OVERDUE_${daysDiff}D`;
        title = `[QUÁ HẠN] Nhắc nợ hóa đơn ${inv.invoice_code} quá hạn ${daysDiff} ngày`;
        content = `Hóa đơn kỳ ${inv.period} căn hộ ${inv.apartment_code} (${remainingAmount.toLocaleString('vi-VN')} ₫) đã quá hạn ${daysDiff} ngày. Vui lòng hoàn tất thanh toán để tránh các biện pháp xử lý công nợ tiếp theo.`;
      }

      if (!stageKey) continue;

      const payload = {
        invoice_id: inv.id,
        contract_id: inv.contract_id,
        building_id: inv.building_id,
        reminder_stage: stageKey,
        days_diff: daysDiff,
        remaining_amount: remainingAmount,
        link: '/resident',
      };

      const insRes = await adminPool.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         SELECT $1, $2, $3, $4, 'PAYMENT_REMINDER', $5::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM notification n
           WHERE n.user_id = $2
             AND n.type = 'PAYMENT_REMINDER'
             AND n.payload->>'invoice_id' = $6::text
             AND n.payload->>'reminder_stage' = $7::text
         )
         RETURNING id`,
        [
          inv.org_id,
          inv.resident_user_id,
          title,
          content,
          JSON.stringify(payload),
          inv.id,
          stageKey,
        ]
      );

      if (insRes.rowCount > 0) {
        await adminPool.query(
          `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
           VALUES (NULL, 'SEND_DEBT_REMINDER', 'invoice', $1, NULL, $2::jsonb)`,
          [
            inv.id,
            JSON.stringify({
              reminder_stage: stageKey,
              days_diff: daysDiff,
              remaining_amount: remainingAmount,
              user_id: inv.resident_user_id,
              notification_id: insRes.rows[0].id,
            }),
          ]
        );
        remindersSent++;
      }
    }

    if (remindersSent > 0) {
      console.log(`[DailyJob] sent FR-039 debt reminders: ${remindersSent}`);
    }
  } catch (reminderErr) {
    console.error('[DailyJob] debt reminder step error:', reminderErr.message);
  }

  // 8b. FR-018 & R-22: Cảnh báo hợp đồng sắp hết hạn (60 ngày chỉ MANAGER; 30 & 15 ngày cả MANAGER + RESIDENT)
  const expiringContracts = await adminPool.query(
    `SELECT c.id, c.building_id, c.primary_tenant_id, c.end_date,
            (c.end_date - $1::date)::int AS days_left,
            b.org_id, b.name AS building_name, a.code AS apartment_code
     FROM contract c
     JOIN building b ON b.id = c.building_id
     JOIN apartment a ON a.id = c.apartment_id
     WHERE c.status IN ('ACTIVE', 'RENEWAL_PENDING')
       AND (c.end_date - $1::date) IN (60, 30, 15)
       AND ($2::uuid IS NULL OR c.building_id = $2::uuid)`,
    [effectiveDateYmd, buildingId]
  );

  for (const c of expiringContracts.rows) {
    const daysLeft = Number(c.days_left);
    const managers = await adminPool.query(
      `SELECT DISTINCT ur.user_id FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       WHERE ur.building_id = $1 AND r.code = 'MANAGER'`,
      [c.building_id]
    );

    const endDateStr = c.end_date.toISOString ? c.end_date.toISOString().split('T')[0] : String(c.end_date);
    const deliveries = managers.rows.map((m) => ({
      userId: m.user_id,
      link: '/admin/contracts',
    }));

    if (daysLeft <= 30) {
      const resident = await adminPool.query(
        `SELECT u.id AS user_id FROM app_user u
         JOIN person p ON p.id = u.person_id
         JOIN tenant t ON t.person_id = p.id
         WHERE t.id = $1`,
        [c.primary_tenant_id]
      );
      for (const r of resident.rows) {
        deliveries.push({
          userId: r.user_id,
          link: '/resident',
        });
      }
    }

    for (const item of deliveries) {
      await adminPool.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         SELECT $1, $2, $3, $4, 'CONTRACT_EXPIRY', $5::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM notification n
           WHERE n.user_id = $2
             AND n.type = 'CONTRACT_EXPIRY'
             AND (n.payload->>'contract_id')::uuid = $6::uuid
             AND (n.payload->>'days_left')::int = $7::int
             AND (
               n.payload->>'as_of_date' = $8::text
               OR (n.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $8::date
             )
         )`,
        [
          c.org_id,
          item.userId,
          `Hợp đồng căn ${c.apartment_code} sắp hết hạn`,
          `Hợp đồng thuê căn ${c.apartment_code} (${c.building_name}) còn ${daysLeft} ngày là hết hạn (ngày kết thúc: ${endDateStr}). Vui lòng liên hệ để gia hạn hoặc chuẩn bị bàn giao.`,
          JSON.stringify({
            contract_id: c.id,
            building_id: c.building_id,
            days_left: daysLeft,
            as_of_date: effectiveDateYmd,
            link: item.link,
          }),
          c.id,
          daysLeft,
          effectiveDateYmd,
        ]
      );
    }
  }

  // 9. FR-068 & R-15: Cảnh báo hạn hoàn cọc cho cả TERMINATED và EXPIRED, và mọi trạng thái chưa tất toán xong
  await runOverdueDepositSettlementAlerts({ asOfDate: effectiveDateYmd, buildingId });

  // 10. M15 (PRD 13.2): Chuyển các bản nháp ai_suggestion PENDING quá hạn (72h) sang EXPIRED
  const aiExpiry = await expireStaleAiSuggestions(adminPool);

  return {
    autoCreatedInvoices,
    skippedMeterContracts,
    overdueMarked,
    lateFeeUpdated,
    expiredAiSuggestions: aiExpiry.expiredCount,
  };
}

export async function runDailyJobs(options = {}) {
  const {
    asOfDate = null,
    buildingId = null,
    maxRetries = 3,
    retryDelaysMs = [1000, 2000, 4000],
    stepHookForTest = null,
  } = options || {};

  const effectiveDateYmd = asOfDate ? String(asOfDate).slice(0, 10) : todayVietnamYmd();
  const effectiveMaxRetries = Math.max(1, Math.trunc(Number(maxRetries) || 3));

  const lockClient = await adminPool.connect();
  let lockAcquired = false;

  try {
    const lockRes = await lockClient.query(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [DAILY_JOB_ADVISORY_LOCK_KEY]
    );
    lockAcquired = Boolean(lockRes.rows[0]?.locked);
    if (!lockAcquired) {
      return {
        skipped: true,
        reason: 'LOCK_HELD',
        runDate: effectiveDateYmd,
      };
    }

    const startedAtMs = Date.now();
    const runRowRes = await adminPool.query(
      `INSERT INTO cron_job_run (job_name, run_date, status, attempt_count, started_at)
       VALUES ('DAILY_BILLING_SYNC', $1::date, 'RUNNING', 1, NOW())
       RETURNING id`,
      [effectiveDateYmd]
    );
    const cronRunId = runRowRes.rows[0]?.id || null;

    for (let attempt = 1; attempt <= effectiveMaxRetries; attempt += 1) {
      try {
        if (cronRunId) {
          await adminPool.query(
            `UPDATE cron_job_run SET attempt_count = $1, status = 'RUNNING' WHERE id = $2`,
            [attempt, cronRunId]
          );
        }

        if (typeof stepHookForTest === 'function') {
          await stepHookForTest(attempt);
        }

        const summary = await executeDailySteps({ effectiveDateYmd, buildingId });
        const durationMs = Math.max(0, Date.now() - startedAtMs);

        if (cronRunId) {
          await adminPool.query(
            `UPDATE cron_job_run
             SET status = 'SUCCEEDED',
                 attempt_count = $1,
                 finished_at = NOW(),
                 duration_ms = $2,
                 summary = $3::jsonb,
                 error_message = NULL
             WHERE id = $4`,
            [attempt, durationMs, JSON.stringify(summary), cronRunId]
          );
        }

        return {
          skipped: false,
          runDate: effectiveDateYmd,
          attempts: attempt,
          ...summary,
        };
      } catch (err) {
        if (attempt < effectiveMaxRetries) {
          const delayMs =
            Array.isArray(retryDelaysMs) && retryDelaysMs.length > 0
              ? Number(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] || 0)
              : 0;
          await sleepMs(delayMs);
          continue;
        }

        const durationMs = Math.max(0, Date.now() - startedAtMs);
        const errMsg = String(err?.message || err || 'Unknown cron failure');
        if (cronRunId) {
          await adminPool
            .query(
              `UPDATE cron_job_run
               SET status = 'FAILED',
                   attempt_count = $1,
                   finished_at = NOW(),
                   duration_ms = $2,
                   error_message = $3
               WHERE id = $4`,
              [attempt, durationMs, errMsg.slice(0, 2000), cronRunId]
            )
            .catch(() => {});
        }

        await notifySysAdminsCronFailure({
          effectiveDateYmd,
          attempts: attempt,
          errorMessage: errMsg,
          buildingId,
        }).catch((alertErr) => {
          console.error('[DailyJob] failed to alert SYS_ADMIN:', alertErr.message);
        });

        throw err;
      }
    }
  } finally {
    if (lockAcquired) {
      await lockClient
        .query(`SELECT pg_advisory_unlock($1)`, [DAILY_JOB_ADVISORY_LOCK_KEY])
        .catch(() => {});
    }
    lockClient.release();
  }
}

export async function runOverdueDepositSettlementAlerts(options = {}) {
  const { asOfDate = null, buildingId = null } = options || {};
  const todayStr = asOfDate ? String(asOfDate).slice(0, 10) : getTodayVnDateStr();

  const depositAlerts = await adminPool.query(
    `SELECT d.id AS deposit_id,
            d.contract_id,
            d.amount_held,
            d.status AS deposit_status,
            d.refund_due_date,
            COALESCE(c.terminated_at, c.end_date) AS end_ref,
            c.building_id,
            building_has_active_owner(c.building_id) AS building_has_active_owner,
            b.org_id,
            a.code AS apartment_code,
            b.name AS building_name,
            ($1::date - COALESCE(c.terminated_at, c.end_date))::int AS days_since_end,
            GREATEST(
              1,
              LEAST(
                90,
                COALESCE(
                  CASE
                    WHEN (ss.value->>'deposit_refund_days') ~ '^[0-9]+$'
                      THEN (ss.value->>'deposit_refund_days')::int
                    ELSE NULL
                  END,
                  5
                )
              )
            ) AS sla_refund_days
     FROM deposit d
     JOIN contract c ON c.id = d.contract_id
     JOIN building b ON b.id = c.building_id
     JOIN apartment a ON a.id = c.apartment_id
     LEFT JOIN system_setting ss ON ss.org_id = b.org_id AND ss.key = 'sla_config'
     WHERE d.status NOT IN ('REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED')
       AND d.amount_held > 0
       AND c.status IN ('TERMINATED', 'EXPIRED')
       AND COALESCE(c.terminated_at, c.end_date) IS NOT NULL
       AND ($2::uuid IS NULL OR c.building_id = $2::uuid)`,
    [todayStr, buildingId]
  );

  for (const dep of depositAlerts.rows) {
    const days = Number(dep.days_since_end);
    const slaDays = Number(dep.sla_refund_days) || 5;
    const warnThreshold = Math.max(0, slaDays - 2);
    const dueStr = dep.refund_due_date ? getTodayVnDateStr(dep.refund_due_date) : null;
    const warnDueStr = dueStr
      ? (() => {
          const [y, m, d] = dueStr.split('-').map(Number);
          return new Date(Date.UTC(y, m - 1, d - 2)).toISOString().slice(0, 10);
        })()
      : null;

    const isOverdue = dueStr ? todayStr >= dueStr : days >= slaDays;
    const isWarning = !isOverdue && (dueStr ? todayStr === warnDueStr : days === warnThreshold);
    if (!isOverdue && !isWarning) continue;

    const title = isOverdue
      ? `[QUÁ HẠN] Hoàn cọc căn ${dep.apartment_code} đã quá hạn ${slaDays} ngày`
      : `[CẢNH BÁO] Đến hạn hoàn cọc căn ${dep.apartment_code} (còn 2 ngày)`;
    const content = isOverdue
      ? `Hợp đồng căn ${dep.apartment_code} đã kết thúc ${days} ngày nhưng chưa hoàn tất thủ tục hoàn cọc (trạng thái: ${dep.deposit_status}, số tiền đang giữ: ${Number(dep.amount_held).toLocaleString('vi-VN')} ₫). Báo cáo khẩn gửi Chủ sở hữu tòa nhà & Ban Quản Lý (FR-068).`
      : `Hợp đồng căn ${dep.apartment_code} đã kết thúc ${days} ngày. Vui lòng hoàn tất hồ sơ tất toán và hoàn cọc cho cư dân đúng hạn ${slaDays} ngày.`;

    const recipientSet = new Set();

    const mgrUsers = await adminPool.query(
      `SELECT DISTINCT ur.user_id
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       JOIN app_user au ON au.id = ur.user_id
       JOIN person p ON p.id = au.person_id
       WHERE p.org_id = $1
         AND au.status = 'ACTIVE'
         AND r.code = 'MANAGER'
         AND ur.building_id = $2`,
      [dep.org_id, dep.building_id]
    );
    mgrUsers.rows.forEach((r) => recipientSet.add(r.user_id));

    if (isOverdue) {
      const ownerUsers = await adminPool.query(
        `SELECT DISTINCT au.id AS user_id
         FROM building b
         JOIN owner o ON o.id = b.owner_id
         JOIN app_user au ON au.person_id = o.person_id
         WHERE b.id = $1
           AND au.status = 'ACTIVE'`,
        [dep.building_id]
      );
      ownerUsers.rows.forEach((r) => recipientSet.add(r.user_id));

      if (!dep.building_has_active_owner) {
        const sysUsers = await adminPool.query(
          `SELECT DISTINCT ur.user_id
           FROM user_role ur
           JOIN role r ON r.id = ur.role_id
           JOIN app_user au ON au.id = ur.user_id
           JOIN person p ON p.id = au.person_id
           WHERE p.org_id = $1
             AND au.status = 'ACTIVE'
             AND r.code = 'SYS_ADMIN'`,
          [dep.org_id]
        );
        sysUsers.rows.forEach((r) => recipientSet.add(r.user_id));
      }
    }

    for (const userId of recipientSet) {
      await adminPool.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         SELECT $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM notification n
           WHERE n.user_id = $2::uuid
             AND n.type = $5::text
             AND (n.payload->>'deposit_id')::uuid = $7::uuid
             AND (
               n.payload->>'as_of_date' = $8::text
               OR (n.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = $8::date
             )
         )`,
        [
          dep.org_id,
          userId,
          title,
          content,
          isOverdue ? 'DEPOSIT_OVERDUE_5D' : 'DEPOSIT_WARNING_3D',
          JSON.stringify({
            deposit_id: dep.deposit_id,
            contract_id: dep.contract_id,
            building_id: dep.building_id,
            days_since: days,
            as_of_date: todayStr,
            link: '/admin/deposits',
          }),
          dep.deposit_id,
          todayStr,
        ]
      );
    }
  }
  // 9. Báo cáo tổng hợp Sổ cọc định kỳ đầu tháng gửi OWNER đang ACTIVE (1 lần/tháng/tòa — GAP-05, PRD 15.3)
  try {
    await sendMonthlyOwnerDepositReports(
      adminPool,
      new Date(`${todayStr}T00:05:00+07:00`),
      buildingId
    );
  } catch (monthlyErr) {
    console.error('[DailyJob] monthly owner deposit report error:', monthlyErr.message);
  }

  // 10. Cảnh báo leo thang yêu cầu sửa chữa quá hạn SLA gửi MANAGER + OWNER (M11 FR-044, PRD 10.2)
  try {
    await escalateOverdueServiceRequests(adminPool, {
      nowTs: new Date(),
      buildingId,
    });
  } catch (slaErr) {
    console.error('[DailyJob] SLA escalation error:', slaErr.message);
  }

  // 11. Phát hành thông báo hẹn giờ đến hạn (M13 FR-054)
  try {
    await dispatchDueScheduledAnnouncements(adminPool, {
      nowTs: new Date(),
      buildingId,
    });
  } catch (schedAnnErr) {
    console.error('[DailyJob] scheduled announcements dispatch error:', schedAnnErr.message);
  }
}

export async function dispatchDueScheduledAnnouncements(
  dbPool = adminPool,
  { nowTs = new Date(), buildingId = null } = {}
) {
  const effectiveNow = nowTs instanceof Date && !Number.isNaN(nowTs.getTime()) ? nowTs : new Date(nowTs);
  let dispatchedCount = 0;
  let notificationsSent = 0;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const dueRes = await client.query(
      `SELECT *
       FROM announcement
       WHERE status = 'SCHEDULED'
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= $1::timestamptz
         AND ($2::uuid IS NULL OR building_id = $2::uuid)
       ORDER BY scheduled_at ASC
       FOR UPDATE SKIP LOCKED`,
      [effectiveNow.toISOString(), buildingId]
    );

    const queryFn = (sql, params) => client.query(sql, params);
    for (const ann of dueRes.rows) {
      const { announcement: sentAnn, notificationsInserted } = await fanOutAnnouncementInTx(
        queryFn,
        {
          announcementRow: ann,
          senderUserId: ann.created_by,
          senderName: 'Ban Quản Lý',
          sentAt: effectiveNow,
        }
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'DISPATCH_SCHEDULED_ANNOUNCEMENT', 'announcement', $2, $3, $4)`,
        [ann.created_by || null, ann.id, JSON.stringify(ann), JSON.stringify(sentAnn)]
      );

      dispatchedCount += 1;
      notificationsSent += notificationsInserted;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { dispatchedCount, notificationsSent };
}

export async function escalateOverdueServiceRequests(
  dbPool = adminPool,
  { nowTs = new Date(), buildingId = null } = {}
) {
  const effectiveNow = nowTs instanceof Date && !Number.isNaN(nowTs.getTime()) ? nowTs : new Date(nowTs);
  let escalatedCount = 0;
  let notificationsSent = 0;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const overdueRes = await client.query(
      `UPDATE service_request sr
       SET sla_breached_at = $1::timestamptz,
           updated_at = NOW()
       FROM apartment a, building b
       WHERE sr.apartment_id = a.id
         AND sr.building_id = b.id
         AND sr.status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED')
         AND sr.sla_due_at IS NOT NULL
         AND sr.sla_due_at < $1::timestamptz
         AND sr.sla_breached_at IS NULL
         AND ($2::uuid IS NULL OR sr.building_id = $2::uuid)
       RETURNING sr.id, sr.org_id, sr.building_id, sr.apartment_id, sr.assigned_to,
                 sr.tracking_code, sr.title, sr.priority, sr.status, sr.sla_due_at,
                 a.code AS apartment_code, b.code AS building_code, b.name AS building_name`,
      [effectiveNow.toISOString(), buildingId]
    );

    escalatedCount = overdueRes.rows.length;

    for (const sr of overdueRes.rows) {
      const recipientsRes = await client.query(
        `SELECT DISTINCT user_id FROM (
           SELECT ur.user_id
           FROM user_role ur
           JOIN role r ON r.id = ur.role_id
           JOIN app_user au ON au.id = ur.user_id
           WHERE au.status = 'ACTIVE'
             AND r.code = 'MANAGER'
             AND ur.building_id = $1
           UNION
           SELECT au_own.id AS user_id
           FROM building b
           JOIN owner o ON o.id = b.owner_id
           JOIN app_user au_own ON au_own.person_id = o.person_id
           WHERE b.id = $1
             AND au_own.status = 'ACTIVE'
           UNION
           SELECT au_ass.id AS user_id
           FROM app_user au_ass
           WHERE $2::uuid IS NOT NULL
             AND au_ass.id = $2::uuid
             AND au_ass.status = 'ACTIVE'
         ) rec`,
        [sr.building_id, sr.assigned_to || null]
      );

      const title = `[QUÁ HẠN SLA] Yêu cầu #${sr.tracking_code} — Phòng ${sr.apartment_code} (${sr.building_code})`;
      const content = `Yêu cầu "${sr.title}" tại căn hộ ${sr.apartment_code} (${sr.building_name}) đã vượt cam kết SLA xử lý. Vui lòng kiểm tra và đôn đốc xử lý ngay.`;
      const payload = {
        service_request_id: sr.id,
        tracking_code: sr.tracking_code,
        building_id: sr.building_id,
        apartment_id: sr.apartment_id,
        priority: sr.priority,
        sla_due_at: sr.sla_due_at,
        link: '/admin/maintenance',
      };

      for (const rec of recipientsRes.rows) {
        const ins = await client.query(
          `INSERT INTO notification (org_id, user_id, title, content, type, payload)
           SELECT $1::uuid, $2::uuid, $3::text, $4::text, 'SERVICE_REQUEST_SLA_BREACH', $5::jsonb
           WHERE NOT EXISTS (
             SELECT 1 FROM notification n
             WHERE n.user_id = $2::uuid
               AND n.type = 'SERVICE_REQUEST_SLA_BREACH'
               AND (n.payload->>'service_request_id') = $6::text
           )`,
          [sr.org_id, rec.user_id, title, content, JSON.stringify(payload), String(sr.id)]
        );
        notificationsSent += ins.rowCount || 0;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { escalatedCount, notificationsSent };
}

export async function sendMonthlyOwnerDepositReports(
  dbPool = adminPool,
  refDate = new Date(),
  buildingId = null
) {
  const vnParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(refDate);
  const year = Number(vnParts.find((p) => p.type === 'year')?.value || refDate.getUTCFullYear());
  const month = Number(vnParts.find((p) => p.type === 'month')?.value || refDate.getUTCMonth() + 1);

  const prevMonthDate = new Date(Date.UTC(year, month - 2, 1));
  const prevYear = prevMonthDate.getUTCFullYear();
  const prevMonthNum = prevMonthDate.getUTCMonth() + 1;
  const prevPeriod = `${prevYear}-${String(prevMonthNum).padStart(2, '0')}`;
  const prevStart = `${prevPeriod}-01`;
  const lastDay = new Date(Date.UTC(prevYear, prevMonthNum, 0)).getUTCDate();
  const prevEnd = `${prevPeriod}-${String(lastDay).padStart(2, '0')}`;

  const buildingsRes = await dbPool.query(
    `SELECT
       b.id AS building_id,
       b.org_id,
       b.code AS building_code,
       b.name AS building_name,
       au.id AS owner_user_id
     FROM building b
     JOIN owner o ON o.id = b.owner_id
     JOIN app_user au ON au.person_id = o.person_id
     JOIN user_role ur ON ur.user_id = au.id
     JOIN role r ON r.id = ur.role_id
     WHERE au.status = 'ACTIVE'
       AND r.code = 'OWNER'
       AND ($1::uuid IS NULL OR b.id = $1::uuid)`,
    [buildingId]
  );

  let sentCount = 0;
  for (const bld of buildingsRes.rows) {
    const aggRes = await dbPool.query(
      `SELECT
         COALESCE(SUM(d.amount_held), 0)::bigint AS closing_held,
         COUNT(*) FILTER (WHERE d.status = 'PENDING_APPROVAL')::int AS pending_approvals,
         COUNT(*) FILTER (WHERE d.status IN ('APPROVED_PENDING_PAYOUT', 'RETURNED'))::int AS pending_payouts,
         COALESCE((
           SELECT SUM(dt.amount)
           FROM deposit_transaction dt
           JOIN deposit d2 ON d2.id = dt.deposit_id
           JOIN contract c2 ON c2.id = d2.contract_id
           WHERE c2.building_id = $1
             AND dt.status = 'APPROVED'
             AND dt.type = 'collect'
             AND (dt.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
         ), 0)::bigint AS collected_in_period,
         GREATEST(0, COALESCE((
           SELECT SUM(
             CASE
               WHEN dt.type = 'refund' THEN dt.amount
               WHEN dt.type = 'refund_reversal' THEN -dt.amount
               ELSE 0
             END
           )
           FROM deposit_transaction dt
           JOIN deposit d2 ON d2.id = dt.deposit_id
           JOIN contract c2 ON c2.id = d2.contract_id
           WHERE c2.building_id = $1
             AND dt.status = 'APPROVED'
             AND dt.type IN ('refund', 'refund_reversal')
             AND (dt.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
         ), 0))::bigint AS refunded_in_period
       FROM deposit d
       JOIN contract c ON c.id = d.contract_id
       WHERE c.building_id = $1`,
      [bld.building_id, prevStart, prevEnd]
    );

    const row = aggRes.rows[0] || {};
    const title = `[BÁO CÁO SỔ CỌC THÁNG ${prevPeriod}] Tòa ${bld.building_code}`;
    const content = `Tổng hợp Sổ cọc tòa ${bld.building_name} kỳ ${prevPeriod}: Thu mới ${Number(row.collected_in_period || 0).toLocaleString('vi-VN')} ₫, Hoàn chi ${Number(row.refunded_in_period || 0).toLocaleString('vi-VN')} ₫, Số dư cọc đang giữ hiện tại ${Number(row.closing_held || 0).toLocaleString('vi-VN')} ₫ (Chờ duyệt: ${Number(row.pending_approvals || 0)}, Chờ chi: ${Number(row.pending_payouts || 0)}).`;
    const payload = {
      building_id: bld.building_id,
      building_code: bld.building_code,
      period: prevPeriod,
      from_date: prevStart,
      to_date: prevEnd,
      closing_held: Number(row.closing_held || 0),
      collected: Number(row.collected_in_period || 0),
      refunded: Number(row.refunded_in_period || 0),
      link: `/admin/reports?tab=deposit-ledger&building_id=${bld.building_id}&from_date=${prevStart}&to_date=${prevEnd}`,
    };

    const ins = await dbPool.query(
      `INSERT INTO notification (org_id, user_id, title, content, type, payload)
       SELECT $1::uuid, $2::uuid, $3::text, $4::text, 'MONTHLY_DEPOSIT_REPORT', $5::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM notification n
         WHERE n.user_id = $2::uuid
           AND n.type = 'MONTHLY_DEPOSIT_REPORT'
           AND (n.payload->>'building_id') = $6::text
           AND (n.payload->>'period') = $7::text
       )`,
      [
        bld.org_id,
        bld.owner_user_id,
        title,
        content,
        JSON.stringify(payload),
        String(bld.building_id),
        prevPeriod,
      ]
    );
    sentCount += ins.rowCount || 0;
  }

  if (sentCount > 0) {
    console.log(`[DailyJob] sent MONTHLY_DEPOSIT_REPORT notifications: ${sentCount}`);
  }
  return sentCount;
}

export async function expireStaleAiSuggestions(dbPool = adminPool, { nowTs = new Date() } = {}) {
  const res = await dbPool.query(
    `UPDATE ai_suggestion
     SET status = 'EXPIRED',
         updated_at = NOW()
     WHERE status = 'PENDING'
       AND expires_at <= $1::timestamptz`,
    [nowTs]
  );
  return { expiredCount: res.rowCount || 0 };
}

export function startDailyJobs(options = {}) {
  const {
    targetHour = 0,
    targetMinute = 5,
    runCatchUpOnBoot = true,
  } = options || {};

  let stopped = false;
  let timer = null;

  if (runCatchUpOnBoot) {
    const todayVn = todayVietnamYmd();
    adminPool
      .query(
        `SELECT 1 FROM cron_job_run
         WHERE job_name = 'DAILY_BILLING_SYNC'
           AND run_date = $1::date
           AND status = 'SUCCEEDED'
         LIMIT 1`,
        [todayVn]
      )
      .then((res) => {
        if (!stopped && res.rows.length === 0) {
          return runDailyJobs();
        }
        return null;
      })
      .catch((err) => console.error('[DailyJob] boot catch-up failed:', err));
  }

  function scheduleNext() {
    if (stopped) return;
    const delayMs = computeNextVietnamDailyRunMs(new Date(), targetHour, targetMinute);
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await runDailyJobs();
      } catch (err) {
        console.error('[DailyJob] scheduled run failed:', err);
      } finally {
        scheduleNext();
      }
    }, delayMs);
    timer.unref?.();
  }

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
