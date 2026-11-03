// Job hằng ngày (B5, R-01, R-02, R-05, R-11, R-15, R-22):
// 1. Hết hạn hợp đồng -> EXPIRED + chuyển căn sang MAINTENANCE chờ bàn giao (trừ khi có HĐ gia hạn con nối tiếp ngay) + gán hạn hoàn cọc +5 ngày
// 2. Đồng bộ trạng thái căn hộ (HĐ tới ngày bắt đầu, giữ chỗ quá hạn, RESERVED mồ côi)
// 3. Tự động sinh hóa đơn hàng tháng theo billing_day (FR-066)
// 4. Tự động chuyển hóa đơn quá hạn sang OVERDUE & cộng phạt chậm thanh toán 100.000 ₫/ngày từ ngày quá hạn thứ 6 (không trần tối đa)
// 5. Cảnh báo sắp hết hạn HĐ: 60 ngày chỉ gửi MANAGER; 30 & 15 ngày gửi MANAGER + RESIDENT (FR-018)
// 6. Cảnh báo hạn hoàn cọc cho cả HĐ TERMINATED và EXPIRED trên mọi trạng thái chưa tất toán xong (FR-068)
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
  currentVietnamPeriod,
} from '../services/serviceBilling.js';

export async function runDailyJobs() {
  const expiredAptIds = new Set();
  const otherAffectedAptIds = new Set();
  const orgRefundDaysCache = new Map();

  async function resolveBuildingRefundDays(buildingId) {
    if (!buildingId) return 5;
    const bRes = await adminPool.query(`SELECT org_id FROM building WHERE id = $1 LIMIT 1`, [buildingId]);
    const orgId = bRes.rows[0]?.org_id;
    if (!orgId) return 5;
    if (!orgRefundDaysCache.has(orgId)) {
      orgRefundDaysCache.set(orgId, await getOrgDepositRefundDays(adminPool, orgId));
    }
    return orgRefundDaysCache.get(orgId);
  }

  // 1a. Hợp đồng đang chờ bàn giao chấm dứt (TERMINATION_PENDING) đã đến ngày hẹn trả phòng -> tự động chuyển sang TERMINATED
  const scheduledTerminated = await adminPool.query(
    `UPDATE contract
     SET status = 'TERMINATED',
         terminated_at = COALESCE(terminated_at, end_date),
         updated_at = NOW()
     WHERE status = 'TERMINATION_PENDING'
       AND COALESCE(terminated_at, end_date) <= CURRENT_DATE
     RETURNING *, COALESCE(terminated_at, end_date) AS eff_end_date`
  );
  for (const row of scheduledTerminated.rows) {
    const termStr = getTodayVnDateStr(row.eff_end_date);
    const sDateStr = getTodayVnDateStr(row.start_date);
    const refundDays = await resolveBuildingRefundDays(row.building_id);
    const { dueAt } = refundDeadline(termStr, refundDays);
    await adminPool.query(
      `UPDATE deposit
       SET refund_due_date = $1, updated_at = NOW()
       WHERE contract_id = $2
         AND status NOT IN ('REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED')
         AND refund_due_date IS NULL`,
      [dueAt, row.id]
    );

    // 6A Sync: đồng bộ hóa đơn & đóng subscription cho hợp đồng kết thúc lịch trả phòng
    try {
      await closeContractBillingAndSubscriptionsInTx(adminPool, {
        contract: row,
        explicitEndYmd: termStr,
        actorId: null,
        reason: 'Kết thúc hợp đồng theo lịch trả phòng (TERMINATION_PENDING)',
      });
    } catch (closeErr) {
      console.error('[DailyJob] Step 1a closeContract error:', closeErr.message);
    }

    if (row.apartment_id) {
      const movedIn = Boolean(sDateStr && termStr >= sDateStr);
      if (!movedIn) {
        otherAffectedAptIds.add(row.apartment_id);
      } else {
        const childContinue = await adminPool.query(
          `SELECT 1 FROM contract
           WHERE parent_contract_id = $1
             AND apartment_id = $2
             AND status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
             AND start_date <= CURRENT_DATE
             AND COALESCE(terminated_at, end_date) > CURRENT_DATE
           LIMIT 1`,
          [row.id, row.apartment_id]
        );
        if (childContinue.rows.length > 0) {
          otherAffectedAptIds.add(row.apartment_id);
        } else {
          expiredAptIds.add(row.apartment_id);
        }
      }
    }
  }
  if (scheduledTerminated.rowCount > 0) {
    console.log(`[DailyJob] scheduled contract terminations finalized: ${scheduledTerminated.rowCount}`);
  }

  // 1b. Hợp đồng đến/quá ngày kết thúc (nửa mở [start_date, end_date) -> end_date <= CURRENT_DATE là đã kết thúc) (R-02)
  const expired = await adminPool.query(
    `UPDATE contract SET status = 'EXPIRED', updated_at = NOW()
     WHERE status IN ('ACTIVE', 'RENEWAL_PENDING') AND end_date <= CURRENT_DATE
     RETURNING *`
  );
  for (const row of expired.rows) {
    const endDateStr = getTodayVnDateStr(row.end_date);
    const refundDays = await resolveBuildingRefundDays(row.building_id);
    const { dueAt } = refundDeadline(endDateStr, refundDays);
    await adminPool.query(
      `UPDATE deposit
       SET refund_due_date = $1, updated_at = NOW()
       WHERE contract_id = $2
         AND status NOT IN ('REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED')
         AND refund_due_date IS NULL`,
      [dueAt, row.id]
    );

    // 6A Sync: đồng bộ hóa đơn & đóng subscription khi hợp đồng hết hạn tự nhiên
    try {
      await closeContractBillingAndSubscriptionsInTx(adminPool, {
        contract: row,
        explicitEndYmd: endDateStr,
        isNaturalExpiry: true,
        actorId: null,
        reason: 'Hết hạn hợp đồng tự nhiên',
      });
    } catch (closeErr) {
      console.error('[DailyJob] Step 1b closeContract error:', closeErr.message);
    }

    // Kết chuyển credit_balance sang hợp đồng gia hạn con (nếu có)
    try {
      const childRenewRes = await adminPool.query(
        `SELECT id, building_id FROM contract
         WHERE parent_contract_id = $1
           AND status IN ('ACTIVE', 'RENEWAL_PENDING')
         ORDER BY created_at DESC LIMIT 1`,
        [row.id]
      );
      if (childRenewRes.rows.length > 0) {
        await transferContractCreditsInTx(adminPool, {
          fromContractId: row.id,
          toContractId: childRenewRes.rows[0].id,
          toBuildingId: childRenewRes.rows[0].building_id,
          actorId: null,
          reason: 'Kết chuyển số dư tín dụng khi hợp đồng cũ hết hạn',
        });
      }
    } catch (xferErr) {
      console.error('[DailyJob] Step 1b transferCredits error:', xferErr.message);
    }

    if (row.apartment_id) {
      // Nếu có HĐ gia hạn con nối tiếp bắt đầu hôm nay (cùng khách ở tiếp), không ép sang MAINTENANCE
      const childContinue = await adminPool.query(
        `SELECT 1 FROM contract
         WHERE parent_contract_id = $1
           AND apartment_id = $2
           AND status IN ('ACTIVE', 'RENEWAL_PENDING')
           AND start_date <= CURRENT_DATE
           AND COALESCE(terminated_at, end_date) > CURRENT_DATE
         LIMIT 1`,
        [row.id, row.apartment_id]
      );
      if (childContinue.rows.length > 0) {
        otherAffectedAptIds.add(row.apartment_id);
      } else {
        expiredAptIds.add(row.apartment_id);
      }
    }
  }
  console.log(`[DailyJob] contract expired: ${expired.rowCount}`);

  // 2. Các căn hộ đang RESERVED/AVAILABLE nhưng HĐ ACTIVE đã tới ngày bắt đầu (start_date <= CURRENT_DATE)
  const dueStartApts = await adminPool.query(
    `SELECT DISTINCT a.id AS apartment_id
     FROM apartment a
     JOIN contract c ON c.apartment_id = a.id
     WHERE a.status IN ('RESERVED', 'AVAILABLE')
       AND c.status IN ('ACTIVE', 'RENEWAL_PENDING')
       AND c.start_date <= CURRENT_DATE
       AND COALESCE(c.terminated_at, c.end_date) > CURRENT_DATE`
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
       AND hold_until < CURRENT_DATE
     RETURNING id`
  );
  if (rsvPendingRejected.rowCount > 0) {
    console.log(`[DailyJob] unconfirmed public reservations rejected: ${rsvPendingRejected.rowCount}`);
  }

  // 3b. Giữ chỗ đã xác nhận tiền (HELD) quá hạn -> chuyển sang EXPIRED
  const rsvExpired = await adminPool.query(
    `UPDATE reservation SET status = 'EXPIRED', updated_at = NOW()
     WHERE status = 'HELD' AND hold_until IS NOT NULL AND hold_until < CURRENT_DATE
     RETURNING apartment_id`
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
       AND NOT EXISTS (SELECT 1 FROM reservation r WHERE r.apartment_id = a.id AND r.status IN ('HELD', 'CANCEL_PENDING_APPROVAL') AND (r.hold_until IS NULL OR r.hold_until >= CURRENT_DATE))
       AND NOT EXISTS (SELECT 1 FROM contract c WHERE c.apartment_id = a.id AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING') AND COALESCE(c.terminated_at, c.end_date) > CURRENT_DATE)`
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

  // 5. FR-066 & R-05: Tự động sinh hóa đơn định kỳ theo billing_day (xử lý ngày 29/30/31 vào cuối tháng ngắn)
  try {
    const dbNowRes = await adminPool.query(
      `SELECT CURRENT_DATE::text AS today_str,
              EXTRACT(DAY FROM CURRENT_DATE)::int AS day_of_month,
              EXTRACT(DAY FROM (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day'))::int AS days_in_month`
    );
    const { today_str: todayStr, day_of_month: dayOfMonth, days_in_month: daysInCurrentMonth } = dbNowRes.rows[0];
    const currentPeriod = todayStr.slice(0, 7);
    const matchDays = [dayOfMonth];
    if (dayOfMonth === daysInCurrentMonth && daysInCurrentMonth < 31) {
      for (let d = daysInCurrentMonth + 1; d <= 31; d++) matchDays.push(d);
    }

    const orgsRes = await adminPool.query('SELECT id FROM organization');
    let autoCreatedTotal = 0;
    for (const orgRow of orgsRes.rows) {
      const txClient = await adminPool.connect();
      try {
        await txClient.query('BEGIN');
        const { createdInvoices } = await generateInvoicesCore(txClient, {
          orgId: orgRow.id,
          targetPeriod: currentPeriod,
          matchBillingDays: matchDays,
          onlyOngoingContracts: false,
          excludeSettledDeposits: true,
          autoIssue: false,
          actorId: null,
        });
        await txClient.query('COMMIT');
        autoCreatedTotal += createdInvoices.length;
      } catch (genErr) {
        await txClient.query('ROLLBACK').catch(() => {});
        console.error('[DailyJob] auto-billing org error:', genErr.message);
      } finally {
        txClient.release();
      }
    }
    if (autoCreatedTotal > 0) {
      console.log(`[DailyJob] auto-generated invoices for billing_day=${matchDays.join(',')}: ${autoCreatedTotal}`);
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
       AND due_date < (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
     RETURNING id, org_id, total_amount, paid_amount`
  );
  for (const row of overdueInvoices.rows) {
    await adminPool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES (NULL, 'MARK_INVOICE_OVERDUE', 'invoice', $1, NULL, $2)`,
      [row.id, JSON.stringify({ status: 'OVERDUE', id: row.id })]
    );
  }
  if (overdueInvoices.rowCount > 0) {
    console.log(`[DailyJob] invoices marked OVERDUE: ${overdueInvoices.rowCount}`);
  }

  // 7. R-11 & FR-064: Tự động cộng phí phạt chậm thanh toán append-only 100.000 ₫/ngày từ ngày quá hạn thứ 6
  // deltaFee = GREATEST(0, expectedFee - gross_accrued_late_fee) để bảo toàn 100% dòng miễn giảm LATE_FEE
  const LATE_FEE_PER_DAY = 100000;
  const GRACE_DAYS = 5;
  const lateInvoices = await adminPool.query(
    `SELECT i.id,
            i.due_date,
            i.subtotal_amount,
            i.adjustment_amount,
            i.total_amount,
            i.paid_amount,
            ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - i.due_date)::int AS overdue_days,
            COALESCE(lf.gross_late_fee, 0)::bigint AS gross_accrued_late_fee
     FROM invoice i
     LEFT JOIN (
       SELECT invoice_id, SUM(amount)::bigint AS gross_late_fee
       FROM invoice_line
       WHERE item_type = 'LATE_FEE' AND amount > 0
       GROUP BY invoice_id
     ) lf ON lf.invoice_id = i.id
     WHERE i.status IN ('OVERDUE', 'ISSUED', 'PARTIALLY_PAID', 'ADJUSTED')
       AND i.paid_amount < i.total_amount
       AND ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - i.due_date) > $1`,
    [GRACE_DAYS]
  );

  for (const inv of lateInvoices.rows) {
    const penaltyDays = Number(inv.overdue_days) - GRACE_DAYS;
    if (penaltyDays <= 0) continue;
    const expectedFee = roundVND(penaltyDays * LATE_FEE_PER_DAY);
    const grossAccruedFee = Number(inv.gross_accrued_late_fee || 0);
    const deltaFee = Math.max(0, expectedFee - grossAccruedFee);

    if (deltaFee > 0) {
      const txClient = await adminPool.connect();
      try {
        await txClient.query('BEGIN');
        const deltaDays = Math.round(deltaFee / LATE_FEE_PER_DAY);
        await txClient.query(
          `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
           VALUES ($1, 'LATE_FEE', $2, $3, 'ngày', $4, $5)`,
          [
            inv.id,
            `Phạt chậm thanh toán (${penaltyDays} ngày sau ${GRACE_DAYS} ngày ân hạn × 100.000 ₫/ngày)`,
            deltaDays,
            LATE_FEE_PER_DAY,
            deltaFee,
          ]
        );
        await txClient.query(
          `UPDATE invoice
           SET subtotal_amount = subtotal_amount + $1,
               total_amount = total_amount + $1,
               status = CASE WHEN status = 'ISSUED' THEN 'OVERDUE' ELSE status END,
               updated_at = NOW()
           WHERE id = $2`,
          [deltaFee, inv.id]
        );
        await txClient.query(
          `UPDATE receivable
           SET amount = amount + $1,
               updated_at = NOW()
           WHERE invoice_id = $2
             AND status IN ('OPEN', 'PARTIALLY_PAID')`,
          [deltaFee, inv.id]
        );
        await txClient.query(
          `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
           VALUES (NULL, 'ACCRUE_LATE_FEE', 'invoice', $1, NULL, $2)`,
          [
            inv.id,
            JSON.stringify({
              delta_fee: deltaFee,
              expected_fee: expectedFee,
              gross_accrued_fee: grossAccruedFee,
              penalty_days: penaltyDays,
            }),
          ]
        );
        await txClient.query('COMMIT');
      } catch (lfErr) {
        await txClient.query('ROLLBACK').catch(() => {});
        console.error('[DailyJob] late fee error:', lfErr.message);
      } finally {
        txClient.release();
      }
    }
  }

  // 8. FR-039 & PRD Mục 10.1 & 12.4: Nhắc nợ tự động đa mốc (-3, 0, +3, +7, +15 ngày)
  try {
    const billingConfigsRes = await adminPool.query(
      `SELECT org_id, value FROM system_setting WHERE key = 'billing_config'`
    );
    const orgReminderDaysMap = new Map();
    for (const r of billingConfigsRes.rows) {
      const val = r.value || {};
      const days = Array.isArray(val.reminder_days) ? val.reminder_days.map(Number) : [3, 7, 15];
      orgReminderDaysMap.set(r.org_id, days);
    }

    const unpaidInvoicesRes = await adminPool.query(
      `SELECT i.id,
              i.org_id,
              i.contract_id,
              i.invoice_code,
              i.period,
              i.total_amount,
              i.paid_amount,
              i.due_date,
              ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - i.due_date)::int AS days_diff,
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
         AND au.status = 'ACTIVE'`
    );

    let remindersSent = 0;
    for (const inv of unpaidInvoicesRes.rows) {
      const daysDiff = Number(inv.days_diff);
      const reminderDays = orgReminderDaysMap.get(inv.org_id) || [3, 7, 15];

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

  // 8. FR-018 & R-22: Cảnh báo hợp đồng sắp hết hạn (60 ngày chỉ MANAGER; 30 & 15 ngày cả MANAGER + RESIDENT)
  const expiringContracts = await adminPool.query(
    `SELECT c.id, c.building_id, c.primary_tenant_id, c.end_date,
            (c.end_date - CURRENT_DATE)::int AS days_left,
            b.org_id, b.name AS building_name, a.code AS apartment_code
     FROM contract c
     JOIN building b ON b.id = c.building_id
     JOIN apartment a ON a.id = c.apartment_id
     WHERE c.status IN ('ACTIVE', 'RENEWAL_PENDING')
       AND (c.end_date - CURRENT_DATE) IN (60, 30, 15)`
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
         SELECT $1, $2, $3, $4, 'CONTRACT_EXPIRY', $5
         WHERE NOT EXISTS (
           SELECT 1 FROM notification n
           WHERE n.user_id = $2
             AND n.type = 'CONTRACT_EXPIRY'
             AND (n.payload->>'contract_id')::uuid = $6::uuid
             AND (n.payload->>'days_left')::int = $7::int
             AND n.created_at::date = CURRENT_DATE
         )`,
        [
          c.org_id,
          item.userId,
          `Hợp đồng căn ${c.apartment_code} sắp hết hạn`,
          `Hợp đồng thuê căn ${c.apartment_code} (${c.building_name}) còn ${daysLeft} ngày là hết hạn (ngày kết thúc: ${endDateStr}). Vui lòng liên hệ để gia hạn hoặc chuẩn bị bàn giao.`,
          JSON.stringify({ contract_id: c.id, days_left: daysLeft, link: item.link }),
          c.id,
          daysLeft,
        ]
      );
    }
  }

  // 9. FR-068 & R-15: Cảnh báo hạn hoàn cọc cho cả TERMINATED và EXPIRED, và mọi trạng thái chưa tất toán xong
  await runOverdueDepositSettlementAlerts();
}

export async function runOverdueDepositSettlementAlerts() {
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
            (CURRENT_DATE - COALESCE(c.terminated_at, c.end_date))::int AS days_since_end,
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
       AND COALESCE(c.terminated_at, c.end_date) IS NOT NULL`
  );

  const todayStr = getTodayVnDateStr();
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
             AND n.created_at::date = CURRENT_DATE
         )`,
        [
          dep.org_id,
          userId,
          title,
          content,
          isOverdue ? 'DEPOSIT_OVERDUE_5D' : 'DEPOSIT_WARNING_3D',
          JSON.stringify({ deposit_id: dep.deposit_id, contract_id: dep.contract_id, days_since: days, link: '/admin/deposits' }),
          dep.deposit_id,
        ]
      );
    }
  }
  // 9. Báo cáo tổng hợp Sổ cọc định kỳ đầu tháng gửi OWNER đang ACTIVE (1 lần/tháng/tòa — GAP-05, PRD 15.3)
  try {
    await sendMonthlyOwnerDepositReports(adminPool);
  } catch (monthlyErr) {
    console.error('[DailyJob] monthly owner deposit report error:', monthlyErr.message);
  }
}

export async function sendMonthlyOwnerDepositReports(dbPool = adminPool, refDate = new Date()) {
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
       AND r.code = 'OWNER'`
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

export function startDailyJobs() {
  runDailyJobs().catch((err) => console.error('[DailyJob] boot run failed:', err));
  setInterval(() => {
    runDailyJobs().catch((err) => console.error('[DailyJob] scheduled run failed:', err));
  }, 24 * 60 * 60 * 1000);
}
