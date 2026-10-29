import React from 'react';
import { Search, X } from 'lucide-react';

export function SearchBar({ value, onChange, placeholder = 'Tìm kiếm...', className = '' }) {
  return (
    <div className={`relative ${className}`}>
      <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        className="w-full h-9 pl-9 pr-8 rounded-lg border border-slate-200 bg-white text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange?.('')}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export default SearchBar;

