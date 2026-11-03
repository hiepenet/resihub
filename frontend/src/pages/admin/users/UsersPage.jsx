import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users,
  UserPlus,
  Settings,
  Edit3,
  Lock,
  Unlock,
  Plus,
  Trash2,
  Save,
  Shield,
  ShieldCheck,
  AlertTriangle,
  ScrollText,
  ExternalLink,
  Building2,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { MoneyInput } from '../../../components/ui/MoneyInput';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { SearchBar } from '../../../components/common/SearchBar';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { usersService } from '../../../services/users.service';
import { buildingsService } from '../../../services/buildings.service';
import { AuditLogsView } from '../audit/AuditLogsPage';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { ROLES, ROLE_LABELS, ROLE_BADGE_VARIANTS } from '../../../constants/roles';
import { formatDateTime } from '../../../utils/format';
import { extractErrorMessage, isValidEmail, isValidPhone } from '../../../utils/validation';
import { DEFAULT_AI_CONFIG, mergeAiConfigState } from '../../../utils/aiHelpers';
import { AiGatewayConfigCard } from '../../../components/settings/AiGatewayConfigCard';

const ALL_ROLE_OPTIONS = [
  ROLES.SYS_ADMIN,
  ROLES.OWNER,
  ROLES.MANAGER,
  ROLES.RESIDENT,
].map((code) => ({
  value: code,
  label: `${ROLE_LABELS[code]} (${code})`,
}));

const DEFAULT_BILLING_CONFIG = {
  billing_day: 1,
  payment_due_days: 5,
  reminder_days_text: '3, 7, 15',
  late_fee_percent: 0,
  electricity_default_price: 3800,
  water_default_price: 22000,
};

const DEFAULT_SLA_CONFIG = {
  response_hours: 2,
  urgent_resolve_hours: 4,
  normal_resolve_hours: 24,
  deposit_refund_days: 5,
};

const DEFAULT_CONTACT_CONFIG = {
  working_hours: '08:00 – 18:00 (Thứ 2 – Thứ 7)',
  technical_hotline: '1900 6868',
  security_hotline: '1900 9119',
  emergency_phone: '0909 113 114',
  support_email: 'support@resihub.vn',
};

export function UsersPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user: currentUser, canManageUsers } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [activeTab, setActiveTab] = useState('users'); // 'users' | 'settings' | 'audit'

  // Tab 1: Danh sách tài khoản
  const [users, setUsers] = useState([]);
  const [buildings, setBuildings] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [filterBySelectedBuilding, setFilterBySelectedBuilding] = useState(true);

  // Modal tạo / sửa user
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [savingUser, setSavingUser] = useState(false);
  const [userForm, setUserForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    id_number: '',
    password: '',
    status: 'ACTIVE',
    roles: [{ role_code: 'MANAGER', building_id: '' }],
  });

  // Confirm khóa / mở tài khoản
  const [toggleStatusTarget, setToggleStatusTarget] = useState(null);
  const [togglingStatus, setTogglingStatus] = useState(false);

  // Tab 2: Cấu hình hệ thống
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [billingConfig, setBillingConfig] = useState(DEFAULT_BILLING_CONFIG);
  const [slaConfig, setSlaConfig] = useState(DEFAULT_SLA_CONFIG);
  const [contactConfig, setContactConfig] = useState(DEFAULT_CONTACT_CONFIG);
  const [approvalConfig, setApprovalConfig] = useState({ allow_self_approval: false });
  const [aiConfig, setAiConfig] = useState(DEFAULT_AI_CONFIG);
  const [aiKeyConfigured, setAiKeyConfigured] = useState(false);

  const fetchUsersData = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const [usersRes, bldgRes] = await Promise.all([
        usersService.list({
          role: roleFilter || undefined,
          status: statusFilter || undefined,
          search: search.trim() || undefined,
        }),
        buildingsService.list().catch(() => ({ data: [] })),
        usersService.listRoles().catch(() => ({ data: [] })),
      ]);
      setUsers(usersRes.data || []);
      setBuildings(bldgRes.data || []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách tài khoản.'));
    } finally {
      setLoadingUsers(false);
    }
  }, [roleFilter, statusFilter, search, toast]);

  const fetchSettingsData = useCallback(async () => {
    setLoadingSettings(true);
    try {
      const res = await usersService.getSettings();
      const data = res.data || {};
      if (data.billing_config) {
        const bc = data.billing_config;
        setBillingConfig({
          billing_day: bc.billing_day ?? 1,
          payment_due_days: bc.payment_due_days ?? 5,
          reminder_days_text: Array.isArray(bc.reminder_days)
            ? bc.reminder_days.join(', ')
            : '3, 7, 15',
          late_fee_percent: bc.late_fee_percent ?? 0,
          electricity_default_price: bc.electricity_default_price ?? 3800,
          water_default_price: bc.water_default_price ?? 22000,
        });
      }
      if (data.sla_config) {
        setSlaConfig({
          ...DEFAULT_SLA_CONFIG,
          ...data.sla_config,
        });
      }
      if (data.contact_config) {
        setContactConfig({
          ...DEFAULT_CONTACT_CONFIG,
          ...data.contact_config,
        });
      }
      if (data.approval_config) {
        setApprovalConfig({
          allow_self_approval: Boolean(data.approval_config.allow_self_approval),
        });
      }
      if (data.ai_config) {
        setAiConfig(mergeAiConfigState(data.ai_config));
      }
      setAiKeyConfigured(Boolean(res?.ai_runtime?.api_key_configured));
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải cấu hình hệ thống.'));
    } finally {
      setLoadingSettings(false);
    }
  }, [toast]);

  useEffect(() => {
    const t = setTimeout(() => {
      fetchUsersData();
    }, 200);
    return () => clearTimeout(t);
  }, [fetchUsersData]);

  useEffect(() => {
    fetchSettingsData();
  }, [fetchSettingsData]);

  const displayedUsers = useMemo(() => {
    if (!selectedBuildingId || !filterBySelectedBuilding) return users;
    return users.filter((u) => {
      const roles = Array.isArray(u.roles) ? u.roles : [];
      return roles.some(
        (r) => r.code === ROLES.SYS_ADMIN || r.building_id === selectedBuildingId
      );
    });
  }, [users, selectedBuildingId, filterBySelectedBuilding]);

  const openCreateUserModal = () => {
    setEditingUser(null);
    setUserForm({
      full_name: '',
      email: '',
      phone: '',
      id_number: '',
      password: '',
      status: 'ACTIVE',
      roles: [{ role_code: 'MANAGER', building_id: selectedBuildingId || '' }],
    });
    setUserModalOpen(true);
  };

  const openEditUserModal = (u) => {
    setEditingUser(u);
    const mappedRoles =
      Array.isArray(u.roles) && u.roles.length > 0
        ? u.roles.map((r) => ({
            role_code: r.code,
            building_id: r.building_id || '',
          }))
        : [{ role_code: 'MANAGER', building_id: selectedBuildingId || '' }];

    setUserForm({
      full_name: u.full_name || '',
      email: u.email || '',
      phone: u.phone || '',
      id_number: u.id_number || '',
      password: '',
      status: u.status || 'ACTIVE',
      roles: mappedRoles,
    });
    setUserModalOpen(true);
  };

  const addRoleRow = () => {
    setUserForm((s) => ({
      ...s,
      roles: [...s.roles, { role_code: 'MANAGER', building_id: selectedBuildingId || '' }],
    }));
  };

  const updateRoleRow = (idx, field, val) => {
    setUserForm((s) => ({
      ...s,
      roles: s.roles.map((r, i) => {
        if (i !== idx) return r;
        if (field === 'role_code' && val === ROLES.SYS_ADMIN) {
          return { role_code: val, building_id: '' };
        }
        return { ...r, [field]: val };
      }),
    }));
  };

  const removeRoleRow = (idx) => {
    setUserForm((s) => ({
      ...s,
      roles: s.roles.length > 1 ? s.roles.filter((_, i) => i !== idx) : s.roles,
    }));
  };

  const handleSaveUser = async (e) => {
    e.preventDefault();
    if (!userForm.full_name.trim()) {
      toast.warning('Họ và tên người dùng là bắt buộc.');
      return;
    }
    if (!userForm.email.trim() && !userForm.phone.trim()) {
      toast.warning('Phải nhập ít nhất Email hoặc Số điện thoại.');
      return;
    }
    if (userForm.email.trim() && !isValidEmail(userForm.email)) {
      toast.warning('Địa chỉ Email không đúng định dạng.');
      return;
    }
    if (userForm.phone.trim() && !isValidPhone(userForm.phone)) {
      toast.warning('Số điện thoại Việt Nam không hợp lệ (10 chữ số).');
      return;
    }
    if (!editingUser && (!userForm.password || userForm.password.length < 8)) {
      toast.warning('Mật khẩu khởi tạo phải có tối thiểu 8 ký tự.');
      return;
    }
    if (editingUser && userForm.password && userForm.password.length < 8) {
      toast.warning('Mật khẩu đặt lại phải có tối thiểu 8 ký tự.');
      return;
    }

    const formattedRoles = userForm.roles.map((r) => ({
      role_code: r.role_code,
      building_id: r.role_code === ROLES.SYS_ADMIN ? null : r.building_id || null,
    }));

    setSavingUser(true);
    try {
      if (editingUser) {
        const payload = {
          full_name: userForm.full_name.trim(),
          email: userForm.email.trim() || null,
          phone: userForm.phone.trim() || null,
          id_number: userForm.id_number.trim() || null,
          status: userForm.status,
          roles: formattedRoles,
        };
        if (userForm.password) {
          payload.password = userForm.password;
        }
        const res = await usersService.update(editingUser.id, payload);
        toast.success(res.message || 'Cập nhật tài khoản và phân quyền thành công.');
      } else {
        const res = await usersService.create({
          full_name: userForm.full_name.trim(),
          email: userForm.email.trim() || null,
          phone: userForm.phone.trim() || null,
          id_number: userForm.id_number.trim() || null,
          password: userForm.password,
          roles: formattedRoles,
        });
        toast.success(res.message || 'Tạo tài khoản mới thành công.');
      }
      setUserModalOpen(false);
      fetchUsersData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu tài khoản người dùng.'));
    } finally {
      setSavingUser(false);
    }
  };

  const handleConfirmToggleStatus = async () => {
    if (!toggleStatusTarget) return;
    const nextStatus = toggleStatusTarget.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    setTogglingStatus(true);
    try {
      const res = await usersService.update(toggleStatusTarget.id, { status: nextStatus });
      toast.success(
        res.message ||
          (nextStatus === 'SUSPENDED'
            ? `Đã tạm khóa tài khoản ${toggleStatusTarget.full_name}.`
            : `Đã mở khóa tài khoản ${toggleStatusTarget.full_name}.`)
      );
      setToggleStatusTarget(null);
      fetchUsersData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể đổi trạng thái tài khoản.'));
    } finally {
      setTogglingStatus(false);
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    const reminderDays = String(billingConfig.reminder_days_text || '')
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0);

    setSavingSettings(true);
    try {
      const res = await usersService.updateSettings({
        billing_config: {
          billing_day: Math.min(28, Math.max(1, Number(billingConfig.billing_day) || 1)),
          payment_due_days: Math.max(1, Number(billingConfig.payment_due_days) || 5),
          reminder_days: reminderDays.length > 0 ? reminderDays : [3, 7, 15],
          late_fee_percent: Math.max(0, Number(billingConfig.late_fee_percent) || 0),
          electricity_default_price: Math.max(
            0,
            Number(billingConfig.electricity_default_price) || 3800
          ),
          water_default_price: Math.max(0, Number(billingConfig.water_default_price) || 22000),
        },
        sla_config: {
          response_hours: Math.max(1, Number(slaConfig.response_hours) || 2),
          urgent_resolve_hours: Math.max(1, Number(slaConfig.urgent_resolve_hours) || 4),
          normal_resolve_hours: Math.max(1, Number(slaConfig.normal_resolve_hours) || 24),
          deposit_refund_days: Math.max(1, Number(slaConfig.deposit_refund_days) || 5),
        },
        contact_config: {
          working_hours: contactConfig.working_hours.trim(),
          technical_hotline: contactConfig.technical_hotline.trim(),
          security_hotline: contactConfig.security_hotline.trim(),
          emergency_phone: contactConfig.emergency_phone.trim(),
          support_email: contactConfig.support_email.trim(),
        },
        approval_config: {
          allow_self_approval: Boolean(approvalConfig.allow_self_approval),
        },
        ai_config: {
          ...aiConfig,
          monthly_budget_vnd: Math.max(0, Math.round(Number(aiConfig.monthly_budget_vnd) || 0)),
          monthly_token_limit: Math.max(10000, Math.round(Number(aiConfig.monthly_token_limit) || 5000000)),
          ocr_threshold: Number(aiConfig.ocr_threshold) || 0.85,
          extract_threshold: Number(aiConfig.extract_threshold) || 0.75,
          triage_threshold: Number(aiConfig.triage_threshold) || 0.65,
        },
      });
      toast.success(res.message || 'Đã lưu cấu hình hệ thống thành công.');
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu cấu hình hệ thống.'));
    } finally {
      setSavingSettings(false);
    }
  };

  const userColumns = useMemo(
    () => [
      {
        key: 'full_name',
        label: 'Người dùng',
        sortable: true,
        render: (row) => (
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-primary-100 text-primary-700 font-bold text-xs flex items-center justify-center shrink-0">
              {(row.full_name || 'U').slice(0, 1).toUpperCase()}
            </div>
            <div>
              <p className="font-semibold text-slate-900">{row.full_name}</p>
              {row.id_number ? (
                <p className="text-[11px] text-slate-400">CCCD: {row.id_number}</p>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        key: 'email',
        label: 'Liên hệ',
        render: (row) => (
          <div className="text-xs">
            <p className="text-slate-800 font-medium break-all">{row.email || '—'}</p>
            <p className="text-slate-500 mt-0.5">{row.phone || '—'}</p>
          </div>
        ),
      },
      {
        key: 'roles',
        label: 'Vai trò & Phạm vi',
        render: (row) => {
          const roles = Array.isArray(row.roles) ? row.roles : [];
          if (roles.length === 0) {
            return <span className="text-xs text-slate-400 italic">Chưa gán quyền</span>;
          }
          return (
            <div className="flex flex-wrap gap-1.5">
              {roles.map((r, idx) => (
                <Badge key={idx} variant={ROLE_BADGE_VARIANTS[r.code] || 'slate'}>
                  {ROLE_LABELS[r.code] || r.name || r.code}
                  {r.building_code
                    ? ` • ${r.building_code}`
                    : r.code === ROLES.SYS_ADMIN
                    ? ' • Toàn hệ thống'
                    : ''}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        key: 'status',
        label: 'Trạng thái',
        align: 'center',
        sortable: true,
        render: (row) => <StatusBadge status={row.status} domain="user" />,
      },
      {
        key: 'last_login_at',
        label: 'Đăng nhập gần nhất',
        align: 'center',
        sortable: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="text-xs text-slate-500">
            {row.last_login_at ? formatDateTime(row.last_login_at) : 'Chưa đăng nhập'}
          </span>
        ),
      },
      {
        key: 'actions',
        label: 'Thao tác',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => {
          if (!canManageUsers) return null;
          const isSelf = row.id === currentUser?.id;
          return (
            <div className="inline-flex items-center justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <Button
                size="xs"
                variant="outline"
                icon={Edit3}
                onClick={() => openEditUserModal(row)}
              >
                Phân quyền
              </Button>
              <Button
                size="xs"
                variant={row.status === 'ACTIVE' ? 'danger' : 'success'}
                icon={row.status === 'ACTIVE' ? Lock : Unlock}
                disabled={isSelf && row.status === 'ACTIVE'}
                title={isSelf ? 'Không thể tự khóa tài khoản đang đăng nhập' : ''}
                onClick={() => setToggleStatusTarget(row)}
              >
                {row.status === 'ACTIVE' ? 'Khóa' : 'Mở khóa'}
              </Button>
            </div>
          );
        },
      },
    ],
    [canManageUsers, currentUser]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Người dùng & Cấu hình Hệ thống"
        subtitle="Quản lý tài khoản nhân sự, phân quyền theo phạm vi tòa nhà (RBAC + RLS) và thiết lập tham số vận hành."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              icon={ScrollText}
              rightIcon={ExternalLink}
              onClick={() => navigate('/admin/audit-logs')}
            >
              Mở trang Nhật ký hệ thống
            </Button>
            {activeTab === 'users' && canManageUsers ? (
              <Button variant="primary" icon={UserPlus} onClick={openCreateUserModal}>
                Tạo tài khoản mới
              </Button>
            ) : activeTab === 'settings' && canManageUsers ? (
              <Button
                variant="primary"
                icon={Save}
                loading={savingSettings}
                onClick={handleSaveSettings}
              >
                Lưu cấu hình hệ thống
              </Button>
            ) : null}
          </div>
        }
      />

      <Tabs
        activeTab={activeTab}
        onChange={setActiveTab}
        tabs={[
          {
            id: 'users',
            label: 'Quản lý tài khoản & Phân quyền',
            icon: Users,
            count: displayedUsers.length,
          },
          {
            id: 'settings',
            label: 'Cấu hình hệ thống',
            icon: Settings,
          },
          {
            id: 'audit',
            label: 'Nhật ký hệ thống',
            icon: ScrollText,
          },
        ]}
      />

      {/* TAB 1: QUẢN LÝ TÀI KHOẢN & PHÂN QUYỀN */}
      {activeTab === 'users' ? (
        <div className="space-y-4">
          <Card className="p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="sm:col-span-2">
                <SearchBar
                  value={search}
                  onChange={setSearch}
                  placeholder="Tìm kiếm theo họ tên, email hoặc số điện thoại..."
                />
              </div>
              <Select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                placeholder="Tất cả vai trò"
                options={ALL_ROLE_OPTIONS}
              />
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                placeholder="Tất cả trạng thái"
                options={[
                  { value: 'ACTIVE', label: 'Đang hoạt động (ACTIVE)' },
                  { value: 'SUSPENDED', label: 'Tạm khóa (SUSPENDED)' },
                ]}
              />
            </div>

            {selectedBuildingId ? (
              <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs text-slate-600">
                <span className="inline-flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5 text-primary-500" />
                  {filterBySelectedBuilding
                    ? 'Đang lọc nhân sự thuộc tòa nhà đã chọn trên thanh điều hướng.'
                    : 'Đang hiển thị toàn bộ tài khoản trong tổ chức.'}
                </span>
                <button
                  type="button"
                  onClick={() => setFilterBySelectedBuilding((v) => !v)}
                  className="font-medium text-primary-600 hover:underline"
                >
                  {filterBySelectedBuilding ? 'Xem toàn tổ chức' : 'Chỉ xem tòa đang chọn'}
                </button>
              </div>
            ) : null}
          </Card>

          <DataTable
            columns={userColumns}
            data={displayedUsers}
            loading={loadingUsers}
            emptyTitle="Không tìm thấy tài khoản nào"
            emptyDescription="Thử thay đổi bộ lọc vai trò hoặc từ khóa tìm kiếm."
          />
        </div>
      ) : null}

      {/* TAB 2: CẤU HÌNH HỆ THỐNG */}
      {activeTab === 'settings' ? (
        loadingSettings ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-80 rounded-xl bg-white border border-slate-200 animate-pulse"
              />
            ))}
          </div>
        ) : (
          <form onSubmit={handleSaveSettings} className="space-y-6">
            <AiGatewayConfigCard
              aiConfig={aiConfig}
              onChange={setAiConfig}
              apiKeyConfigured={aiKeyConfigured}
              canEdit={canManageUsers}
            />

            {/* Quy tắc Phê duyệt Nội bộ (Four-eyes) — R-23 */}
            <Card className="space-y-4">
              <CardHeader
                title="Quy tắc Phê duyệt Nội bộ (Four-eyes)"
                subtitle="Khóa cấu hình: approval_config"
              />
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-primary-600 shrink-0" />
                    Cho phép người tạo tự phê duyệt trong mô hình vận hành 1 nhân sự (allow_self_approval)
                  </p>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Mặc định tắt (<strong>Four-eyes nghiêm ngặt</strong>: người lập hồ sơ không được tự duyệt hợp đồng giá ưu đãi, phụ lục hay hoàn cọc). Khi bật cho mô hình vận hành 1 người, người tạo được phép tự phê duyệt hồ sơ của mình và hệ thống tự động ghi nhận cảnh báo{' '}
                    <code className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-mono text-[11px]">
                      SELF_APPROVAL_WARNING
                    </code>{' '}
                    trong Nhật ký hệ thống (Audit Log).
                  </p>
                </div>

                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    disabled={!canManageUsers}
                    checked={Boolean(approvalConfig.allow_self_approval)}
                    onChange={(e) =>
                      setApprovalConfig({ allow_self_approval: e.target.checked })
                    }
                  />
                  <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600 peer-disabled:opacity-60" />
                </label>
              </div>

              {approvalConfig.allow_self_approval ? (
                <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs text-amber-900">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <span>
                    Chế độ cho phép tự phê duyệt đang <strong>BẬT</strong>. Mọi thao tác tự phê duyệt sẽ tự động ghi nhận cảnh báo <strong>SELF_APPROVAL_WARNING</strong> vào Nhật ký hệ thống.
                  </span>
                </div>
              ) : null}
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* 1. Billing Config */}
              <Card className="space-y-4">
                <CardHeader
                  title="Chu kỳ Hóa đơn & Giá mặc định"
                  subtitle="Khóa cấu hình: billing_config"
                />
                <Input
                  label="Ngày chốt chỉ số & lập hóa đơn hàng tháng"
                  type="number"
                  min="1"
                  max="28"
                  disabled={!canManageUsers}
                  value={billingConfig.billing_day}
                  onChange={(e) =>
                    setBillingConfig((s) => ({ ...s, billing_day: e.target.value }))
                  }
                />
                <Input
                  label="Thời hạn thanh toán (số ngày sau phát hành)"
                  type="number"
                  min="1"
                  max="30"
                  disabled={!canManageUsers}
                  value={billingConfig.payment_due_days}
                  onChange={(e) =>
                    setBillingConfig((s) => ({ ...s, payment_due_days: e.target.value }))
                  }
                />
                <Input
                  label="Các mốc ngày nhắc nợ tự động (cách nhau dấu phẩy)"
                  placeholder="3, 7, 15"
                  disabled={!canManageUsers}
                  value={billingConfig.reminder_days_text}
                  onChange={(e) =>
                    setBillingConfig((s) => ({ ...s, reminder_days_text: e.target.value }))
                  }
                />
                <Input
                  label="Lãi phạt chậm thanh toán (% / tháng)"
                  type="number"
                  min="0"
                  step="0.1"
                  disabled={!canManageUsers}
                  value={billingConfig.late_fee_percent}
                  onChange={(e) =>
                    setBillingConfig((s) => ({ ...s, late_fee_percent: e.target.value }))
                  }
                />
                <div className="grid grid-cols-2 gap-3">
                  <MoneyInput
                    label="Giá điện mặc định (₫/kWh)"
                    disabled={!canManageUsers}
                    placeholder="VD: 3.800"
                    value={billingConfig.electricity_default_price}
                    onChange={(e) =>
                      setBillingConfig((s) => ({
                        ...s,
                        electricity_default_price: e.target.value,
                      }))
                    }
                  />
                  <MoneyInput
                    label="Giá nước mặc định (₫/m³)"
                    disabled={!canManageUsers}
                    placeholder="VD: 22.000"
                    value={billingConfig.water_default_price}
                    onChange={(e) =>
                      setBillingConfig((s) => ({
                        ...s,
                        water_default_price: e.target.value,
                      }))
                    }
                  />
                </div>
              </Card>

              {/* 2. SLA Config */}
              <Card className="space-y-4">
                <CardHeader
                  title="Cam kết SLA Kỹ thuật & Tiền cọc"
                  subtitle="Khóa cấu hình: sla_config"
                />
                <Input
                  label="Thời gian phản hồi tiếp nhận tối đa (giờ)"
                  type="number"
                  min="1"
                  disabled={!canManageUsers}
                  value={slaConfig.response_hours}
                  onChange={(e) =>
                    setSlaConfig((s) => ({ ...s, response_hours: e.target.value }))
                  }
                />
                <Input
                  label="SLA xử lý sự cố KHẨN CẤP (giờ)"
                  type="number"
                  min="1"
                  disabled={!canManageUsers}
                  value={slaConfig.urgent_resolve_hours}
                  onChange={(e) =>
                    setSlaConfig((s) => ({ ...s, urgent_resolve_hours: e.target.value }))
                  }
                />
                <Input
                  label="SLA xử lý sự cố THÔNG THƯỜNG (giờ)"
                  type="number"
                  min="1"
                  disabled={!canManageUsers}
                  value={slaConfig.normal_resolve_hours}
                  onChange={(e) =>
                    setSlaConfig((s) => ({ ...s, normal_resolve_hours: e.target.value }))
                  }
                />
                <Input
                  label="Thời hạn hoàn trả tiền cọc sau thanh lý (ngày)"
                  type="number"
                  min="1"
                  disabled={!canManageUsers}
                  value={slaConfig.deposit_refund_days}
                  onChange={(e) =>
                    setSlaConfig((s) => ({ ...s, deposit_refund_days: e.target.value }))
                  }
                />
              </Card>

              {/* 3. Contact Config */}
              <Card className="space-y-4">
                <CardHeader
                  title="Danh bạ Ban Quản Lý (Cổng Cư Dân)"
                  subtitle="Khóa cấu hình: contact_config"
                />
                <Input
                  label="Khung giờ làm việc hành chính"
                  disabled={!canManageUsers}
                  value={contactConfig.working_hours}
                  onChange={(e) =>
                    setContactConfig((s) => ({ ...s, working_hours: e.target.value }))
                  }
                />
                <Input
                  label="Hotline Kỹ thuật / Bảo trì"
                  disabled={!canManageUsers}
                  value={contactConfig.technical_hotline}
                  onChange={(e) =>
                    setContactConfig((s) => ({ ...s, technical_hotline: e.target.value }))
                  }
                />
                <Input
                  label="Hotline An ninh / Trực bảo vệ 24/7"
                  disabled={!canManageUsers}
                  value={contactConfig.security_hotline}
                  onChange={(e) =>
                    setContactConfig((s) => ({ ...s, security_hotline: e.target.value }))
                  }
                />
                <Input
                  label="Số điện thoại khẩn cấp / PCCC"
                  disabled={!canManageUsers}
                  value={contactConfig.emergency_phone}
                  onChange={(e) =>
                    setContactConfig((s) => ({ ...s, emergency_phone: e.target.value }))
                  }
                />
                <Input
                  label="Email tiếp nhận hỗ trợ cư dân"
                  type="email"
                  disabled={!canManageUsers}
                  value={contactConfig.support_email}
                  onChange={(e) =>
                    setContactConfig((s) => ({ ...s, support_email: e.target.value }))
                  }
                />
              </Card>
            </div>

            {canManageUsers ? (
              <div className="flex justify-end">
                <Button type="submit" variant="primary" size="lg" icon={Save} loading={savingSettings}>
                  Lưu toàn bộ cấu hình hệ thống
                </Button>
              </div>
            ) : null}
          </form>
        )
      ) : null}

      {/* TAB 3: NHẬT KÝ HỆ THỐNG (AUDIT LOGS) */}
      {activeTab === 'audit' ? <AuditLogsView /> : null}

      {/* Modal Tạo / Sửa Tài khoản & Phân quyền nhiều vai trò */}
      <Modal
        open={userModalOpen}
        onClose={() => setUserModalOpen(false)}
        title={
          editingUser
            ? `Chỉnh sửa & Phân quyền: ${editingUser.full_name}`
            : 'Tạo tài khoản người dùng mới'
        }
        subtitle="Hỗ trợ gán nhiều vai trò đồng thời và giới hạn phạm vi quản lý theo từng tòa nhà."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setUserModalOpen(false)} disabled={savingUser}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleSaveUser} loading={savingUser}>
              {editingUser ? 'Lưu cập nhật' : 'Tạo tài khoản'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleSaveUser} className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Họ và tên"
              required
              placeholder="Nguyễn Văn A"
              value={userForm.full_name}
              onChange={(e) => setUserForm((s) => ({ ...s, full_name: e.target.value }))}
            />
            <Input
              label="Số CCCD / Hộ chiếu"
              placeholder="079099001234"
              value={userForm.id_number}
              onChange={(e) => setUserForm((s) => ({ ...s, id_number: e.target.value }))}
            />
          </div>

          {editingUser ? (
            <Select
              label="Trạng thái tài khoản"
              value={userForm.status}
              onChange={(e) => setUserForm((s) => ({ ...s, status: e.target.value }))}
              options={[
                { value: 'ACTIVE', label: 'Đang hoạt động (ACTIVE)' },
                { value: 'SUSPENDED', label: 'Tạm khóa (SUSPENDED)' },
              ]}
            />
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Email đăng nhập"
              type="email"
              placeholder="manager@resihub.vn"
              value={userForm.email}
              onChange={(e) => setUserForm((s) => ({ ...s, email: e.target.value }))}
            />
            <Input
              label="Số điện thoại"
              placeholder="0909123456"
              value={userForm.phone}
              onChange={(e) => setUserForm((s) => ({ ...s, phone: e.target.value }))}
            />
          </div>

          <Input
            label={
              editingUser
                ? 'Đặt lại mật khẩu mới (để trống nếu giữ nguyên)'
                : 'Mật khẩu khởi tạo'
            }
            type="password"
            required={!editingUser}
            placeholder="Tối thiểu 8 ký tự"
            value={userForm.password}
            onChange={(e) => setUserForm((s) => ({ ...s, password: e.target.value }))}
          />

          {/* Phân quyền Multi-role + Building Scope */}
          <div className="space-y-3 pt-3 border-t border-slate-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Shield className="w-4 h-4 text-primary-600" />
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                  Phân quyền Vai trò & Phạm vi Tòa nhà
                </span>
              </div>
              <Button type="button" size="xs" variant="soft" icon={Plus} onClick={addRoleRow}>
                Thêm vai trò
              </Button>
            </div>

            <div className="space-y-2.5">
              {userForm.roles.map((row, idx) => {
                const isGlobalRole = row.role_code === ROLES.SYS_ADMIN;
                return (
                  <div
                    key={idx}
                    className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center p-3 rounded-xl bg-slate-50 border border-slate-200"
                  >
                    <div className="sm:col-span-5">
                      <Select
                        value={row.role_code}
                        onChange={(e) => updateRoleRow(idx, 'role_code', e.target.value)}
                        options={ALL_ROLE_OPTIONS}
                      />
                    </div>
                    <div className="sm:col-span-6">
                      <Select
                        disabled={isGlobalRole}
                        value={isGlobalRole ? '' : row.building_id}
                        onChange={(e) => updateRoleRow(idx, 'building_id', e.target.value)}
                        placeholder={
                          isGlobalRole
                            ? 'Phạm vi: Toàn bộ tổ chức'
                            : '-- Tất cả / Chưa gắn tòa cụ thể --'
                        }
                        options={buildings.map((b) => ({
                          value: b.id,
                          label: `${b.code} — ${b.name}`,
                        }))}
                      />
                    </div>
                    <div className="sm:col-span-1 flex justify-end">
                      <button
                        type="button"
                        disabled={userForm.roles.length <= 1}
                        onClick={() => removeRoleRow(idx)}
                        className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-30"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </form>
      </Modal>

      {/* Confirm Khóa / Mở khóa */}
      <ConfirmDialog
        open={Boolean(toggleStatusTarget)}
        onClose={() => setToggleStatusTarget(null)}
        onConfirm={handleConfirmToggleStatus}
        loading={togglingStatus}
        variant={toggleStatusTarget?.status === 'ACTIVE' ? 'danger' : 'primary'}
        title={
          toggleStatusTarget?.status === 'ACTIVE'
            ? 'Tạm khóa tài khoản người dùng'
            : 'Mở khóa tài khoản người dùng'
        }
        message={
          toggleStatusTarget
            ? toggleStatusTarget.status === 'ACTIVE'
              ? `Khóa tài khoản "${toggleStatusTarget.full_name}" sẽ thu hồi ngay lập tức phiên đăng nhập hiện tại của người dùng này. Bạn chắc chắn muốn tiếp tục?`
              : `Mở khóa để cho phép "${toggleStatusTarget.full_name}" đăng nhập trở lại hệ thống?`
            : ''
        }
        confirmLabel={toggleStatusTarget?.status === 'ACTIVE' ? 'Khóa tài khoản' : 'Mở khóa'}
      />
    </div>
  );
}

export default UsersPage;
