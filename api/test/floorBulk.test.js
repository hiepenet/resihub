import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultFloorName,
  expandFloorRange,
  validateAndNormalizeBulkFloors,
} from '../src/services/floorBulk.js';

test('defaultFloorName formats basement, ground, and positive floors consistently', () => {
  assert.equal(defaultFloorName(-2), 'Tầng hầm B2');
  assert.equal(defaultFloorName(-1), 'Tầng hầm B1');
  assert.equal(defaultFloorName(0), 'Tầng Trệt');
  assert.equal(defaultFloorName(1), 'Tầng 1');
  assert.equal(defaultFloorName(12, 'Tầng '), 'Tầng 12');
  assert.equal(defaultFloorName(3, 'Lầu'), 'Lầu 3');
  assert.equal(defaultFloorName(5, 'F-'), 'F-5');
  assert.equal(defaultFloorName(8, '   '), 'Tầng 8');
});

test('expandFloorRange generates ascending floors and respects includeZero', () => {
  const withoutZero = expandFloorRange({
    fromLevel: -2,
    toLevel: 2,
    includeZero: false,
    namePrefix: 'Tầng',
  });
  assert.equal(withoutZero.ok, true);
  assert.deepEqual(withoutZero.floors, [
    { level: -2, name: 'Tầng hầm B2' },
    { level: -1, name: 'Tầng hầm B1' },
    { level: 1, name: 'Tầng 1' },
    { level: 2, name: 'Tầng 2' },
  ]);

  const withZero = expandFloorRange({
    fromLevel: -1,
    toLevel: 1,
    includeZero: true,
  });
  assert.equal(withZero.ok, true);
  assert.deepEqual(
    withZero.floors.map((f) => f.level),
    [-1, 0, 1]
  );
  assert.equal(withZero.floors[1].name, 'Tầng Trệt');
});

test('expandFloorRange rejects invalid ranges, non-integers, out-of-bounds, and empty result', () => {
  assert.equal(expandFloorRange({ fromLevel: 5, toLevel: 2 }).ok, false);
  assert.equal(expandFloorRange({ fromLevel: -11, toLevel: 1 }).ok, false);
  assert.equal(expandFloorRange({ fromLevel: 1, toLevel: 201 }).ok, false);
  assert.equal(expandFloorRange({ fromLevel: 1, toLevel: 101 }).ok, false);
  assert.equal(expandFloorRange({ fromLevel: '1.5', toLevel: 3 }).ok, false);
  assert.equal(expandFloorRange({ fromLevel: 0, toLevel: 0, includeZero: false }).ok, false);
});

test('validateAndNormalizeBulkFloors normalizes explicit floor list and preserves custom names', () => {
  const res = validateAndNormalizeBulkFloors({
    name_prefix: 'Lầu',
    floors: [
      { level: '2' },
      { level: -1, name: '' },
      { level: 0 },
      { level: 13, name: '  Tầng 12A  ' },
    ],
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.drafts, [
    { level: -1, name: 'Tầng hầm B1' },
    { level: 0, name: 'Tầng Trệt' },
    { level: 2, name: 'Lầu 2' },
    { level: 13, name: 'Tầng 12A' },
  ]);
});

test('validateAndNormalizeBulkFloors rejects duplicate levels in payload', () => {
  const res = validateAndNormalizeBulkFloors({
    floors: [
      { level: 3, name: 'Tầng 3' },
      { level: 4, name: 'Tầng 4' },
      { level: '3', name: 'Tầng 3B' },
    ],
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'DUPLICATE_LEVEL_IN_PAYLOAD');
  assert.deepEqual(res.conflicts, [{ level: 3 }]);
});

test('validateAndNormalizeBulkFloors rejects non-integer levels, oversized batches, and overlong names', () => {
  for (const badLevel of ['2.5', '', null, true, false, [], {}, -15, 250]) {
    const res = validateAndNormalizeBulkFloors({ floors: [{ level: badLevel }] });
    assert.equal(res.ok, false, `Expected failure for level=${JSON.stringify(badLevel)}`);
    assert.equal(res.code, 'VALIDATION_ERROR');
  }

  const tooMany = Array.from({ length: 101 }, (_, idx) => ({ level: idx + 1 }));
  assert.equal(validateAndNormalizeBulkFloors({ floors: tooMany }).ok, false);

  const longName = validateAndNormalizeBulkFloors({
    floors: [{ level: 1, name: 'X'.repeat(101) }],
  });
  assert.equal(longName.ok, false);
  assert.equal(longName.code, 'VALIDATION_ERROR');
});

test('validateAndNormalizeBulkFloors also expands from_level..to_level when floors array is omitted', () => {
  const res = validateAndNormalizeBulkFloors({
    from_level: 6,
    to_level: 8,
    name_prefix: 'Tầng',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.drafts, [
    { level: 6, name: 'Tầng 6' },
    { level: 7, name: 'Tầng 7' },
    { level: 8, name: 'Tầng 8' },
  ]);

  const badPrefixType = validateAndNormalizeBulkFloors({
    from_level: 1,
    to_level: 2,
    name_prefix: { bad: true },
  });
  assert.equal(badPrefixType.ok, false);
  assert.equal(badPrefixType.code, 'VALIDATION_ERROR');

  const overlongPrefix = validateAndNormalizeBulkFloors({
    from_level: 1,
    to_level: 3,
    name_prefix: 'A'.repeat(100),
  });
  assert.equal(overlongPrefix.ok, false);
  assert.equal(overlongPrefix.code, 'VALIDATION_ERROR');
});
