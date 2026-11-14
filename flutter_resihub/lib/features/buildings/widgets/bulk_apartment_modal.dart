import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../services/buildings_service.dart';

const List<String> kApartmentTypes = [
  'Studio',
  '1PN',
  '2PN',
  '3PN',
  'Penthouse',
  'Duplex',
];

class BulkUnitRow {
  String suffix;
  String type;
  int bedrooms;
  double areaM2;
  int baseRent;

  BulkUnitRow({
    required this.suffix,
    this.type = '1PN',
    this.bedrooms = 1,
    this.areaM2 = 45,
    this.baseRent = 8500000,
  });

  Map<String, dynamic> toJson() => {
        'suffix': suffix.trim().toUpperCase(),
        'type': type.trim().isEmpty ? '1PN' : type.trim(),
        'bedrooms': bedrooms,
        'area_m2': areaM2,
        'base_rent': baseRent,
      };
}

List<BulkUnitRow> makeDefaultUnits(int count, [List<BulkUnitRow>? current]) {
  final list = <BulkUnitRow>[];
  for (var i = 0; i < count; i++) {
    if (current != null && i < current.length) {
      list.add(current[i]);
    } else {
      list.add(BulkUnitRow(
        suffix: (i + 1).toString().padLeft(2, '0'),
        type: '1PN',
        bedrooms: 1,
        areaM2: 45,
        baseRent: 8500000,
      ));
    }
  }
  return list;
}

/// Port of `frontend/src/pages/admin/buildings/BulkApartmentModal.jsx`.
class BulkApartmentModal extends ConsumerStatefulWidget {
  final bool open;
  final String buildingId;
  final List<dynamic> floors;
  final List<dynamic> zones;
  final VoidCallback? onClose;
  final void Function(dynamic res)? onCreated;

  const BulkApartmentModal({
    super.key,
    required this.open,
    required this.buildingId,
    this.floors = const [],
    this.zones = const [],
    this.onClose,
    this.onCreated,
  });

  @override
  ConsumerState<BulkApartmentModal> createState() => _BulkApartmentModalState();
}

class _BulkApartmentModalState extends ConsumerState<BulkApartmentModal> {
  final Set<String> _selectedFloorIds = {};
  String _zoneId = '';
  final _codePrefixController = TextEditingController();
  late List<BulkUnitRow> _units;
  Map<String, dynamic>? _preview;
  bool _loadingPreview = false;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _resetForm();
  }

  @override
  void didUpdateWidget(covariant BulkApartmentModal oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.open && !oldWidget.open) {
      _resetForm();
    }
  }

  @override
  void dispose() {
    _codePrefixController.dispose();
    super.dispose();
  }

  void _resetForm() {
    _selectedFloorIds.clear();
    if (widget.floors.isNotEmpty) {
      final first = widget.floors.first;
      if (first is Map && first['id'] != null) {
        _selectedFloorIds.add(first['id'].toString());
      }
    }
    _zoneId = '';
    _codePrefixController.clear();
    _units = makeDefaultUnits(5);
    _preview = null;
    _loadingPreview = false;
    _submitting = false;
  }

  void _invalidate() {
    if (_preview != null) {
      setState(() => _preview = null);
    }
  }

  Future<void> _handlePreview() async {
    if (_selectedFloorIds.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn ít nhất một tầng.');
      return;
    }
    setState(() => _loadingPreview = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final payload = {
        'building_id': widget.buildingId,
        'floor_ids': _selectedFloorIds.toList(),
        'zone_id': _zoneId.isEmpty ? null : _zoneId,
        'code_prefix': _codePrefixController.text.trim().toUpperCase().isEmpty
            ? null
            : _codePrefixController.text.trim().toUpperCase(),
        'units': _units.map((u) => u.toJson()).toList(),
        'dry_run': true,
      };
      final res = await service.previewApartmentsBulk(payload);
      if (mounted) {
        setState(() {
          _preview = res is Map ? Map<String, dynamic>.from(res) : null;
        });
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _loadingPreview = false);
    }
  }

  Future<void> _handleSubmit() async {
    if (_preview == null || _preview!['valid'] == false) {
      ref.read(toastProvider.notifier).warning(
            'Vui lòng xem trước và xử lý hết mã trùng trước khi tạo.',
          );
      return;
    }
    setState(() => _submitting = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final payload = {
        'building_id': widget.buildingId,
        'floor_ids': _selectedFloorIds.toList(),
        'zone_id': _zoneId.isEmpty ? null : _zoneId,
        'code_prefix': _codePrefixController.text.trim().toUpperCase().isEmpty
            ? null
            : _codePrefixController.text.trim().toUpperCase(),
        'units': _units.map((u) => u.toJson()).toList(),
        'dry_run': true,
      };
      final res = await service.createApartmentsBulk(payload);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null)
                ? res['message'].toString()
                : 'Đã tạo ${_units.length * _selectedFloorIds.length} căn hộ.',
          );
      widget.onCreated?.call(res);
      widget.onClose?.call();
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.open) return const SizedBox.shrink();

    final previewValid = _preview != null &&
        (_preview!['valid'] == true ||
            (_preview!['conflicts'] is List && (_preview!['conflicts'] as List).isEmpty));
    final conflicts = (_preview?['conflicts'] is List)
        ? (_preview!['conflicts'] as List)
        : <dynamic>[];

    return AppModal(
      onClose: _submitting ? () {} : () => widget.onClose?.call(),
      title: 'Tạo căn hộ hàng loạt',
      subtitle: 'Áp dụng mẫu căn hộ chung cho nhiều tầng đã chọn',
      size: AppModalSize.lg,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('1. Chọn tầng áp dụng',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: widget.floors.map((f) {
              final id = (f is Map ? f['id'] : '').toString();
              final name = (f is Map ? (f['name'] ?? 'Tầng ${f['level']}') : 'Tầng').toString();
              final isSelected = _selectedFloorIds.contains(id);
              return FilterChip(
                label: Text(name),
                selected: isSelected,
                onSelected: (selected) {
                  setState(() {
                    if (selected) {
                      _selectedFloorIds.add(id);
                    } else {
                      _selectedFloorIds.remove(id);
                    }
                  });
                  _invalidate();
                },
              );
            }).toList(),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              if (widget.zones.isNotEmpty) ...[
                Expanded(
                  child: AppSelect<String>(
                    label: 'Phân khu (Tùy chọn)',
                    value: _zoneId,
                    options: [
                      const AppSelectOption(value: '', label: '-- Không chọn --'),
                      ...widget.zones.map((z) => AppSelectOption(
                            value: (z is Map ? z['id'] : '').toString(),
                            label: (z is Map ? '${z['code']} - ${z['name']}' : '').toString(),
                          )),
                    ],
                    onChanged: (val) {
                      setState(() => _zoneId = val ?? '');
                      _invalidate();
                    },
                  ),
                ),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: AppInput(
                  label: 'Tiền tố mã căn (Tùy chọn)',
                  controller: _codePrefixController,
                  placeholder: 'VD: A, B, BL...',
                  onChanged: (_) => _invalidate(),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('2. Danh sách mẫu căn hộ (${_units.length} căn/tầng)',
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
              AppButton(
                text: 'Thêm căn',
                size: AppButtonSize.xs,
                variant: AppButtonVariant.outline,
                icon: const Icon(LucideIcons.plus, size: 14),
                onPressed: _units.length >= 50
                    ? null
                    : () {
                        setState(() {
                          _units.add(BulkUnitRow(
                            suffix: (_units.length + 1).toString().padLeft(2, '0'),
                            type: '1PN',
                            bedrooms: 1,
                            areaM2: 45,
                            baseRent: 8500000,
                          ));
                        });
                        _invalidate();
                      },
              ),
            ],
          ),
          const SizedBox(height: 8),
          Container(
            constraints: const BoxConstraints(maxHeight: 220),
            decoration: BoxDecoration(
              border: Border.all(color: AppColors.slate200),
              borderRadius: BorderRadius.circular(8),
            ),
            child: ListView.separated(
              shrinkWrap: true,
              itemCount: _units.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, idx) {
                final row = _units[idx];
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 70,
                        child: TextFormField(
                          initialValue: row.suffix,
                          decoration: const InputDecoration(
                            isDense: true,
                            labelText: 'Đuôi số',
                            contentPadding: EdgeInsets.symmetric(horizontal: 6, vertical: 6),
                          ),
                          onChanged: (v) {
                            row.suffix = v;
                            _invalidate();
                          },
                        ),
                      ),
                      const SizedBox(width: 8),
                      SizedBox(
                        width: 100,
                        child: DropdownButtonFormField<String>(
                          isDense: true,
                          isExpanded: true,
                          value: row.type,
                          decoration: const InputDecoration(
                            contentPadding: EdgeInsets.symmetric(horizontal: 6, vertical: 6),
                          ),
                          items: kApartmentTypes
                              .map((t) => DropdownMenuItem(
                                    value: t,
                                    child: Text(t, style: const TextStyle(fontSize: 12), overflow: TextOverflow.ellipsis),
                                  ))
                              .toList(),
                          onChanged: (v) {
                            if (v != null) {
                              row.type = v;
                              _invalidate();
                            }
                          },
                        ),
                      ),
                      const SizedBox(width: 8),
                      SizedBox(
                        width: 80,
                        child: TextFormField(
                          initialValue: row.areaM2.toString(),
                          keyboardType: TextInputType.number,
                          decoration: const InputDecoration(
                            isDense: true,
                            labelText: 'm²',
                            contentPadding: EdgeInsets.symmetric(horizontal: 6, vertical: 6),
                          ),
                          onChanged: (v) {
                            row.areaM2 = double.tryParse(v) ?? 0;
                            _invalidate();
                          },
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextFormField(
                          initialValue: row.baseRent.toString(),
                          keyboardType: TextInputType.number,
                          decoration: const InputDecoration(
                            isDense: true,
                            labelText: 'Giá thuê (VND)',
                            contentPadding: EdgeInsets.symmetric(horizontal: 6, vertical: 6),
                          ),
                          onChanged: (v) {
                            row.baseRent = int.tryParse(v) ?? 0;
                            _invalidate();
                          },
                        ),
                      ),
                      if (_units.length > 1)
                        IconButton(
                          icon: const Icon(LucideIcons.trash2, size: 16, color: AppColors.rose500),
                          onPressed: () {
                            setState(() => _units.removeAt(idx));
                            _invalidate();
                          },
                        ),
                    ],
                  ),
                );
              },
            ),
          ),
          const SizedBox(height: 12),
          if (_preview != null) ...[
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: previewValid ? AppColors.emerald50 : AppColors.rose50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: previewValid ? AppColors.emerald200 : AppColors.rose200,
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        previewValid ? LucideIcons.checkCircle2 : LucideIcons.alertTriangle,
                        size: 16,
                        color: previewValid ? AppColors.emerald600 : AppColors.rose600,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        previewValid
                            ? 'Dự kiến tạo hợp lệ: ${_preview!['total'] ?? (_units.length * _selectedFloorIds.length)} căn hộ.'
                            : 'Phát hiện ${conflicts.length} mã căn hộ bị trùng lặp!',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.bold,
                          color: previewValid ? AppColors.emerald700 : AppColors.rose800,
                        ),
                      ),
                    ],
                  ),
                  if (conflicts.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      'Các mã bị trùng: ${conflicts.map((c) => c is Map ? c['code'] : c.toString()).join(', ')}',
                      style: const TextStyle(fontSize: 12, color: AppColors.rose700),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 12),
          ],
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 8,
            children: [
              Text(
                'Tổng dự kiến: ${_selectedFloorIds.length * _units.length} căn hộ (${_selectedFloorIds.length} tầng × ${_units.length} căn)',
                style: const TextStyle(fontSize: 12, color: AppColors.slate500),
              ),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: _submitting ? null : widget.onClose,
                  ),
                  AppButton(
                    text: 'Xem trước',
                    variant: AppButtonVariant.secondary,
                    icon: const Icon(LucideIcons.eye, size: 14),
                    loading: _loadingPreview,
                    onPressed: _handlePreview,
                  ),
                  AppButton(
                    text: 'Khởi tạo căn hộ',
                    loading: _submitting,
                    onPressed: previewValid && !_loadingPreview ? _handleSubmit : null,
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}
