import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';

export function PageHeader({ title, subtitle, breadcrumbs = [], backTo, showBack, actions }) {
  const navigate = useNavigate();

  const fallbackBackTo =
    backTo ||
    [...breadcrumbs]
      .reverse()
      .find((bc) => Boolean(bc?.to))?.to ||
    null;

  const shouldShowBack = showBack !== undefined ? Boolean(showBack) : Boolean(fallbackBackTo);

  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.state && window.history.state.idx > 0) {
      navigate(-1);
    } else if (fallbackBackTo) {
      navigate(fallbackBackTo);
    } else {
      navigate('/admin/dashboard');
    }
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 no-print">
      <div className="min-w-0">
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

        <div className="flex items-start sm:items-center gap-3">
          {shouldShowBack ? (
            <button
              type="button"
              onClick={handleBack}
              title="Quay lại trang trước"
              aria-label="Quay lại trang trước"
              className="mt-0.5 sm:mt-0 w-9 h-9 rounded-xl border border-slate-200 bg-white text-slate-600 hover:text-primary-600 hover:border-primary-300 hover:bg-primary-50/60 shadow-xs flex items-center justify-center shrink-0 transition-all"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          ) : null}
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight">{title}</h1>
            {subtitle ? <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p> : null}
          </div>
        </div>
      </div>

      {actions ? <div className="flex items-center gap-2.5 flex-wrap shrink-0">{actions}</div> : null}
    </div>
  );
}

export default PageHeader;
