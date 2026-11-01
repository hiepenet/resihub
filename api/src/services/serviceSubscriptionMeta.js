export const MAX_PARKING_QUANTITY = 10;
const MIN_PLATE_LENGTH = 2;
const MAX_PLATE_LENGTH = 30;
const MAX_NOTE_LENGTH = 500;

function makeValidationError(code, message) {
  const err = new Error(message);
  err.httpStatus = 422;
  err.code = code;
  return err;
}

export function isParkingCategory(category) {
  return String(category || '').trim().toUpperCase() === 'PARKING';
}

function normalizePlateForComparison(plate) {
  return String(plate || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function validateAndNormalizeSubscriptionMeta({
  category,
  billingType,
  quantity,
  vehiclePlates,
  note,
} = {}) {
  const isParking = isParkingCategory(category);
  const normBillingType = String(billingType || '').trim().toUpperCase();

  let parsedQty;
  if (normBillingType === 'FIXED' && !isParking) {
    parsedQty = 1;
  } else {
    parsedQty = quantity === undefined || quantity === null || quantity === '' ? 1 : Number(quantity);
    if (!Number.isInteger(parsedQty) || parsedQty < 1) {
      throw makeValidationError(
        'INVALID_SERVICE_QUANTITY',
        'Số lượng dịch vụ đăng ký (quantity) phải là số nguyên dương >= 1.'
      );
    }
    if (isParking && parsedQty > MAX_PARKING_QUANTITY) {
      throw makeValidationError(
        'INVALID_SERVICE_QUANTITY',
        `Mỗi gói dịch vụ gửi xe chỉ đăng ký tối đa ${MAX_PARKING_QUANTITY} xe.`
      );
    }
  }

  const rawNote = note !== undefined && note !== null ? String(note).trim() : '';
  if (rawNote.length > MAX_NOTE_LENGTH) {
    throw makeValidationError(
      'INVALID_SERVICE_NOTE',
      `Ghi chú dịch vụ không được vượt quá ${MAX_NOTE_LENGTH} ký tự.`
    );
  }
  const cleanNote = rawNote || null;

  if (!isParking) {
    return {
      quantity: parsedQty,
      vehiclePlates: [],
      note: cleanNote,
    };
  }

  if (!Array.isArray(vehiclePlates) || vehiclePlates.length === 0) {
    throw makeValidationError(
      'VEHICLE_PLATES_REQUIRED',
      'Vui lòng nhập đầy đủ biển số xe cho dịch vụ gửi/đỗ xe.'
    );
  }

  if (vehiclePlates.length !== parsedQty) {
    throw makeValidationError(
      'INVALID_VEHICLE_PLATES',
      `Cần nhập đúng ${parsedQty} biển số xe tương ứng với số lượng đăng ký.`
    );
  }

  const cleanPlates = [];
  const seenKeys = new Set();

  for (let i = 0; i < vehiclePlates.length; i += 1) {
    const rawPlate = vehiclePlates[i] !== undefined && vehiclePlates[i] !== null
      ? String(vehiclePlates[i]).trim()
      : '';

    if (!rawPlate) {
      throw makeValidationError(
        'VEHICLE_PLATES_REQUIRED',
        parsedQty === 1
          ? 'Vui lòng nhập biển số xe.'
          : `Vui lòng nhập biển số xe #${i + 1}.`
      );
    }

    if (rawPlate.length < MIN_PLATE_LENGTH || rawPlate.length > MAX_PLATE_LENGTH) {
      throw makeValidationError(
        'INVALID_VEHICLE_PLATES',
        `Biển số xe${parsedQty > 1 ? ` #${i + 1}` : ''} phải từ ${MIN_PLATE_LENGTH} đến ${MAX_PLATE_LENGTH} ký tự.`
      );
    }

    const cmpKey = normalizePlateForComparison(rawPlate);
    if (seenKeys.has(cmpKey)) {
      throw makeValidationError(
        'DUPLICATE_VEHICLE_PLATE',
        `Biển số xe "${rawPlate}" bị trùng lặp trong cùng gói đăng ký.`
      );
    }
    seenKeys.add(cmpKey);
    cleanPlates.push(rawPlate);
  }

  return {
    quantity: parsedQty,
    vehiclePlates: cleanPlates,
    note: cleanNote,
  };
}
