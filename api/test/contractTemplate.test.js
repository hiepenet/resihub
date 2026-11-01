import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeTemplateHtml,
  buildContractTemplateServiceRows,
} from '../src/services/contractTemplate.js';

test('buildContractTemplateServiceRows includes default-priced subscriptions, meter rates, overrides, and excludes CANCELLED', () => {
  const rows = buildContractTemplateServiceRows({
    contractStartDate: '2026-11-01',
    subscriptions: [
      {
        service_code: 'MOTORBIKE_PARKING',
        service_name: 'Gửi xe máy hầm B1',
        service_category: 'PARKING',
        billing_type: 'QUANTITY',
        unit: 'xe/tháng',
        quantity: 2,
        unit_price: 120000,
        start_date: '2026-11-01',
        status: 'PENDING_APPROVAL',
        note: '59A1-123.45, 59B2-678.90',
      },
      {
        service_code: 'INTERNET_FIBER',
        service_name: 'Internet Cáp Quang',
        service_category: 'UTILITY',
        billing_type: 'FIXED',
        unit: 'tháng',
        quantity: 1,
        unit_price: 200000,
        start_date: '2026-11-01',
        status: 'ACTIVE',
        note: null,
      },
      {
        service_code: 'CLEANING_WEEKLY',
        service_name: 'Dọn vệ sinh',
        billing_type: 'QUANTITY',
        unit: 'lần/tháng',
        quantity: 1,
        unit_price: 150000,
        status: 'CANCELLED',
      },
      {
        service_code: 'CAR_PARKING',
        service_name: 'Gửi ô tô',
        billing_type: 'QUANTITY',
        unit: 'xe/tháng',
        quantity: 1,
        unit_price: 1500000,
        status: 'REJECTED',
      },
    ],
    servicePrices: [
      { service_code: 'INTERNET', unit_price: 180000, effective_from: '2026-11-01' },
      { service_code: 'ELECTRICITY', unit_price: 3500, effective_from: '2026-11-01' },
    ],
    meters: [
      { meter_type: 'ELECTRICITY', unit: 'kWh', unit_price: 3800 },
      { meter_type: 'WATER', unit: 'm³', unit_price: 22000 },
    ],
    utilityCatalog: [],
  });

  assert.equal(rows.length, 4);
  assert.equal(rows[0].code, 'MOTORBIKE_PARKING');
  assert.equal(rows[0].quantityLabel, '2 xe/tháng');
  assert.equal(rows[0].unitPrice, 120000);
  assert.equal(rows[0].note, '59A1-123.45, 59B2-678.90');
  assert.match(rows[0].amountLabel, /240\.000/);

  // Alias INTERNET_FIBER -> INTERNET override should apply
  assert.equal(rows[1].code, 'INTERNET_FIBER');
  assert.equal(rows[1].unitPrice, 180000);
  assert.match(rows[1].amountLabel, /180\.000/);

  const elec = rows.find((r) => r.code === 'ELECTRICITY');
  const water = rows.find((r) => r.code === 'WATER');
  assert.equal(elec.unitPrice, 3500);
  assert.equal(water.unitPrice, 22000);
  assert.equal(water.amountLabel, 'Theo chỉ số đồng hồ');
});

test('escapeTemplateHtml neutralizes XSS payloads in notes and names', () => {
  assert.equal(
    escapeTemplateHtml('<script>alert("xss" & \'1\')</script>'),
    '&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;1&#39;)&lt;/script&gt;'
  );
  assert.equal(escapeTemplateHtml(null), '');
});
