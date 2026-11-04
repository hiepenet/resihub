import { create } from 'zustand';
import { notificationsService } from '../services/notifications.service';
import { useAuthStore } from './authStore';
import {
  getReadOrgNotifIds,
  persistReadOrgNotifIds,
  mergeOrgNotificationReadState,
} from '../utils/notificationNavigation';

function getCurrentUserId() {
  const user = useAuthStore.getState()?.user;
  return user?.id || user?.sub || null;
}

export const useNotificationStore = create((set, get) => ({
  notifications: [],
  sentHistory: [],
  unreadCount: 0,
  loading: false,

  fetchNotifications: async () => {
    set({ loading: true });
    try {
      const res = await notificationsService.list();
      const userId = getCurrentUserId();
      const merged = mergeOrgNotificationReadState(
        res.data || [],
        userId,
        undefined,
        res.unread_count
      );
      set({
        notifications: merged.notifications,
        sentHistory: res.sent_history || [],
        unreadCount: merged.unreadCount,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  markAsRead: async (id, notificationObj = null) => {
    const state = get();
    const target = state.notifications.find((n) => n.id === id) || notificationObj;
    const wasUnread = Boolean(target && !target.read_at);
    const now = new Date().toISOString();

    if (target && target.user_id == null) {
      const userId = getCurrentUserId();
      const ids = getReadOrgNotifIds(userId);
      ids.add(String(id));
      persistReadOrgNotifIds(userId, ids);
    }

    set((prev) => ({
      notifications: prev.notifications.map((n) =>
        n.id === id ? { ...n, read_at: n.read_at || now } : n
      ),
      unreadCount: wasUnread ? Math.max(0, prev.unreadCount - 1) : prev.unreadCount,
    }));

    try {
      await notificationsService.markRead(id);
    } catch {
      // ignore
    }
  },

  markAllAsRead: async (extraRows = []) => {
    const state = get();
    const userId = getCurrentUserId();
    const combined = [
      ...state.notifications,
      ...(Array.isArray(extraRows) ? extraRows : []),
    ];
    const orgNotifIds = combined
      .filter((n) => n && n.user_id == null && n.id != null)
      .map((n) => String(n.id));
    if (orgNotifIds.length > 0) {
      const ids = getReadOrgNotifIds(userId);
      orgNotifIds.forEach((id) => ids.add(id));
      persistReadOrgNotifIds(userId, ids);
    }

    const now = new Date().toISOString();
    set((prev) => ({
      notifications: prev.notifications.map((n) => ({ ...n, read_at: n.read_at || now })),
      unreadCount: 0,
    }));

    try {
      await notificationsService.markAllRead();
    } catch {
      // ignore
    }
  },

  reset: () => set({ notifications: [], sentHistory: [], unreadCount: 0, loading: false }),
}));
