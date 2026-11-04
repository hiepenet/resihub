import { RESIDENT_PORTAL_TABS } from '../constants/navigation.js';

export const PRIMARY_RESIDENT_MOBILE_TAB_IDS = [
  'overview',
  'invoices',
  'maintenance',
  'services',
];

export const SECONDARY_RESIDENT_MOBILE_TAB_IDS = [
  'contract',
  'notifications',
  'contact',
  'profile',
];

const TAP_BUDGET_MAP = {
  view_overview: 1,
  view_invoices: 1,
  pay_invoice: 2,
  view_maintenance: 1,
  create_maintenance: 2,
  view_services: 1,
  subscribe_service: 2,
  open_secondary_tab: 2,
};

export function resolveResidentMobileNavState({
  activeTab = 'overview',
  unreadCount = 0,
  tabs = RESIDENT_PORTAL_TABS,
} = {}) {
  const safeTabs = Array.isArray(tabs) ? tabs : RESIDENT_PORTAL_TABS;
  const tabById = new Map(safeTabs.map((t) => [t.id, t]));

  const primaryTabs = PRIMARY_RESIDENT_MOBILE_TAB_IDS.map((id) => tabById.get(id)).filter(
    Boolean
  );
  const secondaryTabs = SECONDARY_RESIDENT_MOBILE_TAB_IDS.map((id) => tabById.get(id)).filter(
    Boolean
  );

  const activeSecondaryTab =
    secondaryTabs.find((t) => t.id === activeTab) || null;
  const isMoreActive = Boolean(activeSecondaryTab);
  const moreBadgeCount = Math.max(0, Math.trunc(Number(unreadCount || 0)));

  return {
    primaryTabs,
    secondaryTabs,
    isMoreActive,
    moreBadgeCount,
    activeSecondaryTab,
  };
}

export function getResidentActionTapCount(targetAction) {
  return TAP_BUDGET_MAP[targetAction] ?? 2;
}
