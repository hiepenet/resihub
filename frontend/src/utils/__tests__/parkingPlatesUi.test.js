import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_PARKING_QUANTITY,
  isParkingService,
  allowsMultiQuantity,
  syncVehiclePlatesArray,
  validateServiceMetaInput,
} from '../serviceSubscriptionMeta.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, '../..');

function readSrc(relPath) {
  return fs.readFileSync(path.join(SRC_ROOT, relPath), 'utf8');
}

test('isParkingService detects PARKING category case-insensitively on strings and catalog/subscription objects', () => {
  assert.equal(MAX_PARKING_QUANTITY, 10);
  assert.equal(isParkingService('PARKING'), true);
  assert.equal(isParkingService(' parking '), true);
  assert.equal(isParkingService({ category: 'PARKING', code: 'CUSTOM_SLOT' }), true);
  assert.equal(isParkingService({ service_category: 'parking' }), true);
  assert.equal(isParkingService({ category: 'INTERNET', code: 'INTERNET_FIBER' }), false);
  assert.equal(isParkingService({ category: 'CLEANING', billing_type: 'QUANTITY' }), false);
  assert.equal(isParkingService(null), false);

  // Review Fix (Important #1): FIXED parking services also allow multi-quantity (1..10)
  assert.equal(allowsMultiQuantity({ category: 'PARKING', billing_type: 'FIXED' }), true);
  assert.equal(allowsMultiQuantity({ service_category: 'PARKING', billing_type: 'FIXED' }), true);
  assert.equal(allowsMultiQuantity({ category: 'CLEANING', billing_type: 'QUANTITY' }), true);
  assert.equal(allowsMultiQuantity({ category: 'INTERNET', billing_type: 'FIXED' }), false);
  assert.equal(allowsMultiQuantity(null), false);
});

test('syncVehiclePlatesArray slices on quantity reduction, pads on expansion, and preserves plates during transient empty input (Review Focus #5 & Important #2)', () => {
  assert.deepEqual(
    syncVehiclePlatesArray(['59A1-111.11', '59B2-222.22'], 1),
    ['59A1-111.11']
  );
  assert.deepEqual(
    syncVehiclePlatesArray(['59A1-111.11', '59B2-222.22'], 3),
    ['59A1-111.11', '59B2-222.22', '']
  );
  assert.deepEqual(
    syncVehiclePlatesArray(['59A1-111.11', '59B2-222.22', '59C3-333.33'], ''),
    ['59A1-111.11', '59B2-222.22', '59C3-333.33']
  );
  assert.equal(syncVehiclePlatesArray([], 25).length, 10);
  assert.deepEqual(syncVehiclePlatesArray(undefined, 1), ['']);
  assert.deepEqual(syncVehiclePlatesArray(undefined, ''), ['']);
});

test('validateServiceMetaInput validates per-vehicle plates, duplicate plates, parking cap, non-parking passthrough, and note length', () => {
  const okParking = validateServiceMetaInput({
    isParking: true,
    quantity: 2,
    vehiclePlates: [' 59A1-123.45 ', 'Xe đạp điện #2'],
    note: ' Thẻ từ hầm B1 ',
  });
  assert.equal(okParking.valid, true);
  assert.deepEqual(okParking.cleanPlates, ['59A1-123.45', 'Xe đạp điện #2']);
  assert.equal(okParking.cleanNote, 'Thẻ từ hầm B1');
  assert.deepEqual(okParking.plateErrors, ['', '']);

  // Empty second plate -> error on slot #2 only
  const missingSecond = validateServiceMetaInput({
    isParking: true,
    quantity: 2,
    vehiclePlates: ['59A1-123.45', '   '],
    note: '',
  });
  assert.equal(missingSecond.valid, false);
  assert.equal(missingSecond.plateErrors[0], '');
  assert.match(missingSecond.plateErrors[1], /biển số xe #2/i);

  // Duplicate plate differing by case/whitespace -> error on slot #2 (Review Focus #1)
  const dup = validateServiceMetaInput({
    isParking: true,
    quantity: 2,
    vehiclePlates: ['59a1-123.45', '  59A1-123.45 '],
    note: '',
  });
  assert.equal(dup.valid, false);
  assert.equal(dup.plateErrors[0], '');
  assert.match(dup.plateErrors[1], /trùng/i);

  // Quantity reduced to 1 while old array still has 2 elements -> slices cleanly to 1 (Review Focus #5)
  const reduced = validateServiceMetaInput({
    isParking: true,
    quantity: 1,
    vehiclePlates: ['59A1-111.11', '59A1-111.11'],
    note: '',
  });
  assert.equal(reduced.valid, true);
  assert.deepEqual(reduced.cleanPlates, ['59A1-111.11']);

  // Parking quantity > 10 -> quantityError
  const overCap = validateServiceMetaInput({
    isParking: true,
    quantity: 11,
    vehiclePlates: Array.from({ length: 11 }, (_, i) => `59A1-00${i}`),
    note: '',
  });
  assert.equal(overCap.valid, false);
  assert.match(overCap.quantityError, /10/);

  // Non-parking QUANTITY with quantity=12 and stray plates -> valid, cleanPlates=[] (Review Focus #4)
  const nonParking = validateServiceMetaInput({
    isParking: false,
    quantity: 12,
    vehiclePlates: ['59A1-123.45'],
    note: 'Dọn phòng sáng thứ 2-4-6',
  });
  assert.equal(nonParking.valid, true);
  assert.equal(nonParking.quantityError, '');
  assert.deepEqual(nonParking.cleanPlates, []);
  assert.equal(nonParking.cleanNote, 'Dọn phòng sáng thứ 2-4-6');

  // Note > 500 chars -> noteError
  const longNote = validateServiceMetaInput({
    isParking: false,
    quantity: 1,
    vehiclePlates: [],
    note: 'N'.repeat(501),
  });
  assert.equal(longNote.valid, false);
  assert.match(longNote.noteError, /500/);
});

test('ServiceSubscriptionMetaFields component and all 4 screens enforce parking plates and clean optional note labels', () => {
  const compSrc = readSrc('components/common/ServiceSubscriptionMetaFields.jsx');
  assert.match(compSrc, /export\s+function\s+ServiceSubscriptionMetaFields/);
  assert.match(compSrc, /export\s+function\s+VehiclePlatesBadges/);
  assert.match(compSrc, /Biển số xe/);
  assert.match(compSrc, /Ghi chú dịch vụ \(tùy chọn\)/);
  assert.doesNotMatch(compSrc, /Ghi chú dịch vụ \/ Biển số xe/);

  const screens = [
    'pages/admin/contracts/ContractsPage.jsx',
    'pages/admin/contracts/ContractDetailPage.jsx',
    'pages/admin/services/SubscriptionsPage.jsx',
    'pages/resident/tabs/ServicesTab.jsx',
  ];

  for (const rel of screens) {
    const src = readSrc(rel);
    assert.match(src, /ServiceSubscriptionMetaFields/, `${rel} must use ServiceSubscriptionMetaFields`);
    assert.match(src, /vehicle_plates/, `${rel} must wire vehicle_plates into state and API payload`);
    assert.doesNotMatch(
      src,
      /Ghi chú dịch vụ \/ Biển số xe|Ghi chú đăng ký \(biển số xe|Ghi chú \(biển số xe/,
      `${rel} must not combine license plate into generic note label`
    );
  }

  assert.match(readSrc('pages/admin/contracts/ContractsPage.jsx'), /allowsMultiQuantity/);
  assert.match(readSrc('pages/admin/contracts/ContractDetailPage.jsx'), /allowsMultiQuantity/);
  assert.match(readSrc('pages/admin/contracts/ContractDetailPage.jsx'), /VehiclePlatesBadges/);
  assert.match(readSrc('pages/admin/services/SubscriptionsPage.jsx'), /VehiclePlatesBadges/);
  assert.match(
    readSrc('pages/admin/services/SubscriptionsPage.jsx'),
    /vehicle_plates[\s\S]{0,120}toLowerCase\(\)\.includes\(q\)/,
    'SubscriptionsPage search filter must match vehicle_plates'
  );
  assert.match(
    readSrc('pages/resident/tabs/ServicesTab.jsx'),
    /cancelTarget[\s\S]{0,400}VehiclePlatesBadges\s+plates=\{cancelTarget\.vehicle_plates\}/,
    'Resident Cancel Service modal must show VehiclePlatesBadges for cancelTarget'
  );
});
