export const MAX_PARKING_QUANTITY = 10;
const MIN_PLATE_LENGTH = 2;
const MAX_PLATE_LENGTH = 30;
const MAX_NOTE_LENGTH = 500;

export function isParkingService(svcOrCategory) {
  if (!svcOrCategory) return false;
  if (typeof svcOrCategory === 'string') {
    return svcOrCategory.trim().toUpperCase() === 'PARKING';
  }
  if (typeof svcOrCategory === 'object') {
    const cat = svcOrCategory.category ?? svcOrCategory.service_category ?? '';
    return String(cat).trim().toUpperCase() === 'PARKING';
  }
  return false;
}

export function allowsMultiQuantity(svcOrObj) {
  if (!svcOrObj || typeof svcOrObj !== 'object') return false;
  const billingType = String(svcOrObj.billing_type || '').trim().toUpperCase();
  return billingType === 'QUANTITY' || isParkingService(svcOrObj);
}

export function syncVehiclePlatesArray(plates, nextQuantity) {
  const base = Array.isArray(plates)
    ? plates.map((p) => (p === undefined || p === null ? '' : String(p)))
    : [];
  if (
    nextQuantity === '' ||
    nextQuantity === null ||
    nextQuantity === undefined ||
    String(nextQuantity).trim() === ''
  ) {
    return base.length > 0 ? base.slice(0, MAX_PARKING_QUANTITY) : [''];
  }
  const parsed = Math.floor(Number(nextQuantity) || 1);
  const targetLen = Math.min(MAX_PARKING_QUANTITY, Math.max(1, parsed));
  const next = base.slice(0, targetLen);
  while (next.length < targetLen) {
    next.push('');
  }
  return next;
}

function normalizePlateKey(plate) {
  return String(plate || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function validateServiceMetaInput({
  isParking = false,
  quantity = 1,
  vehiclePlates = [],
  note = '',
} = {}) {
  const rawQty =
    quantity === undefined || quantity === null || quantity === '' ? NaN : Number(quantity);

  let quantityError = '';
  if (!Number.isInteger(rawQty) || rawQty < 1) {
    quantityError = 'Số lượng đăng ký phải là số nguyên dương >= 1.';
  } else if (isParking && rawQty > MAX_PARKING_QUANTITY) {
    quantityError = `Mỗi gói gửi xe chỉ đăng ký tối đa ${MAX_PARKING_QUANTITY} xe.`;
  }

  const safeQty =
    !Number.isInteger(rawQty) || rawQty < 1
      ? 1
      : isParking
      ? Math.min(MAX_PARKING_QUANTITY, rawQty)
      : rawQty;

  const cleanNote = note !== undefined && note !== null ? String(note).trim() : '';
  const noteError =
    cleanNote.length > MAX_NOTE_LENGTH
      ? `Ghi chú dịch vụ không được vượt quá ${MAX_NOTE_LENGTH} ký tự.`
      : '';

  if (!isParking) {
    return {
      valid: !quantityError && !noteError,
      plateErrors: [],
      quantityError,
      noteError,
      cleanPlates: [],
      cleanNote,
    };
  }

  const slots = syncVehiclePlatesArray(vehiclePlates, safeQty);
  const plateErrors = [];
  const cleanPlates = [];
  const seenKeys = new Set();

  for (let i = 0; i < safeQty; i += 1) {
    const trimmed = slots[i].trim();
    if (!trimmed) {
      plateErrors.push(
        safeQty === 1 ? 'Vui lòng nhập biển số xe.' : `Vui lòng nhập biển số xe #${i + 1}.`
      );
      cleanPlates.push('');
      continue;
    }

    if (trimmed.length < MIN_PLATE_LENGTH || trimmed.length > MAX_PLATE_LENGTH) {
      plateErrors.push(
        `Biển số xe${safeQty > 1 ? ` #${i + 1}` : ''} phải từ ${MIN_PLATE_LENGTH} đến ${MAX_PLATE_LENGTH} ký tự.`
      );
      cleanPlates.push(trimmed);
      continue;
    }

    const cmpKey = normalizePlateKey(trimmed);
    if (seenKeys.has(cmpKey)) {
      plateErrors.push(`Biển số xe "${trimmed}" bị trùng lặp trong cùng gói đăng ký.`);
    } else {
      seenKeys.add(cmpKey);
      plateErrors.push('');
    }
    cleanPlates.push(trimmed);
  }

  const hasPlateError = plateErrors.some(Boolean);
  return {
    valid: !quantityError && !noteError && !hasPlateError,
    plateErrors,
    quantityError,
    noteError,
    cleanPlates,
    cleanNote,
  };
}
