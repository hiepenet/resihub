import { create } from 'zustand';
import {
  extractRoleCodes,
  getPrimaryRole,
  hasAnyRole,
  getAssignedBuildingIds,
  isAdminPortalUser,
} from '../utils/permissions';
import { ROLE_LABELS, ROLES } from '../constants/roles';
import { clearQueryCache } from '../services/queryCache';

function safeParseUser() {
  try {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export const useAuthStore = create((set, get) => ({
  user: safeParseUser(),
  accessToken: localStorage.getItem('accessToken') || null,
  refreshToken: localStorage.getItem('refreshToken') || null,
  isAuthenticated: Boolean(localStorage.getItem('accessToken')),
  selectedBuildingId: localStorage.getItem('resihub_selected_building_id') || '',

  setAuthData: (accessToken, refreshToken, user) => {
    clearQueryCache();
    localStorage.setItem('accessToken', accessToken);
    if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.removeItem('activeRole');

    const assignedBuildingIds = getAssignedBuildingIds(user);
    const initialBuildingId =
      assignedBuildingIds.length === 1 ? String(assignedBuildingIds[0]) : '';
    if (initialBuildingId) {
      localStorage.setItem('resihub_selected_building_id', initialBuildingId);
    } else {
      localStorage.removeItem('resihub_selected_building_id');
    }

    set({
      accessToken,
      refreshToken: refreshToken || get().refreshToken,
      user,
      isAuthenticated: true,
      selectedBuildingId: initialBuildingId,
    });
  },

  updateUser: (partialUser) => {
    const merged = { ...(get().user || {}), ...partialUser };
    localStorage.setItem('user', JSON.stringify(merged));
    set({ user: merged });
  },

  setSelectedBuildingId: (buildingId) => {
    const val = buildingId || '';
    if (val) localStorage.setItem('resihub_selected_building_id', val);
    else localStorage.removeItem('resihub_selected_building_id');
    set({ selectedBuildingId: val });
  },

  getRoleCodes: () => extractRoleCodes(get().user),

  getCurrentRole: () => getPrimaryRole(get().user),

  getCurrentRoleInfo: () => {
    const { user } = get();
    const primary = getPrimaryRole(user);
    const matched = Array.isArray(user?.roles)
      ? user.roles.find((r) => (typeof r === 'string' ? r === primary : r?.code === primary))
      : null;
    if (matched && typeof matched === 'object') {
      return {
        ...matched,
        name: matched.name || ROLE_LABELS[primary] || primary,
      };
    }
    return { code: primary, name: ROLE_LABELS[primary] || ROLE_LABELS[ROLES.RESIDENT] };
  },

  // Hỗ trợ kiểm tra đầy đủ mảng multi-role thay vì chỉ lấy roles[0]
  hasRole: (allowedRoles) => hasAnyRole(get().user, allowedRoles),

  isAdminPortal: () => isAdminPortalUser(get().user),

  getAssignedBuildings: () => getAssignedBuildingIds(get().user),

  clearSession: () => {
    clearQueryCache();
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    localStorage.removeItem('activeRole');
    localStorage.removeItem('resihub_selected_building_id');
    set({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      selectedBuildingId: '',
    });
  },
}));
