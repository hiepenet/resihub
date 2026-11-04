import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Wrench,
  Plus,
  LayoutGrid,
  List,
  Star,
  Clock,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  UserCheck,
  Building2,
  Phone,
  Play,
  Archive,
  XCircle,
  Eye,
  Copy,
  Check,
  ExternalLink,
  History,
  Lock,
  Sparkles,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { SearchBar } from '../../../components/common/SearchBar';
import { serviceRequestsService } from '../../../services/serviceRequests.service';
import { buildingsService } from '../../../services/buildings.service';
import { aiService } from '../../../services/ai.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import {
  APARTMENT_STATUS,
  SERVICE_REQUEST_STATUS,
  SERVICE_REQUEST_PRIORITY,
  SERVICE_REQUEST_CATEGORY,
  PREFERRED_SLOT_LABELS,
} from '../../../constants/statuses';
import { ROLE_LABELS } from '../../../constants/roles';
import { formatDateTime, formatRelativeTime } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';
import {
  formatConfidenceBadge,
  mapAiErrorToVietnamese,
  getAiTriageBadgeMeta,
  canOneClickApplyAiTriage,
} from '../../../utils/aiHelpers';
import {
  buildRoomMaintenanceZaloText,
  computeSlaBadgeMeta,
  parseZaloBoldSegments,
  copyZaloMessageToClipboard,
} from '../../../utils/zaloFormat';

const OPEN_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'];

const KANBAN_COLUMNS = [
  {
    status: 'NEW',
    title: 'Mới tiếp nhận',
    accent: 'border-t-sky-500',
    badgeVariant: 'sky',
    bgHeader: 'bg-sky-50/70',
  },
  {
    status: 'REOPENED',
    title: 'Mở lại xử lý',
    accent: 'border-t-rose-500',
    badgeVariant: 'red',
    bgHeader: 'bg-rose-50/70',
  },
  {
    status: 'ASSIGNED',
    title: 'Đã phân công',
    accent: 'border-t-indigo-500',
    badgeVariant: 'indigo',
    bgHeader: 'bg-indigo-50/70',
  },
  {
    status: 'IN_PROGRESS',
    title: 'Đang xử lý',
    accent: 'border-t-amber-500',
    badgeVariant: 'amber',
    bgHeader: 'bg-amber-50/70',
  },
  {
    status: 'ON_HOLD',
    title: 'Tạm hoãn / Hẹn lại',
    accent: 'border-t-purple-500',
    badgeVariant: 'purple',
    bgHeader: 'bg-purple-50/70',
  },
  {
    status: 'RESOLVED',
    title: 'Đã xử lý xong',
    accent: 'border-t-emerald-500',
    badgeVariant: 'emerald',
    bgHeader: 'bg-emerald-50/70',
  },
  {
    status: 'CLOSED',
    title: 'Đã đóng',
    accent: 'border-t-slate-400',
    badgeVariant: 'slate',
    bgHeader: 'bg-slate-100/80',
  },
  {
    status: 'CANCELLED',
    title: 'Đã hủy',
    accent: 'border-t-rose-400',
    badgeVariant: 'red',
    bgHeader: 'bg-rose-50/60',
  },
];

const CATEGORY_OPTIONS = Object.entries(SERVICE_REQUEST_CATEGORY).map(([value, label]) => ({
  value,
  label,
}));

const PRIORITY_OPTIONS = Object.entries(SERVICE_REQUEST_PRIORITY).map(([value, info]) => ({
  value,
  label: info.label,
}));

const STATUS_OPTIONS = Object.entries(SERVICE_REQUEST_STATUS).map(([value, info]) => ({
  value,
  label: info.label,
}));

const PREFERRED_SLOT_OPTIONS = [
  { value: 'ANYTIME', label: PREFERRED_SLOT_LABELS.ANYTIME },
  { value: 'MORNING_08_12', label: PREFERRED_SLOT_LABELS.MORNING_08_12 },
  { value: 'AFTERNOON_13_17', label: PREFERRED_SLOT_LABELS.AFTERNOON_13_17 },
  { value: 'EVENING_18_21', label: PREFERRED_SLOT_LABELS.EVENING_18_21 },
];

const AUDIT_ACTION_LABELS = {
  CREATE_SERVICE_REQUEST: 'Tạo yêu cầu báo hỏng',
  UPDATE_SERVICE_REQUEST: 'Cập nhật xử lý kỹ thuật',
  APPLY_SERVICE_REQUEST_TRIAGE: 'Duyệt / điều phối từ gợi ý AI',
  REOPEN_SERVICE_REQUEST: 'Cư dân yêu cầu xử lý lại',
  CANCEL_SERVICE_REQUEST: 'Hủy yêu cầu sửa chữa',
  RATE_SERVICE_REQUEST: 'Cư dân nghiệm thu & đánh giá sao',
  SLA_ESCALATION_SERVICE_REQUEST: 'Hệ thống cảnh báo quá hạn SLA',
};

function renderAiTriageBadge(triageStatus) {
  const meta = getAiTriageBadgeMeta(triageStatus);
  if (!meta) return null;
  return (
    <Badge variant={meta.variant}>
      {meta.sparkles ? <Sparkles className="w-3 h-3" /> : null} {meta.label}
    </Badge>
  );
}

function toLocalDateTimeInputValue(isoValue) {
  if (!isoValue) return '';
  const dt = new Date(isoValue);
  if (Number.isNaN(dt.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(
    dt.getHours()
  )}:${pad(dt.getMinutes())}`;
}

function StarRatingDisplay({ rating, size = 'sm' }) {
  const num = Number(rating || 0);
  if (!num) return null;
  const textCls = size === 'lg' ? 'text-base' : 'text-xs';
  return (
    <span className={`inline-flex items-center gap-1 font-medium text-amber-500 ${textCls}`}>
      <span className="tracking-tight">
        {'★'.repeat(num)}
        <span className="text-slate-300">{'★'.repeat(Math.max(0, 5 - num))}</span>
      </span>
      <span className="text-slate-600 text-xs font-semibold">({num}/5)</span>
    </span>
  );
}

export function ServiceRequestsPage() {
  const toast = useToast();
  const { canHandleMaintenance } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [viewMode, setViewMode] = useState('kanban'); // 'kanban' | 'table'
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  // Bộ lọc
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);

  // Modal tạo yêu cầu hộ cư dân
  const [createOpen, setCreateOpen] = useState(false);
  const [apartments, setApartments] = useState([]);
  const [creating, setCreating] = useState(false);
  const [mgrDuplicatePrompt, setMgrDuplicatePrompt] = useState(null);
  const [createForm, setCreateForm] = useState({
    apartment_id: '',
    category: 'ELECTRICAL',
    priority: 'NORMAL',
    location_detail: '',
    preferred_slot: 'ANYTIME',
    title: '',
    description: '',
    images: [],
  });

  // Slide-over Drawer chi tiết yêu cầu
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [applyingTriage, setApplyingTriage] = useState(false);
  const [rerunningAi, setRerunningAi] = useState(false);
  const [triageOverrideCategory, setTriageOverrideCategory] = useState('OTHER');
  const [aiTriageError, setAiTriageError] = useState(null);
  const [copiedRoomZalo, setCopiedRoomZalo] = useState(false);
  const [editState, setEditState] = useState({
    status: '',
    assigned_to: '',
    priority: 'NORMAL',
    resolution_note: '',
    resolution_images: [],
    hold_reason: '',
    next_appointment_at: '',
    internal_note: '',
  });
  const [previewImg, setPreviewImg] = useState(null);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await serviceRequestsService.list({
        building_id: selectedBuildingId || undefined,
        category: categoryFilter || undefined,
        priority: priorityFilter || undefined,
        status: statusFilter || undefined,
        overdue_sla: overdueOnly ? 'true' : undefined,
        search: search.trim() || undefined,
      });
      setRequests(res.data || []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách yêu cầu bảo trì.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, categoryFilter, priorityFilter, statusFilter, overdueOnly, search, toast]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRequests();
    }, 200);
    return () => clearTimeout(timer);
  }, [fetchRequests]);

  const stats = useMemo(() => {
    const total = requests.length;
    const newCount = requests.filter((r) => ['NEW', 'REOPENED'].includes(r.status)).length;
    const processingCount = requests.filter((r) =>
      ['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(r.status)
    ).length;
    const doneCount = requests.filter((r) => ['RESOLVED', 'CLOSED'].includes(r.status)).length;
    const overdueCount = requests.filter((r) => {
      if (r.is_sla_overdue) return true;
      return (
        computeSlaBadgeMeta({
          status: r.status,
          slaDueAt: r.sla_due_at,
          slaBreachedAt: r.sla_breached_at,
        }).state === 'OVERDUE'
      );
    }).length;
    const urgentCount = requests.filter(
      (r) => r.priority === 'URGENT' && OPEN_STATUSES.includes(r.status)
    ).length;
    return { total, newCount, processingCount, doneCount, overdueCount, urgentCount };
  }, [requests]);

  const groupedKanban = useMemo(() => {
    const map = {
      NEW: [],
      REOPENED: [],
      ASSIGNED: [],
      IN_PROGRESS: [],
      ON_HOLD: [],
      RESOLVED: [],
      CLOSED: [],
      CANCELLED: [],
    };
    for (const item of requests) {
      if (map[item.status]) {
        map[item.status].push(item);
      }
    }
    return map;
  }, [requests]);

  const syncEditStateFromDetail = (d) => {
    setEditState({
      status: d.status || 'NEW',
      assigned_to: d.assigned_to || '',
      priority: d.priority || 'NORMAL',
      resolution_note: d.resolution_note || '',
      resolution_images: Array.isArray(d.resolution_images) ? d.resolution_images : [],
      hold_reason: d.hold_reason || '',
      next_appointment_at: toLocalDateTimeInputValue(d.next_appointment_at),
      internal_note: d.internal_note || '',
    });
    setTriageOverrideCategory(d.ai_suggested_category || d.category || 'OTHER');
  };

  const openCreateModal = async () => {
    setCreateForm({
      apartment_id: '',
      category: 'ELECTRICAL',
      priority: 'NORMAL',
      location_detail: '',
      preferred_slot: 'ANYTIME',
      title: '',
      description: '',
      images: [],
    });
    setMgrDuplicatePrompt(null);
    setCreateOpen(true);
    try {
      const res = await buildingsService.listApartments({
        building_id: selectedBuildingId || undefined,
      });
      setApartments(res.data || []);
    } catch {
      setApartments([]);
    }
  };

  const submitCreatePayload = async (payload) => {
    setCreating(true);
    try {
      const res = await serviceRequestsService.create(payload);
      toast.success(res.message || 'Đã tạo yêu cầu bảo trì mới.');
      setMgrDuplicatePrompt(null);
      setCreateOpen(false);
      fetchRequests();
    } catch (err) {
      const status = err?.response?.status;
      const errData = err?.response?.data;
      if (status === 409 && errData?.code === 'DUPLICATE_SERVICE_REQUEST') {
        setMgrDuplicatePrompt({
          message: errData?.message || 'Căn hộ đang có yêu cầu cùng hạng mục trong 24 giờ qua.',
          existingRequest: errData?.existing_request || null,
          pendingPayload: payload,
        });
      } else {
        toast.error(extractErrorMessage(err, 'Lỗi khi tạo yêu cầu bảo trì.'));
      }
    } finally {
      setCreating(false);
    }
  };

  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    if (!createForm.apartment_id) {
      toast.warning('Vui lòng chọn căn hộ cần tạo yêu cầu bảo trì.');
      return;
    }
    if (!createForm.title.trim() || !createForm.description.trim()) {
      toast.warning('Vui lòng nhập đầy đủ tiêu đề và mô tả chi tiết sự cố.');
      return;
    }

    await submitCreatePayload({
      apartment_id: createForm.apartment_id,
      category: createForm.category,
      priority: createForm.priority,
      location_detail: createForm.location_detail.trim() || undefined,
      preferred_slot: createForm.preferred_slot || 'ANYTIME',
      title: createForm.title.trim(),
      description: createForm.description.trim(),
      images: createForm.images,
    });
  };

  const openDetailDrawer = async (id) => {
    setDrawerOpen(true);
    setDetailLoading(true);
    setCopiedRoomZalo(false);
    setAiTriageError(null);
    try {
      const res = await serviceRequestsService.getById(id);
      const d = res.data;
      setDetail(d);
      syncEditStateFromDetail(d);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải chi tiết yêu cầu.'));
      setDrawerOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleApplyAiSuggestionExact = async () => {
    if (!canHandleMaintenance || !detail) return;
    setApplyingTriage(true);
    setAiTriageError(null);
    try {
      const res = await serviceRequestsService.applyTriage(detail.id, {});
      toast.success(res.message || 'Đã áp dụng đề xuất phân loại & điều phối của AI.');
      const fresh = await serviceRequestsService.getById(detail.id);
      if (fresh?.data) {
        setDetail(fresh.data);
        syncEditStateFromDetail(fresh.data);
      }
      fetchRequests();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể áp dụng đề xuất AI.'));
    } finally {
      setApplyingTriage(false);
    }
  };

  const handleApplyAiWithOverride = async () => {
    if (!canHandleMaintenance || !detail) return;
    setApplyingTriage(true);
    setAiTriageError(null);
    try {
      const payload = {
        category: triageOverrideCategory || detail.category,
        priority: editState.priority || detail.priority,
        assigned_to: editState.assigned_to || detail.ai_suggested_assignee_id || null,
      };
      const res = await serviceRequestsService.applyTriage(detail.id, payload);
      toast.success(res.message || 'Đã áp dụng điều phối kèm chỉnh sửa của quản lý.');
      const fresh = await serviceRequestsService.getById(detail.id);
      if (fresh?.data) {
        setDetail(fresh.data);
        syncEditStateFromDetail(fresh.data);
      }
      fetchRequests();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể áp dụng điều chỉnh phân loại.'));
    } finally {
      setApplyingTriage(false);
    }
  };

  const handleRerunAiClassify = async () => {
    if (!canHandleMaintenance || !detail) return;
    setRerunningAi(true);
    setAiTriageError(null);
    try {
      await aiService.classifyServiceRequest({ service_request_id: detail.id });
      const fresh = await serviceRequestsService.getById(detail.id);
      if (fresh?.data) {
        setDetail(fresh.data);
        syncEditStateFromDetail(fresh.data);
      }
      fetchRequests();
      toast.success('AI đã cập nhật gợi ý phân loại & điều phối mới.');
    } catch (err) {
      setAiTriageError(mapAiErrorToVietnamese(err));
    } finally {
      setRerunningAi(false);
    }
  };

  const handleUpdateRequest = async (overrideStatus) => {
    if (!detail) return;
    const nextStatus = overrideStatus || editState.status;

    if (nextStatus === 'ON_HOLD' && (!editState.hold_reason || editState.hold_reason.trim().length < 3)) {
      setEditState((s) => ({ ...s, status: 'ON_HOLD' }));
      toast.warning('Vui lòng nhập lý do tạm hoãn / hẹn lại (tối thiểu 3 ký tự) trước khi lưu.');
      return;
    }

    setUpdating(true);
    try {
      const nextApptIso = editState.next_appointment_at
        ? new Date(editState.next_appointment_at).toISOString()
        : null;

      const res = await serviceRequestsService.updateStatus(detail.id, {
        status: nextStatus,
        assigned_to: editState.assigned_to || null,
        priority: editState.priority,
        resolution_note: editState.resolution_note,
        resolution_images: editState.resolution_images,
        hold_reason: editState.hold_reason,
        next_appointment_at: nextApptIso,
        internal_note: editState.internal_note,
      });
      toast.success(res.message || 'Cập nhật yêu cầu thành công.');
      const refreshed = await serviceRequestsService.getById(detail.id);
      setDetail(refreshed.data);
      syncEditStateFromDetail(refreshed.data);
      fetchRequests();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật yêu cầu bảo trì.'));
    } finally {
      setUpdating(false);
    }
  };

  const handleCopyRoomZalo = async () => {
    if (!detail) return;
    const text = buildRoomMaintenanceZaloText(detail);
    const ok = await copyZaloMessageToClipboard(text);
    if (ok) {
      setCopiedRoomZalo(true);
      setTimeout(() => setCopiedRoomZalo(false), 2500);
      toast.success('Đã sao chép tin nhắn cập nhật Zalo phòng (kèm chữ in đậm cho Zalo PC/Web)!');
    } else {
      toast.error('Không thể truy cập bộ nhớ tạm để sao chép.');
    }
  };

  const columns = useMemo(
    () => [
      {
        key: 'tracking_code',
        label: 'Mã tra cứu',
        sortable: true,
        render: (row) => (
          <div>
            <span className="font-mono text-xs font-semibold text-primary-700 bg-primary-50 px-2 py-0.5 rounded-md border border-primary-100">
              {row.tracking_code}
            </span>
            <p className="text-[11px] text-slate-400 mt-1">{formatRelativeTime(row.created_at)}</p>
          </div>
        ),
      },
      {
        key: 'apartment_code',
        label: 'Căn hộ / Người gửi',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-semibold text-slate-900">Căn {row.apartment_code}</p>
            <p className="text-xs text-slate-500 break-words max-w-[200px]">
              {row.building_code} — {row.building_name}
            </p>
            {row.requester_name ? (
              <p className="text-[11px] text-slate-600 mt-0.5">
                {row.requester_name}
                {row.requester_phone ? ` (${row.requester_phone})` : ''}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        key: 'title',
        label: 'Sự cố / Hạng mục',
        sortable: true,
        render: (row) => (
          <div className="max-w-xs">
            <p className="font-medium text-slate-900 break-words">{row.title}</p>
            <p className="text-xs text-slate-500 mt-0.5">
              {SERVICE_REQUEST_CATEGORY[row.category] || row.category}
              {row.location_detail ? ` • ${row.location_detail}` : ''}
            </p>
          </div>
        ),
      },
      {
        key: 'priority',
        label: 'Ưu tiên & SLA',
        align: 'center',
        sortable: true,
        render: (row) => {
          const sla = computeSlaBadgeMeta({
            status: row.status,
            slaDueAt: row.sla_due_at,
            slaBreachedAt: row.sla_breached_at,
          });
          return (
            <div className="flex flex-col items-center gap-1">
              <StatusBadge status={row.priority} domain="priority" />
              <Badge variant={sla.variant}>{sla.label}</Badge>
              {renderAiTriageBadge(row.ai_triage_status)}
            </div>
          );
        },
      },
      {
        key: 'assigned_to_name',
        label: 'Phụ trách',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) =>
          row.assigned_to_name ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700">
              <UserCheck className="w-3.5 h-3.5 text-indigo-500" />
              {row.assigned_to_name}
            </span>
          ) : (
            <span className="text-xs text-slate-400 italic">Chưa phân công</span>
          ),
      },
      {
        key: 'status',
        label: 'Trạng thái',
        align: 'center',
        sortable: true,
        render: (row) => <StatusBadge status={row.status} domain="service_request" />,
      },
      {
        key: 'rating',
        label: 'Đánh giá',
        align: 'center',
        sortable: true,
        render: (row) =>
          row.rating ? (
            <StarRatingDisplay rating={row.rating} />
          ) : (
            <span className="text-xs text-slate-400">—</span>
          ),
      },
      {
        key: 'actions',
        label: 'Thao tác',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => (
          <Button
            variant="ghost"
            size="xs"
            icon={Eye}
            onClick={(e) => {
              e.stopPropagation();
              openDetailDrawer(row.id);
            }}
          >
            Chi tiết
          </Button>
        ),
      },
    ],
    []
  );

  const detailSlaMeta = detail
    ? computeSlaBadgeMeta({
        status: detail.status,
        slaDueAt: detail.sla_due_at,
        slaBreachedAt: detail.sla_breached_at,
      })
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Yêu cầu & Báo hỏng Kỹ thuật"
        subtitle="Tiếp nhận, điều phối nhân sự bảo trì, kiểm soát cam kết SLA và đồng bộ tin nhắn nhóm Zalo phòng."
        actions={
          <>
            <div className="inline-flex items-center bg-white border border-slate-200 rounded-lg p-0.5 shadow-sm">
              <button
                type="button"
                onClick={() => setViewMode('kanban')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  viewMode === 'kanban'
                    ? 'bg-primary-500 text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                Bảng Kanban
              </button>
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  viewMode === 'table'
                    ? 'bg-primary-500 text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <List className="w-3.5 h-3.5" />
                Chế độ Bảng
              </button>
            </div>

            <Button variant="outline" size="md" icon={RefreshCw} onClick={fetchRequests}>
              Làm mới
            </Button>

            {canHandleMaintenance ? (
              <Button variant="primary" size="md" icon={Plus} onClick={openCreateModal}>
                Tạo yêu cầu hộ cư dân
              </Button>
            ) : null}
          </>
        }
      />

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Tổng yêu cầu"
          value={stats.total}
          subtext={
            stats.urgentCount > 0
              ? `${stats.urgentCount} sự cố KHẨN CẤP đang mở`
              : 'Tất cả sự cố ghi nhận'
          }
          icon={Wrench}
          color="sky"
        />
        <StatsCard
          title="Mới / Mở lại"
          value={stats.newCount}
          subtext={
            stats.overdueCount > 0
              ? `${stats.overdueCount} phiếu đang quá hạn SLA!`
              : 'Chờ tiếp nhận & phân công'
          }
          icon={AlertTriangle}
          color={stats.overdueCount > 0 ? 'red' : 'amber'}
        />
        <StatsCard
          title="Đang xử lý / Hẹn lại"
          value={stats.processingCount}
          subtext="Đã phân công / Đang sửa / Tạm hoãn"
          icon={Clock}
          color="indigo"
        />
        <StatsCard
          title="Đã hoàn thành"
          value={stats.doneCount}
          subtext="Đã xử lý xong & nghiệm thu"
          icon={CheckCircle2}
          color="emerald"
        />
      </div>

      {/* Bộ lọc */}
      <Card className="p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-12 gap-3">
          <div className="sm:col-span-2 xl:col-span-3">
            <SearchBar
              value={search}
              onChange={setSearch}
              placeholder="Tìm theo mã tra cứu (SR-...), căn hộ, tiêu đề, cư dân..."
            />
          </div>
          <Select
            containerClassName="xl:col-span-3"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            placeholder="Tất cả hạng mục"
            options={CATEGORY_OPTIONS}
          />
          <Select
            containerClassName="xl:col-span-3"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            placeholder="Tất cả mức ưu tiên"
            options={PRIORITY_OPTIONS}
          />
          <Select
            containerClassName="xl:col-span-3"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            placeholder="Tất cả trạng thái"
            options={STATUS_OPTIONS}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(e) => setOverdueOnly(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500"
            />
            <span className={overdueOnly ? 'text-rose-700 font-semibold' : ''}>
              Chỉ hiển thị phiếu đang Quá hạn SLA
            </span>
          </label>

          {(categoryFilter || priorityFilter || statusFilter || overdueOnly || search) ? (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setCategoryFilter('');
                setPriorityFilter('');
                setStatusFilter('');
                setOverdueOnly(false);
              }}
              className="text-xs text-primary-600 hover:text-primary-700 font-medium"
            >
              Xóa bộ lọc
            </button>
          ) : null}
        </div>
      </Card>

      {/* Nội dung chính: Kanban hoặc Bảng */}
      {viewMode === 'kanban' ? (
        loading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4">
            {KANBAN_COLUMNS.slice(0, 5).map((col) => (
              <div
                key={col.status}
                className="bg-slate-100/70 rounded-xl border border-slate-200 p-3 h-96 animate-pulse"
              />
            ))}
          </div>
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-3 items-start">
            {KANBAN_COLUMNS.map((col) => {
              const items = groupedKanban[col.status] || [];
              return (
                <div
                  key={col.status}
                  className={`min-w-[260px] flex-1 bg-slate-100/60 rounded-xl border border-slate-200/90 border-t-4 ${col.accent} flex flex-col max-h-[72vh]`}
                >
                  <div
                    className={`px-3.5 py-3 border-b border-slate-200/80 ${col.bgHeader} flex items-center justify-between rounded-t-lg`}
                  >
                    <span className="text-xs font-semibold text-slate-800 uppercase tracking-wide">
                      {col.title}
                    </span>
                    <Badge variant={col.badgeVariant}>{items.length}</Badge>
                  </div>

                  <div className="p-2.5 space-y-2.5 overflow-y-auto flex-1">
                    {items.length === 0 ? (
                      <div className="py-10 text-center text-xs text-slate-400">
                        Không có yêu cầu
                      </div>
                    ) : (
                      items.map((sr) => {
                        const slaMeta = computeSlaBadgeMeta({
                          status: sr.status,
                          slaDueAt: sr.sla_due_at,
                          slaBreachedAt: sr.sla_breached_at,
                        });
                        return (
                          <div
                            key={sr.id}
                            onClick={() => openDetailDrawer(sr.id)}
                            className={`bg-white rounded-xl border p-3.5 shadow-sm hover:shadow-md hover:border-primary-300 transition-all cursor-pointer space-y-2.5 ${
                              slaMeta.state === 'OVERDUE'
                                ? 'border-rose-300 ring-1 ring-rose-100'
                                : 'border-slate-200/90'
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-1.5">
                              <span className="font-mono text-[11px] font-semibold text-primary-700 bg-primary-50 px-2 py-0.5 rounded border border-primary-100 break-all">
                                {sr.tracking_code}
                              </span>
                              <StatusBadge status={sr.priority} domain="priority" dot={false} />
                            </div>

                            <div>
                              <h4
                                className="text-sm font-semibold text-slate-900 line-clamp-2 leading-snug break-words"
                                title={sr.title}
                              >
                                {sr.title}
                              </h4>
                              <p className="text-xs text-slate-500 mt-1">
                                {SERVICE_REQUEST_CATEGORY[sr.category] || sr.category}
                                {sr.location_detail ? ` • ${sr.location_detail}` : ''}
                              </p>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={slaMeta.variant}>{slaMeta.label}</Badge>
                              {renderAiTriageBadge(sr.ai_triage_status)}
                              {Number(sr.reopen_count) > 0 ? (
                                <Badge variant="red">Mở lại x{sr.reopen_count}</Badge>
                              ) : null}
                            </div>

                            <div className="flex items-center justify-between gap-2 text-xs text-slate-600 pt-1 border-t border-slate-100">
                              <div className="min-w-0">
                                <p className="font-semibold text-slate-800">
                                  Căn {sr.apartment_code}{' '}
                                  <span className="text-slate-400 font-normal">
                                    ({sr.building_code})
                                  </span>
                                </p>
                                {sr.requester_name ? (
                                  <p className="text-[11px] text-slate-500 break-words">
                                    {sr.requester_name}
                                  </p>
                                ) : null}
                              </div>
                              <span className="text-[11px] text-slate-400 shrink-0">
                                {formatRelativeTime(sr.created_at)}
                              </span>
                            </div>

                            <div className="flex flex-wrap items-center justify-between gap-2">
                              {sr.assigned_to_name ? (
                                <span className="inline-flex items-center gap-1 text-[11px] text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full font-medium break-words">
                                  <UserCheck className="w-3 h-3 shrink-0" />
                                  {sr.assigned_to_name}
                                </span>
                              ) : (
                                <span className="text-[11px] text-slate-400 italic">
                                  Chưa giao nhân sự
                                </span>
                              )}

                              {sr.rating ? <StarRatingDisplay rating={sr.rating} /> : null}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        <DataTable
          columns={columns}
          data={requests}
          loading={loading}
          onRowClick={(row) => openDetailDrawer(row.id)}
          emptyTitle="Không có yêu cầu kỹ thuật nào"
          emptyDescription="Chưa có yêu cầu báo hỏng hoặc bảo trì khớp với bộ lọc hiện tại."
        />
      )}

      {/* Modal tạo yêu cầu hộ cư dân */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Tạo yêu cầu bảo trì hộ cư dân"
        subtitle="Ghi nhận sự cố kỹ thuật trực tiếp tại quầy lễ tân hoặc qua hotline."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleCreateSubmit} loading={creating}>
              Tạo yêu cầu
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4">
          <Select
            label="Căn hộ gặp sự cố"
            required
            value={createForm.apartment_id}
            onChange={(e) => setCreateForm((s) => ({ ...s, apartment_id: e.target.value }))}
            placeholder="-- Chọn căn hộ --"
            options={apartments.map((a) => ({
              value: a.id,
              label: `${a.building_code ? `${a.building_code} - ` : ''}Căn ${a.code} (${
                APARTMENT_STATUS[a.status]?.label || a.status
              })`,
            }))}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Hạng mục kỹ thuật"
              required
              value={createForm.category}
              onChange={(e) => setCreateForm((s) => ({ ...s, category: e.target.value }))}
              options={CATEGORY_OPTIONS}
            />
            <Select
              label="Mức độ ưu tiên"
              required
              value={createForm.priority}
              onChange={(e) => setCreateForm((s) => ({ ...s, priority: e.target.value }))}
              options={PRIORITY_OPTIONS}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Vị trí cụ thể trong phòng"
              placeholder="VD: Nhà vệ sinh phụ, Ban công, Bếp..."
              value={createForm.location_detail}
              onChange={(e) => setCreateForm((s) => ({ ...s, location_detail: e.target.value }))}
            />
            <Select
              label="Khung giờ cư dân thuận tiện"
              value={createForm.preferred_slot}
              onChange={(e) => setCreateForm((s) => ({ ...s, preferred_slot: e.target.value }))}
              options={PREFERRED_SLOT_OPTIONS}
            />
          </div>

          <Input
            label="Tiêu đề sự cố"
            required
            placeholder="Ví dụ: Điều hòa phòng ngủ chính chảy nước, mất lạnh..."
            value={createForm.title}
            onChange={(e) => setCreateForm((s) => ({ ...s, title: e.target.value }))}
          />

          <Input
            label="Mô tả chi tiết tình trạng"
            required
            multiline
            rows={4}
            placeholder="Ghi rõ biểu hiện sự cố, ghi chú liên hệ để kỹ thuật viên kiểm tra..."
            value={createForm.description}
            onChange={(e) => setCreateForm((s) => ({ ...s, description: e.target.value }))}
          />

          <FileUpload
            label="Ảnh hiện trạng đính kèm (tối đa 3 ảnh)"
            multiple
            maxFiles={3}
            value={createForm.images}
            onChange={(imgs) => setCreateForm((s) => ({ ...s, images: imgs }))}
          />

          {mgrDuplicatePrompt ? (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 space-y-2 text-xs text-amber-900">
              <p className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                {mgrDuplicatePrompt.message}
              </p>
              <div className="flex flex-wrap gap-2">
                {mgrDuplicatePrompt.existingRequest?.id ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    onClick={() => {
                      const existingId = mgrDuplicatePrompt.existingRequest.id;
                      setMgrDuplicatePrompt(null);
                      setCreateOpen(false);
                      openDetailDrawer(existingId);
                    }}
                  >
                    Mở phiếu #{mgrDuplicatePrompt.existingRequest.tracking_code}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="xs"
                  variant="warning"
                  loading={creating}
                  onClick={() =>
                    submitCreatePayload({
                      ...mgrDuplicatePrompt.pendingPayload,
                      ignore_duplicate_warning: true,
                    })
                  }
                >
                  Vẫn tạo phiếu mới
                </Button>
              </div>
            </div>
          ) : null}
        </form>
      </Modal>

      {/* Slide-over chi tiết yêu cầu */}
      <Modal
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        variant="drawer"
        title={detail ? `Yêu cầu #${detail.tracking_code}` : 'Chi tiết yêu cầu bảo trì'}
        subtitle={
          detail
            ? `Căn ${detail.apartment_code} • ${detail.building_code} — ${detail.building_name}`
            : 'Đang tải thông tin...'
        }
        footer={
          canHandleMaintenance && detail ? (
            <>
              <Button variant="outline" onClick={() => setDrawerOpen(false)} disabled={updating}>
                Đóng
              </Button>
              <Button
                variant="primary"
                onClick={() => handleUpdateRequest()}
                loading={updating}
              >
                Lưu cập nhật
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setDrawerOpen(false)}>
              Đóng
            </Button>
          )
        }
      >
        {detailLoading || !detail ? (
          <div className="py-12 text-center text-sm text-slate-400">
            Đang tải chi tiết yêu cầu...
          </div>
        ) : (
          <div className="space-y-6">
            {/* Badges & Tiêu đề */}
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={detail.status} domain="service_request" />
                <StatusBadge status={detail.priority} domain="priority" />
                {detailSlaMeta ? (
                  <Badge variant={detailSlaMeta.variant}>{detailSlaMeta.label}</Badge>
                ) : null}
                <Badge variant="slate">
                  {SERVICE_REQUEST_CATEGORY[detail.category] || detail.category}
                </Badge>
                {renderAiTriageBadge(detail.ai_triage_status)}
                {Number(detail.reopen_count) > 0 ? (
                  <Badge variant="red">Đã mở lại {detail.reopen_count} lần</Badge>
                ) : null}
              </div>
              <h4 className="text-base font-semibold text-slate-900 leading-snug break-words">
                {detail.title}
              </h4>
            </div>

            {/* Hộp Trợ lý AI Phân loại & Điều phối (AI-03 — FR-043, US-011) */}
            {(detail.ai_triage_status && detail.ai_triage_status !== 'NONE') ||
            (canHandleMaintenance && OPEN_STATUSES.includes(detail.status)) ? (
              <div className="p-3.5 rounded-xl bg-amber-50/60 border-2 border-dashed border-amber-300/90 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-950">
                      <Sparkles className="w-4 h-4 text-amber-600" />
                      Trợ lý AI Phân loại &amp; Điều phối (AI-03)
                    </span>
                    {renderAiTriageBadge(detail.ai_triage_status)}
                    {detail.ai_confidence !== null && detail.ai_confidence !== undefined ? (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-white border border-amber-200 text-slate-700">
                        {formatConfidenceBadge(detail.ai_confidence, 0.65).label}
                      </span>
                    ) : null}
                  </div>

                  {canHandleMaintenance && OPEN_STATUSES.includes(detail.status) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      icon={RefreshCw}
                      loading={rerunningAi}
                      onClick={handleRerunAiClassify}
                    >
                      Chạy lại AI
                    </Button>
                  ) : null}
                </div>

                {detail.ai_summary ? (
                  <p className="text-xs text-slate-800 bg-white/90 border border-amber-200/80 rounded-lg px-3 py-2 leading-relaxed">
                    <strong>Tóm tắt AI:</strong> {detail.ai_summary}
                  </p>
                ) : null}

                {detail.ai_suggested_category ||
                detail.ai_suggested_priority ||
                detail.ai_suggested_assignee_name ? (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                    <div className="rounded-lg bg-white border border-amber-200/80 px-2.5 py-2">
                      <p className="text-[11px] text-slate-500">Hạng mục đề xuất</p>
                      <p className="font-semibold text-slate-900 mt-0.5">
                        {SERVICE_REQUEST_CATEGORY[detail.ai_suggested_category] ||
                          detail.ai_suggested_category ||
                          '—'}
                      </p>
                    </div>
                    <div className="rounded-lg bg-white border border-amber-200/80 px-2.5 py-2">
                      <p className="text-[11px] text-slate-500">Mức ưu tiên đề xuất</p>
                      <div className="mt-0.5">
                        {detail.ai_suggested_priority ? (
                          <StatusBadge status={detail.ai_suggested_priority} domain="priority" />
                        ) : (
                          <span className="font-semibold text-slate-700">—</span>
                        )}
                      </div>
                    </div>
                    <div className="rounded-lg bg-white border border-amber-200/80 px-2.5 py-2">
                      <p className="text-[11px] text-slate-500">Nhân sự gợi ý</p>
                      <p className="font-semibold text-slate-900 mt-0.5 break-words">
                        {detail.ai_suggested_assignee_name || 'Chưa gợi ý cụ thể'}
                      </p>
                    </div>
                  </div>
                ) : null}

                {getAiTriageBadgeMeta(detail.ai_triage_status)?.needsManualWarning ? (
                  <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span>
                      AI chưa đủ độ tin cậy hoặc tạm gián đoạn (AC-011.2) — hệ thống giữ nguyên phiếu và gắn cờ <strong>Cần phân loại thủ công</strong>. Vui lòng chọn hạng mục/mức ưu tiên bên dưới để điều phối.
                    </span>
                  </div>
                ) : null}

                {aiTriageError ? (
                  <div className="p-2.5 rounded-lg bg-amber-100/70 border border-amber-300 text-xs text-amber-950 space-y-0.5">
                    <p className="font-semibold">{aiTriageError.title}</p>
                    <p>{aiTriageError.guidance}</p>
                  </div>
                ) : null}

                {canHandleMaintenance && OPEN_STATUSES.includes(detail.status) ? (
                  <div className="pt-2 border-t border-amber-200/70 space-y-2.5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 items-end">
                      <Select
                        label="Hạng mục áp dụng / ghi đè"
                        value={triageOverrideCategory}
                        onChange={(e) => setTriageOverrideCategory(e.target.value)}
                        options={CATEGORY_OPTIONS}
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        {canOneClickApplyAiTriage(detail) ? (
                          <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            icon={CheckCircle2}
                            loading={applyingTriage}
                            onClick={handleApplyAiSuggestionExact}
                          >
                            Áp dụng đề xuất AI
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="soft"
                          size="sm"
                          loading={applyingTriage}
                          onClick={handleApplyAiWithOverride}
                        >
                          Áp dụng theo lựa chọn đang chỉnh
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Hộp tiện ích Đồng bộ Nhóm Zalo Phòng (FR-069) */}
            <div className="p-3.5 rounded-xl bg-sky-50/70 border border-sky-200/90 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <p className="text-xs font-bold text-sky-900">
                    Cập nhật tiến độ qua Nhóm Zalo Phòng
                  </p>
                  <p className="text-[11px] text-sky-700">
                    Tin nhắn tự động loại bỏ ghi chú nội bộ BQL để gửi an toàn cho cư dân.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    icon={copiedRoomZalo ? Check : Copy}
                    onClick={handleCopyRoomZalo}
                  >
                    {copiedRoomZalo ? 'Đã sao chép!' : 'Copy tin nhắn Zalo phòng'}
                  </Button>

                  {detail.apartment_zalo_group?.invite_link ? (
                    <a
                      href={detail.apartment_zalo_group.invite_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Mở nhóm Zalo phòng</span>
                    </a>
                  ) : null}
                </div>
              </div>
              {detail.apartment_zalo_group?.name ? (
                <p className="text-[11px] text-slate-600">
                  Nhóm liên kết: <strong>{detail.apartment_zalo_group.name}</strong>
                </p>
              ) : null}

              <div className="p-2.5 rounded-lg bg-white/90 border border-sky-200/80 text-xs text-slate-700 whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                {parseZaloBoldSegments(buildRoomMaintenanceZaloText(detail)).map((seg, idx) =>
                  seg.bold ? (
                    <strong key={idx} className="font-bold text-slate-950">
                      {seg.text}
                    </strong>
                  ) : (
                    <span key={idx}>{seg.text}</span>
                  )
                )}
              </div>
              <p className="text-[11px] text-sky-700">
                Mẹo trên Zalo PC / Zalo Web: nhấn <strong>Ctrl+V</strong> (hoặc chuột phải chọn <strong>Dán giữ định dạng</strong>) để giữ nguyên chữ in đậm.
              </p>
            </div>

            {/* Thông tin chung & SLA */}
            <div className="bg-slate-50 rounded-xl border border-slate-200/80 p-4 grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-slate-400">Mã tra cứu</p>
                <p className="font-mono font-semibold text-slate-800 mt-0.5">
                  {detail.tracking_code}
                </p>
              </div>
              <div>
                <p className="text-slate-400">Vị trí căn hộ</p>
                <p className="font-semibold text-slate-800 mt-0.5 flex items-center gap-1">
                  <Building2 className="w-3.5 h-3.5 text-primary-500 shrink-0" />
                  <span>
                    Căn {detail.apartment_code} ({detail.building_code})
                  </span>
                </p>
              </div>
              <div>
                <p className="text-slate-400">Vị trí trong phòng</p>
                <p className="font-medium text-slate-800 mt-0.5 break-words">
                  {detail.location_detail || 'Không ghi cụ thể'}
                </p>
              </div>
              <div>
                <p className="text-slate-400">Khung giờ cư dân hẹn</p>
                <p className="font-medium text-slate-800 mt-0.5">
                  {detail.preferred_slot
                    ? PREFERRED_SLOT_LABELS[detail.preferred_slot] || detail.preferred_slot
                    : 'Linh hoạt'}
                </p>
              </div>
              <div>
                <p className="text-slate-400">Người gửi yêu cầu</p>
                <p className="font-medium text-slate-800 mt-0.5">
                  {detail.requester_name || 'Ban quản lý'}
                </p>
                {detail.requester_phone ? (
                  <p className="text-slate-500 flex items-center gap-1 mt-0.5">
                    <Phone className="w-3 h-3" /> {detail.requester_phone}
                  </p>
                ) : null}
              </div>
              <div>
                <p className="text-slate-400">Thời điểm tiếp nhận</p>
                <p className="font-medium text-slate-800 mt-0.5">
                  {formatDateTime(detail.created_at)}
                </p>
              </div>
              {detail.sla_due_at ? (
                <div>
                  <p className="text-slate-400">Hạn hoàn thành SLA</p>
                  <p className="font-semibold text-slate-800 mt-0.5">
                    {formatDateTime(detail.sla_due_at)}
                  </p>
                </div>
              ) : null}
              {detail.first_responded_at ? (
                <div>
                  <p className="text-slate-400">Phản hồi đầu tiên</p>
                  <p className="font-medium text-slate-800 mt-0.5">
                    {formatDateTime(detail.first_responded_at)}
                  </p>
                </div>
              ) : null}
              {detail.resolved_at ? (
                <div className="col-span-2 pt-2 border-t border-slate-200/70 flex items-center justify-between">
                  <span className="text-slate-500">
                    Hoàn thành bởi:{' '}
                    <strong className="text-slate-800">
                      {detail.resolved_by_name || 'Kỹ thuật viên'}
                    </strong>
                  </span>
                  <span className="text-emerald-700 font-medium">
                    {formatDateTime(detail.resolved_at)}
                  </span>
                </div>
              ) : null}
            </div>

            {/* Mô tả sự cố & Lý do mở lại / hủy */}
            <div className="space-y-2">
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Mô tả chi tiết từ cư dân
              </h5>
              <div className="p-3.5 rounded-xl bg-white border border-slate-200 text-sm text-slate-700 whitespace-pre-line leading-relaxed break-words">
                {detail.description}
              </div>
              {detail.reopen_reason ? (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 break-words">
                  <strong>Lý do cư dân mở lại yêu cầu:</strong> {detail.reopen_reason}
                </div>
              ) : null}
              {detail.cancelled_reason ? (
                <div className="p-3 rounded-xl bg-slate-100 border border-slate-200 text-xs text-slate-700 break-words">
                  <strong>Lý do hủy phiếu:</strong> {detail.cancelled_reason}
                </div>
              ) : null}
            </div>

            {/* Ảnh hiện trạng ban đầu */}
            {Array.isArray(detail.images) && detail.images.length > 0 ? (
              <div className="space-y-2">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Ảnh hiện trạng ({detail.images.length})
                </h5>
                <div className="grid grid-cols-3 gap-2.5">
                  {detail.images.map((imgUrl, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setPreviewImg(imgUrl)}
                      className="aspect-square rounded-xl border border-slate-200 overflow-hidden bg-slate-100 hover:ring-2 hover:ring-primary-500 transition-all"
                    >
                      <AuthImage
                        src={imgUrl}
                        alt={`Ảnh sự cố ${idx + 1}`}
                        className="w-full h-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Đánh giá sao của cư dân */}
            <div className="space-y-2">
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Đánh giá chất lượng phục vụ
              </h5>
              {detail.rating ? (
                <div className="p-4 rounded-xl bg-amber-50/70 border border-amber-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <StarRatingDisplay rating={detail.rating} size="lg" />
                    <Badge variant="amber">
                      <Star className="w-3 h-3 fill-amber-500 text-amber-500" /> Phản hồi cư dân
                    </Badge>
                  </div>
                  {detail.rating_note ? (
                    <p className="text-sm text-slate-700 italic">“{detail.rating_note}”</p>
                  ) : (
                    <p className="text-xs text-slate-500">Cư dân không để lại nhận xét thêm.</p>
                  )}
                </div>
              ) : (
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70 text-xs text-slate-500">
                  Chưa có đánh giá từ cư dân (cư dân sẽ nghiệm thu 1–5 sao hoặc yêu cầu xử lý lại sau khi yêu cầu chuyển sang{' '}
                  <strong>Đã xử lý xong</strong>).
                </div>
              )}
            </div>

            {/* Khu vực chuyển trạng thái nhanh & Điều phối (MANAGER only) */}
            {canHandleMaintenance ? (
              <div className="space-y-4 pt-4 border-t border-slate-200">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                  Điều phối & Xử lý kỹ thuật
                </h5>

                {/* Nút chuyển nhanh trạng thái */}
                <div className="flex flex-wrap gap-2">
                  {['NEW', 'REOPENED'].includes(detail.status) ? (
                    <Button
                      size="xs"
                      variant="soft"
                      icon={UserCheck}
                      loading={updating}
                      onClick={() => handleUpdateRequest('ASSIGNED')}
                    >
                      Tiếp nhận / Phân công
                    </Button>
                  ) : null}
                  {['NEW', 'ASSIGNED', 'ON_HOLD', 'REOPENED'].includes(detail.status) ? (
                    <Button
                      size="xs"
                      variant="warning"
                      icon={Play}
                      loading={updating}
                      onClick={() => handleUpdateRequest('IN_PROGRESS')}
                    >
                      {detail.status === 'ON_HOLD' ? 'Tiếp tục xử lý' : 'Bắt đầu xử lý'}
                    </Button>
                  ) : null}
                  {['ASSIGNED', 'IN_PROGRESS', 'REOPENED'].includes(detail.status) ? (
                    <Button
                      size="xs"
                      variant="outline"
                      icon={Clock}
                      disabled={updating}
                      onClick={() => setEditState((s) => ({ ...s, status: 'ON_HOLD' }))}
                    >
                      Tạm hoãn / Hẹn lại
                    </Button>
                  ) : null}
                  {['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'].includes(detail.status) ? (
                    <Button
                      size="xs"
                      variant="success"
                      icon={CheckCircle2}
                      loading={updating}
                      onClick={() => handleUpdateRequest('RESOLVED')}
                    >
                      Đánh dấu Đã xử lý xong
                    </Button>
                  ) : null}
                  {detail.status === 'RESOLVED' ? (
                    <Button
                      size="xs"
                      variant="secondary"
                      icon={Archive}
                      loading={updating}
                      onClick={() => handleUpdateRequest('CLOSED')}
                    >
                      Nghiệm thu & Đóng yêu cầu
                    </Button>
                  ) : null}
                  {OPEN_STATUSES.includes(detail.status) ? (
                    <Button
                      size="xs"
                      variant="danger"
                      icon={XCircle}
                      loading={updating}
                      onClick={() => handleUpdateRequest('CANCELLED')}
                    >
                      Hủy yêu cầu
                    </Button>
                  ) : null}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Select
                    label="Trạng thái"
                    value={editState.status}
                    onChange={(e) => setEditState((s) => ({ ...s, status: e.target.value }))}
                    options={STATUS_OPTIONS}
                  />
                  <Select
                    label="Mức độ ưu tiên"
                    value={editState.priority}
                    onChange={(e) => setEditState((s) => ({ ...s, priority: e.target.value }))}
                    options={PRIORITY_OPTIONS}
                  />
                </div>

                <Select
                  label="Phân công nhân sự kỹ thuật / Quản lý"
                  value={editState.assigned_to}
                  onChange={(e) => setEditState((s) => ({ ...s, assigned_to: e.target.value }))}
                  placeholder="-- Chưa phân công --"
                  options={(detail.available_assignees || []).map((u) => ({
                    value: u.id,
                    label: `${u.full_name} — ${ROLE_LABELS[u.role_code] || u.role_code}${
                      u.phone ? ` (${u.phone})` : ''
                    }`,
                  }))}
                />

                {/* Khối Tạm hoãn / Hẹn lại (ON_HOLD) */}
                {(editState.status === 'ON_HOLD' || detail.hold_reason || detail.next_appointment_at) ? (
                  <div className="p-3.5 rounded-xl bg-purple-50/70 border border-purple-200 space-y-3">
                    <p className="text-xs font-bold text-purple-900">
                      Thông tin Tạm hoãn / Hẹn lịch kỹ thuật (hiển thị cho cư dân)
                    </p>
                    <Input
                      label="Lý do tạm hoãn / chờ vật tư"
                      required={editState.status === 'ON_HOLD'}
                      placeholder="VD: Chờ nhập van điện từ chính hãng, cư dân hẹn chiều thứ 7..."
                      value={editState.hold_reason}
                      onChange={(e) =>
                        setEditState((s) => ({ ...s, hold_reason: e.target.value }))
                      }
                    />
                    <Input
                      type="datetime-local"
                      label="Lịch hẹn xử lý tiếp theo (tùy chọn)"
                      value={editState.next_appointment_at}
                      onChange={(e) =>
                        setEditState((s) => ({ ...s, next_appointment_at: e.target.value }))
                      }
                    />
                  </div>
                ) : null}

                {/* Khối Kết quả xử lý gửi Cư dân (PUBLIC) */}
                <div className="p-3.5 rounded-xl bg-emerald-50/50 border border-emerald-200 space-y-3">
                  <p className="text-xs font-bold text-emerald-900">
                    Kết quả xử lý gửi cư dân (hiển thị công khai trên Cổng cư dân & tin nhắn Zalo)
                  </p>
                  <Input
                    label="Biên bản / Kết quả nghiệm thu gửi cư dân"
                    multiline
                    rows={3}
                    placeholder="VD: Đã vệ sinh dàn lạnh, bổ sung gas và kiểm tra nhiệt độ ổn định..."
                    value={editState.resolution_note}
                    onChange={(e) =>
                      setEditState((s) => ({ ...s, resolution_note: e.target.value }))
                    }
                  />
                  <FileUpload
                    label="Ảnh nghiệm thu sau sửa chữa (tối đa 3 ảnh)"
                    multiple
                    maxFiles={3}
                    value={editState.resolution_images}
                    onChange={(imgs) =>
                      setEditState((s) => ({ ...s, resolution_images: imgs }))
                    }
                  />
                </div>

                {/* Khối Ghi chú nội bộ BQL (CONFIDENTIAL - Review Focus #1) */}
                <div className="p-3.5 rounded-xl bg-amber-50/50 border border-amber-200 space-y-2">
                  <p className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                    <span>Ghi chú nội bộ BQL (Bảo mật — Cư dân KHÔNG xem được)</span>
                  </p>
                  <Input
                    multiline
                    rows={3}
                    placeholder="Ghi chú nội bộ chi phí vật tư kho, nhà thầu phụ, lưu ý vận hành..."
                    value={editState.internal_note}
                    onChange={(e) =>
                      setEditState((s) => ({ ...s, internal_note: e.target.value }))
                    }
                  />
                </div>
              </div>
            ) : (
              /* Chế độ chỉ đọc cho OWNER / SYS_ADMIN */
              <div className="space-y-4 pt-3 border-t border-slate-200">
                {(detail.hold_reason || detail.next_appointment_at) ? (
                  <div className="p-3.5 rounded-xl bg-purple-50/70 border border-purple-200 text-xs text-purple-900 space-y-1">
                    {detail.hold_reason ? (
                      <p>
                        <strong>Lý do tạm hoãn:</strong> {detail.hold_reason}
                      </p>
                    ) : null}
                    {detail.next_appointment_at ? (
                      <p>
                        <strong>Lịch hẹn tiếp theo:</strong>{' '}
                        {formatDateTime(detail.next_appointment_at)}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {detail.resolution_note ||
                (Array.isArray(detail.resolution_images) && detail.resolution_images.length > 0) ? (
                  <div className="space-y-2">
                    <h5 className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                      Kết quả xử lý gửi cư dân
                    </h5>
                    {detail.resolution_note ? (
                      <div className="p-3.5 rounded-xl bg-emerald-50/60 border border-emerald-200 text-sm text-emerald-900 whitespace-pre-line">
                        {detail.resolution_note}
                      </div>
                    ) : null}
                    {Array.isArray(detail.resolution_images) &&
                    detail.resolution_images.length > 0 ? (
                      <div className="grid grid-cols-3 gap-2.5">
                        {detail.resolution_images.map((imgUrl, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => setPreviewImg(imgUrl)}
                            className="aspect-square rounded-xl border border-emerald-200 overflow-hidden bg-emerald-50"
                          >
                            <AuthImage
                              src={imgUrl}
                              alt={`Ảnh nghiệm thu ${idx + 1}`}
                              className="w-full h-full object-cover"
                            />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {detail.internal_note ? (
                  <div className="space-y-1.5">
                    <h5 className="text-xs font-semibold uppercase tracking-wide text-amber-800 flex items-center gap-1">
                      <Lock className="w-3.5 h-3.5" />
                      Ghi chú nội bộ BQL
                    </h5>
                    <div className="p-3.5 rounded-xl bg-amber-50/50 border border-amber-200 text-sm text-slate-700 whitespace-pre-line">
                      {detail.internal_note}
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {/* Lịch sử xử lý (Audit Timeline) */}
            {Array.isArray(detail.audit_timeline) && detail.audit_timeline.length > 0 ? (
              <div className="space-y-2.5 pt-4 border-t border-slate-200">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-600 flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5" />
                  <span>Lịch sử xử lý ({detail.audit_timeline.length})</span>
                </h5>
                <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                  {detail.audit_timeline.map((log) => {
                    const prevSt = log.before?.status;
                    const nextSt = log.after?.status;
                    return (
                      <div
                        key={log.id}
                        className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 text-xs space-y-1"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-slate-800">
                            {AUDIT_ACTION_LABELS[log.action] || log.action}
                          </span>
                          <span className="text-[11px] text-slate-400">
                            {formatDateTime(log.created_at || log.at)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                          <span>
                            Thực hiện bởi: <strong>{log.actor_name || 'Hệ thống tự động'}</strong>
                          </span>
                          {nextSt ? (
                            <span className="font-mono text-slate-700">
                              {prevSt && prevSt !== nextSt ? `${prevSt} → ${nextSt}` : nextSt}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Modal>

      {/* Lightbox xem ảnh phóng to */}
      <Modal
        open={Boolean(previewImg)}
        onClose={() => setPreviewImg(null)}
        title="Xem ảnh đính kèm"
        size="lg"
      >
        {previewImg ? (
          <div className="flex items-center justify-center bg-slate-900 rounded-xl overflow-hidden max-h-[70vh]">
            <AuthImage
              src={previewImg}
              alt="Ảnh phóng to"
              className="max-h-[70vh] w-auto object-contain"
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default ServiceRequestsPage;
