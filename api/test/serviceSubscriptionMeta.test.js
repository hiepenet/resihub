import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PARKING_QUANTITY,
  isParkingCategory,
  validateAndNormalizeSubscriptionMeta,
} from '../src/services/serviceSubscriptionMeta.js';

test('isParkingCategory detects PARKING case-insensitively', () => {
  assert.equal(isParkingCategory('PARKING'), true);
  assert.equal(isParkingCategory(' parking '), true);
  assert.equal(isParkingCategory('INTERNET'), false);
  assert.equal(isParkingCategory(null), false);
  assert.equal(MAX_PARKING_QUANTITY, 10);
});

test('validateAndNormalizeSubscriptionMeta accepts valid PARKING plates (including non-motorized labels) and trims note', () => {
  const res = validateAndNormalizeSubscriptionMeta({
    category: 'PARKING',
    billingType: 'QUANTITY',
    quantity: 2,
    vehiclePlates: [' 59A1-123.45 ', 'Xe đạp #2'],
    note: '  Thẻ từ hầm B1  ',
  });
  assert.deepEqual(res, {
    quantity: 2,
    vehiclePlates: ['59A1-123.45', 'Xe đạp #2'],
    note: 'Thẻ từ hầm B1',
  });
});

test('validateAndNormalizeSubscriptionMeta rejects missing, mismatched, out-of-length, or >10 PARKING plates', () => {
  assert.throws(
    () =>
      validateAndNormalizeSubscriptionMeta({
        category: 'PARKING',
        billingType: 'QUANTITY',
        quantity: 1,
        vehiclePlates: undefined,
      }),
    (err) => err.httpStatus === 422 && err.code === 'VEHICLE_PLATES_REQUIRED'
  );

  assert.throws(
    () =>
      validateAndNormalizeSubscriptionMeta({
        category: 'PARKING',
        billingType: 'QUANTITY',
        quantity: 2,
        vehiclePlates: ['59A1-123.45'],
      }),
    (err) => err.httpStatus === 422 && err.code === 'INVALID_VEHICLE_PLATES'
  );

  assert.throws(
    () =>
      validateAndNormalizeSubscriptionMeta({
        category: 'PARKING',
        billingType: 'QUANTITY',
        quantity: 1,
        vehiclePlates: ['A'],
      }),
    (err) => err.httpStatus === 422 && err.code === 'INVALID_VEHICLE_PLATES'
  );

  assert.throws(
    () =>
      validateAndNormalizeSubscriptionMeta({
        category: 'PARKING',
        billingType: 'QUANTITY',
        quantity: 1,
        vehiclePlates: ['X'.repeat(31)],
      }),
    (err) => err.httpStatus === 422 && err.code === 'INVALID_VEHICLE_PLATES'
  );

  assert.throws(
    () =>
      validateAndNormalizeSubscriptionMeta({
        category: 'PARKING',
        billingType: 'QUANTITY',
        quantity: 11,
        vehiclePlates: Array.from({ length: 11 }, (_, i) => `59A-${100 + i}`),
      }),
    (err) => err.httpStatus === 422 && err.code === 'INVALID_SERVICE_QUANTITY'
  );
});

test('validateAndNormalizeSubscriptionMeta rejects duplicate plates differing only in case or whitespace (Review Focus #1)', () => {
  assert.throws(
    () =>
      validateAndNormalizeSubscriptionMeta({
        category: 'PARKING',
        billingType: 'QUANTITY',
        quantity: 2,
        vehiclePlates: ['59a1-123.45', '  59A1-123.45 '],
      }),
    (err) => err.httpStatus === 422 && err.code === 'DUPLICATE_VEHICLE_PLATE'
  );
});

test('validateAndNormalizeSubscriptionMeta allows quantity > 10 for non-PARKING QUANTITY services and strips stray vehiclePlates (Review Focus #4)', () => {
  const cleaning = validateAndNormalizeSubscriptionMeta({
    category: 'CLEANING',
    billingType: 'QUANTITY',
    quantity: 12,
    vehiclePlates: ['30A-111.11'],
    note: 'Dọn thứ 2-4-6',
  });
  assert.deepEqual(cleaning, {
    quantity: 12,
    vehiclePlates: [],
    note: 'Dọn thứ 2-4-6',
  });

  const fixedInternet = validateAndNormalizeSubscriptionMeta({
    category: 'INTERNET',
    billingType: 'FIXED',
    quantity: 3,
    vehiclePlates: ['30A-111.11'],
    note: '',
  });
  assert.deepEqual(fixedInternet, {
    quantity: 1,
    vehiclePlates: [],
    note: null,
  });

  assert.throws(
    () =>
      validateAndNormalizeSubscriptionMeta({
        category: 'INTERNET',
        billingType: 'FIXED',
        quantity: 1,
        note: 'N'.repeat(501),
      }),
    (err) => err.httpStatus === 422 && err.code === 'INVALID_SERVICE_NOTE'
  );
});


test('validateAndNormalizeSubscriptionMeta allows multi-vehicle quantity for FIXED PARKING services and rejects non-primitive JSON values', () => {
  const fixedParking = validateAndNormalizeSubscriptionMeta({
    category: 'PARKING',
    billingType: 'FIXED',
    quantity: 2,
    vehiclePlates: ['59A1-111.11', '59A1-222.22'],
    note: 'Gói đỗ xe cố định',
  });
  assert.deepEqual(fixedParking, {
    quantity: 2,
    vehiclePlates: ['59A1-111.11', '59A1-222.22'],
    note: 'Gói đỗ xe cố định',
  });

  assert.throws(
    () =>
      validateAndNormalizeSubscriptionMeta({
        category: 'PARKING',
        billingType: 'QUANTITY',
        quantity: 1,
        vehiclePlates: [{}],
      }),
    (err) => err.httpStatus === 422 && err.code === 'INVALID_VEHICLE_PLATES'
  );

  assert.throws(
    () =>
      validateAndNormalizeSubscriptionMeta({
        category: 'PARKING',
        billingType: 'QUANTITY',
        quantity: 1,
        vehiclePlates: [true],
      }),
    (err) => err.httpStatus === 422 && err.code === 'INVALID_VEHICLE_PLATES'
  );

  assert.throws(
    () =>
      validateAndNormalizeSubscriptionMeta({
        category: 'INTERNET',
        billingType: 'FIXED',
        quantity: 1,
        note: { bad: 1 },
      }),
    (err) => err.httpStatus === 422 && err.code === 'INVALID_SERVICE_NOTE'
  );
});
