/**
 * Deadlines Service (M05 / M06)
 * Xử lý mốc thời hạn hoàn cọc (FR-068 / FR-005) và cảnh báo hợp đồng sắp hết hạn (FR-018)
 */

import { getTodayVnDateStr } from './depositSettlement.js';

function formatDateUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Đọc cấu hình SLA hạn hoàn cọc (sla_config.deposit_refund_days) theo tổ chức (FR-005 / FR-068).
 * Mặc định 5 ngày nếu chưa cấu hình hoặc giá trị ngoài khoảng hợp lệ.
 */
export async function getOrgDepositRefundDays(dbPool, orgId) {
  if (!dbPool || !orgId) return 5;
  try {
    const res = await dbPool.query(
      `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'sla_config' LIMIT 1`,
      [orgId]
    );
    const raw = Number(res.rows[0]?.value?.deposit_refund_days);
    if (Number.isFinite(raw) && raw >= 1 && raw <= 90) {
      return Math.round(raw);
    }
  } catch {
    // Fallback mặc định 5 ngày
  }
  return 5;
}

/**
 * Tính hạn hoàn cọc theo ngày chấm dứt hợp đồng (FR-068):
 * - dueAt: ngày chấm dứt + refundDays (mặc định 5 ngày — quá hạn, báo lên Chủ nhà / Giám đốc)
 * - warnAt: trước hạn 2 ngày (mặc định +3 ngày — cảnh báo BQL)
 *
 * @param {string|Date} terminatedAt Chuỗi ngày YYYY-MM-DD
 * @param {number} [refundDays=5] Số ngày hạn hoàn cọc theo sla_config
 * @returns {{warnAt: string, dueAt: string}}
 */
export function refundDeadline(terminatedAt, refundDays = 5) {
  const dateStr = terminatedAt ? getTodayVnDateStr(terminatedAt) : getTodayVnDateStr();
  const parts = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));

  const days =
    Number.isFinite(Number(refundDays)) && Number(refundDays) >= 1
      ? Math.round(Number(refundDays))
      : 5;
  const warnDays = Math.max(0, days - 2);

  const warnDate = new Date(base.getTime() + warnDays * 24 * 60 * 60 * 1000);
  const dueDate = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  return {
    warnAt: formatDateUtc(warnDate),
    dueAt: formatDateUtc(dueDate),
  };
}

/**
 * Kiểm tra các mốc cảnh báo hết hạn 60/30/15 ngày (FR-018)
 *
 * @param {string} endDate Chuỗi ngày YYYY-MM-DD kết thúc HĐ
 * @param {string} today Chuỗi ngày YYYY-MM-DD hiện tại
 * @returns {string[]} Mảng mốc chạm hạn, ví dụ ['30']
 */
export function expiryAlertDates(endDate, today) {
  if (!endDate || !today) return [];
  const [y1, m1, d1] = endDate.split('T')[0].split('-').map(Number);
  const [y2, m2, d2] = today.split('T')[0].split('-').map(Number);

  const endUtc = Date.UTC(y1, m1 - 1, d1);
  const todayUtc = Date.UTC(y2, m2 - 1, d2);
  const diffDays = Math.round((endUtc - todayUtc) / (24 * 60 * 60 * 1000));

  const milestones = [60, 30, 15];
  if (milestones.includes(diffDays)) {
    return [String(diffDays)];
  }
  return [];
}
