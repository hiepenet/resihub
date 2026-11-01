import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Bell,
  BellRing,
  Send,
  CheckCheck,
  Inbox,
  History,
  RefreshCw,
  Building2,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { PageHeader } from '../../../components/common/PageHeader';
import { SearchBar } from '../../../components/common/SearchBar';
import { EmptyState } from '../../../components/common/EmptyState';
import { notificationsService } from '../../../services/notifications.service';
import { buildingsService } from '../../../services/buildings.service';
import { useNotificationStore } from '../../../stores/notificationStore';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { APARTMENT_STATUS } from '../../../constants/statuses';
import { formatDateTime, formatRelativeTime } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

const NOTIFICATION_TYPES = {
  ANNOUNCEMENT: { label: 'Thông báo chung BQL', variant: 'sky' },
  MAINTENANCE_NOTICE: { label: 'Lịch bảo trì / Kỹ thuật', variant: 'amber' },
  PAYMENT_REMINDER: { label: 'Nhắc thanh toán phí', variant: 'indigo' },
  SECURITY_ALERT: { label: 'Cảnh báo An ninh / PCCC', variant: 'red' },
  INVOICE_ISSUED: { label: 'Phát hành hóa đơn', variant: 'emerald' },
  PAYMENT_CONFIRMED: { label: 'Xác nhận thanh toán', variant: 'emerald' },
  PAYMENT_REJECTED: { label: 'Từ chối chứng từ', variant: 'red' },
  MAINTENANCE_UPDATE: { label: 'Cập nhật báo hỏng', variant: 'amber' },
  SERVICE_UPDATE: { label: 'Cập nhật dịch vụ', variant: 'purple' },
};

const COMPOSE_TYPE_OPTIONS = [
  { value: 'ANNOUNCEMENT', label: 'Thông báo chung Ban quản lý' },
  { value: 'MAINTENANCE_NOTICE', label: 'Lịch bảo trì / Tạm ngưng điện nước' },
  { value: 'PAYMENT_REMINDER', label: 'Nhắc lịch đóng phí định kỳ' },
  { value: 'SECURITY_ALERT', label: 'Thông báo An ninh / PCCC khẩn' },
];

const SCOPE_LABELS = {
  ALL: { label: 'Toàn hệ thống', variant: 'indigo' },
  BUILDING: { label: 'Theo Tòa nhà', variant: 'sky' },
  FLOOR: { label: 'Theo Tầng', variant: 'amber' },
  APARTMENT: { label: 'Căn hộ cụ thể', variant: 'purple' },
};

export function NotificationsPage() {
  const toast = useToast();
  const { isSysAdmin, canSendNotifications } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);
  const syncBellStore = useNotificationStore((s) => s.fetchNotifications);

  const [activeTab, setActiveTab] = useState('inbox'); // 'inbox' | 'sent_history'
  const [inbox, setInbox] = useState([]);
  const [sentHistory, setSentHistory] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState('');

  // Dữ liệu địa điểm cho Form phát hành thông báo
  const [buildings, setBuildings] = useState([]);
  const [floors, setFloors] = useState([]);
  const [apartments, setApartments] = useState([]);
  const [sending, setSending] = useState(false);

  const [form, setForm] = useState({
    target_scope: isSysAdmin && !selectedBuildingId ? 'ALL' : 'BUILDING',
    building_id: selectedBuildingId || '',
    floor_id: '',
    apartment_id: '',
    type: 'ANNOUNCEMENT',
    title: '',
    content: '',
  });

  const fetchAllNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await notificationsService.list();
      setInbox(res.data || []);
      setSentHistory(res.sent_history || []);
      setUnreadCount(Number(res.unread_count || 0));
      syncBellStore();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách thông báo.'));
    } finally {
      setLoading(false);
    }
  }, [syncBellStore, toast]);

  useEffect(() => {
    fetchAllNotifications();
  }, [fetchAllNotifications]);

  // Nạp danh sách tòa nhà cho form gửi thông báo
  useEffect(() => {
    if (!canSendNotifications) return;
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
  }, [canSendNotifications]);

  // Tự động đồng bộ theo selectedBuildingId từ TopBar
  useEffect(() => {
    if (selectedBuildingId) {
      setForm((prev) => ({
        ...prev,
        target_scope: prev.target_scope === 'ALL' ? 'BUILDING' : prev.target_scope,
        building_id: selectedBuildingId,
        floor_id: '',
        apartment_id: '',
      }));
    }
  }, [selectedBuildingId]);

  // Nạp tầng & căn hộ khi chọn tòa nhà trong form
  useEffect(() => {
    if (!form.building_id) {
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
  }, [form.building_id, form.target_scope]);

  const scopeOptions = useMemo(() => {
    const opts = [];
    if (isSysAdmin) {
      opts.push({ value: 'ALL', label: '🌐 Toàn bộ hệ thống (Tất cả tòa nhà)' });
    }
    opts.push(
      { value: 'BUILDING', label: '🏢 Cư dân theo Tòa nhà' },
      { value: 'FLOOR', label: '📑 Cư dân theo Tầng cụ thể' },
      { value: 'APARTMENT', label: '🚪 Một Căn hộ cụ thể' }
    );
    return opts;
  }, [isSysAdmin]);

  const handleSendNotification = async (e) => {
    e.preventDefault();
    if (!form.title.trim() || !form.content.trim()) {
      toast.warning('Vui lòng nhập đầy đủ tiêu đề và nội dung thông báo.');
      return;
    }
    if (form.target_scope !== 'ALL' && !form.building_id) {
      toast.warning('Vui lòng chọn tòa nhà nhận thông báo.');
      return;
    }
    if (form.target_scope === 'FLOOR' && !form.floor_id) {
      toast.warning('Vui lòng chọn tầng nhận thông báo.');
      return;
    }
    if (form.target_scope === 'APARTMENT' && !form.apartment_id) {
      toast.warning('Vui lòng chọn căn hộ nhận thông báo.');
      return;
    }

    setSending(true);
    try {
      const payload = {
        target_scope: form.target_scope,
        type: form.type,
        title: form.title.trim(),
        content: form.content.trim(),
      };
      if (form.target_scope !== 'ALL') {
        payload.building_id = form.building_id;
      }
      if (form.target_scope === 'FLOOR') {
        payload.floor_id = form.floor_id;
      }
      if (form.target_scope === 'APARTMENT') {
        payload.apartment_id = form.apartment_id;
      }

      const res = await notificationsService.send(payload);
      toast.success(res.message || 'Phát hành thông báo thành công.');
      setForm((prev) => ({ ...prev, title: '', content: '' }));
      setActiveTab('sent_history');
      fetchAllNotifications();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi thông báo.'));
    } finally {
      setSending(false);
    }
  };

  const handleMarkRead = async (item) => {
    if (item.read_at) return;
    try {
      await notificationsService.markRead(item.id);
      setInbox((prev) =>
        prev.map((n) => (n.id === item.id ? { ...n, read_at: new Date().toISOString() } : n))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
      syncBellStore();
    } catch {
      // ignore
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await notificationsService.markAllRead();
      const now = new Date().toISOString();
      setInbox((prev) => prev.map((n) => ({ ...n, read_at: n.read_at || now })));
      setUnreadCount(0);
      syncBellStore();
      toast.success('Đã đánh dấu đọc tất cả thông báo.');
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật trạng thái đã đọc.'));
    }
  };

  const filteredInbox = useMemo(() => {
    return inbox.filter((n) => {
      if (unreadOnly && n.read_at) return false;
      if (selectedBuildingId && n.payload?.building_id && n.payload.building_id !== selectedBuildingId) {
        return false;
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return (
          n.title?.toLowerCase().includes(q) || n.content?.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [inbox, unreadOnly, selectedBuildingId, search]);

  const filteredSent = useMemo(() => {
    return sentHistory.filter((n) => {
      if (selectedBuildingId && n.payload?.building_id && n.payload.building_id !== selectedBuildingId) {
        return false;
      }
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        return (
          n.title?.toLowerCase().includes(q) || n.content?.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [sentHistory, selectedBuildingId, search]);

  const getBuildingLabel = (bId) => {
    if (!bId) return null;
    const b = buildings.find((x) => x.id === bId);
    return b ? `${b.code} — ${b.name}` : null;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trung tâm Thông báo Cư dân"
        subtitle="Phát hành bản tin vận hành theo Tòa nhà, Tầng, Căn hộ và theo dõi hộp thư hệ thống."
        actions={
          <div className="flex items-center gap-2">
            {unreadCount > 0 ? (
              <Button variant="outline" icon={CheckCheck} onClick={handleMarkAllRead}>
                Đọc tất cả ({unreadCount})
              </Button>
            ) : null}
            <Button variant="outline" icon={RefreshCw} onClick={fetchAllNotifications}>
              Làm mới
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* CỘT TRÁI: FORM TẠO THÔNG BÁO MỚI */}
        {canSendNotifications ? (
          <Card className="lg:col-span-5 space-y-4">
            <CardHeader
              title="Phát hành thông báo mới"
              subtitle="Gửi trực tiếp tới ứng dụng Cổng cư dân của các hợp đồng đang hiệu lực."
            />

            <form onSubmit={handleSendNotification} className="space-y-4">
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
                options={scopeOptions}
              />

              {form.target_scope !== 'ALL' ? (
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
              ) : null}

              {form.target_scope === 'FLOOR' ? (
                <Select
                  label="Chọn Tầng"
                  required
                  value={form.floor_id}
                  onChange={(e) => setForm((s) => ({ ...s, floor_id: e.target.value }))}
                  placeholder="-- Chọn tầng nhận thông báo --"
                  options={floors.map((f) => ({
                    value: f.id,
                    label: `${f.name} (Tầng ${f.floor_number})`,
                  }))}
                />
              ) : null}

              {form.target_scope === 'APARTMENT' ? (
                <Select
                  label="Chọn Căn hộ"
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
                placeholder="VD: Thông báo lịch bảo trì thang máy định kỳ tháng này..."
                value={form.title}
                onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))}
              />

              <Input
                label="Nội dung chi tiết"
                required
                multiline
                rows={5}
                placeholder="Nhập nội dung thông báo rõ ràng, thời gian áp dụng và đầu mối liên hệ khi cần..."
                value={form.content}
                onChange={(e) => setForm((s) => ({ ...s, content: e.target.value }))}
              />

              <Button
                type="submit"
                variant="primary"
                className="w-full"
                icon={Send}
                loading={sending}
              >
                Phát hành thông báo ngay
              </Button>
            </form>
          </Card>
        ) : null}

        {/* CỘT PHẢI: TABS HỘP THƯ ĐẾN & LỊCH SỬ ĐÃ PHÁT HÀNH */}
        <div
          className={`${
            canSendNotifications ? 'lg:col-span-7' : 'lg:col-span-12'
          } space-y-4`}
        >
          <Card padding={false} className="overflow-hidden">
            <div className="px-5 pt-3">
              <Tabs
                activeTab={activeTab}
                onChange={setActiveTab}
                tabs={[
                  {
                    id: 'inbox',
                    label: 'Hộp thư đến',
                    icon: Inbox,
                    count: unreadCount > 0 ? `${unreadCount} mới` : filteredInbox.length,
                  },
                  ...(canSendNotifications
                    ? [
                        {
                          id: 'sent_history',
                          label: 'Lịch sử đã phát hành',
                          icon: History,
                          count: filteredSent.length,
                        },
                      ]
                    : []),
                ]}
              />
            </div>

            {/* Thanh tìm kiếm & lọc */}
            <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex flex-wrap items-center justify-between gap-3">
              <div className="flex-1 min-w-[220px]">
                <SearchBar
                  value={search}
                  onChange={setSearch}
                  placeholder="Tìm tiêu đề hoặc nội dung thông báo..."
                />
              </div>

              {activeTab === 'inbox' ? (
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={unreadOnly}
                    onChange={(e) => setUnreadOnly(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span>Chỉ hiện chưa đọc</span>
                </label>
              ) : null}
            </div>

            {/* Nội dung danh sách */}
            {loading ? (
              <div className="p-10 text-center text-sm text-slate-400">
                Đang tải danh sách thông báo...
              </div>
            ) : activeTab === 'inbox' ? (
              filteredInbox.length === 0 ? (
                <EmptyState
                  icon={Bell}
                  title="Hộp thư đến trống"
                  description="Bạn đã đọc hết các thông báo hoặc chưa có thông báo mới nào."
                />
              ) : (
                <div className="divide-y divide-slate-100 max-h-[680px] overflow-y-auto">
                  {filteredInbox.map((item) => {
                    const typeInfo = NOTIFICATION_TYPES[item.type] || {
                      label: item.type || 'Hệ thống',
                      variant: 'slate',
                    };
                    const isUnread = !item.read_at;
                    return (
                      <div
                        key={item.id}
                        onClick={() => handleMarkRead(item)}
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
                            className={`text-sm ${
                              isUnread
                                ? 'font-bold text-slate-900'
                                : 'font-semibold text-slate-800'
                            }`}
                          >
                            {item.title}
                          </h4>
                          <p className="text-xs text-slate-600 whitespace-pre-line leading-relaxed">
                            {item.content}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            ) : filteredSent.length === 0 ? (
              <EmptyState
                icon={BellRing}
                title="Chưa có lịch sử phát hành"
                description="Các bản tin do Ban quản lý phát hành tới cư dân sẽ được lưu vết tại đây."
              />
            ) : (
              <div className="divide-y divide-slate-100 max-h-[680px] overflow-y-auto">
                {filteredSent.map((item) => {
                  const typeInfo = NOTIFICATION_TYPES[item.type] || {
                    label: item.type || 'Thông báo',
                    variant: 'sky',
                  };
                  const scopeCode = item.payload?.target_scope || 'BUILDING';
                  const scopeMeta = SCOPE_LABELS[scopeCode] || SCOPE_LABELS.BUILDING;
                  const bldgLabel =
                    (item.building_code && item.building_name
                      ? `${item.building_code} — ${item.building_name}`
                      : null) || getBuildingLabel(item.payload?.building_id);

                  return (
                    <div key={item.id} className="p-4 sm:px-5 space-y-1.5 hover:bg-slate-50/70">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant={scopeMeta.variant}>{scopeMeta.label}</Badge>
                          <Badge variant={typeInfo.variant}>{typeInfo.label}</Badge>
                          <Badge variant="slate">
                            {scopeCode === 'ALL'
                              ? 'Toàn bộ cư dân'
                              : `${item.recipient_count || 1} người nhận`}
                          </Badge>
                          {bldgLabel ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-slate-600">
                              <Building2 className="w-3 h-3 shrink-0" /> {bldgLabel}
                              {item.floor_name ? ` • ${item.floor_name}` : ''}
                              {item.apartment_code ? ` • Căn ${item.apartment_code}` : ''}
                            </span>
                          ) : null}
                        </div>
                        <span className="text-[11px] text-slate-400">
                          {formatDateTime(item.created_at)}
                        </span>
                      </div>

                      <h4 className="text-sm font-semibold text-slate-900">{item.title}</h4>
                      <p className="text-xs text-slate-600 whitespace-pre-line leading-relaxed">
                        {item.content}
                      </p>

                      {item.payload?.sender_name ? (
                        <p className="text-[11px] text-slate-400 pt-0.5">
                          Người phát hành: <strong>{item.payload.sender_name}</strong>
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

export default NotificationsPage;
