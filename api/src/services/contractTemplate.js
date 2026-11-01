import { roundVND } from './pricing.js';

const SERVICE_CODE_LABELS = {
  ELECTRICITY: { name: 'Điện sinh hoạt', unit: 'kWh' },
  ELEC: { name: 'Điện sinh hoạt', unit: 'kWh' },
  WATER: { name: 'Nước sinh hoạt', unit: 'm³' },
  INTERNET: { name: 'Internet / Wifi', unit: 'tháng' },
  INTERNET_FIBER: { name: 'Internet Cáp Quang', unit: 'tháng' },
  MOTORBIKE_PARKING: { name: 'Gửi xe máy xăng', unit: 'xe/tháng' },
  ELECTRICBIKE_PARKING: { name: 'Gửi xe đạp/máy điện', unit: 'xe/tháng' },
  CAR_PARKING: { name: 'Gửi xe ô tô', unit: 'xe/tháng' },
  TRASH: { name: 'Phí thu gom rác', unit: 'tháng' },
  COMMON_SERVICE: { name: 'Dịch vụ chung', unit: 'tháng' },
  MANAGEMENT_FEE: { name: 'Phí quản lý tòa nhà', unit: 'tháng' },
  CLEANING: { name: 'Vệ sinh & Rác thải', unit: 'tháng' },
  PARKING_MOTO: { name: 'Gửi xe máy', unit: 'xe/tháng' },
  PARKING_CAR: { name: 'Gửi xe ô tô', unit: 'xe/tháng' },
  MANAGEMENT: { name: 'Phí quản lý tòa nhà', unit: 'tháng' },
};

export function escapeTemplateHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMoney(amount) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '0 ₫';
  return `${roundVND(Number(amount)).toLocaleString('vi-VN')} ₫`;
}

function normalizeDateStr(val, fallback = '') {
  if (!val) return fallback;
  if (typeof val === 'string') return val.slice(0, 10);
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(val).slice(0, 10);
}

/**
 * Kết xuất các dòng bảng Điều 5 (Biểu phí dịch vụ & tiện ích) cho mẫu in Hợp đồng A4.
 * Thứ tự ưu tiên đơn giá (FR-065):
 *   contract_service_price -> service_subscription.unit_price / meter.unit_price -> service_catalog.unit_price
 */
export function buildContractTemplateServiceRows({
  contractStartDate = '',
  contractBuildingId = '',
  subscriptions = [],
  servicePrices = [],
  meters = [],
  utilityCatalog = [],
} = {}) {
  const defaultEffectiveFrom = normalizeDateStr(contractStartDate, '');

  // Map contract_service_price theo mã dịch vụ (lấy bản ghi mới nhất nếu có nhiều dòng cùng mã)
  const priceMap = new Map();
  for (const sp of servicePrices || []) {
    const code = String(sp?.service_code || '').trim().toUpperCase();
    if (!code) continue;
    const existing = priceMap.get(code);
    const eff = normalizeDateStr(sp.effective_from, defaultEffectiveFrom);
    if (!existing || eff >= existing.effectiveFrom) {
      priceMap.set(code, {
        unitPrice: Number(sp.unit_price || 0),
        effectiveFrom: eff,
      });
    }
  }

  const consumedPriceCodes = new Set();
  const rows = [];

  // 1. Các gói dịch vụ đăng ký đi kèm (PENDING_APPROVAL hoặc ACTIVE, không phải METERED)
  for (const sub of subscriptions || []) {
    const status = String(sub?.status || '').toUpperCase();
    if (status !== 'PENDING_APPROVAL' && status !== 'ACTIVE') continue;

    const billingType = String(sub?.billing_type || '').toUpperCase();
    if (billingType === 'METERED') continue;

    const codeKey = String(sub?.service_code || '').trim().toUpperCase();
    const catKey = String(sub?.service_category || '').trim().toUpperCase();

    let overrideEntry = codeKey ? priceMap.get(codeKey) : undefined;
    let matchedPriceCode = overrideEntry ? codeKey : null;

    if (!overrideEntry) {
      if (codeKey === 'INTERNET_FIBER' || catKey === 'INTERNET') {
        overrideEntry = priceMap.get('INTERNET');
        if (overrideEntry) matchedPriceCode = 'INTERNET';
      } else if (codeKey === 'MANAGEMENT_FEE' || catKey === 'MANAGEMENT') {
        overrideEntry = priceMap.get('COMMON_SERVICE');
        if (overrideEntry) matchedPriceCode = 'COMMON_SERVICE';
      }
    }

    if (matchedPriceCode) {
      consumedPriceCodes.add(matchedPriceCode);
    }
    if (codeKey) {
      consumedPriceCodes.add(codeKey);
    }

    const effectiveUnitPrice = overrideEntry
      ? Number(overrideEntry.unitPrice)
      : Number(sub?.unit_price || 0);
    const qty = Math.max(1, Number(sub?.quantity || 1));
    const unit = String(sub?.unit || SERVICE_CODE_LABELS[codeKey]?.unit || 'tháng').trim();
    const lineTotal = roundVND(effectiveUnitPrice * qty);
    const effectiveFrom =
      overrideEntry?.effectiveFrom ||
      normalizeDateStr(sub?.start_date, defaultEffectiveFrom);

    const vehiclePlates = Array.isArray(sub?.vehicle_plates)
      ? sub.vehicle_plates
          .map((p) => (p !== null && p !== undefined ? String(p).trim() : ''))
          .filter(Boolean)
      : [];

    rows.push({
      name: String(sub?.service_name || SERVICE_CODE_LABELS[codeKey]?.name || codeKey || 'Dịch vụ'),
      code: codeKey,
      vehiclePlates,
      note: sub?.note ? String(sub.note).trim() : '',
      quantityLabel: `${qty} ${unit}`,
      unitPrice: effectiveUnitPrice,
      amountLabel: `${fmtMoney(lineTotal)}/tháng`,
      effectiveFrom,
    });
  }

  // 2. Điện & Nước theo đồng hồ (ưu tiên: contract_service_price -> meter -> utilityCatalog)
  const meterMap = new Map();
  for (const m of meters || []) {
    const mType = String(m?.meter_type || '').trim().toUpperCase();
    if (mType && !meterMap.has(mType)) {
      meterMap.set(mType, m);
    }
  }

  const utilCatMap = new Map();
  for (const uc of utilityCatalog || []) {
    const uCode = String(uc?.code || '').trim().toUpperCase();
    if (!uCode) continue;
    const rowBldId = uc?.building_id ? String(uc.building_id) : '';
    if (rowBldId && contractBuildingId && rowBldId !== String(contractBuildingId)) {
      continue;
    }
    const existing = utilCatMap.get(uCode);
    const existingIsBldSpecific = Boolean(existing?.building_id);
    const currentIsBldSpecific = Boolean(rowBldId);
    if (!existing || (!existingIsBldSpecific && currentIsBldSpecific)) {
      utilCatMap.set(uCode, uc);
    }
  }

  for (const utilCode of ['ELECTRICITY', 'WATER']) {
    const overrideEntry =
      priceMap.get(utilCode) ||
      (utilCode === 'ELECTRICITY' ? priceMap.get('ELEC') : undefined);
    const meterEntry = meterMap.get(utilCode);
    const catalogEntry = utilCatMap.get(utilCode);

    if (!overrideEntry && !meterEntry && !catalogEntry) {
      continue;
    }

    consumedPriceCodes.add(utilCode);
    if (utilCode === 'ELECTRICITY') consumedPriceCodes.add('ELEC');

    const meta = SERVICE_CODE_LABELS[utilCode];
    const unit = String(meterEntry?.unit || catalogEntry?.unit || meta.unit).trim();
    const unitPrice = overrideEntry
      ? Number(overrideEntry.unitPrice)
      : meterEntry?.unit_price != null
        ? Number(meterEntry.unit_price)
        : Number(catalogEntry?.unit_price || 0);

    rows.push({
      name: String(catalogEntry?.name || meta.name),
      code: utilCode,
      vehiclePlates: [],
      note: overrideEntry ? 'Giá thỏa thuận riêng theo hợp đồng' : '',
      quantityLabel: `1 ${unit}`,
      unitPrice,
      amountLabel: 'Theo chỉ số đồng hồ',
      effectiveFrom: overrideEntry?.effectiveFrom || defaultEffectiveFrom,
    });
  }

  // 3. Các dòng contract_service_price độc lập còn lại (tương thích ngược)
  for (const [codeKey, entry] of priceMap.entries()) {
    if (consumedPriceCodes.has(codeKey)) continue;
    const meta = SERVICE_CODE_LABELS[codeKey] || { name: codeKey, unit: 'tháng' };
    rows.push({
      name: meta.name,
      code: codeKey,
      vehiclePlates: [],
      note: '',
      quantityLabel: `1 ${meta.unit}`,
      unitPrice: Number(entry.unitPrice),
      amountLabel: `${fmtMoney(entry.unitPrice)}/tháng`,
      effectiveFrom: entry.effectiveFrom || defaultEffectiveFrom,
    });
  }

  return rows;
}

