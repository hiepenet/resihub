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
  ['INTERNET_FIBER', 'INTERNET'],
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
      const effA = toDateOnlyYmd(a.effective_from);
      const effB = toDateOnlyYmd(b.effective_from);
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
    if (!item) return false;
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
