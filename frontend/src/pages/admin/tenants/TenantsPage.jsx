import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Users,
  UserPlus,
  UserCheck,
  Clock,
  UserMinus,
  Eye,
  Edit3,
  GitMerge,
  Phone,
  Mail,
  CreditCard,
  Globe,
  Building2,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
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
import { tenantsService } from '../../../services/tenants.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { toInputDate, maskIdNumber } from '../../../utils/format';
import {
  isValidPhone,
  normalizePhone,
  isValidEmail,
  isValidIdNumber,
  extractErrorMessage,
} from '../../../utils/validation';

function getAvatarLetters(fullName) {
  if (!fullName) return 'CD';
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'CD';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function getTenantDisplayStatus(tenant) {
  if (!tenant) return 'INACTIVE';
  if (tenant.status === 'MERGED' || tenant.status === 'REJECTED' || tenant.status === 'INACTIVE' || tenant.status === 'MOVED_OUT') {
    return 'INACTIVE';
  }
  if (tenant.active_contract || tenant.status === 'ACTIVE') {
    return 'ACTIVE';
  }
  if (tenant.status === 'PENDING') {
    return 'PENDING';
  }
  return 'INACTIVE';
}

const INITIAL_FORM = {
  full_name: '',
  phone: '',
  email: '',
  id_number: '',
  dob: '',
  nationality: 'Việt Nam',
  address: '',
  password: '',
};

const STATUS_FILTER_OPTIONS = [
  { value: 'ACTIVE', label: 'Đang thuê (ACTIVE)' },
  { value: 'PENDING', label: 'Chờ nhận phòng / Duyệt hồ sơ (PENDING)' },
  { value: 'INACTIVE', label: 'Đã trả phòng / Chưa thuê (INACTIVE)' },
];

const TYPE_FILTER_OPTIONS = [
  { value: 'primary', label: 'Khách đứng tên HĐ' },
  { value: 'occupant', label: 'Thành viên ở cùng' },
];

export function TenantsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { canManageTenants, isSysAdmin } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [showMerged, setShowMerged] = useState(false);

  // Create Modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(INITIAL_FORM);
  const [createErrors, setCreateErrors] = useState({});
  const [submittingCreate, setSubmittingCreate] = useState(false);
  const [dupChecking, setDupChecking] = useState(false);
  const [dupInfo, setDupInfo] = useState({ isDuplicate: false, inScope: true, duplicates: [], message: '' });

  // Edit Modal state
  const [editOpen, setEditOpen] = useState(false);
  const [editingTenant, setEditingTenant] = useState(null);
  const [editForm, setEditForm] = useState(INITIAL_FORM);
  const [editErrors, setEditErrors] = useState({});
  const [submittingEdit, setSubmittingEdit] = useState(false);

  // Merge Modal state
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeForm, setMergeForm] = useState({
    source_tenant_id: '',
    target_tenant_id: '',
    reason: 'Gộp hồ sơ cư dân trùng thông tin liên hệ / CCCD',
  });
  const [submittingMerge, setSubmittingMerge] = useState(false);

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    try {
      const res = await tenantsService.list();
      setTenants(Array.isArray(res?.data) ? res.data : []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách cư dân.'));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchTenants();
  }, [fetchTenants]);

  // Realtime check-dup trong Modal Tạo cư dân mới
  useEffect(() => {
    if (!createOpen) {
      setDupInfo({ isDuplicate: false, inScope: true, duplicates: [], message: '' });
      return undefined;
    }

    const cleanPhone = normalizePhone(createForm.phone);
    const cleanId = String(createForm.id_number || '').trim();
    const shouldCheckPhone = cleanPhone.length === 10;
    const shouldCheckId = cleanId.length >= 9;

    if (!shouldCheckPhone && !shouldCheckId) {
      setDupInfo({ isDuplicate: false, inScope: true, duplicates: [], message: '' });
      return undefined;
    }

    const timer = setTimeout(async () => {
      setDupChecking(true);
      try {
        const params = {};
        if (shouldCheckPhone) params.phone = cleanPhone;
        if (shouldCheckId) params.id_number = cleanId;
        const res = await tenantsService.checkDup(params);
        setDupInfo({
          isDuplicate: Boolean(res?.isDuplicate),
          inScope: res?.inScope !== false,
          duplicates: Array.isArray(res?.duplicates) ? res.duplicates : [],
          message: res?.message || '',
        });
      } catch {
        // Không chặn thao tác nếu check-dup tạm thời lỗi mạng
      } finally {
        setDupChecking(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [createOpen, createForm.phone, createForm.id_number]);

  const scopedTenants = useMemo(() => {
    return tenants.filter((t) => {
      if (!showMerged && t.status === 'MERGED') return false;
      if (selectedBuildingId && t.active_contract?.building_id) {
        if (String(t.active_contract.building_id) !== String(selectedBuildingId)) {
          return false;
        }
      }
      return true;
    });
  }, [tenants, showMerged, selectedBuildingId]);

  const stats = useMemo(() => {
    const activeTenants = tenants.filter((t) => t.status !== 'MERGED');
    let activeCount = 0;
    let pendingCount = 0;
    let inactiveCount = 0;

    activeTenants.forEach((t) => {
      const st = getTenantDisplayStatus(t);
      if (st === 'ACTIVE') activeCount += 1;
      else if (st === 'PENDING') pendingCount += 1;
      else inactiveCount += 1;
    });

    return {
      total: activeTenants.length,
      activeCount,
      pendingCount,
      inactiveCount,
    };
  }, [tenants]);

  const filteredTenants = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scopedTenants.filter((t) => {
      const displayStatus = getTenantDisplayStatus(t);
      if (statusFilter && displayStatus !== statusFilter) return false;
      if (typeFilter && t.type !== typeFilter) return false;

      if (q) {
        const haystacks = [
          t.full_name,
          t.phone,
          t.id_number,
          t.email,
          t.nationality,
          t.active_contract?.apartment_code,
          t.active_contract?.building_name,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystacks.includes(q)) return false;
      }
      return true;
    });
  }, [scopedTenants, statusFilter, typeFilter, search]);

  const mergeableTenants = useMemo(
    () => tenants.filter((t) => t.status !== 'MERGED'),
    [tenants]
  );

  const validatePersonForm = (form) => {
    const errs = {};
    if (!String(form.full_name || '').trim()) {
      errs.full_name = 'Vui lòng nhập họ và tên cư dân.';
    }
    if (!String(form.phone || '').trim()) {
      errs.phone = 'Vui lòng nhập số điện thoại.';
    } else if (!isValidPhone(form.phone)) {
      errs.phone = 'Số điện thoại không đúng định dạng Việt Nam (10 số).';
    }
    if (form.email && !isValidEmail(form.email)) {
      errs.email = 'Địa chỉ email không hợp lệ.';
    }
    if (form.id_number && !isValidIdNumber(form.id_number)) {
      errs.id_number = 'CCCD/CMND (9 hoặc 12 số) hoặc Hộ chiếu không hợp lệ.';
    }
    if (form.password && form.password.length < 8) {
      errs.password = 'Mật khẩu đăng nhập ban đầu phải từ 8 ký tự trở lên.';
    }
    return errs;
  };

  const handleOpenCreate = () => {
    setCreateForm(INITIAL_FORM);
    setCreateErrors({});
    setDupInfo({ isDuplicate: false, inScope: true, duplicates: [], message: '' });
    setCreateOpen(true);
  };

  const handleCreateSubmit = async (e) => {
    e?.preventDefault();
    if (dupInfo.isDuplicate) {
      toast.warning(
        'Phát hiện trùng SĐT hoặc CCCD (FR-021) — hệ thống chặn tạo mới bản ghi trùng. Vui lòng xem hồ sơ hiện có hoặc thực hiện Gộp hồ sơ.'
      );
      return;
    }
    const errs = validatePersonForm(createForm);
    setCreateErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmittingCreate(true);
    try {
      const payload = {
        full_name: createForm.full_name.trim(),
        phone: normalizePhone(createForm.phone),
        email: createForm.email.trim() || null,
        id_number: createForm.id_number.trim() || null,
        dob: createForm.dob || null,
        address: createForm.address.trim() || null,
        nationality: createForm.nationality.trim() || 'Việt Nam',
        ...(createForm.password ? { password: createForm.password } : {}),
      };
      const res = await tenantsService.create(payload);
      toast.success(res?.message || 'Tạo hồ sơ cư dân thành công.');
      setCreateOpen(false);
      fetchTenants();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tạo hồ sơ cư dân.'));
    } finally {
      setSubmittingCreate(false);
    }
  };

  const handleOpenEdit = (tenant, e) => {
    e?.stopPropagation();
    setEditingTenant(tenant);
    setEditForm({
      full_name: tenant.full_name || '',
      phone: tenant.phone || '',
      email: tenant.email || '',
      id_number: tenant.id_number || '',
      dob: toInputDate(tenant.dob),
      nationality: tenant.nationality || 'Việt Nam',
      address: tenant.address || '',
    });
    setEditErrors({});
    setEditOpen(true);
  };

  const handleEditSubmit = async (e) => {
    e?.preventDefault();
    if (!editingTenant) return;
    const errs = validatePersonForm(editForm);
    setEditErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmittingEdit(true);
    try {
      const payload = {
        full_name: editForm.full_name.trim(),
        phone: normalizePhone(editForm.phone),
        email: editForm.email.trim() || null,
        id_number: editForm.id_number.trim() || null,
        dob: editForm.dob || null,
        address: editForm.address.trim() || null,
        nationality: editForm.nationality.trim() || 'Việt Nam',
      };
      const res = await tenantsService.update(editingTenant.id, payload);
      toast.success(res?.message || 'Cập nhật hồ sơ cư dân thành công.');
      setEditOpen(false);
      fetchTenants();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật thông tin cư dân.'));
    } finally {
      setSubmittingEdit(false);
    }
  };

  const handleOpenMerge = (sourceTenant = null, e = null, targetTenantId = '') => {
    e?.stopPropagation();
    setMergeForm({
      source_tenant_id: sourceTenant?.id || '',
      target_tenant_id: targetTenantId || '',
      reason: 'Gộp hồ sơ cư dân bị trùng thông tin SĐT / CCCD',
    });
    setMergeOpen(true);
  };

  const handleMergeSubmit = async (e) => {
    e?.preventDefault();
    if (!mergeForm.source_tenant_id || !mergeForm.target_tenant_id) {
      toast.warning('Vui lòng chọn đầy đủ hồ sơ cần gộp (nguồn) và hồ sơ chính giữ lại (đích).');
      return;
    }
    if (mergeForm.source_tenant_id === mergeForm.target_tenant_id) {
      toast.warning('Hồ sơ nguồn và hồ sơ đích không được trùng nhau.');
      return;
    }
    if (!mergeForm.reason || !mergeForm.reason.trim()) {
      toast.warning('Vui lòng nhập lý do gộp hồ sơ để lưu vết kiểm toán (FR-021).');
      return;
    }

    setSubmittingMerge(true);
    try {
      const res = await tenantsService.merge({
        source_tenant_id: mergeForm.source_tenant_id,
        target_tenant_id: mergeForm.target_tenant_id,
        reason: mergeForm.reason.trim(),
      });
      toast.success(res?.message || 'Đã gộp hồ sơ cư dân thành công.');
      setMergeOpen(false);
      fetchTenants();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gộp hồ sơ cư dân.'));
    } finally {
      setSubmittingMerge(false);
    }
  };

  const columns = useMemo(
    () => [
      {
        key: 'full_name',
        label: 'Cư dân',
        sortable: true,
        render: (row) => (
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-primary-50 text-primary-700 border border-primary-200 flex items-center justify-center text-xs font-bold shrink-0">
              {getAvatarLetters(row.full_name)}
            </div>
            <div className="min-w-0 max-w-[180px]">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold text-slate-900 truncate">{row.full_name}</span>
                {row.type === 'occupant' ? (
                  <Badge variant="indigo" className="text-[10px] px-1.5 py-0">
                    Ở cùng
                  </Badge>
                ) : null}
                {row.is_shared_profile ? (
                  <Badge variant="sky" className="text-[10px] px-1.5 py-0">
                    Liên tòa
                  </Badge>
                ) : null}
                {row.status === 'MERGED' ? (
                  <Badge variant="slate" className="text-[10px] px-1.5 py-0">
                    Đã gộp
                  </Badge>
                ) : null}
              </div>
              <p className="text-xs text-slate-500 truncate mt-0.5">{row.email || 'Chưa có email'}</p>
            </div>
          </div>
        ),
      },
      {
        key: 'phone',
        label: 'Số điện thoại',
        sortable: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="inline-flex items-center gap-1.5 font-medium text-slate-700 whitespace-nowrap">
            <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            {row.phone || '—'}
          </span>
        ),
      },
      {
        key: 'id_number',
        label: 'CCCD / Hộ chiếu',
        align: 'center',
        sortable: true,
        className: 'whitespace-nowrap',
        render: (row) =>
          row.id_number ? (
            <span
              className="font-mono text-xs bg-slate-100 text-slate-800 px-2 py-1 rounded-md border border-slate-200 whitespace-nowrap"
              title="Dữ liệu nhạy cảm PII được che một phần trên danh sách (PRD 13.5)"
            >
              {maskIdNumber(row.id_number)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-amber-600 font-medium whitespace-nowrap">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Thiếu giấy tờ
            </span>
          ),
      },
      {
        key: 'nationality',
        label: 'Quốc tịch',
        align: 'center',
        sortable: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="text-sm text-slate-700">{row.nationality || 'Việt Nam'}</span>
        ),
      },
      {
        key: 'active_contract',
        label: 'Căn / Tòa hiện tại',
        align: 'center',
        render: (row) => {
          const ac = row.active_contract;
          if (!ac) {
            return <span className="text-xs text-slate-400 italic whitespace-nowrap">Chưa có HĐ hiệu lực</span>;
          }
          return (
            <div onClick={(e) => e.stopPropagation()}>
              <Link
                to={`/admin/contracts/${ac.contract_id}`}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary-600 hover:text-primary-700 bg-primary-50/70 hover:bg-primary-50 px-2 py-1 rounded-lg border border-primary-100 transition-colors whitespace-nowrap"
              >
                <Building2 className="w-3.5 h-3.5 shrink-0" />
                <span>{ac.apartment_code}</span>
                <span className="text-slate-400">•</span>
                <span className="truncate max-w-[95px] text-slate-700">{ac.building_name}</span>
              </Link>
            </div>
          );
        },
      },
      {
        key: 'status',
        label: 'Trạng thái',
        align: 'center',
        sortable: true,
        sortValue: (row) => getTenantDisplayStatus(row),
        render: (row) => (
          <div className="inline-flex flex-col items-center gap-1">
            <StatusBadge status={getTenantDisplayStatus(row)} domain="tenant" />
            {row.status === 'PENDING' ? (
              <span className="text-[11px] text-amber-600 font-medium whitespace-nowrap">Chờ duyệt CCCD</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'actions',
        label: 'Thao tác',
        align: 'center',
        render: (row) => (
          <div
            className="inline-flex items-center justify-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="xs"
              icon={Eye}
              onClick={() => navigate(`/admin/tenants/${row.id}`)}
              title="Xem chi tiết hồ sơ"
            >
              Chi tiết
            </Button>
            {canManageTenants && row.status !== 'MERGED' ? (
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  icon={Edit3}
                  onClick={(e) => handleOpenEdit(row, e)}
                  title="Chỉnh sửa thông tin"
                >
                  Sửa
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  icon={GitMerge}
                  onClick={(e) => handleOpenMerge(row, e)}
                  title="Gộp hồ sơ trùng lặp"
                >
                  Gộp
                </Button>
              </>
            ) : null}
          </div>
        ),
      },
    ],
    [canManageTenants, navigate]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quản lý Cư dân"
        subtitle="Theo dõi hồ sơ khách thuê, định danh CCCD/Hộ chiếu và căn hộ đang lưu trú"
        actions={
          <>
            <Button variant="outline" size="md" icon={RefreshCw} onClick={fetchTenants}>
              Làm mới
            </Button>
            {canManageTenants ? (
              <>
                <Button variant="outline" size="md" icon={GitMerge} onClick={() => handleOpenMerge()}>
                  Gộp trùng lặp
                </Button>
                <Button variant="primary" size="md" icon={UserPlus} onClick={handleOpenCreate}>
                  Thêm cư dân mới
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Tổng hồ sơ cư dân"
          value={stats.total}
          subtext="Hồ sơ hoạt động trong hệ thống"
          icon={Users}
          color="sky"
          onClick={() => setStatusFilter('')}
        />
        <StatsCard
          title="Đang lưu trú"
          value={stats.activeCount}
          subtext="Có hợp đồng đang hiệu lực"
          icon={UserCheck}
          color="emerald"
          onClick={() => setStatusFilter('ACTIVE')}
        />
        <StatsCard
          title="Chờ nhận phòng / CCCD"
          value={stats.pendingCount}
          subtext="Cần bổ sung hoặc duyệt giấy tờ"
          icon={Clock}
          color="amber"
          onClick={() => setStatusFilter('PENDING')}
        />
        <StatsCard
          title="Đã trả phòng / Chưa thuê"
          value={stats.inactiveCount}
          subtext="Chưa gắn hợp đồng hiệu lực"
          icon={UserMinus}
          color="indigo"
          onClick={() => setStatusFilter('INACTIVE')}
        />
      </div>

      {/* Bộ lọc tìm kiếm */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
          <div className="md:col-span-5">
            <SearchBar
              value={search}
              onChange={setSearch}
              placeholder="Tìm theo họ tên, SĐT, số CCCD, email, mã căn hộ..."
            />
          </div>
          <div className="md:col-span-3">
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              placeholder="Tất cả trạng thái"
              options={STATUS_FILTER_OPTIONS}
            />
          </div>
          <div className="md:col-span-2">
            <Select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              placeholder="Mọi vai trò cư trú"
              options={TYPE_FILTER_OPTIONS}
            />
          </div>
          <div className="md:col-span-2 flex items-center justify-between md:justify-end gap-2">
            <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showMerged}
                onChange={(e) => setShowMerged(e.target.checked)}
                className="rounded border-slate-300 text-primary-500 focus:ring-primary-500"
              />
              Hiện hồ sơ đã gộp
            </label>
          </div>
        </div>
      </Card>

      {/* Bảng dữ liệu */}
      <DataTable
        columns={columns}
        data={filteredTenants}
        loading={loading}
        onRowClick={(row) => navigate(`/admin/tenants/${row.id}`)}
        emptyTitle="Chưa tìm thấy hồ sơ cư dân"
        emptyDescription="Thử thay đổi bộ lọc tìm kiếm hoặc tạo mới hồ sơ cư dân đầu tiên."
        emptyAction={
          canManageTenants ? (
            <Button variant="primary" size="sm" icon={UserPlus} onClick={handleOpenCreate}>
              Thêm cư dân mới
            </Button>
          ) : null
        }
      />

      {/* Modal Tạo cư dân mới (kiểm tra trùng SĐT / CCCD realtime) */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Tạo hồ sơ cư dân mới"
        subtitle="Hệ thống tự động kiểm tra trùng lặp SĐT và CCCD theo thời gian thực (FR-021)"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submittingCreate}>
              Hủy bỏ
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateSubmit}
              loading={submittingCreate}
              disabled={dupInfo.isDuplicate}
              icon={UserPlus}
            >
              Lưu hồ sơ cư dân
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4">
          {dupInfo.isDuplicate ? (
            <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 space-y-2">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                <div className="text-xs leading-relaxed">
                  <p className="font-semibold text-rose-900">
                    Chặn tạo mới: Phát hiện định danh SĐT hoặc số CCCD đã tồn tại (FR-021)!
                  </p>
                  <p className="text-rose-700 mt-0.5">
                    {dupInfo.inScope === false
                      ? dupInfo.message ||
                        'Định danh (SĐT/CCCD) này đã được đăng ký trên hệ thống ngoài phạm vi tòa nhà bạn quản lý. Hệ thống bảo mật không tiết lộ thông tin hồ sơ liên tòa.'
                      : 'Theo quy định nghiệp vụ (Mục 7.5), hệ thống chặn tạo mới bản ghi trùng định danh. Vui lòng xem hồ sơ hiện có hoặc thực hiện gộp hồ sơ có lưu vết kiểm toán:'}
                  </p>
                </div>
              </div>
              {dupInfo.inScope !== false && dupInfo.duplicates.length > 0 ? (
                <div className="pl-7 space-y-1.5">
                  {dupInfo.duplicates.map((d) => (
                    <div
                      key={d.id}
                      className="flex flex-wrap items-center justify-between gap-2 bg-white px-3 py-2 rounded-lg border border-rose-200/80 text-xs"
                    >
                      <div className="text-slate-800">
                        <span className="font-semibold">{d.masked_name || d.full_name}</span>
                        <span className="text-slate-500"> · SĐT: {d.masked_phone || d.phone || '—'}</span>
                        {d.masked_id_number || d.id_number ? (
                          <span className="text-slate-500 font-mono">
                            {' '}
                            · CCCD: {d.masked_id_number || d.id_number}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {d.tenant_id ? (
                          <Button
                            variant="outline"
                            size="xs"
                            icon={Eye}
                            onClick={() => {
                              setCreateOpen(false);
                              navigate(`/admin/tenants/${d.tenant_id}`);
                            }}
                          >
                            Xem hồ sơ
                          </Button>
                        ) : null}
                        <Button
                          variant="soft"
                          size="xs"
                          icon={GitMerge}
                          onClick={() => {
                            setCreateOpen(false);
                            handleOpenMerge(null, null, d.tenant_id || '');
                          }}
                        >
                          Mở gộp hồ sơ
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : dupChecking ? (
            <div className="text-xs text-slate-500 flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary-500" />
              Đang kiểm tra trùng lặp SĐT / CCCD...
            </div>
          ) : (createForm.phone || createForm.id_number) && !createErrors.phone && !createErrors.id_number ? (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Chưa phát hiện trùng lặp thông tin định danh.
            </div>
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Họ và tên"
              required
              placeholder="VD: Nguyễn Văn Minh"
              value={createForm.full_name}
              onChange={(e) => setCreateForm((p) => ({ ...p, full_name: e.target.value }))}
              error={createErrors.full_name}
            />
            <Input
              label="Số điện thoại"
              required
              icon={Phone}
              placeholder="VD: 0901234567"
              value={createForm.phone}
              onChange={(e) => setCreateForm((p) => ({ ...p, phone: e.target.value }))}
              error={createErrors.phone}
            />
            <Input
              label="Số CCCD / Hộ chiếu"
              icon={CreditCard}
              placeholder="12 số CCCD hoặc mã Hộ chiếu"
              hint="Nếu để trống, hồ sơ sẽ ở trạng thái PENDING chờ bổ sung trước khi kích hoạt HĐ"
              value={createForm.id_number}
              onChange={(e) => setCreateForm((p) => ({ ...p, id_number: e.target.value }))}
              error={createErrors.id_number}
            />
            <Input
              label="Email liên hệ"
              type="email"
              icon={Mail}
              placeholder="name@example.com"
              value={createForm.email}
              onChange={(e) => setCreateForm((p) => ({ ...p, email: e.target.value }))}
              error={createErrors.email}
            />
            <Input
              label="Ngày sinh"
              type="date"
              value={createForm.dob}
              onChange={(e) => setCreateForm((p) => ({ ...p, dob: e.target.value }))}
            />
            <Input
              label="Quốc tịch"
              icon={Globe}
              placeholder="Việt Nam"
              value={createForm.nationality}
              onChange={(e) => setCreateForm((p) => ({ ...p, nationality: e.target.value }))}
            />
            <Input
              label="Mật khẩu đăng nhập ban đầu (tùy chọn)"
              type="password"
              placeholder="Tối thiểu 8 ký tự (nếu dùng Email)"
              hint="Hệ thống tự cấp tài khoản Cổng cư dân (SĐT + OTP hoạt động ngay)"
              value={createForm.password}
              onChange={(e) => setCreateForm((p) => ({ ...p, password: e.target.value }))}
              error={createErrors.password}
            />
          </div>

          <Input
            label="Địa chỉ thường trú / Quê quán"
            multiline
            rows={2}
            placeholder="Số nhà, đường, phường/xã, tỉnh/thành phố..."
            value={createForm.address}
            onChange={(e) => setCreateForm((p) => ({ ...p, address: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal Chỉnh sửa nhanh cư dân */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Chỉnh sửa thông tin cư dân"
        subtitle={editingTenant ? `Hồ sơ: ${editingTenant.full_name}` : ''}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={submittingEdit}>
              Đóng
            </Button>
            <Button variant="primary" onClick={handleEditSubmit} loading={submittingEdit}>
              Lưu thay đổi
            </Button>
          </>
        }
      >
        <form onSubmit={handleEditSubmit} className="space-y-4">
          {editingTenant?.is_shared_profile && !isSysAdmin ? (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="leading-relaxed">
                <p className="font-semibold">Hồ sơ định danh chung liên tòa (Shared Profile Lock)</p>
                <p className="text-amber-800 mt-0.5">
                  Cư dân này đang đồng thời có hợp đồng hiệu lực tại tòa nhà khác trên hệ thống. Để tránh ghi đè chéo dữ liệu pháp lý, các trường gốc đã có dữ liệu (Họ tên, SĐT, CCCD, Ngày sinh) được khóa đối với Quản lý tòa — chỉ Cư dân tự cập nhật trên Cổng cư dân hoặc Quản trị hệ thống (SYS_ADMIN) điều chỉnh.
                </p>
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Họ và tên"
              required
              disabled={Boolean(editingTenant?.is_shared_profile && !isSysAdmin && editingTenant?.full_name)}
              value={editForm.full_name}
              onChange={(e) => setEditForm((p) => ({ ...p, full_name: e.target.value }))}
              error={editErrors.full_name}
            />
            <Input
              label="Số điện thoại"
              required
              icon={Phone}
              disabled={Boolean(editingTenant?.is_shared_profile && !isSysAdmin && editingTenant?.phone)}
              value={editForm.phone}
              onChange={(e) => setEditForm((p) => ({ ...p, phone: e.target.value }))}
              error={editErrors.phone}
            />
            <Input
              label="Số CCCD / Hộ chiếu"
              icon={CreditCard}
              disabled={Boolean(editingTenant?.is_shared_profile && !isSysAdmin && editingTenant?.id_number)}
              value={editForm.id_number}
              onChange={(e) => setEditForm((p) => ({ ...p, id_number: e.target.value }))}
              error={editErrors.id_number}
            />
            <Input
              label="Email liên hệ"
              type="email"
              icon={Mail}
              value={editForm.email}
              onChange={(e) => setEditForm((p) => ({ ...p, email: e.target.value }))}
              error={editErrors.email}
            />
            <Input
              label="Ngày sinh"
              type="date"
              disabled={Boolean(editingTenant?.is_shared_profile && !isSysAdmin && editingTenant?.dob)}
              value={editForm.dob}
              onChange={(e) => setEditForm((p) => ({ ...p, dob: e.target.value }))}
            />
            <Input
              label="Quốc tịch"
              icon={Globe}
              value={editForm.nationality}
              onChange={(e) => setEditForm((p) => ({ ...p, nationality: e.target.value }))}
            />
          </div>
          <Input
            label="Địa chỉ thường trú"
            multiline
            rows={2}
            value={editForm.address}
            onChange={(e) => setEditForm((p) => ({ ...p, address: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal Gộp hồ sơ cư dân trùng lặp */}
      <Modal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        title="Gộp hồ sơ cư dân trùng lặp"
        subtitle="Chuyển toàn bộ hợp đồng và lịch sử ở cùng từ hồ sơ trùng sang hồ sơ chính (FR-021)"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setMergeOpen(false)} disabled={submittingMerge}>
              Hủy bỏ
            </Button>
            <Button variant="primary" onClick={handleMergeSubmit} loading={submittingMerge} icon={GitMerge}>
              Xác nhận gộp hồ sơ
            </Button>
          </>
        }
      >
        <form onSubmit={handleMergeSubmit} className="space-y-4">
          <div className="p-3.5 rounded-xl bg-sky-50 border border-sky-200 text-xs text-sky-900 leading-relaxed">
            <strong>Cơ chế an toàn dữ liệu:</strong> Hồ sơ nguồn sau khi gộp sẽ được đánh dấu{' '}
            <code className="px-1 py-0.5 bg-white rounded border border-sky-200">[ĐÃ GỘP]</code> (không xóa cứng),
            toàn bộ hợp đồng đứng tên và thông tin thành viên ở cùng sẽ được chuyển sang hồ sơ đích.
          </div>

          <Select
            label="Hồ sơ bị trùng (Nguồn — sẽ đóng sau khi gộp)"
            required
            placeholder="-- Chọn hồ sơ cần gộp đi --"
            value={mergeForm.source_tenant_id}
            onChange={(e) => setMergeForm((p) => ({ ...p, source_tenant_id: e.target.value }))}
            options={mergeableTenants.map((t) => ({
              value: t.id,
              label: `${t.full_name} — ${t.phone || 'Không SĐT'} (${
                t.id_number ? maskIdNumber(t.id_number) : 'Chưa CCCD'
              })`,
            }))}
          />

          <Select
            label="Hồ sơ chính muốn giữ lại (Đích)"
            required
            placeholder="-- Chọn hồ sơ đích nhận dữ liệu --"
            value={mergeForm.target_tenant_id}
            onChange={(e) => setMergeForm((p) => ({ ...p, target_tenant_id: e.target.value }))}
            options={mergeableTenants
              .filter((t) => t.id !== mergeForm.source_tenant_id)
              .map((t) => ({
                value: t.id,
                label: `${t.full_name} — ${t.phone || 'Không SĐT'} (${
                  t.id_number ? maskIdNumber(t.id_number) : 'Chưa CCCD'
                })`,
              }))}
          />

          <Input
            label="Lý do gộp hồ sơ"
            required
            multiline
            rows={2}
            value={mergeForm.reason}
            onChange={(e) => setMergeForm((p) => ({ ...p, reason: e.target.value }))}
            placeholder="Nhập lý do bắt buộc để lưu vết kiểm toán (Audit Log — FR-021)..."
          />
        </form>
      </Modal>
    </div>
  );
}

export default TenantsPage;
