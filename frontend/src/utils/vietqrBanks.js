/**
 * Khớp một bản ghi tài khoản ngân hàng (`{ bank_name, bank_code, bank_bin }`)
 * với danh mục ngân hàng VietQR.
 */
export function matchVietQrBank(banks = [], paymentAccount = {}) {
  if (!paymentAccount || !Array.isArray(banks) || banks.length === 0) return null;
  const code = String(paymentAccount.bank_code || '').trim().toUpperCase();
  const bin = String(paymentAccount.bank_bin || '').trim();
  const nameLower = String(paymentAccount.bank_name || '').trim().toLowerCase();

  return (
    banks.find((bk) => {
      if (!bk) return false;
      const bkCode = String(bk.code || '').trim().toUpperCase();
      const bkBin = String(bk.bin || '').trim();
      const bkShort = String(bk.shortName || bk.short_name || '').trim().toLowerCase();
      const bkFull = String(bk.name || '').trim().toLowerCase();

      if (code && bkCode === code) return true;
      if (bin && bkBin === bin) return true;
      if (nameLower) {
        if (bkShort === nameLower) return true;
        if (bkCode.toLowerCase() === nameLower) return true;
        if (bkFull === nameLower) return true;
      }
      return false;
    }) || null
  );
}

/**
 * Chuyển danh sách ngân hàng VietQR thành mảng `options` giàu thông tin cho component `Select`.
 * Nếu hồ sơ hiện tại lưu tên ngân hàng cũ ngoài danh mục VietQR, tự động chèn lên đầu danh sách
 * để không làm mất dữ liệu khi mở form chỉnh sửa.
 */
export function buildVietQrBankOptions(banks = [], currentBankInfo = {}) {
  const mapped = (Array.isArray(banks) ? banks : []).map((b) => {
    const shortName = b.shortName || b.short_name || b.code || b.name || '';
    return {
      value: shortName,
      label: b.code ? `${shortName} (${b.code})` : shortName,
      sublabel: b.name || '',
      badge: b.bin ? `BIN ${b.bin}` : '',
      logo: b.logo || '',
      searchText: `${shortName} ${b.code || ''} ${b.bin || ''} ${b.name || ''}`,
      bank: b,
    };
  });

  const cur = String(currentBankInfo?.bank_name || '').trim();
  const matched = matchVietQrBank(banks, currentBankInfo);
  if (cur && !matched && !mapped.some((o) => o.value === cur)) {
    mapped.unshift({
      value: cur,
      label: cur,
      sublabel: 'Ngân hàng hiện tại',
      badge: currentBankInfo?.bank_bin ? `BIN ${currentBankInfo.bank_bin}` : '',
      logo: currentBankInfo?.bank_logo || '',
      searchText: `${cur} ${currentBankInfo?.bank_code || ''} ${currentBankInfo?.bank_bin || ''}`,
      bank: null,
    });
  }

  return mapped;
}

