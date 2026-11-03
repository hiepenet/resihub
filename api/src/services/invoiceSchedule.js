import { roundVND } from './pricing.js';
import {
  toDateOnlyYmd,
  addDaysYmd,
  diffDaysYmd,
  getMonthBoundsYmd,
  normalizeSubscriptionStatusInput,
  normalizeInvoiceStatusInput,
  computeSubscriptionPeriodCharge,
} from './serviceBilling.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Sinh lịch hóa đơn dự kiến (expected invoice schedule) cho toàn kỳ hợp đồng (FR-014).
 * Đồng bộ quy tắc tính ngày hiệu lực, pro-rata, ghi đè giá dịch vụ (FR-065), kẹp ngày cuối tháng (1..31),
 * bảo toàn các kỳ lịch sử 1..N-1 cho các gói dịch vụ đã huỷ (TERMINATED), và hỗ trợ mốc cắt chuyển phòng tương lai (roomTransferChildStartDate).
 */
export function buildExpectedInvoiceSchedule({
  contract,
  subscriptions = [],
  servicePrices = [],
  existingInvoices = [],
  roomTransferChildStartDate = null,
  catalogItems = [],
} = {}) {
  if (!contract || contract.status === 'CANCELLED') {
    return [];
  }

  const startStr = toDateOnlyYmd(contract.start_date);
  const rawEndStr = roomTransferChildStartDate
    ? toDateOnlyYmd(roomTransferChildStartDate)
    : toDateOnlyYmd(contract.terminated_at || contract.end_date);

  if (!startStr || !rawEndStr || rawEndStr <= startStr) {
    return [];
  }

  const fullRent = Math.max(0, Number(contract.rent_amount || 0));
  const billingCycle = contract.billing_cycle === 'quarterly' ? 'quarterly' : 'monthly';
  const billingDay = Math.min(31, Math.max(1, Number(contract.billing_day || 1)));
  const paymentDueDays = Math.min(60, Math.max(1, Number(contract.payment_due_days || 5)));

  // If roomTransferChildStartDate is supplied, it is the half-open start of the new lease [oldStart, childStart),
  // so no inclusive termination bonus is added.
  const isInclusiveEndStatus =
    !roomTransferChildStartDate &&
    ['TERMINATED', 'EXPIRED', 'TERMINATION_PENDING'].includes(contract.status);

  // Preserve historical periods 1..N-1 for TERMINATED (and legacy CANCELLED) subscriptions
  // only exclude if METERED, REJECTED, or cancelled prior to start
  const validSubs = (Array.isArray(subscriptions) ? subscriptions : []).filter((s) => {
    if (!s) return false;
    if (String(s.billing_type || 'FIXED').toUpperCase() === 'METERED') return false;
    const status = normalizeSubscriptionStatusInput(s.status);
    if (status === 'REJECTED') return false;
    if (status === 'TERMINATED') {
      const subStart = toDateOnlyYmd(s.start_date) || startStr;
      const subEnd = toDateOnlyYmd(s.end_date);
      if (!subEnd || subEnd < subStart) return false;
    }
    return true;
  });

  const [startYear, startMonth] = startStr.split('-').map(Number);
  let curY = startYear;
  let curM = startMonth;

  const monthlySlices = [];
  let guard = 0;

  while (guard < 240) {
    guard += 1;
    const monthStart = `${curY}-${pad2(curM)}-01`;
    const nextY = curM === 12 ? curY + 1 : curY;
    const nextM = curM === 12 ? 1 : curM + 1;
    const nextMonthStart = `${nextY}-${pad2(nextM)}-01`;

    if (rawEndStr <= monthStart) {
      break;
    }

    const { daysInMonth: totalDays } = getMonthBoundsYmd(`${curY}-${pad2(curM)}`);
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

      let expectedFixedServices = 0;
      for (const sub of validSubs) {
        const charge = computeSubscriptionPeriodCharge({
          subscription: sub,
          periodYm: periodStr,
          boundStartYmd: periodStart,
          boundEndYmd: periodEnd,
          contractBuildingId: contract.building_id,
          contractServicePrices: servicePrices,
          catalogItems,
          includePendingApproval: true,
        });
        expectedFixedServices += charge.amount;
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

  // Exclude CANCELLED and VOID invoices, include ADJUSTED and other active actual invoices
  const nonCancelledInvoices = (Array.isArray(existingInvoices) ? existingInvoices : []).filter(
    (inv) => inv && !['CANCELLED', 'VOID'].includes(normalizeInvoiceStatusInput(inv.status))
  );

  const chunkSize = billingCycle === 'quarterly' ? 3 : 1;
  const schedule = [];

  for (let i = 0; i < monthlySlices.length; i += chunkSize) {
    const chunk = monthlySlices.slice(i, i + chunkSize);
    const first = chunk[0];
    const last = chunk[chunk.length - 1];

    const clampedIssueDay = Math.min(billingDay, first.days_in_month);
    const rawIssueDate = `${first.year}-${pad2(first.month)}-${pad2(clampedIssueDay)}`;
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
