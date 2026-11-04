import { useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useNotificationStore } from '../stores/notificationStore';
import { buildingsService } from '../services/buildings.service';
import {
  resolveNotificationAction,
  syncBuildingFilterBeforeNavigate,
} from '../utils/notificationNavigation';

export function useNotificationAction({ onMarkReadLocal } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const getCurrentRole = useAuthStore((s) => s.getCurrentRole);
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);
  const setSelectedBuildingId = useAuthStore((s) => s.setSelectedBuildingId);
  const markAsRead = useNotificationStore((s) => s.markAsRead);

  const [detailState, setDetailState] = useState({
    open: false,
    notification: null,
    fallbackUrl: null,
    fallbackLabel: 'Đi tới trang liên quan',
  });

  const isAdminPortal = location.pathname.startsWith('/admin');
  const role = getCurrentRole() || (isAdminPortal ? 'MANAGER' : 'RESIDENT');

  const getActionMeta = useCallback(
    (notification) => resolveNotificationAction(notification, { role, isAdminPortal }),
    [role, isAdminPortal]
  );

  const handleNotificationClick = useCallback(
    async (notification) => {
      if (!notification) return;

      if (!notification.read_at) {
        markAsRead(notification.id);
        onMarkReadLocal?.(notification);
      }

      const action = resolveNotificationAction(notification, { role, isAdminPortal });

      if (isAdminPortal && action.buildingId && selectedBuildingId && selectedBuildingId !== action.buildingId) {
        let accessibleIds = [];
        try {
          const cached = buildingsService.peekList?.()?.data;
          if (Array.isArray(cached) && cached.length > 0) {
            accessibleIds = cached.map((b) => b.id);
          } else {
            const res = await buildingsService.list();
            accessibleIds = (res?.data || []).map((b) => b.id);
          }
        } catch {
          accessibleIds = [];
        }
        syncBuildingFilterBeforeNavigate(action.buildingId, {
          selectedBuildingId,
          accessibleBuildingIds: accessibleIds,
          setSelectedBuildingId,
        });
      }

      if (action.kind === 'navigate' && action.url) {
        navigate(action.url);
        return;
      }

      setDetailState({
        open: true,
        notification,
        fallbackUrl: action.fallbackUrl || null,
        fallbackLabel: action.actionLabel || 'Đi tới trang liên quan',
      });
    },
    [isAdminPortal, markAsRead, navigate, onMarkReadLocal, role, selectedBuildingId, setSelectedBuildingId]
  );

  const closeDetailModal = useCallback(() => {
    setDetailState((prev) => ({ ...prev, open: false }));
  }, []);

  const navigateFallback = useCallback(
    (url) => {
      if (url) navigate(url);
    },
    [navigate]
  );

  return {
    handleNotificationClick,
    getActionMeta,
    detailModalProps: {
      open: detailState.open,
      notification: detailState.notification,
      fallbackUrl: detailState.fallbackUrl,
      fallbackLabel: detailState.fallbackLabel,
      onClose: closeDetailModal,
      onNavigateFallback: navigateFallback,
    },
  };
}

export default useNotificationAction;
