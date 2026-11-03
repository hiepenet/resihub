import { adminPool } from '../db/client.js';

/**
 * Làm tròn số tiền VND đến hàng nghìn gần nhất — ROUND(x, -3)
 * Ví dụ: 123456 -> 123000; 123500 -> 124000; -123600 -> -124000
 */
export function roundVND(amount) {
  const num = Number(amount || 0);
  if (!Number.isFinite(num) || num === 0) return 0;
  const sign = num < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(num) / 1000) * 1000;
}

/**
 * Tính phí pro-rata chia theo số ngày thực tế trong tháng (FR-063, PRD 10.3):
 * ROUND(monthlyPrice * quantity * activeDays / daysInMonth, -3)
 */
export function calcProrata({ monthlyPrice, quantity = 1, activeDays, daysInMonth } = {}) {
  const price = Number(monthlyPrice || 0);
  const qty = Number(quantity ?? 1);
  const active = Number(activeDays || 0);
  const totalDays = Number(daysInMonth || 0);
  if (!Number.isFinite(price) || !Number.isFinite(qty) || active <= 0 || totalDays <= 0) {
    return 0;
  }
  if (active >= totalDays) {
    return roundVND(price * qty);
  }
  return roundVND((price * qty * active) / totalDays);
}

/**
 * Tính tiền điện / nước theo sản lượng tiêu thụ cố định 1 bậc (FR-030, FR-063).
 * Ném RangeError('INVALID_READING') nếu chỉ số mới nhỏ hơn chỉ số cũ.
 */
export function calcUtility({ previousReading, currentReading, unitPrice } = {}) {
  const prev = Number(previousReading ?? 0);
  const curr = Number(currentReading ?? 0);
  const price = Number(unitPrice ?? 0);
  if (!Number.isFinite(prev) || !Number.isFinite(curr) || curr < prev) {
    throw new RangeError('INVALID_READING: currentReading must be >= previousReading');
  }
  const consumption = Number((curr - prev).toFixed(4));
  return roundVND(consumption * price);
}

/**
 * Kiểm tra cấu hình hệ thống có cho phép tự phê duyệt (allow_self_approval) hay không (AC-017.3 / R-23).
 * Nếu creatorId === actorId:
 *   - Khi allow_self_approval = false (mặc định): trả { allowed: false }
 *   - Khi allow_self_approval = true: ghi bắt buộc cảnh báo SELF_APPROVAL_WARNING vào audit_log và trả { allowed: true, selfApproved: true }
 */
export async function checkFourEyesOrWarn({
  orgId,
  actorId,
  creatorId,
  entity,
  entityId,
  actionContext = 'APPROVE',
}) {
  if (!creatorId || !actorId || String(creatorId) !== String(actorId)) {
    return { allowed: true, selfApproved: false };
  }

  let allowSelf = false;
  if (orgId) {
    try {
      const cfgRes = await adminPool.query(
        `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'approval_config' LIMIT 1`,
        [orgId]
      );
      const val = cfgRes.rows[0]?.value;
      allowSelf = Boolean(val && val.allow_self_approval === true);
    } catch (err) {
      console.warn('[FourEyes Config Lookup Warning]:', err.message);
    }
  }

  if (!allowSelf) {
    return { allowed: false, selfApproved: false };
  }

  try {
    await adminPool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'SELF_APPROVAL_WARNING', $2, $3, $4)`,
      [
        actorId,
        entity,
        entityId,
        JSON.stringify({
          warning: 'Người lập tự phê duyệt do cấu hình allow_self_approval = true (AC-017.3)',
          context: actionContext,
          actor_id: actorId,
          creator_id: creatorId,
        }),
      ]
    );
  } catch (err) {
    console.warn('[FourEyes SelfApproval Audit Warning]:', err.message);
  }

  return { allowed: true, selfApproved: true };
}

