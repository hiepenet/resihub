import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/search_bar_widget.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/money_input.dart';
import '../../auth/providers/auth_provider.dart';
import '../../auth/providers/permission_provider.dart';
import '../../buildings/services/buildings_service.dart';
import '../services/services_service.dart';

const Map<String, ({String label, IconData icon, AppBadgeVariant badgeVariant})> kServiceCategories = {
  'ELECTRICITY': (label: 'Điện sinh hoạt', icon: LucideIcons.zap, badgeVariant: AppBadgeVariant.amber),
  'WATER': (label: 'Nước sạch', icon: LucideIcons.droplets, badgeVariant: AppBadgeVariant.sky),
  'INTERNET': (label: 'Internet / Viễn thông', icon: LucideIcons.wifi, badgeVariant: AppBadgeVariant.indigo),
  'PARKING': (label: 'Gửi xe / Đỗ xe', icon: LucideIcons.car, badgeVariant: AppBadgeVariant.indigo),
  'CLEANING': (label: 'Vệ sinh căn hộ', icon: LucideIcons.sparkles, badgeVariant: AppBadgeVariant.emerald),
  'MANAGEMENT': (label: 'Phí quản lý vận hành', icon: LucideIcons.shieldCheck, badgeVariant: AppBadgeVariant.sky),
  'UTILITY': (label: 'Tiện ích mở rộng', icon: LucideIcons.layers, badgeVariant: AppBadgeVariant.slate),
  'OTHER': (label: 'Dịch vụ khác', icon: LucideIcons.package, badgeVariant: AppBadgeVariant.slate),
};

const Map<String, String> kBillingTypes = {
  'FIXED': 'Trọn gói cố định / kỳ',
  'METERED': 'Theo chỉ số đồng hồ',
  'QUANTITY': 'Theo số lượng đăng ký',
};

/// Service Catalog Administration Page (M07).
/// Port of `frontend/src/pages/admin/services/ServiceCatalogPage.jsx`.
class ServiceCatalogPage extends ConsumerStatefulWidget {
  const ServiceCatalogPage({super.key});

  @override
  ConsumerState<ServiceCatalogPage> createState() => _ServiceCatalogPageState();
}

class _ServiceCatalogPageState extends ConsumerState<ServiceCatalogPage> {
  List<Map<String, dynamic>> _catalog = [];
  List<Map<String, dynamic>> _buildings = [];
  int _pendingSubsCount = 0;
  bool _loading = true;

  String _search = '';
  String _categoryFilter = '';
  String _statusFilter = 'ALL'; // ALL | ACTIVE | INACTIVE

  @override
  void initState() {
    super.initState();
    _fetchData();
  }

  Future<void> _fetchData({bool force = false}) async {
    setState(() => _loading = true);
    final selectedBuildingId = ref.read(authProvider).selectedBuildingId;

    try {
      final servicesSvc = ref.read(servicesServiceProvider);
      final buildingsSvc = ref.read(buildingsServiceProvider);

      final catRes = await servicesSvc.listCatalog(null, null, force);
      final subRes = await servicesSvc.listSubscriptions({
        if (selectedBuildingId.isNotEmpty) 'building_id': selectedBuildingId,
        'status': 'PENDING_APPROVAL,CANCELLATION_PENDING',
      }).catchError((_) => {'data': []});
      final bldgRes = await buildingsSvc.list().catchError((_) => {'data': []});

      final catList = (catRes is Map && catRes['data'] is List)
          ? (catRes['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : (catRes is List)
              ? catRes.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
              : <Map<String, dynamic>>[];

      final subList = (subRes is Map && subRes['data'] is List)
          ? (subRes['data'] as List)
          : (subRes is List)
              ? subRes
              : const [];

      final bldgList = (bldgRes is Map && bldgRes['data'] is List)
          ? (bldgRes['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : (bldgRes is List)
              ? bldgRes.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
              : <Map<String, dynamic>>[];

      if (mounted) {
        setState(() {
          _catalog = catList;
          _pendingSubsCount = subList.length;
          _buildings = bldgList;
          _loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh mục dịch vụ.'),
            );
      }
    }
  }

  List<Map<String, dynamic>> get _filteredCatalog {
    final selectedBuildingId = ref.watch(authProvider).selectedBuildingId;
    return _catalog.where((item) {
      if (selectedBuildingId.isNotEmpty && item['building_id'] != null) {
        if (item['building_id'].toString() != selectedBuildingId) return false;
      }
      if (_categoryFilter.isNotEmpty && item['category'] != _categoryFilter) {
        return false;
      }
      if (_statusFilter == 'ACTIVE' && item['is_active'] != true) {
        return false;
      }
      if (_statusFilter == 'INACTIVE' && item['is_active'] == true) {
        return false;
      }
      if (_search.trim().isNotEmpty) {
        final q = _search.trim().toLowerCase();
        final name = (item['name'] ?? '').toString().toLowerCase();
        final code = (item['code'] ?? '').toString().toLowerCase();
        final desc = (item['description'] ?? '').toString().toLowerCase();
        if (!name.contains(q) && !code.contains(q) && !desc.contains(q)) {
          return false;
        }
      }
      return true;
    }).toList();
  }

  void _openCatalogFormModal([Map<String, dynamic>? itemToEdit]) {
    final isEditing = itemToEdit != null;
    final selectedBuildingId = ref.read(authProvider).selectedBuildingId;

    final codeCtrl = TextEditingController(text: itemToEdit?['code']?.toString() ?? '');
    final nameCtrl = TextEditingController(text: itemToEdit?['name']?.toString() ?? '');
    final unitCtrl = TextEditingController(text: itemToEdit?['unit']?.toString() ?? 'tháng');
    final descCtrl = TextEditingController(text: itemToEdit?['description']?.toString() ?? '');
    int unitPrice = (itemToEdit?['unit_price'] is num
            ? (itemToEdit!['unit_price'] as num).toInt()
            : int.tryParse(itemToEdit?['unit_price']?.toString() ?? '')) ??
        0;

    String category = itemToEdit?['category']?.toString() ?? 'UTILITY';
    String billingType = itemToEdit?['billing_type']?.toString() ?? 'FIXED';
    String buildingId = itemToEdit?['building_id']?.toString() ?? selectedBuildingId;
    bool isActive = itemToEdit?['is_active'] ?? true;

    String? codeError;
    String? nameError;
    bool saving = false;

    AppModal.show<void>(
      context: context,
      title: isEditing ? 'Chỉnh sửa dịch vụ' : 'Thêm dịch vụ mới',
      subtitle: isEditing
          ? 'Cập nhật đơn giá và thông tin áp dụng cho dịch vụ'
          : 'Khai báo dịch vụ mới vào danh mục của tòa nhà hoặc hệ thống',
      size: AppModalSize.lg,
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Mã dịch vụ',
                      required: true,
                      placeholder: 'VD: ELEC-01, PARKING-CAR',
                      controller: codeCtrl,
                      error: codeError,
                      readOnly: isEditing,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Tên dịch vụ',
                      required: true,
                      placeholder: 'VD: Điện sinh hoạt, Gửi ô tô',
                      controller: nameCtrl,
                      error: nameError,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: AppSelect<String>(
                      label: 'Nhóm dịch vụ',
                      value: category,
                      options: kServiceCategories.entries.map((e) {
                        return AppSelectOption(value: e.key, label: e.value.label);
                      }).toList(),
                      onChanged: (val) {
                        if (val != null) {
                          setModalState(() {
                            category = val;
                            if (val == 'ELECTRICITY') {
                              billingType = 'METERED';
                              unitCtrl.text = 'kWh';
                            } else if (val == 'WATER') {
                              billingType = 'METERED';
                              unitCtrl.text = 'm³';
                            } else if (val == 'PARKING') {
                              billingType = 'QUANTITY';
                              unitCtrl.text = 'xe/tháng';
                            }
                          });
                        }
                      },
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppSelect<String>(
                      label: 'Hình thức tính phí',
                      value: billingType,
                      options: kBillingTypes.entries.map((e) {
                        return AppSelectOption(value: e.key, label: e.value);
                      }).toList(),
                      onChanged: (val) {
                        if (val != null) setModalState(() => billingType = val);
                      },
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: MoneyInput(
                      label: 'Đơn giá chuẩn (VNĐ)',
                      required: true,
                      value: unitPrice,
                      onChanged: (val) => unitPrice = int.tryParse(val) ?? 0,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Đơn vị tính',
                      required: true,
                      placeholder: 'VD: kWh, m³, tháng, xe/tháng',
                      controller: unitCtrl,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              AppSelect<String>(
                label: 'Áp dụng cho tòa nhà',
                value: buildingId,
                options: [
                  const AppSelectOption(value: '', label: 'Toàn hệ thống (Tất cả tòa nhà)'),
                  ..._buildings.map((b) => AppSelectOption(
                        value: b['id']?.toString() ?? '',
                        label: '${b['name']} (${b['code']})',
                      )),
                ],
                onChanged: (val) {
                  if (val != null) setModalState(() => buildingId = val);
                },
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Mô tả / Ghi chú dịch vụ',
                placeholder: 'VD: Định mức sử dụng, thời gian cung cấp...',
                controller: descCtrl,
                multiline: true,
                rows: 2,
              ),
              const SizedBox(height: 16),
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text(
                  'Kích hoạt áp dụng dịch vụ',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
                ),
                subtitle: const Text(
                  'Khi tắt, dịch vụ sẽ không hiển thị khi lập hợp đồng hoặc đăng ký mới',
                  style: TextStyle(fontSize: 12, color: AppColors.slate500),
                ),
                value: isActive,
                onChanged: (val) => setModalState(() => isActive = val),
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy bỏ',
                    variant: AppButtonVariant.outline,
                    onPressed: saving ? null : () => Navigator.of(ctx).pop(),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: isEditing ? 'Cập nhật' : 'Thêm dịch vụ',
                    variant: AppButtonVariant.primary,
                    loading: saving,
                    onPressed: () async {
                      final code = codeCtrl.text.trim();
                      final name = nameCtrl.text.trim();
                      final unit = unitCtrl.text.trim();

                      setModalState(() {
                        codeError = code.isEmpty ? 'Vui lòng nhập mã dịch vụ' : null;
                        nameError = name.isEmpty ? 'Vui lòng nhập tên dịch vụ' : null;
                      });

                      if (code.isEmpty || name.isEmpty) return;

                      setModalState(() => saving = true);
                      try {
                        final payload = {
                          'code': code,
                          'name': name,
                          'category': category,
                          'billing_type': billingType,
                          'unit': unit.isEmpty ? 'tháng' : unit,
                          'unit_price': unitPrice,
                          'building_id': buildingId.isEmpty ? null : buildingId,
                          'description': descCtrl.text.trim(),
                          'is_active': isActive,
                        };

                        final svc = ref.read(servicesServiceProvider);
                        if (isEditing) {
                          await svc.updateCatalog(itemToEdit['id'].toString(), payload);
                          ref.read(toastProvider.notifier).success('Đã cập nhật dịch vụ thành công.');
                        } else {
                          await svc.createCatalog(payload);
                          ref.read(toastProvider.notifier).success('Đã thêm dịch vụ mới vào danh mục.');
                        }

                        if (ctx.mounted) Navigator.of(ctx).pop();
                        _fetchData(force: true);
                      } catch (err) {
                        setModalState(() => saving = false);
                        ref.read(toastProvider.notifier).error(
                              extractErrorMessage(err, 'Không thể lưu thông tin dịch vụ.'),
                            );
                      }
                    },
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _handleToggleActive(Map<String, dynamic> item) async {
    final canManage = ref.read(permissionProvider).canManageServiceCatalog;
    if (!canManage) return;

    final id = item['id']?.toString();
    if (id == null) return;
    final currentActive = item['is_active'] == true;

    try {
      await ref.read(servicesServiceProvider).updateCatalog(id, {'is_active': !currentActive});
      ref.read(toastProvider.notifier).success(
            !currentActive ? 'Đã kích hoạt dịch vụ.' : 'Đã tạm dừng dịch vụ.',
          );
      _fetchData(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể thay đổi trạng thái dịch vụ.'),
          );
    }
  }

  @override
  Widget build(BuildContext context) {
    final perms = ref.watch(permissionProvider);
    final canManage = perms.canManageServiceCatalog;
    final items = _filteredCatalog;

    return Scaffold(
      key: const Key('route:/admin/services'),
      backgroundColor: AppColors.background,
      body: RefreshIndicator(
        onRefresh: () => _fetchData(force: true),
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              PageHeader(
                title: 'Danh mục dịch vụ',
                subtitle: 'Quản lý bảng giá các loại dịch vụ tiện ích, phí cố định & công tơ',
                breadcrumbs: const [
                  BreadcrumbItem(label: 'Trang chủ', to: '/admin'),
                  BreadcrumbItem(label: 'Danh mục dịch vụ'),
                ],
                actions: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    AppButton(
                      text: _pendingSubsCount > 0 ? 'Gói đăng ký ($_pendingSubsCount)' : 'Gói đăng ký dịch vụ',
                      icon: const Icon(LucideIcons.users, size: 16),
                      variant: AppButtonVariant.outline,
                      onPressed: () => context.go('/admin/services/subscriptions'),
                    ),
                    if (canManage) ...[
                      const SizedBox(width: 8),
                      AppButton(
                        text: 'Thêm dịch vụ',
                        icon: const Icon(LucideIcons.plus, size: 16),
                        variant: AppButtonVariant.primary,
                        onPressed: () => _openCatalogFormModal(),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 20),

              // Search & Filter Bar
              AppCard(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    Row(
                      children: [
                        Expanded(
                          flex: 2,
                          child: SearchBarWidget(
                            placeholder: 'Tìm theo tên dịch vụ, mã...',
                            value: _search,
                            onChanged: (val) => setState(() => _search = val),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: AppSelect<String>(
                            value: _categoryFilter,
                            options: [
                              const AppSelectOption(value: '', label: 'Tất cả loại dịch vụ'),
                              ...kServiceCategories.entries.map((e) => AppSelectOption(
                                    value: e.key,
                                    label: e.value.label,
                                  )),
                            ],
                            onChanged: (val) => setState(() => _categoryFilter = val ?? ''),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: AppSelect<String>(
                            value: _statusFilter,
                            options: const [
                              AppSelectOption(value: 'ALL', label: 'Tất cả trạng thái'),
                              AppSelectOption(value: 'ACTIVE', label: 'Đang áp dụng'),
                              AppSelectOption(value: 'INACTIVE', label: 'Ngừng áp dụng'),
                            ],
                            onChanged: (val) => setState(() => _statusFilter = val ?? 'ALL'),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),

              if (_loading) ...[
                const Center(
                  child: Padding(
                    padding: EdgeInsets.symmetric(vertical: 40),
                    child: CircularProgressIndicator(),
                  ),
                ),
              ] else if (items.isEmpty) ...[
                EmptyState(
                  icon: LucideIcons.package,
                  title: 'Chưa có dịch vụ nào',
                  description: 'Không tìm thấy dịch vụ phù hợp với điều kiện tìm kiếm và bộ lọc.',
                  action: canManage
                      ? AppButton(
                          text: 'Thêm dịch vụ đầu tiên',
                          icon: const Icon(LucideIcons.plus, size: 16),
                          variant: AppButtonVariant.primary,
                          onPressed: () => _openCatalogFormModal(),
                        )
                      : null,
                ),
              ] else ...[
                LayoutBuilder(
                  builder: (context, constraints) {
                    final crossAxisCount = constraints.maxWidth > 1000
                        ? 3
                        : constraints.maxWidth > 650
                            ? 2
                            : 1;

                    return GridView.builder(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: crossAxisCount,
                        crossAxisSpacing: 16,
                        mainAxisSpacing: 16,
                        mainAxisExtent: 210,
                      ),
                      itemCount: items.length,
                      itemBuilder: (context, index) {
                        final item = items[index];
                        final catMeta = kServiceCategories[item['category']] ??
                            (
                              label: item['category']?.toString() ?? 'Khác',
                              icon: LucideIcons.package,
                              badgeVariant: AppBadgeVariant.slate,
                            );

                        final billingTypeLabel = kBillingTypes[item['billing_type']] ?? item['billing_type'];
                        final price = item['unit_price'] is num
                            ? item['unit_price'] as num
                            : num.tryParse(item['unit_price']?.toString() ?? '0') ?? 0;
                        final unit = item['unit'] ?? 'tháng';
                        final isActive = item['is_active'] == true;

                        return AppCard(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Container(
                                    width: 40,
                                    height: 40,
                                    decoration: BoxDecoration(
                                      color: AppColors.slate100,
                                      borderRadius: BorderRadius.circular(10),
                                    ),
                                    child: Icon(catMeta.icon, color: AppColors.slate700, size: 20),
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          item['name']?.toString() ?? '—',
                                          style: const TextStyle(
                                            fontSize: 15,
                                            fontWeight: FontWeight.w600,
                                            color: AppColors.slate900,
                                          ),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                        const SizedBox(height: 2),
                                        Text(
                                          item['code']?.toString() ?? '',
                                          style: const TextStyle(
                                            fontFamily: 'monospace',
                                            fontSize: 11,
                                            color: AppColors.slate500,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  AppBadge(
                                    label: isActive ? 'Áp dụng' : 'Tạm dừng',
                                    variant: isActive ? AppBadgeVariant.emerald : AppBadgeVariant.slate,
                                    dot: true,
                                  ),
                                ],
                              ),
                              const SizedBox(height: 16),
                              Row(
                                children: [
                                  AppBadge(
                                    label: catMeta.label,
                                    variant: catMeta.badgeVariant,
                                  ),
                                  const SizedBox(width: 6),
                                  Expanded(
                                    child: Text(
                                      billingTypeLabel?.toString() ?? '',
                                      style: const TextStyle(fontSize: 11, color: AppColors.slate500),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 10),
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      const Text(
                                        'Đơn giá tiêu chuẩn',
                                        style: TextStyle(fontSize: 11, color: AppColors.slate400),
                                      ),
                                      Row(
                                        crossAxisAlignment: CrossAxisAlignment.baseline,
                                        textBaseline: TextBaseline.alphabetic,
                                        children: [
                                          Text(
                                            formatMoney(price),
                                            style: const TextStyle(
                                              fontSize: 16,
                                              fontWeight: FontWeight.w700,
                                              color: AppColors.slate900,
                                            ),
                                          ),
                                          Text(
                                            ' / $unit',
                                            style: const TextStyle(
                                              fontSize: 12,
                                              color: AppColors.slate500,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ],
                                  ),
                                  if (canManage)
                                    Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        IconButton(
                                          tooltip: isActive ? 'Tạm dừng dịch vụ' : 'Kích hoạt lại dịch vụ',
                                          icon: Icon(
                                            isActive ? LucideIcons.powerOff : LucideIcons.power,
                                            size: 16,
                                            color: isActive ? AppColors.amber600 : AppColors.emerald600,
                                          ),
                                          onPressed: () => _handleToggleActive(item),
                                        ),
                                        IconButton(
                                          tooltip: 'Chỉnh sửa dịch vụ',
                                          icon: const Icon(LucideIcons.pencil, size: 16, color: AppColors.slate600),
                                          onPressed: () => _openCatalogFormModal(item),
                                        ),
                                      ],
                                    ),
                                ],
                              ),
                            ],
                          ),
                        );
                      },
                    );
                  },
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
