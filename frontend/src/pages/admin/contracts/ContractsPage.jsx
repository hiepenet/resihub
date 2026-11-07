import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  Trash2,
  ShieldCheck,
  Search,
  Bookmark,
  Sparkles,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { MoneyInput } from '../../../components/ui/MoneyInput';
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
import { ServiceSubscriptionMetaFields } from '../../../components/common/ServiceSubscriptionMetaFields';
import { FileUpload } from '../../../components/ui/FileUpload';
import { AISuggestionField } from '../../../components/ui/AISuggestionField';
import { aiService } from '../../../services/ai.service';
import {
  createAiFieldTracker,
  markFieldConfirmedOrEdited,
  mapAiErrorToVietnamese,
} from '../../../utils/aiHelpers';
import {
  MAX_PARKING_QUANTITY,
  isParkingService,
  allowsMultiQuantity,
  syncVehiclePlatesArray,
  validateServiceMetaInput,
} from '../../../utils/serviceSubscriptionMeta';
import { contractsService, createIdempotencyKey } from '../../../services/contracts.service';
import { buildingsService } from '../../../services/buildings.service';
import { tenantsService } from '../../../services/tenants.service';
import { servicesService } from '../../../services/services.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney, formatDate, exportToCsv } from '../../../utils/format';
import {
  addDaysStr,
  addMonthsClampedStr,
  extractApartmentBusyIntervals,
  findFirstAvailableStartDate,
  findOverlappingBusyIntervals,
  formatBusyOverlapError,
  getDateOrderError,
  maxDateStr,
  minDateStr,
  toDateOnlyStr,
} from '../../../utils/dateRange';
import {
  extractErrorMessage,
  isValidPhone,
  normalizePhone,
  isValidEmail,
  isValidIdNumber,
} from '../../../utils/validation';
import {
  stripNotificationTriggerParams,
  pickDeepLinkTarget,
} from '../../../utils/notificationNavigation';

const CONTRACT_STATUS_OPTIONS = [
  { value: 'DRAFT', label: 'Bản nháp (DRAFT)' },
  { value: 'PENDING_ALL', label: 'Tất cả chờ phê duyệt (Giá / Gia hạn / Chấm dứt)' },
  { value: 'PENDING_APPROVAL', label: 'Chờ phê duyệt giá (PENDING_APPROVAL)' },
  { value: 'ACTIVE', label: 'Đang hiệu lực (ACTIVE)' },
  { value: 'RENEWAL_PENDING', label: 'Chờ duyệt gia hạn (RENEWAL_PENDING)' },
  { value: 'TERMINATION_PENDING', label: 'Chờ bàn giao chấm dứt (TERMINATION_PENDING)' },
  { value: 'EXPIRED', label: 'Đã hết hạn (EXPIRED)' },
  { value: 'TERMINATED', label: 'Đã thanh lý (TERMINATED)' },
  { value: 'CANCELLED', label: 'Đã hủy (CANCELLED)' },
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

function toDateStr(val) {
  return toDateOnlyStr(val);
}

function addMonthsStr(dateStr, months) {
  return addMonthsClampedStr(dateStr, months);
}

function computeSuggestedContractEndDate(startStr, busyIntervals = [], defaultMonths = 12) {
  if (!startStr) return '';
  const targetEnd = addMonthsClampedStr(startStr, defaultMonths);
  const nextBusy = (busyIntervals || []).find((iv) => iv?.from && iv.from > startStr);
  if (!nextBusy) return targetEnd;
  const maxBeforeNext = addDaysStr(nextBusy.from, -1);
  const minValidEnd = addDaysStr(startStr, 1);
  if (maxBeforeNext < minValidEnd) return minValidEnd;
  return minDateStr(targetEnd, maxBeforeNext);
}

function getAptSelectStatusLabel(status) {
  switch (status) {
    case 'AVAILABLE':
      return 'Còn trống';
    case 'RESERVED':
      return 'Đã giữ chỗ';
    case 'OCCUPIED':
      return 'Đang có khách thuê (Tạo HĐ nối tiếp)';
    case 'MAINTENANCE':
      return 'Đang bảo trì (Tạo HĐ tương lai)';
    default:
      return status;
  }
}

const INLINE_RELATIONSHIP_OPTIONS = [
  { value: 'family', label: 'Gia đình / Người thân' },
  { value: 'spouse', label: 'Vợ / Chồng' },
  { value: 'child', label: 'Con cái' },
  { value: 'roommate', label: 'Bạn cùng phòng' },
  { value: 'friend', label: 'Bạn bè' },
  { value: 'other', label: 'Khác' },
];

const INITIAL_NEW_TENANT = {
  full_name: '',
  phone: '',
  id_number: '',
  email: '',
  dob: '',
  nationality: 'Việt Nam',
  address: '',
  password: '',
  id_image_front: '',
  id_image_back: '',
};

export function ContractsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const { canCreateContracts, canApproveContracts } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const initialParams = selectedBuildingId ? { building_id: selectedBuildingId } : {};
  const initialContracts = contractsService.peekList(initialParams)?.data;
  const initialRequests = contractsService.peekRequests(initialParams)?.data;

  const [activeTab, setActiveTab] = useState('list');
  const [contracts, setContracts] = useState(() => (Array.isArray(initialContracts) ? initialContracts : []));
  const [requests, setRequests] = useState(() => (Array.isArray(initialRequests) ? initialRequests : []));
  const [loading, setLoading] = useState(() => !Array.isArray(initialContracts));

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
  const [aptSchedule, setAptSchedule] = useState({
    loading: false,
    apartmentId: '',
    contracts: [],
    reservations: [],
  });

  // Chế độ chọn khách thuê: 'existing' (tra cứu SĐT/CCCD bảo mật) | 'new' (cư dân mới chưa nằm trong hệ thống)
  const [tenantMode, setTenantMode] = useState('existing');
  const [tenantIdentifier, setTenantIdentifier] = useState('');
  const [tenantLookupLoading, setTenantLookupLoading] = useState(false);
  const [lookedUpTenant, setLookedUpTenant] = useState(null);
  const [tenantLookupState, setTenantLookupState] = useState(null);
  const [newTenantForm, setNewTenantForm] = useState(INITIAL_NEW_TENANT);
  const [dupInfo, setDupInfo] = useState({
    isDuplicate: false,
    inScope: true,
    canLinkCrossBuilding: false,
    duplicates: [],
    message: '',
  });
  const [dupChecking, setDupChecking] = useState(false);
  const [inlineOccupants, setInlineOccupants] = useState([]);
  const [serviceCatalog, setServiceCatalog] = useState([]);
  const [selectedServices, setSelectedServices] = useState({});
  const [customMeterPrices, setCustomMeterPrices] = useState({ ELECTRICITY: '', WATER: '' });
  const userEditedCreateDatesRef = useRef(false);
  const createIdemKeyRef = useRef('');

  const [todayStr] = useState(() => toDateOnlyStr(new Date()));
  const [createForm, setCreateForm] = useState({
    building_id: '',
    apartment_id: '',
    primary_tenant_id: '',
    reservation_id: '',
    start_date: todayStr,
    end_date: addMonthsStr(todayStr, 12),
    rent_amount: '',
    deposit_amount: '',
    billing_cycle: 'monthly',
    billing_day: '1',
    payment_due_days: '5',
    note: '',
  });

  // Approve / Reject Resident Request state
  const [reviewRequestTarget, setReviewRequestTarget] = useState(null);
  const [approveReqTarget, setApproveReqTarget] = useState(null);
  const [rejectReqTarget, setRejectReqTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [processingReq, setProcessingReq] = useState(false);

  const fetchData = useCallback(async (opts = {}) => {
    const force = Boolean(opts?.force);
    const queryParams = {};
    if (selectedBuildingId) queryParams.building_id = selectedBuildingId;
    if (!Array.isArray(contractsService.peekList(queryParams)?.data)) {
      setLoading(true);
    }
    try {
      const [cRes, rRes] = await Promise.all([
        contractsService.list(queryParams, { force }),
        contractsService.listRequests(queryParams, { force }).catch(() => ({ data: [] })),
      ]);
      setContracts(Array.isArray(cRes?.data) ? cRes.data : []);
      setRequests(Array.isArray(rRes?.data) ? rRes.data : []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách hợp đồng.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, toast]);

  const [requestsReady, setRequestsReady] = useState(false);

  useEffect(() => {
    setRequestsReady(false);
    Promise.resolve(fetchData()).finally(() => setRequestsReady(true));
  }, [fetchData]);

  useEffect(() => {
    const tabParam = searchParams.get('tab');
    if (tabParam === 'requests' && activeTab !== 'requests') {
      setActiveTab('requests');
    }
    const targetReqId = searchParams.get('request_id');
    const modal = searchParams.get('modal');
    if (loading || !requestsReady || (!targetReqId && modal !== 'request')) return;

    setSearchParams((prev) => stripNotificationTriggerParams(prev), { replace: true });
    setActiveTab('requests');
    setReqStatusFilter('');
    const matched = pickDeepLinkTarget(requests, targetReqId);
    if (matched) {
      setReviewRequestTarget(matched);
    } else {
      toast.info('Bản ghi liên quan không còn tồn tại hoặc đã thay đổi trạng thái.');
    }
  }, [searchParams, setSearchParams, loading, requestsReady, requests, activeTab, toast]);

  // AI-01: Quét hợp đồng giấy/PDF & CCCD khách thuê mới ngay trong modal tạo nháp
  const [contractScanFiles, setContractScanFiles] = useState([]);
  const [contractScanConsent, setContractScanConsent] = useState(true);
  const [extractingContractAi, setExtractingContractAi] = useState(false);
  const [contractAiTracker, setContractAiTracker] = useState(null);
  const [contractAiError, setContractAiError] = useState(null);
  const [inlineCccdConsent, setInlineCccdConsent] = useState(true);
  const [extractingInlineCccd, setExtractingInlineCccd] = useState(false);
  const [inlineCccdTracker, setInlineCccdTracker] = useState(null);
  const [inlineCccdError, setInlineCccdError] = useState(null);

  // Load tòa nhà + căn hộ khi mở modal tạo HĐ nháp (KHÔNG tải danh sách cư dân công khai để bảo mật PII)
  const handleOpenCreate = useCallback(async (preselectAptId = '') => {
    const cleanAptId = typeof preselectAptId === 'string' ? preselectAptId : '';
    const defaultBld = selectedBuildingId || '';
    userEditedCreateDatesRef.current = false;
    createIdemKeyRef.current = createIdempotencyKey();
    setCreateForm({
      building_id: defaultBld,
      apartment_id: cleanAptId,
      primary_tenant_id: '',
      reservation_id: '',
      start_date: todayStr,
      end_date: addMonthsStr(todayStr, 12),
      rent_amount: '',
      deposit_amount: '',
      billing_cycle: 'monthly',
      billing_day: '1',
      payment_due_days: '5',
      note: '',
    });
    setTenantMode('existing');
    setTenantIdentifier('');
    setLookedUpTenant(null);
    setTenantLookupState(null);
    setNewTenantForm(INITIAL_NEW_TENANT);
    setDupInfo({
      isDuplicate: false,
      inScope: true,
      canLinkCrossBuilding: false,
      duplicates: [],
      message: '',
    });
    setInlineOccupants([]);
    setSelectedServices({});
    setCustomMeterPrices({ ELECTRICITY: '', WATER: '' });
    setCreateErrors({});
    setContractScanFiles([]);
    setContractScanConsent(true);
    setContractAiTracker(null);
    setContractAiError(null);
    setInlineCccdConsent(true);
    setInlineCccdTracker(null);
    setInlineCccdError(null);
    setCreateOpen(true);

    setLoadingRefData(true);
    try {
      const [bRes, aRes, sRes] = await Promise.all([
        buildingsService.list(),
        buildingsService.listApartments(
          !cleanAptId && defaultBld ? { building_id: defaultBld } : {}
        ),
        servicesService.listCatalog({ active_only: 'true' }).catch(() => ({ data: [] })),
      ]);
      const bList = Array.isArray(bRes?.data) ? bRes.data : [];
      const aList = Array.isArray(aRes?.data) ? aRes.data : [];
      const sList = Array.isArray(sRes?.data) ? sRes.data : [];
      setBuildings(bList);
      setApartments(aList);
      setServiceCatalog(sList);

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
      setDupInfo({
        isDuplicate: false,
        inScope: true,
        canLinkCrossBuilding: false,
        duplicates: [],
        message: '',
      });
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
          canLinkCrossBuilding: Boolean(res?.canLinkCrossBuilding),
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

  // Tải lịch các khoảng thời gian đã có khách thuê & đang giữ chỗ của căn hộ được chọn
  useEffect(() => {
    if (!createOpen || !createForm.apartment_id) {
      setAptSchedule({ loading: false, apartmentId: '', contracts: [], reservations: [] });
      return undefined;
    }
    let cancelled = false;
    const aptId = createForm.apartment_id;
    setAptSchedule((prev) => ({
      loading: true,
      apartmentId: aptId,
      contracts: prev.apartmentId === aptId ? prev.contracts : [],
      reservations: prev.apartmentId === aptId ? prev.reservations : [],
    }));

    buildingsService
      .getApartment(aptId)
      .then((res) => {
        if (cancelled) return;
        const detail = res?.data || {};
        const activeOrScheduledContracts = (Array.isArray(detail.contracts) ? detail.contracts : [])
          .filter(
            (c) =>
              ['ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING', 'PENDING_APPROVAL', 'DRAFT'].includes(
                c.status
              ) && toDateStr(c.terminated_at || c.end_date) >= todayStr
          )
          .sort((a, b) => toDateStr(a.start_date).localeCompare(toDateStr(b.start_date)));

        const activeHeldReservations = (Array.isArray(detail.reservations) ? detail.reservations : [])
          .filter((r) => r.status === 'HELD' && toDateStr(r.hold_until) >= todayStr)
          .sort((a, b) =>
            toDateStr(a.hold_from || a.created_at).localeCompare(toDateStr(b.hold_from || b.created_at))
          );

        setAptSchedule({
          loading: false,
          apartmentId: aptId,
          contracts: activeOrScheduledContracts,
          reservations: activeHeldReservations,
        });

        // Tự động chọn ngày bắt đầu nằm ngoài mọi khoảng đã thuê / đang giữ chỗ của căn hộ
        const busyIntervals = extractApartmentBusyIntervals(
          { contracts: activeOrScheduledContracts, reservations: activeHeldReservations },
          { todayStr }
        );
        const baseSearchDate = ['OCCUPIED', 'MAINTENANCE'].includes(detail.status)
          ? addDaysStr(todayStr, 1)
          : todayStr;
        const suggestedStart = findFirstAvailableStartDate(baseSearchDate, busyIntervals, {
          minSpanDays: 2,
        });

        if (suggestedStart) {
          setCreateForm((prev) => {
            if (String(prev.apartment_id) !== String(aptId) || prev.reservation_id) {
              return prev;
            }
            const currentOverlaps = findOverlappingBusyIntervals(
              prev.start_date,
              prev.end_date,
              busyIntervals
            );
            const invalidForStatus =
              ['OCCUPIED', 'MAINTENANCE'].includes(detail.status) && prev.start_date <= todayStr;
            if (
              userEditedCreateDatesRef.current &&
              currentOverlaps.length === 0 &&
              !invalidForStatus
            ) {
              return prev;
            }
            return {
              ...prev,
              start_date: suggestedStart,
              end_date: computeSuggestedContractEndDate(suggestedStart, busyIntervals, 12),
            };
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAptSchedule({ loading: false, apartmentId: aptId, contracts: [], reservations: [] });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [createOpen, createForm.apartment_id, todayStr]);

  const handleBuildingChangeInModal = async (buildingId) => {
    setCreateForm((p) => ({
      ...p,
      building_id: buildingId,
      apartment_id: '',
      reservation_id: '',
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
    () => apartments.filter((a) => a.status !== 'INACTIVE'),
    [apartments]
  );

  useEffect(() => {
    if (createOpen) {
      createIdemKeyRef.current = createIdempotencyKey();
    }
  }, [
    createOpen,
    tenantMode,
    createForm,
    newTenantForm,
    inlineOccupants,
    selectedServices,
    customMeterPrices,
  ]);

  const selectedApartment = useMemo(
    () => selectableApartments.find((a) => String(a.id) === String(createForm.apartment_id)) || null,
    [selectableApartments, createForm.apartment_id]
  );

  const selectedReservation = useMemo(
    () =>
      (aptSchedule.reservations || []).find(
        (r) => String(r.id) === String(createForm.reservation_id)
      ) || null,
    [aptSchedule.reservations, createForm.reservation_id]
  );

  const effectiveModalBuildingId = selectedApartment?.building_id || createForm.building_id || '';
  const selectableCatalogServices = useMemo(
    () =>
      serviceCatalog.filter(
        (svc) =>
          svc.is_active !== false &&
          svc.billing_type !== 'METERED' &&
          (!svc.building_id ||
            !effectiveModalBuildingId ||
            String(svc.building_id) === String(effectiveModalBuildingId))
      ),
    [serviceCatalog, effectiveModalBuildingId]
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
    userEditedCreateDatesRef.current = false;
    const apt = selectableApartments.find((a) => String(a.id) === String(aptId));
    const prelimBusy = aptId
      ? extractApartmentBusyIntervals(
          {
            contracts: contracts.filter((c) => String(c.apartment_id) === String(aptId)),
            reservations: [],
          },
          { todayStr }
        )
      : [];
    const baseSearch =
      apt && ['OCCUPIED', 'MAINTENANCE'].includes(apt.status)
        ? addDaysStr(todayStr, 1)
        : todayStr;
    const nextStart = aptId
      ? findFirstAvailableStartDate(baseSearch, prelimBusy, { minSpanDays: 2 })
      : todayStr;

    setCreateForm((p) => {
      const startToUse = nextStart || p.start_date;
      const aptChanged = String(p.apartment_id) !== String(aptId);
      return {
        ...p,
        apartment_id: aptId,
        building_id: apt?.building_id || p.building_id,
        reservation_id: aptChanged ? '' : p.reservation_id,
        start_date: startToUse,
        end_date: computeSuggestedContractEndDate(startToUse, prelimBusy, 12),
        rent_amount: apt?.base_rent ? String(Math.round(Number(apt.base_rent))) : p.rent_amount,
        deposit_amount: apt?.base_rent ? String(Math.round(Number(apt.base_rent))) : p.deposit_amount,
      };
    });
    setCreateErrors((prev) => ({
      ...prev,
      apartment_id: undefined,
      start_date: undefined,
      end_date: undefined,
    }));
  };

  const handleClearLookedUpTenant = () => {
    setLookedUpTenant(null);
    setTenantLookupState(null);
    setTenantIdentifier('');
    setCreateForm((p) => ({ ...p, primary_tenant_id: '', reservation_id: '' }));
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

  const handleSwitchToCrossBuildingLookup = async () => {
    const cleanPhone = normalizePhone(newTenantForm.phone);
    const cleanId = newTenantForm.id_number.trim();
    const ident = isValidPhone(cleanPhone) ? cleanPhone : cleanId;
    setTenantMode('existing');
    setTenantIdentifier(ident);
    setCreateErrors((prev) => ({ ...prev, primary_tenant_id: undefined }));
    if (ident) {
      await handleLookupTenant(ident);
    }
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

  const handleApplyReservationProspect = async (resItem) => {
    userEditedCreateDatesRef.current = true;
    const rawPhone = normalizePhone(resItem?.phone || '');
    const holdStart = maxDateStr(toDateStr(resItem?.hold_from || resItem?.created_at || ''), todayStr);
    const busyWithoutThisRsv = extractApartmentBusyIntervals(aptSchedule, {
      excludeReservationId: resItem?.id,
      todayStr,
    });
    const safeStart = findFirstAvailableStartDate(holdStart || todayStr, busyWithoutThisRsv, {
      minSpanDays: 2,
    });
    setCreateForm((p) => ({
      ...p,
      reservation_id: resItem?.id || '',
      ...(safeStart
        ? {
            start_date: safeStart,
            end_date: computeSuggestedContractEndDate(safeStart, busyWithoutThisRsv, 12),
          }
        : {}),
    }));
    if (isValidPhone(rawPhone)) {
      setTenantMode('existing');
      setTenantIdentifier(rawPhone);
      const found = await handleLookupTenant(rawPhone);
      if (!found) {
        setTenantLookupState(null);
        setTenantMode('new');
        setNewTenantForm((prev) => ({
          ...prev,
          full_name: resItem?.prospect_name || prev.full_name,
          phone: rawPhone,
        }));
        toast.info(`Đã điền thông tin khách giữ chỗ "${resItem?.prospect_name || rawPhone}" vào biểu mẫu tạo mới.`);
      }
    } else if (resItem?.prospect_name) {
      setTenantMode('new');
      setNewTenantForm((prev) => ({
        ...prev,
        full_name: resItem.prospect_name,
      }));
    }
  };

  const activeBusyIntervals = useMemo(
    () =>
      extractApartmentBusyIntervals(aptSchedule, {
        excludeReservationId: createForm.reservation_id,
        todayStr,
      }),
    [aptSchedule, createForm.reservation_id, todayStr]
  );

  const earliestContractStart = useMemo(() => {
    if (!selectedApartment) return '';
    const baseSearch = ['OCCUPIED', 'MAINTENANCE'].includes(selectedApartment.status)
      ? addDaysStr(todayStr, 1)
      : todayStr;
    return findFirstAvailableStartDate(baseSearch, activeBusyIntervals, { minSpanDays: 2 });
  }, [selectedApartment, todayStr, activeBusyIntervals]);

  const minContractStartDate = useMemo(() => {
    if (!selectedApartment || !earliestContractStart) return undefined;
    if (
      ['OCCUPIED', 'MAINTENANCE'].includes(selectedApartment.status) ||
      earliestContractStart > todayStr
    ) {
      return earliestContractStart;
    }
    return undefined;
  }, [selectedApartment, earliestContractStart, todayStr]);

  const liveStartDateError = useMemo(() => {
    if (!createForm.start_date) return '';
    if (
      selectedApartment &&
      ['OCCUPIED', 'MAINTENANCE'].includes(selectedApartment.status) &&
      createForm.start_date <= todayStr
    ) {
      return 'Căn hộ đang có khách thuê / bảo trì, ngày bắt đầu hợp đồng mới phải sau hôm nay.';
    }
    const startHits = findOverlappingBusyIntervals(
      createForm.start_date,
      createForm.start_date,
      activeBusyIntervals
    );
    if (startHits.length > 0) {
      return formatBusyOverlapError(startHits, 'Ngày bắt đầu thuê');
    }
    return '';
  }, [createForm.start_date, selectedApartment, todayStr, activeBusyIntervals]);

  const liveEndDateError = useMemo(() => {
    const orderErr = getDateOrderError(createForm.start_date, createForm.end_date, {
      strictAfter: true,
      startLabel: 'Ngày bắt đầu thuê',
      endLabel: 'Ngày kết thúc thuê',
    });
    if (orderErr) return orderErr;
    if (!liveStartDateError && createForm.start_date && createForm.end_date) {
      const rangeHits = findOverlappingBusyIntervals(
        createForm.start_date,
        createForm.end_date,
        activeBusyIntervals
      );
      if (rangeHits.length > 0) {
        return formatBusyOverlapError(rangeHits, 'Kỳ hạn hợp đồng');
      }
    }
    return '';
  }, [createForm.start_date, createForm.end_date, liveStartDateError, activeBusyIntervals]);

  const overlappingScheduleContracts = useMemo(() => {
    if (!createForm.start_date) return [];
    return findOverlappingBusyIntervals(
      createForm.start_date,
      createForm.end_date,
      activeBusyIntervals
    );
  }, [activeBusyIntervals, createForm.start_date, createForm.end_date]);

  const handleExtractContractAi = async () => {
    const files = Array.isArray(contractScanFiles) ? contractScanFiles.filter(Boolean) : [];
    if (files.length === 0) {
      toast.warning('Vui lòng chọn ảnh hoặc tệp PDF hợp đồng trước khi trích xuất AI.');
      return;
    }
    setExtractingContractAi(true);
    setContractAiError(null);
    try {
      const res = await aiService.extractDocument({
        document_type: 'CONTRACT',
        building_id: effectiveModalBuildingId || selectedBuildingId || undefined,
        files,
        privacy_acknowledged: Boolean(contractScanConsent),
      });
      const data = res?.data || res;
      const out = data?.output || {};
      const aptCodeNorm = String(out.apartment_code || '').trim().toLowerCase();
      const matchedApt = aptCodeNorm
        ? selectableApartments.find(
            (a) => String(a.code || '').trim().toLowerCase() === aptCodeNorm
          )
        : null;

      if (out.start_date || out.end_date) {
        userEditedCreateDatesRef.current = true;
      }

      const mapped = {
        start_date: out.start_date ? String(out.start_date).slice(0, 10) : '',
        end_date: out.end_date ? String(out.end_date).slice(0, 10) : '',
        rent_amount:
          out.rent_amount !== null && out.rent_amount !== undefined && Number(out.rent_amount) > 0
            ? String(Math.round(Number(out.rent_amount)))
            : '',
        deposit_amount:
          out.deposit_amount !== null && out.deposit_amount !== undefined && Number(out.deposit_amount) >= 0
            ? String(Math.round(Number(out.deposit_amount)))
            : '',
        billing_day:
          out.billing_day !== null && out.billing_day !== undefined
            ? String(out.billing_day)
            : '',
        payment_due_days:
          out.payment_due_days !== null && out.payment_due_days !== undefined
            ? String(out.payment_due_days)
            : '',
        note: String(out.terms_note || out.note || '').trim(),
      };

      setCreateForm((prev) => ({
        ...prev,
        ...(matchedApt
          ? {
              building_id: matchedApt.building_id || prev.building_id,
              apartment_id: matchedApt.id,
            }
          : {}),
        ...(mapped.start_date ? { start_date: mapped.start_date } : {}),
        ...(mapped.end_date ? { end_date: mapped.end_date } : {}),
        ...(mapped.rent_amount ? { rent_amount: mapped.rent_amount } : {}),
        ...(mapped.deposit_amount ? { deposit_amount: mapped.deposit_amount } : {}),
        ...(mapped.billing_day ? { billing_day: mapped.billing_day } : {}),
        ...(mapped.payment_due_days ? { payment_due_days: mapped.payment_due_days } : {}),
        ...(mapped.note ? { note: mapped.note } : {}),
      }));

      const lookupKey = normalizePhone(out.tenant_phone || '') || String(out.tenant_id_number || '').trim();
      if (lookupKey) {
        setTenantMode('existing');
        setTenantIdentifier(lookupKey);
        const found = await handleLookupTenant(lookupKey);
        if (!found) {
          setTenantLookupState(null);
          setTenantMode('new');
          setNewTenantForm((prev) => ({
            ...prev,
            full_name: out.tenant_full_name ? String(out.tenant_full_name).trim() : prev.full_name,
            phone: normalizePhone(out.tenant_phone || '') || prev.phone,
            id_number: out.tenant_id_number ? String(out.tenant_id_number).trim() : prev.id_number,
          }));
        }
      } else if (out.tenant_full_name) {
        setTenantMode('new');
        setNewTenantForm((prev) => ({
          ...prev,
          full_name: String(out.tenant_full_name).trim(),
        }));
      }

      const baseConf = data?.confidence ?? null;
      const confMap = {
        start_date: out.field_confidences?.start_date ?? baseConf,
        end_date: out.field_confidences?.end_date ?? baseConf,
        rent_amount: out.field_confidences?.rent_amount ?? baseConf,
        deposit_amount: out.field_confidences?.deposit_amount ?? baseConf,
        billing_day: out.field_confidences?.billing_day ?? baseConf,
        payment_due_days: out.field_confidences?.payment_due_days ?? baseConf,
        note: out.field_confidences?.terms_note ?? baseConf,
      };
      setContractAiTracker(createAiFieldTracker(data?.suggestion_id, mapped, confMap));
      toast.success('AI đã trích xuất nháp hợp đồng — vui lòng kiểm tra các ô viền nét đứt trước khi lưu.');
    } catch (err) {
      setContractAiError(mapAiErrorToVietnamese(err));
    } finally {
      setExtractingContractAi(false);
    }
  };

  const handleExtractInlineCccdAi = async () => {
    const files = [newTenantForm.id_image_front, newTenantForm.id_image_back].filter(Boolean);
    if (files.length === 0) {
      toast.warning('Vui lòng chọn ít nhất 1 ảnh CCCD trước khi trích xuất AI.');
      return;
    }
    setExtractingInlineCccd(true);
    setInlineCccdError(null);
    try {
      const res = await aiService.extractDocument({
        document_type: 'CCCD',
        building_id: effectiveModalBuildingId || selectedBuildingId || undefined,
        files,
        privacy_acknowledged: Boolean(inlineCccdConsent),
      });
      const data = res?.data || res;
      const out = data?.output || {};
      const mapped = {
        full_name: out.full_name ? String(out.full_name).trim() : '',
        id_number: out.id_number ? String(out.id_number).trim() : '',
        dob: out.dob ? String(out.dob).slice(0, 10) : '',
        address: out.permanent_address ? String(out.permanent_address).trim() : '',
      };
      setNewTenantForm((prev) => ({
        ...prev,
        ...(mapped.full_name ? { full_name: mapped.full_name } : {}),
        ...(mapped.id_number ? { id_number: mapped.id_number } : {}),
        ...(mapped.dob ? { dob: mapped.dob } : {}),
        ...(mapped.address ? { address: mapped.address } : {}),
      }));
      const baseConf = data?.confidence ?? null;
      setInlineCccdTracker(
        createAiFieldTracker(data?.suggestion_id, mapped, {
          full_name: out.field_confidences?.full_name ?? baseConf,
          id_number: out.field_confidences?.id_number ?? baseConf,
          dob: out.field_confidences?.dob ?? baseConf,
          address: out.field_confidences?.permanent_address ?? baseConf,
        })
      );
      toast.success('AI đã điền nháp thông tin CCCD cư dân mới.');
    } catch (err) {
      setInlineCccdError(mapAiErrorToVietnamese(err));
    } finally {
      setExtractingInlineCccd(false);
    }
  };

  const dismissContractAiField = (fieldKey) => {
    setContractAiTracker((prev) => {
      if (!prev?.fields?.[fieldKey]) return prev;
      const nextFields = { ...prev.fields };
      delete nextFields[fieldKey];
      return { ...prev, fields: nextFields };
    });
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
    else if (liveStartDateError) errs.start_date = liveStartDateError;
    if (!createForm.end_date) errs.end_date = 'Chọn ngày kết thúc.';
    else if (liveEndDateError) errs.end_date = liveEndDateError;
    if (!createForm.rent_amount || Number(createForm.rent_amount) <= 0) {
      errs.rent_amount = 'Giá thuê phải lớn hơn 0.';
    }
    if (createForm.deposit_amount !== '' && Number(createForm.deposit_amount) < 0) {
      errs.deposit_amount = 'Tiền cọc không được âm.';
    }
    const dayNum = Number(createForm.billing_day || 1);
    if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31) {
      errs.billing_day = 'Ngày phát hành hóa đơn phải từ 1 đến 31.';
    }
    const dueNum = Number(createForm.payment_due_days || 5);
    if (!Number.isInteger(dueNum) || dueNum < 1 || dueNum > 60) {
      errs.payment_due_days = 'Thời hạn thanh toán phải từ 1 đến 60 ngày.';
    }

    const activeOccupants = inlineOccupants.filter(
      (o) => o.full_name.trim() || o.phone.trim() || o.id_number.trim()
    );
    const primaryNormPhone =
      tenantMode === 'new' ? normalizePhone(newTenantForm.phone) : '';
    const seenOccPhones = new Set();

    activeOccupants.forEach((occ, idx) => {
      if (!occ.full_name.trim()) {
        errs[`occ_name_${idx}`] = 'Nhập họ tên thành viên.';
      }
      const normOccPhone = normalizePhone(occ.phone);
      if (!normOccPhone) {
        errs[`occ_phone_${idx}`] = 'Nhập SĐT thành viên.';
      } else if (!isValidPhone(normOccPhone)) {
        errs[`occ_phone_${idx}`] = 'SĐT phải gồm 10 chữ số.';
      } else if (primaryNormPhone && normOccPhone === primaryNormPhone) {
        errs[`occ_phone_${idx}`] = 'Trùng SĐT với khách thuê chính.';
      } else if (seenOccPhones.has(normOccPhone)) {
        errs[`occ_phone_${idx}`] = 'Trùng SĐT giữa các thành viên.';
      } else {
        seenOccPhones.add(normOccPhone);
      }
      if (occ.id_number.trim() && !isValidIdNumber(occ.id_number.trim())) {
        errs[`occ_id_${idx}`] = 'CCCD/Hộ chiếu không hợp lệ.';
      }
    });

    const checkedCatalogServices = selectableCatalogServices.filter(
      (svc) => selectedServices[svc.id]?.checked
    );
    const normalizedServiceMetas = {};
    let firstServiceErrMsg = '';
    checkedCatalogServices.forEach((svc) => {
      const cfg = selectedServices[svc.id] || {};
      const parking = isParkingService(svc);
      const effQty = allowsMultiQuantity(svc) ? cfg.quantity : 1;
      const meta = validateServiceMetaInput({
        isParking: parking,
        quantity: effQty,
        vehiclePlates: cfg.vehicle_plates,
        note: cfg.note,
      });
      normalizedServiceMetas[svc.id] = meta;
      if (meta.quantityError) {
        errs[`svc_qty_${svc.id}`] = meta.quantityError;
        if (!firstServiceErrMsg) firstServiceErrMsg = meta.quantityError;
      }
      if (meta.plateErrors.some(Boolean)) {
        errs[`svc_plates_${svc.id}`] = meta.plateErrors;
        if (!firstServiceErrMsg) firstServiceErrMsg = meta.plateErrors.find(Boolean);
      }
      if (meta.noteError) {
        errs[`svc_note_${svc.id}`] = meta.noteError;
        if (!firstServiceErrMsg) firstServiceErrMsg = meta.noteError;
      }
    });

    setCreateErrors(errs);
    if (Object.keys(errs).length > 0) {
      if (firstServiceErrMsg) toast.warning(firstServiceErrMsg);
      return;
    }

    setSubmittingCreate(true);
    try {
      const payload = {
        apartment_id: createForm.apartment_id,
        building_id: selectedApartment?.building_id || createForm.building_id || undefined,
        ...(createForm.reservation_id ? { reservation_id: createForm.reservation_id } : {}),
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
                ...(newTenantForm.id_image_front ? { id_image_front: newTenantForm.id_image_front } : {}),
                ...(newTenantForm.id_image_back ? { id_image_back: newTenantForm.id_image_back } : {}),
                ...(inlineCccdTracker?.suggestionId ? { ai_suggestion_id: inlineCccdTracker.suggestionId } : {}),
              },
            }),
        ...(activeOccupants.length > 0
          ? {
              occupants: activeOccupants.map((occ) => ({
                full_name: occ.full_name.trim(),
                phone: normalizePhone(occ.phone),
                relationship: occ.relationship || 'family',
                ...(occ.id_number.trim() ? { id_number: occ.id_number.trim() } : {}),
              })),
            }
          : {}),
        start_date: createForm.start_date,
        end_date: createForm.end_date,
        rent_amount: Math.round(Number(createForm.rent_amount)),
        deposit_amount: Math.round(Number(createForm.deposit_amount || 0)),
        billing_cycle: createForm.billing_cycle || 'monthly',
        billing_day: Math.min(31, Math.max(1, Math.round(Number(createForm.billing_day || 1)))),
        payment_due_days: Math.min(60, Math.max(1, Math.round(Number(createForm.payment_due_days || 5)))),
        note: createForm.note.trim(),
        ...(contractAiTracker?.suggestionId ? { ai_suggestion_id: contractAiTracker.suggestionId } : {}),
      };

      const servicesPayload = checkedCatalogServices.map((svc) => {
        const cfg = selectedServices[svc.id] || {};
        const parking = isParkingService(svc);
        const meta = normalizedServiceMetas[svc.id];
        const qty = allowsMultiQuantity(svc)
          ? Math.max(1, Math.round(Number(cfg.quantity || 1)))
          : 1;
        const priceVal =
          cfg.unit_price !== undefined && cfg.unit_price !== ''
            ? Math.max(0, Math.round(Number(cfg.unit_price)))
            : Math.round(Number(svc.unit_price || 0));
        return {
          service_id: svc.id,
          quantity: qty,
          unit_price: priceVal,
          ...(parking ? { vehicle_plates: meta.cleanPlates } : {}),
          ...(meta.cleanNote ? { note: meta.cleanNote } : {}),
        };
      });
      if (servicesPayload.length > 0) {
        payload.services = servicesPayload;
      }

      const servicePricesPayload = [];
      if (customMeterPrices.ELECTRICITY !== '' && Number(customMeterPrices.ELECTRICITY) >= 0) {
        servicePricesPayload.push({
          service_code: 'ELECTRICITY',
          unit_price: Math.round(Number(customMeterPrices.ELECTRICITY)),
        });
      }
      if (customMeterPrices.WATER !== '' && Number(customMeterPrices.WATER) >= 0) {
        servicePricesPayload.push({
          service_code: 'WATER',
          unit_price: Math.round(Number(customMeterPrices.WATER)),
        });
      }
      if (servicePricesPayload.length > 0) {
        payload.service_prices = servicePricesPayload;
      }

      const res = await contractsService.create(payload, {
        idempotencyKey: createIdemKeyRef.current || createIdempotencyKey(),
      });
      const created = res?.data;

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
      if (statusFilter === 'PENDING_ALL') {
        if (!['PENDING_APPROVAL', 'RENEWAL_PENDING', 'TERMINATION_PENDING'].includes(c.status)) {
          return false;
        }
      } else if (statusFilter && c.status !== statusFilter) {
        return false;
      }
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
          <div className="max-w-[180px]">
            <p className="font-semibold text-slate-900">{row.apartment_code}</p>
            <p className="text-xs text-slate-500 truncate" title={row.building_name}>
              {row.building_name}
            </p>
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
            {row.status === 'TERMINATION_PENDING' && row.terminated_at ? (
              <p className="text-[11px] font-medium text-amber-700 mt-0.5">
                Trả phòng: {formatDate(row.terminated_at)}
              </p>
            ) : null}
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
        label: 'Ngày mong muốn / Ngày gửi',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => (
          <div className="text-xs">
            <p className="font-medium text-slate-700">{formatDate(row.desired_date)}</p>
            {row.created_at ? (
              <p className="text-[11px] text-slate-400">Gửi: {formatDate(row.created_at)}</p>
            ) : null}
          </div>
        ),
      },
      {
        key: 'note',
        label: 'Nội dung / Lý do',
        render: (row) => (
          <p className="text-xs text-slate-600 max-w-[300px] whitespace-pre-line break-words">
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
            setStatusFilter('PENDING_ALL');
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
          subtext="Đề nghị chờ Ban Quản Lý xử lý"
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
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submittingCreate}>
              Hủy bỏ
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateSubmit}
              loading={submittingCreate}
              disabled={Boolean(liveStartDateError || liveEndDateError)}
              icon={Plus}
            >
              Lưu hợp đồng nháp
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4">
          {canCreateContracts ? (
            <div className="p-3.5 rounded-2xl border border-indigo-200/90 bg-indigo-50/45 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold text-indigo-950 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                    Quét hợp đồng giấy / PDF bằng AI (AI-01)
                  </p>
                  <p className="text-[11px] text-slate-600 mt-0.5">
                    Tải lên ảnh chụp hoặc bản PDF hợp đồng (tối đa 3 tệp, ≤ 10MB/tệp) để AI điền nháp thông tin điều khoản.
                  </p>
                </div>
                {contractAiTracker?.suggestionId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={async () => {
                      const sid = contractAiTracker.suggestionId;
                      setContractAiTracker(null);
                      try {
                        await aiService.reviewSuggestion(sid, { decision: 'REJECT' });
                      } catch {
                        // Bỏ qua lỗi mạng khi hủy nháp
                      }
                    }}
                  >
                    Hủy nháp AI
                  </Button>
                ) : null}
              </div>

              <FileUpload
                multiple
                maxFiles={3}
                maxSizeMB={10}
                accept="image/jpeg,image/png,application/pdf"
                value={contractScanFiles}
                onChange={(arr) => setContractScanFiles(Array.isArray(arr) ? arr : [])}
                hint="Hỗ trợ ảnh JPG/PNG hoặc tệp PDF hợp đồng (tối đa 3 tệp)"
              />

              {contractScanFiles.length > 0 ? (
                <div className="space-y-2 pt-1 border-t border-indigo-200/60">
                  <label className="flex items-start gap-2 text-[11px] text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(contractScanConsent)}
                      onChange={(e) => setContractScanConsent(e.target.checked)}
                      className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>
                      Xác nhận đã thông báo và được đồng ý xử lý tài liệu hợp đồng qua AI (bấm &quot;Lưu hợp đồng nháp&quot; để chốt dữ liệu).
                    </span>
                  </label>
                  <Button
                    type="button"
                    variant="soft"
                    size="sm"
                    icon={Sparkles}
                    loading={extractingContractAi}
                    onClick={handleExtractContractAi}
                  >
                    Trích xuất hợp đồng bằng AI
                  </Button>
                </div>
              ) : null}

              {contractAiError ? (
                <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-0.5">
                  <p className="font-semibold">{contractAiError.title}</p>
                  <p className="text-amber-800">{contractAiError.guidance}</p>
                </div>
              ) : null}
            </div>
          ) : null}
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
              label="Căn hộ"
              required
              placeholder={
                loadingRefData
                  ? 'Đang tải căn hộ...'
                  : selectableApartments.length === 0
                  ? 'Không có căn hộ khả dụng'
                  : '-- Chọn căn hộ --'
              }
              searchPlaceholder="Tìm mã căn hộ, trạng thái, giá thuê..."
              value={createForm.apartment_id}
              onChange={(e) => handleSelectApartment(e.target.value)}
              error={createErrors.apartment_id}
              options={selectableApartments.map((a) => {
                const cCount = Number(a.active_contracts_count || 0);
                const rCount = Number(a.held_reservations_count || 0);
                const badgeParts = [];
                if (cCount > 0) badgeParts.push(`${cCount} HĐ`);
                if (rCount > 0) badgeParts.push(`${rCount} giữ chỗ`);
                return {
                  value: a.id,
                  label: `${a.code} — ${getAptSelectStatusLabel(a.status)} — Niêm yết: ${formatMoney(a.base_rent)}`,
                  sublabel: [a.building_name, a.floor_name].filter(Boolean).join(' · '),
                  badge: badgeParts.join(' · '),
                };
              })}
            />
          </div>

          {/* Hiển thị đầy đủ khoảng thời gian đã được thuê & các lượt đang giữ chỗ của căn hộ */}
          {selectedApartment &&
          (aptSchedule.loading ||
            aptSchedule.contracts.length > 0 ||
            aptSchedule.reservations.length > 0 ||
            ['OCCUPIED', 'RESERVED', 'MAINTENANCE'].includes(selectedApartment.status)) ? (
            <div
              data-testid="apartment-occupancy-schedule"
              className="rounded-2xl border border-amber-200/90 bg-amber-50/40 p-3.5 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-amber-600 shrink-0" />
                  <span className="text-xs font-bold text-slate-800">
                    Lịch đã thuê &amp; đang giữ chỗ — Căn {selectedApartment.code}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {aptSchedule.contracts.length > 0 ? (
                    <Badge variant="sky">{aptSchedule.contracts.length} hợp đồng</Badge>
                  ) : null}
                  {aptSchedule.reservations.length > 0 ? (
                    <Badge variant="amber">{aptSchedule.reservations.length} lượt giữ chỗ</Badge>
                  ) : null}
                </div>
              </div>

              {aptSchedule.loading ? (
                <p className="text-xs text-slate-500">
                  Đang tải chi tiết khoảng thời gian thuê &amp; giữ chỗ của căn {selectedApartment.code}...
                </p>
              ) : (
                <div className="space-y-2.5">
                  {aptSchedule.contracts.length > 0 ? (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-800 flex items-center gap-1.5">
                        <FileText className="w-3.5 h-3.5 text-sky-600" />
                        Khoảng thời gian đã có khách thuê / hợp đồng ({aptSchedule.contracts.length})
                      </p>
                      <div className="space-y-1.5">
                        {aptSchedule.contracts.map((c, idx) => (
                          <div
                            key={c.id || idx}
                            className="rounded-xl bg-white border border-sky-200/90 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                          >
                            <div className="space-y-0.5">
                              <p className="font-semibold text-slate-900">
                                Từ <span className="text-sky-700 font-mono">{formatDate(c.start_date)}</span> → đến{' '}
                                <span className="text-sky-700 font-mono">
                                  {formatDate(c.terminated_at || c.end_date)}
                                </span>
                              </p>
                              <p className="text-[11px] text-slate-600">
                                Khách thuê: <strong>{c.tenant_name || 'Đang thuê'}</strong>
                                {c.rent_amount ? ` · Giá thuê: ${formatMoney(c.rent_amount)}/tháng` : ''}
                              </p>
                            </div>
                            <StatusBadge status={c.status} domain="contract" />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {aptSchedule.reservations.length > 0 ? (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 flex items-center gap-1.5">
                        <Bookmark className="w-3.5 h-3.5 text-amber-600" />
                        Khoảng thời gian đang được giữ chỗ ({aptSchedule.reservations.length} người giữ chỗ)
                      </p>
                      <div className="space-y-1.5">
                        {aptSchedule.reservations.map((r, idx) => {
                          const isSelectedRsv =
                            Boolean(createForm.reservation_id) &&
                            String(createForm.reservation_id) === String(r.id);
                          return (
                            <div
                              key={r.id || idx}
                              className={`rounded-xl bg-white border px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs ${
                                isSelectedRsv
                                  ? 'border-emerald-400 ring-1 ring-emerald-200'
                                  : 'border-amber-200'
                              }`}
                            >
                              <div className="space-y-0.5">
                                <p className="font-semibold text-slate-900">
                                  <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">
                                    Giữ chỗ #{idx + 1}
                                  </span>
                                  Từ{' '}
                                  <span className="text-amber-700 font-mono">
                                    {formatDate(r.hold_from || r.created_at)}
                                  </span>{' '}
                                  → đến hết{' '}
                                  <span className="text-amber-700 font-mono">{formatDate(r.hold_until)}</span>
                                </p>
                                <p className="text-[11px] text-slate-600">
                                  Khách đặt: <strong>{r.prospect_name}</strong>
                                  {r.phone ? ` (${r.phone})` : ''} · Cọc giữ chỗ:{' '}
                                  <strong className="text-amber-800">{formatMoney(r.hold_amount)}</strong>
                                </p>
                              </div>
                              <Button
                                type="button"
                                size="xs"
                                variant={isSelectedRsv ? 'success' : 'soft'}
                                onClick={() => handleApplyReservationProspect(r)}
                              >
                                {isSelectedRsv ? 'Đã chọn khách này' : 'Chọn khách này'}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {['OCCUPIED', 'MAINTENANCE'].includes(selectedApartment.status) ? (
                    <p className="text-[11px] text-slate-600 pt-0.5">
                      Lưu ý: Căn <strong>{selectedApartment.code}</strong> đang ở trạng thái{' '}
                      <strong>{getAptSelectStatusLabel(selectedApartment.status)}</strong>. Vui lòng chọn ngày bắt đầu{' '}
                      <strong>sau hôm nay</strong> và không chồng lấn với các khoảng thời gian hợp đồng ở trên.
                    </p>
                  ) : null}

                  {overlappingScheduleContracts.length > 0 ? (
                    <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                      <span>
                        Kỳ hạn bạn đang chọn (<strong>{formatDate(createForm.start_date)}</strong> →{' '}
                        <strong>{formatDate(createForm.end_date)}</strong>) đang bị chồng lấn với lịch bận của căn hộ (
                        {overlappingScheduleContracts
                          .map((iv) => `${iv.label}: ${formatDate(iv.from)} → ${formatDate(iv.to)}`)
                          .join('; ')}
                        ). Hãy chọn ngày nằm ngoài các khoảng trên.
                      </span>
                    </div>
                  ) : earliestContractStart && earliestContractStart > todayStr ? (
                    <p className="text-[11px] text-emerald-800 bg-emerald-50/90 border border-emerald-200 rounded-xl px-3 py-1.5">
                      Đã tự động chọn ngày bắt đầu trống đầu tiên (<strong>{formatDate(earliestContractStart)}</strong>) nằm ngoài các khoảng căn hộ đã thuê / đang giữ chỗ.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

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
                      <p className="font-semibold text-emerald-900 flex items-center gap-1.5 flex-wrap">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                        <span>Đã xác thực cư dân: {selectedTenant.masked_name || selectedTenant.full_name}</span>
                        {selectedTenant.cross_building_link ? (
                          <Badge variant="indigo">Liên kết liên tòa (Bảo mật PII)</Badge>
                        ) : null}
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
                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-300 text-xs text-amber-900 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <span>
                        {dupInfo.message ||
                          'Định danh (SĐT/CCCD) này đã tồn tại trên hệ thống ngoài phạm vi tòa nhà bạn quản lý. Không thể tạo trùng hồ sơ.'}
                      </span>
                    </div>
                    {dupInfo.canLinkCrossBuilding ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="primary"
                        icon={Search}
                        onClick={handleSwitchToCrossBuildingLookup}
                      >
                        Chuyển sang Tra cứu &amp; Liên kết cư dân
                      </Button>
                    ) : null}
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
                  <AISuggestionField
                    active={Boolean(inlineCccdTracker?.fields?.full_name?.active)}
                    confirmed={Boolean(inlineCccdTracker?.fields?.full_name?.confirmed)}
                    edited={Boolean(inlineCccdTracker?.fields?.full_name?.edited)}
                    confidence={inlineCccdTracker?.fields?.full_name?.confidence}
                    onConfirm={() =>
                      setInlineCccdTracker((prev) =>
                        markFieldConfirmedOrEdited(prev, 'full_name', newTenantForm.full_name)
                      )
                    }
                  >
                    <Input
                      label="Họ và tên khách thuê mới"
                      required
                      placeholder="VD: Nguyễn Văn Minh"
                      value={newTenantForm.full_name}
                      onChange={(e) => {
                        const val = e.target.value;
                        setNewTenantForm((p) => ({ ...p, full_name: val }));
                        setInlineCccdTracker((prev) =>
                          markFieldConfirmedOrEdited(prev, 'full_name', val)
                        );
                      }}
                      error={createErrors.new_full_name}
                    />
                  </AISuggestionField>
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
                  <AISuggestionField
                    active={Boolean(inlineCccdTracker?.fields?.id_number?.active)}
                    confirmed={Boolean(inlineCccdTracker?.fields?.id_number?.confirmed)}
                    edited={Boolean(inlineCccdTracker?.fields?.id_number?.edited)}
                    confidence={inlineCccdTracker?.fields?.id_number?.confidence}
                    onConfirm={() =>
                      setInlineCccdTracker((prev) =>
                        markFieldConfirmedOrEdited(prev, 'id_number', newTenantForm.id_number)
                      )
                    }
                  >
                    <Input
                      label="Số CCCD / Hộ chiếu"
                      placeholder="12 chữ số CCCD (khuyến nghị nhập đủ)"
                      hint={
                        newTenantForm.id_number.trim()
                          ? 'Có CCCD → Hồ sơ tự động đạt trạng thái APPROVED'
                          : 'Nếu để trống → Lưu nháp được, cần bổ sung trước khi Kích hoạt'
                      }
                      value={newTenantForm.id_number}
                      onChange={(e) => {
                        const val = e.target.value;
                        setNewTenantForm((p) => ({ ...p, id_number: val }));
                        setInlineCccdTracker((prev) =>
                          markFieldConfirmedOrEdited(prev, 'id_number', val)
                        );
                      }}
                      error={createErrors.new_id_number}
                    />
                  </AISuggestionField>
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-1">
                  <FileUpload
                    label="Ảnh CCCD / Hộ chiếu mặt trước (tùy chọn)"
                    accept="image/jpeg,image/png"
                    maxSizeMB={5}
                    value={newTenantForm.id_image_front}
                    onChange={(val) =>
                      setNewTenantForm((p) => ({ ...p, id_image_front: val || '' }))
                    }
                    hint="Ảnh JPG/PNG tối đa 5MB"
                  />
                  <FileUpload
                    label="Ảnh CCCD mặt sau (tùy chọn)"
                    accept="image/jpeg,image/png"
                    maxSizeMB={5}
                    value={newTenantForm.id_image_back}
                    onChange={(val) =>
                      setNewTenantForm((p) => ({ ...p, id_image_back: val || '' }))
                    }
                    hint="Ảnh JPG/PNG tối đa 5MB"
                  />
                </div>
                {canCreateContracts && (newTenantForm.id_image_front || newTenantForm.id_image_back) ? (
                  <div className="p-3 rounded-xl bg-indigo-50/50 border border-indigo-200/80 space-y-2">
                    <label className="flex items-start gap-2 text-[11px] text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(inlineCccdConsent)}
                        onChange={(e) => setInlineCccdConsent(e.target.checked)}
                        className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>Xác nhận cư dân đồng ý xử lý ảnh CCCD bằng AI để điền nháp thông tin định danh.</span>
                    </label>
                    <Button
                      type="button"
                      variant="soft"
                      size="xs"
                      icon={Sparkles}
                      loading={extractingInlineCccd}
                      onClick={handleExtractInlineCccdAi}
                    >
                      Trích xuất CCCD bằng AI
                    </Button>
                    {inlineCccdError ? (
                      <p className="text-xs text-amber-800">{inlineCccdError.title}: {inlineCccdError.guidance}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* Khối tùy chọn: Thành viên ở cùng (occupants[]) ngay khi lập hợp đồng (FR-011 / FR-014) */}
          <div className="p-4 rounded-2xl border border-slate-200/90 bg-slate-50/60 space-y-3.5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-primary-600 shrink-0" />
                  Thành viên ở cùng (Tùy chọn)
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Khai báo sẵn người ở ghép / gia đình để tự động liên kết định danh và cấp quyền Cổng cư dân
                </p>
              </div>
              <div className="shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  icon={UserPlus}
                  onClick={() =>
                    setInlineOccupants((prev) => [
                      ...prev,
                      { full_name: '', phone: '', relationship: 'family', id_number: '' },
                    ])
                  }
                >
                  Thêm thành viên ở cùng
                </Button>
              </div>
            </div>

            {selectedApartment &&
            1 + inlineOccupants.length >
              Number(
                selectedApartment.max_occupants ||
                  Math.max(2, Number(selectedApartment.bedrooms || 1) * 2 + 1)
              ) ? (
              <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>
                  Tổng số người lưu trú dự kiến (<strong>{1 + inlineOccupants.length} người</strong>) vượt định mức khuyến nghị của căn{' '}
                  <strong>{selectedApartment.code}</strong> (
                  {Number(
                    selectedApartment.max_occupants ||
                      Math.max(2, Number(selectedApartment.bedrooms || 1) * 2 + 1)
                  )}{' '}
                  người). Vui lòng kiểm tra lại quy định tòa nhà trước khi ký.
                </span>
              </div>
            ) : null}

            {inlineOccupants.length > 0 ? (
              <div className="space-y-3">
                {inlineOccupants.map((occ, idx) => (
                  <div
                    key={idx}
                    data-testid="inline-occupant-card"
                    className="p-4 rounded-xl bg-white border border-slate-200/90 shadow-xs space-y-3.5"
                  >
                    <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-slate-100">
                      <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary-50 text-primary-700 text-[11px] font-bold">
                          {idx + 1}
                        </span>
                        Thành viên #{idx + 1}
                      </span>
                      <button
                        type="button"
                        title="Xóa thành viên này"
                        onClick={() =>
                          setInlineOccupants((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-rose-600 hover:bg-rose-50 hover:text-rose-700 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Xóa</span>
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <Input
                        label="Họ và tên"
                        required
                        placeholder="VD: Nguyễn Văn B"
                        value={occ.full_name}
                        onChange={(e) =>
                          setInlineOccupants((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, full_name: e.target.value } : item))
                          )
                        }
                        error={createErrors[`occ_name_${idx}`]}
                      />
                      <Input
                        label="Số điện thoại"
                        required
                        placeholder="VD: 0912345678"
                        value={occ.phone}
                        onChange={(e) =>
                          setInlineOccupants((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, phone: e.target.value } : item))
                          )
                        }
                        error={createErrors[`occ_phone_${idx}`]}
                      />
                      <Select
                        label="Quan hệ"
                        value={occ.relationship}
                        onChange={(e) =>
                          setInlineOccupants((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, relationship: e.target.value } : item
                            )
                          )
                        }
                        options={INLINE_RELATIONSHIP_OPTIONS}
                      />
                      <Input
                        label="Số CCCD / Hộ chiếu"
                        placeholder="12 chữ số CCCD (tùy chọn)"
                        value={occ.id_number}
                        onChange={(e) =>
                          setInlineOccupants((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, id_number: e.target.value } : item
                            )
                          )
                        }
                        error={createErrors[`occ_id_${idx}`]}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <AISuggestionField
                active={Boolean(contractAiTracker?.fields?.start_date?.active)}
                confirmed={Boolean(contractAiTracker?.fields?.start_date?.confirmed)}
                edited={Boolean(contractAiTracker?.fields?.start_date?.edited)}
                confidence={contractAiTracker?.fields?.start_date?.confidence}
                onConfirm={() =>
                  setContractAiTracker((prev) =>
                    markFieldConfirmedOrEdited(prev, 'start_date', createForm.start_date)
                  )
                }
                onDismiss={() => dismissContractAiField('start_date')}
              >
                <Input
                  label="Ngày bắt đầu thuê"
                  type="date"
                  required
                  min={minContractStartDate}
                  value={createForm.start_date}
                  onChange={(e) => {
                    userEditedCreateDatesRef.current = true;
                    const val = e.target.value;
                    setCreateForm((p) => ({ ...p, start_date: val }));
                    setCreateErrors((prev) => ({ ...prev, start_date: undefined }));
                    setContractAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'start_date', val));
                  }}
                  error={liveStartDateError || createErrors.start_date}
                />
              </AISuggestionField>
              <AISuggestionField
                active={Boolean(contractAiTracker?.fields?.end_date?.active)}
                confirmed={Boolean(contractAiTracker?.fields?.end_date?.confirmed)}
                edited={Boolean(contractAiTracker?.fields?.end_date?.edited)}
                confidence={contractAiTracker?.fields?.end_date?.confidence}
                onConfirm={() =>
                  setContractAiTracker((prev) =>
                    markFieldConfirmedOrEdited(prev, 'end_date', createForm.end_date)
                  )
                }
                onDismiss={() => dismissContractAiField('end_date')}
              >
                <Input
                  label="Ngày kết thúc thuê"
                  type="date"
                  required
                  min={createForm.start_date ? addDaysStr(createForm.start_date, 1) : undefined}
                  value={createForm.end_date}
                  onChange={(e) => {
                    userEditedCreateDatesRef.current = true;
                    const val = e.target.value;
                    setCreateForm((p) => ({ ...p, end_date: val }));
                    setCreateErrors((prev) => ({ ...prev, end_date: undefined }));
                    setContractAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'end_date', val));
                  }}
                  error={liveEndDateError || createErrors.end_date}
                />
              </AISuggestionField>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-slate-500 flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Chọn nhanh kỳ hạn:
              </span>
              {[6, 12, 24].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    userEditedCreateDatesRef.current = true;
                    setCreateForm((p) => ({
                      ...p,
                      end_date: addMonthsStr(p.start_date || todayStr, m),
                    }));
                    setCreateErrors((prev) => ({ ...prev, end_date: undefined }));
                  }}
                  className="px-2.5 py-1 text-xs font-medium rounded-md bg-slate-100 hover:bg-primary-50 text-slate-700 hover:text-primary-700 border border-slate-200 transition-colors"
                >
                  {m} tháng
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <AISuggestionField
              active={Boolean(contractAiTracker?.fields?.rent_amount?.active)}
              confirmed={Boolean(contractAiTracker?.fields?.rent_amount?.confirmed)}
              edited={Boolean(contractAiTracker?.fields?.rent_amount?.edited)}
              confidence={contractAiTracker?.fields?.rent_amount?.confidence}
              onConfirm={() =>
                setContractAiTracker((prev) =>
                  markFieldConfirmedOrEdited(prev, 'rent_amount', createForm.rent_amount)
                )
              }
              onDismiss={() => dismissContractAiField('rent_amount')}
            >
              <MoneyInput
                label="Giá thuê hàng tháng (VND)"
                required
                placeholder="VD: 8.500.000"
                hint={
                  selectedApartment
                    ? `Giá niêm yết của căn ${selectedApartment.code}: ${formatMoney(selectedApartment.base_rent)}`
                    : undefined
                }
                value={createForm.rent_amount}
                onChange={(e) => {
                  const val = e.target.value;
                  setCreateForm((p) => ({ ...p, rent_amount: val }));
                  setContractAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'rent_amount', val));
                }}
                error={createErrors.rent_amount}
              />
            </AISuggestionField>
            <AISuggestionField
              active={Boolean(contractAiTracker?.fields?.deposit_amount?.active)}
              confirmed={Boolean(contractAiTracker?.fields?.deposit_amount?.confirmed)}
              edited={Boolean(contractAiTracker?.fields?.deposit_amount?.edited)}
              confidence={contractAiTracker?.fields?.deposit_amount?.confidence}
              onConfirm={() =>
                setContractAiTracker((prev) =>
                  markFieldConfirmedOrEdited(prev, 'deposit_amount', createForm.deposit_amount)
                )
              }
              onDismiss={() => dismissContractAiField('deposit_amount')}
            >
              <MoneyInput
                label="Tiền đặt cọc bảo đảm (VND)"
                placeholder="VD: 8.500.000"
                hint={
                  selectedReservation && Number(selectedReservation.hold_amount || 0) > 0
                    ? `Phiếu giữ chỗ đang chọn đã thu ${formatMoney(selectedReservation.hold_amount)} — nên đặt tiền cọc >= mức này để cấn trừ đủ`
                    : 'Mặc định gợi ý bằng 1 tháng tiền thuê'
                }
                value={createForm.deposit_amount}
                onChange={(e) => {
                  const val = e.target.value;
                  setCreateForm((p) => ({ ...p, deposit_amount: val }));
                  setContractAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'deposit_amount', val));
                }}
                error={createErrors.deposit_amount}
              />
            </AISuggestionField>
          </div>

          {isDiscountedWarning ? (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-300 text-xs text-amber-900 flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="leading-relaxed">
                <p className="font-semibold">
                  Cảnh báo khung giá ưu đãi (&lt; 90% giá niêm yết {formatMoney(selectedApartment?.base_rent)})
                </p>
                <p className="text-amber-800 mt-0.5">
                  Theo quy định kiểm soát khung giá (FR-014), mức giá thuê đề xuất giảm trên 10% so với giá niêm yết. Khi bấm Kích hoạt sau khi đính kèm bản ký, hợp đồng sẽ tự động chuyển sang trạng thái{' '}
                  <strong>PENDING_APPROVAL</strong> để chờ <strong>Chủ sở hữu tòa nhà (OWNER)</strong> phê duyệt.
                </p>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
              max="31"
              value={createForm.billing_day}
              onChange={(e) => setCreateForm((p) => ({ ...p, billing_day: e.target.value }))}
              error={createErrors.billing_day}
              hint="Ngày chốt hóa đơn (1 – 31, tự kẹp cuối tháng)"
            />
            <Input
              label="Thời hạn thanh toán (ngày)"
              type="number"
              min="1"
              max="60"
              value={createForm.payment_due_days}
              onChange={(e) => setCreateForm((p) => ({ ...p, payment_due_days: e.target.value }))}
              error={createErrors.payment_due_days}
              hint="Số ngày hạn đóng sau ngày phát hành (mặc định 5)"
            />
          </div>

          {/* Bước 4: Chọn Dịch vụ đi kèm (services[]) & Đơn giá riêng theo hợp đồng (FR-014, FR-065) */}
          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/70 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <p className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                  <FileSignature className="w-3.5 h-3.5 text-primary-600" />
                  Dịch vụ đi kèm &amp; Đơn giá riêng theo hợp đồng (Tùy chọn)
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Đăng ký sẵn các dịch vụ định kỳ (sẽ tự động kích hoạt khi hợp đồng sang ACTIVE) và cấu hình đơn giá ưu đãi riêng nếu có
                </p>
              </div>
              {selectableCatalogServices.filter((svc) => selectedServices[svc.id]?.checked).length > 0 ? (
                <Badge variant="emerald">
                  Đã chọn {selectableCatalogServices.filter((svc) => selectedServices[svc.id]?.checked).length} dịch vụ
                </Badge>
              ) : null}
            </div>

            {selectableCatalogServices.length > 0 ? (
              <div className="space-y-2">
                {selectableCatalogServices.map((svc) => {
                  const parking = isParkingService(svc);
                  const multiQty = allowsMultiQuantity(svc);
                  const cfg = selectedServices[svc.id] || {
                    checked: false,
                    quantity: '1',
                    unit_price: String(Math.round(Number(svc.unit_price || 0))),
                    vehicle_plates: [''],
                    note: '',
                  };
                  return (
                    <div
                      key={svc.id}
                      className={`p-2.5 rounded-lg border transition-colors ${
                        cfg.checked
                          ? 'bg-white border-primary-300 shadow-xs'
                          : 'bg-white/70 border-slate-200'
                      }`}
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5 items-center">
                        <label className="sm:col-span-5 flex items-start gap-2.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={Boolean(cfg.checked)}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              const nextQty = selectedServices[svc.id]?.quantity || '1';
                              setSelectedServices((prev) => ({
                                ...prev,
                                [svc.id]: {
                                  checked,
                                  quantity: nextQty,
                                  unit_price:
                                    prev[svc.id]?.unit_price !== undefined
                                      ? prev[svc.id].unit_price
                                      : String(Math.round(Number(svc.unit_price || 0))),
                                  vehicle_plates: parking
                                    ? syncVehiclePlatesArray(prev[svc.id]?.vehicle_plates, nextQty)
                                    : [],
                                  note: prev[svc.id]?.note || '',
                                },
                              }));
                            }}
                            className="mt-0.5 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                          />
                          <div className="text-xs">
                            <p className="font-semibold text-slate-800">
                              {svc.name}{' '}
                              <span className="font-mono text-[11px] text-slate-400">({svc.code})</span>
                            </p>
                            <p className="text-[11px] text-slate-500">
                              Niêm yết: {formatMoney(svc.unit_price)} / {svc.unit || 'tháng'}
                              {svc.billing_type === 'QUANTITY' ? ' • Tính theo số lượng' : ' • Trọn gói cố định'}
                            </p>
                          </div>
                        </label>

                        {cfg.checked ? (
                          <>
                            <div className="sm:col-span-3">
                              {multiQty ? (
                                <Input
                                  label="Số lượng"
                                  type="number"
                                  min="1"
                                  max={parking ? MAX_PARKING_QUANTITY : undefined}
                                  error={createErrors[`svc_qty_${svc.id}`]}
                                  value={cfg.quantity}
                                  onChange={(e) => {
                                    const nextQty = e.target.value;
                                    setSelectedServices((prev) => ({
                                      ...prev,
                                      [svc.id]: {
                                        ...cfg,
                                        quantity: nextQty,
                                        vehicle_plates: parking
                                          ? syncVehiclePlatesArray(cfg.vehicle_plates, nextQty)
                                          : [],
                                      },
                                    }));
                                    setCreateErrors((prev) => {
                                      if (!prev[`svc_qty_${svc.id}`] && !prev[`svc_plates_${svc.id}`]) return prev;
                                      const next = { ...prev };
                                      delete next[`svc_qty_${svc.id}`];
                                      delete next[`svc_plates_${svc.id}`];
                                      return next;
                                    });
                                  }}
                                />
                              ) : (
                                <div className="text-[11px] text-slate-400 sm:pt-5 text-center">1 gói</div>
                              )}
                            </div>
                            <div className="sm:col-span-4">
                              <MoneyInput
                                label="Đơn giá áp dụng (VND)"
                                value={cfg.unit_price}
                                onChange={(e) =>
                                  setSelectedServices((prev) => ({
                                    ...prev,
                                    [svc.id]: { ...cfg, unit_price: e.target.value },
                                  }))
                                }
                              />
                            </div>
                          </>
                        ) : null}
                      </div>

                      {cfg.checked ? (
                        <div className="mt-2.5 pt-2.5 border-t border-slate-100">
                          <ServiceSubscriptionMetaFields
                            isParking={parking}
                            quantity={multiQty ? cfg.quantity : 1}
                            vehiclePlates={cfg.vehicle_plates}
                            note={cfg.note || ''}
                            plateErrors={createErrors[`svc_plates_${svc.id}`] || []}
                            noteError={createErrors[`svc_note_${svc.id}`] || ''}
                            onPlateChange={(plateIdx, val) => {
                              const nextPlates = syncVehiclePlatesArray(
                                cfg.vehicle_plates,
                                multiQty ? cfg.quantity : 1
                              );
                              nextPlates[plateIdx] = val;
                              setSelectedServices((prev) => ({
                                ...prev,
                                [svc.id]: { ...cfg, vehicle_plates: nextPlates },
                              }));
                              setCreateErrors((prev) => {
                                if (!prev[`svc_plates_${svc.id}`]) return prev;
                                const next = { ...prev };
                                delete next[`svc_plates_${svc.id}`];
                                return next;
                              });
                            }}
                            onNoteChange={(val) => {
                              setSelectedServices((prev) => ({
                                ...prev,
                                [svc.id]: { ...cfg, note: val },
                              }));
                              setCreateErrors((prev) => {
                                if (!prev[`svc_note_${svc.id}`]) return prev;
                                const next = { ...prev };
                                delete next[`svc_note_${svc.id}`];
                                return next;
                              });
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-slate-500 italic">
                Chưa có dịch vụ định kỳ nào trong danh mục hoạt động của tòa nhà.
              </p>
            )}

            <div className="pt-2 border-t border-slate-200/80 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <MoneyInput
                label="Đơn giá Điện riêng theo HĐ (VND/kWh)"
                placeholder="Để trống = theo giá đồng hồ tòa nhà"
                value={customMeterPrices.ELECTRICITY}
                onChange={(e) =>
                  setCustomMeterPrices((p) => ({ ...p, ELECTRICITY: e.target.value }))
                }
              />
              <MoneyInput
                label="Đơn giá Nước riêng theo HĐ (VND/m³)"
                placeholder="Để trống = theo giá đồng hồ tòa nhà"
                value={customMeterPrices.WATER}
                onChange={(e) =>
                  setCustomMeterPrices((p) => ({ ...p, WATER: e.target.value }))
                }
              />
            </div>
          </div>

          <AISuggestionField
            active={Boolean(contractAiTracker?.fields?.note?.active)}
            confirmed={Boolean(contractAiTracker?.fields?.note?.confirmed)}
            edited={Boolean(contractAiTracker?.fields?.note?.edited)}
            confidence={contractAiTracker?.fields?.note?.confidence}
            onConfirm={() =>
              setContractAiTracker((prev) =>
                markFieldConfirmedOrEdited(prev, 'note', createForm.note)
              )
            }
            onDismiss={() => dismissContractAiField('note')}
          >
            <Input
              label="Ghi chú hợp đồng"
              multiline
              rows={2}
              placeholder="Thỏa thuận thêm về nội thất bàn giao, điều kiện ưu đãi..."
              value={createForm.note}
              onChange={(e) => {
                const val = e.target.value;
                setCreateForm((p) => ({ ...p, note: val }));
                setContractAiTracker((prev) => markFieldConfirmedOrEdited(prev, 'note', val));
              }}
            />
          </AISuggestionField>
        </form>
      </Modal>

      {/* Modal Chi tiết & Xử lý Yêu cầu Hợp đồng từ Cư dân (mở tự động từ thông báo) */}
      <Modal
        open={Boolean(reviewRequestTarget)}
        onClose={() => setReviewRequestTarget(null)}
        title="Chi tiết Đề nghị Hợp đồng từ Cư dân"
        subtitle={
          reviewRequestTarget
            ? `Căn ${reviewRequestTarget.apartment_code || '—'} (${reviewRequestTarget.building_name || '—'}) • ${reviewRequestTarget.resident_name || 'Cư dân'}`
            : ''
        }
        size="md"
        footer={
          reviewRequestTarget ? (
            <>
              <Button
                variant="outline"
                onClick={() => setReviewRequestTarget(null)}
                disabled={processingReq}
              >
                Đóng
              </Button>
              {reviewRequestTarget.contract_id ? (
                <Button
                  variant="outline"
                  icon={Eye}
                  onClick={() => {
                    const cid = reviewRequestTarget.contract_id;
                    setReviewRequestTarget(null);
                    navigate(`/admin/contracts/${cid}`);
                  }}
                >
                  Mở hợp đồng gốc
                </Button>
              ) : null}
              {canApproveContracts && reviewRequestTarget.status === 'SUBMITTED' ? (
                <>
                  <Button
                    variant="danger"
                    icon={XCircle}
                    disabled={processingReq}
                    onClick={() => {
                      const target = reviewRequestTarget;
                      setReviewRequestTarget(null);
                      setRejectReqTarget(target);
                      setRejectReason('');
                    }}
                  >
                    Từ chối
                  </Button>
                  <Button
                    variant="success"
                    icon={CheckCircle2}
                    disabled={processingReq}
                    onClick={() => {
                      const target = reviewRequestTarget;
                      setReviewRequestTarget(null);
                      setApproveReqTarget(target);
                    }}
                  >
                    Phê duyệt đề nghị
                  </Button>
                </>
              ) : null}
            </>
          ) : null
        }
      >
        {reviewRequestTarget ? (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200">
              <div>
                <p className="text-slate-500">Loại đề nghị</p>
                <div className="mt-1">
                  <Badge
                    variant={REQUEST_TYPE_MAP[reviewRequestTarget.type]?.variant || 'slate'}
                    dot
                  >
                    {REQUEST_TYPE_MAP[reviewRequestTarget.type]?.label || reviewRequestTarget.type}
                  </Badge>
                </div>
              </div>
              <div>
                <p className="text-slate-500">Trạng thái xử lý</p>
                <div className="mt-1">
                  <Badge
                    variant={REQUEST_STATUS_BADGE[reviewRequestTarget.status]?.variant || 'slate'}
                    dot
                  >
                    {REQUEST_STATUS_BADGE[reviewRequestTarget.status]?.label ||
                      reviewRequestTarget.status}
                  </Badge>
                </div>
              </div>
              <div>
                <p className="text-slate-500">Ngày mong muốn</p>
                <p className="font-semibold text-slate-900 mt-0.5">
                  {formatDate(reviewRequestTarget.desired_date)}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Liên hệ cư dân</p>
                <p className="font-medium text-slate-800 mt-0.5">
                  {reviewRequestTarget.resident_phone || '—'}
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-white border border-slate-200 space-y-1">
              <p className="font-semibold text-slate-700">Nội dung / Lý do từ cư dân</p>
              <p className="text-slate-600 whitespace-pre-line">
                {reviewRequestTarget.note || 'Không có ghi chú thêm.'}
              </p>
            </div>

            {reviewRequestTarget.rejection_reason ? (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 space-y-1">
                <p className="font-semibold text-rose-800">Lý do từ chối</p>
                <p className="text-rose-700">{reviewRequestTarget.rejection_reason}</p>
              </div>
            ) : null}
          </div>
        ) : null}
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
