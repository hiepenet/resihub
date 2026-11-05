import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Task 3.1 — queryCache deduplicates concurrent in-flight fetches (<StrictMode>) and serves fresh TTL hits', async () => {
  const {
    buildCacheKey,
    cachedFetch,
    peekQueryCache,
    clearQueryCache,
    setQueryCacheScopeResolver,
  } = await import('../../frontend/src/services/queryCache.js');

  clearQueryCache();
  setQueryCacheScopeResolver(() => 'user-mgr-1');

  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 25));
    return { data: [{ id: 't1', full_name: 'Nguyen Van A' }] };
  };

  const key = buildCacheKey('tenants', { list: true, building_id: 'b1' });
  const [r1, r2] = await Promise.all([
    cachedFetch(key, fetcher, { ttlMs: 5_000 }),
    cachedFetch(key, fetcher, { ttlMs: 5_000 }),
  ]);

  assert.equal(calls, 1, 'Concurrent calls with identical key must share 1 in-flight fetch');
  assert.deepEqual(r1, r2);

  // Fresh hit within TTL: 0 extra calls
  const r3 = await cachedFetch(key, fetcher, { ttlMs: 5_000 });
  assert.equal(calls, 1, 'Fresh TTL hit must not invoke fetcher again');
  assert.deepEqual(r3, r1);

  const peeked = peekQueryCache(key);
  assert.ok(peeked, 'peekQueryCache must return cached entry');
  assert.equal(peeked.isFresh, true);
  assert.deepEqual(peeked.data, r1);

  // { force: true } bypasses fresh TTL and updates stored value
  const r4 = await cachedFetch(
    key,
    async () => {
      calls += 1;
      return { data: [{ id: 't1', full_name: 'Updated Name' }] };
    },
    { ttlMs: 5_000, force: true }
  );
  assert.equal(calls, 2, 'force: true must bypass fresh cache');
  assert.equal(r4.data[0].full_name, 'Updated Name');
  assert.equal(peekQueryCache(key).data.data[0].full_name, 'Updated Name');
});

test('Task 3.2 — Stale SWR window, cross-user scope isolation (Review Focus #4) & error recovery (Review Focus #5)', async () => {
  const {
    buildCacheKey,
    cachedFetch,
    peekQueryCache,
    clearQueryCache,
    setQueryCacheScopeResolver,
    invalidateRelatedNamespacesForUrl,
  } = await import('../../frontend/src/services/queryCache.js');

  clearQueryCache();
  let currentScope = 'user-mgr-1';
  setQueryCacheScopeResolver(() => currentScope);

  const key = buildCacheKey('contracts', { id: 'c1' });
  await cachedFetch(key, async () => ({ data: { id: 'c1', unmasked: '001099001234' } }), {
    ttlMs: 15,
    maxStaleMs: 5_000,
  });

  await new Promise((r) => setTimeout(r, 30));
  const staleSnap = peekQueryCache(key, { maxStaleMs: 5_000 });
  assert.ok(staleSnap, 'Stale entry within maxStaleMs must still be returned by peekQueryCache');
  assert.equal(staleSnap.isFresh, false, 'Expired ttlMs entry must report isFresh === false');

  // Review Focus #4: Switch user scope from MANAGER to OWNER -> must NOT see MANAGER cache
  currentScope = 'user-owner-2';
  assert.equal(
    peekQueryCache(key),
    null,
    'Switching authenticated user scope must isolate cached entries completely'
  );

  // Review Focus #5: Rejected fetcher must NOT poison cache or in-flight map
  const errKey = buildCacheKey('tenants', { id: 'broken' });
  await assert.rejects(
    () =>
      cachedFetch(errKey, async () => {
        throw new Error('HTTP_500');
      }),
    /HTTP_500/
  );
  assert.equal(peekQueryCache(errKey), null, 'Failed fetch must not be cached');

  const recovered = await cachedFetch(errKey, async () => ({ data: { ok: true } }));
  assert.deepEqual(recovered, { data: { ok: true } }, 'Immediate retry after error must succeed');

  // Mutation invalidation by URL
  const settingsKey = buildCacheKey('settings', 'global');
  const contractListKey = buildCacheKey('contracts', { list: true });
  const aptKey = buildCacheKey('apartments', { id: 'a1' });
  await cachedFetch(settingsKey, async () => ({ data: { allow: true } }));
  await cachedFetch(contractListKey, async () => ({ data: [{ id: 'c1' }] }));
  await cachedFetch(aptKey, async () => ({ data: { id: 'a1' } }));

  invalidateRelatedNamespacesForUrl('/api/v1/contracts/c1/approve');
  assert.equal(peekQueryCache(contractListKey), null, 'Contract mutation must invalidate contracts namespace');
  assert.equal(peekQueryCache(aptKey), null, 'Contract mutation must invalidate apartments namespace');
  assert.ok(peekQueryCache(settingsKey), 'Contract mutation must keep unrelated settings cache intact');

  clearQueryCache();
  assert.equal(peekQueryCache(settingsKey), null, 'clearQueryCache must purge all cached scopes');
});
