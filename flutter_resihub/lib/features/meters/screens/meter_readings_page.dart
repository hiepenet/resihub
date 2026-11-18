import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/base64_file.dart';
import '../../../core/utils/billing_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/search_bar_widget.dart';
import '../../../shared/widgets/common/stats_card.dart';
import '../../../shared/widgets/ui/ai_suggestion_field.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../../ai_gateway/services/ai_service.dart';
import '../../auth/providers/auth_provider.dart';
import '../../auth/providers/permission_provider.dart';
import '../../buildings/providers/buildings_lookup_provider.dart';
import '../../buildings/services/buildings_service.dart';
import '../services/meters_service.dart';
import '../widgets/meter_batch_photo_import_modal.dart';

const List<Map<String, String>> kMeterTypeOptions = [
  {'value': '', 'label': 'Tất cả loại đồng hồ'},
  {'value': 'ELECTRICITY', 'label': '⚡ Đồng hồ Điện (kWh)'},
  {'value': 'WATER', 'label': '💧 Đồng hồ Nước (m³)'},
];

/// Trạng thái chốt theo React (không có UNRECORDED); nhãn FLAGGED dùng ngưỡng từ API.
List<Map<String, String>> meterStatusOptions(num anomalyThresholdPct) => [
      {'value': '', 'label': 'Tất cả trạng thái chốt'},
      {'value': 'CONFIRMED', 'label': 'Đã chốt (CONFIRMED)'},
      {'value': 'DRAFT', 'label': 'Bản nháp (DRAFT)'},
      {'value': 'FLAGGED', 'label': 'Tạm giữ >$anomalyThresholdPct% (FLAGGED)'},
    ];

/// Utility Meters & Readings Page (M08).
/// Port of `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`.
class MeterReadingsPage extends ConsumerStatefulWidget {
  final String? initialMeterId;
  final String? initialModal;

  const MeterReadingsPage({
    super.key,
    this.initialMeterId,
    this.initialModal,
  });

  @override
  ConsumerState<MeterReadingsPage> createState() => _MeterReadingsPageState();
}

class _MeterReadingsPageState extends ConsumerState<MeterReadingsPage> {
  List<Map<String, dynamic>> _meters = [];
  List<Map<String, dynamic>> _buildings = [];
  bool _loading = true;

  String _selectedBuildingId = '';
  String _period = getCurrentPeriod();
  String _meterType = '';
  String _statusFilter = '';
  String _search = '';
  String _activeContractFilter = 'true';
  bool _abnormalOnly = false;
  double _anomalyThresholdPct = 30.0;

  // Local drafts and notes
  final Map<String, String> _draftReadings = {};
  final Map<String, String> _abnormalNotes = {};
  final Map<String, TextEditingController> _inlineReadingControllers = {};
  // AI OCR suggestion state per row (inline edit), mirrors React aiOcrByMeter.
  final Map<String, Map<String, dynamic>> _rowOcr = {};
  bool _batchSaving = false;
  bool _deepLinkHandled = false;

  @override
  void dispose() {
    for (final c in _inlineReadingControllers.values) {
      c.dispose();
    }
    _inlineReadingControllers.clear();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _selectedBuildingId = ref.read(authProvider).selectedBuildingId;
    // Use cached buildings from buildingsListProvider if available to avoid race condition
    final cachedBuildings = ref.read(buildingsListProvider).valueOrNull;
    if (cachedBuildings != null && cachedBuildings.isNotEmpty) {
      _buildings = cachedBuildings;
      if (_selectedBuildingId.isEmpty) {
        _selectedBuildingId = _buildings.first['id']?.toString() ?? '';
      }
      _fetchMeters(); // safe: buildings already loaded
    } else {
      _loadBuildingsThenMeters(); // sequential: buildings first, then meters
    }
  }

  Future<void> _loadBuildingsThenMeters() async {
    await _loadBuildings();
    _fetchMeters();
  }

  Future<void> _loadBuildings() async {
    try {
      // Try cached provider first to avoid a redundant API call
      final cached = ref.read(buildingsListProvider).valueOrNull;
      if (cached != null && cached.isNotEmpty) {
        if (mounted) {
          setState(() {
            _buildings = cached;
            if (_selectedBuildingId.isEmpty && _buildings.isNotEmpty) {
              _selectedBuildingId = _buildings.first['id']?.toString() ?? '';
            }
          });
        }
        return;
      }
      // Fallback to direct API
      final res = await ref.read(buildingsServiceProvider).list();
      final list = (res is Map && res['data'] is List)
          ? (res['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : <Map<String, dynamic>>[];
      if (mounted) {
        setState(() {
          _buildings = list;
          if (_selectedBuildingId.isEmpty && list.isNotEmpty) {
            _selectedBuildingId = list[0]['id']?.toString() ?? '';
          }
        });
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách tòa nhà.'),
            );
      }
    }
  }

  Future<void> _fetchMeters({bool force = false}) async {
    final params = buildMeterListQueryParams(
      buildingId: _selectedBuildingId,
      period: _period,
      activeContractFilter: _activeContractFilter,
    );

    final metersService = ref.read(metersServiceProvider);
    if (!force) {
      final cached = metersService.peekList(params);
      final cachedList = (cached is Map && cached['data'] is List)
          ? (cached['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : (cached is List)
              ? cached.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
              : null;
      if (cachedList != null) {
        if (mounted) {
          setState(() {
            _meters = cachedList;
            _anomalyThresholdPct = resolveAnomalyThresholdPct(
              cached is Map ? cached['anomaly_threshold_pct'] : null,
            );
            for (final m in cachedList) {
              final id = m['id']?.toString() ?? '';
              if (m['period_current_reading'] != null) {
                _draftReadings[id] = m['period_current_reading'].toString();
              }
              if (m['period_abnormal_note'] != null) {
                _abnormalNotes[id] = m['period_abnormal_note'].toString();
              }
            }
            _loading = false;
          });
          _checkAndTriggerDeepLink();
        }
        return;
      }
    }

    if (_meters.isEmpty) setState(() => _loading = true);

    try {
      final res = await metersService.list(params, null, force);
      final list = (res is Map && res['data'] is List)
          ? (res['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : (res is List)
              ? res.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
              : <Map<String, dynamic>>[];

      if (mounted) {
        setState(() {
          _meters = list;
          _anomalyThresholdPct = resolveAnomalyThresholdPct(
            res is Map ? res['anomaly_threshold_pct'] : null,
          );
          for (final m in list) {
            final id = m['id']?.toString() ?? '';
            if (m['period_current_reading'] != null) {
              final nextDraft = m['period_current_reading'].toString();
              _draftReadings[id] = nextDraft;
              final ctrl = _inlineReadingControllers[id];
              if (ctrl != null && ctrl.text != nextDraft) {
                ctrl.text = nextDraft;
              }
            } else {
              _draftReadings.remove(id);
              final ctrl = _inlineReadingControllers[id];
              if (ctrl != null && ctrl.text.isNotEmpty) {
                ctrl.text = '';
              }
            }
            if (m['period_abnormal_note'] != null) {
              _abnormalNotes[id] = m['period_abnormal_note'].toString();
            }
          }
          _loading = false;
        });
        _checkAndTriggerDeepLink();
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách công tơ.'),
            );
      }
    }
  }

  void _checkAndTriggerDeepLink() {
    if (_deepLinkHandled) return;

    String? meterId = widget.initialMeterId;
    if (meterId == null || meterId.isEmpty) {
      try {
        final routerState = GoRouterState.of(context);
        meterId = routerState.uri.queryParameters['meter_id'];
      } catch (_) {}
    }

    if (meterId == null || meterId.isEmpty) return;

    final matched = _meters.firstWhere(
      (m) => m['id']?.toString() == meterId,
      orElse: () => {},
    );

    if (matched.isNotEmpty) {
      _deepLinkHandled = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _openSingleDetailModal(matched);
      });
    }
  }

  List<Map<String, dynamic>> get _filteredMeters {
    final q = _search.trim().toLowerCase();
    return _meters.where((m) {
      if (_meterType.isNotEmpty && m['meter_type']?.toString() != _meterType) {
        return false;
      }
      if (_statusFilter.isNotEmpty &&
          m['period_reading_status']?.toString() != _statusFilter) {
        return false;
      }
      if (_abnormalOnly && m['period_is_abnormal'] != true) {
        return false;
      }
      if (q.isNotEmpty) {
        final apt = (m['apartment_code'] ?? '').toString().toLowerCase();
        final code = (m['meter_code'] ?? '').toString().toLowerCase();
        final bld = (m['building_code'] ?? '').toString().toLowerCase();
        if (!apt.contains(q) && !code.contains(q) && !bld.contains(q)) return false;
      }
      return true;
    }).toList();
  }

  void _openBatchImportModal() {
    MeterBatchPhotoImportModal.show(
      context: context,
      initialBuildingId: _selectedBuildingId,
      period: _period,
      anomalyThresholdPct: _anomalyThresholdPct,
      canWriteMeters: ref.read(permissionProvider).canRecordMeters,
      onSaved: () => _fetchMeters(force: true),
    );
  }

  Future<void> _openCreateMeterModal() async {
    String apartmentId = '';
    String meterType = 'ELECTRICITY';
    String meterCode = '';
    int unitPrice = 3800;
    int initialReading = 0;
    bool saving = false;

    List<Map<String, dynamic>> apartments = [];
    try {
      final res = await ref.read(buildingsServiceProvider).listApartments(
        _selectedBuildingId.isNotEmpty ? {'building_id': _selectedBuildingId} : null,
      );
      apartments = (res is Map && res['data'] is List)
          ? (res['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : (res is List)
              ? res.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
              : <Map<String, dynamic>>[];
      if (apartments.isNotEmpty) {
        apartmentId = apartments.first['id']?.toString() ?? '';
      }
    } catch (_) {
      apartments = [];
    }

    if (!mounted) return;

    AppModal.show<void>(
      context: context,
      title: 'Khởi tạo Công tơ Điện / Nước mới',
      subtitle: 'Gán đồng hồ đo chỉ số vào căn hộ',
      size: AppModalSize.md,
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (apartments.isNotEmpty)
                AppSelect<String>(
                  label: 'Căn hộ áp dụng',
                  required: true,
                  placeholder: '-- Chọn căn hộ --',
                  value: apartmentId.isNotEmpty ? apartmentId : null,
                  options: apartments.map((a) {
                    final code = a['code'] ?? a['apartment_code'] ?? a['id'] ?? '';
                    final bCode = a['building_code'] ?? '';
                    final prefix = bCode.toString().isNotEmpty ? '$bCode - ' : '';
                    final status = a['status'] == 'OCCUPIED' ? 'Đang thuê' : (a['status'] ?? '');
                    final suffix = status.isNotEmpty ? ' ($status)' : '';
                    return AppSelectOption(
                      value: a['id']?.toString() ?? '',
                      label: '${prefix}Căn $code$suffix',
                    );
                  }).toList(),
                  onChanged: (val) {
                    if (val != null) setModalState(() => apartmentId = val);
                  },
                )
              else
                AppInput(
                  label: 'Mã căn hộ / Apartment ID',
                  required: true,
                  placeholder: 'Nhập ID hoặc mã căn hộ (VD: 101, 202...)',
                  initialValue: apartmentId,
                  onChanged: (val) => apartmentId = val.trim(),
                ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: AppSelect<String>(
                      label: 'Loại công tơ',
                      value: meterType,
                      options: const [
                        AppSelectOption(value: 'ELECTRICITY', label: 'Điện sinh hoạt (kWh)'),
                        AppSelectOption(value: 'WATER', label: 'Nước sinh hoạt (m³)'),
                      ],
                      onChanged: (val) {
                        if (val != null) {
                          setModalState(() {
                            meterType = val;
                            unitPrice = val == 'ELECTRICITY' ? 3800 : 22000;
                          });
                        }
                      },
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Mã số công tơ',
                      placeholder: 'VD: EM-101, WM-101',
                      initialValue: meterCode,
                      onChanged: (val) => meterCode = val.trim(),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Đơn giá cơ bản (VNĐ)',
                      required: true,
                      placeholder: '3800',
                      initialValue: unitPrice.toString(),
                      onChanged: (val) => unitPrice = int.tryParse(val.trim()) ?? 0,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Chỉ số ban đầu',
                      placeholder: '0',
                      initialValue: initialReading.toString(),
                      onChanged: (val) => initialReading = int.tryParse(val.trim()) ?? 0,
                    ),
                  ),
                ],
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
                    text: 'Tạo công tơ',
                    variant: AppButtonVariant.primary,
                    loading: saving,
                    onPressed: () async {
                      if (apartmentId.isEmpty) {
                        ref.read(toastProvider.notifier).warning('Vui lòng chọn căn hộ cần lắp đặt đồng hồ.');
                        return;
                      }

                      setModalState(() => saving = true);
                      try {
                        await ref.read(metersServiceProvider).create({
                          'apartment_id': apartmentId,
                          'meter_type': meterType,
                          'meter_code': meterCode.trim().isNotEmpty ? meterCode.trim() : null,
                          'unit_price': unitPrice,
                          'initial_reading': initialReading,
                        });
                        ref.read(toastProvider.notifier).success('Đã tạo mới công tơ thành công.');
                        if (ctx.mounted) Navigator.of(ctx).pop();
                        _fetchMeters(force: true);
                      } catch (err) {
                        setModalState(() => saving = false);
                        ref.read(toastProvider.notifier).error(
                              extractErrorMessage(err, 'Không thể tạo công tơ.'),
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

  Future<void> _openSingleDetailModal(Map<String, dynamic> rawMeter) async {
    String? selectedContractId = rawMeter['target_contract_id']?.toString();
    Map<String, dynamic> activeMeter = resolveMeterSlotView(rawMeter, selectedContractId);

    final meterId = rawMeter['id']?.toString() ?? '';
    final draftVal = _draftReadings[meterId] ??
        (activeMeter['period_current_reading'] != null ? activeMeter['period_current_reading'].toString() : '');
    final noteVal = _abnormalNotes[meterId] ?? (activeMeter['period_abnormal_note']?.toString() ?? '');

    String currentReadingStr = draftVal;
    String abnormalNote = noteVal;
    String? proofImage = activeMeter['period_image_url']?.toString();
    String? aiSuggestionId;
    num? aiOcrReading;
    dynamic aiOcrConfidence;
    bool aiOcrConfirmed = false;
    bool aiOcrEdited = false;
    String? aiOcrWarningText;
    bool isAiRunning = false;
    bool saving = false;
    final readingController = TextEditingController(text: currentReadingStr);

    // Reading history for this meter (React :1597-1666).
    List<Map<String, dynamic>> history = [];
    bool historyLoading = true;
    try {
      final res = await ref.read(metersServiceProvider).listMeterReadings(meterId);
      final raw = (res is Map && res['data'] is List)
          ? res['data'] as List
          : (res is List ? res : const <dynamic>[]);
      history = raw.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
    } catch (_) {
      history = [];
    } finally {
      historyLoading = false;
    }
    if (!mounted) return;

    AppModal.show<void>(
      context: context,
      title: 'Ghi chỉ số chi tiết • Căn ${activeMeter['apartment_code']}',
      subtitle: '${activeMeter['meter_type'] == 'WATER' ? 'Đồng hồ Nước' : 'Đồng hồ Điện'} (${activeMeter['meter_code']}) • Kỳ $_period',
      size: AppModalSize.lg,
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          final canWrite = ref.watch(permissionProvider).canRecordMeters;
          final isLocked = isMeterRowLockedForEdit(activeMeter, canWrite);

          final overlapping = activeMeter['overlapping_contracts'] is List
              ? (activeMeter['overlapping_contracts'] as List).whereType<Map>().toList()
              : <Map>[];

          final prevReading =
              num.tryParse(activeMeter['period_previous_reading']?.toString() ?? '') ??
                  num.tryParse(activeMeter['last_known_reading']?.toString() ?? '') ??
                  0;

          final currentNum = num.tryParse(currentReadingStr.trim());
          final consumption = currentNum != null && currentNum >= prevReading ? currentNum - prevReading : null;
          final estimatedMoney = computeMeterEstimatedAmount(consumption?.toDouble(), activeMeter);

          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              // Turnover multi-slot contract switcher
              if (overlapping.length > 1) ...[
                const Text(
                  'Đợt hợp đồng chuyển giao trong kỳ (Turnover):',
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.slate700),
                ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 8,
                  children: overlapping.map((slot) {
                    final isSelected = slot['contract_id']?.toString() == selectedContractId;
                    return ChoiceChip(
                      label: Text('Đợt ${slot['slot_index']}/${slot['total_slots']} • ${slot['contract_code']} (${slot['tenant_name'] ?? '—'})'),
                      selected: isSelected,
                      onSelected: (val) {
                        if (val) {
                          setModalState(() {
                            selectedContractId = slot['contract_id']?.toString();
                            activeMeter = resolveMeterSlotView(rawMeter, selectedContractId);
                            currentReadingStr = activeMeter['period_current_reading']?.toString() ?? '';
                            readingController.text = currentReadingStr;
                            proofImage = activeMeter['period_image_url']?.toString();
                            aiOcrReading = null;
                            aiOcrConfidence = null;
                            aiOcrConfirmed = false;
                            aiOcrEdited = false;
                            aiOcrWarningText = null;
                            aiSuggestionId = null;
                          });
                        }
                      },
                    );
                  }).toList(),
                ),
                const Divider(height: 24),
              ],

              Row(
                children: [
                  Expanded(
                    child: AppCard(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Chỉ số kỳ trước', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                          const SizedBox(height: 4),
                          Text(
                            '$prevReading ${activeMeter['unit'] ?? ''}',
                            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppCard(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Tiêu thụ ước tính', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                          const SizedBox(height: 4),
                          Text(
                            consumption != null ? '$consumption ${activeMeter['unit'] ?? ''}' : '—',
                            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.primary600),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppCard(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Thành tiền ước tính', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                          const SizedBox(height: 4),
                          Text(
                            estimatedMoney != null ? formatMoney(estimatedMoney) : '—',
                            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.slate900),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),

              if (isLocked)
                Container(
                  padding: const EdgeInsets.all(10),
                  margin: const EdgeInsets.only(bottom: 12),
                  decoration: BoxDecoration(
                    color: AppColors.slate100,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.slate300),
                  ),
                  child: const Row(
                    children: [
                      Icon(LucideIcons.lock, size: 16, color: AppColors.slate600),
                      SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'Đợt hợp đồng này đã được lập hóa đơn phát hành hoặc đã quyết toán. Chỉ số đã bị khóa không cho chỉnh sửa.',
                          style: TextStyle(fontSize: 12, color: AppColors.slate700),
                        ),
                      ),
                    ],
                  ),
                ),

              // Reading input with AISuggestionField
              AISuggestionField(
                active: !isLocked && aiOcrReading != null,
                confirmed: aiOcrConfirmed,
                edited: aiOcrEdited,
                confidence: aiOcrConfidence,
                threshold: 0.85,
                warningText: aiOcrWarningText,
                onConfirm: () => setModalState(() {
                  aiOcrConfirmed = true;
                  aiOcrEdited = num.tryParse(readingController.text.trim()) != aiOcrReading;
                }),
                onDismiss: () => setModalState(() {
                  aiOcrReading = null;
                  aiOcrConfidence = null;
                  aiOcrConfirmed = false;
                  aiOcrEdited = false;
                  aiOcrWarningText = null;
                  aiSuggestionId = null;
                }),
                child: AppInput(
                  controller: readingController,
                  label: 'Chỉ số mới kỳ $_period (${activeMeter['unit'] ?? ''})',
                  required: true,
                  readOnly: isLocked,
                  placeholder: '>= $prevReading',
                  onChanged: (val) {
                    setModalState(() {
                      currentReadingStr = val.trim();
                      if (aiOcrReading != null) {
                        aiOcrConfirmed = true;
                        aiOcrEdited = num.tryParse(val.trim()) != aiOcrReading;
                      }
                    });
                  },
                ),
              ),
              const SizedBox(height: 12),

              // Abnormal note
              AppInput(
                label: 'Ghi chú bất thường / giải trình (nếu có biến động >${_anomalyThresholdPct.round()}%)',
                readOnly: isLocked,
                initialValue: abnormalNote,
                placeholder: 'VD: Khách mới dọn vào sửa nhà, vòi nước rò rỉ đã sửa...',
                onChanged: (val) => abnormalNote = val.trim(),
              ),
              const SizedBox(height: 14),

              // Image proof & single OCR
              const Text('Ảnh chụp mặt công tơ bằng chứng:', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500)),
              const SizedBox(height: 6),
              if (!isLocked) ...[
                FileUploadField(
                  value: proofImage,
                  allowPdf: false,
                  hint: 'Chụp hoặc tải ảnh mặt đồng hồ để lưu bằng chứng & AI OCR',
                  onChanged: (val) async {
                    final dataUrl = val?.toString();
                    setModalState(() => proofImage = dataUrl);

                    if (dataUrl != null && dataUrl.startsWith('data:image/')) {
                      setModalState(() => isAiRunning = true);
                      try {
                        final res = await ref.read(aiServiceProvider).ocrMeterReading({
                          'period': _period,
                          'image_base64': dataUrl,
                          'meter_id': activeMeter['id'],
                          if (activeMeter['target_contract_id'] != null) 'contract_id': activeMeter['target_contract_id'],
                        });
                        final data = res is Map ? (res['data'] is Map ? res['data'] : res) : {};
                        final out = data['output'] is Map ? data['output'] : {};

                        if (out['reading'] != null) {
                          final readingVal = out['reading'];
                          setModalState(() {
                            readingController.text = readingVal.toString();
                            currentReadingStr = readingVal.toString();
                            aiSuggestionId = data['suggestion_id']?.toString();
                            aiOcrReading = num.tryParse(readingVal.toString());
                            aiOcrConfidence = data['confidence'] ?? out['confidence'];
                            aiOcrWarningText = (out['reason']?.toString().isNotEmpty == true)
                                ? out['reason'].toString()
                                : (data['warnings'] is List && (data['warnings'] as List).isNotEmpty)
                                    ? (data['warnings'] as List).join(', ')
                                    : null;
                            aiOcrConfirmed = false;
                            aiOcrEdited = false;
                          });
                          ref.read(toastProvider.notifier).success('AI đã đọc chỉ số: $readingVal');
                        } else if (out['reason'] != null) {
                          ref.read(toastProvider.notifier).warning(out['reason'].toString());
                        }
                      } catch (err) {
                        ref.read(toastProvider.notifier).error(
                              extractErrorMessage(err, 'Không thể nhận diện AI từ ảnh này.'),
                            );
                      } finally {
                        setModalState(() => isAiRunning = false);
                      }
                    }
                  },
                ),
              ] else if (proofImage != null && proofImage!.isNotEmpty) ...[
                InkWell(
                  onTap: () => AuthMediaViewer.show(context, src: proofImage!),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: AuthImage(src: proofImage, width: 120, height: 120, fit: BoxFit.cover),
                  ),
                ),
              ],

              if (isAiRunning)
                const Padding(
                  padding: EdgeInsets.only(top: 8.0),
                  child: Row(
                    children: [
                      SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
                      SizedBox(width: 8),
                      Text('Đang nhận diện chỉ số bằng AI...', style: TextStyle(fontSize: 12, color: AppColors.primary600)),
                    ],
                  ),
                ),

              const SizedBox(height: 16),
              _buildReadingHistory(history, historyLoading),
              const SizedBox(height: 24),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Đóng',
                    variant: AppButtonVariant.outline,
                    onPressed: saving ? null : () => Navigator.of(ctx).pop(),
                  ),
                  if (!isLocked) ...[
                    const SizedBox(width: 8),
                    AppButton(
                      text: 'Lưu nháp',
                      variant: AppButtonVariant.outline,
                      loading: saving,
                      onPressed: () async {
                        final valNum = num.tryParse(currentReadingStr.trim());
                        if (valNum == null || valNum < prevReading) {
                          ref.read(toastProvider.notifier).warning('Chỉ số mới không được nhỏ hơn chỉ số cũ ($prevReading).');
                          return;
                        }

                        setModalState(() => saving = true);
                        try {
                          await ref.read(metersServiceProvider).recordReading(activeMeter['id'].toString(), {
                            'period': _period,
                            'current_reading': valNum,
                            'status': 'DRAFT',
                            if (activeMeter['target_contract_id'] != null) 'contract_id': activeMeter['target_contract_id'],
                            if (abnormalNote.isNotEmpty) 'abnormal_note': abnormalNote,
                            if (proofImage != null && proofImage!.startsWith('data:image/')) 'image_base64': proofImage,
                            if (aiSuggestionId != null) 'ai_suggestion_id': aiSuggestionId,
                          });
                          ref.read(toastProvider.notifier).success('Đã lưu nháp chỉ số.');
                          if (ctx.mounted) Navigator.of(ctx).pop();
                          _fetchMeters(force: true);
                        } catch (err) {
                          setModalState(() => saving = false);
                          ref.read(toastProvider.notifier).error(
                                extractErrorMessage(err, 'Không thể lưu chỉ số.'),
                              );
                        }
                      },
                    ),
                    const SizedBox(width: 8),
                    AppButton(
                      text: 'Xác nhận chốt',
                      variant: AppButtonVariant.primary,
                      loading: saving,
                      onPressed: () async {
                        final readingId = activeMeter['period_reading_id']?.toString();
                        if (readingId == null || readingId.isEmpty) {
                          ref.read(toastProvider.notifier).warning(
                                'Chỉ số chưa được lưu. Vui lòng lưu nháp trước khi xác nhận chốt.',
                              );
                          return;
                        }
                        if (activeMeter['period_is_abnormal'] == true && abnormalNote.trim().isEmpty) {
                          ref.read(toastProvider.notifier).warning(
                                'Vui lòng nhập ghi chú giải trình bất thường trước khi xác nhận chốt.',
                              );
                          return;
                        }

                        setModalState(() => saving = true);
                        try {
                          await ref.read(metersServiceProvider).confirmReading(readingId, {
                            if (abnormalNote.trim().isNotEmpty) 'abnormal_note': abnormalNote.trim(),
                          });
                          ref.read(toastProvider.notifier).success('Đã xác nhận chốt chỉ số công tơ.');
                          if (ctx.mounted) Navigator.of(ctx).pop();
                          _fetchMeters(force: true);
                        } catch (err) {
                          setModalState(() => saving = false);
                          ref.read(toastProvider.notifier).error(
                                extractErrorMessage(err, 'Không thể xác nhận chốt chỉ số.'),
                              );
                        }
                      },
                    ),
                  ],
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _handleQuickConfirm(Map<String, dynamic> meter) async {
    final readingId = meter['period_reading_id']?.toString();
    if (readingId == null || readingId.isEmpty) return;

    final meterId = meter['id']?.toString() ?? '';
    final note = (_abnormalNotes[meterId] ?? meter['period_abnormal_note'] ?? '').toString().trim();
    final isAbnormal = meter['period_is_abnormal'] == true;
    if (isAbnormal && note.isEmpty) {
      ref.read(toastProvider.notifier).warning(
            'Công tơ ${meter['meter_code'] ?? ''} có biến động >${_anomalyThresholdPct.round()}%. '
            'Vui lòng nhập ghi chú giải trình trước khi xác nhận chốt.',
          );
      return;
    }

    try {
      await ref.read(metersServiceProvider).confirmReading(readingId, {
        if (note.isNotEmpty) 'abnormal_note': note,
      });
      ref.read(toastProvider.notifier).success('Đã chốt nhanh chỉ số công tơ.');
      _fetchMeters(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể chốt chỉ số.'),
          );
    }
  }

  Future<void> _handleConfirmAllEligible() async {
    final eligibleIds = _meters
        .where((m) =>
            m['period_reading_id'] != null &&
            m['period_reading_status'] != 'CONFIRMED' &&
            m['period_reading_billed'] != true)
        .map((m) => m['period_reading_id'].toString())
        .toList();

    if (eligibleIds.isEmpty) {
      ref.read(toastProvider.notifier).info('Không có chỉ số nháp nào cần chốt.');
      return;
    }

    final confirmed = await ConfirmDialog.show(
      context: context,
      title: 'Chốt chỉ số hàng loạt',
      message: 'Bạn có chắc chắn muốn chốt toàn bộ ${eligibleIds.length} chỉ số nháp đang hiển thị?',
      confirmLabel: 'Chốt hàng loạt',
      variant: ConfirmDialogVariant.primary,
    );

    if (confirmed != true) return;

    setState(() => _batchSaving = true);
    try {
      await ref.read(metersServiceProvider).confirmBatch({
        'period': _period,
        'building_id': _selectedBuildingId,
        'reading_ids': eligibleIds,
      });
      ref.read(toastProvider.notifier).success('Đã chốt thành công ${eligibleIds.length} chỉ số công tơ.');
      _fetchMeters(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể chốt hàng loạt.'),
          );
    } finally {
      if (mounted) setState(() => _batchSaving = false);
    }
  }

  /// Reading history table shown in the single-meter detail modal.
  Widget _buildReadingHistory(List<Map<String, dynamic>> history, bool loading) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text(
          'Lịch sử ghi chỉ số của công tơ này',
          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.slate700),
        ),
        const SizedBox(height: 6),
        if (loading)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Text('Đang tải lịch sử...', style: TextStyle(fontSize: 12, color: AppColors.slate400)),
          )
        else if (history.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Text('Chưa có lịch sử ghi nhận nào.', style: TextStyle(fontSize: 12, color: AppColors.slate400)),
          )
        else
          Container(
            decoration: BoxDecoration(
              border: Border.all(color: AppColors.slate200),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Column(
              children: history.map((h) {
                final status = h['status']?.toString() ?? 'CONFIRMED';
                final abnormal = h['is_abnormal'] == true;
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 92,
                        child: Text(
                          h['period']?.toString() ?? '—',
                          style: const TextStyle(fontFamily: 'monospace', fontSize: 12, fontWeight: FontWeight.w600),
                        ),
                      ),
                      Expanded(
                        child: Text(
                          '${h['previous_reading'] ?? 0} → ${h['current_reading'] ?? 0} '
                          '(${h['consumption'] ?? 0})',
                          style: const TextStyle(fontSize: 12, color: AppColors.slate700),
                        ),
                      ),
                      if (abnormal)
                        const AppBadge(label: 'Bất thường', variant: AppBadgeVariant.amber),
                      const SizedBox(width: 6),
                      AppBadge(
                        label: status == 'CONFIRMED'
                            ? 'Đã chốt'
                            : status == 'FLAGGED'
                                ? 'Tạm giữ'
                                : status == 'DRAFT'
                                    ? 'Nháp'
                                    : status,
                        variant: status == 'CONFIRMED'
                            ? AppBadgeVariant.emerald
                            : status == 'FLAGGED'
                                ? AppBadgeVariant.amber
                                : AppBadgeVariant.sky,
                      ),
                    ],
                  ),
                );
              }).toList(),
            ),
          ),
      ],
    );
  }

  /// Inline "Chỉ số mới" editor. Validates current reading >= previous reading
  /// and wraps the field in [AISuggestionField] for AI OCR confirm/dismiss.
  Widget _buildInlineReadingCell(Map<String, dynamic> meter) {
    final id = meter['id']?.toString() ?? '';
    final prev = num.tryParse(
          (meter['period_previous_reading'] ?? meter['last_known_reading'] ?? 0).toString(),
        ) ??
        0;
    final locked = isMeterRowLockedForEdit(meter, ref.read(permissionProvider).canRecordMeters);
    final draft = _draftReadings[id] ?? '';
    final valNum = num.tryParse(draft.trim());
    final invalid = draft.trim().isNotEmpty && (valNum == null || valNum < prev);
    final ocr = _rowOcr[id];

    return AISuggestionField(
      active: ocr?['active'] == true,
      confirmed: ocr?['confirmed'] == true,
      edited: ocr?['edited'] == true,
      confidence: ocr?['confidence'],
      threshold: 0.85,
      warningText: ocr?['reason']?.toString(),
      onConfirm: () {
        if (ocr == null) return;
        final nextVal = ocr['reading']?.toString() ?? draft;
        _inlineReadingControllers[id]?.text = nextVal;
        setState(() {
          _draftReadings[id] = nextVal;
          _rowOcr[id] = {...ocr, 'confirmed': true, 'edited': false};
        });
      },
      onDismiss: () => setState(() => _rowOcr.remove(id)),
      child: AppInput(
        key: Key('meter-inline-reading-$id'),
        controller: _inlineReadingControllers.putIfAbsent(
          id,
          () => TextEditingController(text: draft),
        ),
        readOnly: locked,
        placeholder: '>= $prev',
        error: invalid ? '< $prev' : null,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        onChanged: (val) => setState(() {
          _draftReadings[id] = val.trim();
          if (ocr != null) {
            _rowOcr[id] = {
              ...ocr,
              'edited': num.tryParse(val.trim()) != num.tryParse(ocr['reading']?.toString() ?? ''),
            };
          }
        }),
      ),
    );
  }

  /// AI OCR for a single table row: pick image, call OCR, seed inline draft + suggestion.
  Future<void> _scanRowOcr(Map<String, dynamic> meter) async {
    final id = meter['id']?.toString() ?? '';
    try {
      final result = await FilePicker.platform.pickFiles(type: FileType.image, withData: true);
      final file = result?.files.single;
      final bytes = file?.bytes;
      if (file == null || bytes == null) return;
      final mime = file.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      final dataUrl = encodeBytesToDataUrl(bytes, mimeType: mime);
      final res = await ref.read(aiServiceProvider).ocrMeterReading({
        'period': _period,
        'image_base64': dataUrl,
        'meter_id': id,
        if (meter['target_contract_id'] != null) 'contract_id': meter['target_contract_id'],
      });
      final data = res is Map ? (res['data'] is Map ? res['data'] : res) : {};
      final out = data['output'] is Map ? data['output'] : {};
      final reading = out['reading'];
      if (reading == null) {
        if (out['reason'] != null && mounted) {
          ref.read(toastProvider.notifier).warning(out['reason'].toString());
        }
        return;
      }
      if (!mounted) return;
      final readingStr = reading.toString();
      final ctrl = _inlineReadingControllers.putIfAbsent(id, () => TextEditingController());
      ctrl.text = readingStr;
      setState(() {
        _draftReadings[id] = readingStr;
        _rowOcr[id] = {
          'active': true,
          'reading': reading,
          'confidence': data['confidence'] ?? out['confidence'],
          'suggestionId': data['suggestion_id']?.toString(),
          'reason': (out['reason']?.toString().isNotEmpty == true)
              ? out['reason'].toString()
              : (data['warnings'] is List && (data['warnings'] as List).isNotEmpty)
                  ? (data['warnings'] as List).join(', ')
                  : null,
          'confirmed': false,
          'edited': false,
        };
      });
      ref.read(toastProvider.notifier).success('AI đã đọc chỉ số: $reading');
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể nhận diện AI từ ảnh này.'),
          );
    }
  }

  /// Batch record dirty inline drafts with status DRAFT or CONFIRMED.
  Future<void> _handleSaveBatch(String targetStatus) async {
    if (!ref.read(permissionProvider).canRecordMeters) return;

    final dirty = _meters.where((m) {
      final id = m['id']?.toString() ?? '';
      final draft = _draftReadings[id]?.trim() ?? '';
      if (draft.isEmpty) return false;
      return draft != (m['period_current_reading']?.toString() ?? '');
    }).toList();

    if (dirty.isEmpty) {
      ref.read(toastProvider.notifier).info('Chưa có thay đổi chỉ số mới nào cần lưu.');
      return;
    }

    for (final m in dirty) {
      final id = m['id']?.toString() ?? '';
      final prev = num.tryParse(
            (m['period_previous_reading'] ?? m['last_known_reading'] ?? 0).toString(),
          ) ??
          0;
      final valNum = num.tryParse(_draftReadings[id]!.trim());
      if (valNum == null || valNum < prev) {
        ref.read(toastProvider.notifier).warning(
              'Có dòng nhập chỉ số mới nhỏ hơn chỉ số cũ. Vui lòng kiểm tra các ô màu đỏ.',
            );
        return;
      }
    }

    setState(() => _batchSaving = true);
    try {
      final readings = dirty.map((m) {
        final id = m['id']?.toString() ?? '';
        final ocr = _rowOcr[id];
        final dataUrl = ocr?['imageBase64']?.toString();
        return <String, dynamic>{
          'meter_id': id,
          'period': _period,
          if (m['target_contract_id'] != null) 'contract_id': m['target_contract_id'],
          'status': targetStatus,
          'current_reading': num.tryParse(_draftReadings[id]!.trim()),
          'abnormal_note': (_abnormalNotes[id] ?? m['period_abnormal_note'] ?? '').toString().trim(),
          if (ocr?['suggestionId'] != null) 'ai_suggestion_id': ocr!['suggestionId'],
          if (dataUrl != null) 'image_base64': dataUrl,
        };
      }).toList();

      await ref.read(metersServiceProvider).recordBatch({
        'period': _period,
        'status': targetStatus,
        'readings': readings,
      });
      ref.read(toastProvider.notifier).success('Đã lưu thành công ${readings.length} chỉ số.');
      _fetchMeters(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể lưu chỉ số hàng loạt.'),
          );
    } finally {
      if (mounted) setState(() => _batchSaving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final perms = ref.watch(permissionProvider);
    final canManage = perms.canRecordMeters;
    final items = _filteredMeters;

    final totalCount = _meters.length;
    final confirmedCount = _meters.where((m) => m['period_reading_status'] == 'CONFIRMED').length;
    final abnormalCount = _meters.where((m) => m['period_is_abnormal'] == true).length;
    final draftCount = _meters.where((m) => m['period_reading_status'] == 'DRAFT').length;

    return Scaffold(
      key: const Key('route:/admin/meters'),
      backgroundColor: AppColors.background,
      body: RefreshIndicator(
        onRefresh: () => _fetchMeters(force: true),
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              PageHeader(
                title: 'Ghi chỉ số Điện / Nước',
                subtitle: 'Theo dõi chỉ số, đối soát ảnh công tơ bằng AI và giao ca giữa tháng (Turnover)',
                breadcrumbs: const [
                  BreadcrumbItem(label: 'Trang chủ', to: '/admin'),
                  BreadcrumbItem(label: 'Công tơ Điện/Nước'),
                ],
                actions: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    AppButton(
                      text: 'Import AI từ ảnh chụp',
                      icon: const Icon(LucideIcons.sparkles, size: 16),
                      variant: AppButtonVariant.primary,
                      onPressed: _openBatchImportModal,
                    ),
                    if (canManage) ...[
                      const SizedBox(width: 8),
                      AppButton(
                        text: 'Tạo công tơ',
                        icon: const Icon(LucideIcons.plus, size: 16),
                        variant: AppButtonVariant.outline,
                        onPressed: _openCreateMeterModal,
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 20),

              // Stats Cards
              LayoutBuilder(
                builder: (context, constraints) {
                  final cols = constraints.maxWidth > 900
                      ? 4
                      : (constraints.maxWidth >= 500 ? 2 : 1);
                  final itemWidth =
                      ((constraints.maxWidth - (cols - 1) * 16) / cols).floorToDouble();
                  final cards = [
                    StatsCard(
                      title: 'Tổng số công tơ',
                      value: totalCount.toString(),
                      icon: LucideIcons.gauge,
                      color: 'slate',
                    ),
                    StatsCard(
                      title: 'Đã chốt chỉ số',
                      value: '$confirmedCount / $totalCount',
                      icon: LucideIcons.checkCircle2,
                      color: 'emerald',
                    ),
                    StatsCard(
                      title: 'Chỉ số nháp',
                      value: draftCount.toString(),
                      icon: LucideIcons.fileEdit,
                      color: 'sky',
                    ),
                    StatsCard(
                      title: 'Cảnh báo biến động (>${_anomalyThresholdPct.round()}%)',
                      value: abnormalCount.toString(),
                      icon: LucideIcons.triangleAlert,
                      color: 'amber',
                    ),
                  ];
                  return Wrap(
                    spacing: 16,
                    runSpacing: 16,
                    children: [
                      for (final card in cards) SizedBox(width: itemWidth, child: card),
                    ],
                  );
                },
              ),
              const SizedBox(height: 20),

              // Filter Bar
              AppCard(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    Row(
                      children: [
                        Expanded(
                          flex: 2,
                          child: AppSelect<String>(
                            label: 'Tòa nhà',
                            value: _selectedBuildingId,
                            options: _buildings.map((b) {
                              return AppSelectOption(
                                value: b['id']?.toString() ?? '',
                                label: '${b['name']} (${b['code']})',
                              );
                            }).toList(),
                            onChanged: (val) {
                              if (val != null) {
                                setState(() => _selectedBuildingId = val);
                                _fetchMeters();
                              }
                            },
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: AppInput(
                            label: 'Kỳ chốt (YYYY-MM)',
                            initialValue: _period,
                            onChanged: (val) {
                              _period = val.trim();
                              if (_period.isEmpty || RegExp(r'^\d{4}-\d{2}$').hasMatch(_period)) {
                                _fetchMeters();
                              }
                            },
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: AppSelect<String>(
                            label: 'Loại đồng hồ',
                            value: _meterType,
                            options: kMeterTypeOptions.map((e) {
                              return AppSelectOption(value: e['value']!, label: e['label']!);
                            }).toList(),
                            onChanged: (val) => setState(() => _meterType = val ?? ''),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: AppSelect<String>(
                            label: 'Trạng thái',
                            value: _statusFilter,
                            options: meterStatusOptions(_anomalyThresholdPct).map((e) {
                              return AppSelectOption(value: e['value']!, label: e['label']!);
                            }).toList(),
                            onChanged: (val) => setState(() => _statusFilter = val ?? ''),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: AppSelect<String>(
                            label: 'Hợp đồng',
                            value: _activeContractFilter,
                            options: kMeterContractFilterOptions.map((e) {
                              return AppSelectOption(value: e['value']!, label: e['label']!);
                            }).toList(),
                            onChanged: (val) {
                              setState(() => _activeContractFilter = val ?? '');
                              _fetchMeters();
                            },
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          flex: 2,
                          child: Row(
                            children: [
                              Checkbox(
                                value: _abnormalOnly,
                                onChanged: (val) =>
                                    setState(() => _abnormalOnly = val ?? false),
                              ),
                              Expanded(
                                child: Text(
                                  'Chỉ hiện bất thường (>${_anomalyThresholdPct.round()}%)',
                                  style: const TextStyle(fontSize: 12, color: AppColors.slate700),
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
                        Expanded(
                          child: SearchBarWidget(
                            placeholder: 'Tìm theo mã căn hộ, mã công tơ...',
                            value: _search,
                            onChanged: (val) => setState(() => _search = val),
                          ),
                        ),
                        if (canManage) ...[
                          const SizedBox(width: 12),
                          AppButton(
                            text: 'Lưu nháp',
                            icon: const Icon(LucideIcons.save, size: 16),
                            variant: AppButtonVariant.outline,
                            loading: _batchSaving,
                            onPressed: () => _handleSaveBatch('DRAFT'),
                          ),
                          const SizedBox(width: 8),
                          AppButton(
                            text: 'Lưu & Chốt chỉ số',
                            icon: const Icon(LucideIcons.checkCheck, size: 16),
                            variant: AppButtonVariant.primary,
                            loading: _batchSaving,
                            onPressed: () => _handleSaveBatch('CONFIRMED'),
                          ),
                        ],
                        if (canManage && draftCount > 0) ...[
                          const SizedBox(width: 8),
                          AppButton(
                            text: 'Chốt toàn bộ ($draftCount bản nháp)',
                            icon: const Icon(LucideIcons.checkCheck, size: 16),
                            variant: AppButtonVariant.primary,
                            loading: _batchSaving,
                            onPressed: _handleConfirmAllEligible,
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),

              DataTableWidget<Map<String, dynamic>>(
                loading: _loading,
                pageSize: 20,
                data: items,
                emptyTitle: 'Chưa có công tơ nào',
                emptyDescription: 'Không tìm thấy công tơ phù hợp với bộ lọc.',
                emptyAction: canManage
                    ? AppButton(
                        text: 'Tạo công tơ mới',
                        icon: const Icon(LucideIcons.plus, size: 16),
                        variant: AppButtonVariant.primary,
                        onPressed: _openCreateMeterModal,
                      )
                    : null,
                columns: [
                  DataTableColumn<Map<String, dynamic>>(
                    key: 'apartment_code',
                    label: 'Căn hộ / Mã đồng hồ',
                    sortable: true,
                    flex: 2,
                    sortValue: (m) => m['apartment_code']?.toString() ?? '',
                    render: (meter) {
                      final turnoverBadge = resolveMeterTurnoverBadgeMeta(meter);
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Wrap(
                            spacing: 4,
                            crossAxisAlignment: WrapCrossAlignment.center,
                            children: [
                              Text(
                                'Căn ${meter['apartment_code'] ?? '—'}',
                                style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.slate900),
                              ),
                              if (turnoverBadge.isMultiSlot)
                                AppBadge(
                                  label: turnoverBadge.slotLabel ?? '',
                                  variant: AppBadgeVariant.indigo,
                                ),
                            ],
                          ),
                          const SizedBox(height: 2),
                          Text(
                            meter['meter_code']?.toString() ?? '',
                            style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: AppColors.slate500),
                          ),
                        ],
                      );
                    },
                  ),
                  DataTableColumn<Map<String, dynamic>>(
                    key: 'meter_type',
                    label: 'Loại & Đơn giá',
                    sortable: true,
                    flex: 2,
                    sortValue: (m) => m['meter_type']?.toString() ?? '',
                    render: (meter) {
                      final isElec = meter['meter_type'] == 'ELECTRICITY';
                      final unit = meter['unit'] ?? (isElec ? 'kWh' : 'm³');
                      final price = meter['effective_unit_price'] ?? meter['unit_price'] ?? 0;
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          AppBadge(
                            label: isElec ? 'Điện ($unit)' : 'Nước ($unit)',
                            variant: isElec ? AppBadgeVariant.amber : AppBadgeVariant.sky,
                            icon: Icon(isElec ? LucideIcons.zap : LucideIcons.droplets, size: 10),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            '${formatMoney(price)}/$unit',
                            style: const TextStyle(fontSize: 11, color: AppColors.slate500),
                          ),
                        ],
                      );
                    },
                  ),
                  DataTableColumn<Map<String, dynamic>>(
                    key: 'period_previous_reading',
                    label: 'Chỉ số cũ',
                    flex: 1,
                    render: (meter) {
                      final prevReading = meter['period_previous_reading'] ?? meter['last_known_reading'] ?? 0;
                      return Text(prevReading.toString());
                    },
                  ),
                  DataTableColumn<Map<String, dynamic>>(
                    key: 'period_current_reading',
                    label: 'Chỉ số mới',
                    flex: 1,
                    render: _buildInlineReadingCell,
                  ),
                  DataTableColumn<Map<String, dynamic>>(
                    key: 'period_consumption',
                    label: 'Tiêu thụ & Tiền',
                    flex: 2,
                    render: (meter) {
                      final isElec = meter['meter_type'] == 'ELECTRICITY';
                      final unit = meter['unit'] ?? (isElec ? 'kWh' : 'm³');
                      final consumption = meter['period_consumption'];
                      final isAbnormal = meter['period_is_abnormal'] == true;
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            consumption != null ? '$consumption $unit' : '—',
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          if (isAbnormal)
                            Text(
                              'Biến động >${_anomalyThresholdPct.round()}%',
                              style: const TextStyle(fontSize: 10, color: AppColors.amber600, fontWeight: FontWeight.bold),
                            ),
                        ],
                      );
                    },
                  ),
                  DataTableColumn<Map<String, dynamic>>(
                    key: 'period_reading_status',
                    label: 'Trạng thái',
                    width: 130,
                    render: (meter) {
                      final status = meter['period_reading_status'];
                      return Align(
                        alignment: Alignment.centerLeft,
                        child: status == 'CONFIRMED'
                            ? const AppBadge(label: 'Đã chốt', variant: AppBadgeVariant.emerald, dot: true)
                            : status == 'FLAGGED'
                                ? const AppBadge(label: 'Tạm giữ', variant: AppBadgeVariant.amber, dot: true)
                                : status == 'DRAFT'
                                    ? const AppBadge(label: 'Bản nháp', variant: AppBadgeVariant.sky, dot: true)
                                    : const Text('Chưa ghi', style: TextStyle(fontSize: 12, color: AppColors.slate400)),
                      );
                    },
                  ),
                  DataTableColumn<Map<String, dynamic>>(
                    key: 'actions',
                    label: 'Thao tác',
                    align: TextAlign.right,
                    width: 150,
                    render: (meter) {
                      final status = meter['period_reading_status'];
                      final isLocked = isMeterRowLockedForEdit(meter, canManage);
                      return Align(
                        alignment: Alignment.centerRight,
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (canManage && !isLocked)
                              IconButton(
                                padding: const EdgeInsets.all(6),
                                visualDensity: VisualDensity.compact,
                                constraints: const BoxConstraints(minWidth: 34, minHeight: 34),
                                icon: const Icon(LucideIcons.sparkles, size: 16, color: AppColors.amber600),
                                tooltip: 'AI OCR chỉ số',
                                onPressed: () => _scanRowOcr(meter),
                              ),
                            IconButton(
                              padding: const EdgeInsets.all(6),
                              visualDensity: VisualDensity.compact,
                              constraints: const BoxConstraints(minWidth: 34, minHeight: 34),
                              icon: const Icon(LucideIcons.fileEdit, size: 16, color: AppColors.slate600),
                              tooltip: 'Ghi chỉ số & Chi tiết',
                              onPressed: () => _openSingleDetailModal(meter),
                            ),
                            if (canManage && !isLocked && status == 'DRAFT')
                              IconButton(
                                padding: const EdgeInsets.all(6),
                                visualDensity: VisualDensity.compact,
                                constraints: const BoxConstraints(minWidth: 34, minHeight: 34),
                                icon: const Icon(LucideIcons.check, size: 16, color: AppColors.emerald600),
                                tooltip: 'Chốt nhanh',
                                onPressed: () => _handleQuickConfirm(meter),
                              ),
                          ],
                        ),
                      );
                    },
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
