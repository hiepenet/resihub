import { test } from 'node:test';
import assert from 'node:assert';
import { isDiscountedPrice, mapPgError } from '../src/services/contractGuards.js';

test('isDiscountedPrice: giá < 90% niêm yết → cần duyệt; ≥ 90% thì không', () => {
  assert.equal(isDiscountedPrice(8000000, 10000000), true);   // 80%
  assert.equal(isDiscountedPrice(9000000, 10000000), false);  // đúng biên 90%
  assert.equal(isDiscountedPrice(9000001, 10000000), false);
});

test('mapPgError: lỗi exclusion constraint (23P01) → 409 OVERLAP_CONTRACT; lỗi khác → null', () => {
  assert.deepEqual(mapPgError({ code: '23P01', constraint: 'contract_no_overlap' }), {
    status: 409,
    code: 'OVERLAP_CONTRACT',
    message: 'Căn hộ đã có hợp đồng trong khoảng thời gian này.',
  });
  assert.equal(mapPgError({ code: '42P01' }), null);
  assert.equal(mapPgError(null), null);
});
