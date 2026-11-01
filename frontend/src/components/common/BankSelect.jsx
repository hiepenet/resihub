import React, { useMemo } from 'react';
import { Landmark } from 'lucide-react';
import { Select } from '../ui/Select';
import { useVietQrBanks } from '../../hooks/useVietQrBanks';
import { buildVietQrBankOptions, matchVietQrBank } from '../../utils/vietqrBanks';

/**
 * Dropdown chọn ngân hàng chuẩn VietQR.io dùng chung trên toàn hệ thống
 * (hiển thị logo, tên viết tắt, mã ngân hàng, mã BIN và hỗ trợ tìm kiếm nhanh không dấu).
 */
export function BankSelect({
  label = 'Ngân hàng (VietQR)',
  value = '',
  bankMeta = null,
  onBankChange,
  onChange,
  placeholder,
  searchPlaceholder = 'Tìm tên NH, mã VCB, TCB, MB, mã BIN...',
  required = false,
  disabled = false,
  error,
  hint,
  name,
  id,
  size = 'md',
  className = '',
  containerClassName = '',
}) {
  const { banks, loading } = useVietQrBanks();

  const matchedBank = useMemo(
    () =>
      matchVietQrBank(banks, {
        bank_name: value,
        bank_code: bankMeta?.bank_code || '',
        bank_bin: bankMeta?.bank_bin || '',
      }),
    [banks, value, bankMeta?.bank_code, bankMeta?.bank_bin]
  );

  const resolvedValue = matchedBank
    ? matchedBank.shortName || matchedBank.short_name || value
    : value;

  const options = useMemo(
    () =>
      buildVietQrBankOptions(banks, {
        bank_name: value,
        bank_code: bankMeta?.bank_code || '',
        bank_bin: bankMeta?.bank_bin || '',
        bank_logo: bankMeta?.bank_logo || '',
      }),
    [banks, value, bankMeta?.bank_code, bankMeta?.bank_bin, bankMeta?.bank_logo]
  );

  const resolvedPlaceholder =
    placeholder !== undefined
      ? placeholder
      : loading && options.length === 0
      ? 'Đang tải ngân hàng VietQR...'
      : '-- Chọn ngân hàng --';

  return (
    <Select
      id={id}
      name={name}
      size={size}
      icon={Landmark}
      label={label}
      required={required}
      disabled={disabled}
      error={error}
      hint={hint}
      placeholder={resolvedPlaceholder}
      searchPlaceholder={searchPlaceholder}
      emptyText="Không tìm thấy ngân hàng phù hợp trong danh mục VietQR"
      value={resolvedValue}
      options={options}
      onChange={onChange}
      onValueChange={(nextVal, rawOpt) => {
        const chosen = rawOpt?.bank || null;
        onBankChange?.(nextVal, chosen);
      }}
      className={className}
      containerClassName={containerClassName}
    />
  );
}

export default BankSelect;

