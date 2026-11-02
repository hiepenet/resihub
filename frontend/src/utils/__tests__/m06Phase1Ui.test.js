import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', '..');

function readSrc(relPath) {
  return fs.readFileSync(path.join(SRC_DIR, relPath), 'utf8');
}

test('P0-UI-1: idempotency helper rotates keys across calls and preserves explicit idempotencyKey', async () => {
  const mod = await import('../idempotency.js');
  assert.equal(typeof mod.createIdempotencyKey, 'function');
  assert.equal(typeof mod.withIdempotency, 'function');

  const k1 = mod.createIdempotencyKey();
  const k2 = mod.createIdempotencyKey();
  assert.ok(typeof k1 === 'string' && k1.length > 0);
  assert.ok(typeof k2 === 'string' && k2.length > 0);
  assert.notEqual(k1, k2, 'Consecutive calls must generate distinct keys for multi-installment collection');

  const fixed = mod.withIdempotency({ idempotencyKey: 'fixed-key' });
  assert.equal(fixed.headers['Idempotency-Key'], 'fixed-key');

  const auto1 = mod.withIdempotency();
  const auto2 = mod.withIdempotency();
  assert.notEqual(auto1.headers['Idempotency-Key'], auto2.headers['Idempotency-Key']);
});

test('P0-UI-2: DEPOSIT_STATUS defines DEDUCTED_FULL and unambiguous REFUNDED label', async () => {
  const { DEPOSIT_STATUS } = await import('../../constants/statuses.js');
  assert.deepEqual(DEPOSIT_STATUS.DEDUCTED_FULL, {
    label: 'Đã khấu trừ hết cọc',
    variant: 'amber',
  });
  assert.equal(DEPOSIT_STATUS.REFUNDED.label, 'Đã hoàn đủ 100%');
});

test('P0-UI-3: canCollectAdditionalDeposit strictly checks HELD, open contract status, and remaining shortage', async () => {
  const { canCollectAdditionalDeposit } = await import('../idempotency.js');
  assert.equal(typeof canCollectAdditionalDeposit, 'function');

  assert.equal(
    canCollectAdditionalDeposit({ status: 'SETTLEMENT_DRAFT', contract_status: 'TERMINATED', deposit_amount: 10000000, amount_held: 2000000 }),
    false
  );
  assert.equal(
    canCollectAdditionalDeposit({ status: 'HELD', contract_status: 'TERMINATED', deposit_amount: 10000000, amount_held: 2000000 }),
    false
  );
  assert.equal(
    canCollectAdditionalDeposit({ status: 'HELD', contract_status: 'EXPIRED', deposit_amount: 10000000, amount_held: 2000000 }),
    false
  );
  assert.equal(
    canCollectAdditionalDeposit({ status: 'HELD', contract_status: 'ACTIVE', deposit_amount: 0, amount_held: 0 }),
    false
  );
  assert.equal(
    canCollectAdditionalDeposit({ status: 'HELD', contract_status: 'ACTIVE', deposit_amount: 5000000, amount_held: 5000000 }),
    false
  );
  assert.equal(
    canCollectAdditionalDeposit({ status: 'HELD', contract_status: 'ACTIVE', deposit_amount: 5000000, amount_held: 2000000 }),
    true
  );
  assert.equal(
    canCollectAdditionalDeposit({ status: 'HELD', contract_status: 'RENEWAL_PENDING', deposit_amount: 5000000, amount_held: 2000000 }),
    true
  );
  assert.equal(
    canCollectAdditionalDeposit({ status: 'HELD', contract_status: 'TERMINATION_PENDING', deposit_amount: 5000000, amount_held: 2000000 }),
    true
  );
});

test('P0-UI-4: buildingsService removes convertReservation and residentService.disputeDeposit accepts options', () => {
  const bldgSrc = readSrc('services/buildings.service.js');
  assert.equal(/convertReservation\s*:/.test(bldgSrc), false, 'buildings.service.js must not export convertReservation');
  assert.equal(bldgSrc.includes('withIdempotency'), true, 'buildings.service.js must attach withIdempotency');

  const resSrc = readSrc('services/resident.service.js');
  assert.match(
    resSrc,
    /disputeDeposit\s*:\s*\(\s*depositId\s*,\s*payload\s*,\s*options\b/,
    'residentService.disputeDeposit must accept options parameter'
  );
  assert.equal(resSrc.includes('withIdempotency'), true, 'resident.service.js must attach withIdempotency');
});
