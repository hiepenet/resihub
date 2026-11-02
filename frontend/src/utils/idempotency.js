export function createIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `idem-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 12)}`;
}

export function withIdempotency(options = {}) {
  const { idempotencyKey, headers, ...rest } = options || {};
  return {
    ...rest,
    headers: {
      ...(headers || {}),
      'Idempotency-Key': idempotencyKey || createIdempotencyKey(),
    },
  };
}

export function canCollectAdditionalDeposit(row) {
  if (!row || row.status !== 'HELD') return false;
  if (!['ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING'].includes(row.contract_status)) {
    return false;
  }
  const reqAmount = Number(row.deposit_amount || 0);
  const heldAmount = Number(row.amount_held || 0);
  return reqAmount > 0 && reqAmount > heldAmount;
}
