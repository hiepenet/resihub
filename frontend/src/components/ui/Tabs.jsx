import React from 'react';

export function Tabs({ tabs = [], activeTab, onChange, className = '' }) {
  return (
    <div
      role="tablist"
      className={`flex items-center gap-1 border-b border-slate-200 overflow-x-auto no-scrollbar ${className}`}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange?.(tab.id)}
            className={`inline-flex items-center gap-2 px-3.5 sm:px-4 py-2.5 min-h-[44px] sm:min-h-0 text-sm font-medium border-b-2 transition-colors whitespace-nowrap -mb-px ${
              isActive
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300'
            }`}
          >
            {Icon ? <Icon className="w-4 h-4 shrink-0" /> : null}
            <span>{tab.label}</span>
            {tab.count !== undefined && tab.count !== null ? (
              <span
                className={`px-1.5 py-0.5 text-[11px] rounded-full font-semibold ${
                  isActive ? 'bg-primary-100 text-primary-700' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export default Tabs;
