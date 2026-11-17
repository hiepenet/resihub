import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/bank_select.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/search_bar_widget.dart';
import '../../../shared/widgets/common/stats_card.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_skeleton.dart';
import '../../auth/providers/permission_provider.dart';
import '../providers/buildings_lookup_provider.dart';
import '../services/buildings_service.dart';

/// Bất động sản (M03 — Phần 1) — `BuildingsPage`.
/// Port of `frontend/src/pages/admin/buildings/BuildingsPage.jsx`.
class BuildingsPage extends ConsumerStatefulWidget {
  const BuildingsPage({super.key});

  @override
  ConsumerState<BuildingsPage> createState() => _BuildingsPageState();
}

class _BuildingsPageState extends ConsumerState<BuildingsPage> {
  List<Map<String, dynamic>> _buildings = [];
  bool _loading = true;
  String _search = '';

  @override
  void initState() {
    super.initState();
    _loadInitialData();
  }

  void _loadInitialData() {
    try {
      final service = ref.read(buildingsServiceProvider);
      final peeked = service.peekList();
      if (peeked is Map && peeked['data'] is List) {
        _buildings = (peeked['data'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        _loading = false;
      }
    } catch (_) {}
    _fetchBuildings();
  }

  Future<void> _fetchBuildings({bool force = false}) async {
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.list(force: force);
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _buildings = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _loading = false;
        });
      } else if (res is List) {
        setState(() {
          _buildings = res
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _loading = false;
        });
      } else {
        setState(() {
          _buildings = [];
          _loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách tòa nhà.'),
            );
      }
    }
  }

  Future<void> _openCreateModal() async {
    final permissions = ref.read(permissionProvider);
    final service = ref.read(buildingsServiceProvider);
    final success = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => _BuildingFormDialog(
        permissions: permissions,
        service: service,
        onRefreshLiveSync: () => refreshBuildingsSelector(ref),
      ),
    );
    if (success == true) {
      ref.read(toastProvider.notifier).success(
            'Đã tạo tòa nhà mới thành công.',
          );
      _fetchBuildings(force: true);
    }
  }

  Future<void> _openEditModal(Map<String, dynamic> building) async {
    final permissions = ref.read(permissionProvider);
    final service = ref.read(buildingsServiceProvider);
    final success = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => _BuildingFormDialog(
        initialBuilding: building,
        permissions: permissions,
        service: service,
        onRefreshLiveSync: () => refreshBuildingsSelector(ref),
      ),
    );
    if (success == true) {
      ref.read(toastProvider.notifier).success(
            'Đã cập nhật thông tin tòa nhà.',
          );
      _fetchBuildings(force: true);
    }
  }

  Future<void> _handleToggleStatus(Map<String, dynamic> building) async {
    final buildingId = building['id']?.toString() ?? '';
    final currentStatus = building['status']?.toString().toUpperCase() ?? 'ACTIVE';
    final nextStatus = currentStatus == 'INACTIVE' ? 'ACTIVE' : 'INACTIVE';
    final service = ref.read(buildingsServiceProvider);

    try {
      await service.updateStatus(buildingId, nextStatus);
      refreshBuildingsSelector(ref);
      ref.read(toastProvider.notifier).success(
            nextStatus == 'ACTIVE'
                ? 'Đã kích hoạt hoạt động tòa nhà.'
                : 'Đã tạm ngưng hoạt động tòa nhà.',
          );
      _fetchBuildings(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể cập nhật trạng thái tòa nhà.'),
          );
    }
  }

  Future<void> _handleDeleteBuilding(Map<String, dynamic> building) async {
    final buildingId = building['id']?.toString() ?? '';
    final code = building['code'] ?? '';
    final name = building['name'] ?? '';

    final confirmed = await ConfirmDialog.show(
      context: context,
      title: 'Xác nhận xóa tòa nhà',
      message:
          'Bạn có chắc chắn muốn xóa vĩnh viễn tòa nhà "$code — $name"? Thao tác này không thể hoàn tác.',
      confirmLabel: 'Xóa tòa nhà',
      variant: ConfirmDialogVariant.danger,
    );

    if (confirmed == true) {
      try {
        final service = ref.read(buildingsServiceProvider);
        await service.remove(buildingId);
        refreshBuildingsSelector(ref);
        ref.read(toastProvider.notifier).success(
              'Đã xóa tòa nhà $code.',
            );
        _fetchBuildings(force: true);
      } catch (err) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể xóa tòa nhà.'),
            );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final permissions = ref.watch(permissionProvider);

    if (_loading && _buildings.isEmpty) {
      return const PageSkeleton();
    }

    final filtered = _buildings.where((b) {
      if (_search.trim().isEmpty) return true;
      final q = _search.toLowerCase();
      final name = (b['name'] ?? '').toString().toLowerCase();
      final code = (b['code'] ?? '').toString().toLowerCase();
      final address = (b['address'] ?? '').toString().toLowerCase();
      return name.contains(q) || code.contains(q) || address.contains(q);
    }).toList();

    int totalApts = 0;
    int totalOccupied = 0;
    int totalAvailable = 0;
    for (final b in _buildings) {
      totalApts += num.tryParse(b['total_apartments']?.toString() ?? '')?.toInt() ?? 0;
      totalOccupied += num.tryParse(b['occupied_apartments']?.toString() ?? '')?.toInt() ?? 0;
      totalAvailable += num.tryParse(b['available_apartments']?.toString() ?? '')?.toInt() ?? 0;
    }
    final avgOccupancy =
        totalApts > 0 ? (totalOccupied / totalApts * 100).toStringAsFixed(1) : '0.0';

    return Scaffold(
      backgroundColor: AppColors.background,
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Page Header
            PageHeader(
              title: 'Quản lý Bất động sản',
              subtitle:
                  'Danh mục các tòa nhà, khu phân khu, tầng và sơ đồ căn hộ trong phạm vi quản lý',
              actions: permissions.canCreateBuilding
                  ? AppButton(
                      text: 'Thêm tòa nhà mới',
                      icon: const Icon(LucideIcons.plus, size: 16),
                      onPressed: _openCreateModal,
                    )
                  : null,
            ),

            // Summary KPIs
            LayoutBuilder(
              builder: (context, constraints) {
                final isWide = constraints.maxWidth >= 768;
                return isWide
                    ? Row(
                        children: [
                          Expanded(
                            child: StatsCard(
                              title: 'Tổng số tòa nhà',
                              value: _buildings.length,
                              subtext: 'Các tòa trong phạm vi phân quyền',
                              icon: LucideIcons.building2,
                              color: 'sky',
                            ),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: StatsCard(
                              title: 'Tổng quy mô căn hộ',
                              value: totalApts,
                              subtext:
                                  '$totalOccupied đang thuê · $totalAvailable còn trống',
                              icon: LucideIcons.doorOpen,
                              color: 'indigo',
                            ),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: StatsCard(
                              title: 'Tỷ lệ lấp đầy trung bình',
                              value: '$avgOccupancy%',
                              subtext: 'Tính trên tổng quỹ căn hộ khai thác',
                              icon: LucideIcons.layoutGrid,
                              color: 'emerald',
                            ),
                          ),
                        ],
                      )
                    : Column(
                        children: [
                          StatsCard(
                            title: 'Tổng số tòa nhà',
                            value: _buildings.length,
                            subtext: 'Các tòa trong phạm vi phân quyền',
                            icon: LucideIcons.building2,
                            color: 'sky',
                          ),
                          const SizedBox(height: 12),
                          StatsCard(
                            title: 'Tổng quy mô căn hộ',
                            value: totalApts,
                            subtext:
                                '$totalOccupied đang thuê · $totalAvailable còn trống',
                            icon: LucideIcons.doorOpen,
                            color: 'indigo',
                          ),
                          const SizedBox(height: 12),
                          StatsCard(
                            title: 'Tỷ lệ lấp đầy trung bình',
                            value: '$avgOccupancy%',
                            subtext: 'Tính trên tổng quỹ căn hộ khai thác',
                            icon: LucideIcons.layoutGrid,
                            color: 'emerald',
                          ),
                        ],
                      );
              },
            ),

            const SizedBox(height: 24),

            // Search Bar
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: SearchBarWidget(
                value: _search,
                placeholder: 'Tìm theo tên tòa nhà, mã tòa, địa chỉ...',
                onChanged: (val) => setState(() => _search = val),
              ),
            ),

            const SizedBox(height: 20),

            // Building Cards Grid or Empty State
            if (filtered.isEmpty)
              AppCard(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
                  child: Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: AppColors.slate100,
                            borderRadius: BorderRadius.circular(16),
                          ),
                          child: const Icon(
                            LucideIcons.building2,
                            size: 40,
                            color: AppColors.slate400,
                          ),
                        ),
                        const SizedBox(height: 16),
                        const Text(
                          'Không tìm thấy tòa nhà nào',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: AppColors.slate800,
                          ),
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          'Thử thay đổi từ khóa tìm kiếm hoặc thêm tòa nhà mới.',
                          style: TextStyle(fontSize: 13, color: AppColors.slate500),
                        ),
                      ],
                    ),
                  ),
                ),
              )
            else
              LayoutBuilder(
                builder: (context, constraints) {
                  final width = constraints.maxWidth;
                  final crossAxisCount = width >= 1200 ? 3 : (width >= 700 ? 2 : 1);
                  final cardWidth = (width - (crossAxisCount - 1) * 20) / crossAxisCount;

                  return Wrap(
                    spacing: 20,
                    runSpacing: 20,
                    children: filtered.map((b) {
                      return SizedBox(
                        width: cardWidth,
                        child: _BuildingCard(
                          building: b,
                          permissions: permissions,
                          onFloorPlan: () => context.push('/admin/buildings/${b['id']}/floor-plan'),
                          onDetail: () => context.push('/admin/buildings/${b['id']}'),
                          onEdit: () => _openEditModal(b),
                          onToggleStatus: () => _handleToggleStatus(b),
                          onDelete: () => _handleDeleteBuilding(b),
                        ),
                      );
                    }).toList(),
                  );
                },
              ),
          ],
        ),
      ),
    );
  }
}

/// Card component presenting a single building.
class _BuildingCard extends StatelessWidget {
  final Map<String, dynamic> building;
  final PermissionMatrix permissions;
  final VoidCallback onFloorPlan;
  final VoidCallback onDetail;
  final VoidCallback onEdit;
  final VoidCallback onToggleStatus;
  final VoidCallback onDelete;

  const _BuildingCard({
    required this.building,
    required this.permissions,
    required this.onFloorPlan,
    required this.onDetail,
    required this.onEdit,
    required this.onToggleStatus,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final id = building['id']?.toString() ?? '';
    final code = building['code']?.toString() ?? '';
    final name = building['name']?.toString() ?? '';
    final address = building['address']?.toString() ?? '';
    final status = building['status']?.toString().toUpperCase() ?? 'ACTIVE';

    final totalFloors = num.tryParse(building['total_floors']?.toString() ?? '')?.toInt() ?? 0;
    final totalZones = num.tryParse(building['total_zones']?.toString() ?? '')?.toInt() ?? 0;
    final totalApts = num.tryParse(building['total_apartments']?.toString() ?? '')?.toInt() ?? 0;
    final occApts = num.tryParse(building['occupied_apartments']?.toString() ?? '')?.toInt() ?? 0;
    final availApts = num.tryParse(building['available_apartments']?.toString() ?? '')?.toInt() ?? 0;
    final rate = totalApts > 0 ? (occApts / totalApts * 100).round() : 0;

    final hasChildren = totalFloors > 0 || totalZones > 0 || totalApts > 0;

    return InkWell(
      onTap: onDetail,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.slate200),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.04),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Decorative Banner
            Container(
              padding: const EdgeInsets.all(16),
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    Color(0xFF0284C7),
                    Color(0xFF0EA5E9),
                    Color(0xFF4F46E5),
                  ],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.22),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(
                          code,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 0.5,
                          ),
                        ),
                      ),
                      AppBadge(
                        label: status == 'INACTIVE' ? 'Tạm ngưng' : 'Hoạt động',
                        variant: status == 'INACTIVE'
                            ? AppBadgeVariant.slate
                            : AppBadgeVariant.emerald,
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Text(
                    name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      height: 1.25,
                    ),
                  ),
                ],
              ),
            ),

            // Card Body
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Address
                  SizedBox(
                    height: 36,
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Padding(
                          padding: EdgeInsets.only(top: 2),
                          child: Icon(
                            LucideIcons.mapPin,
                            size: 14,
                            color: AppColors.slate400,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            address.isNotEmpty ? address : 'Chưa cập nhật địa chỉ',
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12,
                              color: AppColors.slate500,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: 14),

                  // 3-metric statistics grid
                  Container(
                    padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
                    decoration: BoxDecoration(
                      color: AppColors.slate50,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.slate100),
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            children: [
                              const Text(
                                'Số tầng',
                                style: TextStyle(fontSize: 11, color: AppColors.slate400),
                              ),
                              const SizedBox(height: 2),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  const Icon(
                                    LucideIcons.layers,
                                    size: 13,
                                    color: AppColors.primary500,
                                  ),
                                  const SizedBox(width: 4),
                                  Text(
                                    '$totalFloors',
                                    style: const TextStyle(
                                      fontWeight: FontWeight.bold,
                                      fontSize: 14,
                                      color: AppColors.slate800,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                        Container(
                          width: 1,
                          height: 28,
                          color: AppColors.slate200,
                        ),
                        Expanded(
                          child: Column(
                            children: [
                              const Text(
                                'Đang thuê',
                                style: TextStyle(fontSize: 11, color: AppColors.slate400),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                '$occApts',
                                style: const TextStyle(
                                  fontWeight: FontWeight.bold,
                                  fontSize: 14,
                                  color: AppColors.rose600,
                                ),
                              ),
                            ],
                          ),
                        ),
                        Container(
                          width: 1,
                          height: 28,
                          color: AppColors.slate200,
                        ),
                        Expanded(
                          child: Column(
                            children: [
                              const Text(
                                'Còn trống',
                                style: TextStyle(fontSize: 11, color: AppColors.slate400),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                '$availApts',
                                style: const TextStyle(
                                  fontWeight: FontWeight.bold,
                                  fontSize: 14,
                                  color: AppColors.emerald600,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),

                  const SizedBox(height: 14),

                  // Occupancy Progress
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'Tỷ lệ lấp đầy',
                        style: TextStyle(fontSize: 12, color: AppColors.slate500),
                      ),
                      Text(
                        '$rate% ($occApts/$totalApts căn)',
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: AppColors.slate800,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: LinearProgressIndicator(
                      value: totalApts > 0 ? (rate / 100.0).clamp(0.0, 1.0) : 0.0,
                      minHeight: 6,
                      backgroundColor: AppColors.slate100,
                      valueColor: const AlwaysStoppedAnimation<Color>(AppColors.primary500),
                    ),
                  ),

                  const SizedBox(height: 16),
                  const Divider(height: 1, color: AppColors.slate100),
                  const SizedBox(height: 12),

                  // Card Footer Actions
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Expanded(
                        child: Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            // Sơ đồ tầng
                            AppButton(
                              text: 'Sơ đồ tầng',
                              variant: AppButtonVariant.soft,
                              size: AppButtonSize.xs,
                              icon: const Icon(LucideIcons.layoutGrid, size: 13),
                              onPressed: onFloorPlan,
                            ),

                            // Edit button (SYS_ADMIN or MANAGER)
                            if (permissions.canEditRealEstate)
                              AppButton(
                                text: 'Sửa',
                                variant: AppButtonVariant.ghost,
                                size: AppButtonSize.xs,
                                icon: const Icon(LucideIcons.squarePen, size: 13),
                                onPressed: onEdit,
                              ),

                            // Status Toggle (SYS_ADMIN only)
                            if (permissions.canManageBuildings)
                              AppButton(
                                key: Key('building_status_toggle_$id'),
                                text: status == 'INACTIVE' ? 'Kích hoạt' : 'Tạm ngưng',
                                variant: status == 'INACTIVE'
                                    ? AppButtonVariant.success
                                    : AppButtonVariant.soft,
                                size: AppButtonSize.xs,
                                icon: Icon(
                                  status == 'INACTIVE'
                                      ? LucideIcons.checkCircle2
                                      : LucideIcons.ban,
                                  size: 13,
                                ),
                                onPressed: onToggleStatus,
                              ),

                            // Delete button (SYS_ADMIN only)
                            if (permissions.canManageBuildings)
                              Tooltip(
                                message: hasChildren
                                    ? 'Chỉ được xóa tòa nhà rỗng (chưa có khu, tầng hoặc căn hộ). Vui lòng dùng Ngừng khai thác nếu đã vận hành.'
                                    : 'Xóa tòa nhà rỗng',
                                child: AppButton(
                                  text: 'Xóa',
                                  variant: AppButtonVariant.ghost,
                                  size: AppButtonSize.xs,
                                  disabled: hasChildren,
                                  icon: const Icon(
                                    LucideIcons.trash2,
                                    size: 13,
                                    color: AppColors.rose600,
                                  ),
                                  onPressed: hasChildren ? null : onDelete,
                                ),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      // Chi tiết link
                      InkWell(
                        onTap: onDetail,
                        borderRadius: BorderRadius.circular(4),
                        child: const Padding(
                          padding: EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(
                                'Chi tiết',
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600,
                                  color: AppColors.primary600,
                                ),
                              ),
                              SizedBox(width: 2),
                              Icon(
                                LucideIcons.arrowRight,
                                size: 13,
                                color: AppColors.primary600,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Create / Edit Building Modal Dialog.
class _BuildingFormDialog extends ConsumerStatefulWidget {
  final Map<String, dynamic>? initialBuilding;
  final PermissionMatrix permissions;
  final BuildingsService service;
  final VoidCallback onRefreshLiveSync;

  const _BuildingFormDialog({
    this.initialBuilding,
    required this.permissions,
    required this.service,
    required this.onRefreshLiveSync,
  });

  @override
  ConsumerState<_BuildingFormDialog> createState() => _BuildingFormDialogState();
}

class _BuildingFormDialogState extends ConsumerState<_BuildingFormDialog> {
  late final TextEditingController _nameController;
  late final TextEditingController _codeController;
  late final TextEditingController _addressController;
  late final TextEditingController _accountNumberController;
  late final TextEditingController _accountHolderController;
  late final TextEditingController _ownerIdentifierController;

  final FocusNode _codeFocusNode = FocusNode();

  String _bankName = 'Vietcombank';
  String _bankCode = 'VCB';
  String _bankBin = '970436';
  String _bankLogo = '';

  String _ownerId = '';
  Map<String, dynamic>? _ownerPreview;
  String? _ownerLookupError;
  bool _ownerLookupLoading = false;
  bool _ownerChanged = false;

  Map<String, dynamic>? _codeCheck;
  bool _isSaving = false;

  @override
  void initState() {
    super.initState();
    final b = widget.initialBuilding;
    final pa = b?['payment_account'] is Map
        ? Map<String, dynamic>.from(b!['payment_account'])
        : (b?['lease_terms'] is Map && b!['lease_terms']['payment_account'] is Map
            ? Map<String, dynamic>.from(b['lease_terms']['payment_account'])
            : <String, dynamic>{});

    _nameController = TextEditingController(text: b?['name']?.toString() ?? '');
    _codeController = TextEditingController(text: b?['code']?.toString() ?? '');
    _addressController = TextEditingController(text: b?['address']?.toString() ?? '');
    _accountNumberController =
        TextEditingController(text: pa['account_number']?.toString() ?? '');
    _accountHolderController =
        TextEditingController(text: pa['account_holder']?.toString() ?? '');
    _ownerIdentifierController = TextEditingController();

    _bankName = pa['bank_name']?.toString().isNotEmpty == true
        ? pa['bank_name'].toString()
        : 'Vietcombank';
    _bankCode = pa['bank_code']?.toString() ?? 'VCB';
    _bankBin = pa['bank_bin']?.toString() ?? '970436';
    _bankLogo = pa['bank_logo']?.toString() ?? '';

    _ownerId = b?['owner_id']?.toString() ?? '';
    if (b?['owner_preview'] is Map) {
      _ownerPreview = Map<String, dynamic>.from(b!['owner_preview']);
    }

    _codeFocusNode.addListener(() {
      if (!_codeFocusNode.hasFocus && widget.initialBuilding == null) {
        _handleCodeCheck();
      }
    });
  }

  @override
  void dispose() {
    _codeFocusNode.dispose();
    _nameController.dispose();
    _codeController.dispose();
    _addressController.dispose();
    _accountNumberController.dispose();
    _accountHolderController.dispose();
    _ownerIdentifierController.dispose();
    super.dispose();
  }

  Future<void> _handleCodeCheck() async {
    final code = _codeController.text.trim();
    if (code.isEmpty || widget.initialBuilding != null) return;
    try {
      final res = await widget.service.checkCode(code);
      if (mounted && res is Map) {
        setState(() {
          _codeCheck = Map<String, dynamic>.from(res);
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() => _codeCheck = null);
      }
    }
  }

  Future<Map<String, dynamic>?> _verifyOwnerIdentifier([String? raw]) async {
    final input = (raw ?? _ownerIdentifierController.text).trim();
    if (input.isEmpty) {
      setState(() => _ownerLookupError = null);
      return null;
    }

    final isEmail = input.contains('@');
    if (isEmail) {
      final emailRegex = RegExp(r'^[^@]+@[^@]+\.[^@]+$');
      if (!emailRegex.hasMatch(input)) {
        setState(() {
          _ownerLookupError =
              'Định dạng Email không hợp lệ (ví dụ: chudautu@congty.vn).';
          _ownerPreview = null;
          _ownerId = '';
        });
        return null;
      }
    } else {
      final cleanPhone = input.replaceAll(RegExp(r'\D'), '');
      if (cleanPhone.length != 10 || !cleanPhone.startsWith('0')) {
        setState(() {
          _ownerLookupError =
              'Số điện thoại không đúng định dạng 10 chữ số Việt Nam (ví dụ: 0912345678).';
          _ownerPreview = null;
          _ownerId = '';
        });
        return null;
      }
    }

    setState(() {
      _ownerLookupLoading = true;
      _ownerLookupError = null;
    });

    try {
      final res = await widget.service.lookupOwner(input);
      if (mounted && res is Map && res['found'] == true && res['owner'] is Map) {
        final owner = Map<String, dynamic>.from(res['owner']);
        setState(() {
          _ownerPreview = owner;
          _ownerId = owner['id']?.toString() ?? '';
          _ownerChanged = true;
          _ownerLookupError = null;
          _ownerLookupLoading = false;
        });
        return owner;
      }

      if (mounted) {
        setState(() {
          _ownerPreview = null;
          _ownerId = '';
          _ownerLookupError = (res is Map ? res['message']?.toString() : null) ??
              'Không tìm thấy hồ sơ Chủ đầu tư khớp với thông tin này.';
          _ownerLookupLoading = false;
        });
      }
      return null;
    } catch (err) {
      if (mounted) {
        setState(() {
          _ownerPreview = null;
          _ownerId = '';
          _ownerLookupError = extractErrorMessage(err, 'Không thể kiểm tra thông tin Chủ đầu tư.');
          _ownerLookupLoading = false;
        });
      }
      return null;
    }
  }

  void _handleClearOwner() {
    setState(() {
      _ownerPreview = null;
      _ownerIdentifierController.clear();
      _ownerLookupError = null;
      _ownerChanged = true;
      _ownerId = '';
    });
  }

  Future<void> _handleSubmit() async {
    final name = _nameController.text.trim();
    final code = _codeController.text.trim().toUpperCase();
    final address = _addressController.text.trim();

    if (name.isEmpty || code.isEmpty || address.isEmpty) {
      return;
    }

    final isOwnerReadOnly = widget.permissions.isOwnerFieldLockedForManager(
      widget.initialBuilding?['owner_id']?.toString(),
    );

    String resolvedOwnerId = _ownerId;
    if (!isOwnerReadOnly && _ownerPreview == null && _ownerIdentifierController.text.trim().isNotEmpty) {
      final verified = await _verifyOwnerIdentifier();
      if (verified == null) {
        ref.read(toastProvider.notifier).warning(
              'Email/SĐT Chủ đầu tư chưa hợp lệ hoặc không tìm thấy trong hệ thống. Vui lòng kiểm tra lại hoặc xóa trống ô này nếu chưa gắn Chủ đầu tư.',
            );
        return;
      }
      resolvedOwnerId = verified['id']?.toString() ?? '';
    }

    setState(() => _isSaving = true);

    try {
      final ownerPayload = <String, dynamic>{};
      if (widget.initialBuilding == null) {
        if (resolvedOwnerId.isNotEmpty) {
          ownerPayload['owner_id'] = resolvedOwnerId;
        }
      } else if (widget.permissions.canManageBuildings) {
        if (_ownerChanged) {
          ownerPayload['owner_id'] = resolvedOwnerId.isNotEmpty ? resolvedOwnerId : null;
        }
      } else if ((widget.initialBuilding?['owner_id'] == null ||
              widget.initialBuilding!['owner_id'].toString().isEmpty) &&
          resolvedOwnerId.isNotEmpty) {
        ownerPayload['owner_id'] = resolvedOwnerId;
      }

      final payload = <String, dynamic>{
        'name': name,
        'code': code,
        'address': address,
        ...ownerPayload,
        'payment_account': {
          'bank_name': _bankName.trim(),
          if (_bankCode.isNotEmpty) 'bank_code': _bankCode,
          if (_bankBin.isNotEmpty) 'bank_bin': _bankBin,
          if (_bankLogo.isNotEmpty) 'bank_logo': _bankLogo,
          'account_number': _accountNumberController.text.trim(),
          'account_holder': _accountHolderController.text.trim(),
        },
      };

      if (widget.initialBuilding != null) {
        await widget.service.update(widget.initialBuilding!['id'].toString(), payload);
      } else {
        await widget.service.create(payload);
      }

      widget.onRefreshLiveSync();
      if (mounted) {
        Navigator.of(context).pop(true);
      }
    } catch (err) {
      if (mounted) {
        setState(() => _isSaving = false);
        ref.read(toastProvider.notifier).error(extractErrorMessage(err));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final editing = widget.initialBuilding;
    final isOwnerReadOnly = widget.permissions.isOwnerFieldLockedForManager(
      editing?['owner_id']?.toString(),
    );

    return Dialog(
      backgroundColor: Colors.transparent,
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: 672.0,
          maxHeight: MediaQuery.sizeOf(context).height * 0.9,
        ),
        child: Material(
          color: Colors.transparent,
          child: AppModal(
            title: editing != null ? 'Cập nhật tòa nhà ${editing['code']}' : 'Khởi tạo tòa nhà mới',
            subtitle: 'Thiết lập thông tin định danh, chủ đầu tư sở hữu và tài khoản thụ hưởng',
            size: AppModalSize.lg,
            onClose: () => Navigator.of(context).pop(false),
            footer: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                AppButton(
                  text: 'Hủy bỏ',
                  variant: AppButtonVariant.outline,
                  onPressed: () => Navigator.of(context).pop(false),
                ),
                const SizedBox(width: 10),
                AppButton(
                  text: editing != null ? 'Lưu cập nhật' : 'Tạo tòa nhà',
                  loading: _isSaving,
                  onPressed: _handleSubmit,
                ),
              ],
            ),
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Name & Code
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        flex: 3,
                        child: AppInput(
                          key: const Key('building_name_input'),
                          label: 'Tên tòa nhà',
                          required: true,
                          placeholder: 'VD: Vinhomes Ocean Park - Tòa A',
                          controller: _nameController,
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        flex: 2,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            AppInput(
                              key: const Key('building_code_input'),
                              label: 'Mã tòa nhà',
                              required: true,
                              enabled: editing == null,
                              focusNode: _codeFocusNode,
                              placeholder: 'VD: VOP-A',
                              controller: _codeController,
                            ),
                            if (_codeCheck != null && editing == null) ...[
                              const SizedBox(height: 4),
                              Row(
                                children: [
                                  Icon(
                                    _codeCheck!['available'] == true
                                        ? LucideIcons.checkCircle2
                                        : LucideIcons.circleX,
                                    size: 13,
                                    color: _codeCheck!['available'] == true
                                        ? AppColors.emerald600
                                        : AppColors.rose600,
                                  ),
                                  const SizedBox(width: 4),
                                  Expanded(
                                    child: Text(
                                      _codeCheck!['message']?.toString() ?? '',
                                      style: TextStyle(
                                        fontSize: 11,
                                        color: _codeCheck!['available'] == true
                                            ? AppColors.emerald600
                                            : AppColors.rose600,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),

                  const SizedBox(height: 14),

                  // Address
                  AppInput(
                    key: const Key('building_address_input'),
                    label: 'Địa chỉ chi tiết',
                    required: true,
                    placeholder: 'Số nhà, đường, quận/huyện, tỉnh/thành phố',
                    controller: _addressController,
                  ),

                  const SizedBox(height: 16),

                  // Owner Section (Know-Before-You-Link)
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.slate50,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.slate200),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            const Expanded(
                              child: Row(
                                children: [
                                  Icon(LucideIcons.shieldCheck, size: 16, color: AppColors.primary600),
                                  SizedBox(width: 6),
                                  Flexible(
                                    child: Text(
                                      'Chủ đầu tư sở hữu (OWNER — Tùy chọn)',
                                      style: TextStyle(
                                        fontSize: 12,
                                        fontWeight: FontWeight.w600,
                                        color: AppColors.slate800,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 8),
                            const Text(
                              'Bảo mật danh tính PII',
                              style: TextStyle(fontSize: 11, color: AppColors.slate500),
                            ),
                          ],
                        ),

                        const SizedBox(height: 10),

                        if (isOwnerReadOnly) ...[
                          // Locked state for MANAGER editing building with existing owner
                          Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: AppColors.slate200),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    const Icon(LucideIcons.lock, size: 14, color: AppColors.slate400),
                                    const SizedBox(width: 6),
                                    Text(
                                      _ownerPreview?['masked_name'] ?? 'Đã gắn Chủ đầu tư',
                                      style: const TextStyle(
                                        fontWeight: FontWeight.w600,
                                        fontSize: 13,
                                        color: AppColors.slate800,
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  'Email: ${_ownerPreview?['masked_email'] ?? '—'} · SĐT: ${_ownerPreview?['masked_phone'] ?? '—'}',
                                  style: const TextStyle(fontSize: 12, color: AppColors.slate500),
                                ),
                                const SizedBox(height: 4),
                                const Text(
                                  'Tòa nhà đã gắn Chủ đầu tư. Theo phân quyền PRD (FR-070), chỉ Quản trị hệ thống (SYS_ADMIN) mới được chuyển nhượng Chủ sở hữu.',
                                  style: TextStyle(fontSize: 11, color: AppColors.amber700),
                                ),
                              ],
                            ),
                          ),
                        ] else if (_ownerPreview != null) ...[
                          // Verified preview state
                          Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: const Color(0xFFECFDF5),
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: const Color(0xFFA7F3D0)),
                            ),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        children: [
                                          const Icon(
                                            LucideIcons.checkCircle2,
                                            size: 15,
                                            color: AppColors.emerald600,
                                          ),
                                          const SizedBox(width: 6),
                                          Expanded(
                                            child: Text(
                                              'Đã xác thực: ${_ownerPreview!['masked_name'] ?? _ownerPreview!['full_name'] ?? ''}',
                                              style: const TextStyle(
                                                fontWeight: FontWeight.w600,
                                                fontSize: 13,
                                                color: Color(0xFF065F46),
                                              ),
                                            ),
                                          ),
                                        ],
                                      ),
                                      const SizedBox(height: 4),
                                      Text(
                                        'Email: ${_ownerPreview!['masked_email'] ?? '—'} · SĐT: ${_ownerPreview!['masked_phone'] ?? '—'}',
                                        style: const TextStyle(
                                          fontSize: 12,
                                          color: Color(0xFF047857),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                AppButton(
                                  text: 'Đổi / Xóa',
                                  variant: AppButtonVariant.outline,
                                  size: AppButtonSize.xs,
                                  onPressed: _handleClearOwner,
                                ),
                              ],
                            ),
                          ),
                        ] else ...[
                          // Editable lookup state
                          Row(
                            children: [
                              Expanded(
                                child: AppInput(
                                  key: const Key('owner_identifier_input'),
                                  placeholder:
                                      'Nhập chính xác Email hoặc SĐT 10 số của Chủ đầu tư...',
                                  controller: _ownerIdentifierController,
                                  onSubmitted: (val) => _verifyOwnerIdentifier(val),
                                ),
                              ),
                              const SizedBox(width: 8),
                              AppButton(
                                text: 'Kiểm tra',
                                variant: AppButtonVariant.soft,
                                icon: const Icon(LucideIcons.search, size: 14),
                                loading: _ownerLookupLoading,
                                onPressed: () => _verifyOwnerIdentifier(),
                              ),
                            ],
                          ),
                          if (_ownerLookupError != null) ...[
                            const SizedBox(height: 6),
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Icon(
                                  LucideIcons.triangleAlert,
                                  size: 13,
                                  color: AppColors.rose600,
                                ),
                                const SizedBox(width: 4),
                                Expanded(
                                  child: Text(
                                    _ownerLookupError!,
                                    style: const TextStyle(
                                      fontSize: 12,
                                      color: AppColors.rose600,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ] else ...[
                            const SizedBox(height: 6),
                            const Text(
                              'Hệ thống không hiển thị danh sách công khai Chủ đầu tư. Nhập Email hoặc SĐT để xác thực một phần thông tin, hoặc để trống nếu chưa gán.',
                              style: TextStyle(fontSize: 11, color: AppColors.slate500),
                            ),
                          ],
                        ],
                      ],
                    ),
                  ),

                  const SizedBox(height: 16),

                  // Payment Account Section
                  Container(
                    padding: const EdgeInsets.only(top: 14),
                    decoration: const BoxDecoration(
                      border: Border(top: BorderSide(color: AppColors.slate200)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Tài khoản ngân hàng nhận tiền thuê / phí dịch vụ',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: AppColors.slate700,
                          ),
                        ),
                        const SizedBox(height: 10),
                        BankSelect(
                          label: 'Ngân hàng (VietQR.io)',
                          value: _bankName,
                          bankMeta: {
                            'bank_code': _bankCode,
                            'bank_bin': _bankBin,
                            'bank_logo': _bankLogo,
                          },
                          onBankChange: (name, chosen) {
                            setState(() {
                              _bankName = name;
                              _bankCode = chosen?['code']?.toString() ?? '';
                              _bankBin = chosen?['bin']?.toString() ?? '';
                              _bankLogo = chosen?['logo']?.toString() ?? '';
                            });
                          },
                        ),
                        const SizedBox(height: 12),
                        AppInput(
                          label: 'Số tài khoản',
                          placeholder: 'Nhập số tài khoản ngân hàng',
                          controller: _accountNumberController,
                        ),
                        const SizedBox(height: 12),
                        AppInput(
                          label: 'Chủ tài khoản',
                          placeholder: 'Nhập tên chủ tài khoản ngân hàng',
                          controller: _accountHolderController,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
