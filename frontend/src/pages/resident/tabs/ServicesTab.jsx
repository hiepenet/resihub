import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Sparkles,
  Plus,
  XCircle,
  Calculator,
  Calendar,
  Car,
  Wifi,
  Brush,
  Dumbbell,
  Shield,
  Package,
  Info,
  CheckCircle2,
  Zap,
  Droplets,
  Building2,
} from 'lucide-react';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Skeleton } from '../../../components/ui/Skeleton';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { EmptyState } from '../../../components/common/EmptyState';
import {
  ServiceSubscriptionMetaFields,
  VehiclePlatesBadges,
} from '../../../components/common/ServiceSubscriptionMetaFields';
import { residentService } from '../../../services/resident.service';
import {
  MAX_PARKING_QUANTITY,
  isParkingService,
  syncVehiclePlatesArray,
  validateServiceMetaInput,
} from '../../../utils/serviceSubscriptionMeta';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate, toInputDate } from '../../../utils/format';
import { formatDateVi, getDateOrderError, maxDateStr, toDateOnlyStr } from '../../../utils/dateRange';
import { extractErrorMessage } from '../../../utils/validation';
import { previewSubscriptionProrata } from '../../../utils/billing';

const CATEGORY_META = {
  PARKING: { label: 'Gửi xe & Bãi đỗ', icon: Car, color: 'bg-sky-50 text-sky-600' },
  INTERNET: { label: 'Internet & Truyền hình', icon: Wifi, color: 'bg-indigo-50 text-indigo-600' },
  CLEANING: { label: 'Vệ sinh & Giặt ủi', icon: Brush, color: 'bg-emerald-50 text-emerald-600' },
  AMENITY: { label: 'Tiện ích nội khu', icon: Dumbbell, color: 'bg-purple-50 text-purple-600' },
  SECURITY: { label: 'Thẻ từ & An ninh', icon: Shield, color: 'bg-amber-50 text-amber-600' },
  UTILITY: { label: 'Điện / Nước / Năng lượng', icon: Sparkles, color: 'bg-sky-50 text-sky-600' },
  ELECTRICITY: { label: 'Điện sinh hoạt', icon: Zap, color: 'bg-amber-50 text-amber-600' },
  WATER: { label: 'Nước sinh hoạt', icon: Droplets, color: 'bg-sky-50 text-sky-600' },
  MANAGEMENT: { label: 'Phí quản lý vận hành', icon: Building2, color: 'bg-indigo-50 text-indigo-600' },
  OTHER: { label: 'Dịch vụ khác', icon: Package, color: 'bg-slate-100 text-slate-600' },
};

/**
 * Tính ước tính phí Pro-rata khớp công thức hệ thống (previewSubscriptionProrata)
 */
function calculateProrataDetails(unitPrice, quantity, targetDateStr, mode = 'subscribe', startDate = null) {
  if (mode === 'cancel') {
    const preview = previewSubscriptionProrata({
      unitPrice,
      quantity,
      startDate: startDate || undefined,
      endDate: targetDateStr,
    });
    return {
      daysInMonth: preview.daysInMonth,
      activeDays: preview.activeDays,
      fullMonthAmount: Math.round(Number(unitPrice || 0) * Math.max(1, Number(quantity || 1))),
      prorataAmount: preview.amount,
      amount: preview.amount,
    };
  }
  const preview = previewSubscriptionProrata({
    unitPrice,
    quantity,
    startDate: targetDateStr,
  });
  return {
    daysInMonth: preview.daysInMonth,
    activeDays: preview.activeDays,
    fullMonthAmount: Math.round(Number(unitPrice || 0) * Math.max(1, Number(quantity || 1))),
    prorataAmount: preview.amount,
    amount: preview.amount,
  };
}

export function ServicesTab({ overview, actionParam, onClearActionParam }) {
  const toast = useToast();
  const contract = overview?.active_contract || overview?.contract || null;
  const hasActiveContract = ['ACTIVE', 'RENEWAL_PENDING'].includes(contract?.contract_status);

  const [catalog, setCatalog] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCancelledHistory, setShowCancelledHistory] = useState(false);

  // Subscribe Modal
  const [subModalOpen, setSubModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [subForm, setSubForm] = useState({
    service_id: '',
    quantity: 1,
    start_date: toInputDate(new Date()),
    vehicle_plates: [''],
    note: '',
  });
  const [subErrors, setSubErrors] = useState({
    plateErrors: [],
    quantityError: '',
    noteError: '',
  });

  // Cancel Service Modal
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState(null);
  const [cancelForm, setCancelForm] = useState({
    end_date: toInputDate(new Date()),
    note: '',
  });

  const loadServices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await residentService.listServices(contract?.contract_id);
      setCatalog(res?.data?.catalog || []);
      setSubscriptions(res?.data?.subscriptions || []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải thông tin dịch vụ tiện ích.'));
    } finally {
      setLoading(false);
    }
  }, [contract?.contract_id, toast]);

  useEffect(() => {
    loadServices();
  }, [loadServices]);

  const minSubscribeDate = maxDateStr(
    toInputDate(new Date()),
    toDateOnlyStr(contract?.start_date)
  );
  const maxSubscribeDate = toDateOnlyStr(contract?.end_date);

  const openSubscribeModal = useCallback(
    (serviceId = '') => {
      if (!hasActiveContract) {
        toast.warning('Bạn cần có hợp đồng thuê đang hiệu lực (ACTIVE) để đăng ký dịch vụ mới.');
        return;
      }
      const selectable = catalog.filter((s) => s.billing_type !== 'METERED');
      setSubForm({
        service_id: serviceId || selectable[0]?.id || catalog[0]?.id || '',
        quantity: 1,
        start_date: minSubscribeDate || toInputDate(new Date()),
        vehicle_plates: [''],
        note: '',
      });
      setSubErrors({ plateErrors: [], quantityError: '', noteError: '' });
      setSubModalOpen(true);
    },
    [catalog, hasActiveContract, minSubscribeDate, toast]
  );

  useEffect(() => {
    if (!loading && actionParam === 'subscribe') {
      if (hasActiveContract && catalog.length > 0) {
        openSubscribeModal('');
      }
      onClearActionParam?.();
    }
  }, [loading, actionParam, hasActiveContract, catalog.length, openSubscribeModal, onClearActionParam]);

  const activeSubscriptions = useMemo(
    () =>
      subscriptions.filter((s) =>
        ['ACTIVE', 'PENDING_APPROVAL', 'CANCELLATION_PENDING'].includes(s.status)
      ),
    [subscriptions]
  );

  const historySubscriptions = useMemo(
    () =>
      subscriptions.filter((s) => ['CANCELLED', 'REJECTED', 'TERMINATED'].includes(s.status)),
    [subscriptions]
  );

  const selectedCatalogItem = useMemo(
    () => catalog.find((c) => c.id === subForm.service_id) || null,
    [catalog, subForm.service_id]
  );
  const isSubParking = isParkingService(selectedCatalogItem);

  const subscribeDateError = useMemo(() => {
    if (!subForm.start_date) return '';
    if (minSubscribeDate && subForm.start_date < minSubscribeDate) {
      return `Ngày bắt đầu sử dụng không được nhỏ hơn ${formatDateVi(minSubscribeDate)}.`;
    }
    if (maxSubscribeDate && subForm.start_date > maxSubscribeDate) {
      return `Ngày bắt đầu sử dụng không được vượt quá ngày kết thúc hợp đồng (${formatDateVi(maxSubscribeDate)}).`;
    }
    return '';
  }, [subForm.start_date, minSubscribeDate, maxSubscribeDate]);

  const subscribeProrata = useMemo(() => {
    if (!selectedCatalogItem || subscribeDateError) return null;
    return calculateProrataDetails(
      selectedCatalogItem.unit_price,
      subForm.quantity,
      subForm.start_date,
      'subscribe'
    );
  }, [selectedCatalogItem, subForm.quantity, subForm.start_date, subscribeDateError]);

  const contractEffectiveEndStr = toDateOnlyStr(contract?.end_date);
  const minCancelEndDate = toInputDate(new Date());
  const cancelDateError = useMemo(() => {
    if (!cancelTarget || !cancelForm.end_date) return '';
    if (minCancelEndDate && cancelForm.end_date < minCancelEndDate) {
      return `Ngày kết thúc sử dụng không được nhỏ hơn hôm nay (${formatDateVi(minCancelEndDate)}).`;
    }
    if (contractEffectiveEndStr && cancelForm.end_date > contractEffectiveEndStr) {
      return `Ngày kết thúc sử dụng không được vượt quá ngày kết thúc hợp đồng (${formatDateVi(contractEffectiveEndStr)}).`;
    }
    return '';
  }, [cancelTarget, cancelForm.end_date, minCancelEndDate, contractEffectiveEndStr]);

  const cancelProrata = useMemo(() => {
    if (!cancelTarget || cancelDateError) return null;
    return calculateProrataDetails(
      cancelTarget.unit_price,
      cancelTarget.quantity,
      cancelForm.end_date,
      'cancel',
      cancelTarget.start_date
    );
  }, [cancelTarget, cancelForm.end_date, cancelDateError]);

  const handleSubscribeSubmit = async (e) => {
    e.preventDefault();
    if (!subForm.service_id) {
      toast.warning('Vui lòng chọn dịch vụ muốn đăng ký.');
      return;
    }
    if (subscribeDateError) {
      toast.warning(subscribeDateError);
      return;
    }
    const effQty =
      selectedCatalogItem?.billing_type === 'FIXED' && !isSubParking ? 1 : subForm.quantity;
    const meta = validateServiceMetaInput({
      isParking: isSubParking,
      quantity: effQty,
      vehiclePlates: subForm.vehicle_plates,
      note: subForm.note,
    });
    setSubErrors(meta);
    if (!meta.valid) {
      toast.warning(meta.quantityError || meta.plateErrors.find(Boolean) || meta.noteError);
      return;
    }
    setSubmitting(true);
    try {
      const res = await residentService.subscribeService({
        contract_id: contract?.contract_id || undefined,
        service_id: subForm.service_id,
        quantity:
          selectedCatalogItem?.billing_type === 'FIXED' && !isSubParking
            ? 1
            : Math.max(1, parseInt(subForm.quantity, 10) || 1),
        start_date: subForm.start_date || toInputDate(new Date()),
        ...(isSubParking ? { vehicle_plates: meta.cleanPlates } : {}),
        note: meta.cleanNote || undefined,
      });
      toast.success(
        res?.message || 'Đã gửi yêu cầu đăng ký dịch vụ, chờ Ban Quản Lý phê duyệt!'
      );
      setSubModalOpen(false);
      await loadServices();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể đăng ký dịch vụ.'));
    } finally {
      setSubmitting(false);
    }
  };

  const openCancelModal = (sub) => {
    setCancelTarget(sub);
    setCancelForm({
      end_date: toInputDate(new Date()),
      note: '',
    });
  };

  const handleWithdrawCancel = async (sub) => {
    setWithdrawingId(sub.id);
    try {
      const res = await residentService.withdrawCancelService(sub.id);
      toast.success(res?.message || 'Đã rút yêu cầu hủy dịch vụ thành công.');
      await loadServices();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể rút yêu cầu hủy dịch vụ.'));
    } finally {
      setWithdrawingId(null);
    }
  };

  const handleConfirmCancel = async (e) => {
    e.preventDefault();
    if (!cancelTarget) return;
    if (cancelDateError) {
      toast.warning(cancelDateError);
      return;
    }
    setCancelling(true);
    try {
      const res = await residentService.cancelService(cancelTarget.id, {
        end_date: cancelForm.end_date || toInputDate(new Date()),
        note: cancelForm.note?.trim() || undefined,
      });
      toast.success(res?.message || 'Đã gửi yêu cầu hủy dịch vụ thành công.');
      setCancelTarget(null);
      await loadServices();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể hủy dịch vụ.'));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Section 1: Active / Pending Apartment Subscriptions */}
      <Card>
        <CardHeader
          title="Dịch vụ căn hộ đang đăng ký"
          subtitle="Quản lý các gói dịch vụ định kỳ gắn với hợp đồng thuê hiện tại của bạn"
          action={
            hasActiveContract && catalog.length > 0 ? (
              <Button size="sm" icon={Plus} onClick={() => openSubscribeModal('')} className="w-full sm:w-auto">
                Đăng ký thêm dịch vụ
              </Button>
            ) : null
          }
        />

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        ) : activeSubscriptions.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="Chưa có dịch vụ đăng ký nào đang hoạt động"
            description="Khám phá danh mục tiện ích tòa nhà bên dưới (gửi xe, internet, dọn phòng...) để đăng ký sử dụng cho căn hộ."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {activeSubscriptions.map((sub) => {
              const catKey = String(sub.category || 'OTHER').toUpperCase();
              const meta = CATEGORY_META[catKey] || CATEGORY_META.OTHER;
              const CatIcon = meta.icon;
              const monthlyTotal =
                Number(sub.unit_price || 0) * Math.max(1, Number(sub.quantity || 1));
              const canCancel = ['ACTIVE', 'PENDING_APPROVAL'].includes(sub.status);

              return (
                <div
                  key={sub.id}
                  className="p-4 rounded-xl border border-slate-200/90 bg-white flex flex-col justify-between gap-3 hover:border-primary-300 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${meta.color}`}
                      >
                        <CatIcon className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="text-sm font-bold text-slate-900">
                            {sub.service_name}
                          </h4>
                          <StatusBadge status={sub.status} domain="subscription" />
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Số lượng: <strong className="text-slate-700">{sub.quantity}</strong>{' '}
                          {sub.unit || 'gói'} • Đơn giá: {formatMoney(sub.unit_price)}
                          {sub.apartment_code ? ` • Căn ${sub.apartment_code}` : ''}
                        </p>
                        <VehiclePlatesBadges plates={sub.vehicle_plates} className="mt-1.5" />
                        {sub.note ? (
                          <p className="text-xs text-slate-600 mt-1 bg-slate-50 border border-slate-200/70 rounded-lg px-2.5 py-1 whitespace-pre-line break-words">
                            Ghi chú: {sub.note}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="space-y-0.5">
                      <p className="text-slate-500">
                        Bắt đầu: <strong className="text-slate-700">{formatDate(sub.start_date)}</strong>
                        {sub.end_date ? (
                          <>
                            {' • '}Kết thúc: <strong className="text-slate-700">{formatDate(sub.end_date)}</strong>
                          </>
                        ) : null}
                        {Number(sub.prorata_amount) > 0
                          ? ` • Kỳ đầu (Pro-rata): ${formatMoney(sub.prorata_amount)}`
                          : ''}
                      </p>
                      <p className="font-bold text-primary-700 text-sm">
                        {formatMoney(monthlyTotal)} / tháng
                      </p>
                    </div>

                    {sub.status === 'CANCELLATION_PENDING' ? (
                      <Button
                        variant="outline"
                        size="xs"
                        loading={withdrawingId === sub.id}
                        onClick={() => handleWithdrawCancel(sub)}
                        className="text-amber-600 hover:bg-amber-50 border-amber-200"
                      >
                        Rút yêu cầu hủy
                      </Button>
                    ) : canCancel ? (
                      <Button
                        variant="outline"
                        size="xs"
                        icon={XCircle}
                        onClick={() => openCancelModal(sub)}
                        className="text-rose-600 hover:bg-rose-50 border-rose-200"
                      >
                        {sub.status === 'PENDING_APPROVAL' ? 'Hủy yêu cầu' : 'Hủy dịch vụ'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Cancelled / Past Subscriptions Toggle */}
        {historySubscriptions.length > 0 ? (
          <div className="mt-5 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setShowCancelledHistory((v) => !v)}
              className="text-xs font-medium text-slate-500 hover:text-primary-600"
            >
              {showCancelledHistory
                ? 'Ẩn lịch sử dịch vụ đã hủy / ngừng sử dụng'
                : `Xem lịch sử dịch vụ đã hủy (${historySubscriptions.length})`}
            </button>
            {showCancelledHistory ? (
              <div className="mt-3 space-y-2">
                {historySubscriptions.map((h) => (
                  <div
                    key={h.id}
                    className="px-3.5 py-2.5 rounded-lg bg-slate-50 border border-slate-200/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-500"
                  >
                    <div className="space-y-0.5 min-w-0">
                      <div>
                        <span className="font-semibold text-slate-700">{h.service_name}</span>
                        <span>
                          {' '}
                          (SL: {h.quantity} • Từ {formatDate(h.start_date)}
                          {h.end_date ? ` đến ${formatDate(h.end_date)}` : ''})
                        </span>
                      </div>
                      <VehiclePlatesBadges plates={h.vehicle_plates} className="mt-1" />
                      {h.note ? (
                        <p className="text-slate-600 whitespace-pre-line break-words">
                          Ghi chú: {h.note}
                        </p>
                      ) : null}
                    </div>
                    <StatusBadge status={h.status} domain="subscription" />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* Section 2: Building Service Catalog */}
      <Card>
        <CardHeader
          title="Danh mục dịch vụ Tòa nhà cung cấp"
          subtitle="Chọn dịch vụ tiện ích để đăng ký bổ sung — tự động tính phí Pro-rata theo số ngày thực tế trong tháng đầu"
        />

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-40 w-full rounded-xl" />
            ))}
          </div>
        ) : catalog.length === 0 ? (
          <EmptyState
            icon={Package}
            title="Chưa có danh mục dịch vụ mở rộng"
            description="Ban Quản Lý hiện chưa công bố gói dịch vụ tự đăng ký nào."
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {catalog.map((svc) => {
              const catKey = String(svc.category || 'OTHER').toUpperCase();
              const meta = CATEGORY_META[catKey] || CATEGORY_META.OTHER;
              const CatIcon = meta.icon;
              const isMetered = svc.billing_type === 'METERED';
              const alreadySubscribed = activeSubscriptions.some(
                (s) => s.service_id === svc.id
              );

              return (
                <div
                  key={svc.id}
                  className="rounded-xl border border-slate-200/90 hover:border-primary-300 hover:shadow-sm transition-all p-4 flex flex-col justify-between bg-white"
                >
                  <div className="space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${meta.color}`}
                      >
                        <CatIcon className="w-5 h-5" />
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {alreadySubscribed ? (
                          <Badge variant="emerald" dot>
                            Đã đăng ký
                          </Badge>
                        ) : null}
                        <Badge variant="slate">{meta.label}</Badge>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="text-sm font-bold text-slate-900">{svc.name}</h4>
                        {svc.code ? (
                          <span className="text-[11px] font-mono text-slate-400">#{svc.code}</span>
                        ) : null}
                      </div>
                      {svc.description ? (
                        <p className="text-xs text-slate-500 mt-1 leading-relaxed break-words">
                          {svc.description}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="pt-4 mt-4 border-t border-slate-100 flex items-center justify-between gap-2">
                    <div>
                      <p className="text-[11px] text-slate-400">Đơn giá niêm yết</p>
                      <p className="text-sm font-bold text-primary-600">
                        {formatMoney(svc.unit_price)}
                        <span className="text-[11px] font-normal text-slate-500">
                          /{svc.unit || 'tháng'}
                        </span>
                      </p>
                    </div>

                    {isMetered ? (
                      <Badge variant="sky">Tính theo chỉ số</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant={alreadySubscribed ? 'soft' : 'primary'}
                        disabled={!hasActiveContract}
                        onClick={() => openSubscribeModal(svc.id)}
                      >
                        {alreadySubscribed ? 'Đăng ký thêm' : 'Đăng ký'}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Modal Đăng ký Dịch vụ mới + Ước tính Pro-rata */}
      <Modal
        open={subModalOpen}
        onClose={() => setSubModalOpen(false)}
        title="Đăng ký sử dụng dịch vụ tiện ích"
        subtitle="Hệ thống tự động ước tính phí Pro-rata công bằng theo ngày bắt đầu trong tháng đầu tiên"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setSubModalOpen(false)} disabled={submitting}>
              Hủy
            </Button>
            <Button
              icon={CheckCircle2}
              onClick={handleSubscribeSubmit}
              loading={submitting}
              disabled={Boolean(subscribeDateError)}
            >
              Xác nhận đăng ký
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubscribeSubmit} className="space-y-4">
          <Select
            label="Dịch vụ cần đăng ký"
            required
            value={subForm.service_id}
            onChange={(e) => {
              const nextServiceId = e.target.value;
              const nextSvc = catalog.find((c) => c.id === nextServiceId);
              const nextParking = isParkingService(nextSvc);
              setSubForm((s) => {
                const nextQty =
                  nextSvc?.billing_type === 'FIXED' && !nextParking
                    ? 1
                    : nextParking
                    ? Math.min(MAX_PARKING_QUANTITY, Math.max(1, parseInt(s.quantity, 10) || 1))
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
              setSubErrors({ plateErrors: [], quantityError: '', noteError: '' });
            }}
            options={catalog
              .filter((c) => c.billing_type !== 'METERED')
              .map((c) => ({
                value: c.id,
                label: `${c.name} — ${formatMoney(c.unit_price)}/${c.unit || 'tháng'}`,
              }))}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              type="number"
              min="1"
              max={isSubParking ? MAX_PARKING_QUANTITY : 20}
              disabled={selectedCatalogItem?.billing_type === 'FIXED' && !isSubParking}
              error={subErrors.quantityError}
              required
              label={`Số lượng (${selectedCatalogItem?.unit || 'đơn vị'})`}
              value={subForm.quantity}
              onChange={(e) => {
                const nextQty = e.target.value;
                setSubForm((s) => ({
                  ...s,
                  quantity: nextQty,
                  vehicle_plates: isSubParking
                    ? syncVehiclePlatesArray(s.vehicle_plates, nextQty)
                    : s.vehicle_plates,
                }));
                setSubErrors((prev) => ({ ...prev, quantityError: '', plateErrors: [] }));
              }}
            />

            <Input
              type="date"
              required
              label="Ngày bắt đầu sử dụng"
              min={minSubscribeDate || undefined}
              max={maxSubscribeDate || undefined}
              error={subscribeDateError}
              value={subForm.start_date}
              onChange={(e) => setSubForm((s) => ({ ...s, start_date: e.target.value }))}
            />
          </div>

          {/* Live Pro-rata Calculation Box */}
          {selectedCatalogItem && subscribeProrata ? (
            <div className="p-4 rounded-xl bg-gradient-to-br from-sky-50 to-indigo-50/60 border border-sky-200 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-primary-700">
                <Calculator className="w-4 h-4" />
                <span>Ước tính phí Pro-rata tháng đầu tiên</span>
              </div>

              <div className="space-y-1 text-xs text-slate-600">
                <div className="flex justify-between">
                  <span>Phí trọn tháng ({subForm.quantity} × {formatMoney(selectedCatalogItem.unit_price)}):</span>
                  <span className="font-medium text-slate-800">
                    {formatMoney(subscribeProrata.fullMonthAmount)} / tháng
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Số ngày sử dụng thực tế tháng đầu:</span>
                  <span className="font-medium text-slate-800">
                    {subscribeProrata.activeDays} / {subscribeProrata.daysInMonth} ngày
                  </span>
                </div>
                <div className="flex justify-between pt-2 border-t border-sky-200/80 text-sm font-bold text-primary-700">
                  <span>Phí kỳ đầu tạm tính (Pro-rata):</span>
                  <span>{formatMoney(subscribeProrata.prorataAmount)}</span>
                </div>
              </div>
              <p className="text-[11px] text-slate-500 flex items-center gap-1 pt-0.5">
                <Info className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                Các tháng tiếp theo sẽ tính tròn kỳ theo đơn giá niêm yết.
              </p>
            </div>
          ) : null}

          <ServiceSubscriptionMetaFields
            isParking={isSubParking}
            quantity={subForm.quantity}
            vehiclePlates={subForm.vehicle_plates}
            note={subForm.note}
            plateErrors={subErrors.plateErrors}
            noteError={subErrors.noteError}
            noteMultiline
            noteRows={2}
            onPlateChange={(plateIdx, val) => {
              setSubForm((s) => {
                const nextPlates = syncVehiclePlatesArray(s.vehicle_plates, s.quantity);
                nextPlates[plateIdx] = val;
                return { ...s, vehicle_plates: nextPlates };
              });
              setSubErrors((prev) => ({ ...prev, plateErrors: [] }));
            }}
            onNoteChange={(val) => {
              setSubForm((s) => ({ ...s, note: val }));
              setSubErrors((prev) => ({ ...prev, noteError: '' }));
            }}
          />
        </form>
      </Modal>

      {/* Modal Hủy dịch vụ */}
      <Modal
        open={Boolean(cancelTarget)}
        onClose={() => setCancelTarget(null)}
        title={`Hủy dịch vụ: ${cancelTarget?.service_name || ''}`}
        subtitle="Chọn ngày ngừng sử dụng để hệ thống kết toán phí Pro-rata chính xác tới ngày hủy"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setCancelTarget(null)} disabled={cancelling}>
              Quay lại
            </Button>
            <Button
              variant="danger"
              onClick={handleConfirmCancel}
              loading={cancelling}
              disabled={Boolean(cancelDateError)}
            >
              Xác nhận hủy dịch vụ
            </Button>
          </>
        }
      >
        {cancelTarget ? (
          <form onSubmit={handleConfirmCancel} className="space-y-4">
            <VehiclePlatesBadges plates={cancelTarget.vehicle_plates} />
            <Input
              type="date"
              label="Ngày kết thúc sử dụng"
              min={minCancelEndDate || undefined}
              max={contractEffectiveEndStr || undefined}
              error={cancelDateError}
              value={cancelForm.end_date}
              icon={Calendar}
              onChange={(e) => setCancelForm((s) => ({ ...s, end_date: e.target.value }))}
            />

            {cancelTarget.status === 'ACTIVE' && cancelProrata ? (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1">
                <p className="font-semibold">Tạm tính phí sử dụng đến ngày hủy:</p>
                <p>
                  {cancelProrata.activeDays}/{cancelProrata.daysInMonth} ngày trong tháng ={' '}
                  <strong>{formatMoney(cancelProrata.prorataAmount)}</strong>
                </p>
              </div>
            ) : null}

            <Input
              multiline
              rows={2}
              label="Lý do hủy dịch vụ (tùy chọn)"
              placeholder="Ví dụ: Không còn nhu cầu gửi xe..."
              value={cancelForm.note}
              onChange={(e) => setCancelForm((s) => ({ ...s, note: e.target.value }))}
            />
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

export default ServicesTab;
