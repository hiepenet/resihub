import { test } from 'node:test';
import assert from 'node:assert';
import { isTransitionAllowed, APARTMENT_TRANSITIONS, APARTMENT_STATUSES } from '../src/services/apartmentStatus.js';

test('AVAILABLE -> RESERVED/OCCUPIED/MAINTENANCE/INACTIVE hợp lệ', () => {
  for (const to of ['RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE']) {
    assert.equal(isTransitionAllowed('AVAILABLE', to), true);
  }
});
test('OCCUPIED chỉ được sang MAINTENANCE (rời OCCUPIED phải qua terminate)', () => {
  assert.equal(isTransitionAllowed('OCCUPIED', 'MAINTENANCE'), true);
  assert.equal(isTransitionAllowed('OCCUPIED', 'AVAILABLE'), false);
  assert.equal(isTransitionAllowed('OCCUPIED', 'INACTIVE'), false);
});
test('RESERVED -> AVAILABLE/OCCUPIED, không sang MAINTENANCE/INACTIVE', () => {
  assert.equal(isTransitionAllowed('RESERVED', 'AVAILABLE'), true);
  assert.equal(isTransitionAllowed('RESERVED', 'OCCUPIED'), true);
  assert.equal(isTransitionAllowed('RESERVED', 'MAINTENANCE'), false);
});
test('MAINTENANCE -> AVAILABLE/INACTIVE; INACTIVE -> AVAILABLE', () => {
  assert.equal(isTransitionAllowed('MAINTENANCE', 'AVAILABLE'), true);
  assert.equal(isTransitionAllowed('MAINTENANCE', 'INACTIVE'), true);
  assert.equal(isTransitionAllowed('INACTIVE', 'AVAILABLE'), true);
  assert.equal(isTransitionAllowed('INACTIVE', 'MAINTENANCE'), false);
});
test('no-op (to === from) và status lạ trả false', () => {
  assert.equal(isTransitionAllowed('AVAILABLE', 'AVAILABLE'), false);
  assert.equal(isTransitionAllowed('AVAILABLE', 'XYZ'), false);
});
test('đủ 5 trạng thái chuẩn FR-008', () => {
  assert.deepEqual(APARTMENT_STATUSES, ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE']);
  assert.deepEqual(Object.keys(APARTMENT_TRANSITIONS).sort(), [...APARTMENT_STATUSES].sort());
});
