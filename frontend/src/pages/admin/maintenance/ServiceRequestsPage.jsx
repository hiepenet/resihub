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
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import {
  SERVICE_REQUEST_STATUS,
  SERVICE_REQUEST_PRIORITY,
  SERVICE_REQUEST_CATEGORY,
} from '../../../constants/statuses';
import { ROLE_LABELS } from '../../../constants/roles';
import { formatDateTime, formatRelativeTime } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

const KANBAN_COLUMNS = [
  {
    status: 'NEW',
    title: 'Mới tiếp nhận',
    accent: 'border-t-sky-500',
    badgeVariant: 'sky',
    bgHeader: 'bg-sky-50/70',
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

  // Modal tạo yêu cầu hộ cư dân
  const [createOpen, setCreateOpen] = useState(false);
  const [apartments, setApartments] = useState([]);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({
    apartment_id: '',
    category: 'ELECTRICAL',
    priority: 'NORMAL',
    title: '',
    description: '',
    images: [],
  });

  // Slide-over Drawer chi tiết yêu cầu
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [editState, setEditState] = useState({
    status: '',
    assigned_to: '',
    priority: 'NORMAL',
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
        search: search.trim() || undefined,
      });
      setRequests(res.data || []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách yêu cầu bảo trì.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, categoryFilter, priorityFilter, statusFilter, search, toast]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRequests();
    }, 200);
    return () => clearTimeout(timer);
  }, [fetchRequests]);

  const stats = useMemo(() => {
    const total = requests.length;
    const newCount = requests.filter((r) => r.status === 'NEW').length;
    const processingCount = requests.filter((r) =>
      ['ASSIGNED', 'IN_PROGRESS'].includes(r.status)
    ).length;
    const doneCount = requests.filter((r) => ['RESOLVED', 'CLOSED'].includes(r.status)).length;
    const urgentCount = requests.filter(
      (r) => r.priority === 'URGENT' && !['RESOLVED', 'CLOSED', 'CANCELLED'].includes(r.status)
    ).length;
    return { total, newCount, processingCount, doneCount, urgentCount };
  }, [requests]);

  const groupedKanban = useMemo(() => {
    const map = {
      NEW: [],
      ASSIGNED: [],
      IN_PROGRESS: [],
      RESOLVED: [],
      CLOSED: [],
    };
    for (const item of requests) {
      if (map[item.status]) {
        map[item.status].push(item);
      }
    }
    return map;
  }, [requests]);

  const openCreateModal = async () => {
    setCreateForm({
      apartment_id: '',
      category: 'ELECTRICAL',
      priority: 'NORMAL',
      title: '',
      description: '',
      images: [],
    });
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

    setCreating(true);
    try {
      const res = await serviceRequestsService.create({
        apartment_id: createForm.apartment_id,
        category: createForm.category,
        priority: createForm.priority,
        title: createForm.title.trim(),
        description: createForm.description.trim(),
        images: createForm.images,
      });
      toast.success(res.message || 'Đã tạo yêu cầu bảo trì mới.');
      setCreateOpen(false);
      fetchRequests();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Lỗi khi tạo yêu cầu bảo trì.'));
    } finally {
      setCreating(false);
    }
  };

  const openDetailDrawer = async (id) => {
    setDrawerOpen(true);
    setDetailLoading(true);
    try {
      const res = await serviceRequestsService.getById(id);
      const d = res.data;
      setDetail(d);
      setEditState({
        status: d.status || 'NEW',
        assigned_to: d.assigned_to || '',
        priority: d.priority || 'NORMAL',
        internal_note: d.internal_note || '',
      });
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải chi tiết yêu cầu.'));
      setDrawerOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleUpdateRequest = async (overrideStatus) => {
    if (!detail) return;
    const nextStatus = overrideStatus || editState.status;
    setUpdating(true);
    try {
      const res = await serviceRequestsService.updateStatus(detail.id, {
        status: nextStatus,
        assigned_to: editState.assigned_to || null,
        priority: editState.priority,
        internal_note: editState.internal_note,
      });
      toast.success(res.message || 'Cập nhật yêu cầu thành công.');
      const refreshed = await serviceRequestsService.getById(detail.id);
      setDetail(refreshed.data);
      setEditState({
        status: refreshed.data.status,
        assigned_to: refreshed.data.assigned_to || '',
        priority: refreshed.data.priority,
        internal_note: refreshed.data.internal_note || '',
      });
      fetchRequests();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật yêu cầu bảo trì.'));
    } finally {
      setUpdating(false);
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
        label: 'Căn hộ',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-semibold text-slate-900">Căn {row.apartment_code}</p>
            <p className="text-xs text-slate-500">
              {row.building_code} — {row.building_name}
            </p>
          </div>
        ),
      },
      {
        key: 'title',
        label: 'Sự cố / Hạng mục',
        sortable: true,
        render: (row) => (
          <div className="max-w-xs">
            <p className="font-medium text-slate-900 truncate">{row.title}</p>
            <p className="text-xs text-slate-500 mt-0.5">
              {SERVICE_REQUEST_CATEGORY[row.category] || row.category}
            </p>
          </div>
        ),
      },
      {
        key: 'priority',
        label: 'Ưu tiên',
        align: 'center',
        sortable: true,
        render: (row) => <StatusBadge status={row.priority} domain="priority" />,
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Yêu cầu & Báo hỏng Kỹ thuật"
        subtitle="Tiếp nhận, điều phối nhân sự bảo trì và theo dõi chất lượng xử lý SLA theo thời gian thực."
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
                Kanban 5 cột
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
          subtext={stats.urgentCount > 0 ? `${stats.urgentCount} sự cố KHẨN CẤP đang mở` : 'Tất cả sự cố ghi nhận'}
          icon={Wrench}
          color="sky"
        />
        <StatsCard
          title="Mới tiếp nhận"
          value={stats.newCount}
          subtext="Chờ phân công kỹ thuật viên"
          icon={AlertTriangle}
          color="amber"
        />
        <StatsCard
          title="Đang xử lý"
          value={stats.processingCount}
          subtext="Đã giao nhân sự / Đang sửa chữa"
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
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="lg:col-span-2">
            <SearchBar
              value={search}
              onChange={setSearch}
              placeholder="Tìm theo mã tra cứu (SR-...), căn hộ, tiêu đề, cư dân..."
            />
          </div>
          <Select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            placeholder="Tất cả hạng mục"
            options={CATEGORY_OPTIONS}
          />
          <Select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            placeholder="Tất cả mức ưu tiên"
            options={PRIORITY_OPTIONS}
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            placeholder="Tất cả trạng thái"
            options={STATUS_OPTIONS}
          />
        </div>
      </Card>

      {/* Nội dung chính: Kanban hoặc Bảng */}
      {viewMode === 'kanban' ? (
        loading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4">
            {KANBAN_COLUMNS.map((col) => (
              <div
                key={col.status}
                className="bg-slate-100/70 rounded-xl border border-slate-200 p-3 h-96 animate-pulse"
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 items-start">
            {KANBAN_COLUMNS.map((col) => {
              const items = groupedKanban[col.status] || [];
              return (
                <div
                  key={col.status}
                  className={`bg-slate-100/60 rounded-xl border border-slate-200/90 border-t-4 ${col.accent} flex flex-col max-h-[72vh]`}
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
                      items.map((sr) => (
                        <div
                          key={sr.id}
                          onClick={() => openDetailDrawer(sr.id)}
                          className="bg-white rounded-xl border border-slate-200/90 p-3.5 shadow-sm hover:shadow-md hover:border-primary-300 transition-all cursor-pointer space-y-2.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[11px] font-semibold text-primary-700 bg-primary-50 px-2 py-0.5 rounded border border-primary-100 truncate">
                              {sr.tracking_code}
                            </span>
                            <StatusBadge status={sr.priority} domain="priority" dot={false} />
                          </div>

                          <div>
                            <h4 className="text-sm font-semibold text-slate-900 line-clamp-2 leading-snug">
                              {sr.title}
                            </h4>
                            <p className="text-xs text-slate-500 mt-1">
                              {SERVICE_REQUEST_CATEGORY[sr.category] || sr.category}
                            </p>
                          </div>

                          <div className="flex items-center justify-between text-xs text-slate-600 pt-1 border-t border-slate-100">
                            <span className="font-semibold text-slate-800">
                              Căn {sr.apartment_code}{' '}
                              <span className="text-slate-400 font-normal">({sr.building_code})</span>
                            </span>
                            <span className="text-[11px] text-slate-400">
                              {formatRelativeTime(sr.created_at)}
                            </span>
                          </div>

                          <div className="flex items-center justify-between gap-2">
                            {sr.assigned_to_name ? (
                              <span className="inline-flex items-center gap-1 text-[11px] text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full font-medium truncate max-w-[150px]">
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
                      ))
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
              label: `${a.building_code ? `${a.building_code} - ` : ''}Căn ${a.code} (${a.status})`,
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
            placeholder="Ghi rõ vị trí hỏng, biểu hiện sự cố, khung giờ cư dân có nhà để kỹ thuật viên kiểm tra..."
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
                <Badge variant="slate">
                  {SERVICE_REQUEST_CATEGORY[detail.category] || detail.category}
                </Badge>
              </div>
              <h4 className="text-base font-semibold text-slate-900 leading-snug">
                {detail.title}
              </h4>
            </div>

            {/* Thông tin chung */}
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
                  <Building2 className="w-3.5 h-3.5 text-primary-500" />
                  Căn {detail.apartment_code} ({detail.building_code})
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

            {/* Mô tả sự cố */}
            <div className="space-y-1.5">
              <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Mô tả chi tiết từ cư dân
              </h5>
              <div className="p-3.5 rounded-xl bg-white border border-slate-200 text-sm text-slate-700 whitespace-pre-line leading-relaxed">
                {detail.description}
              </div>
            </div>

            {/* Ảnh đính kèm */}
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
                  Chưa có đánh giá từ cư dân (cư dân sẽ đánh giá 1–5 sao sau khi yêu cầu chuyển sang
                  trạng thái <strong>Đã xử lý xong</strong>).
                </div>
              )}
            </div>

            {/* Khu vực chuyển trạng thái nhanh & Điều phối */}
            {canHandleMaintenance ? (
              <div className="space-y-4 pt-4 border-t border-slate-200">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                  Điều phối & Xử lý kỹ thuật
                </h5>

                {/* Nút chuyển nhanh trạng thái */}
                <div className="flex flex-wrap gap-2">
                  {detail.status === 'NEW' ? (
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
                  {['NEW', 'ASSIGNED'].includes(detail.status) ? (
                    <Button
                      size="xs"
                      variant="warning"
                      icon={Play}
                      loading={updating}
                      onClick={() => handleUpdateRequest('IN_PROGRESS')}
                    >
                      Bắt đầu xử lý
                    </Button>
                  ) : null}
                  {['ASSIGNED', 'IN_PROGRESS'].includes(detail.status) ? (
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
                  {!['CLOSED', 'CANCELLED'].includes(detail.status) ? (
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

                <Input
                  label="Ghi chú nội bộ Ban quản lý / Biên bản xử lý"
                  multiline
                  rows={3}
                  placeholder="Ghi nhận nguyên nhân sự cố, vật tư thay thế hoặc hướng xử lý..."
                  value={editState.internal_note}
                  onChange={(e) =>
                    setEditState((s) => ({ ...s, internal_note: e.target.value }))
                  }
                />
              </div>
            ) : detail.internal_note ? (
              <div className="space-y-1.5">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Ghi chú nội bộ kỹ thuật
                </h5>
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-sm text-slate-700">
                  {detail.internal_note}
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
