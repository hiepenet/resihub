import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Wrench,
  Plus,
  Star,
  Copy,
  Check,
  UserCheck,
  Clock,
  Send,
  AlertTriangle,
  CheckCircle2,
  MessageSquare,
  RefreshCw,
  XCircle,
  Eye,
} from 'lucide-react';
import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Tabs } from '../../../components/ui/Tabs';
import { Skeleton } from '../../../components/ui/Skeleton';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { EmptyState } from '../../../components/common/EmptyState';
import {
  SERVICE_REQUEST_CATEGORY,
  PREFERRED_SLOT_LABELS,
} from '../../../constants/statuses';
import { residentService } from '../../../services/resident.service';
import { useToast } from '../../../hooks/useToast';
import { formatDateTime } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';
import { computeSlaBadgeMeta, copyTextToClipboard } from '../../../utils/zaloFormat';

const OPEN_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'];

const CATEGORY_OPTIONS = [
  { value: 'ELECTRICAL', label: 'Điện chiếu sáng / Ổ cắm (ELECTRICAL)' },
  { value: 'PLUMBING', label: 'Cấp thoát nước / Vòi sen (PLUMBING)' },
  { value: 'HVAC', label: 'Điều hòa / Thông gió (HVAC)' },
  { value: 'FURNITURE', label: 'Nội thất căn hộ (FURNITURE)' },
  { value: 'APPLIANCE', label: 'Thiết bị gia dụng (APPLIANCE)' },
  { value: 'CLEANING', label: 'Vệ sinh môi trường (CLEANING)' },
  { value: 'SECURITY', label: 'An ninh / Khóa cửa thẻ từ (SECURITY)' },
  { value: 'OTHER', label: 'Hạng mục khác (OTHER)' },
];

const PRIORITY_OPTIONS = [
  { value: 'LOW', label: 'Thấp — Không ảnh hưởng sinh hoạt' },
  { value: 'NORMAL', label: 'Bình thường — Xử lý trong giờ hành chính' },
  { value: 'HIGH', label: 'Cao — Ảnh hưởng sinh hoạt hàng ngày' },
  { value: 'URGENT', label: 'Khẩn cấp — Mất điện/nước, rò rỉ nghiêm trọng' },
];

const PREFERRED_SLOT_OPTIONS = [
  { value: 'ANYTIME', label: PREFERRED_SLOT_LABELS.ANYTIME },
  { value: 'MORNING_08_12', label: PREFERRED_SLOT_LABELS.MORNING_08_12 },
  { value: 'AFTERNOON_13_17', label: PREFERRED_SLOT_LABELS.AFTERNOON_13_17 },
  { value: 'EVENING_18_21', label: PREFERRED_SLOT_LABELS.EVENING_18_21 },
];

const STAR_LABELS = {
  1: 'Rất không hài lòng',
  2: 'Chưa hài lòng',
  3: 'Bình thường',
  4: 'Hài lòng',
  5: 'Rất hài lòng — Tuyệt vời!',
};

export function MaintenanceTab({
  overview,
  onRefreshOverview,
  onRequestsChanged,
  actionParam,
  onClearActionParam,
}) {
  const toast = useToast();
  const contract = overview?.active_contract || overview?.contract || null;
  const reopenWindowDays = Number(overview?.sla_config?.reopen_window_days || 3);

  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterTab, setFilterTab] = useState('all');
  const [copiedCode, setCopiedCode] = useState('');
  const [previewImg, setPreviewImg] = useState(null);
  const [highlightedId, setHighlightedId] = useState(null);

  // Create Service Request Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const [srForm, setSrForm] = useState({
    category: 'ELECTRICAL',
    priority: 'NORMAL',
    location_detail: '',
    preferred_slot: 'ANYTIME',
    title: '',
    description: '',
    images: [],
  });

  // 409 DUPLICATE_SERVICE_REQUEST Confirmation State (AC-004.2)
  const [duplicatePrompt, setDuplicatePrompt] = useState(null);

  // Self-cancel Modal (NEW -> CANCELLED)
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  // Reopen Modal (RESOLVED -> REOPENED within reopen_window_days)
  const [reopenTarget, setReopenTarget] = useState(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenError, setReopenError] = useState('');
  const [reopenSubmitting, setReopenSubmitting] = useState(false);

  // Rating 1-5 Stars Modal (RESOLVED -> CLOSED)
  const [ratingTarget, setRatingTarget] = useState(null);
  const [ratingStars, setRatingStars] = useState(5);
  const [hoverStars, setHoverStars] = useState(0);
  const [ratingNote, setRatingNote] = useState('');
  const [ratingSubmitting, setRatingSubmitting] = useState(false);

  const loadRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await residentService.listServiceRequests(contract?.contract_id);
      const rows = res?.data || [];
      setRequests(rows);
      onRequestsChanged?.(rows);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách yêu cầu sửa chữa.'));
    } finally {
      setLoading(false);
    }
  }, [contract?.contract_id, onRequestsChanged, toast]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  const openCreateModal = useCallback(() => {
    if (!contract) {
      toast.warning('Bạn cần có hợp đồng thuê đang hiệu lực để gửi yêu cầu sửa chữa.');
      return;
    }
    setFormErrors({});
    setSrForm({
      category: 'ELECTRICAL',
      priority: 'NORMAL',
      location_detail: '',
      preferred_slot: 'ANYTIME',
      title: '',
      description: '',
      images: [],
    });
    setCreateOpen(true);
  }, [contract, toast]);

  useEffect(() => {
    if (!loading && actionParam === 'new') {
      if (contract) {
        openCreateModal();
      }
      onClearActionParam?.();
    }
  }, [loading, actionParam, contract, openCreateModal, onClearActionParam]);

  const openCount = useMemo(
    () => requests.filter((r) => OPEN_STATUSES.includes(r.status)).length,
    [requests]
  );

  const doneCount = useMemo(
    () => requests.filter((r) => ['RESOLVED', 'CLOSED'].includes(r.status)).length,
    [requests]
  );

  const filteredRequests = useMemo(() => {
    if (filterTab === 'open') {
      return requests.filter((r) => OPEN_STATUSES.includes(r.status));
    }
    if (filterTab === 'done') {
      return requests.filter((r) => ['RESOLVED', 'CLOSED'].includes(r.status));
    }
    return requests;
  }, [requests, filterTab]);

  const submitRequestPayload = async (payload) => {
    setSubmitting(true);
    try {
      const res = await residentService.createServiceRequest(payload);
      toast.success(
        res?.message ||
          `Đã tiếp nhận báo hỏng! Mã tra cứu: ${res?.data?.tracking_code || ''}`
      );
      setDuplicatePrompt(null);
      setCreateOpen(false);
      await Promise.allSettled([loadRequests(), onRefreshOverview?.()]);
    } catch (err) {
      const status = err?.response?.status;
      const errData = err?.response?.data;
      if (status === 409 && errData?.code === 'DUPLICATE_SERVICE_REQUEST') {
        setDuplicatePrompt({
          message:
            errData?.message ||
            'Căn hộ đang có yêu cầu cùng hạng mục vừa gửi trong 24 giờ qua. Bạn vẫn muốn tiếp tục gửi thêm yêu cầu mới?',
          existingRequest: errData?.existing_request || null,
          pendingPayload: payload,
        });
      } else {
        toast.error(extractErrorMessage(err, 'Không thể gửi yêu cầu sửa chữa.'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitNew = async (e) => {
    e.preventDefault();
    if (!srForm.description?.trim()) {
      setFormErrors({ description: 'Vui lòng mô tả chi tiết tình trạng sự cố.' });
      return;
    }

    const payload = {
      category: srForm.category,
      priority: srForm.priority,
      location_detail: srForm.location_detail?.trim() || undefined,
      preferred_slot: srForm.preferred_slot || 'ANYTIME',
      title: srForm.title?.trim() || undefined,
      description: srForm.description.trim(),
      contract_id: contract?.contract_id || undefined,
      apartment_id: contract?.apartment_id || undefined,
      images: srForm.images.slice(0, 3),
    };

    await submitRequestPayload(payload);
  };

  const handleForceCreateDuplicate = async () => {
    if (!duplicatePrompt?.pendingPayload) return;
    await submitRequestPayload({
      ...duplicatePrompt.pendingPayload,
      ignore_duplicate_warning: true,
      confirm_duplicate: true,
    });
  };

  const handleViewExistingDuplicate = () => {
    const existingId = duplicatePrompt?.existingRequest?.id;
    setDuplicatePrompt(null);
    setCreateOpen(false);
    setFilterTab('all');
    if (existingId) {
      setHighlightedId(existingId);
      setTimeout(() => {
        const el = document.getElementById(`sr-card-${existingId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 150);
      setTimeout(() => setHighlightedId(null), 4000);
    }
  };

  const openCancelModal = (reqItem) => {
    setCancelTarget(reqItem);
    setCancelReason('');
  };

  const handleSubmitCancel = async (e) => {
    e.preventDefault();
    if (!cancelTarget) return;
    setCancelSubmitting(true);
    try {
      const res = await residentService.cancelServiceRequest(cancelTarget.id, {
        cancel_reason: cancelReason?.trim() || undefined,
      });
      toast.success(res?.message || 'Đã hủy yêu cầu sửa chữa.');
      setCancelTarget(null);
      await Promise.allSettled([loadRequests(), onRefreshOverview?.()]);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể hủy yêu cầu sửa chữa.'));
    } finally {
      setCancelSubmitting(false);
    }
  };

  const openReopenModal = (reqItem) => {
    setReopenTarget(reqItem);
    setReopenReason('');
    setReopenError('');
  };

  const handleSubmitReopen = async (e) => {
    e.preventDefault();
    if (!reopenTarget) return;
    if (!reopenReason || reopenReason.trim().length < 5) {
      setReopenError('Vui lòng mô tả lý do chưa đạt tối thiểu 5 ký tự để kỹ thuật kiểm tra lại.');
      return;
    }
    setReopenSubmitting(true);
    try {
      const res = await residentService.reopenServiceRequest(reopenTarget.id, {
        reopen_reason: reopenReason.trim(),
      });
      toast.success(res?.message || 'Đã mở lại yêu cầu để Ban quản lý xử lý bổ sung.');
      setReopenTarget(null);
      await Promise.allSettled([loadRequests(), onRefreshOverview?.()]);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể mở lại yêu cầu sửa chữa.'));
    } finally {
      setReopenSubmitting(false);
    }
  };

  const openRatingModal = (reqItem) => {
    setRatingTarget(reqItem);
    setRatingStars(5);
    setHoverStars(0);
    setRatingNote('');
  };

  const handleSubmitRating = async (e) => {
    e.preventDefault();
    if (!ratingTarget) return;
    setRatingSubmitting(true);
    try {
      const res = await residentService.rateServiceRequest(ratingTarget.id, {
        rating: ratingStars,
        rating_note: ratingNote?.trim() || undefined,
      });
      toast.success(res?.message || 'Cảm ơn bạn đã nghiệm thu và đánh giá chất lượng xử lý!');
      setRatingTarget(null);
      await Promise.allSettled([loadRequests(), onRefreshOverview?.()]);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu đánh giá.'));
    } finally {
      setRatingSubmitting(false);
    }
  };

  const handleCopyCode = async (code) => {
    if (!code) return;
    const ok = await copyTextToClipboard(code);
    if (ok) {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(''), 2000);
      toast.info(`Đã sao chép mã tra cứu ${code}`);
    }
  };

  const isReopenExpired = (resolvedAt) => {
    if (!resolvedAt) return false;
    const dt = new Date(resolvedAt);
    if (Number.isNaN(dt.getTime())) return false;
    const windowMs = reopenWindowDays * 24 * 60 * 60 * 1000;
    return Date.now() - dt.getTime() > windowMs;
  };

  return (
    <div className="space-y-6">
      {/* Header Banner + New Request CTA */}
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-bold text-slate-900">
              Báo hỏng & Yêu cầu Hỗ trợ Kỹ thuật
            </h2>
            <p className="text-xs text-slate-500">
              Gửi yêu cầu sửa chữa kèm vị trí chi tiết, khung giờ hẹn, hình ảnh thực tế (tối đa 3 ảnh) và nghiệm thu kết quả xử lý SLA
            </p>
          </div>
          <Button
            icon={Plus}
            onClick={openCreateModal}
            disabled={!contract}
            className="w-full sm:w-auto shrink-0"
          >
            Gửi yêu cầu báo hỏng
          </Button>
        </div>

        {!contract ? (
          <div className="mt-4 p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-center gap-2 text-xs text-amber-800">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              Chức năng gửi báo hỏng dành cho cư dân có hợp đồng thuê căn hộ đang hiệu lực.
            </span>
          </div>
        ) : null}
      </Card>

      {/* Requests List */}
      <Card padding={false} className="overflow-hidden">
        <div className="px-5 pt-4">
          <Tabs
            activeTab={filterTab}
            onChange={setFilterTab}
            tabs={[
              { id: 'all', label: 'Tất cả yêu cầu', count: requests.length },
              { id: 'open', label: 'Đang xử lý', count: openCount },
              { id: 'done', label: 'Đã hoàn thành', count: doneCount },
            ]}
          />
        </div>

        <div className="p-5">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-32 w-full rounded-xl" />
              ))}
            </div>
          ) : filteredRequests.length === 0 ? (
            <EmptyState
              icon={Wrench}
              title="Chưa có yêu cầu báo hỏng nào"
              description="Khi căn hộ phát sinh sự cố điện, nước, điều hòa hoặc nội thất, bạn hãy nhấn nút Gửi yêu cầu báo hỏng để kỹ thuật tòa nhà hỗ trợ ngay."
              action={
                contract ? (
                  <Button size="sm" icon={Plus} onClick={openCreateModal}>
                    Tạo yêu cầu đầu tiên
                  </Button>
                ) : null
              }
            />
          ) : (
            <div className="space-y-4">
              {filteredRequests.map((req) => {
                const imgs = Array.isArray(req.images) ? req.images : [];
                const resImgs = Array.isArray(req.resolution_images) ? req.resolution_images : [];
                const canCancel = req.status === 'NEW';
                const canAcceptOrReopen = req.status === 'RESOLVED';
                const reopenExpired = canAcceptOrReopen && isReopenExpired(req.resolved_at);
                const hasRated = Number(req.rating) > 0;
                const slaMeta = computeSlaBadgeMeta({
                  status: req.status,
                  slaDueAt: req.sla_due_at,
                  slaBreachedAt: req.sla_breached_at,
                });

                return (
                  <div
                    id={`sr-card-${req.id}`}
                    key={req.id}
                    className={`p-4 sm:p-5 rounded-xl border transition-all bg-white ${
                      highlightedId === req.id
                        ? 'ring-2 ring-primary-500 border-primary-400 bg-primary-50/10'
                        : req.status === 'RESOLVED' && !req.rating
                        ? 'border-emerald-300 bg-emerald-50/15'
                        : 'border-slate-200/90 hover:border-slate-300'
                    }`}
                  >
                    {/* Top Row: Tracking Code + Badges */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-3 border-b border-slate-100">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <button
                          type="button"
                          onClick={() => handleCopyCode(req.tracking_code)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-mono font-bold text-slate-800 transition-colors"
                          title="Nhấn để sao chép mã tra cứu"
                        >
                          <span>{req.tracking_code || `SR-${req.id.slice(0, 8)}`}</span>
                          {copiedCode === req.tracking_code ? (
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                          ) : (
                            <Copy className="w-3 h-3 text-slate-400" />
                          )}
                        </button>

                        <Badge variant="indigo">
                          {SERVICE_REQUEST_CATEGORY[req.category] || req.category}
                        </Badge>
                        <StatusBadge status={req.priority} domain="priority" dot={false} />
                        <StatusBadge status={req.status} domain="service_request" />
                        <Badge variant={slaMeta.variant}>{slaMeta.label}</Badge>
                        {req.apartment_code ? (
                          <span className="text-xs font-medium text-slate-600 break-words">
                            Căn {req.apartment_code}
                            {req.building_name ? ` — ${req.building_name}` : ''}
                          </span>
                        ) : null}
                      </div>

                      <span className="text-xs text-slate-400 flex items-center gap-1 shrink-0">
                        <Clock className="w-3.5 h-3.5" />
                        {formatDateTime(req.created_at)}
                      </span>
                    </div>

                    {/* Title, Description, Location & Preferred Slot */}
                    <div className="py-3 space-y-2">
                      <h4 className="text-sm font-bold text-slate-900 break-words">
                        {req.title || `Báo hỏng ${SERVICE_REQUEST_CATEGORY[req.category] || req.category}`}
                      </h4>

                      {(req.location_detail || req.preferred_slot || Number(req.reopen_count) > 0) ? (
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
                          {req.location_detail ? (
                            <span className="px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200 font-medium break-words">
                              Vị trí: {req.location_detail}
                            </span>
                          ) : null}
                          {req.preferred_slot ? (
                            <span className="px-2 py-0.5 rounded-md bg-sky-50 border border-sky-200 text-sky-800 font-medium">
                              Khung giờ hẹn: {PREFERRED_SLOT_LABELS[req.preferred_slot] || req.preferred_slot}
                            </span>
                          ) : null}
                          {Number(req.reopen_count) > 0 ? (
                            <span className="px-2 py-0.5 rounded-md bg-rose-50 border border-rose-200 text-rose-700 font-semibold">
                              Đã yêu cầu xử lý lại {req.reopen_count} lần
                            </span>
                          ) : null}
                        </div>
                      ) : null}

                      <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-line break-words">
                        {req.description}
                      </p>

                      {/* ON_HOLD Notice */}
                      {(req.status === 'ON_HOLD' || req.hold_reason || req.next_appointment_at) ? (
                        <div className="p-3 rounded-xl bg-purple-50/80 border border-purple-200 text-xs text-purple-900 space-y-1">
                          {req.hold_reason ? (
                            <p className="break-words">
                              <strong>Lý do tạm hoãn / hẹn lại:</strong> {req.hold_reason}
                            </p>
                          ) : null}
                          {req.next_appointment_at ? (
                            <p>
                              <strong>Lịch hẹn kỹ thuật tiếp theo:</strong>{' '}
                              {formatDateTime(req.next_appointment_at)}
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      {/* Reopen Reason */}
                      {req.reopen_reason ? (
                        <div className="p-2.5 rounded-xl bg-rose-50/70 border border-rose-200 text-xs text-rose-800 break-words">
                          <strong>Lý do yêu cầu xử lý lại gần nhất:</strong> {req.reopen_reason}
                        </div>
                      ) : null}

                      {/* Cancel Reason */}
                      {req.status === 'CANCELLED' && req.cancelled_reason ? (
                        <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600 break-words">
                          <strong>Lý do hủy:</strong> {req.cancelled_reason}
                        </div>
                      ) : null}

                      {/* Attached Problem Images via AuthImage */}
                      {imgs.length > 0 ? (
                        <div className="space-y-1 pt-1">
                          <p className="text-[11px] font-medium text-slate-500">
                            Ảnh hiện trạng sự cố ({imgs.length})
                          </p>
                          <div className="flex flex-wrap gap-2.5">
                            {imgs.map((imgSrc, idx) => (
                              <button
                                key={idx}
                                type="button"
                                onClick={() => setPreviewImg(imgSrc)}
                                className="w-20 h-20 rounded-xl border border-slate-200 overflow-hidden bg-slate-50 hover:ring-2 hover:ring-primary-400 transition-all"
                              >
                                <AuthImage
                                  src={imgSrc}
                                  alt={`Ảnh sự cố ${idx + 1}`}
                                  className="w-full h-full object-cover"
                                />
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    {/* Footer: Technician Info / Public Resolution / Actions */}
                    <div className="pt-3 border-t border-slate-100 flex flex-col lg:flex-row lg:items-start justify-between gap-3 text-xs">
                      <div className="space-y-2 text-slate-500 min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 flex-wrap">
                          <UserCheck className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span>
                            Kỹ thuật phụ trách:{' '}
                            <strong className="text-slate-700">
                              {req.assigned_to_name || 'Đang điều phối nhân sự'}
                            </strong>
                          </span>
                          {req.sla_due_at && OPEN_STATUSES.includes(req.status) ? (
                            <span className="text-slate-500">
                              • Hạn xử lý SLA: {formatDateTime(req.sla_due_at)}
                            </span>
                          ) : null}
                          {req.resolved_at ? (
                            <span className="text-emerald-700 font-medium">
                              • Hoàn thành lúc: {formatDateTime(req.resolved_at)}
                            </span>
                          ) : null}
                        </p>

                        {req.resolution_note ? (
                          <div className="p-2.5 rounded-xl bg-emerald-50/70 border border-emerald-200 text-emerald-800 flex items-start gap-1.5 whitespace-pre-line break-words">
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5 text-emerald-600" />
                            <span>
                              <strong>Kết quả xử lý kỹ thuật:</strong> {req.resolution_note}
                            </span>
                          </div>
                        ) : null}

                        {resImgs.length > 0 ? (
                          <div className="space-y-1">
                            <p className="text-[11px] font-semibold text-emerald-700">
                              Ảnh nghiệm thu sau sửa chữa ({resImgs.length})
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {resImgs.map((imgSrc, idx) => (
                                <button
                                  key={idx}
                                  type="button"
                                  onClick={() => setPreviewImg(imgSrc)}
                                  className="w-20 h-20 rounded-xl border border-emerald-200 overflow-hidden bg-emerald-50/40 hover:ring-2 hover:ring-emerald-400 transition-all"
                                >
                                  <AuthImage
                                    src={imgSrc}
                                    alt={`Ảnh nghiệm thu ${idx + 1}`}
                                    className="w-full h-full object-cover"
                                  />
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {canCancel ? (
                          <Button
                            size="sm"
                            variant="outline"
                            icon={XCircle}
                            onClick={() => openCancelModal(req)}
                          >
                            Hủy yêu cầu
                          </Button>
                        ) : null}

                        {canAcceptOrReopen ? (
                          <>
                            <span
                              title={
                                reopenExpired
                                  ? `Đã quá thời hạn ${reopenWindowDays} ngày mở lại yêu cầu sau khi hoàn tất.`
                                  : `Yêu cầu kỹ thuật kiểm tra lại (trong vòng ${reopenWindowDays} ngày sau khi hoàn tất)`
                              }
                            >
                              <Button
                                size="sm"
                                variant="outline"
                                icon={RefreshCw}
                                disabled={reopenExpired}
                                onClick={() => openReopenModal(req)}
                              >
                                Chưa đạt — Yêu cầu xử lý lại
                              </Button>
                            </span>

                            {!hasRated ? (
                              <Button
                                size="sm"
                                variant="warning"
                                icon={Star}
                                onClick={() => openRatingModal(req)}
                              >
                                Nghiệm thu & Đánh giá (1–5 ★)
                              </Button>
                            ) : null}
                          </>
                        ) : null}

                        {hasRated ? (
                          <div className="inline-flex flex-col sm:items-end gap-0.5 bg-amber-50/80 border border-amber-200/80 px-3 py-1.5 rounded-xl max-w-sm">
                            <div className="flex items-center gap-0.5 text-amber-500">
                              {[1, 2, 3, 4, 5].map((s) => (
                                <Star
                                  key={s}
                                  className={`w-3.5 h-3.5 ${
                                    s <= Number(req.rating)
                                      ? 'fill-amber-400 text-amber-400'
                                      : 'text-slate-300'
                                  }`}
                                />
                              ))}
                              <span className="ml-1.5 text-xs font-bold text-amber-800">
                                {req.rating}/5
                              </span>
                            </div>
                            {req.rating_note ? (
                              <span className="text-[11px] text-slate-600 italic break-words whitespace-pre-line">
                                "{req.rating_note}"
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {/* Modal Gửi Yêu Cầu Báo Hỏng Mới */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Gửi yêu cầu sửa chữa / báo hỏng"
        subtitle={`Căn hộ ${contract?.apartment_code || ''} — ${contract?.building_name || ''}`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submitting}>
              Hủy
            </Button>
            <Button icon={Send} onClick={handleSubmitNew} loading={submitting}>
              Gửi yêu cầu
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitNew} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Hạng mục sự cố"
              required
              value={srForm.category}
              onChange={(e) => setSrForm((s) => ({ ...s, category: e.target.value }))}
              options={CATEGORY_OPTIONS}
            />

            <Select
              label="Mức độ khẩn cấp"
              required
              value={srForm.priority}
              onChange={(e) => setSrForm((s) => ({ ...s, priority: e.target.value }))}
              options={PRIORITY_OPTIONS}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Vị trí cụ thể trong phòng"
              placeholder="VD: Nhà vệ sinh phụ, Ban công, Bếp..."
              value={srForm.location_detail}
              onChange={(e) => setSrForm((s) => ({ ...s, location_detail: e.target.value }))}
            />

            <Select
              label="Khung giờ thuận tiện tiếp kỹ thuật"
              value={srForm.preferred_slot}
              onChange={(e) => setSrForm((s) => ({ ...s, preferred_slot: e.target.value }))}
              options={PREFERRED_SLOT_OPTIONS}
            />
          </div>

          <Input
            label="Tiêu đề tóm tắt"
            placeholder="Ví dụ: Điều hòa phòng ngủ chính không mát, chảy nước..."
            value={srForm.title}
            onChange={(e) => setSrForm((s) => ({ ...s, title: e.target.value }))}
          />

          <Input
            multiline
            rows={4}
            required
            label="Mô tả chi tiết tình trạng"
            placeholder="Mô tả rõ hiện tượng hư hỏng, mức độ ảnh hưởng để kỹ thuật viên chuẩn bị dụng cụ..."
            value={srForm.description}
            error={formErrors.description}
            onChange={(e) => {
              setSrForm((s) => ({ ...s, description: e.target.value }));
              if (formErrors.description) setFormErrors({});
            }}
          />

          <FileUpload
            label="Ảnh chụp minh họa sự cố (tối đa 3 ảnh)"
            multiple
            maxFiles={3}
            value={srForm.images}
            onChange={(imgs) => setSrForm((s) => ({ ...s, images: imgs }))}
          />
        </form>
      </Modal>

      {/* Cảnh báo 409 DUPLICATE_SERVICE_REQUEST 24h (AC-004.2) */}
      <Modal
        open={Boolean(duplicatePrompt)}
        onClose={() => setDuplicatePrompt(null)}
        title="Phát hiện yêu cầu cùng hạng mục trong 24 giờ qua"
        subtitle="Vui lòng kiểm tra yêu cầu đang mở để tránh tạo phiếu trùng lặp."
        size="md"
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2 w-full">
            <Button
              variant="outline"
              onClick={() => setDuplicatePrompt(null)}
              disabled={submitting}
            >
              Đóng
            </Button>
            {duplicatePrompt?.existingRequest ? (
              <Button
                variant="secondary"
                icon={Eye}
                onClick={handleViewExistingDuplicate}
                disabled={submitting}
              >
                Xem yêu cầu đã gửi
              </Button>
            ) : null}
            <Button
              variant="warning"
              icon={Send}
              onClick={handleForceCreateDuplicate}
              loading={submitting}
            >
              Vẫn tiếp tục gửi mới
            </Button>
          </div>
        }
      >
        {duplicatePrompt ? (
          <div className="space-y-4">
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="leading-relaxed">{duplicatePrompt.message}</p>
            </div>

            {duplicatePrompt.existingRequest ? (
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono font-bold text-primary-700">
                    #{duplicatePrompt.existingRequest.tracking_code}
                  </span>
                  <StatusBadge
                    status={duplicatePrompt.existingRequest.status}
                    domain="service_request"
                  />
                </div>
                <p className="font-semibold text-slate-900 break-words">
                  {duplicatePrompt.existingRequest.title}
                </p>
                {duplicatePrompt.existingRequest.created_at ? (
                  <p className="text-slate-500">
                    Gửi lúc: {formatDateTime(duplicatePrompt.existingRequest.created_at)}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* Modal Tự hủy yêu cầu khi còn NEW */}
      <Modal
        open={Boolean(cancelTarget)}
        onClose={() => setCancelTarget(null)}
        title="Xác nhận hủy yêu cầu báo hỏng"
        subtitle={
          cancelTarget
            ? `Mã yêu cầu: ${cancelTarget.tracking_code} — ${cancelTarget.title || ''}`
            : ''
        }
        size="sm"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setCancelTarget(null)}
              disabled={cancelSubmitting}
            >
              Giữ lại yêu cầu
            </Button>
            <Button
              variant="danger"
              icon={XCircle}
              onClick={handleSubmitCancel}
              loading={cancelSubmitting}
            >
              Xác nhận hủy
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitCancel} className="space-y-3">
          <p className="text-xs text-slate-600 leading-relaxed">
            Yêu cầu đang ở trạng thái <strong>Mới tiếp nhận</strong> và chưa phân công kỹ thuật viên. Bạn có thể hủy nếu sự cố đã tự khắc phục.
          </p>
          <Input
            multiline
            rows={3}
            label="Lý do hủy (tùy chọn)"
            placeholder="Ví dụ: Đã bật lại aptomat, thiết bị hoạt động bình thường..."
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
        </form>
      </Modal>

      {/* Modal Yêu cầu xử lý lại (RESOLVED -> REOPENED, FR-047) */}
      <Modal
        open={Boolean(reopenTarget)}
        onClose={() => setReopenTarget(null)}
        title="Chưa đạt — Yêu cầu kỹ thuật xử lý lại"
        subtitle={
          reopenTarget
            ? `Mã yêu cầu: ${reopenTarget.tracking_code} (thời hạn mở lại: ${reopenWindowDays} ngày)`
            : ''
        }
        size="sm"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setReopenTarget(null)}
              disabled={reopenSubmitting}
            >
              Đóng
            </Button>
            <Button
              variant="danger"
              icon={RefreshCw}
              onClick={handleSubmitReopen}
              loading={reopenSubmitting}
            >
              Gửi yêu cầu xử lý lại
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitReopen} className="space-y-3">
          <p className="text-xs text-slate-600 leading-relaxed">
            Nếu sự cố vẫn tái diễn hoặc chưa được xử lý triệt để, Ban quản lý sẽ nhận cảnh báo ưu tiên và cử kỹ thuật viên kiểm tra lại.
          </p>
          <Input
            multiline
            rows={4}
            required
            label="Mô tả tình trạng chưa đạt"
            placeholder="Ví dụ: Vòi nước dưới bồn rửa vẫn rỉ nước nhỏ giọt sau khi thay gioăng..."
            value={reopenReason}
            error={reopenError}
            onChange={(e) => {
              setReopenReason(e.target.value);
              if (reopenError) setReopenError('');
            }}
          />
        </form>
      </Modal>

      {/* Modal Nghiệm thu & Đánh giá 1-5 Sao (RESOLVED -> CLOSED) */}
      <Modal
        open={Boolean(ratingTarget)}
        onClose={() => setRatingTarget(null)}
        title="Nghiệm thu & Đánh giá chất lượng xử lý"
        subtitle={
          ratingTarget
            ? `Mã yêu cầu: ${ratingTarget.tracking_code} — ${ratingTarget.title || ''}`
            : ''
        }
        size="sm"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setRatingTarget(null)}
              disabled={ratingSubmitting}
            >
              Đóng
            </Button>
            <Button
              variant="warning"
              icon={Star}
              onClick={handleSubmitRating}
              loading={ratingSubmitting}
            >
              Nghiệm thu & Đóng phiếu
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitRating} className="space-y-4">
          <div className="flex flex-col items-center justify-center py-3 bg-amber-50/60 border border-amber-100 rounded-xl">
            <p className="text-xs font-medium text-slate-600 mb-2">
              Mức độ hài lòng của bạn với kết quả sửa chữa
            </p>
            <div className="flex items-center gap-2">
              {[1, 2, 3, 4, 5].map((star) => {
                const active = star <= (hoverStars || ratingStars);
                return (
                  <button
                    key={star}
                    type="button"
                    aria-label={`Đánh giá ${star} sao`}
                    onMouseEnter={() => setHoverStars(star)}
                    onMouseLeave={() => setHoverStars(0)}
                    onClick={() => setRatingStars(star)}
                    className="min-w-[44px] min-h-[44px] p-1.5 inline-flex items-center justify-center rounded-xl transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                  >
                    <Star
                      className={`w-8 h-8 transition-colors ${
                        active
                          ? 'fill-amber-400 text-amber-400'
                          : 'text-slate-300 hover:text-amber-300'
                      }`}
                    />
                  </button>
                );
              })}
            </div>
            <p className="text-xs font-semibold text-amber-700 mt-2">
              {STAR_LABELS[hoverStars || ratingStars]}
            </p>
          </div>

          <Input
            multiline
            rows={3}
            icon={MessageSquare}
            label="Nhận xét chi tiết (tùy chọn)"
            placeholder="Chia sẻ cảm nhận về thái độ nhân viên kỹ thuật và chất lượng xử lý..."
            value={ratingNote}
            onChange={(e) => setRatingNote(e.target.value)}
          />
        </form>
      </Modal>

      {/* Lightbox xem ảnh đính kèm / ảnh nghiệm thu */}
      <Modal
        open={Boolean(previewImg)}
        onClose={() => setPreviewImg(null)}
        title="Xem ảnh chi tiết"
        size="lg"
      >
        {previewImg ? (
          <div className="flex items-center justify-center bg-slate-900/5 rounded-xl p-2">
            <AuthImage
              src={previewImg}
              alt="Ảnh chi tiết"
              className="max-h-[70vh] w-auto rounded-lg object-contain"
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default MaintenanceTab;
