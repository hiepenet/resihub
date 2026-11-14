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

  const ResidentPortalPage({
    super.key = const Key('route:/resident'),
    this.initialTab,
    this.contractId,
    this.targetContractId,
    this.action,
    this.invoiceId,
    this.requestId,
    this.modal,
  });

  @override
  ConsumerState<ResidentPortalPage> createState() => _ResidentPortalPageState();
}

class _ResidentPortalPageState extends ConsumerState<ResidentPortalPage> {
  late String _activeTab;
  String? _selectedContractId;
  String? _actionParam;

  Map<String, dynamic>? _overview;
  int _openRequestsCount = 0;
  bool _loading = true;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _activeTab = widget.initialTab ?? 'overview';
    _selectedContractId = widget.contractId ?? widget.targetContractId;
    _actionParam = widget.action;
    _fetchOverviewData(false);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    try {
      final state = GoRouterState.of(context);
      final queryParams = state.uri.queryParameters;
      final qTab = queryParams['tab'];
      if (qTab != null && kValidResidentTabs.contains(qTab) && widget.initialTab == null) {
        _activeTab = qTab;
      }
      final qContractId = queryParams['contract_id'] ?? queryParams['target_contract_id'];
      if (qContractId != null &&
          qContractId.isNotEmpty &&
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
    } catch (_) {
      // In standalone widget test outside GoRouter, queryParams fallback is safely skipped.
    }
  }

  void _computeOpenRequests(List<dynamic> rows) {
    const openStatuses = {'NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'};
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
    if (!silent) setState(() => _loading = true);
    setState(() => _error = '');

    try {
      final residentService = ref.read(residentServiceProvider);
      final results = await Future.wait([
        residentService.getOverview(_selectedContractId),
        residentService.listServiceRequests(_selectedContractId),
      ]);

      final ovRes = results[0];
      final srRes = results[1];

      final ovData = ovRes is Map && ovRes['data'] is Map
          ? Map<String, dynamic>.from(ovRes['data'] as Map)
          : (ovRes is Map ? Map<String, dynamic>.from(ovRes) : null);

      if (mounted) {
        setState(() {
          if (ovData != null) {
            final activeContract = ovData['active_contract'] ?? ovData['contract'];
            final contactConfig = ovData['contact_config'] ?? ovData['manager_contact'];
            _overview = {
              ...ovData,
              if (activeContract != null) 'active_contract': activeContract,
              if (contactConfig != null) 'contact_config': contactConfig,
            };

            // Set initial selected contract id if not already selected
            if (_selectedContractId == null || _selectedContractId!.isEmpty) {
              final firstCid = activeContract is Map ? activeContract['contract_id']?.toString() : null;
              if (firstCid != null) {
                _selectedContractId = firstCid;
              }
            }
          }
          _loading = false;
        });

        final srList = srRes is Map && srRes['data'] is List
            ? srRes['data'] as List
            : (srRes is List ? srRes : const []);
        _computeOpenRequests(srList);
      }
    } catch (err) {
      if (mounted) {
        final msg = extractErrorMessage(err, 'Không thể tải dữ liệu Cổng cư dân.');
        setState(() {
          _error = msg;
          _loading = false;
        });
        ref.read(toastProvider.notifier).error(msg);
      }
    }
  }

  void _handleNavigateTab(String nextTab, [Map<String, dynamic>? extra]) {
    final safeTab = kValidResidentTabs.contains(nextTab) ? nextTab : 'overview';
    setState(() {
      _activeTab = safeTab;
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
        : (_overview?['reservation'] != null ? [_overview!['reservation']] : const []);
    final r = rList.isNotEmpty && rList.first is Map ? rList.first as Map : null;
    final extraRsv = rList.length > 1 ? ' (+${rList.length - 1})' : '';
    final app = _overview?['onboarding_application'] ?? _overview?['pending_application'];

    final cApt = c is Map ? c['apartment_code']?.toString() : null;
    final cBld = c is Map ? c['building_name']?.toString() : null;
    final rApt = r?['apartment_code']?.toString();
    final rBld = r?['building_name']?.toString();
    final appApt = app is Map ? app['desired_apartment_code']?.toString() : null;
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
                const Icon(LucideIcons.alertCircle, size: 48, color: AppColors.rose500),
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
                  style: const TextStyle(fontSize: 13, color: AppColors.slate500),
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

    switch (_activeTab) {
      case 'overview':
        return OverviewTab(
          overview: _overview,
          openRequestsCount: _openRequestsCount,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
        );
      case 'contract':
        return ContractTab(
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
        );
      case 'invoices':
        return InvoicesTab(
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
          invoiceIdParam: widget.invoiceId,
        );
      case 'services':
        return ServicesTab(
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
        );
      case 'maintenance':
        return MaintenanceTab(
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
          onRequestsChanged: _computeOpenRequests,
          actionParam: _actionParam,
          onClearActionParam: () => setState(() => _actionParam = null),
        );
      case 'notifications':
        return NotificationsTab(
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
        );
      case 'contact':
        return ContactTab(
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
        );
      case 'profile':
        return ProfileTab(
          overview: _overview,
          onRefreshOverview: () => _fetchOverviewData(true),
          onNavigateTab: _handleNavigateTab,
        );
      default:
        return OverviewTab(
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
        : (_overview?['contracts'] is List ? _overview!['contracts'] as List : const []);
    final contracts = rawContracts.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();

    return ResidentShell(
      activeTab: _activeTab,
      onTabSelected: (tab) => _handleNavigateTab(tab),
      contracts: contracts,
      selectedContractId: _selectedContractId,
      onContractChanged: _handleSelectContract,
      apartmentBadge: _computeApartmentBadge(),
      badgeCounts: {
        'maintenance': _openRequestsCount,
      },
      child: _buildTabContent(),
    );
  }
}
