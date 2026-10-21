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
}

export function startDailyJobs() {
  runDailyJobs().catch((err) => console.error('[DailyJob] boot run failed:', err));
  setInterval(() => {
    runDailyJobs().catch((err) => console.error('[DailyJob] scheduled run failed:', err));
  }, 24 * 60 * 60 * 1000);
}
