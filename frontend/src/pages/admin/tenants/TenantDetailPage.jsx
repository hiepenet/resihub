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
  Sparkles,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { AISuggestionField } from '../../../components/ui/AISuggestionField';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { EmptyState } from '../../../components/common/EmptyState';
import { LoadingSpinner } from '../../../components/common/LoadingSpinner';
import { tenantsService } from '../../../services/tenants.service';
import { aiService } from '../../../services/ai.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate, toInputDate } from '../../../utils/format';
import {
  createAiFieldTracker,
  markFieldConfirmedOrEdited,
  mapAiErrorToVietnamese,
} from '../../../utils/aiHelpers';
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
  const { canManageTenants, isSysAdmin } = usePermission();

  const [tenant, setTenant] = useState(null);
  const [idImages, setIdImages] = useState([]);
  const [idImagesMeta, setIdImagesMeta] = useState({ maskedForOwner: false, hasIdImages: false });
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
  const [aiScanFiles, setAiScanFiles] = useState([]);
  const [aiScanConsent, setAiScanConsent] = useState(true);
  const [extractingCccd, setExtractingCccd] = useState(false);
  const [cccdAiTracker, setCccdAiTracker] = useState(null);
  const [cccdAiError, setCccdAiError] = useState(null);

  // Approve / Reject pending tenant profile
  const [approvalDialog, setApprovalDialog] = useState({ open: false, action: 'approve', reason: '', error: '' });
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
      setIdImagesMeta({
        maskedForOwner: Boolean(imgRes?.masked_for_owner),
        hasIdImages: Boolean(imgRes?.has_id_images),
      });
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
    if (tenant.status === 'MERGED') return 'MERGED';
    if (tenant.status === 'REJECTED') return 'REJECTED';
    if (activeContract || tenant.status === 'ACTIVE') return 'ACTIVE';
    if (tenant.status === 'PENDING') return 'PENDING';
    if (tenant.has_past_contract || tenant.status === 'MOVED_OUT' || tenant.status === 'INACTIVE') {
      return 'MOVED_OUT';
    }
    return 'APPROVED';
  }, [tenant, activeContract]);

  const latestFrontImg = useMemo(
    () => [...idImages].reverse().find((img) => img.side === 'front') || null,
    [idImages]
  );
  const latestBackImg = useMemo(
    () => [...idImages].reverse().find((img) => img.side === 'back') || null,
    [idImages]
  );
  const otherIdImgs = useMemo(
    () => idImages.filter((img) => img.side !== 'front' && img.side !== 'back'),
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
        ...(cccdAiTracker?.suggestionId ? { ai_suggestion_id: cccdAiTracker.suggestionId } : {}),
      };
      const res = await tenantsService.update(id, payload);
      toast.success(res?.message || 'Cập nhật thông tin cá nhân thành công.');
      setCccdAiTracker(null);
      setIsEditing(false);
      await loadData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu thông tin cư dân.'));
    } finally {
      setSaving(false);
    }
  };

  const handleExtractDetailCccd = async () => {
    const files = Array.isArray(aiScanFiles) ? aiScanFiles.filter(Boolean) : [];
    if (files.length === 0) {
      toast.warning('Vui lòng chọn hoặc tải lên ít nhất 1 ảnh CCCD để AI trích xuất.');
      return;
    }
    setExtractingCccd(true);
    setCccdAiError(null);
    try {
      const res = await aiService.extractDocument({
        document_type: 'CCCD',
        building_id: activeContract?.building_id || tenant?.desired_building_id || undefined,
        files,
        privacy_acknowledged: Boolean(aiScanConsent),
      });
      const data = res?.data || res;
      const out = data?.output || {};
      const sharedLocked = Boolean(tenant?.is_shared_profile && !isSysAdmin);

      const nextMapped = {};
      if (out.full_name && !(sharedLocked && tenant?.full_name)) {
        nextMapped.full_name = String(out.full_name).trim();
      }
      if (out.id_number && !(sharedLocked && tenant?.id_number)) {
        nextMapped.id_number = String(out.id_number).trim();
      }
      if (out.dob && !(sharedLocked && tenant?.dob)) {
        nextMapped.dob = toInputDate(out.dob);
      }
      if (out.permanent_address) {
        nextMapped.address = String(out.permanent_address).trim();
      }

      setForm((prev) => ({
        ...prev,
        ...(nextMapped.full_name ? { full_name: nextMapped.full_name } : {}),
        ...(nextMapped.id_number ? { id_number: nextMapped.id_number } : {}),
        ...(nextMapped.dob ? { dob: nextMapped.dob } : {}),
        ...(nextMapped.address ? { address: nextMapped.address } : {}),
      }));

      const baseConf = data?.confidence ?? null;
      const confMap = {
        full_name: out.field_confidences?.full_name ?? baseConf,
        id_number: out.field_confidences?.id_number ?? baseConf,
        dob: out.field_confidences?.dob ?? baseConf,
        address: out.field_confidences?.permanent_address ?? baseConf,
      };
      setCccdAiTracker(createAiFieldTracker(data?.suggestion_id, nextMapped, confMap));
      setIsEditing(true);
      toast.success('AI đã điền nháp thông tin từ CCCD — vui lòng kiểm tra và bấm "Lưu thông tin".');
    } catch (err) {
      setCccdAiError(mapAiErrorToVietnamese(err));
    } finally {
      setExtractingCccd(false);
    }
  };

  const dismissDetailAiField = (fieldKey) => {
    setCccdAiTracker((prev) => {
      if (!prev?.fields?.[fieldKey]) return prev;
      const nextFields = { ...prev.fields };
      delete nextFields[fieldKey];
      return { ...prev, fields: nextFields };
    });
  };

  const handleUploadIdCard = async (side, base64Value) => {
    if (!base64Value) return;
    setAiScanFiles((prev) => [base64Value, ...prev.filter((item) => item !== base64Value)].slice(0, 2));
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
    if (approvalDialog.action === 'reject' && !String(approvalDialog.reason || '').trim()) {
      setApprovalDialog((prev) => ({
        ...prev,
        error: 'Vui lòng nhập lý do từ chối để cư dân biết cần bổ sung thông tin gì.',
      }));
      return;
    }
    setProcessingApproval(true);
    try {
      const payload = {
        action: approvalDialog.action,
      };
      if (approvalDialog.action === 'reject') {
        payload.reason = approvalDialog.reason.trim();
      }
      if (form.id_number?.trim()) {
        payload.id_number = form.id_number.trim();
      }
      const res = await tenantsService.update(id, payload);
      toast.success(res?.message || 'Đã cập nhật trạng thái duyệt hồ sơ.');
      setApprovalDialog({ open: false, action: 'approve', reason: '', error: '' });
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
          <div>
            <Link
              to={`/admin/contracts/${row.id}`}
              className="font-mono text-xs font-semibold text-primary-600 hover:text-primary-700 hover:underline"
            >
              HĐ-{String(row.id).slice(0, 8).toUpperCase()}
            </Link>
            {row.member_role === 'occupant' ? (
              <p className="text-[11px] text-indigo-600 font-medium mt-0.5">Thành viên ở cùng</p>
            ) : null}
          </div>
        ),
      },
      {
        key: 'apartment_code',
        label: 'Căn hộ / Tòa nhà',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-semibold text-slate-900">{row.apartment_code}</p>
            <p className="text-xs text-slate-500 break-words">{row.building_name}</p>
          </div>
        ),
      },
      {
        key: 'start_date',
        label: 'Thời hạn thuê',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => (
          <div className="text-xs text-slate-700">
            <p>
              {formatDate(row.start_date)} → {formatDate(row.end_date)}
            </p>
            {row.terminated_at ? (
              <p className="text-[11px] text-amber-700 font-medium mt-0.5">
                Thanh lý: {formatDate(row.terminated_at)}
              </p>
            ) : null}
          </div>
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
                  onClick={() => setApprovalDialog({ open: true, action: 'reject', reason: '', error: '' })}
                >
                  Từ chối hồ sơ
                </Button>
                <Button
                  variant="success"
                  icon={CheckCircle2}
                  onClick={() => setApprovalDialog({ open: true, action: 'approve', reason: '', error: '' })}
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

      {/* Thẻ thông tin nguyện vọng đăng ký thuê trực tuyến / lý do từ chối / đồng ý dữ liệu cá nhân */}
      {(tenant.desired_apartment_code || tenant.application_note || tenant.rejection_reason || tenant.privacy_consent_at) ? (
        <Card className="p-4 bg-slate-50/70 border-slate-200/80">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
            <div className="space-y-1">
              {tenant.desired_apartment_code ? (
                <p className="text-slate-700">
                  <span className="font-semibold text-slate-900">Nguyện vọng đăng ký thuê:</span>{' '}
                  Căn <strong>{tenant.desired_apartment_code}</strong>
                  {tenant.desired_building_name ? ` — ${tenant.desired_building_name}` : ''}
                </p>
              ) : null}
              {tenant.application_note ? (
                <p className="text-slate-600">
                  <span className="font-semibold text-slate-800">Ghi chú từ cư dân:</span> {tenant.application_note}
                </p>
              ) : null}
              {tenant.status === 'REJECTED' && tenant.rejection_reason ? (
                <p className="text-rose-700 font-medium">
                  <span className="font-semibold">Lý do từ chối gần nhất:</span> {tenant.rejection_reason}
                </p>
              ) : null}
            </div>
            {tenant.privacy_consent_at ? (
              <Badge variant="emerald" icon={ShieldCheck}>
                Đã đồng ý xử lý DLCN ({formatDate(tenant.privacy_consent_at)})
              </Badge>
            ) : (
              <Badge variant="slate">Chưa ghi nhận đồng ý DLCN trực tuyến</Badge>
            )}
          </div>
        </Card>
      ) : null}

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
              {tenant.is_shared_profile && !isSysAdmin ? (
                <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <div className="leading-relaxed">
                    <p className="font-semibold">Hồ sơ định danh chung liên tòa (Shared Profile Lock)</p>
                    <p className="text-amber-800 mt-0.5">
                      Cư dân đang đồng thời thuê căn hộ tại tòa nhà khác trên hệ thống. Các thông tin định danh gốc đã xác thực (Họ tên, SĐT, CCCD, Ngày sinh) được khóa đối với Quản lý tòa — chỉ Cư dân tự cập nhật trên Cổng cư dân hoặc Quản trị hệ thống (SYS_ADMIN) điều chỉnh.
                    </p>
                  </div>
                </div>
              ) : null}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <AISuggestionField
                  active={Boolean(isEditing && cccdAiTracker?.fields?.full_name?.active)}
                  confirmed={Boolean(cccdAiTracker?.fields?.full_name?.confirmed)}
                  edited={Boolean(cccdAiTracker?.fields?.full_name?.edited)}
                  confidence={cccdAiTracker?.fields?.full_name?.confidence}
                  onConfirm={() =>
                    setCccdAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'full_name', form.full_name))
                  }
                  onDismiss={() => dismissDetailAiField('full_name')}
                >
                  <Input
                    label="Họ và tên"
                    required
                    disabled={!isEditing || Boolean(tenant.is_shared_profile && !isSysAdmin && tenant.full_name)}
                    value={form.full_name}
                    onChange={(e) => {
                      const val = e.target.value;
                      setForm((p) => ({ ...p, full_name: val }));
                      setCccdAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'full_name', val));
                    }}
                    error={errors.full_name}
                  />
                </AISuggestionField>
                <Input
                  label="Số điện thoại"
                  required
                  icon={Phone}
                  disabled={!isEditing || Boolean(tenant.is_shared_profile && !isSysAdmin && tenant.phone)}
                  value={form.phone}
                  onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                  error={errors.phone}
                />
                <AISuggestionField
                  active={Boolean(isEditing && cccdAiTracker?.fields?.id_number?.active)}
                  confirmed={Boolean(cccdAiTracker?.fields?.id_number?.confirmed)}
                  edited={Boolean(cccdAiTracker?.fields?.id_number?.edited)}
                  confidence={cccdAiTracker?.fields?.id_number?.confidence}
                  onConfirm={() =>
                    setCccdAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'id_number', form.id_number))
                  }
                  onDismiss={() => dismissDetailAiField('id_number')}
                >
                  <Input
                    label="Số CCCD / Hộ chiếu"
                    icon={CreditCard}
                    disabled={!isEditing || Boolean(tenant.is_shared_profile && !isSysAdmin && tenant.id_number)}
                    value={form.id_number}
                    onChange={(e) => {
                      const val = e.target.value;
                      setForm((p) => ({ ...p, id_number: val }));
                      setCccdAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'id_number', val));
                    }}
                    error={errors.id_number}
                    placeholder="Nhập 12 số CCCD hoặc Hộ chiếu"
                  />
                </AISuggestionField>
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
                <AISuggestionField
                  active={Boolean(isEditing && cccdAiTracker?.fields?.dob?.active)}
                  confirmed={Boolean(cccdAiTracker?.fields?.dob?.confirmed)}
                  edited={Boolean(cccdAiTracker?.fields?.dob?.edited)}
                  confidence={cccdAiTracker?.fields?.dob?.confidence}
                  onConfirm={() =>
                    setCccdAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'dob', form.dob))
                  }
                  onDismiss={() => dismissDetailAiField('dob')}
                >
                  <Input
                    label="Ngày sinh"
                    type="date"
                    disabled={!isEditing || Boolean(tenant.is_shared_profile && !isSysAdmin && tenant.dob)}
                    value={form.dob}
                    onChange={(e) => {
                      const val = e.target.value;
                      setForm((p) => ({ ...p, dob: val }));
                      setCccdAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'dob', val));
                    }}
                  />
                </AISuggestionField>
                <Input
                  label="Quốc tịch"
                  icon={Globe}
                  disabled={!isEditing}
                  value={form.nationality}
                  onChange={(e) => setForm((p) => ({ ...p, nationality: e.target.value }))}
                  placeholder="Việt Nam"
                />
              </div>

              <AISuggestionField
                active={Boolean(isEditing && cccdAiTracker?.fields?.address?.active)}
                confirmed={Boolean(cccdAiTracker?.fields?.address?.confirmed)}
                edited={Boolean(cccdAiTracker?.fields?.address?.edited)}
                confidence={cccdAiTracker?.fields?.address?.confidence}
                onConfirm={() =>
                  setCccdAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'address', form.address))
                }
                onDismiss={() => dismissDetailAiField('address')}
              >
                <Input
                  label="Địa chỉ thường trú"
                  multiline
                  rows={3}
                  icon={MapPin}
                  disabled={!isEditing}
                  value={form.address}
                  onChange={(e) => {
                    const val = e.target.value;
                    setForm((p) => ({ ...p, address: val }));
                    setCccdAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'address', val));
                  }}
                  placeholder="Số nhà, đường, phường/xã, quận/huyện, tỉnh/thành phố..."
                />
              </AISuggestionField>
            </form>
          </Card>

          {/* Cột phải: Ảnh CCCD mặt trước & mặt sau */}
          <Card className="lg:col-span-5">
            <CardHeader
              title="Ảnh định danh CCCD / Hộ chiếu"
              subtitle="Lưu trữ bảo mật và ghi nhật ký truy cập (PRD 17.1)"
              action={
                idImagesMeta.maskedForOwner ? (
                  <Badge variant="indigo" icon={ShieldCheck}>
                    {idImagesMeta.hasIdImages ? 'Đã lưu bảo mật' : 'Ẩn theo quyền CĐT'}
                  </Badge>
                ) : latestFrontImg && latestBackImg ? (
                  <Badge variant="emerald" icon={ShieldCheck}>
                    Đủ 2 mặt
                  </Badge>
                ) : (
                  <Badge variant="amber">Chưa đủ 2 mặt</Badge>
                )
              }
            />

            {idImagesMeta.maskedForOwner ? (
              <div className="p-4 rounded-xl bg-indigo-50/70 border border-indigo-200/80 text-xs text-indigo-900 space-y-1.5 leading-relaxed">
                <p className="font-semibold flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-indigo-600 shrink-0" />
                  Bảo mật giấy tờ tùy thân gốc (PRD Mục 13.5)
                </p>
                <p className="text-indigo-800">
                  {idImagesMeta.hasIdImages
                    ? 'Hồ sơ này đã có tệp ảnh CCCD/Hộ chiếu được lưu trữ mã hóa. Theo quy định phân quyền, chỉ Ban Quản Lý tòa nhà và Quản trị hệ thống mới có quyền xem ảnh gốc.'
                    : 'Theo quy định phân quyền, ảnh chụp CCCD/Hộ chiếu gốc chỉ hiển thị với Ban Quản Lý tòa nhà và Quản trị hệ thống.'}
                </p>
              </div>
            ) : !tenant.id_number ? (
              <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs text-amber-800">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>
                  Cư dân chưa cập nhật số CCCD/Hộ chiếu. Vui lòng cập nhật số giấy tờ và đính kèm ảnh chụp 2 mặt để đủ điều kiện kích hoạt hợp đồng thuê.
                </span>
              </div>
            ) : null}

            {!idImagesMeta.maskedForOwner ? (
            <div className="space-y-5">
              {canManageTenants && tenant.status !== 'MERGED' ? (
                <div className="p-3.5 rounded-xl bg-indigo-50/50 border border-indigo-200/80 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-indigo-950 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                      Quét nhanh CCCD bằng AI (AI-01)
                    </span>
                    {cccdAiTracker?.suggestionId ? (
                      <button
                        type="button"
                        onClick={async () => {
                          const sid = cccdAiTracker.suggestionId;
                          setCccdAiTracker(null);
                          try {
                            await aiService.reviewSuggestion(sid, { decision: 'REJECT' });
                          } catch {
                            // Bỏ qua lỗi mạng khi hủy nháp
                          }
                        }}
                        className="text-[11px] font-medium text-rose-700 hover:underline"
                      >
                        Hủy nháp AI
                      </button>
                    ) : null}
                  </div>
                  <FileUpload
                    multiple
                    maxFiles={2}
                    value={aiScanFiles}
                    onChange={(arr) => setAiScanFiles(Array.isArray(arr) ? arr : [])}
                    hint="Chọn ảnh CCCD để AI điền nháp vào biểu mẫu bên trái (tối đa 2 ảnh)"
                  />
                  {aiScanFiles.length > 0 ? (
                    <div className="space-y-2 pt-1">
                      <label className="flex items-start gap-2 text-[11px] text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(aiScanConsent)}
                          onChange={(e) => setAiScanConsent(e.target.checked)}
                          className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span>
                          Xác nhận cư dân đã đồng ý xử lý ảnh giấy tờ bằng AI (bấm &quot;Lưu thông tin&quot; để chốt dữ liệu).
                        </span>
                      </label>
                      <Button
                        type="button"
                        variant="soft"
                        size="sm"
                        icon={Sparkles}
                        loading={extractingCccd}
                        onClick={handleExtractDetailCccd}
                      >
                        Trích xuất sang biểu mẫu (AI)
                      </Button>
                    </div>
                  ) : null}
                  {cccdAiError ? (
                    <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-0.5">
                      <p className="font-semibold">{cccdAiError.title}</p>
                      <p className="text-amber-800">{cccdAiError.guidance}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}

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

              {otherIdImgs.length > 0 ? (
                <div className="space-y-2 pt-2 border-t border-slate-100">
                  <span className="text-xs font-semibold text-slate-700">
                    3. Tệp giấy tờ đính kèm khác ({otherIdImgs.length})
                  </span>
                  <div className="grid grid-cols-2 gap-2.5">
                    {otherIdImgs.map((img, idx) => {
                      const src = `/api/v1/attachments/${img.attachment_id}/view`;
                      return (
                        <div
                          key={img.attachment_id || idx}
                          onClick={() => {
                            setPreviewTitle(`Giấy tờ #${idx + 1} — ${tenant.full_name}`);
                            setPreviewSrc(src);
                          }}
                          className="h-28 rounded-xl border border-slate-200 overflow-hidden bg-slate-50 cursor-pointer hover:border-primary-400 transition-colors"
                        >
                          <AuthImage src={src} alt={`Giấy tờ #${idx + 1}`} className="w-full h-full object-cover" />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
            ) : null}
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
      {approvalDialog.action === 'approve' ? (
        <ConfirmDialog
          open={approvalDialog.open}
          onClose={() => setApprovalDialog({ open: false, action: 'approve', reason: '', error: '' })}
          onConfirm={handleConfirmApproval}
          loading={processingApproval}
          variant="success"
          title="Phê duyệt hồ sơ cư dân"
          confirmLabel="Xác nhận duyệt"
          message={`Xác nhận phê duyệt hồ sơ định danh của cư dân "${tenant.full_name}"? Cư dân cần có số CCCD/Hộ chiếu hợp lệ để được duyệt sang trạng thái APPROVED.`}
        />
      ) : (
        <Modal
          open={approvalDialog.open}
          onClose={() =>
            !processingApproval && setApprovalDialog({ open: false, action: 'approve', reason: '', error: '' })
          }
          title="Từ chối hồ sơ cư dân"
          subtitle={`Nhập lý do từ chối để thông báo cho "${tenant.full_name}" cập nhật lại hồ sơ trên Cổng cư dân`}
          size="md"
          footer={
            <>
              <Button
                variant="outline"
                disabled={processingApproval}
                onClick={() => setApprovalDialog({ open: false, action: 'approve', reason: '', error: '' })}
              >
                Hủy
              </Button>
              <Button variant="danger" loading={processingApproval} onClick={handleConfirmApproval}>
                Xác nhận từ chối
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <Input
              multiline
              rows={3}
              required
              label="Lý do từ chối / Yêu cầu bổ sung"
              placeholder="Ví dụ: Ảnh mặt sau CCCD bị lóa sáng, số CCCD chưa khớp với ảnh chụp..."
              value={approvalDialog.reason}
              error={approvalDialog.error}
              onChange={(e) =>
                setApprovalDialog((prev) => ({ ...prev, reason: e.target.value, error: '' }))
              }
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

export default TenantDetailPage;
