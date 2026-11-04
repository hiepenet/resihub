import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
import {
  ServiceSubscriptionMetaFields,
  VehiclePlatesBadges,
} from '../../../components/common/ServiceSubscriptionMetaFields';
import { servicesService } from '../../../services/services.service';
import {
  MAX_PARKING_QUANTITY,
  isParkingService,
  syncVehiclePlatesArray,
  validateServiceMetaInput,
} from '../../../utils/serviceSubscriptionMeta';
import { buildingsService } from '../../../services/buildings.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney, formatDate, toInputDate } from '../../../utils/format';
import { formatDateVi, getDateOrderError, maxDateStr, toDateOnlyStr } from '../../../utils/dateRange';
import { extractErrorMessage } from '../../../utils/validation';
import { previewSubscriptionProrata } from '../../../utils/billing';
import { stripNotificationTriggerParams } from '../../../utils/notificationNavigation';

function estimateProrata(unitPrice, quantity, dateStr, mode = 'subscribe') {
  if (mode === 'cancel') {
    return previewSubscriptionProrata({ unitPrice, quantity, endDate: dateStr });
  }
  return previewSubscriptionProrata({ unitPrice, quantity, startDate: dateStr });
}

const STATUS_FILTER_PILLS = [
  { value: '', label: 'Tất cả đăng ký' },
  { value: 'PENDING_APPROVAL', label: 'Chờ phê duyệt' },
  { value: 'ACTIVE', label: 'Đang sử dụng' },
  { value: 'CANCELLATION_PENDING', label: 'Chờ hủy' },
  { value: 'TERMINATED', label: 'Đã chấm dứt' },
  { value: 'CANCELLED', label: 'Đã hủy' },
  { value: 'REJECTED', label: 'Đã từ chối' },
];

export function SubscriptionsPage() {
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
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
    vehicle_plates: [''],
    note: '',
  });
  const [assignErrors, setAssignErrors] = useState({
    plateErrors: [],
    quantityError: '',
    noteError: '',
  });

  // Modal xác nhận hủy kèm tính phí Pro-rata
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelEndDate, setCancelEndDate] = useState(toInputDate(new Date()));
  const [cancelNote, setCancelNote] = useState('');
  const [cancelZeroUsage, setCancelZeroUsage] = useState(false);
  const [submittingAction, setSubmittingAction] = useState(false);

  // Confirm từ chối đăng ký & Modal chi tiết/duyệt đăng ký từ thông báo
  const [rejectTarget, setRejectTarget] = useState(null);
  const [reviewSubscription, setReviewSubscription] = useState(null);

  const fetchSubscriptions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await servicesService.listSubscriptions({
        building_id: selectedBuildingId || undefined,
      });
      setSubscriptions(res.data || []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách đăng ký dịch vụ.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, toast]);

  useEffect(() => {
    fetchSubscriptions();
  }, [fetchSubscriptions]);

  const filteredData = useMemo(() => {
    const q = search.trim().toLowerCase();
    return subscriptions.filter((s) => {
      if (statusFilter && s.status !== statusFilter) return false;
      if (!q) return true;
      return (
        s.apartment_code?.toLowerCase().includes(q) ||
        s.building_code?.toLowerCase().includes(q) ||
        s.service_name?.toLowerCase().includes(q) ||
        s.service_code?.toLowerCase().includes(q) ||
        s.tenant_name?.toLowerCase().includes(q) ||
        (Array.isArray(s.vehicle_plates) &&
          s.vehicle_plates.join(' ').toLowerCase().includes(q)) ||
        s.note?.toLowerCase().includes(q)
      );
    });
  }, [subscriptions, statusFilter, search]);

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
      vehicle_plates: [''],
      note: '',
    });
    setAssignErrors({ plateErrors: [], quantityError: '', noteError: '' });
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
  const isAssignParking = isParkingService(selectedAssignService);

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
    const effQty =
      selectedAssignService?.billing_type === 'FIXED' && !isAssignParking
        ? 1
        : assignForm.quantity;
    const meta = validateServiceMetaInput({
      isParking: isAssignParking,
      quantity: effQty,
      vehiclePlates: assignForm.vehicle_plates,
      note: assignForm.note,
    });
    setAssignErrors(meta);
    if (!meta.valid) {
      toast.warning(meta.quantityError || meta.plateErrors.find(Boolean) || meta.noteError);
      return;
    }
    setAssigning(true);
    try {
      const res = await servicesService.createSubscription({
        apartment_id: assignForm.apartment_id,
        service_id: assignForm.service_id,
        quantity:
          selectedAssignService?.billing_type === 'FIXED' && !isAssignParking
            ? 1
            : Math.max(1, Number(assignForm.quantity) || 1),
        start_date: assignForm.start_date,
        ...(isAssignParking ? { vehicle_plates: meta.cleanPlates } : {}),
        note: meta.cleanNote || null,
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
    const subStart = toDateOnlyStr(sub?.start_date);
    const initialEnd = sub?.end_date
      ? toInputDate(sub.end_date)
      : maxDateStr(toInputDate(new Date()), subStart);
    setCancelEndDate(initialEnd);
    setCancelNote(sub.note || '');
    setCancelZeroUsage(false);
  };

  useEffect(() => {
    const subId = searchParams.get('subscription_id');
    if (!subId || loading) return;
    setSearchParams((prev) => stripNotificationTriggerParams(prev), { replace: true });
    setStatusFilter('');
    const matched = subscriptions.find((s) => String(s.id) === String(subId));
    if (!matched) return;
    if (matched.status === 'CANCELLATION_PENDING' && canManageServices) {
      openCancelModal(matched);
    } else {
      setReviewSubscription(matched);
    }
  }, [searchParams, setSearchParams, loading, subscriptions, canManageServices]);

  const cancelStartDateStr = toDateOnlyStr(cancelTarget?.start_date);
  const cancelEndDateError = cancelTarget
    ? getDateOrderError(cancelStartDateStr, cancelEndDate, {
        strictAfter: false,
        startLabel: cancelStartDateStr
          ? `Ngày bắt đầu đăng ký (${formatDateVi(cancelStartDateStr)})`
          : 'Ngày bắt đầu đăng ký',
        endLabel: 'Ngày kết thúc sử dụng',
      })
    : '';

  const cancelProrataPreview = useMemo(() => {
    if (!cancelTarget || cancelEndDateError) return null;
    return previewSubscriptionProrata({
      unitPrice: cancelTarget.unit_price,
      quantity: cancelTarget.quantity,
      startDate: cancelTarget.start_date,
      endDate: cancelEndDate,
      zeroUsage: cancelZeroUsage,
    });
  }, [cancelTarget, cancelEndDate, cancelEndDateError, cancelZeroUsage]);

  const handleConfirmCancel = async () => {
    if (!cancelTarget) return;
    if (cancelEndDateError) {
      toast.warning(cancelEndDateError);
      return;
    }
    setSubmittingAction(true);
    try {
      const res = await servicesService.updateSubscription(cancelTarget.id, {
        status: 'TERMINATED',
        end_date: cancelEndDate,
        zero_usage: cancelZeroUsage,
        cancel_reason: cancelNote.trim() || undefined,
        note: cancelNote.trim() || null,
      });

      const sync = res.invoice_sync;
      let syncMsg = res.message || 'Đã xác nhận chấm dứt dịch vụ và chốt phí Pro-rata.';
      if (sync) {
        if (sync.scenario === 1 || sync.status === 'NO_INVOICE' || sync.scenario === 'NO_INVOICE') {
          syncMsg += ' (Kỳ hiện tại chưa có hóa đơn, phí sẽ không phát sinh).';
        } else if (sync.scenario === 2 || sync.status === 'UPDATED_DRAFT' || sync.scenario === 'UPDATED_DRAFT') {
          syncMsg += ' (Đã cập nhật tự động lại hóa đơn DRAFT kỳ này).';
        } else if (sync.scenario === 3 || sync.status === 'ADJUSTMENT_CREATED' || sync.scenario === 'ADJUSTMENT_CREATED') {
          syncMsg += ' (Hóa đơn đã phát hành: Đã tạo đề nghị điều chỉnh hóa đơn chờ duyệt 4 mắt).';
        }
      }
      toast.success(syncMsg);
      setCancelTarget(null);
      fetchSubscriptions();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể chấm dứt đăng ký dịch vụ.'));
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleKeepService = async (sub) => {
    setSubmittingAction(true);
    try {
      const res = await servicesService.updateSubscription(sub.id, {
        status: 'ACTIVE',
        note: 'Giữ lại dịch vụ tiếp tục sử dụng',
      });
      toast.success(res.message || 'Đã giữ lại dịch vụ, tiếp tục duy trì hoạt động.');
      fetchSubscriptions();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể giữ lại dịch vụ.'));
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
            <VehiclePlatesBadges plates={row.vehicle_plates} className="mt-1" />
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
              <p
                className="text-[11px] text-slate-600 mt-1 max-w-[220px] whitespace-pre-line break-words text-center"
                title={row.note}
              >
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
              <div className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                <Button
                  size="xs"
                  variant="outline"
                  icon={Check}
                  loading={submittingAction}
                  onClick={() => handleKeepService(row)}
                >
                  Giữ lại dịch vụ
                </Button>
                <Button
                  size="xs"
                  variant="warning"
                  icon={Ban}
                  onClick={() => openCancelModal(row)}
                >
                  Xác nhận hủy
                </Button>
              </div>
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
              placeholder="Tìm căn hộ, cư dân, biển số xe, dịch vụ..."
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
            onChange={(e) => {
              const nextServiceId = e.target.value;
              const nextSvc = catalog.find((c) => c.id === nextServiceId);
              const nextParking = isParkingService(nextSvc);
              setAssignForm((s) => {
                const nextQty =
                  nextSvc?.billing_type === 'FIXED' && !nextParking
                    ? 1
                    : nextParking
                    ? Math.min(MAX_PARKING_QUANTITY, Math.max(1, Number(s.quantity) || 1))
                    : s.quantity;
                return {
                  ...s,
                  service_id: nextServiceId,
                  quantity: nextQty,
                  vehicle_plates: nextParking
                    ? syncVehiclePlatesArray(s.vehicle_plates, nextQty)
                    : [''],
                };
              });
              setAssignErrors({ plateErrors: [], quantityError: '', noteError: '' });
            }}
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
              max={isAssignParking ? MAX_PARKING_QUANTITY : undefined}
              disabled={selectedAssignService?.billing_type === 'FIXED' && !isAssignParking}
              error={assignErrors.quantityError}
              required
              value={assignForm.quantity}
              onChange={(e) => {
                const nextQty = e.target.value;
                setAssignForm((s) => ({
                  ...s,
                  quantity: nextQty,
                  vehicle_plates: isAssignParking
                    ? syncVehiclePlatesArray(s.vehicle_plates, nextQty)
                    : s.vehicle_plates,
                }));
                setAssignErrors((prev) => ({ ...prev, quantityError: '', plateErrors: [] }));
              }}
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

          <ServiceSubscriptionMetaFields
            isParking={isAssignParking}
            quantity={assignForm.quantity}
            vehiclePlates={assignForm.vehicle_plates}
            note={assignForm.note}
            plateErrors={assignErrors.plateErrors}
            noteError={assignErrors.noteError}
            noteMultiline
            noteRows={2}
            onPlateChange={(plateIdx, val) => {
              setAssignForm((s) => {
                const nextPlates = syncVehiclePlatesArray(s.vehicle_plates, s.quantity);
                nextPlates[plateIdx] = val;
                return { ...s, vehicle_plates: nextPlates };
              });
              setAssignErrors((prev) => ({ ...prev, plateErrors: [] }));
            }}
            onNoteChange={(val) => {
              setAssignForm((s) => ({ ...s, note: val }));
              setAssignErrors((prev) => ({ ...prev, noteError: '' }));
            }}
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
              disabled={Boolean(cancelEndDateError)}
            >
              Xác nhận hủy dịch vụ
            </Button>
          </>
        }
      >
        {cancelTarget ? (
          <div className="space-y-4">
            <VehiclePlatesBadges plates={cancelTarget.vehicle_plates} />
            <Input
              label="Ngày kết thúc sử dụng thực tế"
              type="date"
              required
              min={cancelStartDateStr || undefined}
              error={cancelEndDateError}
              value={cancelEndDate}
              onChange={(e) => setCancelEndDate(e.target.value)}
            />

            <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-slate-700 select-none">
              <input
                type="checkbox"
                checked={cancelZeroUsage}
                onChange={(e) => setCancelZeroUsage(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
              />
              <span>Miễn phí hoàn toàn (zero_usage: 0 ₫ do chưa từng sử dụng thực tế)</span>
            </label>

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

      {/* Modal xem chi tiết / phê duyệt yêu cầu dịch vụ từ thông báo */}
      <Modal
        open={Boolean(reviewSubscription)}
        onClose={() => setReviewSubscription(null)}
        title="Chi tiết Đăng ký Dịch vụ Căn hộ"
        subtitle={
          reviewSubscription
            ? `Căn ${reviewSubscription.apartment_code || '—'} (${reviewSubscription.building_code || '—'}) • ${reviewSubscription.service_name || 'Dịch vụ'}`
            : ''
        }
        size="md"
        footer={
          reviewSubscription ? (
            <>
              <Button
                variant="outline"
                onClick={() => setReviewSubscription(null)}
                disabled={submittingAction}
              >
                Đóng
              </Button>
              {canManageServices && reviewSubscription.status === 'PENDING_APPROVAL' ? (
                <>
                  <Button
                    variant="danger"
                    icon={X}
                    disabled={submittingAction}
                    onClick={() => {
                      const target = reviewSubscription;
                      setReviewSubscription(null);
                      setRejectTarget(target);
                    }}
                  >
                    Từ chối
                  </Button>
                  <Button
                    variant="success"
                    icon={Check}
                    loading={submittingAction}
                    onClick={async () => {
                      const target = reviewSubscription;
                      await handleApprove(target);
                      setReviewSubscription(null);
                    }}
                  >
                    Phê duyệt đăng ký
                  </Button>
                </>
              ) : canManageServices && reviewSubscription.status === 'CANCELLATION_PENDING' ? (
                <>
                  <Button
                    variant="outline"
                    icon={Check}
                    loading={submittingAction}
                    onClick={async () => {
                      const target = reviewSubscription;
                      await handleKeepService(target);
                      setReviewSubscription(null);
                    }}
                  >
                    Giữ lại dịch vụ
                  </Button>
                  <Button
                    variant="warning"
                    icon={Ban}
                    onClick={() => {
                      const target = reviewSubscription;
                      setReviewSubscription(null);
                      openCancelModal(target);
                    }}
                  >
                    Xác nhận hủy & Pro-rata
                  </Button>
                </>
              ) : null}
            </>
          ) : null
        }
      >
        {reviewSubscription ? (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200">
              <div>
                <p className="text-slate-500">Trạng thái gói</p>
                <div className="mt-1">
                  <StatusBadge status={reviewSubscription.status} domain="service_subscription" />
                </div>
              </div>
              <div>
                <p className="text-slate-500">Khách thuê</p>
                <p className="font-semibold text-slate-900 mt-1">
                  {reviewSubscription.tenant_name || '—'}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Số lượng × Đơn giá</p>
                <p className="font-mono font-semibold text-slate-900 mt-0.5">
                  {reviewSubscription.quantity || 1} × {formatMoney(reviewSubscription.unit_price)}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Ngày bắt đầu / kết thúc</p>
                <p className="font-medium text-slate-800 mt-0.5">
                  {formatDate(reviewSubscription.start_date)}
                  {reviewSubscription.end_date ? ` → ${formatDate(reviewSubscription.end_date)}` : ''}
                </p>
              </div>
            </div>

            <VehiclePlatesBadges plates={reviewSubscription.vehicle_plates} />

            {reviewSubscription.note ? (
              <div className="p-3 rounded-xl bg-white border border-slate-200 space-y-1">
                <p className="font-semibold text-slate-700">Ghi chú đăng ký</p>
                <p className="text-slate-600 whitespace-pre-line">{reviewSubscription.note}</p>
              </div>
            ) : null}
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
