/**
 * Contract Guards Service (M05)
 * Pure functions for contract business validation rules
 */

/**
 * Kiểm tra giá thuê có thấp hơn 10% so với giá niêm yết không (PRD FR-014, line 486).
 * Giá < 90% giá niêm yết -> yêu cầu phê duyệt (PENDING_APPROVAL).
 *
 * @param {number|string|bigint} rentAmount Giá thuê đề xuất
 * @param {number|string|bigint} baseRent Giá niêm yết của căn hộ
 * @returns {boolean}
 */
export function isDiscountedPrice(rentAmount, baseRent) {
  if (!baseRent || Number(baseRent) <= 0) return false;
  return Number(rentAmount) < Number(baseRent) * 0.9;
}

/**
 * Map mã lỗi PostgreSQL thành response JSON chuẩn HTTP.
 * Bắt lỗi exclusion constraint `23P01` (chồng lấn kỳ hạn tầng DB) thành 409 OVERLAP_CONTRACT.
 *
 * @param {object} err Error object từ pg
 * @returns {{status: number, code: string, message: string} | null}
 */
export function mapPgError(err) {
  if (!err) return null;
  if (err.code === '23P01') {
    return {
      status: 409,
      code: 'OVERLAP_CONTRACT',
      message: 'Căn hộ đã có hợp đồng trong khoảng thời gian này.',
    };
  }
  return null;
}
