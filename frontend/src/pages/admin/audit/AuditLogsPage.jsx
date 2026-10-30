import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ScrollText,
  RefreshCw,
  Eye,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  ShieldAlert,
  RotateCcw,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { PageHeader } from '../../../components/common/PageHeader';
import { DataTable } from '../../../components/common/DataTable';
import { SearchBar } from '../../../components/common/SearchBar';
import { auditService } from '../../../services/audit.service';
import { useToast } from '../../../hooks/useToast';
import { formatDateTime } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

const ENTITY_OPTIONS = [
  { value: 'contract', label: 'Hợp đồng (contract)' },
  { value: 'deposit', label: 'Tiền đặt cọc (deposit)' },
  { value: 'deposit_transaction', label: 'Giao dịch cọc (deposit_transaction)' },
  { value: 'invoice', label: 'Hóa đơn (invoice)' },
  { value: 'payment', label: 'Thanh toán (payment)' },
  { value: 'apartment', label: 'Căn hộ (apartment)' },
  { value: 'building', label: 'Tòa nhà (building)' },
  { value: 'reservation', label: 'Giữ chỗ (reservation)' },
  { value: 'tenant', label: 'Cư dân (tenant)' },
  { value: 'user_account', label: 'Tài khoản (user_account)' },
  { value: 'system_setting', label: 'Cấu hình hệ thống (system_setting)' },
];

const ACTION_OPTIONS = [
  { value: 'ACCESS_DENIED', label: 'Từ chối truy cập (ACCESS_DENIED)' },
  { value: 'SELF_APPROVAL_WARNING', label: 'Cảnh báo tự duyệt (SELF_APPROVAL_WARNING)' },
  { value: 'CREATE', label: 'Tạo mới (CREATE)' },
  { value: 'UPDATE', label: 'Cập nhật (UPDATE)' },
  { value: 'DELETE', label: 'Xóa (DELETE)' },
  { value: 'APPROVE', label: 'Phê duyệt (APPROVE)' },
  { value: 'REJECT', label: 'Từ chối (REJECT)' },
  { value: 'ACTIVATE', label: 'Kích hoạt (ACTIVATE)' },
  { value: 'TERMINATE', label: 'Thanh lý (TERMINATE)' },
  { value: 'DISPUTE', label: 'Khiếu nại / Tranh chấp (DISPUTE)' },
  { value: 'RESOLVE_DISPUTE', label: 'Giải quyết khiếu nại (RESOLVE_DISPUTE)' },
];

function getActionBadgeVariant(action) {
  const upper = String(action || '').toUpperCase();
  if (upper === 'ACCESS_DENIED' || upper.includes('DENIED')) return 'red';
  if (upper === 'SELF_APPROVAL_WARNING' || upper.includes('SELF_APPROVAL') || upper.includes('WARNING')) {
    return 'amber';
  }
  if (upper.includes('CREATE') || upper.includes('APPROVE') || upper.includes('ACTIVATE')) {
    return 'emerald';
  }
  if (
    upper.includes('DELETE') ||
    upper.includes('REJECT') ||
    upper.includes('CANCEL') ||
    upper.includes('FORFEIT')
  ) {
    return 'red';
  }
  if (upper.includes('UPDATE') || upper.includes('SETTLE') || upper.includes('RESOLVE')) {
    return 'sky';
  }
  return 'slate';
}

function formatJsonBlock(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'string') {
    try {
      return JSON.stringify(JSON.parse(val), null, 2);
    } catch {
      return val;
    }
  }
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

export function AuditLogsView() {
  const toast = useToast();

  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [search, setSearch] = useState('');
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [selectedLog, setSelectedLog] = useState(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        page,
        limit,
        ...(entity ? { entity } : {}),
        ...(action ? { action } : {}),
        ...(fromDate ? { from: fromDate } : {}),
        ...(toDate ? { to: toDate } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      };
      const res = await auditService.list(params);
      const rawItems = Array.isArray(res?.data)
        ? res.data
        : Array.isArray(res?.data?.items)
        ? res.data.items
        : Array.isArray(res?.items)
        ? res.items
        : [];
      const meta = res?.pagination || res?.meta || res?.data?.pagination || {};
      const resolvedTotal = Number(meta.total ?? res?.total ?? res?.data?.total ?? rawItems.length);
      const resolvedTotalPages = Math.max(
        1,
        Number(meta.totalPages ?? meta.total_pages ?? (Math.ceil(resolvedTotal / limit) || 1))
      );

      setLogs(rawItems);
      setTotal(resolvedTotal);
      setTotalPages(resolvedTotalPages);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải nhật ký kiểm toán hệ thống.'));
    } finally {
      setLoading(false);
    }
  }, [page, limit, entity, action, fromDate, toDate, search, toast]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchLogs();
    }, 200);
    return () => clearTimeout(timer);
  }, [fetchLogs]);

  const handleResetFilters = () => {
    setSearch('');
    setEntity('');
    setAction('');
    setFromDate('');
    setToDate('');
    setPage(1);
  };

  const columns = useMemo(
    () => [
      {
        key: 'created_at',
        label: 'Thời gian',
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="text-xs font-mono text-slate-700">
            {formatDateTime(row.created_at)}
          </span>
        ),
      },
      {
        key: 'actor',
        label: 'Người thực hiện',
        render: (row) => {
          const name = row.actor_name || row.actor_full_name || row.user_name || 'Hệ thống';
          const email = row.actor_email || row.user_email || '';
          return (
            <div className="text-xs">
              <p className="font-semibold text-slate-900">{name}</p>
              {email ? (
                <p className="text-slate-500">{email}</p>
              ) : row.actor_id ? (
                <p className="font-mono text-[10px] text-slate-400">
                  ID: {String(row.actor_id).slice(0, 8)}
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        key: 'action',
        label: 'Hành động',
        align: 'center',
        render: (row) => {
          const act = String(row.action || '—');
          const upper = act.toUpperCase();
          const isAccessDenied = upper === 'ACCESS_DENIED' || upper.includes('DENIED');
          const isSelfApproval =
            upper === 'SELF_APPROVAL_WARNING' || upper.includes('SELF_APPROVAL');
          return (
            <div className="inline-flex items-center gap-1">
              {isAccessDenied ? (
                <ShieldAlert className="w-3.5 h-3.5 text-rose-600 shrink-0" />
              ) : isSelfApproval ? (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              ) : null}
              <Badge variant={getActionBadgeVariant(act)} dot>
                {act}
              </Badge>
            </div>
          );
        },
      },
      {
        key: 'entity',
        label: 'Phân hệ / Đối tượng',
        render: (row) => {
          const ent = row.entity || row.entity_type || row.table_name || '—';
          return (
            <span className="text-xs font-mono font-semibold text-slate-700 bg-slate-100 px-2 py-0.5 rounded">
              {ent}
            </span>
          );
        },
      },
      {
        key: 'entity_id',
        label: 'Mã bản ghi',
        render: (row) => {
          const eid = row.entity_id || row.record_id || row.target_id;
          return eid ? (
            <span className="text-xs font-mono text-slate-600" title={String(eid)}>
              {String(eid).length > 14 ? `${String(eid).slice(0, 8)}…${String(eid).slice(-4)}` : String(eid)}
            </span>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          );
        },
      },
      {
        key: 'actions',
        label: 'Chi tiết',
        align: 'center',
        render: (row) => (
          <Button
            variant="ghost"
            size="xs"
            icon={Eye}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedLog(row);
            }}
          >
            Xem JSON
          </Button>
        ),
      },
    ],
    []
  );

  const beforePayload =
    selectedLog?.before ?? selectedLog?.before_data ?? selectedLog?.old_data ?? null;
  const afterPayload =
    selectedLog?.after ??
    selectedLog?.after_data ??
    selectedLog?.new_data ??
    selectedLog?.details ??
    selectedLog?.metadata ??
    null;

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <div className="sm:col-span-2">
            <SearchBar
              value={search}
              onChange={(val) => {
                setSearch(val);
                setPage(1);
              }}
              placeholder="Tìm theo người thực hiện, email, mã bản ghi, hành động..."
            />
          </div>

          <Select
            value={entity}
            onChange={(e) => {
              setEntity(e.target.value);
              setPage(1);
            }}
            placeholder="Tất cả đối tượng"
            options={ENTITY_OPTIONS}
          />

          <Select
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
            placeholder="Tất cả hành động"
            options={ACTION_OPTIONS}
          />

          <Input
            type="date"
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value);
              setPage(1);
            }}
            title="Từ ngày"
          />

          <Input
            type="date"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value);
              setPage(1);
            }}
            title="Đến ngày"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs text-slate-500">
          <span>
            Tổng cộng <strong className="text-slate-800">{total}</strong> bản ghi nhật ký kiểm toán
          </span>
          <div className="flex items-center gap-2">
            {(search || entity || action || fromDate || toDate) ? (
              <Button variant="ghost" size="xs" icon={RotateCcw} onClick={handleResetFilters}>
                Xóa bộ lọc
              </Button>
            ) : null}
            <Button variant="outline" size="xs" icon={RefreshCw} onClick={fetchLogs}>
              Làm mới
            </Button>
          </div>
        </div>
      </Card>

      <DataTable
        columns={columns}
        data={logs}
        loading={loading}
        pageSize={limit}
        onRowClick={(row) => setSelectedLog(row)}
        emptyTitle="Chưa có bản ghi nhật ký hệ thống"
        emptyDescription="Không tìm thấy sự kiện kiểm toán nào khớp với bộ lọc hiện tại."
      />

      {/* Server-side Pagination */}
      {totalPages > 1 || total > limit ? (
        <Card className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
          <div className="flex items-center gap-2">
            <span>
              Trang <strong className="text-slate-900">{page}</strong> /{' '}
              <strong className="text-slate-900">{totalPages}</strong> ({total} dòng)
            </span>
            <select
              value={limit}
              onChange={(e) => {
                setLimit(Number(e.target.value));
                setPage(1);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
            >
              <option value={20}>20 / trang</option>
              <option value={50}>50 / trang</option>
              <option value={100}>100 / trang</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="xs"
              icon={ChevronLeft}
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Trước
            </Button>
            <Button
              variant="outline"
              size="xs"
              rightIcon={ChevronRight}
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Sau
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Modal chi tiết JSON before / after */}
      <Modal
        open={Boolean(selectedLog)}
        onClose={() => setSelectedLog(null)}
        title="Chi tiết bản ghi Nhật ký Kiểm toán (Audit Log)"
        subtitle={
          selectedLog
            ? `${selectedLog.action || ''} • ${selectedLog.entity || selectedLog.entity_type || ''} • ${formatDateTime(
                selectedLog.created_at
              )}`
            : ''
        }
        size="xl"
        footer={
          <Button variant="outline" onClick={() => setSelectedLog(null)}>
            Đóng
          </Button>
        }
      >
        {selectedLog ? (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200">
              <div>
                <p className="text-slate-500">Người thực hiện</p>
                <p className="font-semibold text-slate-900 mt-0.5">
                  {selectedLog.actor_name || selectedLog.actor_full_name || 'Hệ thống'}
                </p>
                {selectedLog.actor_email ? (
                  <p className="text-slate-500">{selectedLog.actor_email}</p>
                ) : null}
              </div>
              <div>
                <p className="text-slate-500">Hành động</p>
                <div className="mt-1">
                  <Badge variant={getActionBadgeVariant(selectedLog.action)} dot>
                    {selectedLog.action}
                  </Badge>
                </div>
              </div>
              <div>
                <p className="text-slate-500">Đối tượng &amp; Mã bản ghi</p>
                <p className="font-mono font-semibold text-slate-900 mt-0.5 break-all">
                  {selectedLog.entity || selectedLog.entity_type || '—'} /{' '}
                  {selectedLog.entity_id || selectedLog.record_id || '—'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <p className="font-semibold text-slate-700">Dữ liệu trước thay đổi (Before)</p>
                <pre className="p-3.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto max-h-96 leading-relaxed">
                  {formatJsonBlock(beforePayload)}
                </pre>
              </div>
              <div className="space-y-1.5">
                <p className="font-semibold text-slate-700">Dữ liệu sau thay đổi / Chi tiết (After)</p>
                <pre className="p-3.5 rounded-xl bg-slate-900 text-emerald-200 font-mono text-[11px] overflow-x-auto max-h-96 leading-relaxed">
                  {formatJsonBlock(afterPayload)}
                </pre>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export function AuditLogsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Nhật ký Kiểm toán Hệ thống (Audit Logs)"
        subtitle="Truy vết bất biến toàn bộ thao tác nghiệp vụ, cảnh báo tự phê duyệt (SELF_APPROVAL_WARNING) và truy cập bị từ chối (ACCESS_DENIED)."
      />
      <AuditLogsView />
    </div>
  );
}

export default AuditLogsPage;
