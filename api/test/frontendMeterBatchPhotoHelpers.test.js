import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BATCH_METER_PHOTOS,
  DEFAULT_OCR_CONCURRENCY,
  matchMeterFromFilename,
  resolveMeterAfterOcr,
  rematchBatchPhotoItemsForBuilding,
  runBoundedConcurrencyQueue,
  evaluateBatchPhotoImportItems,
  buildBatchPhotoSavePayload,
} from '../../frontend/src/utils/meterBatchPhotoHelpers.js';

const SAMPLE_BUILDING_METERS = [
  {
    id: 'm-a10-el',
    apartment_id: 'apt-a10',
    apartment_code: 'A10',
    meter_type: 'ELECTRICITY',
    meter_code: 'EL-VOP-A-A10',
    unit: 'kWh',
    unit_price: 3800,
    effective_unit_price: 3800,
    initial_reading: 100,
    last_known_reading: 200,
    baseline_avg_consumption: 100,
    period_reading_billed: false,
  },
  {
    id: 'm-a10-wt',
    apartment_id: 'apt-a10',
    apartment_code: 'A10',
    meter_type: 'WATER',
    meter_code: 'WT-VOP-A-A10',
    unit: 'm³',
    unit_price: 22000,
    effective_unit_price: 22000,
    initial_reading: 10,
    last_known_reading: 25,
    baseline_avg_consumption: 12,
    period_reading_billed: false,
  },
  {
    id: 'm-a100-el',
    apartment_id: 'apt-a100',
    apartment_code: 'A100',
    meter_type: 'ELECTRICITY',
    meter_code: 'EL-VOP-A-A100',
    unit: 'kWh',
    unit_price: 3800,
    effective_unit_price: 3800,
    initial_reading: 500,
    last_known_reading: 650,
    baseline_avg_consumption: 140,
    period_reading_billed: false,
  },
  {
    id: 'm-a100-wt',
    apartment_id: 'apt-a100',
    apartment_code: 'A100',
    meter_type: 'WATER',
    meter_code: 'WT-VOP-A-A100',
    unit: 'm³',
    unit_price: 22000,
    effective_unit_price: 22000,
    initial_reading: 30,
    last_known_reading: 45,
    baseline_avg_consumption: 15,
    period_reading_billed: false,
  },
  {
    id: 'm-a1001-el',
    apartment_id: 'apt-a1001',
    apartment_code: 'A1001',
    meter_type: 'ELECTRICITY',
    meter_code: 'EL-VOP-A-A1001',
    unit: 'kWh',
    unit_price: 3800,
    effective_unit_price: 4000,
    initial_reading: 1000,
    last_known_reading: 1200,
    baseline_avg_consumption: 150,
    target_contract_id: 'contract-a1001',
    period_reading_billed: false,
  },
  {
    id: 'm-a1001-wt',
    apartment_id: 'apt-a1001',
    apartment_code: 'A1001',
    meter_type: 'WATER',
    meter_code: 'WT-VOP-A-A1001',
    unit: 'm³',
    unit_price: 22000,
    effective_unit_price: 22000,
    initial_reading: 80,
    last_known_reading: 110,
    baseline_avg_consumption: 15,
    target_contract_id: 'contract-a1001',
    period_reading_billed: false,
  },
  {
    id: 'm-locked-el',
    apartment_id: 'apt-locked',
    apartment_code: 'A2002',
    meter_type: 'ELECTRICITY',
    meter_code: 'EL-VOP-A-A2002',
    unit: 'kWh',
    unit_price: 3800,
    effective_unit_price: 3800,
    initial_reading: 300,
    last_known_reading: 450,
    period_previous_reading: 450,
    period_current_reading: 580,
    period_reading_id: 'rd-locked',
    period_reading_status: 'CONFIRMED',
    period_reading_billed: true,
  },
];

test('Constants: batch limits and default concurrency match spec', () => {
  assert.equal(MAX_BATCH_METER_PHOTOS, 30);
  assert.equal(DEFAULT_OCR_CONCURRENCY, 2);
});

test('matchMeterFromFilename & resolveMeterAfterOcr: longest-first room boundary matching without prefix collisions', () => {
  // Exact meter_code in filename
  const exactCode = matchMeterFromFilename('EL-VOP-A-A1001_thang11.jpg', SAMPLE_BUILDING_METERS);
  assert.equal(exactCode.matchKind, 'EXACT_METER');
  assert.equal(exactCode.meterId, 'm-a1001-el');
  assert.equal(exactCode.apartmentCode, 'A1001');

  // Review Focus #1: A1001 must NEVER match A10 or A100
  const roomA1001Elec = matchMeterFromFilename('A1001_dien.jpg', SAMPLE_BUILDING_METERS);
  assert.equal(roomA1001Elec.matchKind, 'EXACT_METER');
  assert.equal(roomA1001Elec.meterId, 'm-a1001-el');
  assert.equal(roomA1001Elec.apartmentCode, 'A1001');
  assert.equal(roomA1001Elec.meterTypeHint, 'ELECTRICITY');

  const roomA100Water = matchMeterFromFilename('Phong_A100_Nuoc.PNG', SAMPLE_BUILDING_METERS);
  assert.equal(roomA100Water.matchKind, 'EXACT_METER');
  assert.equal(roomA100Water.meterId, 'm-a100-wt');
  assert.equal(roomA100Water.apartmentCode, 'A100');
  assert.equal(roomA100Water.meterTypeHint, 'WATER');

  const roomA10Water = matchMeterFromFilename('a10-w.webp', SAMPLE_BUILDING_METERS);
  assert.equal(roomA10Water.matchKind, 'EXACT_METER');
  assert.equal(roomA10Water.meterId, 'm-a10-wt');
  assert.equal(roomA10Water.apartmentCode, 'A10');
  assert.equal(roomA10Water.meterTypeHint, 'WATER');

  // Vietnamese diacritics in filename: "Căn A1001 - Điện.jpeg"
  const diacriticElec = matchMeterFromFilename('Căn A1001 - Điện.jpeg', SAMPLE_BUILDING_METERS);
  assert.equal(diacriticElec.matchKind, 'EXACT_METER');
  assert.equal(diacriticElec.meterId, 'm-a1001-el');

  // Room-only filename ("A1001 (1).jpg") -> APARTMENT_ONLY until AI-02 returns detected_meter_type
  const roomOnly = matchMeterFromFilename('A1001 (1).jpg', SAMPLE_BUILDING_METERS);
  assert.equal(roomOnly.matchKind, 'APARTMENT_ONLY');
  assert.equal(roomOnly.meterId, null);
  assert.equal(roomOnly.apartmentId, 'apt-a1001');
  assert.equal(roomOnly.apartmentCode, 'A1001');
  assert.equal(roomOnly.meterTypeHint, null);

  // Post-OCR resolution via backend resolved_meter_id or detected_meter_type
  const resolvedIdFromBackend = resolveMeterAfterOcr({
    item: { meterId: null, apartmentId: roomOnly.apartmentId },
    ocrData: {
      output: {
        resolved_meter_id: 'm-a1001-wt',
        detected_meter_type: 'WATER',
      },
    },
    buildingMeters: SAMPLE_BUILDING_METERS,
  });
  assert.equal(resolvedIdFromBackend, 'm-a1001-wt');

  const resolvedByDetectedTypeFallback = resolveMeterAfterOcr({
    item: { meterId: null, apartmentId: roomOnly.apartmentId },
    ocrData: {
      output: {
        resolved_meter_id: null,
        detected_meter_type: 'ELECTRICITY',
      },
    },
    buildingMeters: SAMPLE_BUILDING_METERS,
  });
  assert.equal(resolvedByDetectedTypeFallback, 'm-a1001-el');

  // Unmatched camera filename
  const unmatched = matchMeterFromFilename('IMG_20261105_091122.jpg', SAMPLE_BUILDING_METERS);
  assert.equal(unmatched.matchKind, 'UNMATCHED');
  assert.equal(unmatched.meterId, null);
  assert.equal(unmatched.apartmentId, null);
});

test('runBoundedConcurrencyQueue: enforces max concurrency <= 2 and isolates individual worker errors', async () => {
  let active = 0;
  let maxObservedActive = 0;

  const items = ['p1', 'p2-timeout', 'p3', 'p4', 'p5'];
  const results = await runBoundedConcurrencyQueue(items, 2, async (item, index) => {
    active += 1;
    if (active > maxObservedActive) maxObservedActive = active;
    await new Promise((r) => setTimeout(r, 25));
    active -= 1;
    if (item === 'p2-timeout') {
      throw new Error(`HTTP 504 timeout at ${index}`);
    }
    return `ok:${item}:${index}`;
  });

  assert.equal(maxObservedActive, 2);
  assert.equal(results.length, 5);
  assert.deepEqual(results[0], { status: 'fulfilled', value: 'ok:p1:0' });
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /HTTP 504 timeout/);
  assert.deepEqual(results[2], { status: 'fulfilled', value: 'ok:p3:2' });
  assert.deepEqual(results[3], { status: 'fulfilled', value: 'ok:p4:3' });
  assert.deepEqual(results[4], { status: 'fulfilled', value: 'ok:p5:4' });
});

test('evaluateBatchPhotoImportItems & buildBatchPhotoSavePayload: flags duplicates, locked billed slots, >30% anomalies, and builds clean batch payload', () => {
  // Case A: Duplicate meter collision (Review Focus #2) + Locked billed meter (Review Focus #4) + Unmatched
  const mixedItems = [
    {
      localId: 'row-dup-1',
      fileName: 'A1001_dien_1.jpg',
      meterId: 'm-a1001-el',
      draftReading: '1320',
      abnormalNote: '',
      imageDataUri: 'data:image/jpeg;base64,AAA',
      ocrStatus: 'DONE',
      suggestionId: 'sug-1',
    },
    {
      localId: 'row-dup-2',
      fileName: 'A1001_dien_2.jpg',
      meterId: 'm-a1001-el',
      draftReading: '1325',
      abnormalNote: '',
      imageDataUri: 'data:image/jpeg;base64,BBB',
      ocrStatus: 'DONE',
      suggestionId: 'sug-2',
    },
    {
      localId: 'row-locked',
      fileName: 'A2002_dien.jpg',
      meterId: 'm-locked-el',
      draftReading: '600',
      abnormalNote: '',
      imageDataUri: 'data:image/jpeg;base64,CCC',
      ocrStatus: 'DONE',
      suggestionId: 'sug-3',
    },
    {
      localId: 'row-unmatched',
      fileName: 'IMG_9999.jpg',
      meterId: null,
      draftReading: '150',
      abnormalNote: '',
      imageDataUri: 'data:image/jpeg;base64,DDD',
      ocrStatus: 'DONE',
      suggestionId: 'sug-4',
    },
    {
      localId: 'row-valid-abnormal',
      fileName: 'A1001_nuoc.jpg',
      meterId: 'm-a1001-wt',
      draftReading: '140', // prev 110 -> consumption 30 vs baseline 15 (+100% > 30%)
      abnormalNote: 'Rò phao bồn cầu đã sửa',
      imageDataUri: 'data:image/jpeg;base64,EEE',
      ocrStatus: 'DONE',
      suggestionId: 'sug-5',
    },
    {
      localId: 'row-valid-normal',
      fileName: 'A100_dien.jpg',
      meterId: 'm-a100-el',
      draftReading: '790', // prev 650 -> consumption 140 vs baseline 140 (0%)
      abnormalNote: '',
      imageDataUri: 'data:image/jpeg;base64,FFF',
      ocrStatus: 'DONE',
      suggestionId: 'sug-6',
    },
  ];

  const evaluated = evaluateBatchPhotoImportItems(mixedItems, SAMPLE_BUILDING_METERS, {
    anomalyThresholdPct: 30,
    canWriteMeters: true,
  });

  const byId = Object.fromEntries(evaluated.rows.map((r) => [r.localId, r]));
  assert.equal(byId['row-dup-1'].validationState, 'DUPLICATE_METER_TARGET');
  assert.equal(byId['row-dup-1'].isSaveable, false);
  assert.equal(byId['row-dup-2'].validationState, 'DUPLICATE_METER_TARGET');
  assert.equal(byId['row-dup-2'].isSaveable, false);
  assert.equal(byId['row-locked'].validationState, 'LOCKED_BILLED');
  assert.equal(byId['row-locked'].isSaveable, false);
  assert.equal(byId['row-unmatched'].validationState, 'MISSING_METER');
  assert.equal(byId['row-unmatched'].isSaveable, false);

  assert.equal(byId['row-valid-abnormal'].validationState, 'READY_ABNORMAL');
  assert.equal(byId['row-valid-abnormal'].isAbnormal, true);
  assert.equal(byId['row-valid-abnormal'].isSaveable, true);
  assert.equal(byId['row-valid-abnormal'].estimatedAmount, 660000); // 30 * 22,000

  assert.equal(byId['row-valid-normal'].validationState, 'READY');
  assert.equal(byId['row-valid-normal'].isAbnormal, false);
  assert.equal(byId['row-valid-normal'].isSaveable, true);

  assert.equal(evaluated.saveableRows.length, 2);
  assert.equal(evaluated.summary.saveableCount, 2);
  assert.equal(evaluated.summary.abnormalSaveableCount, 1);
  assert.equal(evaluated.summary.duplicateCount, 2);
  assert.equal(evaluated.summary.skippedCount, 4);

  const payload = buildBatchPhotoSavePayload({
    saveableRows: evaluated.saveableRows,
    period: '2026-11',
    targetStatus: 'CONFIRMED',
  });

  assert.equal(payload.period, '2026-11');
  assert.equal(payload.status, 'CONFIRMED');
  assert.equal(payload.hold_if_abnormal, true);
  assert.equal(payload.readings.length, 2);
  assert.deepEqual(payload.readings[0], {
    meter_id: 'm-a1001-wt',
    contract_id: 'contract-a1001',
    current_reading: 140,
    abnormal_note: 'Rò phao bồn cầu đã sửa',
    image_base64: 'data:image/jpeg;base64,EEE',
    ai_suggestion_id: 'sug-5',
  });
  assert.deepEqual(payload.readings[1], {
    meter_id: 'm-a100-el',
    current_reading: 790,
    image_base64: 'data:image/jpeg;base64,FFF',
    ai_suggestion_id: 'sug-6',
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

test('UI Wiring: MeterBatchPhotoImportModal & MeterReadingsPage integrate batch AI photo import', () => {
  const modalPath = path.join(
    REPO_ROOT,
    'frontend/src/components/meters/MeterBatchPhotoImportModal.jsx'
  );
  assert.equal(fs.existsSync(modalPath), true, 'MeterBatchPhotoImportModal.jsx must exist');
  const modalSrc = fs.readFileSync(modalPath, 'utf8');

  assert.match(modalSrc, /MAX_BATCH_METER_PHOTOS/);
  assert.match(modalSrc, /matchMeterFromFilename/);
  assert.match(modalSrc, /resolveMeterAfterOcr/);
  assert.match(modalSrc, /runBoundedConcurrencyQueue/);
  assert.match(modalSrc, /evaluateBatchPhotoImportItems/);
  assert.match(modalSrc, /buildBatchPhotoSavePayload/);
  assert.match(modalSrc, /rematchBatchPhotoItemsForBuilding/);
  assert.match(modalSrc, /if\s*\(\s*queueProgress\.running\s*\)/);
  assert.match(modalSrc, /compressImageFileToDataUri/);
  assert.match(modalSrc, /aiService\.ocrMeterReading/);
  assert.match(modalSrc, /metersService\.recordBatch/);
  assert.match(modalSrc, /Thử lại/);

  const pagePath = path.join(
    REPO_ROOT,
    'frontend/src/pages/admin/meters/MeterReadingsPage.jsx'
  );
  const pageSrc = fs.readFileSync(pagePath, 'utf8');
  assert.match(pageSrc, /MeterBatchPhotoImportModal/);
  assert.match(pageSrc, /Import ảnh AI/);
});

test('Code Review Fixes: rematchBatchPhotoItemsForBuilding clears stale cross-building assignments/suggestionIds & numeric comparison preserves server abnormal flag', () => {
  const buildingBMeters = [
    {
      id: 'm-b201-el',
      apartment_id: 'apt-b201',
      apartment_code: 'B201',
      meter_type: 'ELECTRICITY',
      meter_code: 'EL-VOP-B-B201',
      unit: 'kWh',
      unit_price: 3800,
      initial_reading: 100,
      last_known_reading: 100,
      period_current_reading: '140.00',
      period_is_abnormal: true,
      period_reading_billed: false,
    },
  ];

  const rowsFromBuildingA = [
    {
      localId: 'r1',
      fileName: 'IMG_4021.jpg',
      buildingId: 'bldg-a',
      meterId: 'm-a1001-el',
      apartmentId: 'apt-a1001',
      apartmentCode: 'A1001',
      manualMeterAssigned: true,
      suggestionId: 'sug-bldg-a-1',
      draftReading: '140',
      ocrStatus: 'DONE',
    },
    {
      localId: 'r2',
      fileName: 'B201_dien.jpg',
      buildingId: 'bldg-a',
      meterId: null,
      apartmentId: null,
      apartmentCode: null,
      manualMeterAssigned: false,
      suggestionId: 'sug-bldg-a-2',
      draftReading: '140',
      ocrStatus: 'DONE',
    },
  ];

  // Switching to Building B must drop Building A's manual meterId, apartmentId, and suggestionId
  const rematchedToB = rematchBatchPhotoItemsForBuilding(
    rowsFromBuildingA,
    buildingBMeters,
    'bldg-b'
  );
  assert.equal(rematchedToB[0].meterId, null);
  assert.equal(rematchedToB[0].apartmentId, null);
  assert.equal(rematchedToB[0].manualMeterAssigned, false);
  assert.equal(rematchedToB[0].suggestionId, null);
  assert.equal(rematchedToB[0].buildingId, 'bldg-b');

  assert.equal(rematchedToB[1].meterId, 'm-b201-el');
  assert.equal(rematchedToB[1].apartmentId, 'apt-b201');
  assert.equal(rematchedToB[1].suggestionId, null);

  // Reloading same Building B keeps valid manual assignment and suggestionId intact
  const manualInB = [
    {
      ...rematchedToB[0],
      meterId: 'm-b201-el',
      manualMeterAssigned: true,
      suggestionId: 'sug-bldg-b-fresh',
    },
  ];
  const reloadedSameB = rematchBatchPhotoItemsForBuilding(
    manualInB,
    buildingBMeters,
    'bldg-b'
  );
  assert.equal(reloadedSameB[0].meterId, 'm-b201-el');
  assert.equal(reloadedSameB[0].manualMeterAssigned, true);
  assert.equal(reloadedSameB[0].suggestionId, 'sug-bldg-b-fresh');

  // Numeric comparison: draftReading "140" matches server period_current_reading "140.00" -> keeps period_is_abnormal = true
  const evalNumeric = evaluateBatchPhotoImportItems(reloadedSameB, buildingBMeters, {
    anomalyThresholdPct: 30,
    canWriteMeters: true,
  });
  assert.equal(evalNumeric.rows[0].isAbnormal, true);
  assert.equal(evalNumeric.rows[0].validationState, 'READY_ABNORMAL');
});
