import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  CheckCheck,
  FileText,
  Clock,
  AlertTriangle,
  Wrench,
  DollarSign,
  ExternalLink,
} from 'lucide-react';
import api from '../../services/api';

export default function NotificationBell() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'unread'
  const dropdownRef = useRef(null);

  const fetchNotifications = async () => {
    try {
      const res = await api.get('/api/v1/notifications');
      setNotifications(res.data?.data || []);
      setUnreadCount(res.data?.unread_count || 0);
    } catch (err) {
      console.warn('Unable to load notifications:', err.message);
    }
  };

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleMarkAsRead = async (notif) => {
    if (!notif.read_at) {
      try {
        await api.patch(`/api/v1/notifications/${notif.id}/read`);
        setNotifications((prev) =>
          prev.map((n) => (n.id === notif.id ? { ...n, read_at: new Date().toISOString() } : n))
        );
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } catch (err) {
        console.error('Failed to mark read:', err);
      }
    }

    setIsOpen(false);
    if (notif.payload?.link) {
      navigate(notif.payload.link);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await api.post('/api/v1/notifications/read-all');
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() }))
      );
      setUnreadCount(0);
    } catch (err) {
      console.error('Failed to mark all read:', err);
    }
  };

  const getNotificationIcon = (type) => {
    switch (type) {
      case 'CONTRACT_EXPIRING':
        return {
          icon: FileText,
          bg: 'bg-indigo-50 text-indigo-600 border-indigo-100',
        };
      case 'RESERVATION_NEW':
        return {
          icon: Clock,
          bg: 'bg-amber-50 text-amber-600 border-amber-100',
        };
      case 'INVOICE_OVERDUE':
        return {
          icon: DollarSign,
          bg: 'bg-rose-50 text-rose-600 border-rose-100',
        };
      case 'MAINTENANCE_TICKET':
        return {
          icon: Wrench,
          bg: 'bg-sky-50 text-sky-600 border-sky-100',
        };
      default:
        return {
          icon: AlertTriangle,
          bg: 'bg-slate-50 text-slate-600 border-slate-100',
        };
    }
  };

  const formatTimeAgo = (dateStr) => {
    if (!dateStr) return '';
    const diff = Math.floor((new Date() - new Date(dateStr)) / 1000);
    if (diff < 60) return 'Vừa xong';
    if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
    return `${Math.floor(diff / 86400)} ngày trước`;
  };

  const displayedNotifications =
    activeTab === 'unread'
      ? notifications.filter((n) => !n.read_at)
      : notifications;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        id="btn-notifications"
        onClick={() => setIsOpen(!isOpen)}
        className={`relative p-2 rounded-xl transition-colors ${
          isOpen
            ? 'bg-slate-100 text-slate-900 ring-2 ring-indigo-500/20'
            : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
        }`}
        title="Thông báo hệ thống"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 px-1.5 py-0.5 min-w-[18px] text-[10px] font-bold rounded-full bg-rose-500 text-white flex items-center justify-center animate-pulse shadow-sm">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-white rounded-2xl shadow-2xl border border-slate-200/90 z-50 overflow-hidden animate-in fade-in duration-150">
          {/* Header */}
          <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm text-slate-800">Thông báo</h3>
              {unreadCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-indigo-100 text-indigo-700">
                  {unreadCount} mới
                </span>
              )}
            </div>

            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 transition-colors"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                Đã đọc tất cả
              </button>
            )}
          </div>

          {/* Tabs */}
          <div className="flex items-center px-4 pt-2.5 border-b border-slate-100 gap-3 text-xs">
            <button
              onClick={() => setActiveTab('all')}
              className={`pb-2 font-semibold border-b-2 transition-colors ${
                activeTab === 'all'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-slate-400 hover:text-slate-700'
              }`}
            >
              Tất cả ({notifications.length})
            </button>
            <button
              onClick={() => setActiveTab('unread')}
              className={`pb-2 font-semibold border-b-2 transition-colors ${
                activeTab === 'unread'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-slate-400 hover:text-slate-700'
              }`}
            >
              Chưa đọc ({unreadCount})
            </button>
          </div>

          {/* Notification List */}
          <div className="max-h-[380px] overflow-y-auto divide-y divide-slate-100">
            {displayedNotifications.length === 0 ? (
              <div className="py-12 px-4 text-center text-slate-400 flex flex-col items-center justify-center">
                <Bell className="w-8 h-8 stroke-1 text-slate-300 mb-2" />
                <p className="text-xs font-medium">Không có thông báo nào</p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {activeTab === 'unread' ? 'Bạn đã đọc hết mọi thông báo' : 'Hệ thống chưa có thông báo mới'}
                </p>
              </div>
            ) : (
              displayedNotifications.map((n) => {
                const iconConfig = getNotificationIcon(n.type);
                const IconComponent = iconConfig.icon;
                const isUnread = !n.read_at;

                return (
                  <div
                    key={n.id}
                    onClick={() => handleMarkAsRead(n)}
                    className={`p-3.5 flex items-start gap-3 transition-colors cursor-pointer hover:bg-slate-50/80 ${
                      isUnread ? 'bg-indigo-50/20' : 'bg-white'
                    }`}
                  >
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center border shrink-0 mt-0.5 ${iconConfig.bg}`}
                    >
                      <IconComponent className="w-4 h-4" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <h4
                          className={`text-xs truncate ${
                            isUnread ? 'font-bold text-slate-900' : 'font-medium text-slate-700'
                          }`}
                        >
                          {n.title}
                        </h4>
                        <span className="text-[10px] text-slate-400 whitespace-nowrap shrink-0">
                          {formatTimeAgo(n.created_at)}
                        </span>
                      </div>

                      <p className="text-[11px] text-slate-500 line-clamp-2 mt-0.5 leading-relaxed">
                        {n.content}
                      </p>

                      {n.payload?.link && (
                        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-indigo-600 font-semibold">
                          <span>Xem chi tiết</span>
                          <ExternalLink className="w-3 h-3" />
                        </div>
                      )}
                    </div>

                    {isUnread && (
                      <span className="w-2 h-2 rounded-full bg-indigo-600 shrink-0 mt-1.5" />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
