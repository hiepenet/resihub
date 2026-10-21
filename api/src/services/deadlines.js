/**
 * Deadlines Service (M05 / M06)
 * Xử lý mốc thời hạn hoàn cọc (FR-068) và cảnh báo hợp đồng sắp hết hạn (FR-018)
 */

function formatDateUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Tính hạn hoàn cọc theo ngày chấm dứt hợp đồng (FR-068):
 * - warnAt: ngày chấm dứt + 3 ngày (cảnh báo BQL)
 * - dueAt: ngày chấm dứt + 5 ngày (quá hạn, báo lên Giám đốc)
 *
 * @param {string} terminatedAt Chuỗi ngày YYYY-MM-DD
 * @returns {{warnAt: string, dueAt: string}}
 */
export function refundDeadline(terminatedAt) {
  if (!terminatedAt) {
    const today = new Date();
    terminatedAt = today.toISOString().split('T')[0];
  }
  const parts = typeof terminatedAt === 'string' ? terminatedAt.split('T')[0].split('-').map(Number) : [terminatedAt.getFullYear(), terminatedAt.getMonth() + 1, terminatedAt.getDate()];
  const base = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));

  const warnDate = new Date(base.getTime() + 3 * 24 * 60 * 60 * 1000);
  const dueDate = new Date(base.getTime() + 5 * 24 * 60 * 60 * 1000);

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
