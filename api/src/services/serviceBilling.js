import { roundVND } from './pricing.js';

/**
 * Format today's date in 'Asia/Ho_Chi_Minh' timezone as 'YYYY-MM-DD' (PRD 13.4).
 */
export function todayVietnamYmd(now) {
  let dt = now;
  if (!dt) {
    dt = new Date();
  } else if (!(dt instanceof Date)) {
    dt = new Date(dt);
  }
  if (Number.isNaN(dt.getTime())) {
    dt = new Date();
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);
}

/**
 * Current period in 'Asia/Ho_Chi_Minh' as 'YYYY-MM'.
 */
export function currentVietnamPeriod(now) {
  return todayVietnamYmd(now).slice(0, 7);
}

/**
 * Normalize date or string input to 'YYYY-MM-DD'. Returns empty string if falsy.
 */
export function toDateOnlyYmd(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return todayVietnamYmd(val);
  }
  return String(val).slice(0, 10);
}

/**
 * Add or subtract days from a 'YYYY-MM-DD' string.
 */
export function addDaysYmd(ymd, deltaDays) {
  if (!ymd) return '';
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + Number(deltaDays || 0)));
  const outY = dt.getUTCFullYear();
  const outM = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const outD = String(dt.getUTCDate()).padStart(2, '0');
  return `${outY}-${outM}-${outD}`;
}

/**
 * Calculate difference in days between two 'YYYY-MM-DD' strings (end - start).
 */
export function diffDaysYmd(startYmd, endYmd) {
  if (!startYmd || !endYmd) return 0;
  const [y1, m1, d1] = String(startYmd).slice(0, 10).split('-').map(Number);
  const [y2, m2, d2] = String(endYmd).slice(0, 10).split('-').map(Number);
  const ms1 = Date.UTC(y1, m1 - 1, d1);
  const ms2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((ms2 - ms1) / 86400000);
}

/**
 * Get start date, end date, and total days in month for a 'YYYY-MM' period.
 */
export function getMonthBoundsYmd(periodYm) {
  let ym = periodYm;
  if (!ym) {
    ym = currentVietnamPeriod();
  }
  const [y, m] = String(ym).slice(0, 7).split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const padM = String(m).padStart(2, '0');
  const padD = String(daysInMonth).padStart(2, '0');
  return {
    monthStart: `${y}-${padM}-01`,
    monthEnd: `${y}-${padM}-${padD}`,
    daysInMonth,
  };
}

/**
 * Normalize subscription status input ('CANCELLED' -> 'TERMINATED').
 */
export function normalizeSubscriptionStatusInput(status) {
  const s = String(status || '').trim().toUpperCase();
  if (s === 'CANCELLED') return 'TERMINATED';
  return s;
}

/**
 * Normalize invoice status input ('CANCELLED' -> 'VOID').
 */
export function normalizeInvoiceStatusInput(status) {
  const s = String(status || '').trim().toUpperCase();
  if (s === 'CANCELLED') return 'VOID';
  return s;
}

const CANONICAL_ALIAS_GROUPS = [
  ['ELECTRICITY', 'ELEC'],
  ['WATER', 'DOMESTIC_WATER'],
  ['INTERNET_FIBER', 'INTERNET', 'WIFI'],
  ['MANAGEMENT_FEE', 'MANAGEMENT', 'COMMON_SERVICE'],
  ['PARKING_MOTO', 'MOTORBIKE_PARKING'],
];

/**
 * Get all bidirectional canonical aliases for a given service code or category.
 */
export function getCanonicalServiceAliases(rawCode, rawCategory) {
  const result = new Set();
  const code = String(rawCode || '').trim().toUpperCase();
  const cat = String(rawCategory || '').trim().toUpperCase();

  if (code) result.add(code);

  for (const group of CANONICAL_ALIAS_GROUPS) {
    if (group.includes(code) || (cat && group.includes(cat))) {
      for (const item of group) {
        result.add(item);
      }
    }
  }

  return Array.from(result);
}

/**
 * Strict 3-tier pricing resolution (FR-065):
 * 1. CONTRACT_OVERRIDE: contract_service_price with effective_from <= periodEndYmd (effective_from DESC, bidirectional aliases)
 * 2. SUBSCRIPTION_LOCKED: only when subscription.is_price_locked === true
 * 3. BUILDING_CATALOG -> DEFAULT_CATALOG: building_id = contractBuildingId -> building_id IS NULL
 */
export function resolveServiceUnitPrice({
  subscription,
  contractBuildingId,
  periodEndYmd,
  contractServicePrices = [],
  catalogItems = [],
} = {}) {
  const code = subscription?.service_code || subscription?.code;
  const cat = subscription?.service_category || subscription?.category;
  const aliasList = getCanonicalServiceAliases(code, cat);
  const aliasSet = new Set(aliasList);

  // 1. CONTRACT_OVERRIDE
  const matchedPrices = (Array.isArray(contractServicePrices) ? contractServicePrices : []).filter((csp) => {
    if (!csp) return false;
    const cCode = String(csp.service_code || '').trim().toUpperCase();
    if (!aliasSet.has(cCode)) return false;
    if (periodEndYmd && csp.effective_from) {
      const eff = toDateOnlyYmd(csp.effective_from);
      if (eff > periodEndYmd) return false;
    }
    return true;
  });

  if (matchedPrices.length > 0) {
    matchedPrices.sort((a, b) => {
      const effA = toDateOnlyYmd(a.effective_from) || '';
      const effB = toDateOnlyYmd(b.effective_from) || '';
      return effB.localeCompare(effA);
    });
    return {
      unitPrice: Number(matchedPrices[0].unit_price || 0),
      priceSource: 'CONTRACT_OVERRIDE',
    };
  }

  // 2. SUBSCRIPTION_LOCKED
  if (Boolean(subscription?.is_price_locked) === true) {
    return {
      unitPrice: Number(subscription?.unit_price || 0),
      priceSource: 'SUBSCRIPTION_LOCKED',
    };
  }

  // 3. BUILDING_CATALOG -> DEFAULT_CATALOG
  const matchedCatalog = (Array.isArray(catalogItems) ? catalogItems : []).filter((item) => {
    if (!item || item.is_active === false) return false;
    const itemCode = String(item.code || item.service_code || '').trim().toUpperCase();
    return aliasSet.has(itemCode);
  });

  if (matchedCatalog.length > 0) {
    if (contractBuildingId) {
      const bldMatch = matchedCatalog.find(
        (item) => item.building_id && String(item.building_id) === String(contractBuildingId)
      );
      if (bldMatch) {
        return {
          unitPrice: Number(bldMatch.unit_price || 0),
          priceSource: 'BUILDING_CATALOG',
        };
      }
    }
    const defMatch = matchedCatalog.find((item) => !item.building_id);
    if (defMatch) {
      return {
        unitPrice: Number(defMatch.unit_price || 0),
        priceSource: 'DEFAULT_CATALOG',
      };
    }
  }

  // Fallback to subscription unit_price if catalog item is not found
  return {
    unitPrice: Number(subscription?.unit_price || 0),
    priceSource: subscription?.is_price_locked ? 'SUBSCRIPTION_LOCKED' : 'DEFAULT_CATALOG',
  };
}

/**
 * Resolves the effective billing window for a subscription.
 */
export function resolveSubscriptionEffectiveWindow(subscription, options = {}) {
  if (!subscription) {
    return { billable: false, effectiveStart: null, effectiveEnd: null };
  }

  const rawStatus = normalizeSubscriptionStatusInput(subscription.status);
  const includePendingApproval = Boolean(options.includePendingApproval);

  if (rawStatus === 'REJECTED') {
    return { billable: false, effectiveStart: null, effectiveEnd: null };
  }
  if (rawStatus === 'PENDING_APPROVAL' && !includePendingApproval) {
    return { billable: false, effectiveStart: null, effectiveEnd: null };
  }
  if (!['ACTIVE', 'CANCELLATION_PENDING', 'TERMINATED', 'PENDING_APPROVAL'].includes(rawStatus)) {
    return { billable: false, effectiveStart: null, effectiveEnd: null };
  }

  const startYmd = toDateOnlyYmd(subscription.start_date);
  if (!startYmd) {
    return { billable: false, effectiveStart: null, effectiveEnd: null };
  }

  const endYmd = subscription.end_date ? toDateOnlyYmd(subscription.end_date) : null;

  if (rawStatus === 'TERMINATED') {
    if (!endYmd || endYmd < startYmd) {
      return { billable: false, effectiveStart: null, effectiveEnd: null };
    }
    return { billable: true, effectiveStart: startYmd, effectiveEnd: endYmd };
  }

  if (endYmd && endYmd < startYmd) {
    return { billable: false, effectiveStart: null, effectiveEnd: null };
  }

  return { billable: true, effectiveStart: startYmd, effectiveEnd: endYmd };
}

/**
 * Computes pro-rata subscription charges for a given billing period (PRD AC-015.3, Spec 5.1.6, 5.2).
 */
export function computeSubscriptionPeriodCharge({
  subscription,
  periodYm,
  boundStartYmd,
  boundEndYmd,
  contractBuildingId,
  contractServicePrices,
  catalogItems,
  lockedUnitPrice,
  lockedQuantity,
  includePendingApproval = false,
} = {}) {
  const { monthStart, monthEnd, daysInMonth } = getMonthBoundsYmd(periodYm);
  const bStart = boundStartYmd || monthStart;
  const bEnd = boundEndYmd || monthEnd;

  const priceRes =
    lockedUnitPrice !== undefined && lockedUnitPrice !== null
      ? { unitPrice: Number(lockedUnitPrice), priceSource: 'INVOICE_LOCKED' }
      : resolveServiceUnitPrice({
          subscription,
          contractBuildingId,
          periodEndYmd: bEnd,
          contractServicePrices,
          catalogItems,
        });

  const unitPrice = priceRes.unitPrice;
  const priceSource = priceRes.priceSource;
  const quantity =
    lockedQuantity !== undefined && lockedQuantity !== null
      ? Number(lockedQuantity)
      : Math.max(1, Number(subscription?.quantity || 1));

  const win = resolveSubscriptionEffectiveWindow(subscription, { includePendingApproval });
  const subName = subscription?.service_name || subscription?.service_code || 'Dịch vụ';

  if (!win.billable) {
    return {
      activeDays: 0,
      daysInMonth,
      isProrated: false,
      unitPrice,
      quantity,
      priceSource,
      rawAmount: 0,
      amount: 0,
      overlapStart: null,
      overlapEnd: null,
      description: `${subName} (0 ngày)`,
      formulaMeta: {
        billing_mode: 'FULL',
        price_source: priceSource,
        unit_price: unitPrice,
        quantity,
        active_days: 0,
        days_in_month: daysInMonth,
        overlap_start: null,
        overlap_end: null,
        raw_amount: 0,
        rounded_amount: 0,
      },
    };
  }

  const overlapStart = win.effectiveStart > bStart ? win.effectiveStart : bStart;
  const effectiveEnd = win.effectiveEnd || bEnd;
  const overlapEnd = effectiveEnd < bEnd ? effectiveEnd : bEnd;

  if (overlapStart > overlapEnd) {
    return {
      activeDays: 0,
      daysInMonth,
      isProrated: false,
      unitPrice,
      quantity,
      priceSource,
      rawAmount: 0,
      amount: 0,
      overlapStart: null,
      overlapEnd: null,
      description: `${subName} (0 ngày)`,
      formulaMeta: {
        billing_mode: 'FULL',
        price_source: priceSource,
        unit_price: unitPrice,
        quantity,
        active_days: 0,
        days_in_month: daysInMonth,
        overlap_start: null,
        overlap_end: null,
        raw_amount: 0,
        rounded_amount: 0,
      },
    };
  }

  const activeDays = diffDaysYmd(overlapStart, overlapEnd) + 1;
  const isProrated = activeDays < daysInMonth;
  const rawAmount = isProrated
    ? (unitPrice * quantity * activeDays) / daysInMonth
    : unitPrice * quantity;
  const amount = roundVND(rawAmount);

  const description = isProrated
    ? `${subName} (${overlapStart} → ${overlapEnd}, ${activeDays}/${daysInMonth} ngày)`
    : `${subName} (${periodYm})`;

  return {
    activeDays,
    daysInMonth,
    isProrated,
    unitPrice,
    quantity,
    priceSource,
    rawAmount,
    amount,
    overlapStart,
    overlapEnd,
    description,
    formulaMeta: {
      billing_mode: isProrated ? 'PRORATED' : 'FULL',
      price_source: priceSource,
      unit_price: unitPrice,
      quantity,
      active_days: activeDays,
      days_in_month: daysInMonth,
      overlap_start: overlapStart,
      overlap_end: overlapEnd,
      raw_amount: rawAmount,
      rounded_amount: amount,
    },
  };
}

/**
 * Resolves the last active calendar day of a contract.
 * Crucial: when roomTransferChildStartDate or isRoomTransfer is provided, ALWAYS computes
 * lastActiveDayYmd = addDaysYmd(childStartDate || explicitEndYmd, -1), completely ignoring
 * contract.terminated_at (which M06 clamps to today on future room transfers).
 */
export function resolveContractLastActiveDay(contract, options = {}) {
  const {
    explicitEndYmd,
    roomTransferChildStartDate,
    isNaturalExpiry,
    isRoomTransfer,
  } = options;

  const startYmd = toDateOnlyYmd(contract?.start_date);

  // Future room-transfer cutoff: ALWAYS compute lastActiveDayYmd = addDaysYmd(childStartDate || explicitEndYmd, -1)
  if (roomTransferChildStartDate || isRoomTransfer) {
    const childStart = roomTransferChildStartDate || explicitEndYmd;
    if (childStart) {
      const lastActiveDayYmd = addDaysYmd(toDateOnlyYmd(childStart), -1);
      const movedIn = Boolean(startYmd && lastActiveDayYmd >= startYmd);
      return { movedIn, lastActiveDayYmd };
    }
  }

  // Natural expiry: lease is half-open [start_date, end_date), last active day is end_date - 1
  if (isNaturalExpiry) {
    const target = explicitEndYmd || contract?.end_date;
    if (target) {
      const lastActiveDayYmd = addDaysYmd(toDateOnlyYmd(target), -1);
      const movedIn = Boolean(startYmd && lastActiveDayYmd >= startYmd);
      return { movedIn, lastActiveDayYmd };
    }
  }

  // Explicit end date
  if (explicitEndYmd) {
    const lastActiveDayYmd = toDateOnlyYmd(explicitEndYmd);
    const movedIn = Boolean(startYmd && lastActiveDayYmd >= startYmd);
    return { movedIn, lastActiveDayYmd };
  }

  // Default contract termination resolution:
  if (contract?.terminated_at) {
    const lastActiveDayYmd = toDateOnlyYmd(contract.terminated_at);
    const movedIn = Boolean(startYmd && lastActiveDayYmd >= startYmd);
    return { movedIn, lastActiveDayYmd };
  }

  if (contract?.end_date) {
    const lastActiveDayYmd = addDaysYmd(toDateOnlyYmd(contract.end_date), -1);
    const movedIn = Boolean(startYmd && lastActiveDayYmd >= startYmd);
    return { movedIn, lastActiveDayYmd };
  }

  return { movedIn: false, lastActiveDayYmd: '' };
}

/**
 * Computes pro-rata contract rent charges for a given billing period (PRD AC-015.3, Spec 5.1.6, 5.2).
 */
export function computeContractRentPeriodCharge({
  contract,
  periodYm,
  lastActiveDayYmd,
  lockedRentAmount,
} = {}) {
  const { monthStart, monthEnd, daysInMonth } = getMonthBoundsYmd(periodYm);
  const startYmd = toDateOnlyYmd(contract?.start_date);
  const endActiveYmd =
    lastActiveDayYmd || resolveContractLastActiveDay(contract).lastActiveDayYmd;

  const unitPrice =
    lockedRentAmount !== undefined && lockedRentAmount !== null
      ? Number(lockedRentAmount)
      : Number(contract?.rent_amount || 0);

  const priceSource =
    lockedRentAmount !== undefined && lockedRentAmount !== null
      ? 'INVOICE_LOCKED'
      : 'CONTRACT_RENT';

  if (!startYmd || !endActiveYmd || endActiveYmd < startYmd) {
    return {
      activeDays: 0,
      daysInMonth,
      isProrated: false,
      unitPrice,
      rawAmount: 0,
      amount: 0,
      overlapStart: null,
      overlapEnd: null,
      description: 'Tiền thuê phòng (0 ngày)',
      formulaMeta: {
        billing_mode: 'FULL',
        price_source: priceSource,
        unit_price: unitPrice,
        quantity: 1,
        active_days: 0,
        days_in_month: daysInMonth,
        overlap_start: null,
        overlap_end: null,
        raw_amount: 0,
        rounded_amount: 0,
      },
    };
  }

  const overlapStart = startYmd > monthStart ? startYmd : monthStart;
  const overlapEnd = endActiveYmd < monthEnd ? endActiveYmd : monthEnd;

  if (overlapStart > overlapEnd) {
    return {
      activeDays: 0,
      daysInMonth,
      isProrated: false,
      unitPrice,
      rawAmount: 0,
      amount: 0,
      overlapStart: null,
      overlapEnd: null,
      description: 'Tiền thuê phòng (0 ngày)',
      formulaMeta: {
        billing_mode: 'FULL',
        price_source: priceSource,
        unit_price: unitPrice,
        quantity: 1,
        active_days: 0,
        days_in_month: daysInMonth,
        overlap_start: null,
        overlap_end: null,
        raw_amount: 0,
        rounded_amount: 0,
      },
    };
  }

  const activeDays = diffDaysYmd(overlapStart, overlapEnd) + 1;
  const isProrated = activeDays < daysInMonth;
  const rawAmount = isProrated
    ? (unitPrice * activeDays) / daysInMonth
    : unitPrice;
  const amount = roundVND(rawAmount);

  const description = isProrated
    ? `Tiền thuê phòng (${overlapStart} → ${overlapEnd}, ${activeDays}/${daysInMonth} ngày)`
    : `Tiền thuê phòng kỳ ${periodYm}`;

  return {
    activeDays,
    daysInMonth,
    isProrated,
    unitPrice,
    rawAmount,
    amount,
    overlapStart,
    overlapEnd,
    description,
    formulaMeta: {
      billing_mode: isProrated ? 'PRORATED' : 'FULL',
      price_source: priceSource,
      unit_price: unitPrice,
      quantity: 1,
      active_days: activeDays,
      days_in_month: daysInMonth,
      overlap_start: overlapStart,
      overlap_end: overlapEnd,
      raw_amount: rawAmount,
      rounded_amount: amount,
    },
  };
}

/**
 * Resolves utility (ELECTRICITY / WATER) unit price across tiers (FR-065):
 * 1. CONTRACT_OVERRIDE -> 2. BUILDING_CATALOG -> 3. METER_CONFIG (meterUnitPrice > 0) -> 4. DEFAULT_CATALOG
 */
export function resolveUtilityUnitPrice({
  meterType,
  meterUnitPrice,
  contractBuildingId,
  periodEndYmd,
  contractServicePrices = [],
  catalogItems = [],
  defaultUtilityPrice = 0,
} = {}) {
  const aliasSet = new Set(getCanonicalServiceAliases(meterType, meterType));

  // 1. CONTRACT_OVERRIDE
  const matchedPrices = (Array.isArray(contractServicePrices) ? contractServicePrices : []).filter((csp) => {
    if (!csp) return false;
    const cCode = String(csp.service_code || '').trim().toUpperCase();
    if (!aliasSet.has(cCode)) return false;
    if (periodEndYmd && csp.effective_from) {
      const eff = toDateOnlyYmd(csp.effective_from);
      if (eff > periodEndYmd) return false;
    }
    return true;
  });

  if (matchedPrices.length > 0) {
    matchedPrices.sort((a, b) => {
      const effA = toDateOnlyYmd(a.effective_from) || '';
      const effB = toDateOnlyYmd(b.effective_from) || '';
      return effB.localeCompare(effA);
    });
    return {
      unitPrice: Number(matchedPrices[0].unit_price || 0),
      priceSource: 'CONTRACT_OVERRIDE',
    };
  }

  // 2. BUILDING_CATALOG & 4. DEFAULT_CATALOG candidates
  const matchedCatalog = (Array.isArray(catalogItems) ? catalogItems : []).filter((item) => {
    if (!item || item.is_active === false) return false;
    const itemCode = String(item.code || item.service_code || '').trim().toUpperCase();
    return aliasSet.has(itemCode);
  });

  if (contractBuildingId && matchedCatalog.length > 0) {
    const bldMatch = matchedCatalog.find(
      (item) => item.building_id && String(item.building_id) === String(contractBuildingId)
    );
    if (bldMatch) {
      return {
        unitPrice: Number(bldMatch.unit_price || 0),
        priceSource: 'BUILDING_CATALOG',
      };
    }
  }

  // 3. METER_CONFIG
  const meterPriceNum = Number(meterUnitPrice || 0);
  if (Number.isFinite(meterPriceNum) && meterPriceNum > 0) {
    return {
      unitPrice: meterPriceNum,
      priceSource: 'METER_CONFIG',
    };
  }

  // 4. DEFAULT_CATALOG
  const defMatch = matchedCatalog.find((item) => !item.building_id);
  if (defMatch) {
    return {
      unitPrice: Number(defMatch.unit_price || 0),
      priceSource: 'DEFAULT_CATALOG',
    };
  }

  return {
    unitPrice: Number(defaultUtilityPrice || 0),
    priceSource: 'DEFAULT_CATALOG',
  };
}

/**
 * Resolves all contract billing_day values (1..31) that should fire on asOfDateYmd (FR-066).
 * On the last calendar day of a short month (28/29/30), higher billing days up to 31 clamp onto that day.
 */
export function resolveBillingDaysForDate(asOfDateYmd) {
  const cleanYmd = toDateOnlyYmd(asOfDateYmd);
  if (!cleanYmd) return [];
  const day = Number(cleanYmd.slice(8, 10));
  if (!Number.isInteger(day) || day < 1 || day > 31) return [];
  const { daysInMonth } = getMonthBoundsYmd(cleanYmd.slice(0, 7));
  if (day < daysInMonth) {
    return [day];
  }
  const result = [];
  for (let d = daysInMonth; d <= 31; d += 1) {
    result.push(d);
  }
  return result;
}

const VN_OFFSET_MS = 7 * 3600 * 1000;

/**
 * Computes milliseconds (>= 1000) until the next occurrence of HH:mm:00 in Asia/Ho_Chi_Minh (UTC+7).
 */
export function computeNextVietnamDailyRunMs(nowDate = new Date(), targetHour = 0, targetMinute = 5) {
  const dt = nowDate instanceof Date && !Number.isNaN(nowDate.getTime()) ? nowDate : new Date(nowDate);
  const nowMs = dt.getTime();
  const vnShifted = new Date(nowMs + VN_OFFSET_MS);
  const vnY = vnShifted.getUTCFullYear();
  const vnM = vnShifted.getUTCMonth();
  const vnD = vnShifted.getUTCDate();

  let targetMs = Date.UTC(vnY, vnM, vnD, Number(targetHour || 0), Number(targetMinute || 0), 0, 0) - VN_OFFSET_MS;
  if (targetMs - nowMs < 1000) {
    targetMs = Date.UTC(vnY, vnM, vnD + 1, Number(targetHour || 0), Number(targetMinute || 0), 0, 0) - VN_OFFSET_MS;
  }
  return Math.max(1000, targetMs - nowMs);
}

/**
 * Computes append-only late payment penalty delta (FR-064):
 * - 100,000 VND/day after graceDays (default 5)
 * - Stops accruing new penalties once principalAmount is fully settled by paidAmount + creditOffsetAmount
 * - Preserves 4-eyes waivers via deltaFee = Math.max(0, expectedTotalLateFee - grossAccruedLateFee)
 */
export function computeLateFeeAccrual({
  dueDateYmd,
  asOfDateYmd,
  totalAmount,
  paidAmount = 0,
  creditOffsetAmount = 0,
  principalAmount = null,
  grossAccruedLateFee = 0,
  graceDays = 5,
  lateFeePerDay = 100000,
  maxLateFeeCap = null,
} = {}) {
  const dueStr = toDateOnlyYmd(dueDateYmd);
  const asOfStr = toDateOnlyYmd(asOfDateYmd);
  const total = Number(totalAmount || 0);
  const paid = Number(paidAmount || 0);
  const creditOffset = Number(creditOffsetAmount || 0);
  const grossAccrued = Math.max(0, Number(grossAccruedLateFee || 0));
  const grace = Math.max(0, Number(graceDays ?? 5));
  const ratePerDay = Math.max(0, Number(lateFeePerDay ?? 100000));
  const cap = maxLateFeeCap !== null && maxLateFeeCap !== undefined && Number(maxLateFeeCap) > 0
    ? roundVND(Number(maxLateFeeCap))
    : null;

  const principalSettled =
    principalAmount !== null &&
    principalAmount !== undefined &&
    Number(principalAmount) <= paid + creditOffset;

  if (!dueStr || !asOfStr || paid >= total || total <= 0) {
    return {
      isOverdue: false,
      principalSettled,
      overdueDays: 0,
      chargeableDays: 0,
      expectedTotalLateFee: 0,
      deltaFee: 0,
      capped: false,
    };
  }

  const overdueDays = asOfStr > dueStr ? Math.max(0, diffDaysYmd(dueStr, asOfStr)) : 0;
  if (overdueDays <= 0) {
    return {
      isOverdue: false,
      principalSettled,
      overdueDays: 0,
      chargeableDays: 0,
      expectedTotalLateFee: 0,
      deltaFee: 0,
      capped: false,
    };
  }

  if (principalSettled) {
    return {
      isOverdue: true,
      principalSettled: true,
      overdueDays,
      chargeableDays: Math.max(0, overdueDays - grace),
      expectedTotalLateFee: grossAccrued,
      deltaFee: 0,
      capped: false,
    };
  }

  const chargeableDays = Math.max(0, overdueDays - grace);
  let expectedTotalLateFee = roundVND(chargeableDays * ratePerDay);
  let capped = false;
  if (cap !== null && expectedTotalLateFee > cap) {
    expectedTotalLateFee = cap;
    capped = true;
  }

  const deltaFee = roundVND(Math.max(0, expectedTotalLateFee - grossAccrued));
  return {
    isOverdue: true,
    principalSettled: false,
    overdueDays,
    chargeableDays,
    expectedTotalLateFee,
    deltaFee,
    capped,
  };
}

/**
 * Evaluates meter reading consumption and > 30% variance against up to 3 prior positive CONFIRMED periods (FR-030, FR-031).
 */
export function evaluateMeterReadingAnomaly({
  previousReading,
  currentReading,
  recentConsumptions = [],
  thresholdRatio = 0.3,
} = {}) {
  const prev = Number(previousReading ?? 0);
  const curr = Number(currentReading);

  if (!Number.isFinite(prev) || !Number.isFinite(curr) || curr < prev) {
    return {
      valid: false,
      code: 'INVALID_READING',
      consumption: 0,
      baselineAvg: null,
      varianceRatio: null,
      diffPct: null,
      isAbnormal: false,
    };
  }

  const consumption = Number((curr - prev).toFixed(2));
  const positiveHistory = (Array.isArray(recentConsumptions) ? recentConsumptions : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(0, 3);

  if (positiveHistory.length === 0) {
    return {
      valid: true,
      consumption,
      baselineAvg: null,
      varianceRatio: null,
      diffPct: null,
      isAbnormal: false,
    };
  }

  const sum = positiveHistory.reduce((acc, v) => acc + v, 0);
  const baselineAvg = Number((sum / positiveHistory.length).toFixed(2));
  const rawDelta = consumption - baselineAvg;
  const varianceRatio = Math.abs(rawDelta) / baselineAvg;
  const diffPct = Math.round((rawDelta / baselineAvg) * 100);
  const effThreshold = Number.isFinite(Number(thresholdRatio)) && Number(thresholdRatio) > 0
    ? Number(thresholdRatio)
    : 0.3;
  // Compare against unrounded ratio (curr - prev vs sum/N) with tiny float epsilon guard
  const exactBaseline = sum / positiveHistory.length;
  const exactRatio = Math.abs(consumption - exactBaseline) / exactBaseline;
  const isAbnormal = exactRatio > effThreshold + 1e-9;

  return {
    valid: true,
    consumption,
    baselineAvg,
    varianceRatio: Number(exactRatio.toFixed(4)),
    diffPct,
    isAbnormal,
  };
}
