// Job hằng ngày (B5, R-01, R-02, R-05, R-11, R-15, R-22):
// 1. Hết hạn hợp đồng -> EXPIRED + chuyển căn sang MAINTENANCE chờ bàn giao (trừ khi có HĐ gia hạn con nối tiếp ngay) + gán hạn hoàn cọc +5 ngày
// 2. Đồng bộ trạng thái căn hộ (HĐ tới ngày bắt đầu, giữ chỗ quá hạn, RESERVED mồ côi)
// 3. Tự động sinh hóa đơn hàng tháng theo billing_day (FR-066)
// 4. Tự động chuyển hóa đơn quá hạn sang OVERDUE & cộng phạt chậm thanh toán 100.000 ₫/ngày từ ngày quá hạn thứ 6 (không trần tối đa)
// 5. Cảnh báo sắp hết hạn HĐ: 60 ngày chỉ gửi MANAGER; 30 & 15 ngày gửi MANAGER + RESIDENT (FR-018)
// 6. Cảnh báo hạn hoàn cọc cho cả HĐ TERMINATED và EXPIRED trên mọi trạng thái chưa tất toán xong (FR-068)
import { adminPool } from '../db/client.js';
import { syncApartmentStatus } from '../services/apartmentStatus.js';
import { refundDeadline } from '../services/deadlines.js';
import { generateInvoicesCore } from '../routes/invoices.js';
import { roundVND } from '../services/pricing.js';

export async function runDailyJobs() {
  const expiredAptIds = new Set();
  const otherAffectedAptIds = new Set();

  // 1a. Hợp đồng đang chờ bàn giao chấm dứt (TERMINATION_PENDING) đã đến ngày hẹn trả phòng -> tự động chuyển sang TERMINATED
  const scheduledTerminated = await adminPool.query(
    `UPDATE contract
     SET status = 'TERMINATED',
         terminated_at = COALESCE(terminated_at, end_date),
         updated_at = NOW()
     WHERE status = 'TERMINATION_PENDING'
       AND COALESCE(terminated_at, end_date) <= CURRENT_DATE
     RETURNING id, apartment_id, start_date, COALESCE(terminated_at, end_date) AS eff_end_date`
  );
  for (const row of scheduledTerminated.rows) {
    const termStr = row.eff_end_date?.toISOString
      ? row.eff_end_date.toISOString().slice(0, 10)
      : String(row.eff_end_date).slice(0, 10);
    const sDateStr = row.start_date?.toISOString
      ? row.start_date.toISOString().slice(0, 10)
      : String(row.start_date).slice(0, 10);
    const { dueAt } = refundDeadline(termStr);
    await adminPool.query(
      `UPDATE deposit
       SET refund_due_date = $1, updated_at = NOW()
       WHERE contract_id = $2
         AND status NOT IN ('REFUNDED', 'PARTIALLY_REFUNDED', 'TRANSFERRED')
         AND refund_due_date IS NULL`,
      [dueAt, row.id]
    );

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
     RETURNING id, apartment_id, end_date`
  );
  for (const row of expired.rows) {
    const endDateStr = row.end_date?.toISOString ? row.end_date.toISOString().slice(0, 10) : String(row.end_date).slice(0, 10);
    const { dueAt } = refundDeadline(endDateStr);
    await adminPool.query(
      `UPDATE deposit
       SET refund_due_date = $1, updated_at = NOW()
       WHERE contract_id = $2
         AND status NOT IN ('REFUNDED', 'PARTIALLY_REFUNDED', 'TRANSFERRED')
         AND refund_due_date IS NULL`,
      [dueAt, row.id]
    );

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

  // 3. Giữ chỗ quá hạn
  const rsvExpired = await adminPool.query(
    `UPDATE reservation SET status = 'EXPIRED', updated_at = NOW()
     WHERE status = 'HELD' AND hold_until IS NOT NULL AND hold_until < CURRENT_DATE
     RETURNING apartment_id`
  );
  rsvExpired.rows.forEach((r) => {
    if (!expiredAptIds.has(r.apartment_id)) otherAffectedAptIds.add(r.apartment_id);
  });
  console.log(`[DailyJob] reservation expired: ${rsvExpired.rowCount}`);

  // 4. Các căn đang RESERVED mồ côi (không còn giữ chỗ HELD hay HĐ mở)
  const orphanReserved = await adminPool.query(
    `SELECT a.id AS apartment_id
     FROM apartment a
     WHERE a.status = 'RESERVED'
       AND NOT EXISTS (SELECT 1 FROM reservation r WHERE r.apartment_id = a.id AND r.status = 'HELD' AND (r.hold_until IS NULL OR r.hold_until >= CURRENT_DATE))
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
          onlyOngoingContracts: true,
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

  // 6. R-05: Tự động chuyển hóa đơn quá hạn sang OVERDUE
  const overdueUpdate = await adminPool.query(
    `UPDATE invoice
     SET status = 'OVERDUE', updated_at = NOW()
     WHERE status IN ('ISSUED', 'PARTIALLY_PAID')
       AND due_date < CURRENT_DATE`
  );
  if (overdueUpdate.rowCount > 0) {
    console.log(`[DailyJob] invoices marked OVERDUE: ${overdueUpdate.rowCount}`);
  }

  // 7. R-11: Tự động cộng phí phạt chậm thanh toán 100.000 ₫/ngày từ ngày quá hạn thứ 6 (sau 5 ngày ân hạn, không giới hạn trần)
  const LATE_FEE_PER_DAY = 100000;
  const GRACE_DAYS = 5;
  const lateInvoices = await adminPool.query(
    `SELECT i.id,
            i.due_date,
            i.subtotal_amount,
            i.adjustment_amount,
            i.total_amount,
            (CURRENT_DATE - i.due_date)::int AS overdue_days,
            COALESCE(lf.total_late_fee, 0)::bigint AS existing_late_fee
     FROM invoice i
     LEFT JOIN (
       SELECT invoice_id, SUM(amount)::bigint AS total_late_fee
       FROM invoice_line
       WHERE item_type = 'LATE_FEE'
       GROUP BY invoice_id
     ) lf ON lf.invoice_id = i.id
     WHERE i.status IN ('OVERDUE', 'ISSUED', 'PARTIALLY_PAID')
       AND (CURRENT_DATE - i.due_date) > $1`,
    [GRACE_DAYS]
  );

  for (const inv of lateInvoices.rows) {
    const penaltyDays = Number(inv.overdue_days) - GRACE_DAYS;
    if (penaltyDays <= 0) continue;
    const expectedFee = roundVND(penaltyDays * LATE_FEE_PER_DAY);
    const existingFee = Number(inv.existing_late_fee || 0);
    const deltaFee = expectedFee - existingFee;

    if (deltaFee > 0) {
      const txClient = await adminPool.connect();
      try {
        await txClient.query('BEGIN');
        await txClient.query(
          `DELETE FROM invoice_line WHERE invoice_id = $1 AND item_type = 'LATE_FEE'`,
          [inv.id]
        );
        await txClient.query(
          `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
           VALUES ($1, 'LATE_FEE', $2, $3, 'ngày', $4, $5)`,
          [
            inv.id,
            `Phạt chậm thanh toán (${penaltyDays} ngày sau ${GRACE_DAYS} ngày ân hạn × 100.000 ₫/ngày)`,
            penaltyDays,
            LATE_FEE_PER_DAY,
            expectedFee,
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
        await txClient.query('COMMIT');
      } catch (lfErr) {
        await txClient.query('ROLLBACK').catch(() => {});
        console.error('[DailyJob] late fee error:', lfErr.message);
      } finally {
        txClient.release();
      }
    }
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
  const depositAlerts = await adminPool.query(
    `SELECT d.id AS deposit_id,
            d.contract_id,
            d.amount_held,
            d.status AS deposit_status,
            d.refund_due_date,
            COALESCE(c.terminated_at, c.end_date) AS end_ref,
            c.building_id,
            b.org_id,
            a.code AS apartment_code,
            b.name AS building_name,
            (CURRENT_DATE - COALESCE(c.terminated_at, c.end_date))::int AS days_since_end
     FROM deposit d
     JOIN contract c ON c.id = d.contract_id
     JOIN building b ON b.id = c.building_id
     JOIN apartment a ON a.id = c.apartment_id
     WHERE d.status NOT IN ('REFUNDED', 'PARTIALLY_REFUNDED', 'TRANSFERRED')
       AND d.amount_held > 0
       AND c.status IN ('TERMINATED', 'EXPIRED')
       AND COALESCE(c.terminated_at, c.end_date) IS NOT NULL
       AND (
         (CURRENT_DATE - COALESCE(c.terminated_at, c.end_date)) = 3
         OR (CURRENT_DATE - COALESCE(c.terminated_at, c.end_date)) >= 5
         OR (d.refund_due_date IS NOT NULL AND CURRENT_DATE = (d.refund_due_date - INTERVAL '2 days')::date)
         OR (d.refund_due_date IS NOT NULL AND CURRENT_DATE >= d.refund_due_date)
       )`
  );

  for (const dep of depositAlerts.rows) {
    const days = Number(dep.days_since_end);
    const isOverdue =
      days >= 5 ||
      (dep.refund_due_date && new Date() >= new Date(`${String(dep.refund_due_date).slice(0, 10)}T00:00:00`));
    const title = isOverdue
      ? `[QUÁ HẠN] Hoàn cọc căn ${dep.apartment_code} đã quá hạn 5 ngày`
      : `[CẢNH BÁO] Đến hạn hoàn cọc căn ${dep.apartment_code} (còn 2 ngày)`;
    const content = isOverdue
      ? `Hợp đồng căn ${dep.apartment_code} đã kết thúc ${days} ngày nhưng chưa hoàn tất thủ tục hoàn cọc (trạng thái: ${dep.deposit_status}, số tiền đang giữ: ${Number(dep.amount_held).toLocaleString('vi-VN')} ₫). Báo cáo khẩn gửi Quản trị hệ thống & Ban Quản Lý (FR-068).`
      : `Hợp đồng căn ${dep.apartment_code} đã kết thúc ${days} ngày. Vui lòng hoàn tất hồ sơ tất toán và hoàn cọc cho cư dân đúng hạn 5 ngày.`;

    const notifyUsers = isOverdue
      ? await adminPool.query(
          `SELECT DISTINCT ur.user_id
           FROM user_role ur
           JOIN role r ON r.id = ur.role_id
           JOIN app_user au ON au.id = ur.user_id
           JOIN person p ON p.id = au.person_id
           WHERE p.org_id = $1
             AND (r.code = 'SYS_ADMIN' OR (r.code = 'MANAGER' AND ur.building_id = $2))`,
          [dep.org_id, dep.building_id]
        )
      : await adminPool.query(
          `SELECT DISTINCT ur.user_id
           FROM user_role ur
           JOIN role r ON r.id = ur.role_id
           JOIN app_user au ON au.id = ur.user_id
           JOIN person p ON p.id = au.person_id
           WHERE p.org_id = $1
             AND r.code = 'MANAGER'
             AND ur.building_id = $2`,
          [dep.org_id, dep.building_id]
        );

    for (const u of notifyUsers.rows) {
      await adminPool.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         SELECT $1, $2, $3, $4, $5, $6
         WHERE NOT EXISTS (
           SELECT 1 FROM notification n
           WHERE n.user_id = $2
             AND n.type = $5
             AND (n.payload->>'deposit_id')::uuid = $7::uuid
             AND n.created_at::date = CURRENT_DATE
         )`,
        [
          dep.org_id,
          u.user_id,
          title,
          content,
          isOverdue ? 'DEPOSIT_OVERDUE_5D' : 'DEPOSIT_WARNING_3D',
          JSON.stringify({ deposit_id: dep.deposit_id, contract_id: dep.contract_id, days_since: days, link: '/admin/deposits' }),
          dep.deposit_id,
        ]
      );
    }
  }
}

export function startDailyJobs() {
  runDailyJobs().catch((err) => console.error('[DailyJob] boot run failed:', err));
  setInterval(() => {
    runDailyJobs().catch((err) => console.error('[DailyJob] scheduled run failed:', err));
  }, 24 * 60 * 60 * 1000);
}
