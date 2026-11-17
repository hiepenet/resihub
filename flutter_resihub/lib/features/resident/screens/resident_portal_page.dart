import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/layout/resident_shell.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_skeleton.dart';
import '../services/resident_service.dart';
import '../tabs/contact_tab.dart';
import '../tabs/contract_tab.dart';
import '../tabs/invoices_tab.dart';
import '../tabs/maintenance_tab.dart';
import '../tabs/notifications_tab.dart';
import '../tabs/overview_tab.dart';
import '../tabs/profile_tab.dart';
import '../tabs/services_tab.dart';

const List<String> kValidResidentTabs = [
  'overview',
  'contract',
  'invoices',
  'services',
  'maintenance',
  'notifications',
  'contact',
  'profile',
];

/// Mirrors React `VALID_TABS.includes(rawTab) ? rawTab : 'overview'`.
String resolveInitialResidentTab(String? raw) =>
    raw != null && kValidResidentTabs.contains(raw) ? raw : 'overview';

/// Mirrors ResidentPortalPage.jsx:93-109 — only adopt `target_contract_id`
/// when it belongs to the active contracts list and differs from the current.
bool shouldSyncTargetContractId(
  String? target,
  dynamic activeContracts,
  String? current,
) {
  if (target == null || target.isEmpty) return false;
  if (activeContracts is! List) return false;
  final isActive = activeContracts.any((c) =>
      c is Map &&
      (c['contract_id']?.toString() == target || c['id']?.toString() == target));
  return isActive && current != target;
}

/// Promise.allSettled equivalent: records success or failure per future so one
/// rejected fetch never discards the other result.
Future<Map<String, dynamic>> settledResult(Future<dynamic> future) async {
  try {
    return {'ok': true, 'value': await future};
  } catch (e) {
    return {'ok': false, 'error': e};
  }
}

/// Multi-device Resident Portal Page wrapping [ResidentShell].
/// Supports multi-unit apartment switching, prospect reservation onboarding, and deep-linking query parameters.
class ResidentPortalPage extends ConsumerStatefulWidget {
  final String? initialTab;
  final String? contractId;
  final String? targetContractId;
  final String? action;
  final String? invoiceId;
  final String? requestId;
  final String? modal;
  final String? reservationId;
  final String? depositId;
  final String? subscriptionId;
  final String? creditId;

  const ResidentPortalPage({
    super.key = const Key('route:/resident'),
    this.initialTab,
    this.contractId,
    this.targetContractId,
    this.action,
    this.invoiceId,
    this.requestId,
    this.modal,
    this.reservationId,
    this.depositId,
    this.subscriptionId,
    this.creditId,
  });

  @override
  ConsumerState<ResidentPortalPage> createState() => _ResidentPortalPageState();
}

class _ResidentPortalPageState extends ConsumerState<ResidentPortalPage> {
  late String _activeTab;
  /// Tabs already mounted. An [IndexedStack] keeps each tab's State alive via
  /// stable [ValueKey]s, so revisiting does not re-enter initState. Widget
  /// objects are rebuilt each build (not cached) so fresh overview/contract
  /// props reach didUpdateWidget — otherwise switching apartment would feed
  /// stale data to an already-visited tab.
  final Set<String> _visitedTabs = {};
  String? _selectedContractId;
  String? _actionParam;
  late String? _modalParam;
  late String? _requestIdParam;
  late String? _invoiceIdParam;
  late String? _reservationIdParam;
  late String? _depositIdParam;
  late String? _subscriptionIdParam;
  late String? _creditIdParam;

  Map<String, dynamic>? _overview;
  int _openRequestsCount = 0;
  bool _loading = true;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _activeTab = resolveInitialResidentTab(widget.initialTab);
    _visitedTabs.add(_activeTab);
    _selectedContractId = widget.contractId;
    _actionParam = widget.action;
    _modalParam = widget.modal;
    _requestIdParam = widget.requestId;
    _invoiceIdParam = widget.invoiceId;
    _reservationIdParam = widget.reservationId;
    _depositIdParam = widget.depositId;
    _subscriptionIdParam = widget.subscriptionId;
    _creditIdParam = widget.creditId;
    _applyCachedOverview();
    _fetchOverviewData(false);
  }

  void _applyCachedOverview() {
    try {
      final residentService = ref.read(residentServiceProvider);
      final cachedOv = residentService.peekOverview(_selectedContractId);
      final ovData = cachedOv is Map && cachedOv['data'] is Map
          ? Map<String, dynamic>.from(cachedOv['data'] as Map)
          : (cachedOv is Map ? Map<String, dynamic>.from(cachedOv) : null);
      if (ovData != null) {
        final activeContract = ovData['active_contract'] ?? ovData['contract'];
        final contactConfig = ovData['contact_config'] ?? ovData['manager_contact'];
        _overview = {
          ...ovData,
          if (activeContract != null) 'active_contract': activeContract,
          if (contactConfig != null) 'contact_config': contactConfig,
        };
        if (_selectedContractId == null || _selectedContractId!.isEmpty) {
          final firstCid = activeContract is Map
              ? activeContract['contract_id']?.toString()
              : null;
          if (firstCid != null) {
            _selectedContractId = firstCid;
          }
        }
        final target = widget.targetContractId;
        if (shouldSyncTargetContractId(
            target, ovData['active_contracts'], _selectedContractId)) {
          _selectedContractId = target;
        }
        _loading = false;
      }
      final cachedSr = residentService.peekServiceRequests(_selectedContractId);
      if (cachedSr != null) {
        final srList = cachedSr is Map && cachedSr['data'] is List
            ? cachedSr['data'] as List
            : (cachedSr is List ? cachedSr : const []);
        const openStatuses = {
          'NEW',
          'ASSIGNED',
          'IN_PROGRESS',
          'ON_HOLD',
          'REOPENED'
        };
        _openRequestsCount = srList.where((r) {
          if (r is Map) {
            return openStatuses.contains(r['status']?.toString().toUpperCase());
          }
          return false;
        }).length;
      }
    } catch (_) {
      // Safe fallback in standalone tests
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    try {
      final state = GoRouterState.of(context);
      final queryParams = state.uri.queryParameters;
      final qTab = queryParams['tab'];
      if (qTab != null &&
          kValidResidentTabs.contains(qTab) &&
          widget.initialTab == null) {
        _activeTab = qTab;
        _visitedTabs.add(_activeTab);
      }
      final explicitId = queryParams['contract_id'];
      final targetId = queryParams['target_contract_id'];
      String? qContractId;
      if (explicitId != null && explicitId.isNotEmpty) {
        qContractId = explicitId;
      } else if (targetId != null &&
          shouldSyncTargetContractId(
              targetId, _overview?['active_contracts'], _selectedContractId)) {
        qContractId = targetId;
      }
      if (qContractId != null &&
          widget.contractId == null &&
          widget.targetContractId == null) {
        if (_selectedContractId != qContractId) {
          _selectedContractId = qContractId;
          _fetchOverviewData(false);
        }
      }
      final qAction = queryParams['action'];
      if (qAction != null && widget.action == null) {
        _actionParam = qAction;
      }
      // Deep-link params not wired through the router constructor are read
      // straight from the current GoRouter URI (same source React reads).
      void inherit(String key, void Function(String) assign) {
        final value = queryParams[key];
        if (value != null && value.isNotEmpty) assign(value);
      }

      inherit('modal', (v) => _modalParam ??= v);
      inherit('request_id', (v) => _requestIdParam ??= v);
      inherit('invoice_id', (v) => _invoiceIdParam ??= v);
      inherit('reservation_id', (v) => _reservationIdParam ??= v);
      inherit('deposit_id', (v) => _depositIdParam ??= v);
      inherit('subscription_id', (v) => _subscriptionIdParam ??= v);
      inherit('credit_id', (v) => _creditIdParam ??= v);
    } catch (_) {
      // In standalone widget test outside GoRouter, queryParams fallback is safely skipped.
    }
  }

  void _computeOpenRequests(List<dynamic> rows) {
    const openStatuses = {
      'NEW',
      'ASSIGNED',
      'IN_PROGRESS',
      'ON_HOLD',
      'REOPENED'
    };
    final count = rows.where((r) {
      if (r is Map) {
        final st = r['status']?.toString().toUpperCase();
        return openStatuses.contains(st);
      }
      return false;
    }).length;

    if (mounted) {
      setState(() => _openRequestsCount = count);
    }
  }

  Future<void> _fetchOverviewData([bool silent = false]) async {
    if (!silent && _overview == null) setState(() => _loading = true);
    setState(() => _error = '');

    final residentService = ref.read(residentServiceProvider);
    // E11: allSettled - process each result independently so a failed fetch
    // never discards the other one.
    final results = await Future.wait([
      settledResult(residentService.getOverview(_selectedContractId)),
      settledResult(residentService.listServiceRequests(_selectedContractId)),
    ]);

    final ovRes = results[0];
    final srRes = results[1];

    if (!mounted) return;

    if (ovRes['ok'] == true) {
      final raw = ovRes['value'];
      final ovData = raw is Map && raw['data'] is Map
          ? Map<String, dynamic>.from(raw['data'] as Map)
          : (raw is Map ? Map<String, dynamic>.from(raw) : null);

      setState(() {
        if (ovData != null) {
          final activeContract =
              ovData['active_contract'] ?? ovData['contract'];
          final contactConfig =
              ovData['contact_config'] ?? ovData['manager_contact'];
          _overview = {
            ...ovData,
            if (activeContract != null) 'active_contract': activeContract,
            if (contactConfig != null) 'contact_config': contactConfig,
          };

          if (_selectedContractId == null || _selectedContractId!.isEmpty) {
            final firstCid = activeContract is Map
                ? activeContract['contract_id']?.toString()
                : null;
            if (firstCid != null) {
              _selectedContractId = firstCid;
            }
          }

          final target = widget.targetContractId;
          if (shouldSyncTargetContractId(
              target, ovData['active_contracts'], _selectedContractId)) {
            _selectedContractId = target;
          }
        }
        _loading = false;
      });
    } else {
      final msg = extractErrorMessage(
          ovRes['error'], 'Không thể tải dữ liệu Cổng cư dân.');
      setState(() {
        _error = msg;
        _loading = false;
      });
      ref.read(toastProvider.notifier).error(msg);
    }

    if (srRes['ok'] == true) {
      final srList = srRes['value'] is Map &&
              (srRes['value'] as Map)['data'] is List
          ? (srRes['value'] as Map)['data'] as List
          : (srRes['value'] is List ? srRes['value'] as List : const []);
      _computeOpenRequests(srList);
    }
  }

  void _handleNavigateTab(String nextTab, [Map<String, dynamic>? extra]) {
    final safeTab = kValidResidentTabs.contains(nextTab) ? nextTab : 'overview';
    setState(() {
      _activeTab = safeTab;
      _visitedTabs.add(safeTab);
      if (extra != null && extra.containsKey('action')) {
        _actionParam = extra['action']?.toString();
      }
    });
  }

  void _handleSelectContract(String nextContractId) {
    if (_selectedContractId == nextContractId) return;
    setState(() {
      _selectedContractId = nextContractId;
    });
    _fetchOverviewData(false);
  }

  String _computeApartmentBadge() {
    final c = _overview?['active_contract'] ?? _overview?['contract'];
    final rList = _overview?['reservations'] is List
        ? _overview!['reservations'] as List
        : (_overview?['reservation'] != null
            ? [_overview!['reservation']]
            : const []);
    final r =
        rList.isNotEmpty && rList.first is Map ? rList.first as Map : null;
    final extraRsv = rList.length > 1 ? ' (+${rList.length - 1})' : '';
    final app = _overview?['onboarding_application'] ??
        _overview?['pending_application'];

    final cApt = c is Map ? c['apartment_code']?.toString() : null;
    final cBld = c is Map ? c['building_name']?.toString() : null;
    final rApt = r?['apartment_code']?.toString();
    final rBld = r?['building_name']?.toString();
    final appApt =
        app is Map ? app['desired_apartment_code']?.toString() : null;
    final appBld = app is Map ? app['desired_building_name']?.toString() : null;

    if (cApt != null && rApt != null) {
      return 'Căn $cApt${cBld != null ? ' — $cBld' : ''} • Giữ chỗ Căn $rApt${rBld != null ? ' ($rBld)' : ''}$extraRsv';
    }
    if (cApt != null) {
      return 'Căn $cApt${cBld != null ? ' — $cBld' : ''}';
    }
    if (rApt != null) {
      return 'Giữ chỗ Căn $rApt${rBld != null ? ' — $rBld' : ''}$extraRsv';
    }
    if (appApt != null) {
      return 'Đăng ký Căn $appApt${appBld != null ? ' — $appBld' : ''}';
    }
    return 'Tài khoản Cư dân';
  }

  Widget _buildTabContent() {
    if (_loading && _overview == null) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: AppSkeleton(height: 300),
      );
    }

    if (_error.isNotEmpty && _overview == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: AppCard(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(LucideIcons.alertCircle,
                    size: 48, color: AppColors.rose500),
                const SizedBox(height: 12),
                const Text(
                  'Không thể kết nối dữ liệu Cổng cư dân',
                  style: TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: AppColors.slate900,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  _error,
                  textAlign: TextAlign.center,
                  style:
                      const TextStyle(fontSize: 13, color: AppColors.slate500),
                ),
                const SizedBox(height: 16),
                AppButton(
                  text: 'Thử tải lại',
                  icon: const Icon(LucideIcons.refreshCw, size: 14),
                  onPressed: () => _fetchOverviewData(false),
                ),
              ],
            ),
          ),
        ),
      );
    }

    _visitedTabs.add(_activeTab);
    final activeIdx = kValidResidentTabs.indexOf(_activeTab);
    return IndexedStack(
      index: activeIdx >= 0 ? activeIdx : 0,
      children: [
        for (final tab in kValidResidentTabs)
          _visitedTabs.contains(tab) ? _createTab(tab) : const SizedBox.shrink(),
      ],
    );
  }

  Widget _createTab(String tab) {
    switch (tab) {
      case 'overview':
        return OverviewTab(
          key: const ValueKey('overview'),
          overview: _overview,
          openRequestsCount: _openRequestsCount,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
          modalParam: _modalParam,
          reservationIdParam: _reservationIdParam,
        );
      case 'contract':
        return ContractTab(
          key: const ValueKey('contract'),
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
          modalParam: _modalParam,
          depositIdParam: _depositIdParam,
        );
      case 'invoices':
        return InvoicesTab(
          key: const ValueKey('invoices'),
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
          invoiceIdParam: _invoiceIdParam,
          creditIdParam: _creditIdParam,
          modalParam: _modalParam,
        );
      case 'services':
        return ServicesTab(
          key: const ValueKey('services'),
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
          actionParam: _actionParam,
          modalParam: _modalParam,
          subscriptionIdParam: _subscriptionIdParam,
          onClearActionParam: () => setState(() => _actionParam = null),
        );
      case 'maintenance':
        return MaintenanceTab(
          key: const ValueKey('maintenance'),
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
          onRequestsChanged: _computeOpenRequests,
          actionParam: _actionParam,
          onClearActionParam: () => setState(() => _actionParam = null),
          requestIdParam: _requestIdParam,
          modalParam: _modalParam,
        );
      case 'notifications':
        return NotificationsTab(
          key: const ValueKey('notifications'),
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
        );
      case 'contact':
        return ContactTab(
          key: const ValueKey('contact'),
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
        );
      case 'profile':
        return ProfileTab(
          key: const ValueKey('profile'),
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
        );
      default:
        return OverviewTab(
          key: const ValueKey('overview'),
          overview: _overview,
          openRequestsCount: _openRequestsCount,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final rawContracts = _overview?['active_contracts'] is List
        ? _overview!['active_contracts'] as List
        : (_overview?['contracts'] is List
            ? _overview!['contracts'] as List
            : const []);
    final contracts = rawContracts
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();

    return ResidentShell(
      activeTab: _activeTab,
      onTabSelected: (tab) => _handleNavigateTab(tab),
      contracts: contracts,
      selectedContractId: _selectedContractId,
      onContractChanged: _handleSelectContract,
      apartmentBadge: _computeApartmentBadge(),
      child: _buildTabContent(),
    );
  }
}
