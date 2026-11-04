import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageSource = fs.readFileSync(
  path.resolve(__dirname, '../../frontend/src/pages/admin/meters/MeterReadingsPage.jsx'),
  'utf8'
);

test('Task 3: MeterReadingsPage active_contract filter options, query builder, and JSX wiring', async (t) => {
  const billingUtils = await import('../../frontend/src/utils/billing.js');
  const { METER_CONTRACT_FILTER_OPTIONS, buildMeterListQueryParams } = billingUtils;

  await t.test('1. METER_CONTRACT_FILTER_OPTIONS defines all, active, and inactive options', () => {
    assert.ok(Array.isArray(METER_CONTRACT_FILTER_OPTIONS));
    assert.deepEqual(METER_CONTRACT_FILTER_OPTIONS, [
      { value: '', label: 'Tất cả căn hộ' },
      { value: 'true', label: 'Đang có hợp đồng ACTIVE' },
      { value: 'false', label: 'Chưa có hợp đồng ACTIVE' },
    ]);
  });

  await t.test('2. buildMeterListQueryParams normalizes activeContractFilter and trims search', () => {
    assert.deepEqual(
      buildMeterListQueryParams({
        buildingId: 'b-1',
        meterType: 'ELECTRICITY',
        statusFilter: 'CONFIRMED',
        activeContractFilter: 'true',
        period: '2026-11',
        search: '  A002  ',
      }),
      {
        building_id: 'b-1',
        meter_type: 'ELECTRICITY',
        status: 'CONFIRMED',
        active_contract: 'true',
        period: '2026-11',
        search: 'A002',
      }
    );

    assert.deepEqual(
      buildMeterListQueryParams({
        buildingId: '',
        meterType: '',
        statusFilter: '',
        activeContractFilter: 'false',
        period: '2026-11',
        search: '   ',
      }),
      {
        building_id: undefined,
        meter_type: undefined,
        status: undefined,
        active_contract: 'false',
        period: '2026-11',
        search: undefined,
      }
    );

    const ignored = buildMeterListQueryParams({
      buildingId: 'b-1',
      activeContractFilter: 'invalid',
      period: '2026-11',
    });
    assert.equal(ignored.active_contract, undefined);
  });

  await t.test('3. MeterReadingsPage.jsx wires activeContractFilter state, Select, and buildMeterListQueryParams', () => {
    assert.match(pageSource, /METER_CONTRACT_FILTER_OPTIONS/);
    assert.match(pageSource, /buildMeterListQueryParams/);
    assert.match(pageSource, /const\s+\[activeContractFilter,\s*setActiveContractFilter\]\s*=\s*useState\(['"]{2}\)/);
    assert.match(pageSource, /options=\{METER_CONTRACT_FILTER_OPTIONS\}/);
  });
});

