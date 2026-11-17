import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_tabs.dart';
import '../services/buildings_service.dart';

const int kMinLevel = -10;
const int kMaxLevel = 200;
const int kMaxBulkCount = 100;

int? parseStrictInt(dynamic raw) {
  if (raw == null) return null;
  if (raw is int) return raw;
  if (raw is num) return raw.toInt();
  final trimmed = raw.toString().trim();
  if (!RegExp(r'^-?\d+$').hasMatch(trimmed)) return null;
  return int.tryParse(trimmed);
}

String buildDefaultFloorName(int level, [String namePrefix = 'Tầng']) {
  if (level < 0) return 'Tầng hầm B${level.abs()}';
  if (level == 0) return 'Tầng Trệt';
  final cleanPrefix = namePrefix.trim().isEmpty ? 'Tầng' : namePrefix.trim();
  if (RegExp(r'[-_/.]+$').hasMatch(cleanPrefix)) {
    return '$cleanPrefix$level';
  }
  return '$cleanPrefix $level';
}

({int from, int to}) computeSuggestedRange(List<dynamic> existingFloors) {
  if (existingFloors.isEmpty) {
    return (from: 1, to: 5);
  }
  final levels = existingFloors
      .map((f) => parseStrictInt(f is Map ? f['level'] : null))
      .whereType<int>()
      .toList();
  if (levels.isEmpty) {
    return (from: 1, to: 5);
  }
  final maxLvl = levels.reduce(math.max);
  final nextFrom = math.min(kMaxLevel, math.max(1, maxLvl + 1));
  final nextTo = math.min(kMaxLevel, nextFrom + 4);
  return (from: nextFrom, to: nextTo);
}

/// React FloorModal:117-128 — tự quyết định includeZero theo dải tầng khi người
/// dùng CHƯA tự sửa checkbox (zeroTouched = false). Trả null = giữ nguyên.
bool? autoIncludeZeroForRange(String? fromStr, String? toStr) {
  final f = parseStrictInt(fromStr);
  final t = parseStrictInt(toStr);
  if (f == null || t == null) return null;
  if (f < 0 && t > 0) return false;
  if (f == 0 || t == 0) return true;
  return null;
}

/// Một preset chọn nhanh (React FloorModal:379-456).
class FloorPreset {
  final String label;
  final int from;
  final int to;
  final bool? includeZero;

  const FloorPreset({
    required this.label,
    required this.from,
    required this.to,
    this.includeZero,
  });
}

/// 4 preset khi chưa có tầng, 3 preset khi đã có tầng (khớp React).
List<FloorPreset> buildFloorPresets(List<dynamic> existingFloors) {
  if (existingFloors.isEmpty) {
    return const [
      FloorPreset(label: 'Tầng 1 → 5', from: 1, to: 5, includeZero: false),
      FloorPreset(label: 'Tầng 1 → 10', from: 1, to: 10, includeZero: false),
      FloorPreset(label: 'Hầm B1 + Tầng 1 → 5', from: -1, to: 5, includeZero: false),
      FloorPreset(label: 'Trệt (0) + Tầng 1 → 5', from: 0, to: 5, includeZero: true),
    ];
  }
  final sug = computeSuggestedRange(existingFloors);
  return [
    FloorPreset(label: '+5 tầng kế (${sug.from} → ${sug.to})', from: sug.from, to: sug.to),
    FloorPreset(
      label: '+10 tầng kế (${sug.from} → ${math.min(kMaxLevel, sug.from + 9)})',
      from: sug.from,
      to: math.min(kMaxLevel, sug.from + 9),
    ),
    const FloorPreset(label: 'Thêm 2 tầng hầm (B1, B2)', from: -2, to: -1, includeZero: false),
  ];
}

/// Tính danh sách tầng preview — tách để test thuần (không cần widget).
({String error, List<FloorBulkRow> rows}) computeFloorBulkRows({
  required String fromLevel,
  required String toLevel,
  required List<dynamic> existingFloors,
  required bool includeZero,
  required bool skipExisting,
  required Set<int> excludedLevels,
  required Map<int, String> customNames,
  required String namePrefix,
}) {
  final parsedFrom = parseStrictInt(fromLevel);
  final parsedTo = parseStrictInt(toLevel);

  if (parsedFrom == null || parsedTo == null) {
    return (
      error: 'Vui lòng nhập Từ tầng và Đến tầng là số nguyên hợp lệ.',
      rows: const <FloorBulkRow>[]
    );
  }
  if (parsedFrom < kMinLevel ||
      parsedTo > kMaxLevel ||
      parsedTo < kMinLevel ||
      parsedFrom > kMaxLevel) {
    return (
      error: 'Số tầng phải nằm trong khoảng từ $kMinLevel đến $kMaxLevel.',
      rows: const <FloorBulkRow>[]
    );
  }
  if (parsedFrom > parsedTo) {
    return (
      error: 'Giá trị "Từ tầng" không được lớn hơn "Đến tầng".',
      rows: const <FloorBulkRow>[]
    );
  }

  final existingByLevel = <int, dynamic>{};
  for (final f in existingFloors) {
    final lvl = parseStrictInt(f is Map ? f['level'] : null);
    if (lvl != null) existingByLevel[lvl] = f;
  }

  final rows = <FloorBulkRow>[];
  for (var lvl = parsedFrom; lvl <= parsedTo; lvl++) {
    if (lvl == 0 && !includeZero) continue;
    final existing = existingByLevel[lvl];
    final autoSkipped = existing != null && skipExisting;
    final manuallyExcluded = excludedLevels.contains(lvl);
    final checked = !autoSkipped && !manuallyExcluded;
    final defaultName = buildDefaultFloorName(lvl, namePrefix);
    final displayName = customNames[lvl] ?? defaultName;

    rows.add(FloorBulkRow(
      level: lvl,
      existing: existing,
      autoSkipped: autoSkipped,
      manuallyExcluded: manuallyExcluded,
      checked: checked,
      defaultName: defaultName,
      displayName: displayName,
      isConflict: existing != null && !skipExisting && checked,
    ));

    if (rows.length > kMaxBulkCount) {
      return (
        error: 'Một lần chỉ hỗ trợ tạo tối đa $kMaxBulkCount tầng. Vui lòng thu hẹp dải tầng.',
        rows: const <FloorBulkRow>[]
      );
    }
  }

  if (rows.isEmpty) {
    return (
      error: 'Dải tầng hiện tại không có tầng nào để tạo.',
      rows: const <FloorBulkRow>[]
    );
  }

  return (error: '', rows: rows);
}

class FloorBulkRow {
  final int level;
  final dynamic existing;
  final bool autoSkipped;
  final bool manuallyExcluded;
  final bool checked;
  final String defaultName;
  final String displayName;
  final bool isConflict;

  const FloorBulkRow({
    required this.level,
    required this.existing,
    required this.autoSkipped,
    required this.manuallyExcluded,
    required this.checked,
    required this.defaultName,
    required this.displayName,
    required this.isConflict,
  });
}

/// Port of `frontend/src/pages/admin/buildings/FloorModal.jsx`.
class FloorModal extends ConsumerStatefulWidget {
  final bool open;
  final VoidCallback? onClose;
  final String buildingId;
  final List<dynamic> existingFloors;
  final String initialMode;
  final void Function(dynamic res)? onCreated;

  const FloorModal({
    super.key,
    required this.open,
    this.onClose,
    required this.buildingId,
    this.existingFloors = const [],
    this.initialMode = 'bulk',
    this.onCreated,
  });

  @override
  ConsumerState<FloorModal> createState() => _FloorModalState();
}

class _FloorModalState extends ConsumerState<FloorModal> {
  late String _mode;
  bool _submitting = false;

  // Single form
  final _singleLevelController = TextEditingController();
  final _singleNameController = TextEditingController();

  // Bulk form
  final _fromLevelController = TextEditingController();
  final _toLevelController = TextEditingController();
  final _namePrefixController = TextEditingController(text: 'Tầng');
  bool _includeZero = false;
  bool _zeroTouched = false;
  bool _skipExisting = true;
  final Set<int> _excludedLevels = {};
  final Map<int, String> _customNames = {};

  @override
  void initState() {
    super.initState();
    _mode = widget.initialMode;
    _resetForm();
  }

  @override
  void didUpdateWidget(covariant FloorModal oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.open && !oldWidget.open) {
      _mode = widget.initialMode;
      _resetForm();
    }
  }

  @override
  void dispose() {
    _singleLevelController.dispose();
    _singleNameController.dispose();
    _fromLevelController.dispose();
    _toLevelController.dispose();
    _namePrefixController.dispose();
    super.dispose();
  }

  void _resetForm() {
    final suggested = computeSuggestedRange(widget.existingFloors);
    _singleLevelController.text = suggested.from.toString();
    _singleNameController.clear();

    _fromLevelController.text = suggested.from.toString();
    _toLevelController.text = suggested.to.toString();
    _namePrefixController.text = 'Tầng';
    _includeZero = suggested.from == 0 || suggested.to == 0;
    _zeroTouched = false;
    _skipExisting = true;
    _excludedLevels.clear();
    _customNames.clear();
  }

  ({String error, List<FloorBulkRow> rows}) _computeBulkRows() {
    return computeFloorBulkRows(
      fromLevel: _fromLevelController.text,
      toLevel: _toLevelController.text,
      existingFloors: widget.existingFloors,
      includeZero: _includeZero,
      skipExisting: _skipExisting,
      excludedLevels: _excludedLevels,
      customNames: _customNames,
      namePrefix: _namePrefixController.text,
    );
  }

  /// React FloorModal:117-128 — đổi dải tự cập nhật includeZero khi user chưa tự sửa.
  void _handleRangeChange({String? from, String? to}) {
    if (from != null) _fromLevelController.text = from;
    if (to != null) _toLevelController.text = to;
    if (!_zeroTouched) {
      final auto = autoIncludeZeroForRange(
        _fromLevelController.text,
        _toLevelController.text,
      );
      if (auto != null) _includeZero = auto;
    }
    setState(() {});
  }

  void _handleCustomNameChange(int level, String value) {
    setState(() => _customNames[level] = value);
  }

  void _handleResetCustomizations() {
    setState(() {
      _excludedLevels.clear();
      _customNames.clear();
    });
  }

  void _applyPreset(FloorPreset preset) {
    setState(() {
      _fromLevelController.text = preset.from.toString();
      _toLevelController.text = preset.to.toString();
      if (preset.includeZero != null) {
        _includeZero = preset.includeZero!;
        _zeroTouched = true;
      }
      _excludedLevels.clear();
    });
  }

  Future<void> _handleSingleSubmit() async {
    final lvl = parseStrictInt(_singleLevelController.text);
    if (lvl == null || lvl < kMinLevel || lvl > kMaxLevel) {
      ref.read(toastProvider.notifier).warning(
            'Số tầng phải là số nguyên từ $kMinLevel đến $kMaxLevel.',
          );
      return;
    }
    setState(() => _submitting = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.createFloor(widget.buildingId, {
        'level': lvl,
        'name': _singleNameController.text.trim().isEmpty
            ? null
            : _singleNameController.text.trim(),
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null)
                ? res['message'].toString()
                : 'Đã thêm tầng mới.',
          );
      widget.onCreated?.call(res);
      widget.onClose?.call();
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _handleBulkSubmit() async {
    final computation = _computeBulkRows();
    if (computation.error.isNotEmpty) {
      ref.read(toastProvider.notifier).warning(computation.error);
      return;
    }
    final conflicts = computation.rows.where((r) => r.isConflict).toList();
    if (conflicts.isNotEmpty) {
      ref.read(toastProvider.notifier).warning(
            'Vui lòng bật tự động bỏ qua tầng đã có hoặc bỏ chọn các tầng bị trùng.',
          );
      return;
    }
    final selectedRows = computation.rows.where((r) => r.checked).toList();
    if (selectedRows.isEmpty) {
      ref.read(toastProvider.notifier).warning(
            'Chưa có tầng mới nào được chọn để khởi tạo.',
          );
      return;
    }

    final payloadFloors = selectedRows.map((r) => {
          'level': r.level,
          'name': r.displayName.trim().isEmpty ? r.defaultName : r.displayName.trim(),
        }).toList();

    setState(() => _submitting = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.createFloorsBulk(widget.buildingId, {
        'floors': payloadFloors,
        'name_prefix': _namePrefixController.text.trim().isEmpty
            ? 'Tầng'
            : _namePrefixController.text.trim(),
        'skip_existing': _skipExisting,
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null)
                ? res['message'].toString()
                : 'Đã tạo ${payloadFloors.length} tầng mới.',
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

    final computation = _computeBulkRows();
    final selectedCount = computation.rows.where((r) => r.checked).length;
    final conflictCount = computation.rows.where((r) => r.isConflict).length;

    return AppModal(
      onClose: _submitting ? () {} : () => widget.onClose?.call(),
      title: 'Thêm tầng vào tòa nhà',
      subtitle: 'Khởi tạo tầng đơn lẻ hoặc tự động sinh dải tầng liên tiếp',
      size: AppModalSize.lg,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AppTabs(
            tabs: const [
              AppTabItem(id: 'bulk', label: 'Thêm hàng loạt', icon: Icon(LucideIcons.layers, size: 16)),
              AppTabItem(id: 'single', label: 'Thêm từng tầng', icon: Icon(LucideIcons.plus, size: 16)),
            ],
            activeTab: _mode,
            onChanged: (m) => setState(() => _mode = m),
          ),
          const SizedBox(height: 16),
          if (_mode == 'single') ...[
            AppInput(
              label: 'Số tầng (Level)',
              required: true,
              controller: _singleLevelController,
              placeholder: 'VD: 1, 2, -1 (Hầm B1)',
              keyboardType: const TextInputType.numberWithOptions(signed: true),
            ),
            const SizedBox(height: 12),
            AppInput(
              label: 'Tên hiển thị tầng (Tùy chọn)',
              controller: _singleNameController,
              placeholder: 'Mặc định: Tầng 1, Tầng hầm B1...',
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                AppButton(
                  text: 'Hủy',
                  variant: AppButtonVariant.outline,
                  onPressed: _submitting ? null : widget.onClose,
                ),
                const SizedBox(width: 8),
                AppButton(
                  text: 'Thêm tầng',
                  loading: _submitting,
                  onPressed: _handleSingleSubmit,
                ),
              ],
            ),
          ] else ...[
            Row(
              children: [
                Expanded(
                  child: AppInput(
                    label: 'Từ tầng',
                    required: true,
                    controller: _fromLevelController,
                    onChanged: (val) => _handleRangeChange(from: val),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: AppInput(
                    label: 'Đến tầng',
                    required: true,
                    controller: _toLevelController,
                    onChanged: (val) => _handleRangeChange(to: val),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: AppInput(
                    label: 'Tiền tố tên',
                    controller: _namePrefixController,
                    placeholder: 'Tầng',
                    onChanged: (_) => setState(() {}),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final preset in buildFloorPresets(widget.existingFloors))
                  ActionChip(
                    label: Text(preset.label),
                    onPressed: () => _applyPreset(preset),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Checkbox(
                  key: const Key('include-zero-checkbox'),
                  value: _includeZero,
                  onChanged: (val) {
                    setState(() {
                      _includeZero = val ?? false;
                      _zeroTouched = true;
                    });
                  },
                ),
                const Text('Bao gồm tầng 0 (Tầng Trệt)', style: TextStyle(fontSize: 13)),
                const SizedBox(width: 16),
                Checkbox(
                  value: _skipExisting,
                  onChanged: (val) {
                    setState(() => _skipExisting = val ?? true);
                  },
                ),
                const Text('Tự động bỏ qua tầng đã có', style: TextStyle(fontSize: 13)),
              ],
            ),
            const SizedBox(height: 12),
            if (computation.error.isNotEmpty)
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.rose50,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.rose200),
                ),
                child: Text(
                  computation.error,
                  style: const TextStyle(color: AppColors.rose700, fontSize: 13),
                ),
              )
            else
              Container(
                constraints: const BoxConstraints(maxHeight: 220),
                decoration: BoxDecoration(
                  border: Border.all(color: AppColors.slate200),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: computation.rows.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final row = computation.rows[index];
                    return Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      child: Row(
                        children: [
                          Checkbox(
                            value: row.checked,
                            onChanged: row.autoSkipped
                                ? null
                                : (checked) {
                                    setState(() {
                                      if (checked == true) {
                                        _excludedLevels.remove(row.level);
                                      } else {
                                        _excludedLevels.add(row.level);
                                      }
                                    });
                                  },
                          ),
                          Text('Tầng ${row.level}',
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                          const SizedBox(width: 12),
                          Expanded(
                            child: AppInput(
                              key: Key('floor-name-${row.level}'),
                              initialValue: row.displayName,
                              placeholder: row.defaultName,
                              enabled: !row.autoSkipped && row.checked && !_submitting,
                              onChanged: (value) => _handleCustomNameChange(row.level, value),
                            ),
                          ),
                          if (row.autoSkipped)
                            const AppBadge(
                              label: 'Đã có (Bỏ qua)',
                              variant: AppBadgeVariant.slate,
                            )
                          else if (row.isConflict)
                            const AppBadge(
                              label: 'Trùng',
                              variant: AppBadgeVariant.red,
                            )
                          else
                            const AppBadge(
                              label: 'Mới',
                              variant: AppBadgeVariant.emerald,
                            ),
                        ],
                      ),
                    );
                  },
                ),
              ),
            const SizedBox(height: 16),
            Wrap(
              alignment: WrapAlignment.spaceBetween,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 8,
              runSpacing: 8,
              children: [
                Text(
                  'Chọn $selectedCount tầng để tạo${conflictCount > 0 ? ' · $conflictCount bị trùng' : ''}',
                  style: const TextStyle(fontSize: 12, color: AppColors.slate500),
                ),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    if (_excludedLevels.isNotEmpty || _customNames.isNotEmpty)
                      AppButton(
                        text: 'Khôi phục mặc định',
                        variant: AppButtonVariant.ghost,
                        onPressed: _submitting ? null : _handleResetCustomizations,
                      ),
                    AppButton(
                      text: 'Hủy',
                      variant: AppButtonVariant.outline,
                      onPressed: _submitting ? null : widget.onClose,
                    ),
                    AppButton(
                      text: 'Khởi tạo tầng',
                      loading: _submitting,
                      onPressed: conflictCount > 0 || selectedCount == 0
                          ? null
                          : _handleBulkSubmit,
                    ),
                  ],
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
