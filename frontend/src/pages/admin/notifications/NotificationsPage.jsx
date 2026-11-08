import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Bell,
  BellRing,
  Send,
  CheckCheck,
  Inbox,
  RefreshCw,
  Building2,
  Copy,
  Check,
  Plus,
  Clock,
  AlertTriangle,
  XCircle,
  ExternalLink,
  MessageSquare,
  ArrowRight,
  Trash2,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { Modal } from '../../../components/ui/Modal';
import { PageHeader } from '../../../components/common/PageHeader';
import { SearchBar } from '../../../components/common/SearchBar';
import { EmptyState } from '../../../components/common/EmptyState';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { notificationsService } from '../../../services/notifications.service';
import { announcementsService } from '../../../services/announcements.service';
import { buildingsService } from '../../../services/buildings.service';
import { useNotificationStore } from '../../../stores/notificationStore';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { useNotificationAction } from '../../../hooks/useNotificationAction';
import { NotificationDetailModal } from '../../../components/common/NotificationDetailModal';
import { mergeOrgNotificationReadState } from '../../../utils/notificationNavigation';
import { APARTMENT_STATUS, ANNOUNCEMENT_STATUS } from '../../../constants/statuses';
import { formatDateTime, formatRelativeTime } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';
import {
  ZALO_QUICK_TEMPLATES,
  buildZaloPreviewText,
  isValidZaloGroupUrl,
  parseZaloBoldSegments,
  copyZaloMessageToClipboard,
} from '../../../utils/zaloFormat';

const NOTIFICATION_TYPES = {
  ANNOUNCEMENT: { label: 'Thông báo chung BQL', variant: 'sky' },
  UTILITY_INTERRUPTION: { label: 'Cắt điện / nước tạm thời', variant: 'amber' },
  MAINTENANCE_NOTICE: { label: 'Lịch bảo trì / Kỹ thuật', variant: 'amber' },
  HOUSE_RULES: { label: 'Nhắc nhở nội quy', variant: 'indigo' },
  SECURITY_ALERT: { label: 'Cảnh báo An ninh / PCCC', variant: 'red' },
  SYSTEM: { label: 'Thông báo hệ thống', variant: 'slate' },
  PAYMENT_REMINDER: { label: 'Nhắc thanh toán phí', variant: 'indigo' },
  INVOICE_ISSUED: { label: 'Phát hành hóa đơn', variant: 'emerald' },
  PAYMENT_CONFIRMED: { label: 'Xác nhận thanh toán', variant: 'emerald' },
  PAYMENT_REJECTED: { label: 'Từ chối chứng từ', variant: 'red' },
  MAINTENANCE_UPDATE: { label: 'Cập nhật báo hỏng', variant: 'amber' },
  SERVICE_REQUEST_CREATED: { label: 'Báo hỏng mới', variant: 'sky' },
  SERVICE_REQUEST_URGENT: { label: 'Báo hỏng KHẨN CẤP', variant: 'red' },
  SERVICE_REQUEST_REOPENED: { label: 'Mở lại báo hỏng', variant: 'red' },
  SERVICE_REQUEST_ESCALATED: { label: 'Quá hạn SLA kỹ thuật', variant: 'red' },
  SERVICE_REQUEST_SLA_BREACH: { label: 'Quá hạn SLA kỹ thuật', variant: 'red' },
  SERVICE_UPDATE: { label: 'Cập nhật dịch vụ', variant: 'purple' },
  SERVICE_TERMINATED: { label: 'Chấm dứt dịch vụ', variant: 'slate' },
  SERVICE_SUBSCRIPTION_REQUESTED: { label: 'Đăng ký dịch vụ mới', variant: 'sky' },
  SERVICE_CANCELLATION_REQUESTED: { label: 'Yêu cầu hủy dịch vụ', variant: 'amber' },
  PAYMENT_REPORTED: { label: 'Cư dân báo đã thanh toán', variant: 'emerald' },
  CONTRACT_REQUEST_SUBMITTED: { label: 'Đề nghị gia hạn / chấm dứt HĐ', variant: 'indigo' },
  PENDING_CREDIT_REFUND: { label: 'Chờ duyệt hoàn tín dụng (4 mắt)', variant: 'amber' },
  CREDIT_REFUND_PENDING: { label: 'Chờ hoàn tiền tín dụng', variant: 'amber' },
  CREDIT_REFUNDED: { label: 'Đã hoàn tiền tín dụng', variant: 'emerald' },
  CREDIT_REFUND_REJECTED: { label: 'Từ chối hoàn tín dụng', variant: 'red' },
  INVOICE_ADJUSTMENT_PENDING: { label: 'Chờ duyệt điều chỉnh HĐ (4 mắt)', variant: 'amber' },
  INVOICE_ADJUSTED: { label: 'Hóa đơn đã điều chỉnh', variant: 'purple' },
  AI_BUDGET_WARNING: { label: 'Cảnh báo ngân sách AI', variant: 'amber' },
  AI_BUDGET_EXCEEDED: { label: 'Chạm trần ngân sách AI', variant: 'red' },
  CRON_JOB_FAILED: { label: 'Lỗi tiến trình nền', variant: 'red' },
};

const COMPOSE_TYPE_OPTIONS = [
  { value: 'ANNOUNCEMENT', label: 'Thông báo chung Ban quản lý' },
  { value: 'UTILITY_INTERRUPTION', label: 'Tạm ngừng cấp điện / nước' },
  { value: 'MAINTENANCE_NOTICE', label: 'Lịch bảo trì thang máy / PCCC / Kỹ thuật' },
  { value: 'HOUSE_RULES', label: 'Nhắc nhở nội quy khu vực chung' },
  { value: 'SECURITY_ALERT', label: 'Cảnh báo An ninh / PCCC khẩn' },
];

const SCOPE_OPTIONS = [
  { value: 'BUILDING', label: '🏢 Toàn tòa nhà (BUILDING)' },
  { value: 'FLOOR', label: '📑 Theo Tầng cụ thể (FLOOR)' },
  { value: 'APARTMENT', label: '🚪 Từng Phòng / Căn hộ (APARTMENT)' },
];

const SCOPE_LABELS = {
  ALL: { label: 'Toàn hệ thống', variant: 'indigo' },
  BUILDING: { label: 'Toàn Tòa nhà', variant: 'sky' },
  FLOOR: { label: 'Theo Tầng', variant: 'amber' },
  APARTMENT: { label: 'Theo Phòng', variant: 'purple' },
};

const ANNOUNCEMENT_STATUS_OPTIONS = Object.entries(ANNOUNCEMENT_STATUS).map(([value, meta]) => ({
  value,
  label: meta.label,
}));

function toLocalDateTimeInputValue(isoValue) {
  if (!isoValue) return '';
  const dt = new Date(isoValue);
  if (Number.isNaN(dt.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(
    dt.getHours()
  )}:${pad(dt.getMinutes())}`;
}

export function NotificationsPage() {
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const { canSendNotifications, canManageZaloGroups, canDeleteZaloGroups } = usePermission();
  const user = useAuthStore((s) => s.user);
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);
  const syncBellStore = useNotificationStore((s) => s.fetchNotifications);

  // 3 tabs: 'announcements' ("Thông báo & Xuất Zalo") | 'zalo_groups' ("Danh bạ Nhóm Zalo") | 'inbox' ("Hộp thư đến")
  const initialTab = ['announcements', 'zalo_groups', 'inbox'].includes(searchParams.get('tab'))
    ? searchParams.get('tab')
    : 'announcements';
  const [activeTab, setActiveTab] = useState(initialTab);

  useEffect(() => {
    const qTab = searchParams.get('tab');
    if (['announcements', 'zalo_groups', 'inbox'].includes(qTab)) {
      setActiveTab(qTab);
    }
  }, [searchParams]);

  const [announcements, setAnnouncements] = useState([]);
  const [zaloGroups, setZaloGroups] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch] = useState('');
  const [annStatusFilter, setAnnStatusFilter] = useState('');
  const [annScopeFilter, setAnnScopeFilter] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [zaloScopeFilter, setZaloScopeFilter] = useState('');
  const [includeInactiveGroups, setIncludeInactiveGroups] = useState(false);

  // Location options
  const [buildings, setBuildings] = useState([]);
  const [floors, setFloors] = useState([]);
  const [apartments, setApartments] = useState([]);

  // Announcement Compose / Edit Draft state (MANAGER only)
  const [editingAnnId, setEditingAnnId] = useState(null);
  const [savingAction, setSavingAction] = useState(''); // 'draft' | 'schedule' | 'send' | ''
  const [zaloManuallyEdited, setZaloManuallyEdited] = useState(false);
  const [form, setForm] = useState({
    target_scope: 'BUILDING',
    building_id: selectedBuildingId || '',
    floor_id: '',
    apartment_id: '',
    type: 'ANNOUNCEMENT',
    title: '',
    body: '',
    zalo_content: '',
    scheduled_at: '',
  });

  // 2-Step Confirmation Dialog before broadcasting (PRD 14.3)
  const [confirmSendModal, setConfirmSendModal] = useState(null); // { mode: 'compose' | 'existing', announcement?: row }

  // "Sao chép & Dán sang nhóm Zalo" Modal (FR-069)
  const [zaloCopyModal, setZaloCopyModal] = useState(null);
  const [checkedZaloGroupIds, setCheckedZaloGroupIds] = useState([]);
  const [zaloMarkNote, setZaloMarkNote] = useState('');
  const [copiedZaloBody, setCopiedZaloBody] = useState(false);
  const [markingZalo, setMarkingZalo] = useState(false);

  // Zalo Group Directory Create/Edit/Delete Modal (SYS_ADMIN + MANAGER)
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [groupApartments, setGroupApartments] = useState([]);
  const [groupSubmitting, setGroupSubmitting] = useState(false);
  const [groupLinkError, setGroupLinkError] = useState('');
  const [deleteGroupTarget, setDeleteGroupTarget] = useState(null);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [groupForm, setGroupForm] = useState({
    building_id: selectedBuildingId || '',
    scope: 'BUILDING',
    apartment_id: '',
    name: '',
    invite_link: '',
    note: '',
    is_active: true,
  });

  const fetchAllData = useCallback(async () => {
    setLoading(true);
    try {
      const [notifRes, annRes, zgRes] = await Promise.all([
        notificationsService.list(),
        announcementsService.listAnnouncements({
          building_id: selectedBuildingId || undefined,
          status: annStatusFilter || undefined,
          target_scope: annScopeFilter || undefined,
        }),
        announcementsService.listZaloGroups({
          building_id: selectedBuildingId || undefined,
          scope: zaloScopeFilter || undefined,
          include_inactive: includeInactiveGroups ? 'true' : undefined,
        }),
      ]);

      const currentUserId = user?.id || user?.sub || null;
      const mergedInbox = mergeOrgNotificationReadState(
        notifRes?.data || [],
        currentUserId,
        undefined,
        notifRes?.unread_count
      );
      setInbox(mergedInbox.notifications);
      setUnreadCount(mergedInbox.unreadCount);
      setAnnouncements(annRes?.data || []);
      setZaloGroups(zgRes?.data || []);
      syncBellStore();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải dữ liệu thông báo & nhóm Zalo.'));
    } finally {
      setLoading(false);
    }
  }, [
    selectedBuildingId,
    annStatusFilter,
    annScopeFilter,
    zaloScopeFilter,
    includeInactiveGroups,
    syncBellStore,
    toast,
  ]);

  useEffect(() => {
    fetchAllData();
  }, [fetchAllData]);

  // Load scoped buildings for filters & compose
  useEffect(() => {
    buildingsService
      .list()
      .then((res) => {
        const list = res.data || [];
        setBuildings(list);
        if (!form.building_id && (selectedBuildingId || list[0]?.id)) {
          setForm((prev) => ({
            ...prev,
            building_id: selectedBuildingId || list[0]?.id || '',
          }));
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync TopBar selectedBuildingId
  useEffect(() => {
    if (selectedBuildingId) {
      setForm((prev) => ({
        ...prev,
        building_id: selectedBuildingId,
        floor_id: '',
        apartment_id: '',
      }));
    }
  }, [selectedBuildingId]);

  // Load floors / apartments when composing
  useEffect(() => {
    if (!canSendNotifications || !form.building_id) {
      setFloors([]);
      setApartments([]);
      return;
    }
    if (form.target_scope === 'FLOOR') {
      buildingsService
        .listFloors(form.building_id)
        .then((res) => setFloors(res.data || []))
        .catch(() => setFloors([]));
    }
    if (form.target_scope === 'APARTMENT') {
      buildingsService
        .listApartments({ building_id: form.building_id })
        .then((res) => setApartments(res.data || []))
        .catch(() => setApartments([]));
    }
  }, [canSendNotifications, form.building_id, form.target_scope]);

  // Load apartments for Zalo Group modal when scope = APARTMENT
  useEffect(() => {
    if (!groupModalOpen || !groupForm.building_id || groupForm.scope !== 'APARTMENT') {
      setGroupApartments([]);
      return;
    }
    buildingsService
      .listApartments({ building_id: groupForm.building_id })
      .then((res) => setGroupApartments(res.data || []))
      .catch(() => setGroupApartments([]));
  }, [groupModalOpen, groupForm.building_id, groupForm.scope]);

  // Selected labels for live Zalo preview
  const selectedBuildingObj = useMemo(
    () => buildings.find((b) => b.id === form.building_id) || null,
    [buildings, form.building_id]
  );
  const selectedFloorObj = useMemo(
    () => floors.find((f) => f.id === form.floor_id) || null,
    [floors, form.floor_id]
  );
  const selectedApartmentObj = useMemo(
    () => apartments.find((a) => a.id === form.apartment_id) || null,
    [apartments, form.apartment_id]
  );

  const autoZaloPreview = useMemo(
    () =>
      buildZaloPreviewText({
        type: form.type,
        title: form.title,
        body: form.body,
        targetScope: form.target_scope,
        buildingCode: selectedBuildingObj?.code || '',
        buildingName: selectedBuildingObj?.name || '',
        floorName: selectedFloorObj?.name || '',
        apartmentCode: selectedApartmentObj?.code || '',
        scheduledOrSentAt: form.scheduled_at ? new Date(form.scheduled_at) : null,
      }),
    [
      form.type,
      form.title,
      form.body,
      form.target_scope,
      form.scheduled_at,
      selectedBuildingObj,
      selectedFloorObj,
      selectedApartmentObj,
    ]
  );

  useEffect(() => {
    if (!zaloManuallyEdited) {
      setForm((prev) =>
        prev.zalo_content === autoZaloPreview ? prev : { ...prev, zalo_content: autoZaloPreview }
      );
    }
  }, [autoZaloPreview, zaloManuallyEdited]);

  const resetComposeForm = useCallback(() => {
    setEditingAnnId(null);
    setZaloManuallyEdited(false);
    setForm((prev) => ({
      target_scope: 'BUILDING',
      building_id: selectedBuildingId || prev.building_id || buildings[0]?.id || '',
      floor_id: '',
      apartment_id: '',
      type: 'ANNOUNCEMENT',
      title: '',
      body: '',
      zalo_content: '',
      scheduled_at: '',
    }));
  }, [buildings, selectedBuildingId]);

  const handleApplyQuickTemplate = (tpl) => {
    setZaloManuallyEdited(false);
    setForm((prev) => ({
      ...prev,
      type: tpl.type,
      title: tpl.defaultTitle,
      body: tpl.bodyTemplate,
    }));
  };

  const validateComposeFields = () => {
    if (!form.building_id) {
      toast.warning('Vui lòng chọn tòa nhà áp dụng thông báo.');
      return false;
    }
    if (form.target_scope === 'FLOOR' && !form.floor_id) {
      toast.warning('Vui lòng chọn tầng nhận thông báo.');
      return false;
    }
    if (form.target_scope === 'APARTMENT' && !form.apartment_id) {
      toast.warning('Vui lòng chọn căn hộ nhận thông báo.');
      return false;
    }
    if (!form.title.trim() || !form.body.trim()) {
      toast.warning('Vui lòng nhập đầy đủ tiêu đề và nội dung bản tin.');
      return false;
    }
    return true;
  };

  const buildAnnouncementPayload = ({ scheduledIso = null } = {}) => ({
    building_id: form.building_id,
    target_scope: form.target_scope,
    floor_id: form.target_scope === 'FLOOR' ? form.floor_id : null,
    apartment_id: form.target_scope === 'APARTMENT' ? form.apartment_id : null,
    type: form.type,
    title: form.title.trim(),
    body: form.body.trim(),
    zalo_content: (form.zalo_content || autoZaloPreview).trim(),
    scheduled_at: scheduledIso,
  });

  const handleSaveDraft = async () => {
    if (!validateComposeFields()) return;
    setSavingAction('draft');
    try {
      const payload = buildAnnouncementPayload({ scheduledIso: null });
      if (editingAnnId) {
        await announcementsService.updateAnnouncement(editingAnnId, {
          ...payload,
          status: 'DRAFT',
        });
        toast.success('Đã cập nhật bản nháp thông báo.');
      } else {
        await announcementsService.createAnnouncement(payload);
        toast.success('Đã lưu bản nháp thông báo.');
      }
      resetComposeForm();
      await fetchAllData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu bản nháp thông báo.'));
    } finally {
      setSavingAction('');
    }
  };

  const handleSaveScheduled = async () => {
    if (!validateComposeFields()) return;
    if (!form.scheduled_at) {
      toast.warning('Vui lòng chọn thời điểm hẹn giờ phát hành.');
      return;
    }
    const schedDt = new Date(form.scheduled_at);
    if (Number.isNaN(schedDt.getTime()) || schedDt.getTime() <= Date.now()) {
      toast.warning('Thời điểm hẹn giờ gửi phải nằm trong tương lai.');
      return;
    }

    setSavingAction('schedule');
    try {
      const payload = buildAnnouncementPayload({ scheduledIso: schedDt.toISOString() });
      if (editingAnnId) {
        await announcementsService.updateAnnouncement(editingAnnId, {
          ...payload,
          status: 'SCHEDULED',
        });
        toast.success('Đã cập nhật lịch hẹn giờ phát hành thông báo.');
      } else {
        await announcementsService.createAnnouncement(payload);
        toast.success('Đã lên lịch hẹn giờ phát hành thông báo.');
      }
      resetComposeForm();
      await fetchAllData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể hẹn giờ thông báo.'));
    } finally {
      setSavingAction('');
    }
  };

  const handleRequestImmediateSend = (e) => {
    e.preventDefault();
    if (!validateComposeFields()) return;
    setConfirmSendModal({ mode: 'compose' });
  };

  const openZaloModalForAnnouncement = (ann) => {
    setZaloCopyModal(ann);
    setCopiedZaloBody(false);
    setZaloMarkNote('');
    const existingGroupIds = Array.isArray(ann?.manual_sent_groups)
      ? ann.manual_sent_groups.map((g) => (typeof g === 'string' ? g : g.id)).filter(Boolean)
      : [];
    const defaultIds =
      existingGroupIds.length > 0
        ? existingGroupIds
        : (ann?.target_zalo_groups || []).map((g) => g.id);
    setCheckedZaloGroupIds(defaultIds);
  };

  const handleConfirm2StepSend = async () => {
    if (!confirmSendModal) return;
    setSavingAction('send');
    try {
      let targetId = confirmSendModal.announcement?.id || editingAnnId;
      if (confirmSendModal.mode === 'compose') {
        const payload = buildAnnouncementPayload({ scheduledIso: null });
        if (targetId) {
          await announcementsService.updateAnnouncement(targetId, payload);
        } else {
          const createdRes = await announcementsService.createAnnouncement(payload);
          targetId = createdRes?.data?.id;
        }
      }

      const sentRes = await announcementsService.sendAnnouncement(targetId, {
        confirm_send: true,
      });
      toast.success(
        sentRes?.message ||
          `Đã phát hành thông báo tới ${sentRes?.data?.recipient_count ?? 0} tài khoản cư dân!`
      );
      setConfirmSendModal(null);
      if (confirmSendModal.mode === 'compose') {
        resetComposeForm();
      }
      await fetchAllData();
      if (sentRes?.data) {
        openZaloModalForAnnouncement(sentRes.data);
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể phát hành thông báo.'));
    } finally {
      setSavingAction('');
    }
  };

  const handleEditDraftRow = (ann) => {
    setEditingAnnId(ann.id);
    setZaloManuallyEdited(true);
    setForm({
      target_scope: ann.target_scope || 'BUILDING',
      building_id: ann.building_id || '',
      floor_id: ann.floor_id || '',
      apartment_id: ann.apartment_id || '',
      type: ann.type || 'ANNOUNCEMENT',
      title: ann.title || '',
      body: ann.body || '',
      zalo_content: ann.zalo_content || '',
      scheduled_at: toLocalDateTimeInputValue(ann.scheduled_at),
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCancelAnnouncement = async (ann) => {
    try {
      await announcementsService.updateAnnouncement(ann.id, { status: 'CANCELLED' });
      toast.success('Đã hủy bản tin thông báo.');
      if (editingAnnId === ann.id) resetComposeForm();
      await fetchAllData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể hủy bản tin.'));
    }
  };

  const handleCopyZaloContent = async () => {
    if (!zaloCopyModal?.zalo_content) return;
    const ok = await copyZaloMessageToClipboard(zaloCopyModal.zalo_content);
    if (ok) {
      setCopiedZaloBody(true);
      setTimeout(() => setCopiedZaloBody(false), 2500);
      toast.success('Đã sao chép nội dung chuẩn Zalo (kèm chữ in đậm cho Zalo PC/Web)!');
    } else {
      toast.error('Không thể sao chép tự động, vui lòng bôi đen văn bản để sao chép.');
    }
  };

  const handleMarkZaloSentSubmit = async () => {
    if (!zaloCopyModal) return;
    setMarkingZalo(true);
    try {
      const res = await announcementsService.markZaloSent(zaloCopyModal.id, {
        zalo_group_ids: checkedZaloGroupIds,
        note: zaloMarkNote.trim() || undefined,
      });
      toast.success(res?.message || 'Đã ghi nhận trạng thái dán thông báo lên nhóm Zalo.');
      setZaloCopyModal(res?.data || null);
      await fetchAllData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật trạng thái gửi Zalo.'));
    } finally {
      setMarkingZalo(false);
    }
  };

  // Zalo Group Directory handlers
  const openCreateGroupModal = () => {
    setEditingGroup(null);
    setGroupLinkError('');
    setGroupForm({
      building_id: selectedBuildingId || buildings[0]?.id || '',
      scope: 'BUILDING',
      apartment_id: '',
      name: '',
      invite_link: '',
      note: '',
      is_active: true,
    });
    setGroupModalOpen(true);
  };

  const openEditGroupModal = (grp) => {
    setEditingGroup(grp);
    setGroupLinkError('');
    setGroupForm({
      building_id: grp.building_id || '',
      scope: grp.scope || 'BUILDING',
      apartment_id: grp.apartment_id || '',
      name: grp.name || '',
      invite_link: grp.invite_link || '',
      note: grp.note || '',
      is_active: Boolean(grp.is_active),
    });
    setGroupModalOpen(true);
  };

  const handleSubmitGroup = async (e) => {
    e.preventDefault();
    if (!groupForm.building_id || !groupForm.name.trim()) {
      toast.warning('Vui lòng chọn tòa nhà và nhập tên nhóm Zalo.');
      return;
    }
    if (groupForm.scope === 'APARTMENT' && !groupForm.apartment_id) {
      toast.warning('Vui lòng chọn căn hộ cho nhóm Zalo phạm vi Phòng.');
      return;
    }
    if (groupForm.invite_link.trim() && !isValidZaloGroupUrl(groupForm.invite_link)) {
      setGroupLinkError(
        'Đường dẫn nhóm Zalo phải bắt đầu bằng https://zalo.me/ hoặc https://chat.zalo.me/'
      );
      return;
    }

    setGroupSubmitting(true);
    try {
      const payload = {
        building_id: groupForm.building_id,
        scope: groupForm.scope,
        apartment_id: groupForm.scope === 'APARTMENT' ? groupForm.apartment_id : null,
        name: groupForm.name.trim(),
        invite_link: groupForm.invite_link.trim() || null,
        note: groupForm.note.trim() || null,
        is_active: Boolean(groupForm.is_active),
      };

      if (editingGroup) {
        await announcementsService.updateZaloGroup(editingGroup.id, payload);
        toast.success('Đã cập nhật thông tin nhóm Zalo.');
      } else {
        await announcementsService.createZaloGroup(payload);
        toast.success('Đã thêm nhóm Zalo vào danh bạ.');
      }
      setGroupModalOpen(false);
      await fetchAllData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu thông tin nhóm Zalo.'));
    } finally {
      setGroupSubmitting(false);
    }
  };

  const handleConfirmDeleteGroup = async () => {
    if (!deleteGroupTarget?.id) return;
    setDeletingGroup(true);
    try {
      const res = await announcementsService.deleteZaloGroup(deleteGroupTarget.id);
      toast.success(res?.message || `Đã xóa nhóm Zalo "${deleteGroupTarget.name}".`);
      setDeleteGroupTarget(null);
      await fetchAllData();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể xóa nhóm Zalo.'));
    } finally {
      setDeletingGroup(false);
    }
  };

  // Inbox handlers
  const markInboxItemReadLocal = useCallback((item) => {
    if (!item || item.read_at) return;
    setInbox((prev) =>
      prev.map((n) => (n.id === item.id ? { ...n, read_at: new Date().toISOString() } : n))
    );
    setUnreadCount((c) => Math.max(0, c - 1));
  }, []);

  const {
    handleNotificationClick: handleInboxItemAction,
    getActionMeta,
    detailModalProps,
  } = useNotificationAction({ onMarkReadLocal: markInboxItemReadLocal });

  const handleMarkAllRead = async () => {
    try {
      await useNotificationStore.getState().markAllAsRead(inbox);
      const now = new Date().toISOString();
      setInbox((prev) => prev.map((n) => ({ ...n, read_at: n.read_at || now })));
      setUnreadCount(0);
      syncBellStore();
      toast.success('Đã đánh dấu đọc tất cả thông báo.');
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật trạng thái đã đọc.'));
    }
  };

  const filteredAnnouncements = useMemo(() => {
    return announcements.filter((a) => {
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return (
          a.title?.toLowerCase().includes(q) ||
          a.body?.toLowerCase().includes(q) ||
          a.building_code?.toLowerCase().includes(q) ||
          a.apartment_code?.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [announcements, search]);

  const filteredZaloGroups = useMemo(() => {
    return zaloGroups.filter((g) => {
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return (
          g.name?.toLowerCase().includes(q) ||
          g.building_code?.toLowerCase().includes(q) ||
          g.apartment_code?.toLowerCase().includes(q) ||
          g.note?.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [zaloGroups, search]);

  const filteredInbox = useMemo(() => {
    return inbox.filter((n) => {
      if (unreadOnly && n.read_at) return false;
      if (
        selectedBuildingId &&
        n.payload?.building_id &&
        n.payload.building_id !== selectedBuildingId
      ) {
        return false;
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return n.title?.toLowerCase().includes(q) || n.content?.toLowerCase().includes(q);
      }
      return true;
    });
  }, [inbox, unreadOnly, selectedBuildingId, search]);

  const confirmSummary = useMemo(() => {
    if (!confirmSendModal) return null;
    if (confirmSendModal.mode === 'existing' && confirmSendModal.announcement) {
      const a = confirmSendModal.announcement;
      return {
        title: a.title,
        scopeLabel: SCOPE_LABELS[a.target_scope]?.label || a.target_scope,
        targetDetail: `${a.building_code || ''} — ${a.building_name || ''}${
          a.floor_name ? ` • ${a.floor_name}` : ''
        }${a.apartment_code ? ` • Căn ${a.apartment_code}` : ''}`,
      };
    }
    return {
      title: form.title,
      scopeLabel: SCOPE_LABELS[form.target_scope]?.label || form.target_scope,
      targetDetail: `${selectedBuildingObj ? `${selectedBuildingObj.code} — ${selectedBuildingObj.name}` : ''}${
        selectedFloorObj ? ` • ${selectedFloorObj.name}` : ''
      }${selectedApartmentObj ? ` • Căn ${selectedApartmentObj.code}` : ''}`,
    };
  }, [
    confirmSendModal,
    form.title,
    form.target_scope,
    selectedBuildingObj,
    selectedFloorObj,
    selectedApartmentObj,
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trung tâm Thông báo & Đồng bộ Nhóm Zalo"
        subtitle="Soạn bản tin chuẩn hóa theo Tòa nhà / Tầng / Phòng, theo dõi lượt đọc của cư dân và sao chép 1 chạm sang nhóm Zalo vận hành."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {unreadCount > 0 ? (
              <Button variant="outline" icon={CheckCheck} onClick={handleMarkAllRead}>
                Đọc tất cả ({unreadCount})
              </Button>
            ) : null}
            <Button variant="outline" icon={RefreshCw} onClick={fetchAllData}>
              Làm mới
            </Button>
          </div>
        }
      />

      {/* Top Navigation Tabs */}
      <Card padding={false} className="overflow-hidden">
        <div className="px-5 pt-3">
          <Tabs
            activeTab={activeTab}
            onChange={setActiveTab}
            tabs={[
              {
                id: 'announcements',
                label: 'Thông báo & Xuất Zalo',
                icon: BellRing,
                count: filteredAnnouncements.length,
              },
              {
                id: 'zalo_groups',
                label: 'Danh bạ Nhóm Zalo',
                icon: MessageSquare,
                count: filteredZaloGroups.length,
              },
              {
                id: 'inbox',
                label: 'Hộp thư đến',
                icon: Inbox,
                count: unreadCount > 0 ? `${unreadCount} mới` : filteredInbox.length,
              },
            ]}
          />
        </div>
      </Card>

      {/* TAB 1: THÔNG BÁO & XUẤT ZALO */}
      {activeTab === 'announcements' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* CỘT TRÁI: SOẠN BẢN TIN & XEM TRƯỚC ZALO (Chỉ hiển thị cho MANAGER) */}
          {canSendNotifications ? (
            <Card className="lg:col-span-5 space-y-4">
              <CardHeader
                title={editingAnnId ? 'Chỉnh sửa bản tin nháp / hẹn giờ' : 'Soạn bản tin mới'}
                subtitle="Chọn mẫu nhanh, kiểm tra bản xem trước Zalo và xác nhận trước khi phát hành."
              />

              {/* Mẫu nhanh Zalo */}
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-slate-600">
                  Mẫu thông báo nhanh (1 chạm điền sẵn)
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {ZALO_QUICK_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.key}
                      type="button"
                      onClick={() => handleApplyQuickTemplate(tpl)}
                      className="px-2.5 py-1 rounded-lg text-xs font-medium bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-200 transition-colors"
                    >
                      {tpl.label}
                    </button>
                  ))}
                </div>
              </div>

              <form onSubmit={handleRequestImmediateSend} className="space-y-3.5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Select
                    label="Phạm vi người nhận"
                    required
                    value={form.target_scope}
                    onChange={(e) =>
                      setForm((s) => ({
                        ...s,
                        target_scope: e.target.value,
                        floor_id: '',
                        apartment_id: '',
                      }))
                    }
                    options={SCOPE_OPTIONS}
                  />

                  <Select
                    label="Tòa nhà áp dụng"
                    required
                    value={form.building_id}
                    onChange={(e) =>
                      setForm((s) => ({
                        ...s,
                        building_id: e.target.value,
                        floor_id: '',
                        apartment_id: '',
                      }))
                    }
                    placeholder="-- Chọn tòa nhà --"
                    options={buildings.map((b) => ({
                      value: b.id,
                      label: `${b.code} — ${b.name}`,
                    }))}
                  />
                </div>

                {form.target_scope === 'FLOOR' ? (
                  <Select
                    label="Chọn Tầng nhận thông báo"
                    required
                    value={form.floor_id}
                    onChange={(e) => setForm((s) => ({ ...s, floor_id: e.target.value }))}
                    placeholder="-- Chọn tầng cụ thể --"
                    options={floors.map((f) => {
                      const num = f.floor_number ?? f.level;
                      return {
                        value: f.id,
                        label: num != null ? `${f.name} (Tầng ${num})` : f.name,
                      };
                    })}
                  />
                ) : null}

                {form.target_scope === 'APARTMENT' ? (
                  <Select
                    label="Chọn Căn hộ nhận thông báo"
                    required
                    value={form.apartment_id}
                    onChange={(e) => setForm((s) => ({ ...s, apartment_id: e.target.value }))}
                    placeholder="-- Chọn căn hộ cụ thể --"
                    options={apartments.map((a) => ({
                      value: a.id,
                      label: `Căn ${a.code} (${APARTMENT_STATUS[a.status]?.label || a.status})`,
                    }))}
                  />
                ) : null}

                <Select
                  label="Phân loại bản tin"
                  required
                  value={form.type}
                  onChange={(e) => setForm((s) => ({ ...s, type: e.target.value }))}
                  options={COMPOSE_TYPE_OPTIONS}
                />

                <Input
                  label="Tiêu đề thông báo"
                  required
                  placeholder="VD: Thông báo tạm ngừng cấp nước bảo trì bể ngầm..."
                  value={form.title}
                  onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))}
                />

                <Input
                  label="Nội dung chi tiết trên Cổng cư dân"
                  required
                  multiline
                  rows={4}
                  placeholder="Nhập thời gian áp dụng, khu vực ảnh hưởng và đầu mối liên hệ..."
                  value={form.body}
                  onChange={(e) => setForm((s) => ({ ...s, body: e.target.value }))}
                />

                {/* Live Editable Zalo Preview */}
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-800">
                      Xem trước nội dung chuẩn Zalo (có thể chỉnh sửa)
                    </span>
                    {zaloManuallyEdited ? (
                      <button
                        type="button"
                        onClick={() => setZaloManuallyEdited(false)}
                        className="text-[11px] text-primary-600 hover:underline font-medium"
                      >
                        Khôi phục mẫu tự động
                      </button>
                    ) : null}
                  </div>
                  <Input
                    multiline
                    rows={6}
                    value={form.zalo_content}
                    onChange={(e) => {
                      setZaloManuallyEdited(true);
                      setForm((s) => ({ ...s, zalo_content: e.target.value }));
                    }}
                  />
                  <p className="text-[11px] text-slate-500">
                    Mẹo: Bọc <code className="px-1 py-0.5 rounded bg-slate-200/80 text-slate-700">**nội dung**</code> quanh các thông tin quan trọng để tự động <strong>in đậm</strong> khi dán sang Zalo PC/Web.
                  </p>
                  {form.zalo_content ? (
                    <div className="p-2.5 rounded-lg bg-white border border-slate-200/90 text-xs text-slate-700 whitespace-pre-wrap leading-relaxed max-h-44 overflow-y-auto">
                      {parseZaloBoldSegments(form.zalo_content).map((seg, idx) =>
                        seg.bold ? (
                          <strong key={idx} className="font-bold text-slate-950">
                            {seg.text}
                          </strong>
                        ) : (
                          <span key={idx}>{seg.text}</span>
                        )
                      )}
                    </div>
                  ) : null}
                </div>

                {/* Hẹn giờ gửi */}
                <Input
                  type="datetime-local"
                  label="Thời điểm hẹn giờ gửi (chỉ bắt buộc khi chọn Hẹn giờ)"
                  value={form.scheduled_at}
                  onChange={(e) => setForm((s) => ({ ...s, scheduled_at: e.target.value }))}
                />

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    loading={savingAction === 'draft'}
                    disabled={Boolean(savingAction)}
                    onClick={handleSaveDraft}
                  >
                    Lưu nháp
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    icon={Clock}
                    loading={savingAction === 'schedule'}
                    disabled={Boolean(savingAction)}
                    onClick={handleSaveScheduled}
                  >
                    Hẹn giờ gửi
                  </Button>
                </div>

                <Button
                  type="submit"
                  variant="primary"
                  className="w-full"
                  icon={Send}
                  loading={savingAction === 'send'}
                  disabled={Boolean(savingAction)}
                >
                  Phát hành thông báo ngay
                </Button>

                {editingAnnId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="w-full"
                    onClick={resetComposeForm}
                  >
                    Hủy chế độ chỉnh sửa
                  </Button>
                ) : null}
              </form>
            </Card>
          ) : null}

          {/* CỘT PHẢI: DANH SÁCH BẢN TIN, TỶ LỆ ĐỌC & TRẠNG THÁI DÁN ZALO */}
          <div
            className={`${
              canSendNotifications ? 'lg:col-span-7' : 'lg:col-span-12'
            } space-y-4`}
          >
            <Card padding={false} className="overflow-hidden">
              <div
                className={`p-4 border-b border-slate-100 bg-slate-50/50 grid grid-cols-1 sm:grid-cols-2 ${
                  canSendNotifications ? '' : 'xl:grid-cols-12'
                } gap-3`}
              >
                <div className={canSendNotifications ? 'sm:col-span-2' : 'sm:col-span-2 xl:col-span-6'}>
                  <SearchBar
                    value={search}
                    onChange={setSearch}
                    placeholder="Tìm tiêu đề, tòa, căn hộ..."
                  />
                </div>
                <Select
                  containerClassName={canSendNotifications ? '' : 'xl:col-span-3'}
                  value={annStatusFilter}
                  onChange={(e) => setAnnStatusFilter(e.target.value)}
                  placeholder="Tất cả trạng thái"
                  options={ANNOUNCEMENT_STATUS_OPTIONS}
                />
                <Select
                  containerClassName={canSendNotifications ? '' : 'xl:col-span-3'}
                  value={annScopeFilter}
                  onChange={(e) => setAnnScopeFilter(e.target.value)}
                  placeholder="Tất cả phạm vi"
                  options={SCOPE_OPTIONS}
                />
              </div>

              {loading ? (
                <div className="p-10 text-center text-sm text-slate-400">
                  Đang tải danh sách thông báo...
                </div>
              ) : filteredAnnouncements.length === 0 ? (
                <EmptyState
                  icon={BellRing}
                  title="Chưa có bản tin thông báo nào"
                  description="Các bản tin nháp, hẹn giờ hoặc đã phát hành cùng lịch sử sao chép Zalo sẽ hiển thị tại đây."
                />
              ) : (
                <div className="divide-y divide-slate-100 max-h-[720px] overflow-y-auto">
                  {filteredAnnouncements.map((ann) => {
                    const typeInfo = NOTIFICATION_TYPES[ann.type] || {
                      label: ann.type || 'Thông báo',
                      variant: 'sky',
                    };
                    const scopeMeta = SCOPE_LABELS[ann.target_scope] || SCOPE_LABELS.BUILDING;

                    return (
                      <div key={ann.id} className="p-4 sm:px-5 space-y-2.5 hover:bg-slate-50/70">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusBadge status={ann.status} domain="announcement" />
                            <Badge variant={scopeMeta.variant}>{scopeMeta.label}</Badge>
                            <Badge variant={typeInfo.variant}>{typeInfo.label}</Badge>

                            {ann.status === 'SENT' ? (
                              <Badge variant="slate">
                                Đã đọc: {ann.read_count || 0}/{ann.recipient_count || 0} cư dân
                              </Badge>
                            ) : null}

                            {ann.manual_sent_at ? (
                              <Badge variant="emerald">
                                Đã dán Zalo • {formatDateTime(ann.manual_sent_at)}
                              </Badge>
                            ) : (
                              <Badge variant="amber">Chưa dán Zalo</Badge>
                            )}
                          </div>

                          <span className="text-[11px] text-slate-400">
                            {ann.sent_at
                              ? `Phát hành: ${formatDateTime(ann.sent_at)}`
                              : ann.scheduled_at
                              ? `Hẹn gửi: ${formatDateTime(ann.scheduled_at)}`
                              : formatDateTime(ann.created_at)}
                          </span>
                        </div>

                        <div className="space-y-1">
                          <p className="text-xs font-medium text-slate-500 flex items-center gap-1 flex-wrap">
                            <Building2 className="w-3.5 h-3.5 text-primary-500 shrink-0" />
                            <span>
                              {ann.building_code} — {ann.building_name}
                              {ann.floor_name ? ` • ${ann.floor_name}` : ''}
                              {ann.apartment_code ? ` • Căn ${ann.apartment_code}` : ''}
                            </span>
                          </p>
                          <h4 className="text-sm font-bold text-slate-900 break-words">
                            {ann.title}
                          </h4>
                          <p className="text-xs text-slate-600 whitespace-pre-line leading-relaxed break-words">
                            {ann.body}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                          <span className="text-[11px] text-slate-400">
                            {ann.created_by_name
                              ? `Tạo bởi: ${ann.created_by_name}`
                              : 'Ban Quản Lý'}
                            {ann.manual_sent_by_name
                              ? ` • Xác nhận Zalo: ${ann.manual_sent_by_name}`
                              : ''}
                          </span>

                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="xs"
                              variant="secondary"
                              icon={Copy}
                              onClick={() => openZaloModalForAnnouncement(ann)}
                            >
                              {canSendNotifications ? 'Sao chép dán Zalo' : 'Xem nội dung Zalo'}
                            </Button>

                            {canSendNotifications &&
                            ['DRAFT', 'SCHEDULED'].includes(ann.status) ? (
                              <>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  onClick={() => handleEditDraftRow(ann)}
                                >
                                  Chỉnh sửa
                                </Button>
                                <Button
                                  size="xs"
                                  variant="primary"
                                  icon={Send}
                                  onClick={() =>
                                    setConfirmSendModal({
                                      mode: 'existing',
                                      announcement: ann,
                                    })
                                  }
                                >
                                  Phát hành
                                </Button>
                                <Button
                                  size="xs"
                                  variant="danger"
                                  icon={XCircle}
                                  onClick={() => handleCancelAnnouncement(ann)}
                                >
                                  Hủy
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        </div>
      ) : null}

      {/* TAB 2: DANH BẠ NHÓM ZALO (zalo_group) */}
      {activeTab === 'zalo_groups' ? (
        <Card padding={false} className="overflow-hidden">
          <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[240px]">
              <div className="flex-1 min-w-[200px]">
                <SearchBar
                  value={search}
                  onChange={setSearch}
                  placeholder="Tìm tên nhóm Zalo, mã tòa, mã phòng..."
                />
              </div>
              <div className="w-52">
                <Select
                  value={zaloScopeFilter}
                  onChange={(e) => setZaloScopeFilter(e.target.value)}
                  placeholder="Tất cả loại nhóm"
                  options={[
                    { value: 'BUILDING', label: 'Nhóm chung Tòa nhà' },
                    { value: 'APARTMENT', label: 'Nhóm riêng từng Phòng' },
                  ]}
                />
              </div>
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeInactiveGroups}
                  onChange={(e) => setIncludeInactiveGroups(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                />
                <span>Hiện cả nhóm ngưng hoạt động</span>
              </label>
            </div>

            {canManageZaloGroups ? (
              <Button variant="primary" size="sm" icon={Plus} onClick={openCreateGroupModal}>
                Thêm nhóm Zalo
              </Button>
            ) : null}
          </div>

          {loading ? (
            <div className="p-10 text-center text-sm text-slate-400">
              Đang tải danh bạ nhóm Zalo...
            </div>
          ) : filteredZaloGroups.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="Chưa cấu hình nhóm Zalo vận hành"
              description="Lưu danh sách link nhóm Zalo Tòa nhà (1 nhóm chung) và nhóm Zalo từng Phòng (Cư dân + BQL) để mở nhanh khi dán thông báo hoặc cập nhật sửa chữa."
              action={
                canManageZaloGroups ? (
                  <Button size="sm" icon={Plus} onClick={openCreateGroupModal}>
                    Thêm nhóm Zalo đầu tiên
                  </Button>
                ) : null
              }
            />
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredZaloGroups.map((grp) => (
                <div
                  key={grp.id}
                  className="p-4 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/70"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={grp.scope === 'APARTMENT' ? 'purple' : 'sky'}>
                        {grp.scope === 'APARTMENT'
                          ? `Nhóm Phòng ${grp.apartment_code || ''}`
                          : 'Nhóm chung Tòa nhà'}
                      </Badge>
                      <Badge variant={grp.is_active ? 'emerald' : 'slate'}>
                        {grp.is_active ? 'Đang hoạt động' : 'Ngưng hoạt động'}
                      </Badge>
                      <span className="text-xs text-slate-500">
                        {grp.building_code} — {grp.building_name}
                      </span>
                    </div>
                    <h4 className="text-sm font-bold text-slate-900 break-words">{grp.name}</h4>
                    {grp.note ? (
                      <p className="text-xs text-slate-500 break-words">{grp.note}</p>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {grp.invite_link ? (
                      <a
                        href={grp.invite_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Mở nhóm Zalo</span>
                      </a>
                    ) : (
                      <span className="text-xs text-slate-400 italic">Chưa gắn link zalo.me</span>
                    )}

                    {canManageZaloGroups ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => openEditGroupModal(grp)}
                      >
                        Chỉnh sửa
                      </Button>
                    ) : null}
                    {canDeleteZaloGroups ? (
                      <Button
                        size="xs"
                        variant="outline"
                        icon={Trash2}
                        className="border-rose-200 text-rose-600 hover:bg-rose-50 hover:border-rose-300"
                        onClick={() => setDeleteGroupTarget(grp)}
                      >
                        Xóa
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}

      {/* TAB 3: HỘP THƯ ĐẾN */}
      {activeTab === 'inbox' ? (
        <Card padding={false} className="overflow-hidden">
          <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex flex-wrap items-center justify-between gap-3">
            <div className="flex-1 min-w-[220px]">
              <SearchBar
                value={search}
                onChange={setSearch}
                placeholder="Tìm tiêu đề hoặc nội dung hộp thư..."
              />
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(e) => setUnreadOnly(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
              />
              <span>Chỉ hiện chưa đọc</span>
            </label>
          </div>

          {loading ? (
            <div className="p-10 text-center text-sm text-slate-400">
              Đang tải hộp thư đến...
            </div>
          ) : filteredInbox.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="Hộp thư đến trống"
              description="Bạn đã đọc hết các thông báo hoặc chưa có thông báo hệ thống mới."
            />
          ) : (
            <div className="divide-y divide-slate-100 max-h-[680px] overflow-y-auto">
              {filteredInbox.map((item) => {
                const typeInfo = NOTIFICATION_TYPES[item.type] || {
                  label: item.type || 'Hệ thống',
                  variant: 'slate',
                };
                const isUnread = !item.read_at;
                const actionMeta = getActionMeta(item);
                return (
                  <div
                    key={item.id}
                    onClick={() => handleInboxItemAction(item)}
                    className={`p-4 sm:px-5 transition-colors cursor-pointer hover:bg-slate-50 flex items-start gap-3.5 ${
                      isUnread ? 'bg-primary-50/35' : ''
                    }`}
                  >
                    <div
                      className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${
                        isUnread ? 'bg-primary-500' : 'bg-slate-200'
                      }`}
                    />
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant={typeInfo.variant}>{typeInfo.label}</Badge>
                          {isUnread ? <Badge variant="sky">Mới</Badge> : null}
                        </div>
                        <span className="text-[11px] text-slate-400">
                          {formatRelativeTime(item.created_at)} •{' '}
                          {formatDateTime(item.created_at)}
                        </span>
                      </div>
                      <h4
                        className={`text-sm break-words ${
                          isUnread ? 'font-bold text-slate-900' : 'font-semibold text-slate-800'
                        }`}
                      >
                        {item.title}
                      </h4>
                      <p className="text-xs text-slate-600 whitespace-pre-line leading-relaxed break-words">
                        {item.content}
                      </p>
                      <div className="pt-1 flex justify-end">
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary-600">
                          {actionMeta.actionLabel}
                          <ArrowRight className="w-3.5 h-3.5" />
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      ) : null}

      {/* Modal Xác nhận 2 bước trước khi phát hành thông báo (PRD 14.3) */}
      <Modal
        open={Boolean(confirmSendModal)}
        onClose={() => setConfirmSendModal(null)}
        title="Xác nhận phát hành bản tin tới Cư dân (Bước 2/2)"
        subtitle="Kiểm tra kỹ phạm vi đối tượng nhận trước khi gửi đồng loạt lên Cổng cư dân."
        size="md"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setConfirmSendModal(null)}
              disabled={savingAction === 'send'}
            >
              Quay lại kiểm tra
            </Button>
            <Button
              variant="primary"
              icon={Send}
              loading={savingAction === 'send'}
              onClick={handleConfirm2StepSend}
            >
              Xác nhận & Phát hành ngay
            </Button>
          </>
        }
      >
        {confirmSummary ? (
          <div className="space-y-3 text-xs">
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                Hệ thống sẽ gửi thông báo trực tiếp tới tất cả người đứng tên hợp đồng và người ở cùng đang hiệu lực trong phạm vi dưới đây. Sau khi gửi không thể thu hồi.
              </p>
            </div>
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
              <p>
                <span className="text-slate-500">Phạm vi nhận:</span>{' '}
                <strong className="text-slate-900">{confirmSummary.scopeLabel}</strong>
              </p>
              <p>
                <span className="text-slate-500">Khu vực áp dụng:</span>{' '}
                <strong className="text-slate-900">{confirmSummary.targetDetail}</strong>
              </p>
              <p className="break-words">
                <span className="text-slate-500">Tiêu đề:</span>{' '}
                <strong className="text-slate-900">{confirmSummary.title}</strong>
              </p>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Modal Sao chép & Dán sang nhóm Zalo (FR-069) */}
      <Modal
        open={Boolean(zaloCopyModal)}
        onClose={() => setZaloCopyModal(null)}
        title="Sao chép & Dán sang nhóm Zalo vận hành"
        subtitle={zaloCopyModal ? zaloCopyModal.title : ''}
        size="lg"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2 w-full">
            <Button variant="outline" onClick={() => setZaloCopyModal(null)}>
              Đóng
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                icon={copiedZaloBody ? Check : Copy}
                onClick={handleCopyZaloContent}
              >
                {copiedZaloBody ? 'Đã sao chép!' : 'Sao chép nội dung'}
              </Button>
              {canSendNotifications ? (
                <Button
                  variant="primary"
                  icon={CheckCheck}
                  loading={markingZalo}
                  onClick={handleMarkZaloSentSubmit}
                >
                  Xác nhận đã gửi thủ công lên Zalo
                </Button>
              ) : null}
            </div>
          </div>
        }
      >
        {zaloCopyModal ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-slate-700">
                Nội dung đã định dạng sẵn cho nhóm Zalo
              </p>
              <div className="p-3.5 rounded-xl bg-slate-900 text-slate-200 text-xs whitespace-pre-wrap font-sans leading-relaxed max-h-60 overflow-y-auto">
                {parseZaloBoldSegments(zaloCopyModal.zalo_content).map((seg, idx) =>
                  seg.bold ? (
                    <strong key={idx} className="font-bold text-white">
                      {seg.text}
                    </strong>
                  ) : (
                    <span key={idx}>{seg.text}</span>
                  )
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                Mẹo trên Zalo PC / Zalo Web: nhấn <strong>Ctrl+V</strong> (hoặc chuột phải chọn <strong>Dán giữ định dạng</strong>) để giữ nguyên các mục in đậm.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-700">
                Nhóm Zalo đích tương ứng phạm vi bản tin ({(zaloCopyModal.target_zalo_groups || []).length})
              </p>
              {(zaloCopyModal.target_zalo_groups || []).length === 0 ? (
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-500">
                  Chưa có nhóm Zalo nào khớp với tòa nhà / căn hộ này trong danh bạ. Bạn vẫn có thể sao chép văn bản phía trên để dán vào Zalo.
                </div>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {zaloCopyModal.target_zalo_groups.map((grp) => {
                    const checked = checkedZaloGroupIds.includes(grp.id);
                    return (
                      <div
                        key={grp.id}
                        className="p-3 rounded-xl bg-sky-50/60 border border-sky-200 flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <label className="inline-flex items-center gap-2.5 cursor-pointer min-w-0">
                          {canSendNotifications ? (
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setCheckedZaloGroupIds((ids) => [...ids, grp.id]);
                                } else {
                                  setCheckedZaloGroupIds((ids) =>
                                    ids.filter((x) => x !== grp.id)
                                  );
                                }
                              }}
                              className="w-4 h-4 rounded border-slate-300 text-primary-600"
                            />
                          ) : null}
                          <span className="font-semibold text-slate-900 break-words">
                            {grp.name}
                          </span>
                          <Badge variant={grp.scope === 'APARTMENT' ? 'purple' : 'sky'}>
                            {grp.scope === 'APARTMENT'
                              ? `Phòng ${grp.apartment_code || ''}`
                              : 'Nhóm Tòa'}
                          </Badge>
                        </label>

                        {grp.invite_link ? (
                          <a
                            href={grp.invite_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-medium"
                          >
                            <ExternalLink className="w-3 h-3" />
                            <span>Mở nhóm Zalo</span>
                          </a>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {zaloCopyModal.manual_sent_at ? (
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
                Đã ghi nhận dán lên Zalo lúc{' '}
                <strong>{formatDateTime(zaloCopyModal.manual_sent_at)}</strong>
                {zaloCopyModal.manual_sent_by_name
                  ? ` bởi ${zaloCopyModal.manual_sent_by_name}`
                  : ''}
                .
              </div>
            ) : null}

            {canSendNotifications ? (
              <Input
                label="Ghi chú xác nhận gửi Zalo (tùy chọn)"
                placeholder="VD: Đã ghim thông báo đầu nhóm Zalo Tòa VOP-A..."
                value={zaloMarkNote}
                onChange={(e) => setZaloMarkNote(e.target.value)}
              />
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* Modal Tạo / Sửa Nhóm Zalo (MANAGER only) */}
      <Modal
        open={groupModalOpen}
        onClose={() => setGroupModalOpen(false)}
        title={editingGroup ? 'Cập nhật Nhóm Zalo' : 'Thêm Nhóm Zalo vào Danh bạ'}
        subtitle="Quản lý đường dẫn nhóm Zalo chung của Tòa nhà và nhóm Zalo riêng từng Căn hộ."
        size="md"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setGroupModalOpen(false)}
              disabled={groupSubmitting}
            >
              Hủy
            </Button>
            <Button variant="primary" onClick={handleSubmitGroup} loading={groupSubmitting}>
              {editingGroup ? 'Lưu thay đổi' : 'Thêm nhóm Zalo'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitGroup} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Select
              label="Tòa nhà"
              required
              value={groupForm.building_id}
              onChange={(e) =>
                setGroupForm((s) => ({
                  ...s,
                  building_id: e.target.value,
                  apartment_id: '',
                }))
              }
              placeholder="-- Chọn tòa nhà --"
              options={buildings.map((b) => ({
                value: b.id,
                label: `${b.code} — ${b.name}`,
              }))}
            />

            <Select
              label="Phạm vi nhóm"
              required
              value={groupForm.scope}
              onChange={(e) =>
                setGroupForm((s) => ({
                  ...s,
                  scope: e.target.value,
                  apartment_id: '',
                }))
              }
              options={[
                { value: 'BUILDING', label: 'Nhóm chung Tòa nhà' },
                { value: 'APARTMENT', label: 'Nhóm riêng từng Phòng' },
              ]}
            />
          </div>

          {groupForm.scope === 'APARTMENT' ? (
            <Select
              label="Căn hộ liên kết"
              required
              value={groupForm.apartment_id}
              onChange={(e) => setGroupForm((s) => ({ ...s, apartment_id: e.target.value }))}
              placeholder="-- Chọn căn hộ --"
              options={groupApartments.map((a) => ({
                value: a.id,
                label: `Căn ${a.code} (${APARTMENT_STATUS[a.status]?.label || a.status})`,
              }))}
            />
          ) : null}

          <Input
            label="Tên hiển thị nhóm Zalo"
            required
            placeholder="VD: Cư dân Tòa VOP-A hoặc Zalo Hỗ trợ Phòng A101"
            value={groupForm.name}
            onChange={(e) => setGroupForm((s) => ({ ...s, name: e.target.value }))}
          />

          <Input
            label="Đường dẫn tham gia nhóm (zalo.me)"
            placeholder="https://zalo.me/g/..."
            value={groupForm.invite_link}
            error={groupLinkError}
            onChange={(e) => {
              setGroupForm((s) => ({ ...s, invite_link: e.target.value }));
              if (groupLinkError) setGroupLinkError('');
            }}
          />

          <Input
            multiline
            rows={2}
            label="Ghi chú vận hành (tùy chọn)"
            placeholder="VD: Nhóm gồm chủ hộ A101 + Kỹ thuật trực ca..."
            value={groupForm.note}
            onChange={(e) => setGroupForm((s) => ({ ...s, note: e.target.value }))}
          />

          <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={groupForm.is_active}
              onChange={(e) =>
                setGroupForm((s) => ({ ...s, is_active: e.target.checked }))
              }
              className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
            />
            <span>Nhóm đang hoạt động (gợi ý tự động khi dán thông báo)</span>
          </label>
        </form>
      </Modal>

      <NotificationDetailModal {...detailModalProps} />

      <ConfirmDialog
        open={Boolean(deleteGroupTarget)}
        onClose={() => {
          if (!deletingGroup) setDeleteGroupTarget(null);
        }}
        onConfirm={handleConfirmDeleteGroup}
        loading={deletingGroup}
        variant="danger"
        title="Xác nhận xóa nhóm Zalo"
        confirmLabel="Xóa nhóm Zalo"
        message={
          deleteGroupTarget
            ? `Bạn có chắc chắn muốn xóa vĩnh viễn nhóm Zalo "${deleteGroupTarget.name}" (${deleteGroupTarget.building_code || ''}) khỏi danh bạ vận hành?`
            : ''
        }
      />
    </div>
  );
}

export default NotificationsPage;
