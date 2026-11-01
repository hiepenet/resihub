import { roundVND } from './pricing.js';

function toDateStr(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(val).slice(0, 10);
}

function parseYmd(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return { y, m, d };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatYmd(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function daysInMonthUtc(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDaysYmd(ymd, deltaDays) {
  const { y, m, d } = parseYmd(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return formatYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function diffDaysYmd(startYmd, endYmd) {
  const a = parseYmd(startYmd);
  const b = parseYmd(endYmd);
  const msA = Date.UTC(a.y, a.m - 1, a.d);
  const msB = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((msB - msA) / 86400000);
}

function resolveSubscriptionUnitPrice(sub, cspMap) {
  const codeKey = String(sub.service_code || sub.code || '').toUpperCase();
  const catKey = String(sub.service_category || sub.category || '').toUpperCase();

  let overrideUnitPrice = cspMap.has(codeKey) ? cspMap.get(codeKey) : undefined;
  if (overrideUnitPrice === undefined) {
    if (codeKey === 'INTERNET_FIBER' || catKey === 'INTERNET') {
      overrideUnitPrice = cspMap.get('INTERNET');
    } else if (codeKey === 'MANAGEMENT_FEE' || catKey === 'MANAGEMENT') {
      overrideUnitPrice = cspMap.get('COMMON_SERVICE');
    }
  }

  return overrideUnitPrice !== undefined ? Number(overrideUnitPrice) : Number(sub.unit_price || 0);
}

function buildCspMapForDate(servicePrices, asOfDateStr) {
  const sorted = [...(Array.isArray(servicePrices) ? servicePrices : [])].sort((a, b) =>
    toDateStr(b.effective_from).localeCompare(toDateStr(a.effective_from))
  );
  const cspMap = new Map();
  for (const row of sorted) {
    const eff = toDateStr(row.effective_from);
    if (eff && eff > asOfDateStr) continue;
    const key = String(row.service_code || '').toUpperCase();
    if (key && !cspMap.has(key)) {
      cspMap.set(key, Number(row.unit_price || 0));
    }
  }
  return cspMap;
}

/**
 * Sinh lịch hóa đơn dự kiến (expected invoice schedule) cho toàn kỳ hợp đồng (FR-014).
 * Đồng bộ quy tắc tính ngày hiệu lực, pro-rata, ghi đè giá dịch vụ (FR-065) và kẹp ngày cuối tháng (1..31).
 */
export function buildExpectedInvoiceSchedule({
  contract,
  subscriptions = [],
  servicePrices = [],
  existingInvoices = [],
} = {}) {
  if (!contract || contract.status === 'CANCELLED') {
    return [];
  }

  const startStr = toDateStr(contract.start_date);
  const rawEndStr = toDateStr(contract.terminated_at || contract.end_date);
  if (!startStr || !rawEndStr || rawEndStr <= startStr) {
    return [];
  }

  const fullRent = Math.max(0, Number(contract.rent_amount || 0));
  const billingCycle = contract.billing_cycle === 'quarterly' ? 'quarterly' : 'monthly';
  const billingDay = Math.min(31, Math.max(1, Number(contract.billing_day || 1)));
  const paymentDueDays = Math.min(60, Math.max(1, Number(contract.payment_due_days || 5)));
  const isInclusiveEndStatus = ['TERMINATED', 'EXPIRED', 'TERMINATION_PENDING'].includes(contract.status);

  const validSubs = (Array.isArray(subscriptions) ? subscriptions : []).filter(
    (s) =>
      s &&
      String(s.billing_type || 'FIXED').toUpperCase() !== 'METERED' &&
      !['CANCELLED', 'REJECTED'].includes(String(s.status || '').toUpperCase())
  );

  const startParts = parseYmd(startStr);
  let curY = startParts.y;
  let curM = startParts.m;

  const monthlySlices = [];
  let guard = 0;

  while (guard < 240) {
    guard += 1;
    const monthStart = formatYmd(curY, curM, 1);
    const nextY = curM === 12 ? curY + 1 : curY;
    const nextM = curM === 12 ? 1 : curM + 1;
    const nextMonthStart = formatYmd(nextY, nextM, 1);

    if (rawEndStr <= monthStart) {
      break;
    }

    const totalDays = daysInMonthUtc(curY, curM);
    const startBound = startStr > monthStart ? startStr : monthStart;
    const endBound = rawEndStr < nextMonthStart ? rawEndStr : nextMonthStart;
    const inclusiveBonus =
      isInclusiveEndStatus && rawEndStr > monthStart && rawEndStr < nextMonthStart ? 1 : 0;
    const activeDays = Math.max(0, Math.min(totalDays, diffDaysYmd(startBound, endBound) + inclusiveBonus));

    if (activeDays > 0) {
      const periodStr = `${curY}-${pad2(curM)}`;
      const periodStart = startBound;
      const periodEnd = addDaysYmd(periodStart, activeDays - 1);
      const isProrated = activeDays < totalDays;
      const expectedRent = isProrated
        ? roundVND((fullRent * activeDays) / totalDays)
        : roundVND(fullRent);

      const cspMap = buildCspMapForDate(servicePrices, periodEnd);
      let expectedFixedServices = 0;

      for (const sub of validSubs) {
        const subStart = toDateStr(sub.start_date) || startStr;
        const subEnd = toDateStr(sub.end_date);
        if (subStart > periodEnd) continue;
        if (subEnd && subEnd < periodStart) continue;

        const unitPrice = resolveSubscriptionUnitPrice(sub, cspMap);
        const qty = Math.max(1, Number(sub.quantity || 1));
        const svcAmt = isProrated
          ? roundVND((unitPrice * qty * activeDays) / totalDays)
          : roundVND(unitPrice * qty);
        expectedFixedServices += svcAmt;
      }

      monthlySlices.push({
        year: curY,
        month: curM,
        period: periodStr,
        period_start: periodStart,
        period_end: periodEnd,
        days_in_month: totalDays,
        active_days: activeDays,
        is_prorated: isProrated,
        expected_rent: expectedRent,
        expected_fixed_services: expectedFixedServices,
      });
    }

    curY = nextY;
    curM = nextM;
  }

  const nonCancelledInvoices = (Array.isArray(existingInvoices) ? existingInvoices : []).filter(
    (inv) => inv && inv.status !== 'CANCELLED'
  );

  const chunkSize = billingCycle === 'quarterly' ? 3 : 1;
  const schedule = [];

  for (let i = 0; i < monthlySlices.length; i += chunkSize) {
    const chunk = monthlySlices.slice(i, i + chunkSize);
    const first = chunk[0];
    const last = chunk[chunk.length - 1];

    const clampedIssueDay = Math.min(billingDay, daysInMonthUtc(first.year, first.month));
    const rawIssueDate = formatYmd(first.year, first.month, clampedIssueDay);
    const issueDate = rawIssueDate < first.period_start ? first.period_start : rawIssueDate;
    const dueDate = addDaysYmd(issueDate, paymentDueDays);

    const expectedRent = chunk.reduce((sum, m) => sum + m.expected_rent, 0);
    const expectedFixedServices = chunk.reduce((sum, m) => sum + m.expected_fixed_services, 0);
    const expectedTotal = expectedRent + expectedFixedServices;
    const isProrated =
      chunk.some((m) => m.is_prorated) || (billingCycle === 'quarterly' && chunk.length < 3);

    const matchedInvoice =
      nonCancelledInvoices.find((inv) => chunk.some((m) => m.period === inv.period)) || null;

    schedule.push({
      period_no: schedule.length + 1,
      billing_period:
        chunk.length === 1 ? first.period : `${first.period} → ${last.period}`,
      period_start: first.period_start,
      period_end: last.period_end,
      issue_date: issueDate,
      due_date: dueDate,
      is_prorated: isProrated,
      expected_rent: expectedRent,
      expected_fixed_services: expectedFixedServices,
      expected_total: expectedTotal,
      metered_note: 'Chưa bao gồm điện/nước theo chỉ số đồng hồ thực tế',
      actual_invoice: matchedInvoice
        ? {
            id: matchedInvoice.id,
            invoice_code: matchedInvoice.invoice_code || matchedInvoice.invoice_no || null,
            period: matchedInvoice.period,
            status: matchedInvoice.status,
            total_amount: Number(matchedInvoice.total_amount || 0),
          }
        : null,
    });
  }

  return schedule;
}
