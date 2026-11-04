import React, { useId, useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, Check, X } from 'lucide-react';

function normalizeVnSearch(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

export function Select({
  label,
  options = [],
  placeholder,
  value,
  onChange,
  onValueChange,
  error,
  hint,
  required = false,
  disabled = false,
  name,
  id,
  size = 'md',
  icon: LeftIcon,
  searchable,
  searchPlaceholder,
  emptyText = 'Không tìm thấy mục phù hợp',
  className = '',
  containerClassName = '',
  'aria-label': ariaLabel,
}) {
  const generatedId = useId();
  const fieldId = id || generatedId;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 240, placeAbove: false });

  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const searchInputRef = useRef(null);

  const normalizedOptions = useMemo(() => {
    const list = [];
    if (placeholder !== undefined) {
      list.push({
        value: '',
        label: placeholder,
        sublabel: '',
        badge: '',
        logo: '',
        searchText: placeholder,
        isPlaceholder: true,
        disabled: false,
      });
    }
    for (const opt of options) {
      if (opt === null || opt === undefined) continue;
      if (typeof opt === 'object') {
        const val = opt.value ?? '';
        const lbl = opt.label ?? String(val);
        list.push({
          value: val,
          label: lbl,
          sublabel: opt.sublabel || '',
          badge: opt.badge || '',
          logo: opt.logo || '',
          disabled: Boolean(opt.disabled),
          isPlaceholder: false,
          raw: opt,
          searchBlob: normalizeVnSearch(
            `${lbl} ${opt.sublabel || ''} ${opt.badge || ''} ${opt.searchText || ''} ${val}`
          ),
        });
      } else {
        list.push({
          value: opt,
          label: String(opt),
          sublabel: '',
          badge: '',
          logo: '',
          disabled: false,
          isPlaceholder: false,
          raw: opt,
          searchBlob: normalizeVnSearch(String(opt)),
        });
      }
    }
    return list.map((item) => ({
      ...item,
      searchBlob: item.searchBlob ?? normalizeVnSearch(`${item.label} ${item.value}`),
    }));
  }, [options, placeholder]);

  const currentValStr = value === undefined || value === null ? '' : String(value);

  const selectedOption = useMemo(
    () => normalizedOptions.find((o) => String(o.value) === currentValStr) || null,
    [normalizedOptions, currentValStr]
  );

  const showSearch =
    searchable !== undefined
      ? Boolean(searchable)
      : normalizedOptions.length > 5 || Boolean(searchPlaceholder);

  const effectiveSearchPlaceholder = searchPlaceholder || 'Nhập từ khóa để lọc nhanh...';

  const filteredOptions = useMemo(() => {
    const q = normalizeVnSearch(query);
    if (!q) return normalizedOptions;
    return normalizedOptions.filter((o) => o.searchBlob.includes(q));
  }, [normalizedOptions, query]);

  const hasRichOptions = useMemo(
    () => normalizedOptions.some((o) => Boolean(o.logo || o.sublabel)),
    [normalizedOptions]
  );

  const longestPrimaryLen = useMemo(
    () =>
      normalizedOptions.reduce(
        (maxLen, o) =>
          Math.max(
            maxLen,
            String(o.label || '').length + (o.badge ? String(o.badge).length + 4 : 0)
          ),
        0
      ),
    [normalizedOptions]
  );

  const longestSubLen = useMemo(
    () =>
      normalizedOptions.reduce(
        (maxLen, o) => Math.max(maxLen, String(o.sublabel || '').length),
        0
      ),
    [normalizedOptions]
  );

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove = spaceBelow < 260 && rect.top > 280;
    const estimatedWidth = Math.min(
      560,
      Math.max(
        220,
        Math.ceil(longestPrimaryLen * 8.4) + (hasRichOptions ? 96 : 64),
        Math.ceil(longestSubLen * 7.2) + 96
      )
    );
    const desiredWidth = Math.min(
      window.innerWidth - 16,
      Math.max(rect.width, estimatedWidth)
    );
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - desiredWidth - 8));
    setCoords({
      top: placeAbove ? rect.top - 6 : rect.bottom + 6,
      left,
      width: desiredWidth,
      placeAbove,
    });
  }, [hasRichOptions, longestPrimaryLen, longestSubLen]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    updatePosition();
    setQuery('');
    const activeIndex = normalizedOptions.findIndex((o) => String(o.value) === currentValStr);
    setHighlightIdx(activeIndex >= 0 ? activeIndex : 0);
    setOpen(true);
  }, [disabled, updatePosition, normalizedOptions, currentValStr]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const isCoarsePointer =
      typeof window !== 'undefined' &&
      Boolean(window.matchMedia?.('(pointer: coarse)').matches);
    const focusTimer =
      isCoarsePointer || !showSearch
        ? null
        : requestAnimationFrame(() => {
            searchInputRef.current?.focus();
          });

    const handleOutside = (e) => {
      if (
        triggerRef.current?.contains(e.target) ||
        menuRef.current?.contains(e.target)
      ) {
        return;
      }
      closeMenu();
    };

    const handleReposition = () => updatePosition();

    document.addEventListener('mousedown', handleOutside);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      if (focusTimer !== null) cancelAnimationFrame(focusTimer);
      document.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [open, showSearch, closeMenu, updatePosition]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [query]);

  const commitSelection = (opt) => {
    if (!opt || opt.disabled) return;
    const nextVal = opt.value;
    const syntheticEvent = {
      target: { value: nextVal, name, id: fieldId },
      currentTarget: { value: nextVal, name, id: fieldId },
    };
    onChange?.(syntheticEvent);
    onValueChange?.(nextVal, opt.raw ?? opt);
    closeMenu();
    triggerRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((prev) =>
        filteredOptions.length > 0 ? (prev + 1) % filteredOptions.length : 0
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((prev) =>
        filteredOptions.length > 0
          ? (prev - 1 + filteredOptions.length) % filteredOptions.length
          : 0
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filteredOptions[highlightIdx];
      if (target) commitSelection(target);
    }
  };

  const sizeClasses =
    size === 'sm'
      ? 'min-h-[44px] sm:min-h-0 sm:h-8 py-1.5 sm:py-0 pl-2.5 pr-8 text-base sm:text-xs rounded-lg'
      : 'min-h-[44px] sm:min-h-0 sm:h-9 py-2 sm:py-0 pl-3 pr-8 text-base sm:text-sm rounded-lg';

  const displayLabel = selectedOption
    ? selectedOption.label
    : placeholder !== undefined
    ? placeholder
    : 'Chọn...';

  const isMutedPlaceholder =
    (!selectedOption && currentValStr === '') ||
    Boolean(selectedOption?.isPlaceholder && currentValStr === '' && label);

  return (
    <div className={label || error || hint ? `space-y-1.5 ${containerClassName}` : containerClassName}>
      {label ? (
        <label htmlFor={fieldId} className="block text-xs font-medium text-slate-700">
          {label}
          {required ? <span className="text-rose-500 ml-0.5">*</span> : null}
        </label>
      ) : null}

      <div className="relative">
        {name ? <input type="hidden" name={name} value={currentValStr} /> : null}
        <button
          ref={triggerRef}
          id={fieldId}
          type="button"
          disabled={disabled}
          title={displayLabel ? String(displayLabel) : undefined}
          aria-label={ariaLabel || label || placeholder || 'Chọn mục'}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => (open ? closeMenu() : openMenu())}
          onKeyDown={handleKeyDown}
          className={`w-full ${sizeClasses} border bg-white text-left flex items-center gap-2 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all focus:outline-none focus:ring-2 ${
            error
              ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/20'
              : open
              ? 'border-primary-500 ring-2 ring-primary-500/20'
              : 'border-slate-200 hover:border-slate-300 focus:border-primary-500 focus:ring-primary-500/20'
          } disabled:bg-slate-50 disabled:text-slate-400 disabled:shadow-none disabled:cursor-not-allowed ${className}`}
        >
          {selectedOption?.logo ? (
            <img
              src={selectedOption.logo}
              alt=""
              className="w-6 h-4 object-contain rounded bg-white border border-slate-100 shrink-0"
            />
          ) : LeftIcon ? (
            <LeftIcon className="w-4 h-4 text-primary-500 shrink-0" />
          ) : null}

          <span
            title={displayLabel ? String(displayLabel) : undefined}
            className={`block flex-1 min-w-0 truncate whitespace-nowrap leading-normal ${
              isMutedPlaceholder ? 'text-slate-500 font-normal' : 'text-slate-800 font-medium'
            }`}
          >
            {displayLabel}
          </span>

          {selectedOption?.badge && !selectedOption?.logo ? (
            <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-semibold text-slate-600 shrink-0">
              {selectedOption.badge}
            </span>
          ) : null}

          <ChevronDown
            className={`w-4 h-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none transition-transform duration-150 ${
              open ? 'rotate-180 text-primary-500' : ''
            }`}
          />
        </button>
      </div>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              style={{
                position: 'fixed',
                top: coords.placeAbove ? undefined : `${coords.top}px`,
                bottom: coords.placeAbove ? `${window.innerHeight - coords.top}px` : undefined,
                left: `${coords.left}px`,
                width: `${coords.width}px`,
                zIndex: 9999,
              }}
              className="bg-white rounded-xl border border-slate-200/90 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-100"
            >
              {/* Ô input lọc dữ liệu nhanh */}
              {showSearch ? (
                <div className="p-2 border-b border-slate-100 bg-slate-50/70">
                  <div className="relative flex items-center">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 pointer-events-none" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={effectiveSearchPlaceholder}
                      aria-label="Lọc danh sách tùy chọn"
                      className="w-full min-h-[40px] sm:min-h-0 sm:h-8 pl-8 pr-7 rounded-lg border border-slate-200 bg-white text-base sm:text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
                    />
                    {query ? (
                      <button
                        type="button"
                        onClick={() => {
                          setQuery('');
                          searchInputRef.current?.focus();
                        }}
                        aria-label="Xóa từ khóa lọc"
                        className="min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 p-1 inline-flex items-center justify-center text-slate-400 hover:text-slate-600 absolute right-1"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {/* Danh sách kết quả */}
              <ul
                role="listbox"
                className="max-h-64 overflow-y-auto p-1 space-y-0.5"
              >
                {filteredOptions.length === 0 ? (
                  <li className="px-3 py-4 text-center text-xs text-slate-400">{emptyText}</li>
                ) : (
                  filteredOptions.map((opt, idx) => {
                    const isSelected = String(opt.value) === currentValStr;
                    const isHighlighted = idx === highlightIdx;
                    const optionTooltip = opt.sublabel
                      ? `${opt.label} — ${opt.sublabel}`
                      : String(opt.label || '');
                    return (
                      <li
                        key={`${String(opt.value)}_${idx}`}
                        role="option"
                        title={optionTooltip || undefined}
                        data-option-value={String(opt.value)}
                        aria-selected={isSelected}
                        onMouseEnter={() => setHighlightIdx(idx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          commitSelection(opt);
                        }}
                        className={`min-h-[44px] sm:min-h-0 rounded-lg px-2.5 py-2 text-xs sm:text-sm flex items-center justify-between gap-2.5 cursor-pointer select-none transition-colors ${
                          opt.disabled
                            ? 'opacity-45 cursor-not-allowed'
                            : isSelected
                            ? 'bg-primary-50 text-primary-800 font-semibold'
                            : isHighlighted
                            ? 'bg-slate-100/90 text-slate-900'
                            : 'text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          {opt.logo ? (
                            <img
                              src={opt.logo}
                              alt=""
                              className="w-8 h-5 object-contain rounded bg-white border border-slate-200/80 p-0.5 shrink-0"
                            />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="truncate whitespace-nowrap leading-snug">
                                {opt.label}
                              </span>
                              {opt.badge ? (
                                <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-mono font-semibold text-slate-600 shrink-0">
                                  {opt.badge}
                                </span>
                              ) : null}
                            </div>
                            {opt.sublabel ? (
                              <p className="text-[11px] text-slate-500 font-normal truncate whitespace-nowrap leading-snug mt-0.5">
                                {opt.sublabel}
                              </p>
                            ) : null}
                          </div>
                        </div>
                        {isSelected ? (
                          <Check className="w-4 h-4 text-primary-600 shrink-0" />
                        ) : null}
                      </li>
                    );
                  })
                )}
              </ul>
            </div>,
            document.body
          )
        : null}

      {error ? (
        <p className="text-xs text-rose-600">{error}</p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export default Select;
