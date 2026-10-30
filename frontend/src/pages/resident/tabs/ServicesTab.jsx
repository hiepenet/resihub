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
import { residentService } from '../../../services/resident.service';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate, toInputDate } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

const CATEGORY_META = {
  PARKING: { label: 'Gửi xe & Bãi đỗ', icon: Car, color: 'bg-sky-50 text-sky-600' },
  INTERNET: { label: 'Internet & Truyền hình', icon: Wifi, color: 'bg-indigo-50 text-indigo-600' },
  CLEANING: { label: 'Vệ sinh & Giặt ủi', icon: Brush, color: 'bg-emerald-50 text-emerald-600' },
  AMENITY: { label: 'Tiện ích nội khu', icon: Dumbbell, color: 'bg-purple-50 text-purple-600' },
  SECURITY: { label: 'Thẻ từ & An ninh', icon: Shield, color: 'bg-amber-50 text-amber-600' },
  UTILITY: { label: 'Điện / Nước / Năng lượng', icon: Sparkles, color: 'bg-sky-50 text-sky-600' },
  OTHER: { label: 'Dịch vụ khác', icon: Package, color: 'bg-slate-100 text-slate-600' },
};

/**
 * Tính ước tính phí Pro-rata khớp công thức backend (resident.js computeProrata)
 */
function calculateProrataDetails(unitPrice, quantity, targetDateStr, mode = 'subscribe') {
  const todayStr = toInputDate(new Date());
  const dateStr = targetDateStr || todayStr;
  const parts = String(dateStr).split('-').map(Number);

  let year;
  let monthIndex;
  let day;

  if (parts.length === 3 && parts[0] > 1900) {
    year = parts[0];
    monthIndex = parts[1] - 1;
    day = parts[2];
  } else {
    const now = new Date();
    year = now.getFullYear();
    monthIndex = now.getMonth();
    day = now.getDate();
  }

  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const activeDays = mode === 'cancel' ? day : Math.max(1, daysInMonth - day + 1);
  const fullMonthAmount = Math.round(Number(unitPrice || 0) * Math.max(1, Number(quantity || 1)));
  const prorataAmount = Math.round((fullMonthAmount * activeDays) / daysInMonth);

  return {
    daysInMonth,
    activeDays,
    fullMonthAmount,
    prorataAmount,
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
    note: '',
  });

  // Cancel Service Modal
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelling, setCancelling] = useState(false);
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
        start_date: toInputDate(new Date()),
        note: '',
      });
      setSubModalOpen(true);
    },
    [catalog, hasActiveContract, toast]
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
      subscriptions.filter((s) => ['CANCELLED', 'REJECTED'].includes(s.status)),
    [subscriptions]
  );

  const selectedCatalogItem = useMemo(
    () => catalog.find((c) => c.id === subForm.service_id) || null,
    [catalog, subForm.service_id]
  );

  const subscribeProrata = useMemo(() => {
    if (!selectedCatalogItem) return null;
    return calculateProrataDetails(
      selectedCatalogItem.unit_price,
      subForm.quantity,
      subForm.start_date,
      'subscribe'
    );
  }, [selectedCatalogItem, subForm.quantity, subForm.start_date]);

  const cancelProrata = useMemo(() => {
    if (!cancelTarget) return null;
    return calculateProrataDetails(
      cancelTarget.unit_price,
      cancelTarget.quantity,
      cancelForm.end_date,
      'cancel'
    );
  }, [cancelTarget, cancelForm.end_date]);

  const handleSubscribeSubmit = async (e) => {
    e.preventDefault();
    if (!subForm.service_id) {
      toast.warning('Vui lòng chọn dịch vụ muốn đăng ký.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await residentService.subscribeService({
        contract_id: contract?.contract_id || undefined,
        service_id: subForm.service_id,
        quantity: Math.max(1, parseInt(subForm.quantity, 10) || 1),
        start_date: subForm.start_date || toInputDate(new Date()),
        note: subForm.note?.trim() || undefined,
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

  const handleConfirmCancel = async (e) => {
    e.preventDefault();
    if (!cancelTarget) return;
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
              <Button size="sm" icon={Plus} onClick={() => openSubscribeModal('')}>
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
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="space-y-0.5">
                      <p className="text-slate-500">
                        Bắt đầu: <strong className="text-slate-700">{formatDate(sub.start_date)}</strong>
                        {Number(sub.prorata_amount) > 0
                          ? ` • Kỳ đầu (Pro-rata): ${formatMoney(sub.prorata_amount)}`
                          : ''}
                      </p>
                      <p className="font-bold text-primary-700 text-sm">
                        {formatMoney(monthlyTotal)} / tháng
                      </p>
                    </div>

                    {canCancel ? (
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
                    className="px-3.5 py-2.5 rounded-lg bg-slate-50 border border-slate-200/60 flex items-center justify-between gap-2 text-xs text-slate-500"
                  >
                    <div>
                      <span className="font-semibold text-slate-700">{h.service_name}</span>
                      <span>
                        {' '}
                        (SL: {h.quantity} • Từ {formatDate(h.start_date)}
                        {h.end_date ? ` đến ${formatDate(h.end_date)}` : ''})
                      </span>
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
                      <div className="flex items-center gap-1.5">
                        {alreadySubscribed ? (
                          <Badge variant="emerald" dot>
                            Đã đăng ký
                          </Badge>
                        ) : null}
                        <Badge variant="slate">{meta.label}</Badge>
                      </div>
                    </div>

                    <div>
                      <h4 className="text-sm font-bold text-slate-900">{svc.name}</h4>
                      <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                        {svc.description || `Mã DV: ${svc.code}`}
                      </p>
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
            <Button icon={CheckCircle2} onClick={handleSubscribeSubmit} loading={submitting}>
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
            onChange={(e) => setSubForm((s) => ({ ...s, service_id: e.target.value }))}
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
              max="20"
              required
              label={`Số lượng (${selectedCatalogItem?.unit || 'đơn vị'})`}
              value={subForm.quantity}
              onChange={(e) => setSubForm((s) => ({ ...s, quantity: e.target.value }))}
            />

            <Input
              type="date"
              required
              label="Ngày bắt đầu sử dụng"
              min={toInputDate(new Date())}
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

          <Input
            multiline
            rows={2}
            label="Ghi chú đăng ký (biển số xe, khung giờ dọn phòng...)"
            placeholder="Ví dụ: Biển số xe 30H-123.45, loại xe tay ga..."
            value={subForm.note}
            onChange={(e) => setSubForm((s) => ({ ...s, note: e.target.value }))}
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
            <Button variant="danger" onClick={handleConfirmCancel} loading={cancelling}>
              Xác nhận hủy dịch vụ
            </Button>
          </>
        }
      >
        {cancelTarget ? (
          <form onSubmit={handleConfirmCancel} className="space-y-4">
            <Input
              type="date"
              label="Ngày kết thúc sử dụng"
              min={toInputDate(new Date())}
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
