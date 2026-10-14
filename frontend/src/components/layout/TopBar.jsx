import React, { useEffect, useState, useRef } from 'react';
import {
  Menu,
  Building2,
  Bell,
  CheckCircle2,
  ChevronDown,
  CheckCheck,
  FileText,
  Clock,
  ShieldCheck,
  AlertCircle,
  ExternalLink,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';

export default function TopBar({ onMenuClick }) {
  const navigate = useNavigate();

  // Building Switcher State
  const [buildings, setBuildings] = useState([]);
  const [selectedBuildingId, setSelectedBuildingId] = useState(() => {
    return localStorage.getItem('resihub_selected_building_id') || 'ALL';
  });

  // Health Status
  const [systemHealth, setSystemHealth] = useState('checking');

  // Notifications State
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpenNotifications, setIsOpenNotifications] = useState(false);
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'unread'
  const [isLoadingNotifications, setIsLoadingNotifications] = useState(false);

  const notifDropdownRef = useRef(null);

  // Fetch health, buildings and notifications
  useEffect(() => {
    // 1. Health check
    api.get('/api/health')
      .then(() => setSystemHealth('healthy'))
      .catch(() => setSystemHealth('error'));

    // 2. Fetch buildings for switcher (PRD 8.2)
    api.get('/api/v1/buildings')
      .then((res) => {
        const list = res.data?.data || [];
        setBuildings(list);
      })
      .catch(() => {});

    // 3. Fetch notifications initially
    fetchNotifications();

    // 4. Set interval polling for notifications every 30 seconds
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchNotifications = async () => {
    try {
      const res = await api.get('/api/v1/notifications');
      setNotifications(res.data?.data || []);
      setUnreadCount(res.data?.unread_count || 0);
    } catch (err) {
      console.warn('Unable to load notifications:', err.message);
    }
  };

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (notifDropdownRef.current && !notifDropdownRef.current.contains(event.target)) {
        setIsOpenNotifications(false);
      }
    }
    if (isOpenNotifications) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpenNotifications]);

  // Handle building switcher change
  const handleBuildingChange = (e) => {
    const val = e.target.value;
    setSelectedBuildingId(val);
    localStorage.setItem('resihub_selected_building_id', val);
    // Dispatch a custom window event so child pages like Dashboard can react immediately
    window.dispatchEvent(new CustomEvent('buildingChanged', { detail: val }));
  };

  // Mark 1 notification as read
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

    setIsOpenNotifications(false);
    if (notif.payload?.link) {
      navigate(notif.payload.link);
    }
  };

  // Mark all as read
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

  // Helper for notification icon
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
      case 'DEPOSIT_SECURE':
        return {
          icon: ShieldCheck,
          bg: 'bg-emerald-50 text-emerald-600 border-emerald-100',
        };
      default:
        return {
          icon: Bell,
          bg: 'bg-slate-50 text-slate-600 border-slate-200',
        };
    }
  };

  // Format relative time helper
  const formatTimeAgo = (dateStr) => {
    if (!dateStr) return '';
    const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 60) return 'Vừa xong';
    if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
    return `${Math.floor(diff / 86400)} ngày trước`;
  };

  const displayedNotifications = notifications.filter((n) => {
    if (activeTab === 'unread') return !n.read_at;
    return true;
  });

  return (
    <header className="h-16 bg-white border-b border-surface-border px-4 sm:px-6 flex items-center justify-between sticky top-0 z-30 shadow-sm">
      <div className="flex items-center gap-3">
        {/* Mobile menu toggle */}
        <button
          onClick={onMenuClick}
          className="p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 lg:hidden"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Building Switcher (PRD 8.2) */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center">
            <Building2 className="w-4 h-4" />
          </div>
          <div className="relative">
            <select
              value={selectedBuildingId}
              onChange={handleBuildingChange}
              className="appearance-none bg-slate-50 border border-slate-200 text-slate-800 text-xs sm:text-sm font-semibold rounded-lg pl-3 pr-8 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500 cursor-pointer max-w-[200px] sm:max-w-[320px] truncate"
            >
              <option value="ALL">🏢 Tất cả tòa nhà ({buildings.length} tòa)</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        </div>
      </div>

      {/* Right Actions */}
      <div className="flex items-center gap-3">
        {/* System API Status */}
        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
          <span>API 200 OK</span>
        </div>

        {/* Notification Bell Dropdown Container */}
        <div className="relative" ref={notifDropdownRef}>
          <button
            onClick={() => setIsOpenNotifications(!isOpenNotifications)}
            className={`relative p-2 rounded-lg transition-colors ${
              isOpenNotifications
                ? 'bg-slate-100 text-slate-900 ring-2 ring-indigo-500/20'
                : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
            }`}
            title="Thông báo hệ thống"
          >
            <Bell className="w-5 h-5" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 px-1.5 py-0.5 min-w-[18px] text-[10px] font-bold rounded-full bg-red-500 text-white flex items-center justify-center animate-pulse shadow-sm">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {/* Popover Dropdown */}
          {isOpenNotifications && (
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
                    className="text-[11px] font-semibold text-primary-600 hover:text-primary-800 flex items-center gap-1 transition-colors"
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

              {/* Footer */}
              <div className="p-2.5 bg-slate-50 border-t border-slate-100 text-center">
                <button
                  onClick={() => setIsOpenNotifications(false)}
                  className="text-xs text-slate-500 hover:text-slate-800 font-medium py-1 px-3 rounded-lg hover:bg-slate-200/50 transition-colors"
                >
                  Đóng
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
