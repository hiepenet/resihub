// Máy trạng thái căn hộ theo FR-008 (PRD): AVAILABLE, RESERVED, OCCUPIED, MAINTENANCE, INACTIVE.
// Chỉ dùng cho guard nội bộ luồng nghiệp vụ (HĐ, giữ chỗ, bàn giao).
// Route PATCH /apartments/:id chặn riêng target OCCUPIED/RESERVED — không tự đổi tay.

export const APARTMENT_STATUSES = ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE'];

export const APARTMENT_TRANSITIONS = {
  AVAILABLE: ['RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE'],
  RESERVED: ['AVAILABLE', 'OCCUPIED'],
  OCCUPIED: ['MAINTENANCE'],
  MAINTENANCE: ['AVAILABLE', 'INACTIVE'],
  INACTIVE: ['AVAILABLE'],
};

export function isTransitionAllowed(from, to) {
  return from !== to && Boolean(APARTMENT_TRANSITIONS[from]?.includes(to));
}

/**
 * Đồng bộ trạng thái thực tế của căn hộ dựa trên hợp đồng hiệu lực, hợp đồng tương lai và phiếu giữ chỗ.
 * Thứ tự ưu tiên:
 *   1. Căn đang INACTIVE -> giữ nguyên INACTIVE.
 *   2. enterMaintenance = true (vừa trả phòng thực tế) -> chuyển sang MAINTENANCE.
 *   3. Có hợp đồng đang ở tại thời điểm hiện tại (start_date <= CURRENT_DATE < COALESCE(terminated_at, end_date)) -> OCCUPIED.
 *   4. Căn đang MAINTENANCE và leaveMaintenance = false -> giữ nguyên MAINTENANCE chờ nghiệm thu.
 *   5. Có hợp đồng hiệu lực tương lai (start_date > CURRENT_DATE) hoặc giữ chỗ HELD còn hạn -> RESERVED.
 *   6. Ngược lại -> AVAILABLE.
 */
export async function syncApartmentStatus(
  client,
  apartmentId,
  { enterMaintenance = false, leaveMaintenance = false } = {}
) {
  const aptRes = await client.query(
    `SELECT id, status FROM apartment WHERE id = $1 FOR UPDATE`,
    [apartmentId]
  );
  if (aptRes.rows.length === 0) return null;

  const currentStatus = aptRes.rows[0].status;
  if (currentStatus === 'INACTIVE') {
    return 'INACTIVE';
  }

  let targetStatus = null;

  if (enterMaintenance) {
    targetStatus = 'MAINTENANCE';
  } else {
    const currentActiveRes = await client.query(
      `SELECT 1
       FROM contract
       WHERE apartment_id = $1
         AND status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
         AND start_date <= CURRENT_DATE
         AND COALESCE(terminated_at, end_date) > CURRENT_DATE
       LIMIT 1`,
      [apartmentId]
    );

    if (currentActiveRes.rows.length > 0) {
      targetStatus = 'OCCUPIED';
    } else if (currentStatus === 'MAINTENANCE' && !leaveMaintenance) {
      targetStatus = 'MAINTENANCE';
    } else {
      const futureOrHoldRes = await client.query(
        `SELECT 1
         FROM contract
         WHERE apartment_id = $1
           AND status IN ('ACTIVE', 'RENEWAL_PENDING')
           AND start_date > CURRENT_DATE
         UNION ALL
         SELECT 1
         FROM reservation
         WHERE apartment_id = $1
           AND status = 'HELD'
           AND (hold_until IS NULL OR hold_until >= CURRENT_DATE)
         LIMIT 1`,
        [apartmentId]
      );
      targetStatus = futureOrHoldRes.rows.length > 0 ? 'RESERVED' : 'AVAILABLE';
    }
  }

  if (targetStatus !== currentStatus) {
    await client.query(
      `UPDATE apartment SET status = $2, updated_at = NOW() WHERE id = $1`,
      [apartmentId, targetStatus]
    );
  }

  return targetStatus;
}
