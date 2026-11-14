import '../constants/navigation.dart';

/// The 4 tab IDs that occupy the bottom navigation bar for residents.
const List<String> kPrimaryResidentMobileTabIds = [
  'overview',
  'invoices',
  'maintenance',
  'services',
];

/// The 4 secondary tab IDs accessible via the "Thêm" (More) bottom sheet or menu.
const List<String> kSecondaryResidentMobileTabIds = [
  'contract',
  'notifications',
  'contact',
  'profile',
];

/// Tap budget mapping per key resident action (from residentNavHelpers.js).
const Map<String, int> kResidentTapBudgetMap = {
  'view_overview': 1,
  'view_invoices': 1,
  'pay_invoice': 2,
  'view_maintenance': 1,
  'create_maintenance': 2,
  'view_services': 1,
  'subscribe_service': 2,
  'open_secondary_tab': 2,
};

/// Retrieves the tap count budget for a specific resident action.
int getResidentActionTapCount(String targetAction) {
  return kResidentTapBudgetMap[targetAction] ?? 2;
}

/// Resolved navigation state for the Resident mobile bottom navigation.
class ResidentMobileNavState {
  const ResidentMobileNavState({
    required this.primaryTabs,
    required this.secondaryTabs,
    required this.isMoreActive,
    required this.moreBadgeCount,
    this.activeSecondaryTab,
  });

  final List<ResidentTabDef> primaryTabs;
  final List<ResidentTabDef> secondaryTabs;
  final bool isMoreActive;
  final int moreBadgeCount;
  final ResidentTabDef? activeSecondaryTab;
}

/// Resolves the mobile navigation state (4 primary tabs + 4 secondary tabs + 'More' sheet state).
ResidentMobileNavState resolveResidentMobileNavState({
  String activeTab = 'overview',
  int unreadCount = 0,
  List<ResidentTabDef> tabs = kResidentPortalTabs,
}) {
  final tabMap = {for (final t in tabs) t.id: t};

  final primaryTabs = kPrimaryResidentMobileTabIds
      .map((id) => tabMap[id])
      .whereType<ResidentTabDef>()
      .toList();

  final secondaryTabs = kSecondaryResidentMobileTabIds
      .map((id) => tabMap[id])
      .whereType<ResidentTabDef>()
      .toList();

  final activeSecondaryTab =
      secondaryTabs.where((t) => t.id == activeTab).firstOrNull;
  final isMoreActive = activeSecondaryTab != null;
  final moreBadgeCount = unreadCount < 0 ? 0 : unreadCount;

  return ResidentMobileNavState(
    primaryTabs: primaryTabs,
    secondaryTabs: secondaryTabs,
    isMoreActive: isMoreActive,
    moreBadgeCount: moreBadgeCount,
    activeSecondaryTab: activeSecondaryTab,
  );
}
