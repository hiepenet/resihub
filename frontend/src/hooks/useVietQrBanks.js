import { useState, useEffect, useCallback } from 'react';
import { buildingsService } from '../services/buildings.service';

let cachedBanks = null;
let inflightPromise = null;

async function fetchBanksOnce(force = false) {
  if (!force && Array.isArray(cachedBanks) && cachedBanks.length > 0) {
    return cachedBanks;
  }
  if (!force && inflightPromise) {
    return inflightPromise;
  }

  inflightPromise = buildingsService
    .listBanks()
    .then((res) => {
      const items = Array.isArray(res?.data) ? res.data : [];
      if (items.length > 0) {
        cachedBanks = items;
      }
      return items;
    })
    .catch(() => cachedBanks || [])
    .finally(() => {
      inflightPromise = null;
    });

  return inflightPromise;
}

/**
 * Hook tải và lưu đệm danh sách ngân hàng VietQR dùng chung cho toàn bộ các màn hình.
 */
export function useVietQrBanks() {
  const [banks, setBanks] = useState(() => cachedBanks || []);
  const [loading, setLoading] = useState(() => !cachedBanks);

  const reload = useCallback(async (force = true) => {
    setLoading(true);
    try {
      const items = await fetchBanksOnce(force);
      setBanks(items);
      return items;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (cachedBanks && cachedBanks.length > 0) {
      setBanks(cachedBanks);
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    fetchBanksOnce(false).then((items) => {
      if (!active) return;
      setBanks(items);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  return { banks, loading, reload };
}

export default useVietQrBanks;

