import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExpectedInvoiceSchedule } from '../src/services/invoiceSchedule.js';
import { roundVND } from '../src/services/pricing.js';

test('buildExpectedInvoiceSchedule: monthly mid-month pro-rata and billing_day=31 clamping across Feb', () => {
  const schedule = buildExpectedInvoiceSchedule({
    contract: {
      id: '00000000-0000-0000-0000-000000000001',
      status: 'ACTIVE',
      start_date: '2026-11-16',
      end_date: '2027-02-16',
      rent_amount: 9000000,
      billing_cycle: 'monthly',
      billing_day: 31,
      payment_due_days: 7,
    },
    subscriptions: [],
    servicePrices: [],
    existingInvoices: [],
  });

  assert.equal(schedule.length, 4);

  // Period 1: Nov 16..30 (15/30 days)
  assert.equal(schedule[0].period_no, 1);
  assert.equal(schedule[0].billing_period, '2026-11');
  assert.equal(schedule[0].period_start, '2026-11-16');
  assert.equal(schedule[0].period_end, '2026-11-30');
  assert.equal(schedule[0].is_prorated, true);
  assert.equal(schedule[0].expected_rent, 4500000);
  assert.equal(schedule[0].issue_date, '2026-11-30');
  assert.equal(schedule[0].due_date, '2026-12-07');

  // Period 2: Dec 1..31 (full month)
  assert.equal(schedule[1].billing_period, '2026-12');
  assert.equal(schedule[1].is_prorated, false);
  assert.equal(schedule[1].expected_rent, 9000000);
  assert.equal(schedule[1].issue_date, '2026-12-31');
  assert.equal(schedule[1].due_date, '2027-01-07');

  // Period 3: Jan 1..31 (full month)
  assert.equal(schedule[2].billing_period, '2027-01');
  assert.equal(schedule[2].expected_rent, 9000000);
  assert.equal(schedule[2].issue_date, '2027-01-31');
  assert.equal(schedule[2].due_date, '2027-02-07');

  // Period 4: Feb 1..15 (15/28 days, billing_day=31 clamps to 2027-02-28)
  assert.equal(schedule[3].billing_period, '2027-02');
  assert.equal(schedule[3].period_start, '2027-02-01');
  assert.equal(schedule[3].period_end, '2027-02-15');
  assert.equal(schedule[3].is_prorated, true);
  assert.equal(schedule[3].expected_rent, roundVND((9000000 * 15) / 28));
  assert.equal(schedule[3].issue_date, '2027-02-28');
  assert.equal(schedule[3].due_date, '2027-03-07');
});

test('buildExpectedInvoiceSchedule: quarterly grouping with fixed/quantity subscriptions and contract_service_price override', () => {
  const schedule = buildExpectedInvoiceSchedule({
    contract: {
      id: '00000000-0000-0000-0000-000000000002',
      status: 'ACTIVE',
      start_date: '2027-01-01',
      end_date: '2027-07-01',
      rent_amount: 10000000,
      billing_cycle: 'quarterly',
      billing_day: 5,
      payment_due_days: 10,
    },
    subscriptions: [
      {
        id: 'sub-1',
        service_code: 'INTERNET_FIBER',
        service_category: 'INTERNET',
        billing_type: 'FIXED',
        quantity: 1,
        unit_price: 220000,
        start_date: '2027-01-01',
        status: 'ACTIVE',
      },
      {
        id: 'sub-2',
        service_code: 'MOTORBIKE_PARKING',
        service_category: 'PARKING',
        billing_type: 'QUANTITY',
        quantity: 2,
        unit_price: 120000,
        start_date: '2027-01-01',
        status: 'ACTIVE',
      },
      {
        id: 'sub-3',
        service_code: 'ELECTRICITY',
        service_category: 'ELECTRICITY',
        billing_type: 'METERED',
        quantity: 1,
        unit_price: 3800,
        start_date: '2027-01-01',
        status: 'ACTIVE',
      },
    ],
    servicePrices: [
      {
        service_code: 'INTERNET',
        unit_price: 180000,
        effective_from: '2027-01-01',
      },
    ],
    existingInvoices: [
      {
        id: 'inv-q1',
        period: '2027-01',
        status: 'PAID',
        total_amount: 31260000,
      },
    ],
  });

  assert.equal(schedule.length, 2);

  // Quarter 1: Jan..Mar (3 months)
  // Rent = 30,000,000; Services = (180,000 + 2 * 120,000) * 3 = 1,260,000 (METERED excluded)
  assert.equal(schedule[0].period_no, 1);
  assert.equal(schedule[0].period_start, '2027-01-01');
  assert.equal(schedule[0].period_end, '2027-03-31');
  assert.equal(schedule[0].issue_date, '2027-01-05');
  assert.equal(schedule[0].due_date, '2027-01-15');
  assert.equal(schedule[0].expected_rent, 30000000);
  assert.equal(schedule[0].expected_fixed_services, 1260000);
  assert.equal(schedule[0].expected_total, 31260000);
  assert.equal(schedule[0].actual_invoice?.id, 'inv-q1');

  // Quarter 2: Apr..Jun (3 months)
  assert.equal(schedule[1].period_no, 2);
  assert.equal(schedule[1].period_start, '2027-04-01');
  assert.equal(schedule[1].period_end, '2027-06-30');
  assert.equal(schedule[1].issue_date, '2027-04-05');
  assert.equal(schedule[1].due_date, '2027-04-15');
  assert.equal(schedule[1].expected_total, 31260000);
  assert.equal(schedule[1].actual_invoice, null);
});

test('buildExpectedInvoiceSchedule: returns empty array for CANCELLED contract', () => {
  const schedule = buildExpectedInvoiceSchedule({
    contract: {
      id: '00000000-0000-0000-0000-000000000003',
      status: 'CANCELLED',
      start_date: '2027-01-01',
      end_date: '2028-01-01',
      rent_amount: 10000000,
    },
  });
  assert.deepEqual(schedule, []);
});
