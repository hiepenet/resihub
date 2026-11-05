import {
  evaluateClientMeterAnomaly,
  computeMeterEstimatedAmount,
  isMeterRowLockedForEdit,
} from './billing.js';

export const MAX_BATCH_METER_PHOTOS = 30;
export const DEFAULT_OCR_CONCURRENCY = 2;

function normalizeAsciiTokenString(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (ch) => (ch === 'đ' ? 'd' : 'D'))
    .toUpperCase();
}

function stripFileExtension(fileName) {
  return String(fileName || '')
    .trim()
    .replace(/\.[a-z0-9]{2,5}$/i, '');
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCodeBoundaryRegex(normCode) {
  return new RegExp(`(?<![A-Z0-9])${escapeRegExp(normCode)}(?![A-Z0-9])`);
}

export function detectMeterTypeHintFromText(rawText) {
  const norm = normalizeAsciiTokenString(rawText);
  if (!norm) return null;

  const hasElec = /(?<![A-Z0-9])(DIEN|ELECTRICITY|ELECTRIC|ELEC|KWH|EL|E)(?![A-Z0-9])/.test(norm);
  const hasWater = /(?<![A-Z0-9])(NUOC|WATER|M3|WT|W)(?![A-Z0-9])/.test(norm);

  if (hasElec && !hasWater) return 'ELECTRICITY';
  if (hasWater && !hasElec) return 'WATER';
  return null;
}

function resolveMeterPreviousBaseline(row) {
  if (!row) return 0;
  if (row.period_previous_reading !== null && row.period_previous_reading !== undefined) {
    return Number(row.period_previous_reading);
  }
  if (row.last_known_reading !== null && row.last_known_reading !== undefined) {
    return Number(row.last_known_reading);
  }
  return Number(row.initial_reading || 0);
}

function resolveMeterRollingAvg(row) {
  if (!row) return null;
  if (row.baseline_avg_consumption !== null && row.baseline_avg_consumption !== undefined) {
    return Number(row.baseline_avg_consumption);
  }
  if (row.last_known_consumption !== null && row.last_known_consumption !== undefined) {
    return Number(row.last_known_consumption);
  }
  return null;
}

/**
 * Nhận diện công tơ hoặc căn hộ mục tiêu từ tên file ảnh chụp công tơ:
 * - Ưu tiên 1: Khớp chính xác `meter_code` (sắp xếp độ dài giảm dần, ranh giới chữ-số).
 * - Ưu tiên 2: Khớp mã căn hộ `apartment_code` (độ dài giảm dần để `A1001` không bao giờ khớp nhầm `A100` hoặc `A10`).
 *   + Nếu phần còn lại của tên file có gợi ý Điện/Nước (`_dien`, `_nuoc`, `_E`, `_W`, `kwh`, `m3`) -> trả `EXACT_METER`.
 *   + Nếu tên file chỉ chứa mã phòng (`A1001 (1).jpg`) -> trả `APARTMENT_ONLY` để AI-02 tự phân giải Điện/Nước từ mặt đồng hồ.
 * - Không khớp -> `UNMATCHED`.
 */
export function matchMeterFromFilename(fileName, buildingMeters = []) {
  const meters = Array.isArray(buildingMeters) ? buildingMeters : [];
  const stemNorm = normalizeAsciiTokenString(stripFileExtension(fileName));

  if (!stemNorm || meters.length === 0) {
    return {
      matchKind: 'UNMATCHED',
      meterId: null,
      apartmentId: null,
      apartmentCode: null,
      meterTypeHint: detectMeterTypeHintFromText(stemNorm),
    };
  }

  // 1) Khớp chính xác meter_code (dài nhất trước)
  const metersByCodeLen = [...meters]
    .filter((m) => m?.meter_code)
    .sort((a, b) => String(b.meter_code).length - String(a.meter_code).length);

  for (const m of metersByCodeLen) {
    const codeNorm = normalizeAsciiTokenString(m.meter_code).trim();
    if (!codeNorm) continue;
    if (buildCodeBoundaryRegex(codeNorm).test(stemNorm)) {
      return {
        matchKind: 'EXACT_METER',
        meterId: m.id,
        apartmentId: m.apartment_id || null,
        apartmentCode: m.apartment_code || null,
        meterTypeHint: m.meter_type || null,
      };
    }
  }

  // 2) Nhóm theo căn hộ và khớp apartment_code dài nhất trước (chống đụng độ tiền tố A10 / A100 / A1001)
  const aptMap = new Map();
  for (const m of meters) {
    const rawAptCode = String(m?.apartment_code || '').trim();
    const normAptCode = normalizeAsciiTokenString(rawAptCode).trim();
    if (!normAptCode) continue;
    if (!aptMap.has(normAptCode)) {
      aptMap.set(normAptCode, {
        normAptCode,
        apartmentId: m.apartment_id || null,
        apartmentCode: rawAptCode,
        meters: [],
      });
    }
    aptMap.get(normAptCode).meters.push(m);
  }

  const sortedApts = Array.from(aptMap.values()).sort(
    (a, b) => b.normAptCode.length - a.normAptCode.length
  );

  for (const apt of sortedApts) {
    const re = buildCodeBoundaryRegex(apt.normAptCode);
    if (re.test(stemNorm)) {
      const remainder = stemNorm.replace(re, ' ');
      const typeHint = detectMeterTypeHintFromText(remainder);

      if (typeHint) {
        const typedCandidates = apt.meters.filter((m) => m.meter_type === typeHint);
        if (typedCandidates.length === 1) {
          return {
            matchKind: 'EXACT_METER',
            meterId: typedCandidates[0].id,
            apartmentId: apt.apartmentId,
            apartmentCode: apt.apartmentCode,
            meterTypeHint: typeHint,
          };
        }
      }

      return {
        matchKind: 'APARTMENT_ONLY',
        meterId: null,
        apartmentId: apt.apartmentId,
        apartmentCode: apt.apartmentCode,
        meterTypeHint: typeHint,
      };
    }
  }

  return {
    matchKind: 'UNMATCHED',
    meterId: null,
    apartmentId: null,
    apartmentCode: null,
    meterTypeHint: detectMeterTypeHintFromText(stemNorm),
  };
}

/**
 * Sau khi AI-02 đọc ảnh công tơ xong, tự động gắn `meterId` cho các ảnh chỉ có tên phòng (`APARTMENT_ONLY`)
 * dựa trên `resolved_meter_id` hoặc `detected_meter_type` mà backend trả về.
 */
export function resolveMeterAfterOcr({ item = {}, ocrData = null, buildingMeters = [] } = {}) {
  if (item?.meterId) {
    return item.meterId;
  }
  const meters = Array.isArray(buildingMeters) ? buildingMeters : [];
  const backendResolvedId = ocrData?.output?.resolved_meter_id || null;
  if (
    backendResolvedId &&
    meters.some((m) => String(m.id) === String(backendResolvedId))
  ) {
    return backendResolvedId;
  }

  const detType = String(ocrData?.output?.detected_meter_type || '')
    .trim()
    .toUpperCase();
  const targetApartmentId = item?.apartmentId || ocrData?.output?.apartment_id || null;

  if (targetApartmentId) {
    const aptMeters = meters.filter(
      (m) => String(m.apartment_id) === String(targetApartmentId)
    );
    if (detType === 'ELECTRICITY' || detType === 'WATER') {
      const typed = aptMeters.filter((m) => m.meter_type === detType);
      if (typed.length === 1) {
        return typed[0].id;
      }
    } else if (aptMeters.length === 1) {
      return aptMeters[0].id;
    }
  }

  return null;
}

/**
 * Khớp lại danh sách ảnh khi tải lại danh sách công tơ hoặc khi Quản lý đổi Tòa nhà mục tiêu:
 * - Nếu dòng vẫn thuộc cùng tòa nhà (`sameBuilding`) và đã gán công tơ hợp lệ trong tòa đó -> giữ nguyên.
 * - Nếu đổi sang tòa nhà khác (hoặc công tơ cũ không thuộc tòa mới) -> xóa `manualMeterAssigned` và xóa `suggestionId`
 *   của tòa cũ (tránh gửi nhầm `apartment_id` / `ai_suggestion_id` liên tòa gây lỗi 404/403), đồng thời khớp lại theo tên file.
 */
export function rematchBatchPhotoItemsForBuilding(
  items = [],
  newBuildingMeters = [],
  nextBuildingId = ''
) {
  const list = Array.isArray(items) ? items : [];
  const meters = Array.isArray(newBuildingMeters) ? newBuildingMeters : [];
  const meterIdSet = new Set(meters.map((m) => String(m.id)));

  return list.map((row) => {
    const sameBuilding =
      !row.buildingId ||
      !nextBuildingId ||
      String(row.buildingId) === String(nextBuildingId);

    if (
      sameBuilding &&
      row.manualMeterAssigned &&
      row.meterId &&
      meterIdSet.has(String(row.meterId))
    ) {
      return {
        ...row,
        buildingId: nextBuildingId || row.buildingId || '',
      };
    }

    if (sameBuilding && row.meterId && meterIdSet.has(String(row.meterId))) {
      return {
        ...row,
        buildingId: nextBuildingId || row.buildingId || '',
      };
    }

    const m = matchMeterFromFilename(row.fileName, meters);
    return {
      ...row,
      buildingId: nextBuildingId || '',
      matchKind: m.matchKind,
      meterId: m.meterId,
      apartmentId: m.apartmentId,
      apartmentCode: m.apartmentCode,
      meterTypeHint: m.meterTypeHint,
      manualMeterAssigned: false,
      suggestionId: sameBuilding ? row.suggestionId : null,
    };
  });
}

/**
 * Hàng đợi bất đồng bộ giới hạn số luồng chạy song song (`concurrency = 2`),
 * bảo toàn thứ tự kết quả và cô lập lỗi của từng phần tử mà không làm gãy các ảnh còn lại.
 */
export async function runBoundedConcurrencyQueue(
  items = [],
  concurrency = DEFAULT_OCR_CONCURRENCY,
  workerFn,
  { signal } = {}
) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const limit = Math.max(1, Math.min(Number(concurrency) || DEFAULT_OCR_CONCURRENCY, list.length));
  const results = new Array(list.length);
  let cursor = 0;

  async function workerLoop() {
    while (true) {
      if (signal?.aborted) return;
      const idx = cursor;
      cursor += 1;
      if (idx >= list.length) return;

      try {
        const value = await workerFn(list[idx], idx);
        results[idx] = { status: 'fulfilled', value };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers = Array.from({ length: limit }, () => workerLoop());
  await Promise.all(workers);
  return results;
}

/**
 * Đánh giá toàn bộ danh sách ảnh trong Modal đối soát trước khi Lưu nháp / Lưu & Chốt:
 * - Phát hiện trùng công tơ đích (`DUPLICATE_METER_TARGET`)
 * - Phát hiện công tơ đã lập hóa đơn bị khóa (`LOCKED_BILLED`)
 * - Phát hiện thiếu công tơ (`MISSING_METER`), thiếu/sai chỉ số (`MISSING_READING` / `INVALID_READING`)
 * - Tính toán sản lượng, thành tiền tạm tính & cảnh báo biến động `>30%` (`READY_ABNORMAL` / `READY`)
 */
export function evaluateBatchPhotoImportItems(
  items = [],
  buildingMeters = [],
  { anomalyThresholdPct = 30, canWriteMeters = true } = {}
) {
  const list = Array.isArray(items) ? items : [];
  const meters = Array.isArray(buildingMeters) ? buildingMeters : [];
  const meterById = new Map(meters.map((m) => [String(m.id), m]));

  const meterTargetCounts = new Map();
  for (const it of list) {
    if (it?.meterId) {
      const key = String(it.meterId);
      meterTargetCounts.set(key, (meterTargetCounts.get(key) || 0) + 1);
    }
  }

  const rows = list.map((it) => {
    const meter = it?.meterId ? meterById.get(String(it.meterId)) || null : null;
    const isProcessing = it?.ocrStatus === 'PENDING' || it?.ocrStatus === 'PROCESSING';
    const isDuplicateTarget =
      Boolean(meter) && (meterTargetCounts.get(String(meter.id)) || 0) > 1;
    const isLocked = meter ? isMeterRowLockedForEdit(meter, canWriteMeters) : false;

    const prevReading = meter ? resolveMeterPreviousBaseline(meter) : null;
    const baselineAvg = meter ? resolveMeterRollingAvg(meter) : null;

    const anomaly = meter
      ? evaluateClientMeterAnomaly({
          prevReading,
          currentReading: it?.draftReading,
          baselineAvg,
          thresholdPct: anomalyThresholdPct,
        })
      : {
          hasInput: Boolean(String(it?.draftReading ?? '').trim()),
          isInvalid: false,
          consumption: null,
          baselineAvg: null,
          diffPct: null,
          isAbnormal: false,
        };

    let isAbnormal = anomaly.isAbnormal;
    if (
      meter &&
      !isAbnormal &&
      Boolean(meter.period_is_abnormal) &&
      anomaly.hasInput &&
      !anomaly.isInvalid &&
      meter.period_current_reading !== null &&
      meter.period_current_reading !== undefined &&
      Number(it?.draftReading) === Number(meter.period_current_reading)
    ) {
      isAbnormal = true;
    }

    const estimatedAmount =
      meter && anomaly.hasInput && !anomaly.isInvalid
        ? computeMeterEstimatedAmount(anomaly.consumption, meter)
        : null;

    const hasTypeMismatchWarning = Boolean(
      meter &&
        it?.detectedMeterType &&
        (it.detectedMeterType === 'ELECTRICITY' || it.detectedMeterType === 'WATER') &&
        meter.meter_type !== it.detectedMeterType
    );

    let validationState = 'READY';
    let isSaveable = false;

    if (isProcessing) {
      validationState = 'OCR_PROCESSING';
    } else if (!meter) {
      validationState = 'MISSING_METER';
    } else if (isLocked) {
      validationState = 'LOCKED_BILLED';
    } else if (isDuplicateTarget) {
      validationState = 'DUPLICATE_METER_TARGET';
    } else if (!anomaly.hasInput) {
      validationState = 'MISSING_READING';
    } else if (anomaly.isInvalid) {
      validationState = 'INVALID_READING';
    } else if (isAbnormal) {
      validationState = 'READY_ABNORMAL';
      isSaveable = true;
    } else {
      validationState = 'READY';
      isSaveable = true;
    }

    return {
      ...it,
      meter,
      prevReading,
      baselineAvg: anomaly.baselineAvg,
      consumption: anomaly.consumption,
      diffPct: anomaly.diffPct,
      isAbnormal,
      isInvalidReading: anomaly.isInvalid,
      hasReadingInput: anomaly.hasInput,
      estimatedAmount,
      hasTypeMismatchWarning,
      validationState,
      isSaveable,
    };
  });

  const saveableRows = rows.filter((r) => r.isSaveable);
  const summary = {
    totalCount: rows.length,
    processingCount: rows.filter((r) => r.validationState === 'OCR_PROCESSING').length,
    saveableCount: saveableRows.length,
    abnormalSaveableCount: saveableRows.filter((r) => r.isAbnormal).length,
    abnormalMissingNoteCount: saveableRows.filter(
      (r) => r.isAbnormal && !String(r.abnormalNote || '').trim()
    ).length,
    duplicateCount: rows.filter((r) => r.validationState === 'DUPLICATE_METER_TARGET').length,
    lockedCount: rows.filter((r) => r.validationState === 'LOCKED_BILLED').length,
    missingMeterCount: rows.filter((r) => r.validationState === 'MISSING_METER').length,
    missingOrInvalidReadingCount: rows.filter(
      (r) =>
        r.validationState === 'MISSING_READING' || r.validationState === 'INVALID_READING'
    ).length,
    skippedCount: rows.length - saveableRows.length,
  };

  return {
    rows,
    saveableRows,
    summary,
  };
}

/**
 * Đóng gói dữ liệu gửi lên `POST /api/v1/meters/readings/batch` kèm ảnh bằng chứng và `ai_suggestion_id`.
 */
export function buildBatchPhotoSavePayload({
  saveableRows = [],
  period,
  targetStatus = 'DRAFT',
} = {}) {
  const readings = (Array.isArray(saveableRows) ? saveableRows : [])
    .filter((r) => r?.isSaveable && r?.meter?.id)
    .map((r) => {
      const entry = {
        meter_id: r.meter.id,
        current_reading: Number(r.draftReading),
      };
      if (r.meter.target_contract_id) {
        entry.contract_id = r.meter.target_contract_id;
      }
      const trimmedNote = String(r.abnormalNote || '').trim();
      if (trimmedNote) {
        entry.abnormal_note = trimmedNote;
      }
      if (r.imageDataUri && String(r.imageDataUri).startsWith('data:image/')) {
        entry.image_base64 = r.imageDataUri;
      }
      if (r.suggestionId) {
        entry.ai_suggestion_id = r.suggestionId;
      }
      return entry;
    });

  return {
    period,
    status: targetStatus,
    hold_if_abnormal: true,
    readings,
  };
}
