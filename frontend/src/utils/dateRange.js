const BLOCKING_CONTRACT_STATUSES = new Set([
  'ACTIVE',
  'RENEWAL_PENDING',
  'TERMINATION_PENDING',
  'PENDING_APPROVAL',
  'DRAFT',
]);

/**
 * Chuẩn hóa giá trị ngày bất kỳ (Date, ISO string, YYYY-MM-DD) về chuỗi `YYYY-MM-DD`.
 * Trả về `""` nếu rỗng hoặc không hợp lệ.
 */
export function toDateOnlyStr(val) {
  if (!val) return '';
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return '';
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const str = String(val).trim();
  const exactIsoDate = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (exactIsoDate) {
    const y = Number(exactIsoDate[1]);
    const m = Number(exactIsoDate[2]);
    const d = Number(exactIsoDate[3]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d
    ) {
      return `${exactIsoDate[1]}-${exactIsoDate[2]}-${exactIsoDate[3]}`;
    }
    return '';
  }
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) return '';
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseUtcParts(dateStr) {
  const clean = toDateOnlyStr(dateStr);
  if (!clean) return null;
  const [y, m, d] = clean.split('-').map(Number);
  return { y, m, d };
}

function formatUtcDate(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Định dạng `YYYY-MM-DD` sang `DD/MM/YYYY` để hiển thị trên thông báo tiếng Việt.
 */
export function formatDateVi(dateStr) {
  const clean = toDateOnlyStr(dateStr);
  if (!clean) return '';
  const [y, m, d] = clean.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Cộng/trừ số ngày trên chuỗi lịch `YYYY-MM-DD` theo chuẩn UTC (không lệch múi giờ).
 */
export function addDaysStr(dateStr, days) {
  const parts = parseUtcParts(dateStr);
  if (!parts) return '';
  const dt = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + Number(days || 0)));
  return formatUtcDate(dt);
}

/**
 * Khoảng cách ngày nguyên `endStr - startStr` (trả về `null` nếu thiếu 1 trong 2 ngày).
 */
export function diffDaysStr(startStr, endStr) {
  const s = parseUtcParts(startStr);
  const e = parseUtcParts(endStr);
  if (!s || !e) return null;
  const msPerDay = 86400000;
  const startUtc = Date.UTC(s.y, s.m - 1, s.d);
  const endUtc = Date.UTC(e.y, e.m - 1, e.d);
  return Math.round((endUtc - startUtc) / msPerDay);
}

/**
 * Cộng số tháng trên chuỗi `YYYY-MM-DD`, tự kẹp ngày cuối tháng (VD: `2026-01-31` + 1 tháng -> `2026-02-28`).
 */
export function addMonthsClampedStr(dateStr, months) {
  const parts = parseUtcParts(dateStr);
  if (!parts) return '';
  const totalMonths = parts.y * 12 + (parts.m - 1) + Number(months || 0);
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonthIndex = ((totalMonths % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, targetMonthIndex + 1, 0)
  ).getUTCDate();
  const clampedDay = Math.min(parts.d, lastDayOfTargetMonth);
  return formatUtcDate(new Date(Date.UTC(targetYear, targetMonthIndex, clampedDay)));
}

/**
 * Trả về ngày lớn nhất trong danh sách chuỗi ngày hợp lệ (`""` nếu không có ngày nào).
 */
export function maxDateStr(...dates) {
  let result = '';
  for (const raw of dates) {
    const d = toDateOnlyStr(raw);
    if (d && (!result || d > result)) {
      result = d;
    }
  }
  return result;
}

/**
 * Trả về ngày nhỏ nhất trong danh sách chuỗi ngày hợp lệ (`""` nếu không có ngày nào).
 */
export function minDateStr(...dates) {
  let result = '';
  for (const raw of dates) {
    const d = toDateOnlyStr(raw);
    if (d && (!result || d < result)) {
      result = d;
    }
  }
  return result;
}

/**
 * Gom toàn bộ khoảng bận của căn hộ từ danh sách hợp đồng và phiếu giữ chỗ đang hiệu lực.
 */
export function extractApartmentBusyIntervals(
  { contracts = [], reservations = [] } = {},
  { excludeContractId = null, excludeReservationId = null, todayStr = '' } = {}
) {
  const minEnd = toDateOnlyStr(todayStr);
  const excludeContractKey =
    excludeContractId != null && excludeContractId !== '' ? String(excludeContractId) : null;
  const excludeResKey =
    excludeReservationId != null && excludeReservationId !== ''
      ? String(excludeReservationId)
      : null;

  const intervals = [];

  for (const c of contracts || []) {
    if (!c || !BLOCKING_CONTRACT_STATUSES.has(c.status)) continue;
    if (excludeContractKey && String(c.id) === excludeContractKey) continue;
    const from = toDateOnlyStr(c.start_date);
    const to = toDateOnlyStr(c.terminated_at || c.end_date);
    if (!from || !to || to < from) continue;
    if (minEnd && to < minEnd) continue;
    intervals.push({
      id: c.id,
      kind: 'contract',
      status: c.status,
      from,
      to,
      label: c.contract_number ? `HĐ ${c.contract_number}` : 'Hợp đồng thuê',
    });
  }

  for (const r of reservations || []) {
    if (!r || r.status !== 'HELD') continue;
    if (excludeResKey && String(r.id) === excludeResKey) continue;
    const from = toDateOnlyStr(r.hold_from || r.created_at);
    const to = toDateOnlyStr(r.hold_until);
    if (!from || !to || to < from) continue;
    if (minEnd && to < minEnd) continue;
    intervals.push({
      id: r.id,
      kind: 'reservation',
      status: r.status,
      from,
      to,
      label: r.prospect_name ? `Giữ chỗ (${r.prospect_name})` : 'Phiếu giữ chỗ',
    });
  }

  intervals.sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return 0;
  });

  return intervals;
}

/**
 * Tìm ngày bắt đầu trống đầu tiên kể từ `baseDateStr` nằm ngoài mọi khoảng đã thuê / giữ chỗ,
 * đồng thời đủ ít nhất `minSpanDays` ngày trống liên tiếp (VD: giữ chỗ cần ít nhất 2 mốc ngày `hold_from -> hold_from + 1`).
 */
export function findFirstAvailableStartDate(
  baseDateStr,
  busyIntervals = [],
  { minSpanDays = 1 } = {}
) {
  let candidate = toDateOnlyStr(baseDateStr);
  if (!candidate) return '';

  const sorted = [...(busyIntervals || [])]
    .filter((iv) => iv?.from && iv?.to && iv.to >= iv.from)
    .sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : 1));

  const spanOffset = Math.max(1, Number(minSpanDays) || 1) - 1;

  let moved = true;
  while (moved) {
    moved = false;
    const spanEnd = addDaysStr(candidate, spanOffset);
    for (const iv of sorted) {
      if (iv.from <= spanEnd && candidate <= iv.to) {
        const nextCandidate = addDaysStr(iv.to, 1);
        if (nextCandidate > candidate) {
          candidate = nextCandidate;
          moved = true;
          break;
        }
      }
    }
  }

  return candidate;
}

/**
 * Tìm các khoảng bận bị chồng lấn với khoảng `[startStr, endStr]` người dùng đang chọn.
 */
export function findOverlappingBusyIntervals(startStr, endStr, busyIntervals = []) {
  const s = toDateOnlyStr(startStr);
  const e = toDateOnlyStr(endStr);
  if (!s) return [];
  const rangeEnd = e && e >= s ? e : s;
  return (busyIntervals || []).filter(
    (iv) => iv?.from && iv?.to && iv.from <= rangeEnd && iv.to >= s
  );
}

/**
 * Định dạng thông báo lỗi tiếng Việt khi khoảng ngày chọn bị trùng lịch thuê/giữ chỗ của căn hộ.
 */
export function formatBusyOverlapError(overlaps = [], actionLabel = 'Khoảng thời gian chọn') {
  if (!overlaps || overlaps.length === 0) return '';
  const first = overlaps[0];
  const kindText = first.kind === 'reservation' ? 'phiếu giữ chỗ' : 'hợp đồng thuê';
  return `${actionLabel} trùng với ${kindText} (${formatDateVi(first.from)} → ${formatDateVi(first.to)}). Vui lòng chọn ngoài khoảng này.`;
}

/**
 * Kiểm tra thứ tự ngày trước - ngày sau cho các form lưu dữ liệu.
 * - `strictAfter: true`  -> bắt buộc `end > start` (kỳ hạn hợp đồng, giữ chỗ, gia hạn)
 * - `strictAfter: false` -> bắt buộc `end >= start` (hủy dịch vụ, phụ lục, bộ lọc)
 */
export function getDateOrderError(
  startStr,
  endStr,
  {
    strictAfter = false,
    startLabel = 'Ngày bắt đầu',
    endLabel = 'Ngày kết thúc',
  } = {}
) {
  const s = toDateOnlyStr(startStr);
  const e = toDateOnlyStr(endStr);
  if (!s || !e) return '';
  if (strictAfter && e <= s) {
    return `${endLabel} phải sau ${startLabel.toLowerCase()}.`;
  }
  if (!strictAfter && e < s) {
    return `${endLabel} không được nhỏ hơn ${startLabel.toLowerCase()}.`;
  }
  return '';
}

/**
 * Dùng cho bộ lọc tức thời (AuditLogsPage): nếu sửa "Từ ngày" vượt qua "Đến ngày" hiện có,
 * tự đồng bộ `toDate = fromDate` để bảng lọc lại mượt mà, không trả rỗng vô lý.
 */
export function syncFilterDateRange(nextFrom, currentTo) {
  const fromDate = toDateOnlyStr(nextFrom);
  const toDate = toDateOnlyStr(currentTo);
  if (fromDate && toDate && fromDate > toDate) {
    return { fromDate, toDate: fromDate };
  }
  return { fromDate, toDate };
}

