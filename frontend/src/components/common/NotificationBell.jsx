import React, { useState, useRef, useEffect } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { useNotificationStore } from '../../stores/notificationStore';
import { formatRelativeTime } from '../../utils/format';

export function NotificationBell({ onViewAll }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const { notifications, unreadCount, fetchNotifications, markAsRead, markAllAsRead } = useNotificationStore();

  useEffect(() => {
    fetchNotifications();
    const timer = setInterval(fetchNotifications, 60000);
    return () => clearInterval(timer);
  }, [fetchNotifications]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="Thông báo"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center p-2 rounded-xl text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
        title="Thông báo"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 ? (
          <span className="absolute top-1 right-1 min-w-[17px] h-[17px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="fixed inset-x-3 top-16 sm:inset-auto sm:absolute sm:right-0 sm:mt-2 sm:w-96 bg-white rounded-2xl shadow-elevated border border-slate-200 z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-900">Thông báo ({unreadCount} chưa đọc)</span>
            {unreadCount > 0 ? (
              <button
                type="button"
                onClick={markAllAsRead}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                Đọc tất cả
              </button>
            ) : null}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
            {notifications.length === 0 ? (
              <p className="py-8 text-center text-xs text-slate-400">Chưa có thông báo nào.</p>
            ) : (
              notifications.slice(0, 12).map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    if (!n.read_at) markAsRead(n.id);
                    setOpen(false);
                    onViewAll?.();
                  }}
                  className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors flex items-start gap-2.5 ${
                    !n.read_at ? 'bg-primary-50/40' : ''
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                      !n.read_at ? 'bg-primary-500' : 'bg-transparent'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-slate-800 break-words leading-snug">{n.title}</p>
                    <p className="text-xs text-slate-600 line-clamp-3 break-words mt-0.5">{n.content}</p>
                    <p className="text-[11px] text-slate-400 mt-1">{formatRelativeTime(n.created_at)}</p>
                  </div>
                </button>
              ))
            )}
          </div>

          {onViewAll ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onViewAll();
              }}
              className="w-full py-2.5 text-center text-xs font-medium text-primary-600 hover:bg-slate-50 border-t border-slate-100"
            >
              Xem toàn bộ thông báo
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default NotificationBell;

