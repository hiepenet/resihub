// Job hằng ngày (B5): hết hạn hợp đồng → EXPIRED; flip căn RESERVED → OCCUPIED khi HĐ ACTIVE tới hạn;
// hết hạn giữ chỗ → EXPIRED + mở căn lại. Chạy bằng adminPool vì job không có user context —
// RLS default-deny sẽ chặn im lặng nếu đi qua appPool.
// ponytail: trong-process interval; tách worker container + distributed lock khi chạy đa instance (PRD 12.4).
import { adminPool } from '../db/client.js';

export async function runDailyJobs() {
  // 1. Hợp đồng quá hạn
  const expired = await adminPool.query(
    `UPDATE contract SET status='EXPIRED', updated_at=NOW()
     WHERE status IN ('ACTIVE','RENEWAL_PENDING') AND end_date < CURRENT_DATE`
  );
  console.log(`[DailyJob] contract expired: ${expired.rowCount}`);

  // 2. Căn RESERVED có HĐ ACTIVE vừa tới hạn → OCCUPIED
  const flipped = await adminPool.query(
    `UPDATE apartment SET status='OCCUPIED', updated_at=NOW()
     WHERE status='RESERVED'
       AND id IN (SELECT apartment_id FROM contract WHERE status='ACTIVE' AND start_date <= CURRENT_DATE)`
  );
  console.log(`[DailyJob] apartment RESERVED -> OCCUPIED: ${flipped.rowCount}`);

  // 3. Giữ chỗ quá hạn
  const rsvExpired = await adminPool.query(
    `UPDATE reservation SET status='EXPIRED', updated_at=NOW()
     WHERE status='HELD' AND hold_until IS NOT NULL AND hold_until < CURRENT_DATE`
  );
  console.log(`[DailyJob] reservation expired: ${rsvExpired.rowCount}`);

  // 4. Mở lại căn của giữ chỗ hết hạn — bắt buộc NOT EXISTS: không flip nhầm căn
  //    đang có giữ chỗ HELD mới hoặc hợp đồng hiệu lực ghim ở RESERVED.
  const reOpened = await adminPool.query(
    `UPDATE apartment a SET status='AVAILABLE', updated_at=NOW()
     WHERE a.status='RESERVED'
       AND NOT EXISTS (SELECT 1 FROM reservation r WHERE r.apartment_id = a.id AND r.status = 'HELD')
       AND NOT EXISTS (SELECT 1 FROM contract c WHERE c.apartment_id = a.id AND c.status IN ('ACTIVE','RENEWAL_PENDING'))`
  );
  console.log(`[DailyJob] apartment RESERVED -> AVAILABLE: ${reOpened.rowCount}`);

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
      // Lưu ý 3: Anti-duplicate check trong cùng ngày
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

  // 6. FR-068: Cảnh báo thời hạn hoàn cọc (ngày chấm dứt +3 cảnh báo, +5 báo Giám đốc)
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
      ? `Hợp đồng căn ${dep.apartment_code} đã chấm dứt được 5 ngày nhưng chưa hoàn tất thủ tục hoàn cọc (số tiền đang giữ: ${dep.amount_held} VND). Báo cáo khẩn gửi Giám đốc (FR-068).`
      : `Hợp đồng căn ${dep.apartment_code} đã chấm dứt 3 ngày. Vui lòng mở hồ sơ tất toán và hoàn cọc cho cư dân đúng hạn.`;

    const notifyUsers = isOverdue
      ? await adminPool.query(
          `SELECT ur.user_id FROM user_role ur
           JOIN role r ON r.id = ur.role_id
           WHERE r.code = 'OWNER'`
        )
      : await adminPool.query(
          `SELECT ur.user_id FROM user_role ur
           JOIN role r ON r.id = ur.role_id
           WHERE (ur.building_id = $1 AND r.code = 'MANAGER') OR r.code = 'OWNER'`,
          [dep.building_id]
        );

    for (const u of notifyUsers.rows) {
      // Lưu ý 3: Anti-duplicate check
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
