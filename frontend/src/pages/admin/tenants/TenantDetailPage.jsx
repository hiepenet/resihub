import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  User,
  Phone,
  Mail,
  CreditCard,
  Globe,
  MapPin,
  Calendar,
  FileText,
  Users,
  Edit3,
  Save,
  X,
  CheckCircle2,
  XCircle,
  ArrowRightLeft,
  ExternalLink,
  ZoomIn,
  ShieldCheck,
  AlertTriangle,
  Building2,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { EmptyState } from '../../../components/common/EmptyState';
import { LoadingSpinner } from '../../../components/common/LoadingSpinner';
import { tenantsService } from '../../../services/tenants.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate, toInputDate } from '../../../utils/format';
import {
  isValidPhone,
  normalizePhone,
  isValidEmail,
  isValidIdNumber,
  extractErrorMessage,
} from '../../../utils/validation';

const RELATIONSHIP_LABELS = {
  family: 'Gia đình / Người thân',
  spouse: 'Vợ / Chồng',
  child: 'Con cái',
  roommate: 'Bạn cùng phòng',
  friend: 'Bạn bè',
  other: 'Khác',
};

function getAvatarLetters(fullName) {
  if (!fullName) return 'CD';
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'CD';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function TenantDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { canManageTenants } = usePermission();

  const [tenant, setTenant] = useState(null);
  const [idImages, setIdImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('profile');

  // Edit profile state
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState({
    full_name: '',
    phone: '',
    email: '',
    id_number: '',
    dob: '',
    nationality: 'Việt Nam',
    address: '',
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  // Upload CCCD state
  const [uploadingSide, setUploadingSide] = useState(null);
  const [previewSrc, setPreviewSrc] = useState(null);
  const [previewTitle, setPreviewTitle] = useState('');

  // Approve / Reject pending tenant profile
  const [approvalDialog, setApprovalDialog] = useState({ open: false, action: 'approve' });
  const [processingApproval, setProcessingApproval] = useState(false);

  const loadData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [detailRes, imgRes] = await Promise.all([
        tenantsService.getById(id),
        tenantsService.getIdImages(id).catch(() => ({ data: [] })),
      ]);
      const data = detailRes?.data || null;
      setTenant(data);
      setIdImages(Array.isArray(imgRes?.data) ? imgRes.data : []);
      if (data) {
        setForm({
          full_name: data.full_name || '',
          phone: data.phone || '',
          email: data.email || '',
          id_number: data.id_number || '',
          dob: toInputDate(data.dob),
          nationality: data.nationality || 'Việt Nam',
          address: data.address || '',
        });
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải thông tin chi tiết cư dân.'));
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const contracts = useMemo(() => (Array.isArray(tenant?.contracts) ? tenant.contracts : []), [tenant]);
  const occupants = useMemo(() => (Array.isArray(tenant?.occupants) ? tenant.occupants : []), [tenant]);

  const activeContract = useMemo(
    () =>
      contracts.find((c) => ['ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING'].includes(c.status)) ||
      null,
    [contracts]
  );

  const displayTenantStatus = useMemo(() => {
    if (!tenant) return 'INACTIVE';
    if (tenant.status === 'PENDING') return 'PENDING';
    if (activeContract || tenant.status === 'ACTIVE') return 'ACTIVE';
    return 'INACTIVE';
  }, [tenant, activeContract]);

  const latestFrontImg = useMemo(
    () => [...idImages].reverse().find((img) => img.side === 'front') || null,
    [idImages]
  );
  const latestBackImg = useMemo(
    () => [...idImages].reverse().find((img) => img.side === 'back') || null,
    [idImages]
  );

  const handleSaveProfile = async (e) => {
    e?.preventDefault();
    const nextErrs = {};
    if (!String(form.full_name || '').trim()) {
      nextErrs.full_name = 'Họ và tên không được để trống.';
    }
    if (!String(form.phone || '').trim()) {
      nextErrs.phone = 'Số điện thoại không được để trống.';
    } else if (!isValidPhone(form.phone)) {
      nextErrs.phone = 'Số điện thoại không đúng định dạng (10 chữ số).';
    }
    if (form.email && !isValidEmail(form.email)) {
      nextErrs.email = 'Địa chỉ email không hợp lệ.';
    }
    if (form.id_number && !isValidIdNumber(form.id_number)) {
      nextErrs.id_number = 'Số CCCD/CMND hoặc Hộ chiếu không hợp lệ.';
    }
    setErrors(nextErrs);
    if (Object.keys(nextErrs).length > 0) return;

    setSaving(true);
    try {
      const payload = {
        full_name: form.full_name.trim(),
        phone: normalizePhone(form.phone),
        email: form.email.trim() || null,
        id_number: form.id_number.trim() || null,
        dob: form.dob || null,
        nationality: form.nationality.trim() || 'Việt Nam',
        address: form.address.trim() || null,
      };
      const res = await tenantsService.update(id, payload);
      toast.success(res?.message || 'Cập nhật thông tin cá nhân thành công.');
      setIsEditing(false);
      await loadData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu thông tin cư dân.'));
    } finally {
      setSaving(false);
    }
  };

  const handleUploadIdCard = async (side, base64Value) => {
    if (!base64Value) return;
    setUploadingSide(side);
    try {
      const res = await tenantsService.uploadIdImage(id, {
        image_base64: base64Value,
        side,
      });
      toast.success(
        res?.message || `Đã tải lên ảnh CCCD mặt ${side === 'front' ? 'trước' : 'sau'} thành công.`
      );
      const imgRes = await tenantsService.getIdImages(id);
      setIdImages(Array.isArray(imgRes?.data) ? imgRes.data : []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải ảnh CCCD lên máy chủ.'));
    } finally {
      setUploadingSide(null);
    }
  };

  const handleConfirmApproval = async () => {
    setProcessingApproval(true);
    try {
      const payload = {
        action: approvalDialog.action,
      };
      if (form.id_number?.trim()) {
        payload.id_number = form.id_number.trim();
      }
      const res = await tenantsService.update(id, payload);
      toast.success(res?.message || 'Đã cập nhật trạng thái duyệt hồ sơ.');
      setApprovalDialog({ open: false, action: 'approve' });
      await loadData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể duyệt hồ sơ cư dân.'));
    } finally {
      setProcessingApproval(false);
    }
  };

  const contractColumns = useMemo(
    () => [
      {
        key: 'code',
        label: 'Mã hợp đồng',
        render: (row) => (
          <Link
            to={`/admin/contracts/${row.id}`}
            className="font-mono text-xs font-semibold text-primary-600 hover:text-primary-700 hover:underline"
          >
            HĐ-{String(row.id).slice(0, 8).toUpperCase()}
          </Link>
        ),
      },
      {
        key: 'apartment_code',
        label: 'Căn hộ / Tòa nhà',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-semibold text-slate-900">{row.apartment_code}</p>
            <p className="text-xs text-slate-500">{row.building_name}</p>
          </div>
        ),
      },
      {
        key: 'start_date',
        label: 'Thời hạn thuê',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="text-xs text-slate-700">
            {formatDate(row.start_date)} → {formatDate(row.end_date)}
          </span>
        ),
      },
      {
        key: 'rent_amount',
        label: 'Giá thuê / tháng',
        align: 'right',
        sortable: true,
        className: 'font-mono tabular-nums whitespace-nowrap',
        render: (row) => <span className="font-semibold text-slate-800">{formatMoney(row.rent_amount)}</span>,
      },
      {
        key: 'deposit_amount',
        label: 'Tiền đặt cọc',
        align: 'right',
        className: 'font-mono tabular-nums whitespace-nowrap',
        render: (row) => <span className="text-slate-700">{formatMoney(row.deposit_amount)}</span>,
      },
      {
        key: 'status',
        label: 'Trạng thái HĐ',
        align: 'center',
        render: (row) => <StatusBadge status={row.status} domain="contract" />,
      },
      {
        key: 'action',
        label: 'Thao tác',
        align: 'center',
        render: (row) => (
          <Button
            variant="soft"
            size="xs"
            rightIcon={ExternalLink}
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/admin/contracts/${row.id}`);
            }}
          >
            Mở hợp đồng
          </Button>
        ),
      },
    ],
    [navigate]
  );

  const occupantColumns = useMemo(
    () => [
      {
        key: 'full_name',
        label: 'Họ và tên thành viên',
        sortable: true,
        render: (row) => (
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 flex items-center justify-center text-xs font-semibold">
              {getAvatarLetters(row.full_name)}
            </div>
            <span className="font-medium text-slate-900">{row.full_name}</span>
          </div>
        ),
      },
      {
        key: 'relationship',
        label: 'Quan hệ với chủ hộ',
        align: 'center',
        render: (row) => (
          <Badge variant="indigo">
            {RELATIONSHIP_LABELS[row.relationship] || row.relationship || 'Thành viên ở cùng'}
          </Badge>
        ),
      },
      {
        key: 'phone',
        label: 'Số điện thoại',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => <span className="text-slate-700">{row.phone || '—'}</span>,
      },
      {
        key: 'id_number',
        label: 'Số CCCD / Hộ chiếu',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="font-mono text-xs text-slate-700">{row.id_number || 'Chưa cập nhật'}</span>
        ),
      },
      {
        key: 'action',
        label: 'Hồ sơ',
        align: 'center',
        render: (row) =>
          row.tenant_id ? (
            <Button
              variant="ghost"
              size="xs"
              rightIcon={ExternalLink}
              onClick={() => navigate(`/admin/tenants/${row.tenant_id}`)}
            >
              Xem hồ sơ
            </Button>
          ) : null,
      },
    ],
    [navigate]
  );

  if (loading) {
    return <LoadingSpinner label="Đang tải hồ sơ cư dân..." />;
  }

  if (!tenant) {
    return (
      <Card>
        <EmptyState
          title="Không tìm thấy hồ sơ cư dân"
          description="Hồ sơ không tồn tại hoặc bạn không có quyền truy cập."
          action={
            <Button variant="primary" onClick={() => navigate('/admin/tenants')}>
              Quay lại danh sách cư dân
            </Button>
          }
        />
      </Card>
    );
  }

  const tabs = [
    { id: 'profile', label: 'Thông tin cá nhân & CCCD', icon: User },
    { id: 'contracts', label: 'Hợp đồng thuê', icon: FileText, count: contracts.length },
    { id: 'occupants', label: 'Thành viên cùng ở', icon: Users, count: occupants.length },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Quản lý Cư dân', to: '/admin/tenants' },
          { label: tenant.full_name || 'Chi tiết cư dân' },
        ]}
        title={tenant.full_name}
        subtitle={`Mã hồ sơ: ${String(tenant.id).slice(0, 8).toUpperCase()} • Quốc tịch: ${
          tenant.nationality || 'Việt Nam'
        }`}
        actions={
          <>
            {canManageTenants && tenant.status === 'PENDING' ? (
              <>
                <Button
                  variant="outline"
                  icon={XCircle}
                  onClick={() => setApprovalDialog({ open: true, action: 'reject' })}
                >
                  Từ chối hồ sơ
                </Button>
                <Button
                  variant="success"
                  icon={CheckCircle2}
                  onClick={() => setApprovalDialog({ open: true, action: 'approve' })}
                >
                  Duyệt hồ sơ cư dân
                </Button>
              </>
            ) : null}

            {activeContract ? (
              <Button
                variant="primary"
                icon={ArrowRightLeft}
                onClick={() => navigate(`/admin/contracts/${activeContract.id}`)}
              >
                Chuyển phòng / Kết thúc HĐ ({activeContract.apartment_code})
              </Button>
            ) : contracts.length > 0 ? (
              <Button
                variant="soft"
                icon={FileText}
                onClick={() => navigate(`/admin/contracts/${contracts[0].id}`)}
              >
                Xem hợp đồng gần nhất
              </Button>
            ) : null}
          </>
        }
      />

      {/* Thẻ tóm tắt cư dân */}
      <Card className="p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
          <div className="flex items-start sm:items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary-500 to-sky-600 text-white flex items-center justify-center text-xl font-bold shadow-sm shrink-0">
              {getAvatarLetters(tenant.full_name)}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-bold text-slate-900">{tenant.full_name}</h2>
                <StatusBadge status={displayTenantStatus} domain="tenant" />
                {tenant.status === 'APPROVED' ? (
                  <Badge variant="emerald" dot>
                    Đã xác thực giấy tờ
                  </Badge>
                ) : tenant.status === 'PENDING' ? (
                  <Badge variant="amber" dot>
                    Chờ xác thực CCCD
                  </Badge>
                ) : tenant.status === 'REJECTED' ? (
                  <Badge variant="red" dot>
                    Từ chối hồ sơ
                  </Badge>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-600">
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5 text-slate-400" />
                  {tenant.phone || '—'}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-slate-400" />
                  {tenant.email || 'Chưa cập nhật email'}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CreditCard className="w-3.5 h-3.5 text-slate-400" />
                  CCCD/HC: <strong>{tenant.id_number || 'Chưa bổ sung'}</strong>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-slate-400" />
                  Ngày sinh: {formatDate(tenant.dob)}
                </span>
              </div>
            </div>
          </div>

          {activeContract ? (
            <div className="p-3.5 rounded-xl bg-sky-50/70 border border-sky-200/80 flex items-center justify-between gap-4 min-w-[270px]">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">
                  Căn hộ đang thuê
                </p>
                <p className="text-sm font-bold text-slate-900 mt-0.5 flex items-center gap-1.5">
                  <Building2 className="w-4 h-4 text-primary-600" />
                  {activeContract.apartment_code} — {activeContract.building_name}
                </p>
                <p className="text-xs text-slate-600 mt-0.5">
                  Giá thuê: <strong>{formatMoney(activeContract.rent_amount)}</strong> • Hết hạn:{' '}
                  {formatDate(activeContract.end_date)}
                </p>
              </div>
              <Button
                variant="outline"
                size="xs"
                onClick={() => navigate(`/admin/contracts/${activeContract.id}`)}
              >
                Chi tiết HĐ
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      {/* Tabs điều hướng */}
      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {/* TAB 1: Thông tin cá nhân & CCCD */}
      {activeTab === 'profile' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Cột trái: Thông tin cá nhân */}
          <Card className="lg:col-span-7">
            <CardHeader
              title="Thông tin cá nhân & Liên hệ"
              subtitle="Cập nhật họ tên, số điện thoại, CCCD, quốc tịch và địa chỉ thường trú"
              action={
                canManageTenants && tenant.status !== 'MERGED' ? (
                  isEditing ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        icon={X}
                        disabled={saving}
                        onClick={() => {
                          setIsEditing(false);
                          setErrors({});
                          setForm({
                            full_name: tenant.full_name || '',
                            phone: tenant.phone || '',
                            email: tenant.email || '',
                            id_number: tenant.id_number || '',
                            dob: toInputDate(tenant.dob),
                            nationality: tenant.nationality || 'Việt Nam',
                            address: tenant.address || '',
                          });
                        }}
                      >
                        Hủy
                      </Button>
                      <Button variant="primary" size="sm" icon={Save} loading={saving} onClick={handleSaveProfile}>
                        Lưu thông tin
                      </Button>
                    </div>
                  ) : (
                    <Button variant="outline" size="sm" icon={Edit3} onClick={() => setIsEditing(true)}>
                      Chỉnh sửa
                    </Button>
                  )
                ) : null
              }
            />

            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label="Họ và tên"
                  required
                  disabled={!isEditing}
                  value={form.full_name}
                  onChange={(e) => setForm((p) => ({ ...p, full_name: e.target.value }))}
                  error={errors.full_name}
                />
                <Input
                  label="Số điện thoại"
                  required
                  icon={Phone}
                  disabled={!isEditing}
                  value={form.phone}
                  onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                  error={errors.phone}
                />
                <Input
                  label="Số CCCD / Hộ chiếu"
                  icon={CreditCard}
                  disabled={!isEditing}
                  value={form.id_number}
                  onChange={(e) => setForm((p) => ({ ...p, id_number: e.target.value }))}
                  error={errors.id_number}
                  placeholder="Nhập 12 số CCCD hoặc Hộ chiếu"
                />
                <Input
                  label="Email"
                  type="email"
                  icon={Mail}
                  disabled={!isEditing}
                  value={form.email}
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                  error={errors.email}
                  placeholder="name@example.com"
                />
                <Input
                  label="Ngày sinh"
                  type="date"
                  disabled={!isEditing}
                  value={form.dob}
                  onChange={(e) => setForm((p) => ({ ...p, dob: e.target.value }))}
                />
                <Input
                  label="Quốc tịch"
                  icon={Globe}
                  disabled={!isEditing}
                  value={form.nationality}
                  onChange={(e) => setForm((p) => ({ ...p, nationality: e.target.value }))}
                  placeholder="Việt Nam"
                />
              </div>

              <Input
                label="Địa chỉ thường trú"
                multiline
                rows={3}
                icon={MapPin}
                disabled={!isEditing}
                value={form.address}
                onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                placeholder="Số nhà, đường, phường/xã, quận/huyện, tỉnh/thành phố..."
              />
            </form>
          </Card>

          {/* Cột phải: Ảnh CCCD mặt trước & mặt sau */}
          <Card className="lg:col-span-5">
            <CardHeader
              title="Ảnh định danh CCCD / Hộ chiếu"
              subtitle="Lưu trữ bảo mật và ghi nhật ký truy cập (PRD 17.1)"
              action={
                latestFrontImg && latestBackImg ? (
                  <Badge variant="emerald" icon={ShieldCheck}>
                    Đủ 2 mặt
                  </Badge>
                ) : (
                  <Badge variant="amber">Chưa đủ 2 mặt</Badge>
                )
              }
            />

            {!tenant.id_number ? (
              <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs text-amber-800">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>
                  Cư dân chưa cập nhật số CCCD/Hộ chiếu. Vui lòng cập nhật số giấy tờ và đính kèm ảnh chụp 2 mặt để đủ điều kiện kích hoạt hợp đồng thuê.
                </span>
              </div>
            ) : null}

            <div className="space-y-5">
              {/* Mặt trước */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700">1. Mặt trước CCCD (Front)</span>
                  {latestFrontImg ? (
                    <button
                      type="button"
                      onClick={() => {
                        setPreviewTitle('CCCD Mặt trước — ' + tenant.full_name);
                        setPreviewSrc(`/api/v1/attachments/${latestFrontImg.attachment_id}/view`);
                      }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                      Phóng to
                    </button>
                  ) : null}
                </div>

                {latestFrontImg ? (
                  <div
                    onClick={() => {
                      setPreviewTitle('CCCD Mặt trước — ' + tenant.full_name);
                      setPreviewSrc(`/api/v1/attachments/${latestFrontImg.attachment_id}/view`);
                    }}
                    className="w-full h-44 rounded-xl border border-slate-200 overflow-hidden bg-slate-50 cursor-pointer hover:border-primary-400 transition-colors"
                  >
                    <AuthImage
                      src={`/api/v1/attachments/${latestFrontImg.attachment_id}/view`}
                      alt="CCCD mặt trước"
                      className="w-full h-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="w-full h-32 rounded-xl border border-dashed border-slate-200 bg-slate-50 flex items-center justify-center text-xs text-slate-400">
                    Chưa có ảnh mặt trước
                  </div>
                )}

                {canManageTenants && tenant.status !== 'MERGED' ? (
                  <FileUpload
                    value=""
                    onChange={(b64) => handleUploadIdCard('front', b64)}
                    hint={
                      uploadingSide === 'front'
                        ? 'Đang tải ảnh mặt trước lên...'
                        : latestFrontImg
                        ? 'Tải ảnh mới để cập nhật mặt trước (JPG/PNG ≤ 5MB)'
                        : 'Tải lên ảnh mặt trước CCCD (JPG/PNG ≤ 5MB)'
                    }
                  />
                ) : null}
              </div>

              {/* Mặt sau */}
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700">2. Mặt sau CCCD (Back)</span>
                  {latestBackImg ? (
                    <button
                      type="button"
                      onClick={() => {
                        setPreviewTitle('CCCD Mặt sau — ' + tenant.full_name);
                        setPreviewSrc(`/api/v1/attachments/${latestBackImg.attachment_id}/view`);
                      }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                      Phóng to
                    </button>
                  ) : null}
                </div>

                {latestBackImg ? (
                  <div
                    onClick={() => {
                      setPreviewTitle('CCCD Mặt sau — ' + tenant.full_name);
                      setPreviewSrc(`/api/v1/attachments/${latestBackImg.attachment_id}/view`);
                    }}
                    className="w-full h-44 rounded-xl border border-slate-200 overflow-hidden bg-slate-50 cursor-pointer hover:border-primary-400 transition-colors"
                  >
                    <AuthImage
                      src={`/api/v1/attachments/${latestBackImg.attachment_id}/view`}
                      alt="CCCD mặt sau"
                      className="w-full h-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="w-full h-32 rounded-xl border border-dashed border-slate-200 bg-slate-50 flex items-center justify-center text-xs text-slate-400">
                    Chưa có ảnh mặt sau
                  </div>
                )}

                {canManageTenants && tenant.status !== 'MERGED' ? (
                  <FileUpload
                    value=""
                    onChange={(b64) => handleUploadIdCard('back', b64)}
                    hint={
                      uploadingSide === 'back'
                        ? 'Đang tải ảnh mặt sau lên...'
                        : latestBackImg
                        ? 'Tải ảnh mới để cập nhật mặt sau (JPG/PNG ≤ 5MB)'
                        : 'Tải lên ảnh mặt sau CCCD (JPG/PNG ≤ 5MB)'
                    }
                  />
                ) : null}
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {/* TAB 2: Hợp đồng thuê */}
      {activeTab === 'contracts' ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Lịch sử hợp đồng đứng tên</h3>
              <p className="text-xs text-slate-500">
                Nhấn vào từng hợp đồng để thực hiện chuyển phòng, gia hạn, phụ lục hoặc chấm dứt hợp đồng.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate('/admin/contracts')}>
              Tất cả hợp đồng
            </Button>
          </div>

          <DataTable
            columns={contractColumns}
            data={contracts}
            onRowClick={(row) => navigate(`/admin/contracts/${row.id}`)}
            emptyTitle="Cư dân chưa đứng tên hợp đồng nào"
            emptyDescription="Bạn có thể tạo hợp đồng nháp mới cho cư dân tại phân hệ Hợp đồng thuê."
            emptyAction={
              <Button variant="primary" size="sm" onClick={() => navigate('/admin/contracts')}>
                Đi tới Hợp đồng thuê
              </Button>
            }
          />
        </div>
      ) : null}

      {/* TAB 3: Thành viên cùng ở */}
      {activeTab === 'occupants' ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Danh sách thành viên cùng lưu trú</h3>
              <p className="text-xs text-slate-500">
                Các thành viên được đăng ký ở cùng theo hợp đồng hiện tại của cư dân.
              </p>
            </div>
            {activeContract ? (
              <Button
                variant="soft"
                size="sm"
                rightIcon={ExternalLink}
                onClick={() => navigate(`/admin/contracts/${activeContract.id}`)}
              >
                Quản lý người ở cùng trên HĐ {activeContract.apartment_code}
              </Button>
            ) : null}
          </div>

          <DataTable
            columns={occupantColumns}
            data={occupants}
            rowKey="tenant_id"
            emptyTitle="Chưa có thành viên ở cùng"
            emptyDescription="Nếu căn hộ có người thân hoặc bạn cùng phòng lưu trú, BQL có thể thêm trực tiếp trên trang chi tiết hợp đồng."
          />
        </div>
      ) : null}

      {/* Modal phóng to ảnh CCCD */}
      <Modal
        open={Boolean(previewSrc)}
        onClose={() => setPreviewSrc(null)}
        title={previewTitle || 'Xem ảnh CCCD'}
        size="lg"
        footer={
          <Button variant="outline" onClick={() => setPreviewSrc(null)}>
            Đóng
          </Button>
        }
      >
        <div className="flex items-center justify-center bg-slate-900/5 rounded-xl p-2 min-h-[320px]">
          {previewSrc ? (
            <AuthImage src={previewSrc} alt={previewTitle} className="max-h-[70vh] w-auto rounded-lg object-contain" />
          ) : null}
        </div>
      </Modal>

      {/* Xác nhận duyệt / từ chối hồ sơ cư dân PENDING */}
      <ConfirmDialog
        open={approvalDialog.open}
        onClose={() => setApprovalDialog({ open: false, action: 'approve' })}
        onConfirm={handleConfirmApproval}
        loading={processingApproval}
        variant={approvalDialog.action === 'approve' ? 'success' : 'danger'}
        title={
          approvalDialog.action === 'approve' ? 'Phê duyệt hồ sơ cư dân' : 'Từ chối hồ sơ cư dân'
        }
        confirmLabel={approvalDialog.action === 'approve' ? 'Xác nhận duyệt' : 'Từ chối hồ sơ'}
        message={
          approvalDialog.action === 'approve'
            ? `Xác nhận phê duyệt hồ sơ định danh của cư dân "${tenant.full_name}"? Cư dân cần có số CCCD/Hộ chiếu hợp lệ để được duyệt sang trạng thái APPROVED.`
            : `Bạn có chắc chắn muốn từ chối hồ sơ của cư dân "${tenant.full_name}"?`
        }
      />
    </div>
  );
}

export default TenantDetailPage;
