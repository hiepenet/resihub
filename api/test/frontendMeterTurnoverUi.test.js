import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('Task 4: Frontend Meter Turnover UI Helpers & MeterReadingsPage Wiring', async (t) => {
  const billingModule = await import('../../frontend/src/utils/billing.js');

  await t.test('1. isMeterRowLockedForEdit locks billed readings even for MANAGER and unlocks unbilled rows', () => {
    const { isMeterRowLockedForEdit } = billingModule;
    assert.equal(typeof isMeterRowLockedForEdit, 'function', 'isMeterRowLockedForEdit must be exported');

    assert.equal(isMeterRowLockedForEdit({ period_reading_billed: true }, true), true);
    assert.equal(isMeterRowLockedForEdit({ period_reading_billed: false }, true), false);
    assert.equal(isMeterRowLockedForEdit({ period_reading_billed: false }, false), true);
    assert.equal(isMeterRowLockedForEdit(null, true), false);
  });

  await t.test('2. resolveMeterTurnoverBadgeMeta & resolveMeterSlotView format multi-slot turnover metadata and project slots', () => {
    const { resolveMeterTurnoverBadgeMeta, resolveMeterSlotView } = billingModule;
    assert.equal(typeof resolveMeterTurnoverBadgeMeta, 'function', 'resolveMeterTurnoverBadgeMeta must be exported');
    assert.equal(typeof resolveMeterSlotView, 'function', 'resolveMeterSlotView must be exported');

    const row = {
      id: 'm1',
      initial_reading: 900,
      last_known_reading: 1100,
      target_contract_id: 'c2',
      target_contract_code: 'HĐ-BBBB2222',
      target_tenant_name: 'Nguyen Van Moi',
      period_slot_index: 2,
      period_total_slots: 2,
      period_reading_id: null,
      period_previous_reading: null,
      period_current_reading: null,
      period_consumption: null,
      period_reading_status: null,
      period_reading_billed: false,
      effective_unit_price: 4200,
      effective_price_source: 'CONTRACT_OVERRIDE',
      overlapping_contracts: [
        {
          contract_id: 'c1',
          contract_code: 'HĐ-AAAA1111',
          tenant_name: 'Tran Thi Cu',
          slot_index: 1,
          total_slots: 2,
          overlap_start: '2028-12-01',
          overlap_end: '2028-12-15',
          reading_id: 'r1',
          previous_reading: 1000,
          current_reading: 1100,
          consumption: 100,
          reading_status: 'CONFIRMED',
          is_abnormal: false,
          abnormal_note: 'Chot tra phong',
          image_url: '/api/v1/attachments/att1/view',
          is_billed: true,
          effective_unit_price: 3500,
          effective_price_source: 'METER_DEFAULT',
        },
        {
          contract_id: 'c2',
          contract_code: 'HĐ-BBBB2222',
          tenant_name: 'Nguyen Van Moi',
          slot_index: 2,
          total_slots: 2,
          overlap_start: '2028-12-20',
          overlap_end: '2028-12-31',
          reading_id: null,
          previous_reading: 1100,
          current_reading: null,
          consumption: null,
          reading_status: null,
          is_abnormal: false,
          abnormal_note: null,
          image_url: null,
          is_billed: false,
          effective_unit_price: 4200,
          effective_price_source: 'CONTRACT_OVERRIDE',
        },
      ],
    };

    const badge = resolveMeterTurnoverBadgeMeta(row);
    assert.equal(badge.showContractTag, true);
    assert.equal(badge.isMultiSlot, true);
    assert.equal(badge.slotLabel, 'Đợt 2/2');
    assert.equal(badge.contractCode, 'HĐ-BBBB2222');
    assert.equal(badge.tenantName, 'Nguyen Van Moi');

    const slot1View = resolveMeterSlotView(row, 'c1');
    assert.equal(slot1View.target_contract_id, 'c1');
    assert.equal(slot1View.period_reading_id, 'r1');
    assert.equal(slot1View.period_previous_reading, 1000);
    assert.equal(slot1View.period_current_reading, 1100);
    assert.equal(slot1View.period_reading_status, 'CONFIRMED');
    assert.equal(slot1View.period_reading_billed, true);
    assert.equal(slot1View.effective_unit_price, 3500);

    const slot2View = resolveMeterSlotView(row, 'c2');
    assert.equal(slot2View.target_contract_id, 'c2');
    assert.equal(slot2View.period_reading_id, null);
    assert.equal(slot2View.last_known_reading, 1100);
    assert.equal(slot2View.period_reading_billed, false);
    assert.equal(slot2View.effective_unit_price, 4200);
  });

  await t.test('3. MeterReadingsPage.jsx wires turnover badge, locked-row guard, modal contract selector & history contract_code', async () => {
    const pagePath = path.join(REPO_ROOT, 'frontend', 'src', 'pages', 'admin', 'meters', 'MeterReadingsPage.jsx');
    const src = await fs.readFile(pagePath, 'utf8');

    assert.match(src, /isMeterRowLockedForEdit/, 'Must use isMeterRowLockedForEdit');
    assert.match(src, /resolveMeterTurnoverBadgeMeta/, 'Must use resolveMeterTurnoverBadgeMeta');
    assert.match(src, /resolveMeterSlotView/, 'Must use resolveMeterSlotView');
    assert.match(src, /!m\.period_reading_billed|!Boolean\(m\.period_reading_billed\)/, 'dirtyValidRows must exclude period_reading_billed rows');
    assert.match(src, /Đã lập HĐ/, 'Must display locked billed badge Đã lập HĐ');
    assert.match(src, /contract_id:\s*selectedSlotContractId/, 'handleSaveSingle must pass selectedSlotContractId as contract_id');
    assert.match(src, /h\.contract_code/, 'History table must display h.contract_code');
  });
});

