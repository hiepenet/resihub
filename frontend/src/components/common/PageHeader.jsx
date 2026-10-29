import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

export function PageHeader({ title, subtitle, breadcrumbs = [], actions }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 no-print">
      <div>
        {breadcrumbs.length > 0 ? (
          <nav className="flex items-center gap-1.5 text-xs text-slate-500 mb-1.5 flex-wrap">
            {breadcrumbs.map((bc, idx) => (
              <React.Fragment key={idx}>
                {idx > 0 ? <ChevronRight className="w-3.5 h-3.5 text-slate-400" /> : null}
                {bc.to ? (
                  <Link to={bc.to} className="hover:text-primary-600 transition-colors font-medium">
                    {bc.label}
                  </Link>
                ) : (
                  <span className="text-slate-700 font-medium">{bc.label}</span>
                )}
              </React.Fragment>
            ))}
          </nav>
        ) : null}
        <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight">{title}</h1>
        {subtitle ? <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2.5 flex-wrap shrink-0">{actions}</div> : null}
    </div>
  );
}

export default PageHeader;

