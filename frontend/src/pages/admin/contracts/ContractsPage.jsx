import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  FileText,
  Plus,
  Download,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Eye,
  Inbox,
  FileSignature,
  Calendar,
  Users,
  UserPlus,
  ShieldCheck,
  Search,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { SearchBar } from '../../../components/common/SearchBar';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { contractsService } from '../../../services/contracts.service';
import { buildingsService } from '../../../services/buildings.service';
import { tenantsService } from '../../../services/tenants.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney, formatDate, exportToCsv } from '../../../utils/format';
import {
  extractErrorMessage,
  isValidPhone,
  normalizePhone,
  isValidEmail,
  isValidIdNumber,
} from '../../../utils/validation';

const CONTRACT_STATUS_OPTIONS = [
  { value: 'DRAFT', label: 'Bản nháp (DRAFT)' },
  { value: 'PENDING_APPROVAL', label: 'Chờ phê duyệt giá (PENDING_APPROVAL)' },
  { value: 'ACTIVE', label: 'Đang hiệu lực (ACTIVE)' },
  { value: 'RENEWAL_PENDING', label: 'Chờ duyệt gia hạn (RENEWAL_PENDING)' },
  { value: 'TERMINATION_PENDING', label: 'Chờ duyệt chấm dứt (TERMINATION_PENDING)' },
  { value: 'EXPIRED', label: 'Đã hết hạn (EXPIRED)' },
  { value: 'TERMINATED', label: 'Đã thanh lý (TERMINATED)' },
];

const REQUEST_STATUS_OPTIONS = [
  { value: 'SUBMITTED', label: 'Chờ xử lý (SUBMITTED)' },
  { value: 'APPROVED', label: 'Đã phê duyệt (APPROVED)' },
  { value: 'REJECTED', label: 'Đã từ chối (REJECTED)' },
];

const REQUEST_TYPE_MAP = {
  RENEWAL: { label: 'Gia hạn hợp đồng', variant: 'sky' },
  TERMINATION: { label: 'Chấm dứt hợp đồng', variant: 'amber' },
  REGISTRATION: { label: 'Đăng ký thuê mới', variant: 'emerald' },
  REGISTER: { label: 'Đăng ký thuê mới', variant: 'emerald' },
};

const REQUEST_STATUS_BADGE = {
  SUBMITTED: { label: 'Chờ duyệt', variant: 'amber' },
  APPROVED: { label: 'Đã duyệt', variant: 'emerald' },
  REJECTED: { label: 'Đã từ chối', variant: 'red' },
};

function addMonthsStr(dateStr, months) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

const INITIAL_NEW_TENANT = {
  full_name: '',
  phone: '',
  id_number: '',
  email: '',
  dob: '',
  nationality: 'Việt Nam',
  address: '',
  password: '',
};

export function ContractsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const { canCreateContracts, canApproveContracts } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [activeTab, setActiveTab] = useState('list');
  const [contracts, setContracts] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [reqStatusFilter, setReqStatusFilter] = useState('');

  // Create Draft Modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [buildings, setBuildings] = useState([]);
  const [apartments, setApartments] = useState([]);
  const [loadingRefData, setLoadingRefData] = useState(false);
  const [submittingCreate, setSubmittingCreate] = useState(false);
  const [createErrors, setCreateErrors] = useState({});

  // Chế độ chọn khách thuê: 'existing' (tra cứu SĐT/CCCD bảo mật) | 'new' (cư dân mới chưa nằm trong hệ thống)
  const [tenantMode, setTenantMode] = useState('existing');
  const [tenantIdentifier, setTenantIdentifier] = useState('');
  const [tenantLookupLoading, setTenantLookupLoading] = useState(false);
  const [lookedUpTenant, setLookedUpTenant] = useState(null);
  const [tenantLookupState, setTenantLookupState] = useState(null);
  const [newTenantForm, setNewTenantForm] = useState(INITIAL_NEW_TENANT);
  const [dupInfo, setDupInfo] = useState({ isDuplicate: false, inScope: true, duplicates: [], message: '' });
  const [dupChecking, setDupChecking] = useState(false);

  const [todayStr] = useState(() => new Date().toISOString().slice(0, 10));
  const [createForm, setCreateForm] = useState({
    building_id: '',
    apartment_id: '',
    primary_tenant_id: '',
    start_date: todayStr,
    end_date: addMonthsStr(todayStr, 12),
    rent_amount: '',
    deposit_amount: '',
    billing_cycle: 'monthly',
    billing_day: '1',
    note: '',
  });

  // Approve / Reject Resident Request state
  const [approveReqTarget, setApproveReqTarget] = useState(null);
  const [rejectReqTarget, setRejectReqTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [processingReq, setProcessingReq] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const queryParams = {};
      if (selectedBuildingId) queryParams.building_id = selectedBuildingId;

      const [cRes, rRes] = await Promise.all([
        contractsService.list(queryParams),
        contractsService.listRequests(queryParams).catch(() => ({ data: [] })),
      ]);
      setContracts(Array.isArray(cRes?.data) ? cRes.data : []);
      setRequests(Array.isArray(rRes?.data) ? rRes.data : []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách hợp đồng.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Load tòa nhà + căn hộ khi mở modal tạo HĐ nháp (KHÔNG tải danh sách cư dân công khai để bảo mật PII)
  const handleOpenCreate = useCallback(async (preselectAptId = '') => {
    const cleanAptId = typeof preselectAptId === 'string' ? preselectAptId : '';
    const defaultBld = selectedBuildingId || '';
    setCreateForm({
      building_id: defaultBld,
      apartment_id: cleanAptId,
      primary_tenant_id: '',
      start_date: todayStr,
      end_date: addMonthsStr(todayStr, 12),
      rent_amount: '',
      deposit_amount: '',
      billing_cycle: 'monthly',
      billing_day: '1',
      note: '',
    });
    setTenantMode('existing');
    setTenantIdentifier('');
    setLookedUpTenant(null);
    setTenantLookupState(null);
    setNewTenantForm(INITIAL_NEW_TENANT);
    setDupInfo({ isDuplicate: false, inScope: true, duplicates: [], message: '' });
    setCreateErrors({});
    setCreateOpen(true);

    setLoadingRefData(true);
    try {
      const [bRes, aRes] = await Promise.all([
        buildingsService.list(),
        buildingsService.listApartments(
          !cleanAptId && defaultBld ? { building_id: defaultBld } : {}
        ),
      ]);
      const bList = Array.isArray(bRes?.data) ? bRes.data : [];
      const aList = Array.isArray(aRes?.data) ? aRes.data : [];
      setBuildings(bList);
      setApartments(aList);

      if (cleanAptId) {
        const matchedApt = aList.find((a) => String(a.id) === String(cleanAptId));
        if (matchedApt) {
          const base = matchedApt.base_rent ? String(Math.round(Number(matchedApt.base_rent))) : '';
          setCreateForm((p) => ({
            ...p,
            building_id: matchedApt.building_id || p.building_id,
            apartment_id: matchedApt.id,
            rent_amount: base || p.rent_amount,
            deposit_amount: base || p.deposit_amount,
          }));
        }
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải dữ liệu tòa nhà / căn hộ.'));
    } finally {
      setLoadingRefData(false);
    }
  }, [selectedBuildingId, todayStr, toast]);

  // Tự mở modal khi chuyển từ Sơ đồ tầng sang (/admin/contracts?apartment_id=...)
  useEffect(() => {
    const aptFromQuery = searchParams.get('apartment_id');
    if (aptFromQuery && canCreateContracts) {
      handleOpenCreate(aptFromQuery);
      const next = new URLSearchParams(searchParams);
      next.delete('apartment_id');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams, canCreateContracts, handleOpenCreate]);

  // Kiểm tra trùng SĐT / CCCD theo thời gian thực khi nhập cư dân mới ngay trong modal Hợp đồng
  useEffect(() => {
    if (!createOpen || tenantMode !== 'new') return undefined;
    const cleanPhone = normalizePhone(newTenantForm.phone);
    const cleanId = newTenantForm.id_number.trim();
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
        // ignore network hiccup on check-dup
      } finally {
        setDupChecking(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [createOpen, tenantMode, newTenantForm.phone, newTenantForm.id_number]);

  const handleBuildingChangeInModal = async (buildingId) => {
    setCreateForm((p) => ({
      ...p,
      building_id: buildingId,
      apartment_id: '',
      rent_amount: '',
      deposit_amount: '',
    }));
    try {
      const aRes = await buildingsService.listApartments(
        buildingId ? { building_id: buildingId } : {}
      );
      setApartments(Array.isArray(aRes?.data) ? aRes.data : []);
    } catch {
      setApartments([]);
    }
  };

  const selectableApartments = useMemo(
    () => apartments.filter((a) => ['AVAILABLE', 'RESERVED'].includes(a.status)),
    [apartments]
  );

  const selectedApartment = useMemo(
    () => selectableApartments.find((a) => String(a.id) === String(createForm.apartment_id)) || null,
    [selectableApartments, createForm.apartment_id]
  );

  const selectedTenant = lookedUpTenant;

  const isDiscountedWarning = useMemo(() => {
    if (!selectedApartment) return false;
    const baseRent = Number(selectedApartment.base_rent || 0);
    const proposed = Number(createForm.rent_amount || 0);
    if (baseRent <= 0 || proposed <= 0) return false;
    return proposed < baseRent * 0.9;
  }, [selectedApartment, createForm.rent_amount]);

  const handleSelectApartment = (aptId) => {
    const apt = selectableApartments.find((a) => String(a.id) === String(aptId));
    setCreateForm((p) => ({
      ...p,
      apartment_id: aptId,
      building_id: apt?.building_id || p.building_id,
      rent_amount: apt?.base_rent ? String(Math.round(Number(apt.base_rent))) : p.rent_amount,
      deposit_amount: apt?.base_rent ? String(Math.round(Number(apt.base_rent))) : p.deposit_amount,
    }));
  };

  const handleClearLookedUpTenant = () => {
    setLookedUpTenant(null);
    setTenantLookupState(null);
    setTenantIdentifier('');
    setCreateForm((p) => ({ ...p, primary_tenant_id: '' }));
  };

  const handleLookupTenant = async (rawValue = tenantIdentifier) => {
    const raw = String(rawValue || '').trim();
    if (!raw) {
      setTenantLookupState(null);
      setLookedUpTenant(null);
      setCreateForm((p) => ({ ...p, primary_tenant_id: '' }));
      return null;
    }

    const normPhone = normalizePhone(raw);
    const okPhone = isValidPhone(normPhone);
    const okId = !okPhone && isValidIdNumber(raw);

    if (!okPhone && !okId) {
      setLookedUpTenant(null);
      setCreateForm((p) => ({ ...p, primary_tenant_id: '' }));
      setTenantLookupState({
        found: false,
        invalidFormat: true,
        outOfScopeConflict: false,
        message:
          'Định dạng không hợp lệ. Vui lòng nhập đúng SĐT 10 chữ số (VD: 0912345678) hoặc Số CCCD/Hộ chiếu (9–12 ký tự).',
      });
      return null;
    }

    setTenantLookupLoading(true);
    setTenantLookupState(null);
    try {
      const res = await tenantsService.lookup(okPhone ? normPhone : raw.replace(/\s+/g, ''));
      if (res?.found && res?.tenant?.id) {
        setLookedUpTenant(res.tenant);
        setTenantLookupState(null);
        setCreateForm((p) => ({ ...p, primary_tenant_id: res.tenant.id }));
        setCreateErrors((prev) => ({ ...prev, primary_tenant_id: undefined }));
        return res.tenant;
      }

      setLookedUpTenant(null);
      setCreateForm((p) => ({ ...p, primary_tenant_id: '' }));
      setTenantLookupState({
        found: false,
        invalidFormat: false,
        outOfScopeConflict: Boolean(res?.outOfScopeConflict),
        normalizedPhone: res?.normalizedPhone || (okPhone ? normPhone : ''),
        normalizedIdNumber: res?.normalizedIdNumber || (okId ? raw.replace(/\s+/g, '') : ''),
        message:
          res?.message ||
          'Chưa tìm thấy hồ sơ cư dân khớp với SĐT / CCCD này.',
      });
      return null;
    } catch (err) {
      setLookedUpTenant(null);
      setCreateForm((p) => ({ ...p, primary_tenant_id: '' }));
      setTenantLookupState({
        found: false,
        invalidFormat: false,
        outOfScopeConflict: false,
        message: extractErrorMessage(err, 'Không thể tra cứu hồ sơ cư dân.'),
      });
      return null;
    } finally {
      setTenantLookupLoading(false);
    }
  };

  const handleSwitchToNewWithPrefill = () => {
    setNewTenantForm((prev) => ({
      ...prev,
      phone: tenantLookupState?.normalizedPhone || prev.phone,
      id_number: tenantLookupState?.normalizedIdNumber || prev.id_number,
    }));
    setTenantLookupState(null);
    setCreateErrors((prev) => ({ ...prev, primary_tenant_id: undefined }));
    setTenantMode('new');
  };

  const handleUseDuplicateTenant = (dup) => {
    if (dup?.tenant_id) {
      setTenantMode('existing');
      setLookedUpTenant({
        id: dup.tenant_id,
        person_id: dup.id,
        full_name: dup.full_name,
        masked_name: dup.masked_name || dup.full_name,
        masked_phone: dup.masked_phone || dup.phone,
        masked_id_number: dup.masked_id_number || dup.id_number,
        has_id_number: Boolean(dup.id_number || dup.masked_id_number),
        status: dup.id_number || dup.masked_id_number ? 'APPROVED' : 'PENDING',
      });
      setTenantLookupState(null);
      setCreateForm((p) => ({ ...p, primary_tenant_id: dup.tenant_id }));
      setCreateErrors((prev) => ({ ...prev, primary_tenant_id: undefined }));
      toast.info(`Đã chọn hồ sơ cư dân "${dup.masked_name || dup.full_name}" có sẵn trong phạm vi quản lý.`);
    } else {
      toast.warning('Không thể liên kết tự động hồ sơ này.');
    }
  };

  const handleCreateSubmit = async (e) => {
    e?.preventDefault();

    let resolvedPrimaryTenantId = createForm.primary_tenant_id;
    if (tenantMode === 'existing' && !resolvedPrimaryTenantId && tenantIdentifier.trim()) {
      const verifiedTenant = await handleLookupTenant(tenantIdentifier);
      if (verifiedTenant?.id) {
        resolvedPrimaryTenantId = verifiedTenant.id;
      }
    }

    if (tenantMode === 'new' && dupInfo.isDuplicate && dupInfo.inScope === false) {
      toast.warning(
        dupInfo.message ||
          'SĐT hoặc CCCD này đã đăng ký ngoài phạm vi tòa nhà bạn quản lý — không thể tạo trùng hồ sơ định danh.'
      );
      return;
    }

    const errs = {};
    if (!createForm.apartment_id) errs.apartment_id = 'Vui lòng chọn căn hộ trống hoặc đã giữ chỗ.';

    if (tenantMode === 'existing') {
      if (!resolvedPrimaryTenantId) {
        errs.primary_tenant_id = 'Vui lòng nhập SĐT / CCCD để xác thực khách thuê hoặc chuyển sang "+ Tạo cư dân mới".';
      }
    } else {
      if (!newTenantForm.full_name.trim()) {
        errs.new_full_name = 'Vui lòng nhập họ và tên khách thuê mới.';
      }
      if (!newTenantForm.phone.trim()) {
        errs.new_phone = 'Vui lòng nhập số điện thoại khách thuê.';
      } else if (!isValidPhone(newTenantForm.phone)) {
        errs.new_phone = 'Số điện thoại không đúng định dạng 10 chữ số Việt Nam.';
      }
      if (newTenantForm.email.trim() && !isValidEmail(newTenantForm.email.trim())) {
        errs.new_email = 'Địa chỉ email không hợp lệ.';
      }
      if (newTenantForm.id_number.trim() && !isValidIdNumber(newTenantForm.id_number.trim())) {
        errs.new_id_number = 'Số CCCD (9/12 số) hoặc Hộ chiếu không hợp lệ.';
      }
      if (newTenantForm.password && newTenantForm.password.length < 8) {
        errs.new_password = 'Mật khẩu đăng nhập ban đầu phải từ 8 ký tự trở lên.';
      }
    }

    if (!createForm.start_date) errs.start_date = 'Chọn ngày bắt đầu.';
    if (!createForm.end_date) errs.end_date = 'Chọn ngày kết thúc.';
    if (createForm.start_date && createForm.end_date && createForm.end_date <= createForm.start_date) {
      errs.end_date = 'Ngày kết thúc phải sau ngày bắt đầu hợp đồng.';
    }
    if (!createForm.rent_amount || Number(createForm.rent_amount) <= 0) {
      errs.rent_amount = 'Giá thuê phải lớn hơn 0.';
    }
    if (createForm.deposit_amount !== '' && Number(createForm.deposit_amount) < 0) {
      errs.deposit_amount = 'Tiền cọc không được âm.';
    }

    setCreateErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmittingCreate(true);
    try {
      const payload = {
        apartment_id: createForm.apartment_id,
        building_id: selectedApartment?.building_id || createForm.building_id || undefined,
        ...(tenantMode === 'existing'
          ? { primary_tenant_id: resolvedPrimaryTenantId }
          : {
              new_tenant: {
                full_name: newTenantForm.full_name.trim(),
                phone: normalizePhone(newTenantForm.phone),
                id_number: newTenantForm.id_number.trim() || null,
                email: newTenantForm.email.trim() || null,
                dob: newTenantForm.dob || null,
                nationality: newTenantForm.nationality.trim() || 'Việt Nam',
                address: newTenantForm.address.trim() || null,
                ...(newTenantForm.password ? { password: newTenantForm.password } : {}),
              },
            }),
        start_date: createForm.start_date,
        end_date: createForm.end_date,
        rent_amount: Math.round(Number(createForm.rent_amount)),
        deposit_amount: Math.round(Number(createForm.deposit_amount || 0)),
        billing_day: Math.min(28, Math.max(1, Number(createForm.billing_day || 1))),
        note: createForm.note.trim(),
      };
      const res = await contractsService.create(payload);
      const created = res?.data;

      if (created?.id && createForm.billing_cycle && createForm.billing_cycle !== 'monthly') {
        await contractsService.update(created.id, {
          billing_cycle: createForm.billing_cycle,
        }).catch(() => {});
      }

      toast.success(res?.message || 'Đã tạo hợp đồng nháp thành công.');
      setCreateOpen(false);
      if (created?.id) {
        navigate(`/admin/contracts/${created.id}`);
      } else {
        fetchData();
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tạo hợp đồng nháp.'));
    } finally {
      setSubmittingCreate(false);
    }
  };

  const handleConfirmApproveRequest = async () => {
    if (!approveReqTarget) return;
    setProcessingReq(true);
    try {
      const res = await contractsService.approveRequest(approveReqTarget.id);
      toast.success(res?.message || 'Đã phê duyệt yêu cầu của cư dân.');
      setApproveReqTarget(null);
      fetchData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể phê duyệt yêu cầu.'));
    } finally {
      setProcessingReq(false);
    }
  };

  const handleConfirmRejectRequest = async (e) => {
    e?.preventDefault();
    if (!rejectReqTarget) return;
    setProcessingReq(true);
    try {
      const res = await contractsService.rejectRequest(rejectReqTarget.id, {
        reason: rejectReason.trim(),
      });
      toast.success(res?.message || 'Đã từ chối yêu cầu của cư dân.');
      setRejectReqTarget(null);
      setRejectReason('');
      fetchData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể từ chối yêu cầu.'));
    } finally {
      setProcessingReq(false);
    }
  };

  const stats = useMemo(() => {
    const active = contracts.filter((c) => c.status === 'ACTIVE').length;
    const pending = contracts.filter((c) =>
      ['PENDING_APPROVAL', 'RENEWAL_PENDING', 'TERMINATION_PENDING'].includes(c.status)
    ).length;
    const drafts = contracts.filter((c) => c.status === 'DRAFT').length;
    const pendingReqs = requests.filter((r) => r.status === 'SUBMITTED').length;
    return { active, pending, drafts, pendingReqs };
  }, [contracts, requests]);

  const filteredContracts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contracts.filter((c) => {
      if (statusFilter && c.status !== statusFilter) return false;
      if (q) {
        const code = `hđ-${String(c.id || '').slice(0, 8)}`.toLowerCase();
        const haystacks = [
          code,
          c.id,
          c.apartment_code,
          c.building_name,
          c.tenant_name,
          c.tenant_phone,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystacks.includes(q)) return false;
      }
      return true;
    });
  }, [contracts, statusFilter, search]);

  const filteredRequests = useMemo(() => {
    const q = search.trim().toLowerCase();
    return requests.filter((r) => {
      if (reqStatusFilter && r.status !== reqStatusFilter) return false;
      if (q) {
        const haystacks = [
          r.apartment_code,
          r.building_name,
          r.resident_name,
          r.resident_phone,
          r.note,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystacks.includes(q)) return false;
      }
      return true;
    });
  }, [requests, reqStatusFilter, search]);

  const handleExportCsv = () => {
    if (filteredContracts.length === 0) {
      toast.warning('Không có dữ liệu hợp đồng để xuất CSV.');
      return;
    }
    exportToCsv(
      `danh-sach-hop-dong-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        { label: 'Mã HĐ', accessor: (r) => `HĐ-${String(r.id).slice(0, 8).toUpperCase()}` },
        { label: 'Căn hộ', key: 'apartment_code' },
        { label: 'Tòa nhà', key: 'building_name' },
        { label: 'Khách thuê đại diện', key: 'tenant_name' },
        { label: 'Số điện thoại', key: 'tenant_phone' },
        { label: 'Ngày bắt đầu', accessor: (r) => formatDate(r.start_date) },
        { label: 'Ngày kết thúc', accessor: (r) => formatDate(r.end_date) },
        { label: 'Giá thuê (VND)', accessor: (r) => Number(r.rent_amount || 0) },
        { label: 'Tiền đặt cọc (VND)', accessor: (r) => Number(r.deposit_amount || 0) },
        { label: 'Trạng thái', key: 'status' },
      ],
      filteredContracts
    );
    toast.success(`Đã xuất ${filteredContracts.length} hợp đồng ra tệp CSV.`);
  };

  const contractColumns = useMemo(
    () => [
      {
        key: 'code',
        label: 'Mã HĐ',
        render: (row) => (
          <div>
            <span className="font-mono text-xs font-semibold text-primary-600">
              HĐ-{String(row.id).slice(0, 8).toUpperCase()}
            </span>
            {row.parent_contract_id ? (
              <p className="text-[10px] text-slate-400 mt-0.5">HĐ nối tiếp</p>
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
            <p className="text-xs text-slate-500 truncate max-w-[180px]">{row.building_name}</p>
          </div>
        ),
      },
      {
        key: 'tenant_name',
        label: 'Khách thuê chính',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-medium text-slate-800">{row.tenant_name}</p>
            <p className="text-xs text-slate-500">{row.tenant_phone || '—'}</p>
          </div>
        ),
      },
      {
        key: 'start_date',
        label: 'Kỳ hạn hợp đồng',
        align: 'center',
        sortable: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <div className="text-xs text-slate-700">
            <p>{formatDate(row.start_date)}</p>
            <p className="text-slate-500">→ {formatDate(row.end_date)}</p>
          </div>
        ),
      },
      {
        key: 'rent_amount',
        label: 'Giá thuê / Cọc',
        align: 'right',
        sortable: true,
        sortValue: (row) => Number(row.rent_amount || 0),
        className: 'font-mono tabular-nums whitespace-nowrap',
        render: (row) => (
          <div>
            <p className="font-semibold text-slate-900">{formatMoney(row.rent_amount)}</p>
            <p className="text-xs font-sans text-slate-500">Cọc: {formatMoney(row.deposit_amount)}</p>
          </div>
        ),
      },
      {
        key: 'status',
        label: 'Trạng thái',
        align: 'center',
        sortable: true,
        render: (row) => <StatusBadge status={row.status} domain="contract" />,
      },
      {
        key: 'actions',
        label: 'Thao tác',
        align: 'center',
        render: (row) => (
          <Button
            variant="ghost"
            size="xs"
            icon={Eye}
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/admin/contracts/${row.id}`);
            }}
          >
            Chi tiết
          </Button>
        ),
      },
    ],
    [navigate]
  );

  const requestColumns = useMemo(
    () => [
      {
        key: 'type',
        label: 'Loại đề nghị',
        align: 'center',
        render: (row) => {
          const meta = REQUEST_TYPE_MAP[row.type] || { label: row.type, variant: 'slate' };
          return (
            <Badge variant={meta.variant} dot>
              {meta.label}
            </Badge>
          );
        },
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
        key: 'resident_name',
        label: 'Cư dân gửi yêu cầu',
        render: (row) => (
          <div>
            <p className="font-medium text-slate-800">{row.resident_name}</p>
            <p className="text-xs text-slate-500">{row.resident_phone || '—'}</p>
          </div>
        ),
      },
      {
        key: 'desired_date',
        label: 'Ngày mong muốn',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="text-xs font-medium text-slate-700">
            {formatDate(row.desired_date)}
          </span>
        ),
      },
      {
        key: 'note',
        label: 'Nội dung / Lý do',
        render: (row) => (
          <p className="text-xs text-slate-600 max-w-[260px] whitespace-pre-line line-clamp-2">
            {row.note || '—'}
          </p>
        ),
      },
      {
        key: 'status',
        label: 'Trạng thái xử lý',
        align: 'center',
        render: (row) => {
          const st = REQUEST_STATUS_BADGE[row.status] || { label: row.status, variant: 'slate' };
          return (
            <Badge variant={st.variant} dot>
              {st.label}
            </Badge>
          );
        },
      },
      {
        key: 'actions',
        label: 'Thao tác',
        align: 'center',
        render: (row) => (
          <div className="inline-flex items-center justify-center gap-1.5">
            {canApproveContracts && row.status === 'SUBMITTED' ? (
              <>
                <Button
                  variant="success"
                  size="xs"
                  icon={CheckCircle2}
                  onClick={() => setApproveReqTarget(row)}
                >
                  Duyệt
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  icon={XCircle}
                  onClick={() => {
                    setRejectReqTarget(row);
                    setRejectReason('');
                  }}
                >
                  Từ chối
                </Button>
              </>
            ) : null}
            {row.contract_id ? (
              <Button
                variant="ghost"
                size="xs"
                icon={Eye}
                onClick={() => navigate(`/admin/contracts/${row.contract_id}`)}
              >
                Mở HĐ
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    [canApproveContracts, navigate]
  );

  const tabs = [
    {
      id: 'list',
      label: 'Danh sách hợp đồng',
      icon: FileText,
      count: contracts.length,
    },
    {
      id: 'requests',
      label: 'Yêu cầu từ cư dân',
      icon: Inbox,
      count: stats.pendingReqs > 0 ? stats.pendingReqs : requests.length,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quản lý Hợp đồng thuê"
        subtitle={
          selectedBuildingId
            ? 'Đang lọc theo tòa nhà đã chọn trên thanh điều hướng'
            : 'Quản lý vòng đời hợp đồng thuê, phụ lục điều chỉnh và đề nghị gia hạn / chấm dứt từ cư dân'
        }
        actions={
          <>
            <Button variant="outline" size="md" icon={RefreshCw} onClick={fetchData}>
              Làm mới
            </Button>
            <Button variant="outline" size="md" icon={Download} onClick={handleExportCsv}>
              Xuất CSV
            </Button>
            {canCreateContracts ? (
              <Button variant="primary" size="md" icon={Plus} onClick={() => handleOpenCreate()}>
                Tạo hợp đồng nháp
              </Button>
            ) : null}
          </>
        }
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Đang hiệu lực"
          value={stats.active}
          subtext="Hợp đồng đang khai thác"
          icon={CheckCircle2}
          color="emerald"
          onClick={() => {
            setActiveTab('list');
            setStatusFilter('ACTIVE');
          }}
        />
        <StatsCard
          title="Chờ phê duyệt"
          value={stats.pending}
          subtext="Giá ưu đãi / Gia hạn / Chấm dứt"
          icon={Clock}
          color="amber"
          onClick={() => {
            setActiveTab('list');
            setStatusFilter('PENDING_APPROVAL');
          }}
        />
        <StatsCard
          title="Hợp đồng nháp"
          value={stats.drafts}
          subtext="Chờ tải bản scan ký kết"
          icon={FileSignature}
          color="sky"
          onClick={() => {
            setActiveTab('list');
            setStatusFilter('DRAFT');
          }}
        />
        <StatsCard
          title="Yêu cầu từ cư dân"
          value={stats.pendingReqs}
          subtext="Đề nghị chờ BQL / CĐT xử lý"
          icon={Inbox}
          color="indigo"
          onClick={() => setActiveTab('requests')}
        />
      </div>

      {/* Tabs */}
      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {/* Filter Toolbar */}
      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
          <div className="md:col-span-7">
            <SearchBar
              value={search}
              onChange={setSearch}
              placeholder={
                activeTab === 'list'
                  ? 'Tìm theo mã HĐ, mã căn hộ, tòa nhà, họ tên hoặc SĐT khách thuê...'
                  : 'Tìm theo căn hộ, họ tên cư dân, SĐT hoặc ghi chú đề nghị...'
              }
            />
          </div>
          <div className="md:col-span-5">
            {activeTab === 'list' ? (
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                placeholder="Tất cả trạng thái hợp đồng"
                options={CONTRACT_STATUS_OPTIONS}
              />
            ) : (
              <Select
                value={reqStatusFilter}
                onChange={(e) => setReqStatusFilter(e.target.value)}
                placeholder="Tất cả trạng thái yêu cầu"
                options={REQUEST_STATUS_OPTIONS}
              />
            )}
          </div>
        </div>
      </Card>

      {/* Bảng hiển thị theo Tab */}
      {activeTab === 'list' ? (
        <DataTable
          columns={contractColumns}
          data={filteredContracts}
          loading={loading}
          onRowClick={(row) => navigate(`/admin/contracts/${row.id}`)}
          emptyTitle="Không tìm thấy hợp đồng nào"
          emptyDescription="Chưa có hợp đồng khớp với điều kiện lọc hiện tại."
          emptyAction={
            canCreateContracts ? (
              <Button variant="primary" size="sm" icon={Plus} onClick={() => handleOpenCreate()}>
                Tạo hợp đồng nháp mới
              </Button>
            ) : null
          }
        />
      ) : (
        <DataTable
          columns={requestColumns}
          data={filteredRequests}
          loading={loading}
          emptyTitle="Chưa có yêu cầu nào từ cư dân"
          emptyDescription="Các đề nghị đăng ký thuê, gia hạn hoặc chấm dứt hợp đồng từ Cổng cư dân sẽ hiển thị tại đây."
        />
      )}

      {/* Modal Tạo hợp đồng nháp mới */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Tạo hợp đồng thuê mới (Bản nháp)"
        subtitle="Lưu nháp hợp đồng → In mẫu A4 ký kết → Đính kèm bản scan → Kích hoạt (NV-08)"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submittingCreate}>
              Hủy bỏ
            </Button>
            <Button variant="primary" onClick={handleCreateSubmit} loading={submittingCreate} icon={Plus}>
              Lưu hợp đồng nháp
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Tòa nhà"
              placeholder={loadingRefData ? 'Đang tải tòa nhà...' : '-- Tất cả tòa quản lý --'}
              value={createForm.building_id}
              onChange={(e) => handleBuildingChangeInModal(e.target.value)}
              options={buildings.map((b) => ({
                value: b.id,
                label: `${b.name} (${b.code})`,
              }))}
            />

            <Select
              label="Căn hộ (Trống / Đã giữ chỗ)"
              required
              placeholder={
                loadingRefData
                  ? 'Đang tải căn hộ...'
                  : selectableApartments.length === 0
                  ? 'Không có căn AVAILABLE / RESERVED'
                  : '-- Chọn căn hộ --'
              }
              value={createForm.apartment_id}
              onChange={(e) => handleSelectApartment(e.target.value)}
              error={createErrors.apartment_id}
              options={selectableApartments.map((a) => ({
                value: a.id,
                label: `${a.code} — ${a.status === 'RESERVED' ? 'Đã giữ chỗ' : 'Còn trống'} — Niêm yết: ${formatMoney(a.base_rent)}`,
              }))}
            />
          </div>

          {/* Tra cứu cư dân bảo mật (Know-Before-You-Link) HOẶC Tạo mới cư dân chưa có trong hệ thống */}
          <div className="space-y-3 rounded-2xl border border-slate-200/90 bg-slate-50/60 p-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-primary-600 shrink-0" />
                  <span>
                    Khách thuê đại diện đứng tên hợp đồng <span className="text-rose-500">*</span>
                  </span>
                </p>
                <p className="text-[11px] text-slate-500">
                  Bảo mật dữ liệu PII: tra cứu chính xác bằng SĐT / CCCD hoặc khởi tạo hồ sơ cư dân mới
                </p>
              </div>
              <div className="inline-grid grid-cols-2 p-1 rounded-xl bg-slate-200/80 shrink-0">
                <button
                  type="button"
                  onClick={() => setTenantMode('existing')}
                  className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    tenantMode === 'existing'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Users className="w-3.5 h-3.5" />
                  Tra cứu cư dân
                </button>
                <button
                  type="button"
                  onClick={() => setTenantMode('new')}
                  className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    tenantMode === 'new'
                      ? 'bg-primary-600 text-white shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  + Tạo cư dân mới
                </button>
              </div>
            </div>

            {tenantMode === 'existing' ? (
              <div className="space-y-2.5">
                {selectedTenant ? (
                  <div className="rounded-xl bg-emerald-50/90 border border-emerald-200 px-3.5 py-3 flex items-center justify-between gap-3">
                    <div className="space-y-0.5 text-xs">
                      <p className="font-semibold text-emerald-900 flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                        Đã xác thực cư dân: {selectedTenant.masked_name || selectedTenant.full_name}
                      </p>
                      <p className="text-emerald-800">
                        SĐT: <span className="font-mono">{selectedTenant.masked_phone || '—'}</span> · CCCD:{' '}
                        <span className="font-mono">
                          {selectedTenant.masked_id_number || 'Chưa bổ sung (PENDING)'}
                        </span>
                      </p>
                    </div>
                    <Button type="button" variant="outline" size="xs" onClick={handleClearLookedUpTenant}>
                      Đổi / Nhập lại
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-col sm:flex-row gap-2">
                      <div className="flex-1">
                        <Input
                          icon={Search}
                          placeholder="Nhập chính xác SĐT 10 số hoặc số CCCD/Hộ chiếu của cư dân..."
                          value={tenantIdentifier}
                          error={createErrors.primary_tenant_id}
                          onChange={(e) => {
                            setTenantIdentifier(e.target.value);
                            if (tenantLookupState) setTenantLookupState(null);
                            if (createErrors.primary_tenant_id) {
                              setCreateErrors((prev) => ({ ...prev, primary_tenant_id: undefined }));
                            }
                          }}
                          onBlur={() => {
                            if (tenantIdentifier.trim() && !tenantLookupLoading) {
                              handleLookupTenant(tenantIdentifier);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleLookupTenant(tenantIdentifier);
                            }
                          }}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="soft"
                        icon={Search}
                        loading={tenantLookupLoading}
                        onClick={() => handleLookupTenant(tenantIdentifier)}
                      >
                        Tra cứu
                      </Button>
                    </div>

                    {tenantLookupState ? (
                      <div
                        className={`p-3 rounded-xl border text-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 ${
                          tenantLookupState.invalidFormat || tenantLookupState.outOfScopeConflict
                            ? 'bg-rose-50 border-rose-200 text-rose-800'
                            : 'bg-amber-50 border-amber-200 text-amber-900'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                          <span>{tenantLookupState.message}</span>
                        </div>
                        {!tenantLookupState.invalidFormat && !tenantLookupState.outOfScopeConflict ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="primary"
                            icon={UserPlus}
                            onClick={handleSwitchToNewWithPrefill}
                          >
                            + Tạo cư dân mới
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-500">
                        Hệ thống không công khai danh sách cư dân khi lập hợp đồng. Nhập SĐT (10 số) hoặc CCCD của khách để tra cứu, hoặc bấm <strong>+ Tạo cư dân mới</strong>.
                      </p>
                    )}
                  </div>
                )}

                {selectedTenant && (!selectedTenant.has_id_number || selectedTenant.status === 'PENDING') ? (
                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <span>
                      Hồ sơ khách thuê <strong>{selectedTenant.masked_name || selectedTenant.full_name}</strong> hiện chưa đủ CCCD hoặc đang ở trạng thái{' '}
                      <strong>PENDING</strong>. Bạn vẫn lưu nháp hợp đồng được, nhưng cần bổ sung & duyệt hồ sơ cư dân trước khi kích hoạt.
                    </span>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3 bg-white rounded-xl border border-sky-200/80 p-3.5">
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-sky-50 border border-sky-100 text-xs text-sky-900">
                  <ShieldCheck className="w-4 h-4 text-primary-600 shrink-0 mt-0.5" />
                  <span>
                    Khi lưu hợp đồng, hệ thống sẽ <strong>tự động tạo hồ sơ cư dân</strong> và{' '}
                    <strong>cấp ngay tài khoản Cổng cư dân</strong> (khách thuê đăng nhập bằng{' '}
                    <strong>SĐT + OTP</strong> hoặc Email & Mật khẩu).
                  </span>
                </div>

                {dupInfo.isDuplicate && dupInfo.inScope === false ? (
                  <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span>
                      {dupInfo.message ||
                        'Định danh (SĐT/CCCD) này đã được đăng ký trên hệ thống ngoài phạm vi tòa nhà bạn quản lý. Không thể tạo trùng hồ sơ.'}
                    </span>
                  </div>
                ) : dupInfo.isDuplicate && dupInfo.duplicates.length > 0 ? (
                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-300 text-xs text-amber-900 space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <div className="w-full">
                        <p className="font-semibold">
                          Phát hiện SĐT / CCCD đã tồn tại trong phạm vi quản lý:
                        </p>
                        {dupInfo.duplicates.map((d) => (
                          <div key={d.id} className="mt-1 flex items-center justify-between gap-2 flex-wrap">
                            <span>
                              • <strong>{d.masked_name || d.full_name}</strong> — SĐT: {d.masked_phone || d.phone || '—'}
                              {d.masked_id_number || d.id_number ? ` — CCCD: ${d.masked_id_number || d.id_number}` : ''}
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => handleUseDuplicateTenant(d)}
                            >
                              Dùng hồ sơ này
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="Họ và tên khách thuê mới"
                    required
                    placeholder="VD: Nguyễn Văn Minh"
                    value={newTenantForm.full_name}
                    onChange={(e) => setNewTenantForm((p) => ({ ...p, full_name: e.target.value }))}
                    error={createErrors.new_full_name}
                  />
                  <Input
                    label="Số điện thoại (nhận mã OTP)"
                    required
                    placeholder="VD: 0912345678"
                    hint={dupChecking ? 'Đang kiểm tra trùng SĐT...' : undefined}
                    value={newTenantForm.phone}
                    onChange={(e) => setNewTenantForm((p) => ({ ...p, phone: e.target.value }))}
                    error={createErrors.new_phone}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="Số CCCD / Hộ chiếu"
                    placeholder="12 chữ số CCCD (khuyến nghị nhập đủ)"
                    hint={
                      newTenantForm.id_number.trim()
                        ? 'Có CCCD → Hồ sơ tự động đạt trạng thái APPROVED'
                        : 'Nếu để trống → Lưu nháp được, cần bổ sung trước khi Kích hoạt'
                    }
                    value={newTenantForm.id_number}
                    onChange={(e) => setNewTenantForm((p) => ({ ...p, id_number: e.target.value }))}
                    error={createErrors.new_id_number}
                  />
                  <Input
                    label="Email (tùy chọn)"
                    type="email"
                    placeholder="khachthue@gmail.com"
                    value={newTenantForm.email}
                    onChange={(e) => setNewTenantForm((p) => ({ ...p, email: e.target.value }))}
                    error={createErrors.new_email}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="Ngày sinh"
                    type="date"
                    value={newTenantForm.dob}
                    onChange={(e) => setNewTenantForm((p) => ({ ...p, dob: e.target.value }))}
                  />
                  <Input
                    label="Mật khẩu đăng nhập ban đầu (tùy chọn)"
                    type="password"
                    placeholder="Tối thiểu 8 ký tự (nếu dùng Email)"
                    hint="Để trống nếu cư dân chỉ đăng nhập bằng SĐT + OTP"
                    value={newTenantForm.password}
                    onChange={(e) => setNewTenantForm((p) => ({ ...p, password: e.target.value }))}
                    error={createErrors.new_password}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="Địa chỉ thường trú"
                    placeholder="Số nhà, phường/xã, quận/huyện, tỉnh/TP"
                    value={newTenantForm.address}
                    onChange={(e) => setNewTenantForm((p) => ({ ...p, address: e.target.value }))}
                  />
                  <Input
                    label="Quốc tịch"
                    placeholder="Việt Nam"
                    value={newTenantForm.nationality}
                    onChange={(e) => setNewTenantForm((p) => ({ ...p, nationality: e.target.value }))}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Ngày bắt đầu thuê"
                type="date"
                required
                value={createForm.start_date}
                onChange={(e) => setCreateForm((p) => ({ ...p, start_date: e.target.value }))}
                error={createErrors.start_date}
              />
              <Input
                label="Ngày kết thúc thuê"
                type="date"
                required
                value={createForm.end_date}
                onChange={(e) => setCreateForm((p) => ({ ...p, end_date: e.target.value }))}
                error={createErrors.end_date}
              />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-slate-500 flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Chọn nhanh kỳ hạn:
              </span>
              {[6, 12, 24].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() =>
                    setCreateForm((p) => ({
                      ...p,
                      end_date: addMonthsStr(p.start_date || todayStr, m),
                    }))
                  }
                  className="px-2.5 py-1 text-xs font-medium rounded-md bg-slate-100 hover:bg-primary-50 text-slate-700 hover:text-primary-700 border border-slate-200 transition-colors"
                >
                  {m} tháng
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Giá thuê hàng tháng (VND)"
              type="number"
              min="0"
              required
              placeholder="VD: 8500000"
              hint={
                selectedApartment
                  ? `Giá niêm yết của căn ${selectedApartment.code}: ${formatMoney(selectedApartment.base_rent)}`
                  : undefined
              }
              value={createForm.rent_amount}
              onChange={(e) => setCreateForm((p) => ({ ...p, rent_amount: e.target.value }))}
              error={createErrors.rent_amount}
            />
            <Input
              label="Tiền đặt cọc bảo đảm (VND)"
              type="number"
              min="0"
              placeholder="VD: 8500000"
              hint="Mặc định gợi ý bằng 1 tháng tiền thuê"
              value={createForm.deposit_amount}
              onChange={(e) => setCreateForm((p) => ({ ...p, deposit_amount: e.target.value }))}
              error={createErrors.deposit_amount}
            />
          </div>

          {isDiscountedWarning ? (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-300 text-xs text-amber-900 flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="leading-relaxed">
                <p className="font-semibold">
                  Cảnh báo khung giá ưu đãi (&lt; 90% giá niêm yết {formatMoney(selectedApartment?.base_rent)})
                </p>
                <p className="text-amber-800 mt-0.5">
                  Theo quy định kiểm soát nội bộ (FR-014), mức giá thuê đề xuất giảm trên 10% so với giá niêm yết. Khi bấm Kích hoạt sau khi đính kèm bản ký, hợp đồng sẽ tự động chuyển sang trạng thái{' '}
                  <strong>PENDING_APPROVAL</strong> để chờ Chủ đầu tư (<strong>OWNER</strong>) phê duyệt.
                </p>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Chu kỳ thanh toán"
              value={createForm.billing_cycle}
              onChange={(e) => setCreateForm((p) => ({ ...p, billing_cycle: e.target.value }))}
              options={[
                { value: 'monthly', label: 'Hàng tháng (Monthly)' },
                { value: 'quarterly', label: '3 tháng / lần (Quarterly)' },
              ]}
            />
            <Input
              label="Ngày phát hành hóa đơn định kỳ"
              type="number"
              min="1"
              max="28"
              value={createForm.billing_day}
              onChange={(e) => setCreateForm((p) => ({ ...p, billing_day: e.target.value }))}
              hint="Ngày chốt hóa đơn hàng tháng (1 – 28)"
            />
          </div>

          <Input
            label="Ghi chú hợp đồng"
            multiline
            rows={2}
            placeholder="Thỏa thuận thêm về nội thất bàn giao, điều kiện ưu đãi..."
            value={createForm.note}
            onChange={(e) => setCreateForm((p) => ({ ...p, note: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Xác nhận Phê duyệt yêu cầu từ cư dân */}
      <ConfirmDialog
        open={Boolean(approveReqTarget)}
        onClose={() => setApproveReqTarget(null)}
        onConfirm={handleConfirmApproveRequest}
        loading={processingReq}
        variant="success"
        title="Phê duyệt yêu cầu của cư dân"
        confirmLabel="Phê duyệt ngay"
        message={
          approveReqTarget
            ? `Xác nhận phê duyệt đề nghị "${
                REQUEST_TYPE_MAP[approveReqTarget.type]?.label || approveReqTarget.type
              }" cho căn hộ ${approveReqTarget.apartment_code} của cư dân ${approveReqTarget.resident_name}? Hệ thống sẽ tự động gửi thông báo đến cư dân.`
            : ''
        }
      />

      {/* Modal Từ chối yêu cầu từ cư dân */}
      <Modal
        open={Boolean(rejectReqTarget)}
        onClose={() => setRejectReqTarget(null)}
        title="Từ chối đề nghị của cư dân"
        subtitle={
          rejectReqTarget
            ? `Căn hộ ${rejectReqTarget.apartment_code} — Cư dân: ${rejectReqTarget.resident_name}`
            : ''
        }
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setRejectReqTarget(null)} disabled={processingReq}>
              Hủy bỏ
            </Button>
            <Button
              variant="danger"
              onClick={handleConfirmRejectRequest}
              loading={processingReq}
              icon={XCircle}
            >
              Xác nhận từ chối
            </Button>
          </>
        }
      >
        <form onSubmit={handleConfirmRejectRequest} className="space-y-3">
          <Input
            label="Lý do từ chối gửi tới cư dân"
            multiline
            rows={3}
            placeholder="Nhập lý do từ chối để cư dân nắm rõ..."
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
        </form>
      </Modal>
    </div>
  );
}

export default ContractsPage;
