const DEFAULT_TTL_MS = 20_000;
const DEFAULT_MAX_STALE_MS = 300_000;

const dataStore = new Map();
const inflightStore = new Map();

let customScopeResolver = null;

export function setQueryCacheScopeResolver(fn) {
  customScopeResolver = typeof fn === 'function' ? fn : null;
}

function resolveScope() {
  if (customScopeResolver) {
    try {
      const custom = customScopeResolver();
      if (custom) return String(custom);
    } catch {
      // fall through
    }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const rawUser = localStorage.getItem('user');
      if (rawUser) {
        const parsed = JSON.parse(rawUser);
        const uid = parsed?.sub || parsed?.id || parsed?.email;
        if (uid) return `u:${uid}`;
      }
      const token = localStorage.getItem('accessToken');
      if (token) return `t:${token.slice(-24)}`;
    } catch {
      // fall through
    }
  }
  return 'anon';
}

function stableSerialize(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined && value[k] !== '')
    .sort();
  if (keys.length === 0) return '{}';
  return `{${keys.map((k) => `${k}:${stableSerialize(value[k])}`).join(',')}}`;
}

export function buildCacheKey(namespace, parts) {
  const ns = String(namespace || 'default');
  if (parts === undefined || parts === null || parts === '') {
    return `${ns}:all`;
  }
  const serialized = stableSerialize(parts);
  return `${ns}:${serialized || 'all'}`;
}

function toScopedKey(logicalKey) {
  return `${resolveScope()}::${logicalKey}`;
}

export function peekQueryCache(logicalKey, options = {}) {
  const sKey = toScopedKey(logicalKey);
  const entry = dataStore.get(sKey);
  if (!entry) return null;

  const now = Date.now();
  const age = now - entry.updatedAt;
  const maxStaleMs = options.maxStaleMs ?? entry.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  if (age > maxStaleMs) {
    dataStore.delete(sKey);
    return null;
  }

  return {
    data: entry.data,
    isFresh: age <= entry.ttlMs,
    updatedAt: entry.updatedAt,
  };
}

export function cachedFetch(logicalKey, fetcher, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  const force = Boolean(options.force);
  const sKey = toScopedKey(logicalKey);

  if (!force) {
    const existing = dataStore.get(sKey);
    if (existing && Date.now() - existing.updatedAt <= ttlMs) {
      return Promise.resolve(existing.data);
    }
    const pending = inflightStore.get(sKey);
    if (pending) {
      return pending;
    }
  }

  const promise = Promise.resolve()
    .then(() => fetcher())
    .then((result) => {
      // Only commit to cache if this request was not invalidated mid-flight
      if (inflightStore.get(sKey) === promise) {
        dataStore.set(sKey, {
          logicalKey,
          data: result,
          updatedAt: Date.now(),
          ttlMs,
          maxStaleMs,
        });
      }
      return result;
    })
    .finally(() => {
      if (inflightStore.get(sKey) === promise) {
        inflightStore.delete(sKey);
      }
    });

  inflightStore.set(sKey, promise);
  return promise;
}

export function invalidateQueryCache(prefixes) {
  if (!prefixes) {
    clearQueryCache();
    return;
  }
  const list = (Array.isArray(prefixes) ? prefixes : [prefixes])
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  if (list.length === 0) return;

  const matchesPrefix = (logicalKey) =>
    list.some(
      (prefix) =>
        logicalKey === prefix ||
        logicalKey.startsWith(`${prefix}:`) ||
        logicalKey.startsWith(prefix)
    );

  for (const [sKey, entry] of dataStore.entries()) {
    if (matchesPrefix(entry.logicalKey)) {
      dataStore.delete(sKey);
    }
  }

  for (const sKey of inflightStore.keys()) {
    const sepIdx = sKey.indexOf('::');
    const logicalKey = sepIdx >= 0 ? sKey.slice(sepIdx + 2) : sKey;
    if (matchesPrefix(logicalKey)) {
      inflightStore.delete(sKey);
    }
  }
}

const URL_INVALIDATION_RULES = [
  { match: '/api/v1/tenants', namespaces: ['tenants', 'contracts', 'reports', 'users'] },
  {
    match: '/api/v1/contracts',
    namespaces: ['contracts', 'apartments', 'buildings', 'tenants', 'deposits', 'meters', 'invoices', 'reports'],
  },
  { match: '/api/v1/buildings', namespaces: ['buildings', 'apartments', 'meters', 'reports'] },
  { match: '/api/v1/apartments', namespaces: ['apartments', 'buildings', 'contracts', 'meters', 'reports'] },
  { match: '/api/v1/reservations', namespaces: ['reservations', 'apartments', 'buildings', 'reports'] },
  { match: '/api/v1/service-catalog', namespaces: ['services', 'contracts', 'meters'] },
  { match: '/api/v1/service-subscriptions', namespaces: ['services', 'contracts', 'invoices'] },
  { match: '/api/v1/settings', namespaces: ['settings', 'reservations', 'meters'] },
  { match: '/api/v1/deposits', namespaces: ['deposits', 'contracts', 'apartments', 'reports'] },
  { match: '/api/v1/invoices', namespaces: ['invoices', 'payments', 'meters', 'contracts', 'apartments', 'reports', 'deposits'] },
  { match: '/api/v1/payments', namespaces: ['payments', 'invoices', 'contracts', 'apartments', 'reports', 'deposits'] },
  { match: '/api/v1/receivables', namespaces: ['payments', 'invoices', 'reports'] },
  { match: '/api/v1/meters', namespaces: ['meters', 'invoices', 'apartments', 'contracts', 'reports'] },
  { match: '/api/v1/service-requests', namespaces: ['serviceRequests', 'reports'] },
  { match: '/api/v1/notifications', namespaces: ['notifications'] },
  { match: '/api/v1/announcements', namespaces: ['notifications'] },
  { match: '/api/v1/zalo-groups', namespaces: ['notifications'] },
  { match: '/api/v1/admin/users', namespaces: ['users', 'tenants'] },
];

export function invalidateRelatedNamespacesForUrl(url) {
  const cleanUrl = String(url || '');
  if (!cleanUrl) return;
  const matched = new Set();
  for (const rule of URL_INVALIDATION_RULES) {
    if (cleanUrl.includes(rule.match)) {
      for (const ns of rule.namespaces) matched.add(ns);
    }
  }
  if (matched.size > 0) {
    invalidateQueryCache([...matched]);
  }
}

export function clearQueryCache() {
  dataStore.clear();
  inflightStore.clear();
}
