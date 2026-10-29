import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Sparkles,
  Users,
  ArrowLeft,
  Plus,
  Check,
  X,
  Ban,
  Clock,
  CheckCircle2,
  Calculator,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { SearchBar } from '../../../components/common/SearchBar';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { servicesService } from '../../../services/services.service';
import { buildingsService } from '../../../services/buildings.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney, formatDate, toInputDate } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

function estimateProrata(unitPrice, quantity, dateStr, mode = 'subscribe') {
  const dt = dateStr ? new Date(dateStr) : new Date();
  if (Number.isNaN(dt.getTime())) return 0;
  const year = dt.getFullYear();
  const month = dt.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const day = dt.getDate();
  const activeDays = mode === 'cancel' ? day : Math.max(1, daysInMonth - day + 1);
  return {
    amount: Math.round((Number(unitPrice || 0) * Number(quantity || 1) * activeDays) / daysInMonth),
    activeDays,
    daysInMonth,
  };
}

const STATUS_FILTER_PILLS = [
  { value: '', label: 'Tất cả đăng ký' },
  { value: 'PENDING_APPROVAL', label: 'Chờ phê duyệt' },
  { value: 'ACTIVE', label: 'Đang sử dụng' },
  { value: 'CANCELLATION_PENDING', label: 'Chờ hủy' },
  { value: 'CANCELLED', label: 'Đã hủy' },
];

export function SubscriptionsPage() {
  const toast = useToast();
  const { canManageServices } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [subscriptions, setSubscriptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');

  // Modal gán dịch vụ mới cho căn hộ
  const [assignOpen, setAssignOpen] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const [apartments, setApartments] = useState([]);
  const [assigning, setAssigning] = useState(false);
  const [assignForm, setAssignForm] = useState({
    apartment_id: '',
    service_id: '',
    quantity: 1,
    start_date: toInputDate(new Date()),
    note: '',
  });

  // Modal xác nhận hủy kèm tính phí Pro-rata
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelEndDate, setCancelEndDate] = useState(toInputDate(new Date()));
  const [cancelNote, setCancelNote] = useState('');
  const [submittingAction, setSubmittingAction] = useState(false);

  // Confirm từ chối đăng ký
  const [rejectTarget, setRejectTarget] = useState(null);

  const fetchSubscriptions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await servicesService.listSubscriptions({
        building_id: selectedBuildingId || undefined,
        status: statusFilter || undefined,
      });
      setSubscriptions(res.data || []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách đăng ký dịch vụ.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, statusFilter, toast]);

  useEffect(() => {
    fetchSubscriptions();
  }, [fetchSubscriptions]);

  const filteredData = useMemo(() => {
    if (!search.trim()) return subscriptions;
    const q = search.trim().toLowerCase();
    return subscriptions.filter(
      (s) =>
        s.apartment_code?.toLowerCase().includes(q) ||
        s.building_code?.toLowerCase().includes(q) ||
        s.service_name?.toLowerCase().includes(q) ||
        s.service_code?.toLowerCase().includes(q) ||
        s.tenant_name?.toLowerCase().includes(q)
    );
  }, [subscriptions, search]);

  const stats = useMemo(() => {
    const pendingApprove = subscriptions.filter((s) => s.status === 'PENDING_APPROVAL').length;
    const pendingCancel = subscriptions.filter((s) => s.status === 'CANCELLATION_PENDING').length;
    const active = subscriptions.filter((s) => s.status === 'ACTIVE').length;
    const monthlyValue = subscriptions
      .filter((s) => s.status === 'ACTIVE')
      .reduce((sum, s) => sum + Number(s.unit_price || 0) * Number(s.quantity || 1), 0);
    return { pendingApprove, pendingCancel, active, monthlyValue };
  }, [subscriptions]);

  const openAssignModal = async () => {
    setAssignForm({
      apartment_id: '',
      service_id: '',
      quantity: 1,
      start_date: toInputDate(new Date()),
      note: '',
    });
    setAssignOpen(true);
    try {
      const [catRes, aptRes] = await Promise.all([
        servicesService.listCatalog({ active_only: 'true' }),
        buildingsService.listApartments({ building_id: selectedBuildingId || undefined }),
      ]);
      setCatalog((catRes.data || []).filter((c) => c.billing_type !== 'METERED'));
      setApartments(aptRes.data || []);
    } catch {
      setCatalog([]);
      setApartments([]);
    }
  };

  const selectedAssignService = useMemo(
    () => catalog.find((c) => c.id === assignForm.service_id) || null,
    [catalog, assignForm.service_id]
  );

  const assignProrataPreview = useMemo(() => {
    if (!selectedAssignService) return null;
    return estimateProrata(
      selectedAssignService.unit_price,
      assignForm.quantity,
      assignForm.start_date,
      'subscribe'
    );
  }, [selectedAssignService, assignForm.quantity, assignForm.start_date]);

  const handleAssignSubmit = async (e) => {
    e.preventDefault();
    if (!assignForm.apartment_id || !assignForm.service_id) {
      toast.warning('Vui lòng chọn căn hộ và dịch vụ cần gán.');
      return;
    }
    setAssigning(true);
    try {
      const res = await servicesService.createSubscription({
        apartment_id: assignForm.apartment_id,
        service_id: assignForm.service_id,
        quantity: Math.max(1, Number(assignForm.quantity) || 1),
        start_date: assignForm.start_date,
        note: assignForm.note.trim() || null,
      });
      toast.success(res.message || 'Đã gán dịch vụ cho căn hộ thành công.');
      setAssignOpen(false);
      fetchSubscriptions();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gán dịch vụ cho căn hộ.'));
    } finally {
      setAssigning(false);
    }
  };

  const handleApprove = async (sub) => {
    setSubmittingAction(true);
    try {
      const res = await servicesService.updateSubscription(sub.id, { status: 'ACTIVE' });
      toast.success(res.message || `Đã phê duyệt dịch vụ "${sub.service_name}".`);
      fetchSubscriptions();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể phê duyệt đăng ký dịch vụ.'));
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleConfirmReject = async () => {
    if (!rejectTarget) return;
    setSubmittingAction(true);
    try {
      const res = await servicesService.updateSubscription(rejectTarget.id, {
        status: 'REJECTED',
      });
      toast.success(res.message || 'Đã từ chối yêu cầu đăng ký dịch vụ.');
      setRejectTarget(null);
      fetchSubscriptions();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể từ chối đăng ký.'));
    } finally {
      setSubmittingAction(false);
    }
  };

  const openCancelModal = (sub) => {
    setCancelTarget(sub);
    setCancelEndDate(sub.end_date ? toInputDate(sub.end_date) : toInputDate(new Date()));
    setCancelNote(sub.note || '');
  };

  const cancelProrataPreview = useMemo(() => {
    if (!cancelTarget) return null;
    return estimateProrata(
      cancelTarget.unit_price,
      cancelTarget.quantity,
      cancelEndDate,
      'cancel'
    );
  }, [cancelTarget, cancelEndDate]);

  const handleConfirmCancel = async () => {
    if (!cancelTarget) return;
    setSubmittingAction(true);
    try {
      const res = await servicesService.updateSubscription(cancelTarget.id, {
        status: 'CANCELLED',
        end_date: cancelEndDate,
        note: cancelNote.trim() || null,
      });
      toast.success(res.message || 'Đã xác nhận hủy dịch vụ và chốt phí Pro-rata.');
      setCancelTarget(null);
      fetchSubscriptions();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể hủy đăng ký dịch vụ.'));
    } finally {
      setSubmittingAction(false);
    }
  };

  const columns = useMemo(
    () => [
      {
        key: 'apartment_code',
        label: 'Căn hộ / Cư dân',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-semibold text-slate-900">
              Căn {row.apartment_code}{' '}
              <span className="text-xs font-normal text-slate-500">({row.building_code})</span>
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              {row.tenant_name || 'Chưa gắn khách thuê'}
              {row.tenant_phone ? ` • ${row.tenant_phone}` : ''}
            </p>
          </div>
        ),
      },
      {
        key: 'service_name',
        label: 'Dịch vụ đăng ký',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-medium text-slate-900">{row.service_name}</p>
            <span className="font-mono text-[11px] text-slate-500">{row.service_code}</span>
          </div>
        ),
      },
      {
        key: 'quantity',
        label: 'SL × Đơn giá',
        align: 'right',
        className: 'font-mono tabular-nums whitespace-nowrap',
        render: (row) => (
          <div>
            <p className="font-medium text-slate-800">
              {row.quantity} × {formatMoney(row.unit_price)}
            </p>
            <p className="text-xs font-sans text-slate-400">Đơn vị: {row.unit}</p>
          </div>
        ),
      },
      {
        key: 'prorata_amount',
        label: 'Phí tháng / Pro-rata',
        align: 'right',
        sortable: true,
        className: 'font-mono tabular-nums whitespace-nowrap',
        render: (row) => {
          const fullAmt = Number(row.unit_price || 0) * Number(row.quantity || 1);
          const proAmt = Number(row.prorata_amount || 0);
          return (
            <div>
              <p className="font-semibold text-slate-900">{formatMoney(fullAmt)}/kỳ</p>
              {proAmt > 0 ? (
                <Badge variant="indigo" className="mt-1">
                  <Calculator className="w-3 h-3" />
                  Pro-rata: {formatMoney(proAmt)}
                </Badge>
              ) : null}
            </div>
          );
        },
      },
      {
        key: 'start_date',
        label: 'Hiệu lực',
        align: 'center',
        sortable: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <div className="text-xs">
            <p className="text-slate-700 font-medium">Từ: {formatDate(row.start_date)}</p>
            {row.end_date ? (
              <p className="text-rose-600 mt-0.5">Đến: {formatDate(row.end_date)}</p>
            ) : (
              <p className="text-slate-400 mt-0.5">Đang duy trì hàng kỳ</p>
            )}
          </div>
        ),
      },
      {
        key: 'status',
        label: 'Trạng thái',
        align: 'center',
        sortable: true,
        render: (row) => (
          <div className="inline-flex flex-col items-center">
            <StatusBadge status={row.status} domain="subscription" />
            {row.note ? (
              <p className="text-[11px] text-slate-500 mt-1 max-w-[180px] truncate" title={row.note}>
                {row.note}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        key: 'actions',
        label: 'Thao tác',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => {
          if (!canManageServices) return <span className="text-xs text-slate-400">—</span>;

          if (row.status === 'PENDING_APPROVAL') {
            return (
              <div className="inline-flex items-center justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                <Button
                  size="xs"
                  variant="success"
                  icon={Check}
                  disabled={submittingAction}
                  onClick={() => handleApprove(row)}
                >
                  Phê duyệt
                </Button>
                <Button
                  size="xs"
                  variant="danger"
                  icon={X}
                  disabled={submittingAction}
                  onClick={() => setRejectTarget(row)}
                >
                  Từ chối
                </Button>
              </div>
            );
          }

          if (row.status === 'CANCELLATION_PENDING') {
            return (
              <Button
                size="xs"
                variant="warning"
                icon={Ban}
                onClick={(e) => {
                  e.stopPropagation();
                  openCancelModal(row);
                }}
              >
                Xác nhận hủy
              </Button>
            );
          }

          if (row.status === 'ACTIVE') {
            return (
              <Button
                size="xs"
                variant="outline"
                icon={Ban}
                onClick={(e) => {
                  e.stopPropagation();
                  openCancelModal(row);
                }}
              >
                Hủy dịch vụ
              </Button>
            );
          }

          return <span className="text-xs text-slate-400">—</span>;
        },
      },
    ],
    [canManageServices, submittingAction]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Dịch vụ & Tiện ích', to: '/admin/services' },
          { label: 'Đăng ký dịch vụ' },
        ]}
        title="Quản lý Đăng ký Dịch vụ Căn hộ"
        subtitle="Phê duyệt yêu cầu đăng ký/hủy tiện ích của cư dân và tự động tính phí Pro-rata theo ngày thực tế."
        actions={
          <>
            <Link to="/admin/services">
              <Button variant="outline" icon={ArrowLeft}>
                Danh mục dịch vụ
              </Button>
            </Link>
            {canManageServices ? (
              <Button variant="primary" icon={Plus} onClick={openAssignModal}>
                Gán dịch vụ cho căn hộ
              </Button>
            ) : null}
          </>
        }
      />

      {/* Thanh chuyển đổi chế độ M07 */}
      <div className="flex items-center gap-1 border-b border-slate-200">
        <Link
          to="/admin/services"
          className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300 -mb-px transition-colors"
        >
          <Sparkles className="w-4 h-4" />
          <span>Bảng giá & Danh mục</span>
        </Link>
        <Link
          to="/admin/services/subscriptions"
          className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 border-primary-500 text-primary-600 -mb-px"
        >
          <Users className="w-4 h-4" />
          <span>Đăng ký dịch vụ căn hộ ({filteredData.length})</span>
        </Link>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Chờ phê duyệt mới"
          value={stats.pendingApprove}
          subtext="Yêu cầu từ cổng cư dân"
          icon={Clock}
          color="amber"
        />
        <StatsCard
          title="Chờ xác nhận hủy"
          value={stats.pendingCancel}
          subtext="Cần chốt ngày ngưng & Pro-rata"
          icon={Ban}
          color="rose"
        />
        <StatsCard
          title="Đang hoạt động"
          value={stats.active}
          subtext="Tự động cộng vào hóa đơn kỳ"
          icon={CheckCircle2}
          color="emerald"
        />
        <StatsCard
          title="Doanh thu dịch vụ / kỳ"
          value={formatMoney(stats.monthlyValue)}
          subtext="Ước tính từ các gói đang mở"
          icon={Sparkles}
          color="indigo"
        />
      </div>

      {/* Bộ lọc trạng thái & Tìm kiếm */}
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {STATUS_FILTER_PILLS.map((pill) => {
              const active = statusFilter === pill.value;
              return (
                <button
                  key={pill.value}
                  type="button"
                  onClick={() => setStatusFilter(pill.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    active
                      ? 'bg-primary-500 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {pill.label}
                </button>
              );
            })}
          </div>

          <div className="w-full sm:w-80">
            <SearchBar
              value={search}
              onChange={setSearch}
              placeholder="Tìm căn hộ, cư dân, tên dịch vụ..."
            />
          </div>
        </div>
      </Card>

      {/* Bảng dữ liệu */}
      <DataTable
        columns={columns}
        data={filteredData}
        loading={loading}
        emptyTitle="Chưa có đăng ký dịch vụ nào"
        emptyDescription="Không tìm thấy gói đăng ký dịch vụ nào khớp với bộ lọc hiện tại."
      />

      {/* Modal Gán dịch vụ mới cho căn hộ */}
      <Modal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title="Gán dịch vụ mới cho căn hộ"
        subtitle="Đăng ký trực tiếp dịch vụ tiện ích cho căn hộ đang thuê và tự động tính phí Pro-rata kỳ đầu."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setAssignOpen(false)} disabled={assigning}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleAssignSubmit} loading={assigning}>
              Xác nhận gán dịch vụ
            </Button>
          </>
        }
      >
        <form onSubmit={handleAssignSubmit} className="space-y-4">
          <Select
            label="Chọn căn hộ"
            required
            value={assignForm.apartment_id}
            onChange={(e) => setAssignForm((s) => ({ ...s, apartment_id: e.target.value }))}
            placeholder="-- Chọn căn hộ áp dụng --"
            options={apartments.map((a) => ({
              value: a.id,
              label: `${a.building_code ? `${a.building_code} - ` : ''}Căn ${a.code} (${
                a.status === 'OCCUPIED' ? 'Đang thuê' : a.status
              })`,
            }))}
          />

          <Select
            label="Dịch vụ tiện ích"
            required
            value={assignForm.service_id}
            onChange={(e) => setAssignForm((s) => ({ ...s, service_id: e.target.value }))}
            placeholder="-- Chọn dịch vụ --"
            options={catalog.map((c) => ({
              value: c.id,
              label: `${c.name} (${formatMoney(c.unit_price)} / ${c.unit})`,
            }))}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Số lượng đăng ký"
              type="number"
              min="1"
              required
              value={assignForm.quantity}
              onChange={(e) => setAssignForm((s) => ({ ...s, quantity: e.target.value }))}
            />
            <Input
              label="Ngày bắt đầu tính phí"
              type="date"
              required
              value={assignForm.start_date}
              onChange={(e) => setAssignForm((s) => ({ ...s, start_date: e.target.value }))}
            />
          </div>

          {selectedAssignService && assignProrataPreview ? (
            <div className="p-4 rounded-xl bg-indigo-50/70 border border-indigo-200 space-y-1.5 text-xs">
              <div className="flex items-center justify-between font-semibold text-indigo-900">
                <span className="inline-flex items-center gap-1.5">
                  <Calculator className="w-4 h-4 text-indigo-600" />
                  Tạm tính phí Pro-rata kỳ đầu tiên
                </span>
                <span className="text-base font-bold text-indigo-700">
                  {formatMoney(assignProrataPreview.amount)}
                </span>
              </div>
              <p className="text-indigo-700/80">
                Tính trên <strong>{assignProrataPreview.activeDays}</strong> /{' '}
                {assignProrataPreview.daysInMonth} ngày còn lại trong tháng (Phí chuẩn trọn kỳ:{' '}
                {formatMoney(
                  Number(selectedAssignService.unit_price) * Number(assignForm.quantity || 1)
                )}
                ).
              </p>
            </div>
          ) : null}

          <Input
            label="Ghi chú (biển số xe, mã thẻ từ, yêu cầu khung giờ vệ sinh...)"
            multiline
            rows={2}
            placeholder="VD: Xe máy Honda SH biển số 59A3-123.45..."
            value={assignForm.note}
            onChange={(e) => setAssignForm((s) => ({ ...s, note: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal Xác nhận hủy & Chốt Pro-rata */}
      <Modal
        open={Boolean(cancelTarget)}
        onClose={() => setCancelTarget(null)}
        title="Xác nhận hủy dịch vụ & Tính phí Pro-rata"
        subtitle={
          cancelTarget
            ? `Căn ${cancelTarget.apartment_code} • Dịch vụ: ${cancelTarget.service_name}`
            : ''
        }
        size="md"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setCancelTarget(null)}
              disabled={submittingAction}
            >
              Đóng
            </Button>
            <Button
              variant="danger"
              onClick={handleConfirmCancel}
              loading={submittingAction}
            >
              Xác nhận hủy dịch vụ
            </Button>
          </>
        }
      >
        {cancelTarget ? (
          <div className="space-y-4">
            <Input
              label="Ngày kết thúc sử dụng thực tế"
              type="date"
              required
              value={cancelEndDate}
              onChange={(e) => setCancelEndDate(e.target.value)}
            />

            {cancelProrataPreview ? (
              <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 space-y-1.5 text-xs">
                <div className="flex items-center justify-between font-semibold text-amber-900">
                  <span className="inline-flex items-center gap-1.5">
                    <Calculator className="w-4 h-4 text-amber-600" />
                    Phí Pro-rata tháng hủy dự kiến
                  </span>
                  <span className="text-base font-bold text-amber-700">
                    {formatMoney(cancelProrataPreview.amount)}
                  </span>
                </div>
                <p className="text-amber-800/80">
                  Tính cho <strong>{cancelProrataPreview.activeDays}</strong> /{' '}
                  {cancelProrataPreview.daysInMonth} ngày sử dụng trong tháng kết thúc (Gói{' '}
                  {cancelTarget.quantity} × {formatMoney(cancelTarget.unit_price)}).
                </p>
              </div>
            ) : null}

            <Input
              label="Ghi chú xác nhận hủy"
              multiline
              rows={2}
              placeholder="Ghi chú thu hồi thẻ gửi xe / ngắt kết nối dịch vụ..."
              value={cancelNote}
              onChange={(e) => setCancelNote(e.target.value)}
            />
          </div>
        ) : null}
      </Modal>

      {/* Confirm từ chối đăng ký */}
      <ConfirmDialog
        open={Boolean(rejectTarget)}
        onClose={() => setRejectTarget(null)}
        onConfirm={handleConfirmReject}
        loading={submittingAction}
        title="Từ chối yêu cầu đăng ký dịch vụ"
        message={
          rejectTarget
            ? `Bạn có chắc chắn muốn từ chối yêu cầu đăng ký dịch vụ "${rejectTarget.service_name}" của Căn ${rejectTarget.apartment_code}?`
            : ''
        }
        confirmLabel="Từ chối yêu cầu"
      />
    </div>
  );
}

export default SubscriptionsPage;
