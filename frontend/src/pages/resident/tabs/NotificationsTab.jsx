import React, { useState, useEffect, useMemo } from 'react';
import {
  Bell,
  CheckCheck,
  Receipt,
  FileText,
  Wrench,
  Megaphone,
  Clock,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Tabs } from '../../../components/ui/Tabs';
import { Skeleton } from '../../../components/ui/Skeleton';
import { EmptyState } from '../../../components/common/EmptyState';
import { useNotificationStore } from '../../../stores/notificationStore';
import { formatDateTime, formatRelativeTime } from '../../../utils/format';

function getNotificationMeta(type = '') {
  const upper = String(type).toUpperCase();
  if (upper.includes('INVOICE') || upper.includes('PAYMENT')) {
    return {
      icon: Receipt,
      color: 'bg-sky-50 text-sky-600 border-sky-100',
      label: 'Tài chính & Hóa đơn',
      targetTab: 'invoices',
      actionLabel: 'Xem hóa đơn',
    };
  }
  if (upper.includes('CONTRACT') || upper.includes('DEPOSIT')) {
    return {
      icon: FileText,
      color: 'bg-indigo-50 text-indigo-600 border-indigo-100',
      label: 'Hợp đồng & Sổ cọc',
      targetTab: 'contract',
      actionLabel: 'Xem hợp đồng',
    };
  }
  if (upper.includes('SERVICE_REQUEST') || upper.includes('MAINTENANCE')) {
    return {
      icon: Wrench,
      color: 'bg-amber-50 text-amber-600 border-amber-100',
      label: 'Kỹ thuật & Bảo trì',
      targetTab: 'maintenance',
      actionLabel: 'Xem báo hỏng',
    };
  }
  return {
    icon: Megaphone,
    color: 'bg-purple-50 text-purple-600 border-purple-100',
    label: 'Thông báo Ban Quản Lý',
    targetTab: null,
    actionLabel: null,
  };
}

export function NotificationsTab({ onNavigateTab }) {
  const {
    notifications,
    unreadCount,
    loading,
    fetchNotifications,
    markAsRead,
    markAllAsRead,
  } = useNotificationStore();

  const [filterTab, setFilterTab] = useState('all');

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const filteredList = useMemo(() => {
    if (filterTab === 'unread') {
      return notifications.filter((n) => !n.read_at);
    }
    return notifications;
  }, [notifications, filterTab]);

  const handleNotificationClick = (notif) => {
    if (!notif.read_at) {
      markAsRead(notif.id);
    }
  };

  return (
    <div className="space-y-6">
      <Card padding={false} className="overflow-hidden">
        {/* Header + Filter Bar */}
        <div className="px-5 pt-5 pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">Hộp thư Thông báo Cư dân</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Cập nhật thông báo vận hành tòa nhà, nhắc lịch hóa đơn và tiến độ xử lý yêu cầu
            </p>
          </div>

          {unreadCount > 0 ? (
            <Button
              variant="soft"
              size="sm"
              icon={CheckCheck}
              onClick={markAllAsRead}
              className="shrink-0"
            >
              Đánh dấu đọc tất cả ({unreadCount})
            </Button>
          ) : null}
        </div>

        <div className="px-5 mt-3">
          <Tabs
            activeTab={filterTab}
            onChange={setFilterTab}
            tabs={[
              { id: 'all', label: 'Tất cả', count: notifications.length },
              { id: 'unread', label: 'Chưa đọc', count: unreadCount },
            ]}
          />
        </div>

        <div className="p-5">
          {loading && notifications.length === 0 ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-20 w-full rounded-xl" />
              ))}
            </div>
          ) : filteredList.length === 0 ? (
            <EmptyState
              icon={Bell}
              title={
                filterTab === 'unread'
                  ? 'Bạn đã đọc hết tất cả thông báo'
                  : 'Chưa có thông báo nào'
              }
              description={
                filterTab === 'unread'
                  ? 'Không còn thông báo mới nào chưa đọc trong hộp thư của bạn.'
                  : 'Các bản tin từ Ban Quản Lý và thông báo tự động của hệ thống sẽ xuất hiện tại đây.'
              }
            />
          ) : (
            <div className="space-y-2.5">
              {filteredList.map((n) => {
                const isUnread = !n.read_at;
                const meta = getNotificationMeta(n.type);
                const NotifIcon = meta.icon;

                return (
                  <div
                    key={n.id}
                    onClick={() => handleNotificationClick(n)}
                    className={`p-4 rounded-xl border transition-all cursor-pointer flex items-start gap-3.5 ${
                      isUnread
                        ? 'bg-primary-50/45 border-primary-200 hover:bg-primary-50/70 shadow-sm'
                        : 'bg-white border-slate-200/80 hover:bg-slate-50/70'
                    }`}
                  >
                    <div
                      className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 mt-0.5 ${meta.color}`}
                    >
                      <NotifIcon className="w-5 h-5" />
                    </div>

                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          {isUnread ? (
                            <span className="w-2 h-2 rounded-full bg-primary-500 shrink-0" />
                          ) : null}
                          <h4
                            className={`text-sm ${
                              isUnread
                                ? 'font-bold text-slate-900'
                                : 'font-semibold text-slate-700'
                            }`}
                          >
                            {n.title}
                          </h4>
                          <Badge variant={isUnread ? 'sky' : 'slate'}>{meta.label}</Badge>
                        </div>

                        <span
                          className="text-[11px] text-slate-400 shrink-0 flex items-center gap-1"
                          title={formatDateTime(n.created_at)}
                        >
                          <Clock className="w-3 h-3" />
                          {formatRelativeTime(n.created_at)}
                        </span>
                      </div>

                      <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-line">
                        {n.content}
                      </p>

                      <div className="pt-1.5 flex items-center justify-between gap-2 text-[11px]">
                        <span className="text-slate-400">
                          {isUnread ? (
                            <span className="text-primary-600 font-medium">
                              Nhấn để đánh dấu đã đọc
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                              Đã xem lúc {formatDateTime(n.read_at)}
                            </span>
                          )}
                        </span>

                        {meta.targetTab && onNavigateTab ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isUnread) markAsRead(n.id);
                              onNavigateTab(meta.targetTab);
                            }}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-primary-600 hover:text-primary-700"
                          >
                            {meta.actionLabel}
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export default NotificationsTab;
