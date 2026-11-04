export const REVENUE_SOURCE_KEYS = ['rent', 'electricity', 'water', 'service', 'other'];

export const AGING_BUCKET_DEFS = [
  { key: 'current_not_due', label: 'Chưa đến hạn' },
  { key: '0_15', label: '1–15 ngày' },
  { key: '16_30', label: '16–30 ngày' },
  { key: '31_60', label: '31–60 ngày' },
  { key: 'over_60', label: '>60 ngày' },
];

const SPILL_ORDER = ['other', 'service', 'water', 'electricity', 'rent'];
const IGNORED_INVOICE_STATUSES = new Set(['DRAFT', 'VOID', 'CANCELLED']);

export function parseDashboardMonthsParam(rawMonths) {
  if (rawMonths === undefined || rawMonths === null || String(rawMonths).trim() === '') {
    return { valid: true, months: 12 };
  }
  const clean = String(rawMonths).trim();
  if (!/^\d+$/.test(clean)) {
    return {
      valid: false,
      code: 'VALIDATION_ERROR',
      message: 'Tham số months phải là số nguyên từ 1 đến 24.',
    };
  }
  const months = Number(clean);
  if (!Number.isInteger(months) || months < 1 || months > 24) {
    return {
      valid: false,
      code: 'VALIDATION_ERROR',
      message: 'Tham số months phải nằm trong khoảng từ 1 đến 24.',
    };
  }
  return { valid: true, months };
}

export function buildRecentMonthsPeriods(todayVnYmd, months = 12) {
  const safeCount = Math.max(1, Math.min(24, Math.trunc(Number(months || 12))));
  const ym = String(todayVnYmd || '').slice(0, 7);
  let year;
  let month;
  if (/^\d{4}-\d{2}$/.test(ym)) {
    [year, month] = ym.split('-').map(Number);
  } else {
    const nowVn = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date());
    [year, month] = nowVn.slice(0, 7).split('-').map(Number);
  }

  const periods = [];
  for (let i = safeCount - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    periods.push(`${yyyy}-${mm}`);
  }
  return periods;
}

export function getPeriodEndYmd(periodYm) {
  const clean = String(periodYm || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(clean)) return '';
  const [y, m] = clean.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return '';
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
}

function mapLineToSourceBucket(itemType, formulaMeta) {
  const rawType = String(itemType || '').trim().toUpperCase();
  let metaObj = formulaMeta;
  if (typeof metaObj === 'string') {
    try {
      metaObj = JSON.parse(metaObj);
    } catch {
      metaObj = null;
    }
  }
  const effectiveType =
    rawType === 'ADJUSTMENT'
      ? String(metaObj?.adjusts_item_type || 'OTHER').trim().toUpperCase()
      : rawType;

  if (effectiveType === 'RENT') return 'rent';
  if (effectiveType === 'ELECTRICITY') return 'electricity';
  if (effectiveType === 'WATER') return 'water';
  if (effectiveType === 'SERVICE') return 'service';
  return 'other';
}

export function aggregateInvoiceLinesBySource({ invoices = [], lines = [], periods = [] } = {}) {
  const periodMap = new Map();
  for (const p of periods) {
    periodMap.set(p, {
      period: p,
      rent: 0,
      electricity: 0,
      water: 0,
      service: 0,
      other: 0,
      total_billed: 0,
    });
  }

  const linesByInvId = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line || !line.invoice_id) continue;
    const key = String(line.invoice_id);
    if (!linesByInvId.has(key)) linesByInvId.set(key, []);
    linesByInvId.get(key).push(line);
  }

  for (const inv of Array.isArray(invoices) ? invoices : []) {
    if (!inv || !periodMap.has(inv.period)) continue;
    const statusUpper = String(inv.status || '').trim().toUpperCase();
    if (IGNORED_INVOICE_STATUSES.has(statusUpper)) continue;

    const invoiceBilled = Math.max(
      0,
      Math.round(Number(inv.total_amount || 0) + Math.max(0, Number(inv.credit_offset_amount || 0)))
    );

    const invBuckets = {
      rent: 0,
      electricity: 0,
      water: 0,
      service: 0,
      other: 0,
    };

    const invLines = linesByInvId.get(String(inv.id)) || [];
    if (invLines.length === 0) {
      invBuckets.other = invoiceBilled;
    } else {
      for (const l of invLines) {
        const bKey = mapLineToSourceBucket(l.item_type, l.formula_meta);
        invBuckets[bKey] += Math.round(Number(l.amount || 0));
      }

      // Clamp negative bucket balances and spill across remaining positive buckets
      let deficit = 0;
      for (const k of REVENUE_SOURCE_KEYS) {
        if (invBuckets[k] < 0) {
          deficit += -invBuckets[k];
          invBuckets[k] = 0;
        }
      }
      if (deficit > 0) {
        for (const k of SPILL_ORDER) {
          if (deficit <= 0) break;
          const deduct = Math.min(invBuckets[k], deficit);
          invBuckets[k] -= deduct;
          deficit -= deduct;
        }
      }

      // Reconcile line sum to invoiceBilled so stacked bars match billed KPI 100%
      const currentSum =
        invBuckets.rent +
        invBuckets.electricity +
        invBuckets.water +
        invBuckets.service +
        invBuckets.other;

      if (currentSum < invoiceBilled) {
        invBuckets.other += invoiceBilled - currentSum;
      } else if (currentSum > invoiceBilled) {
        let excess = currentSum - invoiceBilled;
        for (const k of SPILL_ORDER) {
          if (excess <= 0) break;
          const trim = Math.min(invBuckets[k], excess);
          invBuckets[k] -= trim;
          excess -= trim;
        }
      }
    }

    const acc = periodMap.get(inv.period);
    acc.rent += invBuckets.rent;
    acc.electricity += invBuckets.electricity;
    acc.water += invBuckets.water;
    acc.service += invBuckets.service;
    acc.other += invBuckets.other;
    acc.total_billed += invoiceBilled;
  }

  return periods.map((p) => periodMap.get(p));
}

export function normalizeReceivablesAging(rawRow = {}) {
  const row = rawRow || {};
  const amountsByKey = {
    current_not_due: Math.max(0, Math.round(Number(row.current_not_due || 0))),
    '0_15': Math.max(0, Math.round(Number(row.bucket_0_15 ?? row['0_15'] ?? 0))),
    '16_30': Math.max(0, Math.round(Number(row.bucket_16_30 ?? row['16_30'] ?? 0))),
    '31_60': Math.max(0, Math.round(Number(row.bucket_31_60 ?? row['31_60'] ?? 0))),
    over_60: Math.max(0, Math.round(Number(row.bucket_over_60 ?? row.over_60 ?? 0))),
  };

  const countsByKey = {
    current_not_due: Math.max(0, Math.trunc(Number(row.count_current_not_due || 0))),
    '0_15': Math.max(0, Math.trunc(Number(row.count_0_15 || 0))),
    '16_30': Math.max(0, Math.trunc(Number(row.count_16_30 || 0))),
    '31_60': Math.max(0, Math.trunc(Number(row.count_31_60 || 0))),
    over_60: Math.max(0, Math.trunc(Number(row.count_over_60 || 0))),
  };

  const buckets = AGING_BUCKET_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    amount: amountsByKey[def.key] || 0,
    count: countsByKey[def.key] || 0,
  }));

  const total_debt = buckets.reduce((sum, b) => sum + b.amount, 0);
  const overdue_debt = buckets
    .filter((b) => b.key !== 'current_not_due')
    .reduce((sum, b) => sum + b.amount, 0);
  const total_count = buckets.reduce((sum, b) => sum + b.count, 0);

  return {
    buckets,
    total_debt,
    overdue_debt,
    total_count,
  };
}

export function buildMonthlyOccupancySeries({
  periods = [],
  currentPeriod,
  totalExploitableApartments = 0,
  currentOccupiedCount = 0,
  monthlyOccupiedByPeriod = {},
} = {}) {
  const exploitable = Math.max(0, Math.trunc(Number(totalExploitableApartments || 0)));

  return (Array.isArray(periods) ? periods : []).map((period) => {
    if (exploitable <= 0) {
      return {
        period,
        occupied: 0,
        exploitable: 0,
        occupancy_rate: 0,
      };
    }

    const rawOccupied =
      period === currentPeriod
        ? Number(currentOccupiedCount || 0)
        : Number(monthlyOccupiedByPeriod?.[period] || 0);

    const occupied = Math.min(exploitable, Math.max(0, Math.trunc(rawOccupied)));
    const occupancy_rate = Number(((occupied / exploitable) * 100).toFixed(1));

    return {
      period,
      occupied,
      exploitable,
      occupancy_rate,
    };
  });
}
