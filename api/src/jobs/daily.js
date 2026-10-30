// Job hằng ngày (B5): hết hạn hợp đồng -> EXPIRED; đồng bộ trạng thái căn hộ (back-to-back RESERVED -> OCCUPIED / AVAILABLE);
// hết hạn giữ chỗ -> EXPIRED + mở căn lại; cảnh báo sắp hết hạn HĐ & hạn hoàn cọc 5 ngày (FR-068).
// Chạy bằng adminPool vì job không có user context — RLS default-deny sẽ chặn im lặng nếu đi qua appPool.
import { adminPool } from '../db/client.js';
import { syncApartmentStatus } from '../services/apartmentStatus.js';

export async function runDailyJobs() {
  const affectedAptIds = new Set();

  // 1. Hợp đồng đến/quá ngày kết thúc (nửa mở [start_date, end_date) -> end_date <= CURRENT_DATE là đã kết thúc)
  const expired = await adminPool.query(
    `UPDATE contract SET status = 'EXPIRED', updated_at = NOW()
     WHERE status IN ('ACTIVE', 'RENEWAL_PENDING') AND end_date <= CURRENT_DATE
     RETURNING apartment_id`
  );
  expired.rows.forEach((r) => affectedAptIds.add(r.apartment_id));
  console.log(`[DailyJob] contract expired: ${expired.rowCount}`);

  // 2. Các căn hộ đang RESERVED nhưng HĐ ACTIVE đã tới ngày bắt đầu (start_date <= CURRENT_DATE)
  const dueStartApts = await adminPool.query(
    `SELECT DISTINCT a.id AS apartment_id
     FROM apartment a
     JOIN contract c ON c.apartment_id = a.id
     WHERE a.status IN ('RESERVED', 'AVAILABLE')
       AND c.status IN ('ACTIVE', 'RENEWAL_PENDING')
       AND c.start_date <= CURRENT_DATE
       AND COALESCE(c.terminated_at, c.end_date) > CURRENT_DATE`
  );
  dueStartApts.rows.forEach((r) => affectedAptIds.add(r.apartment_id));

  // 3. Giữ chỗ quá hạn
  const rsvExpired = await adminPool.query(
    `UPDATE reservation SET status = 'EXPIRED', updated_at = NOW()
     WHERE status = 'HELD' AND hold_until IS NOT NULL AND hold_until < CURRENT_DATE
     RETURNING apartment_id`
  );
  rsvExpired.rows.forEach((r) => affectedAptIds.add(r.apartment_id));
  console.log(`[DailyJob] reservation expired: ${rsvExpired.rowCount}`);

  // 4. Các căn đang RESERVED mồ côi (không còn giữ chỗ HELD hay HĐ mở)
  const orphanReserved = await adminPool.query(
    `SELECT a.id AS apartment_id
     FROM apartment a
     WHERE a.status = 'RESERVED'
       AND NOT EXISTS (SELECT 1 FROM reservation r WHERE r.apartment_id = a.id AND r.status = 'HELD' AND (r.hold_until IS NULL OR r.hold_until >= CURRENT_DATE))
       AND NOT EXISTS (SELECT 1 FROM contract c WHERE c.apartment_id = a.id AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING') AND COALESCE(c.terminated_at, c.end_date) > CURRENT_DATE)`
  );
  orphanReserved.rows.forEach((r) => affectedAptIds.add(r.apartment_id));

  for (const aptId of affectedAptIds) {
    if (aptId) {
      await syncApartmentStatus(adminPool, aptId);
    }
  }
  console.log(`[DailyJob] synced apartment statuses: ${affectedAptIds.size}`);

  // 5. FR-018: Cảnh báo hợp đồng sắp hết hạn (60/30/15 ngày)
  const expiringContracts = await adminPool.query(
    `SELECT c.id, c.building_id, c.primary_tenant_id, c.end_date,
            (c.end_date - CURRENT_DATE) AS days_left,
            b.org_id, b.name AS building_name, a.code AS apartment_code
     FROM contract c
     JOIN building b ON b.id = c.building_id
     JOIN apartment a ON a.id = c.apartment_id
     WHERE c.status IN ('ACTIVE', 'RENEWAL_PENDING')
       AND (c.end_date - CURRENT_DATE) IN (60, 30, 15)`
  );

  for (const c of expiringContracts.rows) {
    const managers = await adminPool.query(
      `SELECT ur.user_id FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       WHERE ur.building_id = $1 AND r.code = 'MANAGER'`,
      [c.building_id]
    );

    const resident = await adminPool.query(
      `SELECT u.id AS user_id FROM app_user u
       JOIN person p ON p.id = u.person_id
       JOIN tenant t ON t.person_id = p.id
       WHERE t.id = $1`,
      [c.primary_tenant_id]
    );

    const targetUserIds = [
      ...managers.rows.map((m) => m.user_id),
      ...(resident.rows.length > 0 ? [resident.rows[0].user_id] : []),
    ];

    const endDateStr = c.end_date.toISOString ? c.end_date.toISOString().split('T')[0] : String(c.end_date);
    for (const userId of targetUserIds) {
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
          userId,
          `Hợp đồng căn ${c.apartment_code} sắp hết hạn`,
          `Hợp đồng thuê căn ${c.apartment_code} (${c.building_name}) còn ${c.days_left} ngày là hết hạn (ngày kết thúc: ${endDateStr}). Vui lòng liên hệ để gia hạn hoặc chuẩn bị bàn giao.`,
          JSON.stringify({ contract_id: c.id, days_left: Number(c.days_left), link: '/admin/contracts' }),
          c.id,
          Number(c.days_left),
        ]
      );
    }
  }

  // 6. FR-068: Cảnh báo thời hạn hoàn cọc (ngày chấm dứt +3 cảnh báo nội bộ, +5 báo khẩn SYS_ADMIN & MANAGER)
  // Phương án 2: OWNER 100% Read-Only nên cảnh báo vận hành gửi tới SYS_ADMIN + MANAGER + ACCOUNTANT.
  const depositAlerts = await adminPool.query(
    `SELECT d.id AS deposit_id, d.contract_id, d.amount_held,
            c.terminated_at, c.building_id,
            b.org_id, a.code AS apartment_code, b.name AS building_name,
            (CURRENT_DATE - c.terminated_at) AS days_since_terminate
     FROM deposit d
     JOIN contract c ON c.id = d.contract_id
     JOIN building b ON b.id = c.building_id
     JOIN apartment a ON a.id = c.apartment_id
     WHERE d.status = 'HELD'
       AND c.status = 'TERMINATED'
       AND c.terminated_at IS NOT NULL
       AND (CURRENT_DATE - c.terminated_at) IN (3, 5)`
  );

  for (const dep of depositAlerts.rows) {
    const days = Number(dep.days_since_terminate);
    const isOverdue = days === 5;
    const title = isOverdue
      ? `[QUÁ HẠN] Hoàn cọc căn ${dep.apartment_code} đã quá 5 ngày`
      : `[CẢNH BÁO] Đến hạn hoàn cọc căn ${dep.apartment_code} (3 ngày)`;
    const content = isOverdue
      ? `Hợp đồng căn ${dep.apartment_code} đã chấm dứt được 5 ngày nhưng chưa hoàn tất thủ tục hoàn cọc (số tiền đang giữ: ${dep.amount_held} VND). Báo cáo khẩn gửi Quản trị hệ thống & Ban Quản Lý (FR-068).`
      : `Hợp đồng căn ${dep.apartment_code} đã chấm dứt 3 ngày. Vui lòng mở hồ sơ tất toán và hoàn cọc cho cư dân đúng hạn.`;

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
             AND r.code IN ('MANAGER', 'ACCOUNTANT')
             AND (ur.building_id = $2 OR (r.code = 'ACCOUNTANT' AND ur.building_id IS NULL))`,
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
