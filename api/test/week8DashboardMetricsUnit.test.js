import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVENUE_SOURCE_KEYS,
  AGING_BUCKET_DEFS,
  parseDashboardMonthsParam,
  buildRecentMonthsPeriods,
  getPeriodEndYmd,
  aggregateInvoiceLinesBySource,
  normalizeReceivablesAging,
  buildMonthlyOccupancySeries,
} from '../src/services/dashboardMetrics.js';

test('parseDashboardMonthsParam defaults to 12 and validates integer range 1..24', () => {
  assert.deepEqual(parseDashboardMonthsParam(undefined), { valid: true, months: 12 });
  assert.deepEqual(parseDashboardMonthsParam(''), { valid: true, months: 12 });
  assert.deepEqual(parseDashboardMonthsParam(null), { valid: true, months: 12 });
  assert.deepEqual(parseDashboardMonthsParam('6'), { valid: true, months: 6 });
  assert.deepEqual(parseDashboardMonthsParam(12), { valid: true, months: 12 });
  assert.deepEqual(parseDashboardMonthsParam('24'), { valid: true, months: 24 });

  for (const bad of ['0', '-6', '25', '99', 'abc', '6.5']) {
    const res = parseDashboardMonthsParam(bad);
    assert.equal(res.valid, false, `Expected ${bad} to be invalid`);
    assert.equal(res.code, 'VALIDATION_ERROR');
  }
});

test('buildRecentMonthsPeriods anchors to Vietnam YYYY-MM-DD and getPeriodEndYmd handles leap years', () => {
  assert.deepEqual(buildRecentMonthsPeriods('2026-03-01', 6), [
    '2025-10',
    '2025-11',
    '2025-12',
    '2026-01',
    '2026-02',
    '2026-03',
  ]);
  const p12 = buildRecentMonthsPeriods('2026-11-04', 12);
  assert.equal(p12.length, 12);
  assert.equal(p12[0], '2025-12');
  assert.equal(p12[11], '2026-11');

  assert.equal(getPeriodEndYmd('2024-02'), '2024-02-29');
  assert.equal(getPeriodEndYmd('2026-02'), '2026-02-28');
  assert.equal(getPeriodEndYmd('2026-04'), '2026-04-30');
  assert.equal(getPeriodEndYmd('2026-12'), '2026-12-31');
});

test('aggregateInvoiceLinesBySource maps 5 PRD sources, ignores DRAFT/VOID/CANCELLED, and spills negative ADJUSTMENT', () => {
  assert.deepEqual(REVENUE_SOURCE_KEYS, ['rent', 'electricity', 'water', 'service', 'other']);

  const periods = ['2026-04', '2026-05'];
  const invoices = [
    // Inv 1 (2026-04): ADJUSTED with negative spill on SERVICE + credit_offset_amount
    // Gross billed = 3,000,000 + 1,000,000 = 4,000,000
    {
      id: 'inv-1',
      period: '2026-04',
      status: 'ADJUSTED',
      total_amount: 3_000_000,
      credit_offset_amount: 1_000_000,
    },
    // Inv 2 (2026-05): Normal PAID invoice with all 5 item categories
    {
      id: 'inv-2',
      period: '2026-05',
      status: 'PAID',
      total_amount: 7_350_000,
      credit_offset_amount: 0,
    },
    // Inv 3 (2026-05): DRAFT -> must be ignored
    {
      id: 'inv-3',
      period: '2026-05',
      status: 'DRAFT',
      total_amount: 9_000_000,
      credit_offset_amount: 0,
    },
    // Inv 4 (2026-05): VOID -> must be ignored
    {
      id: 'inv-4',
      period: '2026-05',
      status: 'VOID',
      total_amount: 5_000_000,
      credit_offset_amount: 0,
    },
  ];

  const lines = [
    // Inv 1 lines: RENT 5M, SERVICE 1M, approved invoice_adjustment -2M via adjustment_target='SERVICE' (formula_meta={}),
    // PLUS production credit_offset invoice_line (-1M with credit_id) which MUST be excluded so it does not double-count or fabricate 'other'!
    // Expected: service clamps to 0, -1M spills to rent -> rent = 4M, other = 0, total_billed = 4M
    { invoice_id: 'inv-1', item_type: 'RENT', amount: 5_000_000 },
    { invoice_id: 'inv-1', item_type: 'SERVICE', amount: 1_000_000 },
    {
      invoice_id: 'inv-1',
      item_type: 'ADJUSTMENT',
      amount: -2_000_000,
      formula_meta: {},
      adjustment_target: 'SERVICE',
    },
    {
      invoice_id: 'inv-1',
      item_type: 'ADJUSTMENT',
      amount: -1_000_000,
      formula_meta: null,
      credit_id: 'cred-offset-1',
    },
    // Inv 2 lines: RENT 6M, ELECTRICITY 700k, WATER 150k, SERVICE 300k, LATE_FEE 200k
    { invoice_id: 'inv-2', item_type: 'RENT', amount: 6_000_000 },
    { invoice_id: 'inv-2', item_type: 'ELECTRICITY', amount: 700_000 },
    { invoice_id: 'inv-2', item_type: 'WATER', amount: 150_000 },
    { invoice_id: 'inv-2', item_type: 'SERVICE', amount: 300_000 },
    { invoice_id: 'inv-2', item_type: 'LATE_FEE', amount: 200_000 },
    // Ignored lines on DRAFT & VOID
    { invoice_id: 'inv-3', item_type: 'RENT', amount: 9_000_000 },
    { invoice_id: 'inv-4', item_type: 'RENT', amount: 5_000_000 },
  ];

  const series = aggregateInvoiceLinesBySource({ invoices, lines, periods });
  assert.equal(series.length, 2);

  const apr = series[0];
  assert.equal(apr.period, '2026-04');
  assert.equal(apr.service, 0);
  assert.equal(apr.rent, 4_000_000);
  assert.equal(apr.electricity, 0);
  assert.equal(apr.water, 0);
  assert.equal(apr.other, 0);
  assert.equal(apr.total_billed, 4_000_000);
  assert.equal(apr.rent + apr.electricity + apr.water + apr.service + apr.other, apr.total_billed);

  const may = series[1];
  assert.equal(may.period, '2026-05');
  assert.equal(may.rent, 6_000_000);
  assert.equal(may.electricity, 700_000);
  assert.equal(may.water, 150_000);
  assert.equal(may.service, 300_000);
  assert.equal(may.other, 200_000);
  assert.equal(may.total_billed, 7_350_000);
});

test('normalizeReceivablesAging maps exact 5 PRD buckets and computes overdue/total debt', () => {
  assert.equal(AGING_BUCKET_DEFS.length, 5);
  assert.deepEqual(
    AGING_BUCKET_DEFS.map((b) => b.key),
    ['current_not_due', '0_15', '16_30', '31_60', 'over_60']
  );

  const aging = normalizeReceivablesAging({
    current_not_due: '1000000',
    count_current_not_due: 1,
    bucket_0_15: '2000000',
    count_0_15: 2,
    bucket_16_30: '3000000',
    count_16_30: 1,
    bucket_31_60: '4000000',
    count_31_60: 3,
    bucket_over_60: '5000000',
    count_over_60: 2,
  });

  assert.equal(aging.total_debt, 15_000_000);
  assert.equal(aging.overdue_debt, 14_000_000);
  assert.equal(aging.total_count, 9);
  assert.deepEqual(
    aging.buckets.map((b) => ({ key: b.key, amount: b.amount, count: b.count })),
    [
      { key: 'current_not_due', amount: 1_000_000, count: 1 },
      { key: '0_15', amount: 2_000_000, count: 2 },
      { key: '16_30', amount: 3_000_000, count: 1 },
      { key: '31_60', amount: 4_000_000, count: 3 },
      { key: 'over_60', amount: 5_000_000, count: 2 },
    ]
  );
});

test('buildMonthlyOccupancySeries handles 0 exploitable apartments safely and aligns currentPeriod with live snapshot', () => {
  const emptySeries = buildMonthlyOccupancySeries({
    periods: ['2026-10', '2026-11'],
    currentPeriod: '2026-11',
    totalExploitableApartments: 0,
    currentOccupiedCount: 0,
    monthlyOccupiedByPeriod: { '2026-10': 2 },
  });
  assert.deepEqual(emptySeries, [
    { period: '2026-10', occupied: 0, exploitable: 0, occupancy_rate: 0 },
    { period: '2026-11', occupied: 0, exploitable: 0, occupancy_rate: 0 },
  ]);

  const series = buildMonthlyOccupancySeries({
    periods: ['2026-09', '2026-10', '2026-11'],
    currentPeriod: '2026-11',
    totalExploitableApartments: 8,
    currentOccupiedCount: 6, // 75% live snapshot
    monthlyOccupiedByPeriod: {
      '2026-09': 3, // 37.5%
      '2026-10': 12, // clamped to 8 -> 100%
      '2026-11': 4, // ignored for currentPeriod in favor of live snapshot 6
    },
  });

  assert.deepEqual(series, [
    { period: '2026-09', occupied: 3, exploitable: 8, occupancy_rate: 37.5 },
    { period: '2026-10', occupied: 8, exploitable: 8, occupancy_rate: 100 },
    { period: '2026-11', occupied: 6, exploitable: 8, occupancy_rate: 75 },
  ]);
});

