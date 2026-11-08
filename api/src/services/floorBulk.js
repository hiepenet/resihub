export const MIN_FLOOR_LEVEL = -10;
export const MAX_FLOOR_LEVEL = 200;
export const MAX_BULK_FLOORS = 100;
export const MAX_FLOOR_NAME_LEN = 100;

export function parseStrictInt(raw) {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export function defaultFloorName(level, namePrefix = 'Tầng') {
  const lvl = Number(level);
  if (lvl < 0) return `Tầng hầm B${Math.abs(lvl)}`;
  if (lvl === 0) return 'Tầng Trệt';
  const cleanPrefix = String(namePrefix ?? '').trim() || 'Tầng';
  if (/[-_/.]$/.test(cleanPrefix)) {
    return `${cleanPrefix}${lvl}`;
  }
  return `${cleanPrefix} ${lvl}`;
}

export function expandFloorRange({
  fromLevel,
  toLevel,
  includeZero = true,
  namePrefix = 'Tầng',
} = {}) {
  if (namePrefix !== undefined && namePrefix !== null && typeof namePrefix !== 'string') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Tiền tố tên tầng phải là chuỗi ký tự hợp lệ.',
    };
  }

  const from = parseStrictInt(fromLevel);
  const to = parseStrictInt(toLevel);

  if (from === null || to === null) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Từ tầng và Đến tầng phải là số nguyên hợp lệ.',
    };
  }
  if (from < MIN_FLOOR_LEVEL || to > MAX_FLOOR_LEVEL || to < MIN_FLOOR_LEVEL || from > MAX_FLOOR_LEVEL) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `Số tầng phải nằm trong khoảng từ ${MIN_FLOOR_LEVEL} đến ${MAX_FLOOR_LEVEL}.`,
    };
  }
  if (from > to) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Từ tầng không được lớn hơn Đến tầng.',
    };
  }

  const floors = [];
  for (let lvl = from; lvl <= to; lvl += 1) {
    if (lvl === 0 && includeZero === false) continue;
    const generatedName = defaultFloorName(lvl, namePrefix);
    if (generatedName.length > MAX_FLOOR_NAME_LEN) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Tên hiển thị của tầng ${lvl} không được vượt quá ${MAX_FLOOR_NAME_LEN} ký tự.`,
      };
    }
    floors.push({
      level: lvl,
      name: generatedName,
    });
    if (floors.length > MAX_BULK_FLOORS) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Một lần chỉ được khởi tạo tối đa ${MAX_BULK_FLOORS} tầng.`,
      };
    }
  }

  if (floors.length === 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Dải tầng đã chọn không có tầng nào hợp lệ để tạo.',
    };
  }

  return { ok: true, floors };
}

export function validateAndNormalizeBulkFloors(body = {}) {
  const rawList = body?.floors;
  const namePrefix = body?.name_prefix;

  if (namePrefix !== undefined && namePrefix !== null && typeof namePrefix !== 'string') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Tiền tố tên tầng phải là chuỗi ký tự hợp lệ.',
    };
  }

  if (rawList === undefined || rawList === null) {
    if (body?.from_level !== undefined || body?.to_level !== undefined) {
      const expanded = expandFloorRange({
        fromLevel: body.from_level,
        toLevel: body.to_level,
        includeZero: body.include_zero !== false,
        namePrefix,
      });
      if (!expanded.ok) return expanded;
      return { ok: true, drafts: expanded.floors };
    }
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Vui lòng cung cấp danh sách tầng hoặc dải tầng cần tạo.',
    };
  }

  if (!Array.isArray(rawList) || rawList.length === 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Danh sách tầng cần tạo không được để trống.',
    };
  }
  if (rawList.length > MAX_BULK_FLOORS) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `Một lần chỉ được khởi tạo tối đa ${MAX_BULK_FLOORS} tầng.`,
    };
  }

  const seen = new Set();
  const duplicateLevels = new Set();
  const normalized = [];

  for (let i = 0; i < rawList.length; i += 1) {
    const item = rawList[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Dữ liệu tầng thứ ${i + 1} không hợp lệ.`,
      };
    }

    const lvl = parseStrictInt(item.level);
    if (lvl === null || lvl < MIN_FLOOR_LEVEL || lvl > MAX_FLOOR_LEVEL) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Số tầng ở dòng ${i + 1} phải là số nguyên từ ${MIN_FLOOR_LEVEL} đến ${MAX_FLOOR_LEVEL}.`,
      };
    }

    if (item.name !== undefined && item.name !== null && typeof item.name !== 'string') {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Tên hiển thị của tầng ${lvl} không hợp lệ.`,
      };
    }

    const customName = typeof item.name === 'string' ? item.name.trim() : '';
    const finalName = customName || defaultFloorName(lvl, namePrefix);
    if (finalName.length > MAX_FLOOR_NAME_LEN) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: `Tên hiển thị của tầng ${lvl} không được vượt quá ${MAX_FLOOR_NAME_LEN} ký tự.`,
      };
    }

    if (seen.has(lvl)) {
      duplicateLevels.add(lvl);
    } else {
      seen.add(lvl);
    }

    normalized.push({ level: lvl, name: finalName });
  }

  if (duplicateLevels.size > 0) {
    const sortedDups = [...duplicateLevels].sort((a, b) => a - b);
    return {
      ok: false,
      code: 'DUPLICATE_LEVEL_IN_PAYLOAD',
      message: `Danh sách gửi lên bị trùng số tầng: ${sortedDups.join(', ')}.`,
      conflicts: sortedDups.map((level) => ({ level })),
    };
  }

  normalized.sort((a, b) => a.level - b.level);
  return { ok: true, drafts: normalized };
}
