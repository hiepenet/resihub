import { useState, useEffect, useCallback } from 'react';
import { extractErrorMessage } from '../utils/validation';

export function useApi(fetcher, deps = [], options = {}) {
  const { immediate = true, initialData = null } = options;
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState(null);

  const execute = useCallback(async (...args) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetcher(...args);
      setData(res);
      return res;
    } catch (err) {
      const msg = extractErrorMessage(err);
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (immediate) {
      execute().catch(() => {});
    }
  }, [execute, immediate]);

  return { data, setData, loading, error, refetch: execute };
}

