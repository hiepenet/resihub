import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApartmentDrafts,
  findDuplicateCodes,
  floorLevelToken,
} from '../src/services/apartmentBulk.js';

const units = [
  { suffix: '01', type: '1PN', bedrooms: 1, area_m2: 45, base_rent: 8500000 },
  { suffix: '02', type: '2PN', bedrooms: 2, area_m2: 60, base_rent: 11000000 },
];

test('floorLevelToken maps positive, ground and basement levels', () => {
  assert.equal(floorLevelToken(5), '5');
  assert.equal(floorLevelToken(0), 'G');
  assert.equal(floorLevelToken(-2), 'B2');
});

test('buildApartmentDrafts builds one code per floor × unit', () => {
  const drafts = buildApartmentDrafts({
    codePrefix: 'a',
    floors: [
      { id: 'f1', level: 1, name: 'Tầng 1' },
      { id: 'f2', level: 2, name: 'Tầng 2' },
    ],
    units,
    zoneId: 'z1',
    amenities: { wifi: true },
    note: 'mẫu tầng',
  });

  assert.equal(drafts.length, 4);
  assert.deepEqual(drafts.map((d) => d.code), ['A101', 'A102', 'A201', 'A202']);
  assert.equal(drafts[0].floor_id, 'f1');
  assert.equal(drafts[0].floor_name, 'Tầng 1');
  assert.equal(drafts[0].zone_id, 'z1');
  assert.deepEqual(drafts[0].amenities, { wifi: true });
  assert.equal(drafts[0].note, 'mẫu tầng');
  assert.equal(drafts[3].bedrooms, 2);
  assert.equal(drafts[3].base_rent, 11000000);
});

test('buildApartmentDrafts auto-generates padded suffixes when suffix is omitted', () => {
  const drafts = buildApartmentDrafts({
    floors: [{ id: 'ground', level: 0 }],
    units: [{ type: 'Studio' }, { type: 'Studio' }],
  });

  assert.deepEqual(drafts.map((d) => d.code), ['G01', 'G02']);
});

test('buildApartmentDrafts normalizes prefix, suffix and numeric fields', () => {
  const drafts = buildApartmentDrafts({
    codePrefix: ' b ',
    floors: [{ id: 'basement', level: -1 }],
    units: [
      { suffix: ' a ', type: ' 1PN ', bedrooms: '1', area_m2: '45.5', base_rent: '8500000' },
    ],
  });

  assert.equal(drafts[0].code, 'BB1A');
  assert.equal(drafts[0].type, '1PN');
  assert.equal(drafts[0].bedrooms, 1);
  assert.equal(drafts[0].area_m2, 45.5);
  assert.equal(drafts[0].base_rent, 8500000);
});

test('findDuplicateCodes returns each duplicated code once', () => {
  const drafts = [{ code: 'A101' }, { code: 'A101' }, { code: 'A102' }];
  assert.deepEqual(findDuplicateCodes(drafts), ['A101']);
});
