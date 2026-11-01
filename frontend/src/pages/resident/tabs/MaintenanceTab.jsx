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
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { SERVICE_REQUEST_CATEGORY } from '../../../constants/statuses';
import { residentService } from '../../../services/resident.service';
import { useToast } from '../../../hooks/useToast';
import { formatDateTime } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

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

  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterTab, setFilterTab] = useState('all');
  const [copiedCode, setCopiedCode] = useState('');
  const [previewImg, setPreviewImg] = useState(null);

  // Create Service Request Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const [srForm, setSrForm] = useState({
    category: 'ELECTRICAL',
    priority: 'NORMAL',
    title: '',
    description: '',
    images: [],
  });

  // 409 DUPLICATE_SERVICE_REQUEST Confirmation State (AC-004.2)
  const [duplicatePrompt, setDuplicatePrompt] = useState(null);

  // Rating 1-5 Stars Modal
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
    () =>
      requests.filter((r) => ['NEW', 'ASSIGNED', 'IN_PROGRESS'].includes(r.status))
        .length,
    [requests]
  );

  const doneCount = useMemo(
    () => requests.filter((r) => ['RESOLVED', 'CLOSED'].includes(r.status)).length,
    [requests]
  );

  const filteredRequests = useMemo(() => {
    if (filterTab === 'open') {
      return requests.filter((r) =>
        ['NEW', 'ASSIGNED', 'IN_PROGRESS'].includes(r.status)
      );
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
            'Căn hộ đang có yêu cầu cùng hạng mục chờ xử lý trong 7 ngày qua. Bạn vẫn muốn tiếp tục gửi thêm yêu cầu mới?',
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
      force_create: true,
      confirm_duplicate: true,
    });
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
      toast.success(res?.message || 'Cảm ơn bạn đã đánh giá chất lượng xử lý!');
      setRatingTarget(null);
      await loadRequests();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu đánh giá.'));
    } finally {
      setRatingSubmitting(false);
    }
  };

  const handleCopyCode = async (code) => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(''), 2000);
      toast.info(`Đã sao chép mã tra cứu ${code}`);
    } catch {
      // ignore
    }
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
              Gửi yêu cầu sửa chữa kèm hình ảnh thực tế (tối đa 3 ảnh), theo dõi tiến độ kỹ thuật viên và đánh giá chất lượng phục vụ
            </p>
          </div>
          <Button
            icon={Plus}
            onClick={openCreateModal}
            disabled={!contract}
            className="shrink-0"
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
                const canRate = req.status === 'RESOLVED' && !req.rating;
                const hasRated = Number(req.rating) > 0;

                return (
                  <div
                    key={req.id}
                    className={`p-4 sm:p-5 rounded-xl border transition-all bg-white ${
                      req.status === 'RESOLVED' && !req.rating
                        ? 'border-emerald-300 bg-emerald-50/15'
                        : 'border-slate-200/90 hover:border-slate-300'
                    }`}
                  >
                    {/* Top Row: Tracking Code + Badges */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-3 border-b border-slate-100">
                      <div className="flex items-center gap-2 flex-wrap">
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
                        {req.apartment_code ? (
                          <span className="text-xs font-medium text-slate-600">
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

                    {/* Title & Description */}
                    <div className="py-3 space-y-1.5">
                      <h4 className="text-sm font-bold text-slate-900">
                        {req.title || `Báo hỏng ${SERVICE_REQUEST_CATEGORY[req.category] || req.category}`}
                      </h4>
                      <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-line">
                        {req.description}
                      </p>

                      {/* Attached Images via AuthImage */}
                      {imgs.length > 0 ? (
                        <div className="flex flex-wrap gap-2.5 pt-2">
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
                      ) : null}
                    </div>

                    {/* Footer: Technician Info / Resolution / Rating */}
                    <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-start justify-between gap-3 text-xs">
                      <div className="space-y-1 text-slate-500 min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 flex-wrap">
                          <UserCheck className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span>
                            Kỹ thuật phụ trách:{' '}
                            <strong className="text-slate-700">
                              {req.assigned_to_name || 'Đang điều phối nhân sự'}
                            </strong>
                          </span>
                          {req.resolved_at ? (
                            <span className="text-emerald-700 font-medium">
                              • Hoàn thành lúc: {formatDateTime(req.resolved_at)}
                            </span>
                          ) : null}
                        </p>
                        {req.resolution_note || req.internal_note ? (
                          <p className="flex items-start gap-1.5 text-emerald-700 whitespace-pre-line break-words">
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span>
                              Kết quả / Ghi chú xử lý: {req.resolution_note || req.internal_note}
                            </span>
                          </p>
                        ) : null}
                      </div>

                      <div className="shrink-0">
                        {canRate ? (
                          <Button
                            size="sm"
                            variant="warning"
                            icon={Star}
                            onClick={() => openRatingModal(req)}
                          >
                            Đánh giá 1–5 ★
                          </Button>
                        ) : hasRated ? (
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
            placeholder="Mô tả rõ vị trí, hiện tượng hư hỏng và khung giờ kỹ thuật viên có thể ghé kiểm tra..."
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

      {/* Cảnh báo 409 DUPLICATE_SERVICE_REQUEST (AC-004.2) */}
      <ConfirmDialog
        open={Boolean(duplicatePrompt)}
        onClose={() => setDuplicatePrompt(null)}
        onConfirm={handleForceCreateDuplicate}
        loading={submitting}
        variant="warning"
        title="Phát hiện yêu cầu cùng hạng mục đang mở"
        confirmLabel="Vẫn tiếp tục gửi mới"
        cancelLabel="Để tôi kiểm tra lại"
        message={
          duplicatePrompt
            ? `${duplicatePrompt.message}${
                duplicatePrompt.existingRequest?.title
                  ? ` (Tiêu đề hiện có: "${duplicatePrompt.existingRequest.title}")`
                  : ''
              }`
            : ''
        }
      />

      {/* Modal Đánh giá 1-5 Sao (★★★★★) */}
      <Modal
        open={Boolean(ratingTarget)}
        onClose={() => setRatingTarget(null)}
        title="Đánh giá chất lượng xử lý kỹ thuật"
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
              Gửi đánh giá
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
                    onMouseEnter={() => setHoverStars(star)}
                    onMouseLeave={() => setHoverStars(0)}
                    onClick={() => setRatingStars(star)}
                    className="p-1 transition-transform hover:scale-110 focus:outline-none"
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

      {/* Lightbox xem ảnh đính kèm */}
      <Modal
        open={Boolean(previewImg)}
        onClose={() => setPreviewImg(null)}
        title="Ảnh minh họa sự cố"
        size="lg"
      >
        {previewImg ? (
          <div className="flex items-center justify-center bg-slate-900/5 rounded-xl p-2">
            <AuthImage
              src={previewImg}
              alt="Ảnh sự cố"
              className="max-h-[70vh] w-auto rounded-lg object-contain"
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default MaintenanceTab;
