import React, { useState, useMemo } from 'react';
import { ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Table, THead, TBody, TH, TD } from '../ui/Table';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from './EmptyState';

const TEXT_ALIGN_RE = /\btext-(left|center|right)\b/g;

function resolveColAlign(col) {
  if (col.align === 'left' || col.align === 'center' || col.align === 'right') {
    return col.align;
  }
  const combined = `${col.headerClassName || ''} ${col.className || ''}`;
  if (/\btext-center\b/.test(combined)) return 'center';
  if (/\btext-right\b/.test(combined)) return 'right';
  if (col.key === 'actions' || col.key === 'action' || col.key === 'status') return 'center';
  return 'left';
}

function stripTextAlign(cls = '') {
  return cls.replace(TEXT_ALIGN_RE, '').replace(/\s+/g, ' ').trim();
}

export function DataTable({
  columns = [],
  data = [],
  rowKey = 'id',
  loading = false,
  pageSize = 12,
  emptyTitle = 'Chưa có dữ liệu',
  emptyDescription = 'Không tìm thấy bản ghi nào khớp với bộ lọc hiện tại.',
  emptyAction,
  onRowClick,
  embedded = false,
}) {
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(1);

  const sortedData = useMemo(() => {
    if (!sortCol) return data;
    const colDef = columns.find((c) => c.key === sortCol);
    return [...data].sort((a, b) => {
      const va = colDef?.sortValue ? colDef.sortValue(a) : a[sortCol];
      const vb = colDef?.sortValue ? colDef.sortValue(b) : b[sortCol];
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const cmp =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), 'vi');
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, sortCol, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(sortedData.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedData = sortedData.slice((safePage - 1) * pageSize, safePage * pageSize);

  const handleSort = (key, sortable) => {
    if (!sortable) return;
    if (sortCol === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(key);
      setSortDir('asc');
    }
  };

  const containerClass = embedded
    ? 'w-full min-w-0 border-t border-slate-100 overflow-hidden'
    : 'w-full min-w-0 bg-white rounded-xl border border-slate-200/80 shadow-card overflow-hidden';

  if (loading) {
    return (
      <div className={`${containerClass} p-5 space-y-3`}>
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className={containerClass}>
        <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
      </div>
    );
  }

  return (
    <div className={containerClass}>
      <Table>
        <THead>
          <tr>
            {columns.map((col) => {
              const align = resolveColAlign(col);
              const alignTextCls =
                align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
              const alignFlex =
                align === 'right'
                  ? 'justify-end'
                  : align === 'center'
                  ? 'justify-center'
                  : 'justify-start';
              const isActionCol = col.key === 'actions' || col.key === 'action';
              const combinedCls = `${col.headerClassName || ''} ${col.className || ''}`;
              const actionFitCls =
                isActionCol && !/\bw-\S+/.test(combinedCls) ? 'w-px whitespace-nowrap' : '';
              const cleanHdrCls = stripTextAlign(col.headerClassName || '');
              const isSorted = sortCol === col.key;

              return (
                <TH
                  key={col.key}
                  onClick={() => handleSort(col.key, col.sortable)}
                  className={`${
                    col.sortable ? 'cursor-pointer select-none hover:text-slate-900 transition-colors' : ''
                  } ${alignTextCls} ${actionFitCls} ${cleanHdrCls}`.trim()}
                >
                  <div className={`flex items-center gap-1 whitespace-nowrap ${alignFlex}`}>
                    <span>{col.label}</span>
                    {col.sortable ? (
                      <ArrowUpDown
                        className={`w-3.5 h-3.5 shrink-0 ${
                          isSorted ? 'text-primary-600 opacity-100' : 'text-slate-400 opacity-65'
                        }`}
                      />
                    ) : null}
                  </div>
                </TH>
              );
            })}
          </tr>
        </THead>
        <TBody>
          {pagedData.map((row, idx) => (
            <tr
              key={typeof rowKey === 'function' ? rowKey(row) : row[rowKey] || idx}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`transition-colors hover:bg-slate-50/70 ${onRowClick ? 'cursor-pointer' : ''}`}
            >
              {columns.map((col) => {
                const align = resolveColAlign(col);
                const alignTextCls =
                  align === 'right'
                    ? 'text-right'
                    : align === 'center'
                    ? 'text-center'
                    : 'text-left';
                const isActionCol = col.key === 'actions' || col.key === 'action';
                const combinedCls = `${col.headerClassName || ''} ${col.className || ''}`;
                const actionFitCls =
                  isActionCol && !/\bw-\S+/.test(combinedCls) ? 'min-w-[88px]' : '';
                const cleanCellCls = stripTextAlign(col.className || '');

                return (
                  <TD
                    key={col.key}
                    className={`${alignTextCls} ${actionFitCls} ${cleanCellCls}`.trim()}
                  >
                    {col.render ? col.render(row) : row[col.key] ?? '—'}
                  </TD>
                );
              })}
            </tr>
          ))}
        </TBody>
      </Table>

      {sortedData.length > pageSize ? (
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between gap-2 text-xs text-slate-500">
          <span className="whitespace-nowrap">
            Hiển thị {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, sortedData.length)} /{' '}
            {sortedData.length} bản ghi
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-2 font-medium text-slate-700 whitespace-nowrap">
              Trang {safePage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default DataTable;
