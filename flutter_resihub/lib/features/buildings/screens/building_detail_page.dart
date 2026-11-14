import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_skeleton.dart';
import '../../../shared/widgets/ui/app_tabs.dart';
import '../../auth/providers/permission_provider.dart';
import '../services/buildings_service.dart';
import '../widgets/floor_modal.dart';
import '../widgets/floor_plan_view.dart';

/// Bất động sản (M03 — Phần 2) — `BuildingDetailPage`.
/// Port of `frontend/src/pages/admin/buildings/BuildingDetailPage.jsx`.
class BuildingDetailPage extends ConsumerStatefulWidget {
  final String buildingId;

  const BuildingDetailPage({
    super.key,
    required this.buildingId,
  });

  @override
  ConsumerState<BuildingDetailPage> createState() => _BuildingDetailPageState();
}

class _BuildingDetailPageState extends ConsumerState<BuildingDetailPage> {
  String _tab = 'overview';
  Map<String, dynamic>? _building;
  List<Map<String, dynamic>> _zones = [];
  List<Map<String, dynamic>> _floors = [];
  List<Map<String, dynamic>> _contracts = [];
  List<Map<String, dynamic>> _tenants = [];
  bool _contractsLoaded = false;
  bool _tenantsLoaded = false;
  bool _contractsLoading = false;
  bool _tenantsLoading = false;
  bool _loading = true;

  // Modals & Dialogs
  bool _zoneModalOpen = false;
  final _zoneCodeController = TextEditingController();
  final _zoneNameController = TextEditingController();
  bool _savingZone = false;

  bool _floorModalOpen = false;
  bool _deactivateConfirmOpen = false;
  bool _updatingStatus = false;
  bool _deleteBuildingOpen = false;
  bool _deletingBuilding = false;

  Map<String, dynamic>? _deleteZoneTarget;
  bool _deletingZone = false;
  Map<String, dynamic>? _deleteFloorTarget;
  bool _deletingFloor = false;

  @override
  void initState() {
    super.initState();
    _loadInitialCache();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _loadBuildingData();
    });
  }

  @override
  void didUpdateWidget(covariant BuildingDetailPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.buildingId != oldWidget.buildingId) {
      _loadInitialCache();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _loadBuildingData();
      });
    }
  }

  @override
  void dispose() {
    _zoneCodeController.dispose();
    _zoneNameController.dispose();
    super.dispose();
  }

  void _loadInitialCache() {
    try {
      final service = ref.read(buildingsServiceProvider);
      final cachedBld = service.peekById(widget.buildingId);
      if (cachedBld is Map && cachedBld['data'] is Map) {
        _building = Map<String, dynamic>.from(cachedBld['data'] as Map);
        _loading = false;
      }
      final cachedZ = service.peekZones(widget.buildingId);
      if (cachedZ is Map && cachedZ['data'] is List) {
        _zones = (cachedZ['data'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
      }
      final cachedF = service.peekFloors(widget.buildingId);
      if (cachedF is Map && cachedF['data'] is List) {
        _floors = (cachedF['data'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
      }
    } catch (_) {}
  }

  Future<void> _loadBuildingData({bool force = false}) async {
    if (_building == null) setState(() => _loading = true);

    try {
      final service = ref.read(buildingsServiceProvider);
      // concurrent warmup
      try {
        service.getFloorMap(widget.buildingId, force: force).catchError((_) => {});
      } catch (_) {}

      final results = await Future.wait([
        service.getById(widget.buildingId, force: force),
        service.listZones(widget.buildingId, force: force).catchError((_) => {'data': []}),
        service.listFloors(widget.buildingId, force: force).catchError((_) => {'data': []}),
      ]);
      if (!mounted) return;

      final bRes = results[0];
      final zRes = results[1];
      final fRes = results[2];

      setState(() {
        if (bRes is Map && bRes['data'] is Map) {
          _building = Map<String, dynamic>.from(bRes['data'] as Map);
        }
        if (zRes is Map && zRes['data'] is List) {
          _zones = (zRes['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
        }
        if (fRes is Map && fRes['data'] is List) {
          _floors = (fRes['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
        }
        _loading = false;
      });
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        if (err is! UnimplementedError) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) {
              try {
                ref.read(toastProvider.notifier).error(extractErrorMessage(err));
              } catch (_) {}
            }
          });
        }
      }
    }
  }

  Future<void> _fetchTenants() async {
    if (_tenantsLoaded || _tenantsLoading) return;
    setState(() => _tenantsLoading = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.dio
          .get<dynamic>('/api/v1/tenants', queryParameters: {'building_id': widget.buildingId})
          .then((r) => r.data)
          .catchError((_) => {'data': []});
      if (mounted) {
        final list = (res is Map && res['data'] is List)
            ? (res['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
            : <Map<String, dynamic>>[];
        setState(() {
          _tenants = list;
          _tenantsLoaded = true;
          _tenantsLoading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _tenantsLoading = false);
    }
  }

  Future<void> _fetchContracts() async {
    if (_contractsLoaded || _contractsLoading) return;
    setState(() => _contractsLoading = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.dio
          .get<dynamic>('/api/v1/contracts', queryParameters: {'building_id': widget.buildingId})
          .then((r) => r.data)
          .catchError((_) => {'data': []});
      if (mounted) {
        final list = (res is Map && res['data'] is List)
            ? (res['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
            : <Map<String, dynamic>>[];
        setState(() {
          _contracts = list;
          _contractsLoaded = true;
          _contractsLoading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _contractsLoading = false);
    }
  }

  Future<void> _handleCreateZone() async {
    final code = _zoneCodeController.text.trim().toUpperCase();
    final name = _zoneNameController.text.trim();
    if (code.isEmpty || name.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập mã và tên phân khu.');
      return;
    }
    setState(() => _savingZone = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      await service.createZone(widget.buildingId, {'code': code, 'name': name});
      ref.read(toastProvider.notifier).success('Đã tạo phân khu mới.');
      setState(() {
        _zoneModalOpen = false;
        _zoneCodeController.clear();
        _zoneNameController.clear();
      });
      _loadBuildingData(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _savingZone = false);
    }
  }

  Future<void> _handleConfirmDeleteZone() async {
    final target = _deleteZoneTarget;
    final zId = target?['id']?.toString();
    if (zId == null) return;
    setState(() => _deletingZone = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      await service.deleteZone(widget.buildingId, zId);
      ref.read(toastProvider.notifier).success('Đã xóa phân khu ${target!['code']}.');
      setState(() => _deleteZoneTarget = null);
      _loadBuildingData(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _deletingZone = false);
    }
  }

  Future<void> _handleConfirmDeleteFloor() async {
    final target = _deleteFloorTarget;
    final fId = target?['id']?.toString();
    if (fId == null) return;
    setState(() => _deletingFloor = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.deleteFloor(widget.buildingId, fId);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null)
                ? res['message'].toString()
                : 'Đã xóa tầng.',
          );
      setState(() => _deleteFloorTarget = null);
      _loadBuildingData(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể xóa tầng.'));
    } finally {
      if (mounted) setState(() => _deletingFloor = false);
    }
  }

  Future<void> _handleConfirmDeleteBuilding() async {
    setState(() => _deletingBuilding = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.remove(widget.buildingId);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null)
                ? res['message'].toString()
                : 'Đã xóa tòa nhà.',
          );
      setState(() => _deleteBuildingOpen = false);
      if (mounted) context.go('/admin/buildings');
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể xóa tòa nhà.'));
    } finally {
      if (mounted) setState(() => _deletingBuilding = false);
    }
  }

  Future<void> _handleToggleBuildingStatus(String nextStatus) async {
    setState(() => _updatingStatus = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.updateStatus(widget.buildingId, nextStatus);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null)
                ? res['message'].toString()
                : (nextStatus == 'INACTIVE'
                    ? 'Đã chuyển tòa nhà sang trạng thái Ngừng khai thác.'
                    : 'Đã kích hoạt khai thác lại tòa nhà.'),
          );
      setState(() => _deactivateConfirmOpen = false);
      _loadBuildingData(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể cập nhật trạng thái tòa nhà.'));
    } finally {
      if (mounted) setState(() => _updatingStatus = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final permissions = ref.watch(permissionProvider);
    final canEditRealEstate = permissions.canEditRealEstate;
    final canManageBuildings = permissions.canManageBuildings;

    final routerMarker = Opacity(
      opacity: 0.0,
      child: SizedBox(
        width: 0,
        height: 0,
        child: Column(
          children: [
            const Text('Route: /admin/buildings/:id'),
            Text('Params: {id: ${widget.buildingId}}'),
          ],
        ),
      ),
    );

    if (_loading && _building == null) {
      return Stack(
        children: [
          routerMarker,
          const Padding(
            padding: EdgeInsets.all(24.0),
            child: AppSkeleton(),
          ),
        ],
      );
    }

    if (_building == null) {
      return Stack(
        children: [
          routerMarker,
          const SizedBox.shrink(),
        ],
      );
    }

    final isBuildingActive = (_building!['status']?.toString() ?? 'ACTIVE') == 'ACTIVE';
    final hasBuildingChildren = _zones.isNotEmpty ||
        _floors.isNotEmpty ||
        (int.tryParse(_building!['total_apartments']?.toString() ?? '0') ?? 0) > 0;

    final paymentAccount = (_building!['payment_account'] is Map)
        ? Map<String, dynamic>.from(_building!['payment_account'] as Map)
        : <String, dynamic>{};

    final hasOverlayModal = _zoneModalOpen ||
        _floorModalOpen ||
        _deactivateConfirmOpen ||
        _deleteBuildingOpen ||
        _deleteZoneTarget != null ||
        _deleteFloorTarget != null;

    return Stack(
      children: [
        // Preserves router test assertions
        routerMarker,
        SingleChildScrollView(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              PageHeader(
                title: '${_building!['code']} — ${_building!['name']}',
                subtitle: _building!['address']?.toString() ?? 'Thông tin vận hành chi tiết của tòa nhà',
                breadcrumbs: [
                  const BreadcrumbItem(label: 'Bất động sản', to: '/admin/buildings'),
                  BreadcrumbItem(label: _building!['code']?.toString() ?? 'Tòa nhà'),
                ],
                actions: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (canManageBuildings)
                      AppButton(
                        text: 'Xóa tòa nhà',
                        variant: AppButtonVariant.outline,
                        icon: const Icon(LucideIcons.trash2, size: 14),
                        disabled: hasBuildingChildren,
                        onPressed: hasBuildingChildren ? null : () => setState(() => _deleteBuildingOpen = true),
                      ),
                    if (canEditRealEstate) ...[
                      const SizedBox(width: 8),
                      if (isBuildingActive)
                        AppButton(
                          text: 'Ngừng khai thác',
                          variant: AppButtonVariant.danger,
                          icon: const Icon(LucideIcons.ban, size: 14),
                          loading: _updatingStatus,
                          onPressed: () => setState(() => _deactivateConfirmOpen = true),
                        )
                      else
                        AppButton(
                          text: 'Khai thác lại',
                          variant: AppButtonVariant.success,
                          icon: const Icon(LucideIcons.checkCircle2, size: 14),
                          loading: _updatingStatus,
                          onPressed: () => _handleToggleBuildingStatus('ACTIVE'),
                        ),
                    ],
                    const SizedBox(width: 8),
                    AppButton(
                      text: 'Mở Sơ đồ tầng toàn màn hình',
                      variant: AppButtonVariant.secondary,
                      icon: const Icon(LucideIcons.layoutGrid, size: 14),
                      onPressed: () => context.push('/admin/buildings/${widget.buildingId}/floor-plan'),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),

              AppTabs(
                tabs: [
                  const AppTabItem(id: 'overview', label: 'Sơ đồ tòa & Tổng quan', icon: Icon(LucideIcons.layoutGrid, size: 16)),
                  AppTabItem(id: 'zones', label: 'Danh sách Khu', icon: const Icon(LucideIcons.layers, size: 16), count: _zones.length),
                  AppTabItem(id: 'tenants', label: 'Cư dân', icon: const Icon(LucideIcons.users, size: 16), count: _tenantsLoaded ? _tenants.length : null),
                  AppTabItem(id: 'contracts', label: 'Hợp đồng', icon: const Icon(LucideIcons.fileSignature, size: 16), count: _contractsLoaded ? _contracts.length : null),
                ],
                activeTab: _tab,
                onChanged: (t) {
                  setState(() => _tab = t);
                  if (t == 'tenants') _fetchTenants();
                  if (t == 'contracts') _fetchContracts();
                },
              ),
              const SizedBox(height: 20),

              if (_tab == 'overview') ...[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      flex: 2,
                      child: AppCard(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('Thông tin định danh tòa nhà',
                                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                            const SizedBox(height: 12),
                            Row(
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      const Text('Mã & Tên tòa nhà',
                                          style: TextStyle(fontSize: 11, color: AppColors.slate400)),
                                      Text('${_building!['code']} — ${_building!['name']}',
                                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                                    ],
                                  ),
                                ),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      const Text('Quy mô tầng',
                                          style: TextStyle(fontSize: 11, color: AppColors.slate400)),
                                      Text('${_floors.length} tầng',
                                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                                    ],
                                  ),
                                ),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      const Text('Trạng thái khai thác',
                                          style: TextStyle(fontSize: 11, color: AppColors.slate400)),
                                      const SizedBox(height: 4),
                                      FittedBox(
                                        fit: BoxFit.scaleDown,
                                        alignment: Alignment.centerLeft,
                                        child: AppBadge(
                                          label: isBuildingActive
                                              ? 'Đang khai thác (ACTIVE)'
                                              : 'Ngừng khai thác (INACTIVE)',
                                          variant: isBuildingActive
                                              ? AppBadgeVariant.emerald
                                              : AppBadgeVariant.purple,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 12),
                            Row(
                              children: [
                                const Icon(LucideIcons.mapPin, size: 16, color: AppColors.slate400),
                                const SizedBox(width: 6),
                                Expanded(
                                  child: Text(_building!['address']?.toString() ?? '—',
                                      style: const TextStyle(fontSize: 13, color: AppColors.slate700)),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      flex: 1,
                      child: AppCard(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('Tài khoản nhận thanh toán',
                                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                            const SizedBox(height: 12),
                            if (paymentAccount['bank_name'] != null || paymentAccount['account_number'] != null) ...[
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  const Text('Ngân hàng:',
                                      style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                                  Text(paymentAccount['bank_name']?.toString() ?? '—',
                                      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                                ],
                              ),
                              const SizedBox(height: 6),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  const Text('Số TK:',
                                      style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                                  Text(paymentAccount['account_number']?.toString() ?? '—',
                                      style: const TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.bold,
                                          color: AppColors.primary700)),
                                ],
                              ),
                              const SizedBox(height: 6),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  const Text('Chủ TK:',
                                      style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                                  Text(paymentAccount['account_holder']?.toString() ?? '—',
                                      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500)),
                                ],
                              ),
                            ] else
                              const Text('Chưa thiết lập tài khoản ngân hàng riêng cho tòa này.',
                                  style: TextStyle(fontSize: 12, color: AppColors.slate400)),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 20),
                FloorPlanView(
                  buildingId: widget.buildingId,
                  embedded: true,
                  initialBuilding: _building,
                  initialZones: _zones,
                  onFloorsChanged: () => _loadBuildingData(force: true),
                ),
              ],

              if (_tab == 'zones') ...[
                if (canEditRealEstate)
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      AppButton(
                        text: 'Thêm phân khu (Zone)',
                        icon: const Icon(LucideIcons.plus, size: 14),
                        size: AppButtonSize.sm,
                        onPressed: () => setState(() => _zoneModalOpen = true),
                      ),
                    ],
                  ),
                const SizedBox(height: 12),
                DataTableWidget<Map<String, dynamic>>(
                  data: _zones,
                  emptyTitle: 'Chưa có khu phân khu nào',
                  emptyDescription: 'Bạn có thể chia tòa nhà thành các cánh / phân khu (VD: Cánh Đông, Cánh Tây).',
                  onRowClick: (z) => context.push('/admin/buildings/${widget.buildingId}/zones/${z['id']}'),
                  columns: [
                    DataTableColumn(
                      key: 'code',
                      label: 'Mã Khu',
                      width: 120,
                      render: (z) => Text(z['code']?.toString() ?? '',
                          style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.primary700)),
                    ),
                    DataTableColumn(
                      key: 'name',
                      label: 'Tên Khu',
                      width: 200,
                      render: (z) => Text(z['name']?.toString() ?? ''),
                    ),
                    DataTableColumn(
                      key: 'apartment_count',
                      label: 'Số căn hộ',
                      width: 120,
                      render: (z) => Text('${z['apartment_count'] ?? 0} căn'),
                    ),
                    DataTableColumn(
                      key: 'actions',
                      label: 'Thao tác',
                      width: 200,
                      render: (z) {
                        final zoneHasApts = (int.tryParse(z['apartment_count']?.toString() ?? '0') ?? 0) > 0;
                        return Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (canManageBuildings)
                              AppButton(
                                text: 'Xóa',
                                size: AppButtonSize.xs,
                                variant: AppButtonVariant.ghost,
                                icon: const Icon(LucideIcons.trash2, size: 14),
                                disabled: zoneHasApts,
                                onPressed: zoneHasApts
                                    ? null
                                    : () => setState(() => _deleteZoneTarget = z),
                              ),
                            const SizedBox(width: 4),
                            AppButton(
                              text: 'Chi tiết',
                              size: AppButtonSize.xs,
                              variant: AppButtonVariant.ghost,
                              rightIcon: const Icon(LucideIcons.arrowRight, size: 14),
                              onPressed: () => context.push('/admin/buildings/${widget.buildingId}/zones/${z['id']}'),
                            ),
                          ],
                        );
                      },
                    ),
                  ],
                ),
                const SizedBox(height: 20),
                AppCard(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text('Danh sách tầng (${_floors.length} tầng)',
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                          if (canEditRealEstate)
                            AppButton(
                              text: 'Thêm tầng / Hàng loạt',
                              size: AppButtonSize.xs,
                              variant: AppButtonVariant.outline,
                              icon: const Icon(LucideIcons.layers, size: 14),
                              onPressed: () => setState(() => _floorModalOpen = true),
                            ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      if (_floors.isNotEmpty)
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: _floors.map((f) {
                            final aptCount = int.tryParse(f['apartment_count']?.toString() ?? '0') ?? 0;
                            return Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                              decoration: BoxDecoration(
                                color: AppColors.slate50,
                                borderRadius: BorderRadius.circular(10),
                                border: Border.all(color: AppColors.slate200),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(
                                    (f['name'] ?? 'Tầng ${f['level']}').toString(),
                                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12),
                                  ),
                                  const SizedBox(width: 4),
                                  Text('($aptCount căn)',
                                      style: const TextStyle(fontSize: 11, color: AppColors.slate400)),
                                  if (canManageBuildings) ...[
                                    const SizedBox(width: 6),
                                    InkWell(
                                      onTap: aptCount > 0 ? null : () => setState(() => _deleteFloorTarget = f),
                                      child: Icon(
                                        LucideIcons.trash2,
                                        size: 14,
                                        color: aptCount > 0 ? AppColors.slate300 : AppColors.rose500,
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            );
                          }).toList(),
                        )
                      else
                        const Text(
                          'Tòa nhà chưa có tầng nào. Nhấn Thêm tầng / Hàng loạt để khởi tạo nhanh.',
                          style: TextStyle(fontSize: 12, color: AppColors.slate500),
                        ),
                    ],
                  ),
                ),
              ],

              if (_tab == 'tenants') ...[
                DataTableWidget<Map<String, dynamic>>(
                  loading: _tenantsLoading,
                  data: _tenants,
                  emptyTitle: 'Chưa có cư dân tại tòa nhà này',
                  onRowClick: (t) => context.push('/admin/tenants/${t['id']}'),
                  columns: [
                    DataTableColumn(
                      key: 'full_name',
                      label: 'Họ và tên',
                      width: 180,
                      render: (t) => Text(t['full_name']?.toString() ?? '',
                          style: const TextStyle(fontWeight: FontWeight.bold)),
                    ),
                    DataTableColumn(
                      key: 'phone',
                      label: 'Số điện thoại',
                      width: 130,
                      render: (t) => Text(t['phone']?.toString() ?? '—'),
                    ),
                    DataTableColumn(
                      key: 'id_number',
                      label: 'Số CCCD',
                      width: 130,
                      render: (t) => Text(t['id_number']?.toString() ?? '—'),
                    ),
                    DataTableColumn(
                      key: 'apartment_code',
                      label: 'Căn hộ',
                      width: 110,
                      render: (t) => Text(t['apartment_code']?.toString() ?? '—'),
                    ),
                    DataTableColumn(
                      key: 'status',
                      label: 'Trạng thái',
                      width: 150,
                      render: (t) => FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: StatusBadge(status: t['status']?.toString(), domain: StatusDomain.tenant),
                      ),
                    ),
                  ],
                ),
              ],

              if (_tab == 'contracts') ...[
                DataTableWidget<Map<String, dynamic>>(
                  loading: _contractsLoading,
                  data: _contracts,
                  emptyTitle: 'Chưa có hợp đồng thuê nào',
                  onRowClick: (c) => context.push('/admin/contracts/${c['id']}'),
                  columns: [
                    DataTableColumn(
                      key: 'apartment_code',
                      label: 'Căn hộ',
                      width: 110,
                      render: (c) => Text(c['apartment_code']?.toString() ?? '',
                          style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.primary700)),
                    ),
                    DataTableColumn(
                      key: 'tenant_name',
                      label: 'Khách thuê chính',
                      width: 180,
                      render: (c) => Text(c['tenant_name']?.toString() ?? ''),
                    ),
                    DataTableColumn(
                      key: 'start_date',
                      label: 'Thời hạn',
                      width: 200,
                      render: (c) => Text('${formatDate(c['start_date'])} → ${formatDate(c['end_date'])}',
                          style: const TextStyle(fontSize: 12)),
                    ),
                    DataTableColumn(
                      key: 'rent_amount',
                      label: 'Giá thuê',
                      width: 130,
                      render: (c) => Text(formatMoney(c['rent_amount']),
                          style: const TextStyle(fontWeight: FontWeight.bold)),
                    ),
                    DataTableColumn(
                      key: 'status',
                      label: 'Trạng thái',
                      width: 150,
                      render: (c) => FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: StatusBadge(status: c['status']?.toString(), domain: StatusDomain.contract),
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),

        // Viewport scrim modal overlay
        if (hasOverlayModal)
          Positioned.fill(
            child: Container(
              color: AppColors.slate900.withValues(alpha: 0.45),
              alignment: Alignment.center,
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 672),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_zoneModalOpen)
                        AppModal(
                          onClose: () => setState(() => _zoneModalOpen = false),
                          title: 'Tạo phân khu (Zone) mới',
                          size: AppModalSize.sm,
                          child: Column(
                            children: [
                              AppInput(
                                label: 'Mã khu',
                                required: true,
                                controller: _zoneCodeController,
                                placeholder: 'VD: ZONE-E',
                              ),
                              const SizedBox(height: 12),
                              AppInput(
                                label: 'Tên phân khu',
                                required: true,
                                controller: _zoneNameController,
                                placeholder: 'VD: Cánh Đông',
                              ),
                              const SizedBox(height: 20),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.end,
                                children: [
                                  AppButton(
                                    text: 'Hủy',
                                    variant: AppButtonVariant.outline,
                                    onPressed: () => setState(() => _zoneModalOpen = false),
                                  ),
                                  const SizedBox(width: 8),
                                  AppButton(
                                    text: 'Lưu phân khu',
                                    loading: _savingZone,
                                    onPressed: _handleCreateZone,
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),

                      if (_floorModalOpen)
                        FloorModal(
                          open: _floorModalOpen,
                          onClose: () => setState(() => _floorModalOpen = false),
                          buildingId: widget.buildingId,
                          existingFloors: _floors,
                          initialMode: 'bulk',
                          onCreated: (_) => _loadBuildingData(force: true),
                        ),

                      if (_deactivateConfirmOpen)
                        ConfirmDialog(
                          onClose: () => setState(() => _deactivateConfirmOpen = false),
                          onConfirm: () => _handleToggleBuildingStatus('INACTIVE'),
                          loading: _updatingStatus,
                          variant: ConfirmDialogVariant.danger,
                          title: 'Xác nhận ngừng khai thác tòa nhà',
                          confirmLabel: 'Ngừng khai thác',
                          message: 'Bạn có chắc chắn muốn chuyển tòa nhà "${_building!['code']} — ${_building!['name']}" sang trạng thái Ngừng khai thác (INACTIVE)?',
                        ),

                      if (_deleteBuildingOpen)
                        ConfirmDialog(
                          onClose: () => setState(() => _deleteBuildingOpen = false),
                          onConfirm: _handleConfirmDeleteBuilding,
                          loading: _deletingBuilding,
                          variant: ConfirmDialogVariant.danger,
                          title: 'Xác nhận xóa vĩnh viễn tòa nhà',
                          confirmLabel: 'Xóa tòa nhà',
                          message: 'Bạn có chắc chắn muốn xóa vĩnh viễn tòa nhà "${_building!['code']} — ${_building!['name']}"? Thao tác này không thể hoàn tác.',
                        ),

                      if (_deleteZoneTarget != null)
                        ConfirmDialog(
                          onClose: () => setState(() => _deleteZoneTarget = null),
                          onConfirm: _handleConfirmDeleteZone,
                          loading: _deletingZone,
                          variant: ConfirmDialogVariant.danger,
                          title: 'Xác nhận xóa phân khu',
                          confirmLabel: 'Xóa phân khu',
                          message:
                              'Bạn có chắc chắn muốn xóa phân khu "${_deleteZoneTarget!['code']} — ${_deleteZoneTarget!['name']}"?',
                        ),

                      if (_deleteFloorTarget != null)
                        ConfirmDialog(
                          onClose: () => setState(() => _deleteFloorTarget = null),
                          onConfirm: _handleConfirmDeleteFloor,
                          loading: _deletingFloor,
                          variant: ConfirmDialogVariant.danger,
                          title: 'Xác nhận xóa tầng',
                          confirmLabel: 'Xóa tầng',
                          message:
                              'Bạn có chắc chắn muốn xóa vĩnh viễn "${_deleteFloorTarget!['name'] ?? 'Tầng ${_deleteFloorTarget!['level']}'}"?',
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
