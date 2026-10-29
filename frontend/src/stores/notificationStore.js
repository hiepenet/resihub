import { create } from 'zustand';
import { notificationsService } from '../services/notifications.service';

export const useNotificationStore = create((set, get) => ({
  notifications: [],
  sentHistory: [],
  unreadCount: 0,
  loading: false,

  fetchNotifications: async () => {
    set({ loading: true });
    try {
      const res = await notificationsService.list();
      set({
        notifications: res.data || [],
        sentHistory: res.sent_history || [],
        unreadCount: Number(res.unread_count || 0),
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  markAsRead: async (id) => {
    try {
      await notificationsService.markRead(id);
      set((state) => ({
        notifications: state.notifications.map((n) =>
          n.id === id ? { ...n, read_at: n.read_at || new Date().toISOString() } : n
        ),
        unreadCount: Math.max(0, state.unreadCount - 1),
      }));
    } catch {
      // ignore
    }
  },

  markAllAsRead: async () => {
    try {
      await notificationsService.markAllRead();
      const now = new Date().toISOString();
      set((state) => ({
        notifications: state.notifications.map((n) => ({ ...n, read_at: n.read_at || now })),
        unreadCount: 0,
      }));
    } catch {
      // ignore
    }
  },

  reset: () => set({ notifications: [], sentHistory: [], unreadCount: 0, loading: false }),
}));

