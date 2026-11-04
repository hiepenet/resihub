import React, { useId, useRef, useState, useLayoutEffect } from 'react';
import {
  formatMoneyInputDisplay,
  parseMoneyUserEdit,
  handleMoneySeparatorKey,
} from '../../utils/moneyInput';

/**
 * Ô nhập số tiền tự động định dạng phân tách hàng nghìn bằng dấu chấm (VD: 100.000, 1.000.000).
 * Vẫn phát sự kiện `onChange` với `e.target.value` là chuỗi số nguyên sạch (VD: "100000", "-200000")
 * để tương thích hoàn toàn với các phép tính `Number(...)` và payload gửi API.
 */
export function MoneyInput({
  label,
  hint,
  error,
  icon: Icon,
  rightElement,
  required = false,
  allowNegative = false,
  value,
  onChange,
  onValueChange,
  onKeyDown,
  onBlur,
  name,
  id,
  placeholder,
  disabled = false,
  className = '',
  containerClassName = '',
  ...restProps
}) {
  const generatedId = useId();
  const fieldId = id || generatedId;
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  const inputRef = useRef(null);
  const pendingCaretRef = useRef(null);
  const [transientMinus, setTransientMinus] = useState(false);

  // Loại bỏ các thuộc tính đặc thù của type="number" nếu truyền dư sang
  const {
    type: _ignoredType,
    min: _ignoredMin,
    max: _ignoredMax,
    step: _ignoredStep,
    ...safeRestProps
  } = restProps;

  const describedBy =
    safeRestProps['aria-describedby'] ||
    (error ? errorId : hint ? hintId : undefined);

  const formattedFromProp = formatMoneyInputDisplay(value, { allowNegative });
  const displayValue =
    allowNegative && transientMinus && !formattedFromProp ? '-' : formattedFromProp;

  useLayoutEffect(() => {
    if (pendingCaretRef.current !== null && inputRef.current) {
      const pos = pendingCaretRef.current;
      pendingCaretRef.current = null;
      try {
        inputRef.current.setSelectionRange(pos, pos);
      } catch {
        // Bỏ qua nếu trình duyệt không hỗ trợ setSelectionRange ở thời điểm blur
      }
    }
  });

  const emitRawChange = (rawValue) => {
    const syntheticEvent = {
      target: { value: rawValue, name, id: fieldId },
      currentTarget: { value: rawValue, name, id: fieldId },
    };
    onChange?.(syntheticEvent);
    onValueChange?.(rawValue);
  };

  const handleChange = (e) => {
    const { value: domText, selectionStart } = e.target;
    const parsed = parseMoneyUserEdit(domText, selectionStart, { allowNegative });
    pendingCaretRef.current = parsed.nextCaretIndex;
    setTransientMinus(parsed.isTransientMinus);
    emitRawChange(parsed.rawValue);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const el = e.currentTarget;
      const sepResult = handleMoneySeparatorKey(
        el.value,
        el.selectionStart,
        el.selectionEnd,
        e.key,
        { allowNegative }
      );
      if (sepResult.handled) {
        e.preventDefault();
        pendingCaretRef.current = sepResult.nextCaretIndex;
        setTransientMinus(sepResult.isTransientMinus);
        emitRawChange(sepResult.rawValue);
        return;
      }
    }
    onKeyDown?.(e);
  };

  const handleBlur = (e) => {
    if (transientMinus) {
      setTransientMinus(false);
    }
    onBlur?.(e);
  };

  const baseInputCls = `w-full rounded-lg border bg-white text-base sm:text-sm font-mono tabular-nums text-slate-800 placeholder:font-sans placeholder:text-slate-400 transition-colors focus:outline-none focus:ring-2 ${
    error
      ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/20'
      : 'border-slate-200 hover:border-slate-300 focus:border-primary-500 focus:ring-primary-500/20'
  } disabled:bg-slate-50 disabled:text-slate-400`;

  return (
    <div className={`space-y-1.5 ${containerClassName}`}>
      {label ? (
        <label htmlFor={fieldId} className="block text-xs font-medium text-slate-700">
          {label}
          {required ? <span className="text-rose-500 ml-0.5">*</span> : null}
        </label>
      ) : null}
      <div className="relative">
        {Icon ? (
          <Icon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        ) : null}
        <input
          ref={inputRef}
          id={fieldId}
          name={name}
          type="text"
          inputMode={allowNegative ? 'text' : 'numeric'}
          autoComplete="off"
          disabled={disabled}
          required={required}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          placeholder={placeholder}
          value={displayValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          className={`${baseInputCls} min-h-[44px] sm:min-h-0 sm:h-9 ${
            Icon ? 'pl-9' : 'pl-3'
          } ${rightElement ? 'pr-9' : 'pr-3'} ${className}`}
          {...safeRestProps}
        />
        {rightElement ? (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center">
            {rightElement}
          </div>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export default MoneyInput;
