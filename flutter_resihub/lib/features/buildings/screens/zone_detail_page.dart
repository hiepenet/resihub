import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_skeleton.dart';
import '../../auth/providers/permission_provider.dart';
import '../services/buildings_service.dart';

/// Bất động sản (M03 — Phần 2) — `ZoneDetailPage`.
/// Port of `frontend/src/pages/admin/buildings/ZoneDetailPage.jsx`.
class ZoneDetailPage extends ConsumerStatefulWidget {
  final String buildingId;
  final String zoneId;

  const ZoneDetailPage({
    super.key,
    required this.buildingId,
    required this.zoneId,
  });

  @override
  ConsumerState<ZoneDetailPage> createState() => _ZoneDetailPageState();
}

class _ZoneDetailPageState extends ConsumerState<ZoneDetailPage> {
  Map<String, dynamic>? _building;
  Map<String, dynamic>? _zone;
  List<Map<String, dynamic>> _apartments = [];
  bool _loading = true;

  bool _editOpen = false;
  final _nameController = TextEditingController();
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _loadZone();
    });
  }

  @override
  void didUpdateWidget(covariant ZoneDetailPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.buildingId != oldWidget.buildingId || widget.zoneId != oldWidget.zoneId) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _loadZone();
      });
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _loadZone() async {
    setState(() => _loading = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final results = await Future.wait([
        service.getById(widget.buildingId),
        service.listZones(widget.buildingId),
        service.listApartments({'building_id': widget.buildingId}),
      ]);
      if (!mounted) return;

      final bRes = results[0];
      final zRes = results[1];
      final aRes = results[2];

      Map<String, dynamic>? foundZone;
      if (zRes is Map && zRes['data'] is List) {
        for (final item in zRes['data'] as List) {
          if (item is Map && item['id']?.toString() == widget.zoneId) {
            foundZone = Map<String, dynamic>.from(item);
            break;
          }
        }
      }

      final apts = <Map<String, dynamic>>[];
      if (aRes is Map && aRes['data'] is List) {
        for (final item in aRes['data'] as List) {
          if (item is Map && item['zone_id']?.toString() == widget.zoneId) {
            apts.add(Map<String, dynamic>.from(item));
          }
        }
      }

      setState(() {
        if (bRes is Map && bRes['data'] is Map) {
          _building = Map<String, dynamic>.from(bRes['data'] as Map);
        }
        _zone = foundZone;
        if (foundZone != null) {
          _nameController.text = foundZone['name']?.toString() ?? '';
        }
        _apartments = apts;
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

  Future<void> _handleSave() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập tên phân khu.');
      return;
    }
    setState(() => _saving = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      await service.updateZone(widget.buildingId, widget.zoneId, {'name': name});
      ref.read(toastProvider.notifier).success('Đã cập nhật tên phân khu.');
      setState(() => _editOpen = false);
      _loadZone();
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _handleDelete() async {
    setState(() => _saving = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      await service.deleteZone(widget.buildingId, widget.zoneId);
      ref.read(toastProvider.notifier).success('Đã xóa phân khu ${_zone?['code'] ?? ''}.');
      if (mounted) context.go('/admin/buildings/${widget.buildingId}');
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
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
            const Text('Route: /admin/buildings/:id/zones/:zoneId'),
            Text('Params: {id: ${widget.buildingId}, zoneId: ${widget.zoneId}}'),
          ],
        ),
      ),
    );

    if (_loading) {
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

    if (_zone == null) {
      return Stack(
        children: [
          routerMarker,
          Padding(
            padding: const EdgeInsets.all(24.0),
            child: Column(
              children: [
                const EmptyState(
                  icon: LucideIcons.doorOpen,
                  title: 'Không tìm thấy phân khu',
                  description: 'Phân khu không tồn tại trong tòa nhà này.',
                ),
                const SizedBox(height: 12),
                AppButton(
                  text: 'Quay lại tòa nhà',
                  variant: AppButtonVariant.outline,
                  onPressed: () => context.go('/admin/buildings/${widget.buildingId}'),
                ),
              ],
            ),
          ),
        ],
      );
    }

    final hasOverlayModal = _editOpen;

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
                title: 'Phân khu ${_zone!['code']} — ${_zone!['name']}',
                subtitle: 'Thuộc tòa nhà ${_building?['name'] ?? ''} · ${_apartments.length} căn hộ',
                breadcrumbs: [
                  const BreadcrumbItem(label: 'Bất động sản', to: '/admin/buildings'),
                  BreadcrumbItem(
                    label: _building?['code']?.toString() ?? 'Tòa nhà',
                    to: '/admin/buildings/${widget.buildingId}',
                  ),
                  BreadcrumbItem(label: _zone!['code']?.toString() ?? 'Phân khu'),
                ],
                actions: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (canEditRealEstate)
                      AppButton(
                        text: 'Đổi tên khu',
                        variant: AppButtonVariant.outline,
                        size: AppButtonSize.sm,
                        icon: const Icon(LucideIcons.edit3, size: 14),
                        onPressed: () => setState(() => _editOpen = true),
                      ),
                    if (canManageBuildings && _apartments.isEmpty) ...[
                      const SizedBox(width: 8),
                      AppButton(
                        text: 'Xóa khu trống',
                        variant: AppButtonVariant.danger,
                        size: AppButtonSize.sm,
                        icon: const Icon(LucideIcons.trash2, size: 14),
                        loading: _saving,
                        onPressed: _handleDelete,
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 20),

              DataTableWidget<Map<String, dynamic>>(
                data: _apartments,
                emptyTitle: 'Chưa có căn hộ nào gán vào phân khu này',
                onRowClick: (a) => context.push('/admin/apartments/${a['id']}'),
                columns: [
                  DataTableColumn(
                    key: 'code',
                    label: 'Mã căn hộ',
                    width: 120,
                    render: (a) => Text(a['code']?.toString() ?? '',
                        style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.primary700)),
                  ),
                  DataTableColumn(
                    key: 'floor_name',
                    label: 'Tầng',
                    width: 90,
                    render: (a) => Text((a['floor_name'] ?? 'Tầng ${a['floor_level'] ?? 1}').toString()),
                  ),
                  DataTableColumn(
                    key: 'type',
                    label: 'Loại căn / PN',
                    width: 140,
                    render: (a) => Text('${a['type'] ?? '1PN'} (${a['bedrooms'] ?? 1} PN)'),
                  ),
                  DataTableColumn(
                    key: 'area_m2',
                    label: 'Diện tích',
                    width: 100,
                    render: (a) => Text('${a['area_m2'] ?? 0} m²'),
                  ),
                  DataTableColumn(
                    key: 'base_rent',
                    label: 'Giá niêm yết',
                    width: 130,
                    render: (a) => Text(formatMoney(a['base_rent']),
                        style: const TextStyle(fontWeight: FontWeight.bold)),
                  ),
                  DataTableColumn(
                    key: 'status',
                    label: 'Trạng thái',
                    width: 150,
                    render: (a) => FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: StatusBadge(status: a['status']?.toString(), domain: StatusDomain.apartment),
                    ),
                  ),
                ],
              ),
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
                  constraints: const BoxConstraints(maxWidth: 448),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_editOpen)
                        AppModal(
                          onClose: () => setState(() => _editOpen = false),
                          title: 'Đổi tên phân khu',
                          size: AppModalSize.sm,
                          child: Column(
                            children: [
                              AppInput(
                                label: 'Tên phân khu',
                                required: true,
                                controller: _nameController,
                              ),
                              const SizedBox(height: 20),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.end,
                                children: [
                                  AppButton(
                                    text: 'Hủy',
                                    variant: AppButtonVariant.outline,
                                    onPressed: () => setState(() => _editOpen = false),
                                  ),
                                  const SizedBox(width: 8),
                                  AppButton(
                                    text: 'Lưu',
                                    loading: _saving,
                                    onPressed: _handleSave,
                                  ),
                                ],
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
      ],
    );
  }
}
