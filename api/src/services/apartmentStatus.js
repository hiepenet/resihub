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
