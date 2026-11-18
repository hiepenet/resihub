import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/ai_helpers.dart' show formatConfidenceBadge;
import '../../../core/utils/base64_file.dart';
import '../../../core/utils/meter_batch_photo_helpers.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../ai_gateway/services/ai_service.dart';
import '../../buildings/services/buildings_service.dart';
import '../services/meters_service.dart';

/// React `MeterBatchPhotoImportModal.jsx:178-192`: ưu tiên tòa được truyền vào,
/// giữ lựa chọn cũ nếu còn hợp lệ, chỉ tự chọn khi danh sách có đúng 1 tòa.
String resolveBatchPhotoTargetBuildingId(
  String requestedId,
  List<Map<String, dynamic>> buildings, {
  String previousId = '',
}) {
  final ids = buildings.map((b) => b['id']?.toString()).whereType<String>().toSet();
  if (requestedId.isNotEmpty && ids.contains(requestedId)) return requestedId;
  if (previousId.isNotEmpty && ids.contains(previousId)) return previousId;
  return buildings.length == 1 ? (buildings.first['id']?.toString() ?? '') : '';
}

/// React `MeterBatchPhotoImportModal.jsx:499-508`: phản hồi có flagged/abnormal
/// thì toast cảnh báo, ngược lại toast thành công.
ToastVariant resolveBatchSaveToastVariant(dynamic response) {
  if (response is Map) {
    final flagged = response['flagged_count'];
    final abnormal = response['abnormal_count'];
    final flaggedCount = flagged is num ? flagged : num.tryParse(flagged?.toString() ?? '');
    final abnormalCount = abnormal is num ? abnormal : num.tryParse(abnormal?.toString() ?? '');
    if ((flaggedCount ?? 0) > 0 || (abnormalCount ?? 0) > 0) {
      return ToastVariant.warning;
    }
  }
  return ToastVariant.success;
}

/// Batch Meter Photo Import & AI OCR Modal (FR-030).
/// Port of `frontend/src/components/meters/MeterBatchPhotoImportModal.jsx`.
class MeterBatchPhotoImportModal extends ConsumerStatefulWidget {
  final String initialBuildingId;
  final String period;
  final num anomalyThresholdPct;
  final bool canWriteMeters;
  final List<Map<String, dynamic>>? initialItems;
  final VoidCallback? onSaved;
  final VoidCallback? onClose;

  const MeterBatchPhotoImportModal({
    super.key,
    this.initialBuildingId = '',
    required this.period,
    this.anomalyThresholdPct = 30,
    this.canWriteMeters = true,
    this.initialItems,
    this.onSaved,
    this.onClose,
  });

  /// Displays the modal in a full-screen overlay dialog.
  static Future<void> show({
    required BuildContext context,
    String initialBuildingId = '',
    required String period,
    num anomalyThresholdPct = 30,
    bool canWriteMeters = true,
    VoidCallback? onSaved,
  }) {
    return AppModal.show<void>(
      context: context,
      title: 'Import Chỉ số Điện / Nước Hàng loạt từ Ảnh Chụp (AI OCR)',
      subtitle: 'Kỳ chốt: $period • AI nhận diện công tơ từ tên file & mặt đồng hồ (Tối đa $kMaxBatchMeterPhotos ảnh/đợt)',
      size: AppModalSize.full,
      child: MeterBatchPhotoImportModal(
        initialBuildingId: initialBuildingId,
        period: period,
        anomalyThresholdPct: anomalyThresholdPct,
        canWriteMeters: canWriteMeters,
        onSaved: onSaved,
      ),
    );
  }

  @override
  ConsumerState<MeterBatchPhotoImportModal> createState() => _MeterBatchPhotoImportModalState();
}

class _MeterBatchPhotoImportModalState extends ConsumerState<MeterBatchPhotoImportModal> {
  List<Map<String, dynamic>> _buildings = [];
  String _targetBuildingId = '';
  List<Map<String, dynamic>> _buildingMeters = [];

  final List<Map<String, dynamic>> _items = [];
  final Map<String, TextEditingController> _readingControllers = {};
  final Map<String, TextEditingController> _noteControllers = {};
  final ScrollController _horizontalScrollController = ScrollController();
  int _queueTotal = 0;
  int _queueCompleted = 0;
  bool _isQueueRunning = false;
  String? _savingStatus;
  int _sessionGen = 0;

  @override
  void initState() {
    super.initState();
    _targetBuildingId = widget.initialBuildingId;
    if (widget.initialItems != null) {
      for (final raw in widget.initialItems!) {
        final copy = Map<String, dynamic>.from(raw);
        final id = copy['localId']?.toString() ?? '';
        _items.add(copy);
        _readingControllers[id] = TextEditingController(text: copy['draftReading']?.toString() ?? '');
        _noteControllers[id] = TextEditingController(text: copy['abnormalNote']?.toString() ?? '');
      }
    }
    _loadBuildingsAndMeters();
  }

  @override
  void dispose() {
    for (final c in _readingControllers.values) {
      c.dispose();
    }
    for (final c in _noteControllers.values) {
      c.dispose();
    }
    _readingControllers.clear();
    _noteControllers.clear();
    _horizontalScrollController.dispose();
    super.dispose();
  }

  Future<void> _loadBuildingsAndMeters() async {
    try {
      final bldgRes = await ref.read(buildingsServiceProvider).list();
      final list = (bldgRes is Map && bldgRes['data'] is List)
          ? (bldgRes['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : <Map<String, dynamic>>[];

      if (mounted) {
        setState(() {
          _buildings = list;
          _targetBuildingId = resolveBatchPhotoTargetBuildingId(
            widget.initialBuildingId,
            list,
            previousId: _targetBuildingId,
          );
        });
        if (_targetBuildingId.isNotEmpty) {
          _fetchBuildingMeters(_targetBuildingId);
        }
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách tòa nhà.'),
            );
      }
    }
  }

  Future<List<Map<String, dynamic>>> _fetchBuildingMeters(String bldgId) async {
    if (bldgId.isEmpty) {
      setState(() => _buildingMeters = []);
      return [];
    }

    try {
      final res = await ref.read(metersServiceProvider).list({
        'building_id': bldgId,
        'period': widget.period,
      });

      final list = (res is Map && res['data'] is List)
          ? (res['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : (res is List)
              ? res.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
              : <Map<String, dynamic>>[];

      if (mounted) {
        setState(() {
          _buildingMeters = list;
          // Rematch existing items
          final rematched = rematchBatchPhotoItemsForBuilding(_items, list, bldgId);
          _items.clear();
          _items.addAll(rematched);
        });
      }
      return list;
    } catch (err) {
      if (mounted) {
        setState(() {
          _buildingMeters = [];
        });
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách công tơ của tòa nhà.'),
            );
      }
      return [];
    }
  }

  Future<void> _pickPhotos() async {
    if (!widget.canWriteMeters) return;
    if (_isQueueRunning) {
      ref.read(toastProvider.notifier).warning('Hệ thống đang đọc lô ảnh hiện tại, vui lòng đợi.');
      return;
    }
    if (_targetBuildingId.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn Tòa nhà mục tiêu trước khi tải ảnh.');
      return;
    }

    final remainingSlots = kMaxBatchMeterPhotos - _items.length;
    if (remainingSlots <= 0) {
      ref.read(toastProvider.notifier).warning(
            'Mỗi đợt đối soát tối đa $kMaxBatchMeterPhotos ảnh. Vui lòng lưu hoặc xóa bớt dòng trước khi thêm ảnh mới.',
          );
      return;
    }

    // Pick multiple files using FilePicker
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['jpg', 'jpeg', 'png', 'webp'],
      allowMultiple: true,
      withData: true,
    );

    if (result == null || result.files.isEmpty) return;

    // React :364-371 — lọc MIME, báo tệp bị bỏ (FilePicker chỉ lọc theo extension trên vài nền tảng).
    final pickedFiles = result.files.where((f) {
      final ext = (f.extension ?? f.name.split('.').last).toLowerCase();
      return ext == 'jpg' || ext == 'jpeg' || ext == 'png' || ext == 'webp';
    }).toList();
    if (pickedFiles.length < result.files.length) {
      ref.read(toastProvider.notifier).warning(
            'Đã bỏ qua ${result.files.length - pickedFiles.length} tệp không phải ảnh JPG/PNG/WEBP.',
          );
    }
    if (pickedFiles.isEmpty) return;

    if (pickedFiles.length > remainingSlots) {
      ref.read(toastProvider.notifier).warning(
            'Chỉ nhận $remainingSlots ảnh đầu tiên để đảm bảo giới hạn tối đa $kMaxBatchMeterPhotos ảnh/đợt.',
          );
    }

    final accepted = pickedFiles.take(remainingSlots).toList();
    final List<Map<String, dynamic>> prepared = [];
    final currentGen = ++_sessionGen;

    for (final file in accepted) {
      final bytes = file.bytes;
      if (bytes == null) continue;

      try {
        final compressedDataUrl = await compressImageBytesToDataUrl(bytes, maxDimension: 1280);
        final match = matchMeterFromFilename(file.name, _buildingMeters);
        final localId = 'bmo-${DateTime.now().millisecondsSinceEpoch}-${file.name}';
        _readingControllers[localId] = TextEditingController(text: '');
        _noteControllers[localId] = TextEditingController(text: '');

        prepared.add({
          'localId': localId,
          'buildingId': _targetBuildingId,
          'fileName': file.name,
          'imageDataUri': compressedDataUrl,
          'matchKind': match.matchKind,
          'meterId': match.meterId,
          'apartmentId': match.apartmentId,
          'apartmentCode': match.apartmentCode,
          'meterTypeHint': match.meterTypeHint,
          'manualMeterAssigned': false,
          'draftReading': '',
          'userEditedReading': false,
          'abnormalNote': '',
          'ocrStatus': 'PENDING',
          'suggestionId': null,
          'confidence': null,
          'detectedMeterType': null,
          'aiReason': '',
          'aiWarnings': <String>[],
          'needsHumanReview': false,
          'ocrError': '',
        });
      } catch (err) {
        ref.read(toastProvider.notifier).error('Không thể đọc ảnh "${file.name}": $err');
      }
    }

    if (prepared.isEmpty || !mounted || _sessionGen != currentGen) return;

    setState(() {
      _items.addAll(prepared);
      _queueTotal = prepared.length;
      _queueCompleted = 0;
      _isQueueRunning = true;
    });

    // Run OCR with concurrency = 2
    await runBoundedConcurrencyQueue<Map<String, dynamic>, void>(
      prepared,
      kDefaultOcrConcurrency,
      (item, idx) async {
        try {
          await _runOcrForRow(item, currentGen);
        } finally {
          if (mounted && _sessionGen == currentGen) {
            setState(() {
              _queueCompleted++;
            });
          }
        }
      },
    );

    if (mounted && _sessionGen == currentGen) {
      setState(() => _isQueueRunning = false);
    }
  }

  Future<void> _runOcrForRow(Map<String, dynamic> rowSnapshot, int genId) async {
    if (_sessionGen != genId) return;

    final localId = rowSnapshot['localId'];
    setState(() {
      final idx = _items.indexWhere((r) => r['localId'] == localId);
      if (idx >= 0) {
        _items[idx]['ocrStatus'] = 'PROCESSING';
        _items[idx]['ocrError'] = '';
      }
    });

    final matchedMeter = rowSnapshot['meterId'] != null
        ? _buildingMeters.firstWhere((m) => m['id']?.toString() == rowSnapshot['meterId'].toString(), orElse: () => {})
        : null;

    final ocrPayload = <String, dynamic>{
      'period': widget.period,
      'image_base64': rowSnapshot['imageDataUri'],
    };

    if (matchedMeter != null && matchedMeter.isNotEmpty) {
      ocrPayload['meter_id'] = matchedMeter['id'];
      if (matchedMeter['target_contract_id'] != null) {
        ocrPayload['contract_id'] = matchedMeter['target_contract_id'];
      }
    } else {
      ocrPayload['building_id'] = _targetBuildingId;
      if (rowSnapshot['apartmentId'] != null) {
        ocrPayload['apartment_id'] = rowSnapshot['apartmentId'];
      }
    }

    try {
      final res = await ref.read(aiServiceProvider).ocrMeterReading(ocrPayload);
      if (_sessionGen != genId || !mounted) return;

      final data = res is Map ? (res['data'] is Map ? res['data'] : res) : {};
      final out = data['output'] is Map ? data['output'] : {};

      final autoMeterId = rowSnapshot['manualMeterAssigned'] == true
          ? rowSnapshot['meterId']
          : resolveMeterAfterOcr(
              item: rowSnapshot,
              ocrData: data,
              buildingMeters: _buildingMeters,
            );

      final hasAiReading = out['reading'] != null;

      setState(() {
        final idx = _items.indexWhere((r) => r['localId'] == localId);
        if (idx >= 0) {
          final curr = _items[idx];
          final currDraft = curr['draftReading']?.toString() ?? '';
          final userEdited = curr['userEditedReading'] == true && currDraft.trim().isNotEmpty;
          final nextDraft = userEdited
              ? currDraft
              : (hasAiReading ? out['reading'].toString() : currDraft);

          final key = localId.toString();
          final ctrl = _readingControllers.putIfAbsent(key, () => TextEditingController());
          if (ctrl.text != nextDraft) {
            ctrl.text = nextDraft;
          }

          _items[idx]['meterId'] = curr['manualMeterAssigned'] == true
              ? curr['meterId']
              : (autoMeterId ?? curr['meterId']);
          _items[idx]['draftReading'] = nextDraft;
          _items[idx]['ocrStatus'] = hasAiReading ? 'DONE' : 'NEEDS_MANUAL';
          _items[idx]['suggestionId'] = data['suggestion_id'];
          _items[idx]['confidence'] = data['confidence'] ?? out['confidence'];
          _items[idx]['detectedMeterType'] = out['detected_meter_type'];
          _items[idx]['aiReason'] = out['reason']?.toString() ?? '';
          _items[idx]['aiWarnings'] = data['warnings'] is List ? data['warnings'] : <String>[];
          _items[idx]['needsHumanReview'] = data['needs_human_review'] == true;
          _items[idx]['ocrError'] = '';
        }
      });
    } catch (err) {
      if (_sessionGen != genId || !mounted) return;
      setState(() {
        final idx = _items.indexWhere((r) => r['localId'] == localId);
        if (idx >= 0) {
          _items[idx]['ocrStatus'] = 'FAILED';
          _items[idx]['ocrError'] = extractErrorMessage(err, 'Lỗi nhận diện AI');
        }
      });
    }
  }

  Future<void> _handleSaveBatch(String targetStatus) async {
    if (!widget.canWriteMeters) return;

    final evaluation = evaluateBatchPhotoImportItems(
      _items,
      _buildingMeters,
      anomalyThresholdPct: widget.anomalyThresholdPct,
      canWriteMeters: widget.canWriteMeters,
    );

    if (evaluation.saveableRows.isEmpty) {
      ref.read(toastProvider.notifier).warning('Không có dòng nào đủ điều kiện lưu.');
      return;
    }

    setState(() => _savingStatus = targetStatus);

    try {
      final payload = buildBatchPhotoSavePayload(
        saveableRows: evaluation.saveableRows,
        period: widget.period,
        targetStatus: targetStatus,
      );

      final res = await ref.read(metersServiceProvider).recordBatch(payload);

      final savedIds = evaluation.saveableRows.map((r) => r.raw['localId']).toSet();
      final remaining = _items.where((r) => !savedIds.contains(r['localId'])).toList();

      widget.onSaved?.call();

      if (remaining.isEmpty) {
        final toastVariant = resolveBatchSaveToastVariant(res);
        final message = res is Map && res['message'] != null
            ? res['message'].toString()
            : toastVariant == ToastVariant.warning
                ? 'Đã lưu ${payload['readings'].length} chỉ số (có chỉ số biến động >${widget.anomalyThresholdPct}%).'
                : 'Đã import thành công ${payload['readings'].length} chỉ số công tơ.';
        if (toastVariant == ToastVariant.warning) {
          ref.read(toastProvider.notifier).warning(message);
        } else {
          ref.read(toastProvider.notifier).success(message);
        }
        setState(() => _items.clear());
        if (mounted) Navigator.of(context).pop();
      } else {
        setState(() {
          _items.clear();
          _items.addAll(remaining);
        });
        await _fetchBuildingMeters(_targetBuildingId);
        ref.read(toastProvider.notifier).warning(
              'Đã lưu ${payload['readings'].length} chỉ số hợp lệ. Còn ${remaining.length} ảnh cần kiểm tra tiếp.',
            );
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể lưu lô chỉ số từ ảnh.'),
          );
    } finally {
      if (mounted) setState(() => _savingStatus = null);
    }
  }

  /// React :452-460 / :1016-1029 — đọc lại AI cho từng dòng.
  Future<void> _retrySingleRow(Map<String, dynamic> row) async {
    if (!widget.canWriteMeters || _targetBuildingId.isEmpty || _isQueueRunning || _savingStatus != null) {
      return;
    }
    await _runOcrForRow(Map<String, dynamic>.from(row), _sessionGen);
  }

  Widget _buildValidationBadge(BatchPhotoImportRow row) {
    switch (row.validationState) {
      case 'OCR_PROCESSING':
        return const AppBadge(label: 'Đang đọc AI...', variant: AppBadgeVariant.indigo, dot: true);
      case 'MISSING_METER':
        return const AppBadge(label: 'Chọn công tơ', variant: AppBadgeVariant.amber, dot: true);
      case 'LOCKED_BILLED':
        return const AppBadge(label: 'Đã lập HĐ', variant: AppBadgeVariant.slate, icon: Icon(LucideIcons.lock, size: 10));
      case 'DUPLICATE_METER_TARGET':
        return const AppBadge(label: 'Trùng công tơ', variant: AppBadgeVariant.red, dot: true);
      case 'MISSING_READING':
        return const AppBadge(label: 'Chưa có số mới', variant: AppBadgeVariant.amber, dot: true);
      case 'INVALID_READING':
        return const AppBadge(label: 'Nhỏ hơn số cũ', variant: AppBadgeVariant.red, dot: true);
      case 'READY_ABNORMAL':
        return AppBadge(label: 'Biến động >${widget.anomalyThresholdPct}%', variant: AppBadgeVariant.amber, dot: true);
      case 'READY':
        return const AppBadge(label: 'Sẵn sàng lưu', variant: AppBadgeVariant.emerald, dot: true);
      default:
        return const SizedBox.shrink();
    }
  }

  @override
  Widget build(BuildContext context) {
    final evaluation = evaluateBatchPhotoImportItems(
      _items,
      _buildingMeters,
      anomalyThresholdPct: widget.anomalyThresholdPct,
      canWriteMeters: widget.canWriteMeters,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        // Controls Row
        Row(
          children: [
            Expanded(
              flex: 2,
              child: AppSelect<String>(
                label: 'Tòa nhà mục tiêu',
                value: _targetBuildingId,
                options: _buildings.map((b) {
                  return AppSelectOption(
                    value: b['id']?.toString() ?? '',
                    label: '${b['name']} (${b['code']})',
                  );
                }).toList(),
                onChanged: (val) {
                  if (val != null && val != _targetBuildingId) {
                    setState(() => _targetBuildingId = val);
                    _fetchBuildingMeters(val);
                  }
                },
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              flex: 3,
              child: Padding(
                padding: const EdgeInsets.only(top: 20.0),
                child: Row(
                  children: [
                    AppButton(
                      text: 'Tải ảnh chụp (Tối đa $kMaxBatchMeterPhotos ảnh)',
                      icon: const Icon(LucideIcons.cloudUpload, size: 16),
                      variant: AppButtonVariant.primary,
                      onPressed: _isQueueRunning ? null : _pickPhotos,
                    ),
                    if (_items.isNotEmpty) ...[
                      const SizedBox(width: 8),
                      AppButton(
                        text: 'Xóa toàn bộ',
                        variant: AppButtonVariant.outline,
                        onPressed: _isQueueRunning
                            ? null
                            : () {
                                _sessionGen++;
                                for (final c in _readingControllers.values) {
                                  c.dispose();
                                }
                                for (final c in _noteControllers.values) {
                                  c.dispose();
                                }
                                _readingControllers.clear();
                                _noteControllers.clear();
                                setState(() => _items.clear());
                              },
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),

        const SizedBox(height: 12),
        _buildTipBox(),

        if (_isQueueRunning) ...[
          const SizedBox(height: 12),
          LinearProgressIndicator(
            value: _queueTotal > 0 ? _queueCompleted / _queueTotal : null,
            backgroundColor: AppColors.slate200,
            valueColor: const AlwaysStoppedAnimation(AppColors.primary500),
          ),
          const SizedBox(height: 4),
          Text(
            'Đang xử lý AI OCR ($_queueCompleted/$_queueTotal ảnh)...',
            style: const TextStyle(fontSize: 12, color: AppColors.slate500),
          ),
        ],

        const SizedBox(height: 16),

        // FR-031 — React :773-785: cảnh báo dòng biến động >ngưỡng thiếu ghi chú giải trình.
        if (evaluation.summary.abnormalMissingNoteCount > 0)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: AppColors.amber50,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: AppColors.amber200),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(LucideIcons.triangleAlert, size: 16, color: AppColors.amber600),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Có ${evaluation.summary.abnormalMissingNoteCount} công tơ biến động vượt ngưỡng '
                    '>${widget.anomalyThresholdPct}% chưa nhập ghi chú giải trình. Nếu bấm '
                    '"Lưu & Chốt chỉ số" ngay, hệ thống sẽ tự động giữ các dòng đó ở trạng thái '
                    'Tạm giữ (FLAGGED) theo quy tắc an toàn FR-031; nhập ghi chú giải trình để '
                    'chốt thẳng sang CONFIRMED.',
                    style: const TextStyle(fontSize: 12, color: Color(0xFF78350F)),
                  ),
                ),
              ],
            ),
          ),

        if (evaluation.summary.abnormalMissingNoteCount > 0) const SizedBox(height: 12),

        // Items Table
        if (_items.isEmpty) ...[
          Container(
            padding: const EdgeInsets.symmetric(vertical: 48),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              border: Border.all(color: AppColors.border),
              borderRadius: BorderRadius.circular(12),
              color: AppColors.slate50,
            ),
            child: Column(
              children: [
                const Icon(LucideIcons.image, size: 40, color: AppColors.slate400),
                const SizedBox(height: 8),
                const Text(
                  'Chưa có ảnh nào được chọn',
                  style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.slate700),
                ),
                const SizedBox(height: 4),
                Text(
                  'Chọn tòa nhà và nhấn "Tải ảnh chụp" để AI đọc chỉ số công tơ tự động',
                  style: const TextStyle(fontSize: 12, color: AppColors.slate500),
                ),
              ],
            ),
          ),
        ] else ...[
          Container(
            constraints: const BoxConstraints(maxHeight: 450),
            decoration: BoxDecoration(
              border: Border.all(color: AppColors.border),
              borderRadius: BorderRadius.circular(12),
            ),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final minWidth = constraints.maxWidth.isFinite ? constraints.maxWidth : 600.0;
                return Scrollbar(
                  controller: _horizontalScrollController,
                  thumbVisibility: true,
                  child: SingleChildScrollView(
                    child: SingleChildScrollView(
                      controller: _horizontalScrollController,
                      scrollDirection: Axis.horizontal,
                      child: ConstrainedBox(
                        constraints: BoxConstraints(minWidth: minWidth),
                        child: DataTable(
                          columnSpacing: 12.0,
                          horizontalMargin: 12.0,
                          dataRowMinHeight: 72.0,
                          dataRowMaxHeight: 96.0,
                          headingRowColor: WidgetStateProperty.all(AppColors.slate50),
                          columns: [
                            const DataColumn(label: SizedBox(width: 46, child: Text('Ảnh'))),
                            const DataColumn(label: SizedBox(width: 175, child: Text('Tệp & Gợi ý AI'))),
                            const DataColumn(label: SizedBox(width: 180, child: Text('Công tơ đích'))),
                            const DataColumn(label: SizedBox(width: 50, child: Text('Số cũ', textAlign: TextAlign.right))),
                            DataColumn(label: SizedBox(width: 84, child: Text('Số mới (${widget.period})'))),
                            const DataColumn(label: SizedBox(width: 86, child: Text('Tiêu thụ', textAlign: TextAlign.right))),
                            const DataColumn(label: SizedBox(width: 145, child: Text('Ghi chú giải trình'))),
                            const DataColumn(label: SizedBox(width: 100, child: Text('Đánh giá'))),
                            const DataColumn(label: Text('Thao tác')),
                          ],
                          rows: evaluation.rows.map((evalRow) {
                            final raw = evalRow.raw;
                            final meter = evalRow.meter;
                            final localId = raw['localId'];
                            final localKey = localId.toString();
                            final confMeta = raw['confidence'] != null
                                ? formatConfidenceBadge(raw['confidence'], 0.8)
                                : null;

                            return DataRow(
                              cells: [
                                DataCell(
                                  SizedBox(
                                    width: 46,
                                    child: InkWell(
                                      onTap: () {
                                        if (raw['imageDataUri'] != null) {
                                          AuthMediaViewer.show(context, src: raw['imageDataUri'].toString());
                                        }
                                      },
                                      child: ClipRRect(
                                        borderRadius: BorderRadius.circular(6),
                                        child: AuthImage(
                                          src: raw['imageDataUri']?.toString(),
                                          width: 44,
                                          height: 44,
                                          fit: BoxFit.cover,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                                DataCell(
                                  SizedBox(
                                    width: 175,
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      mainAxisAlignment: MainAxisAlignment.center,
                                      children: [
                                        Text(
                                          raw['fileName']?.toString() ?? '',
                                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.slate900),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                        const SizedBox(height: 3),
                                        Wrap(
                                          spacing: 4,
                                          runSpacing: 4,
                                          children: [
                                            if (raw['detectedMeterType'] == 'ELECTRICITY')
                                              const AppBadge(
                                                label: 'AI: Điện',
                                                variant: AppBadgeVariant.amber,
                                                icon: Icon(LucideIcons.zap, size: 10),
                                              ),
                                            if (raw['detectedMeterType'] == 'WATER')
                                              const AppBadge(
                                                label: 'AI: Nước',
                                                variant: AppBadgeVariant.sky,
                                                icon: Icon(LucideIcons.droplets, size: 10),
                                              ),
                                            if (raw['detectedMeterType'] == null &&
                                                raw['matchKind'] == 'APARTMENT_ONLY' &&
                                                raw['apartmentCode'] != null)
                                              AppBadge(
                                                label: 'Khớp căn ${raw['apartmentCode']}',
                                                variant: AppBadgeVariant.slate,
                                              ),
                                            if (confMeta != null)
                                              AppBadge(
                                                label: 'AI ${confMeta.percentText}',
                                                variant: AppBadgeVariant.fromString(confMeta.tone),
                                              ),
                                          ],
                                        ),
                                        if (evalRow.hasTypeMismatchWarning)
                                          Text(
                                            'Ảnh chụp nghi là đồng hồ ${raw['detectedMeterType'] == 'WATER' ? 'Nước' : 'Điện'}, khác loại công tơ đang chọn!',
                                            style: const TextStyle(fontSize: 10, color: AppColors.rose600),
                                            maxLines: 2,
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                        if (raw['ocrError'] != null && raw['ocrError'].toString().isNotEmpty)
                                          Text(
                                            raw['ocrError'].toString(),
                                            style: const TextStyle(fontSize: 10, color: AppColors.rose600),
                                            maxLines: 2,
                                            overflow: TextOverflow.ellipsis,
                                          )
                                        else if (raw['aiReason'] != null && raw['aiReason'].toString().isNotEmpty)
                                          Text(
                                            raw['aiReason'].toString(),
                                            style: const TextStyle(fontSize: 10, color: AppColors.slate500),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                      ],
                                    ),
                                  ),
                                ),
                                DataCell(
                                  SizedBox(
                                    width: 180,
                                    child: () {
                                      final meterIdVal = raw['meterId']?.toString();
                                      final hasMatchingItem = meterIdVal != null &&
                                          _buildingMeters.any((m) => m['id']?.toString() == meterIdVal);
                                      return DropdownButton<String>(
                                        isExpanded: true,
                                        value: meterIdVal,
                                        hint: const Text('-- Chọn công tơ --', style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                                        items: [
                                          const DropdownMenuItem(
                                            value: null,
                                            child: Text('-- Chọn công tơ --', style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                                          ),
                                          if (meterIdVal != null && !hasMatchingItem)
                                            DropdownMenuItem(
                                              value: meterIdVal,
                                              child: Text(
                                                'Công tơ $meterIdVal',
                                                style: const TextStyle(fontSize: 12),
                                                overflow: TextOverflow.ellipsis,
                                              ),
                                            ),
                                          ..._buildingMeters.map((m) {
                                            final type = m['meter_type'] == 'WATER' ? 'Nước' : 'Điện';
                                            return DropdownMenuItem(
                                              value: m['id']?.toString(),
                                              child: Text(
                                                'Căn ${m['apartment_code'] ?? '—'} • $type (${m['meter_code']})',
                                                style: const TextStyle(fontSize: 12),
                                                overflow: TextOverflow.ellipsis,
                                              ),
                                            );
                                          }),
                                        ],
                                        onChanged: (val) {
                                          setState(() {
                                            final idx = _items.indexWhere((r) => r['localId'] == localId);
                                            if (idx >= 0) {
                                              _items[idx]['meterId'] = val;
                                              _items[idx]['manualMeterAssigned'] = true;
                                            }
                                          });
                                        },
                                      );
                                    }(),
                                  ),
                                ),
                                DataCell(
                                  SizedBox(
                                    width: 50,
                                    child: Align(
                                      alignment: Alignment.centerRight,
                                      child: Text(
                                        evalRow.prevReading != null ? evalRow.prevReading.toString() : '—',
                                        style: const TextStyle(fontSize: 12, color: AppColors.slate600),
                                      ),
                                    ),
                                  ),
                                ),
                                DataCell(
                                  SizedBox(
                                    width: 84,
                                    child: AppInput(
                                      controller: _readingControllers.putIfAbsent(
                                        localKey,
                                        () => TextEditingController(text: raw['draftReading']?.toString() ?? ''),
                                      ),
                                      onChanged: (val) {
                                        final idx = _items.indexWhere((r) => r['localId'] == localId);
                                        if (idx >= 0) {
                                          _items[idx]['draftReading'] = val.trim();
                                          _items[idx]['userEditedReading'] = true;
                                        }
                                        setState(() {});
                                      },
                                    ),
                                  ),
                                ),
                                DataCell(
                                  SizedBox(
                                    width: 86,
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.end,
                                      mainAxisAlignment: MainAxisAlignment.center,
                                      children: [
                                        Text(
                                          evalRow.consumption != null ? '+${evalRow.consumption} ${meter?['unit'] ?? ''}' : '—',
                                          style: TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w600,
                                            color: evalRow.isAbnormal ? AppColors.amber700 : AppColors.slate900,
                                          ),
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                        if (evalRow.diffPct != null)
                                          Text(
                                            '${evalRow.diffPct! > 0 ? '+' : ''}${evalRow.diffPct}%',
                                            style: TextStyle(
                                              fontSize: 11,
                                              color: evalRow.isAbnormal ? AppColors.amber600 : AppColors.slate500,
                                              fontWeight: evalRow.isAbnormal ? FontWeight.bold : FontWeight.normal,
                                            ),
                                          ),
                                      ],
                                    ),
                                  ),
                                ),
                                DataCell(
                                  SizedBox(
                                    width: 145,
                                    child: AppInput(
                                      controller: _noteControllers.putIfAbsent(
                                        localKey,
                                        () => TextEditingController(text: raw['abnormalNote']?.toString() ?? ''),
                                      ),
                                      placeholder: evalRow.isAbnormal
                                          ? 'Giải trình biến động >${widget.anomalyThresholdPct}%...'
                                          : 'Ghi chú (nếu có)...',
                                      onChanged: (val) {
                                        final idx = _items.indexWhere((r) => r['localId'] == localId);
                                        if (idx >= 0) {
                                          _items[idx]['abnormalNote'] = val;
                                        }
                                        setState(() {});
                                      },
                                    ),
                                  ),
                                ),
                                DataCell(
                                  SizedBox(
                                    width: 100,
                                    child: _buildValidationBadge(evalRow),
                                  ),
                                ),
                                DataCell(
                                  Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      TextButton.icon(
                                        style: TextButton.styleFrom(
                                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                                          minimumSize: Size.zero,
                                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                        ),
                                        onPressed: _isQueueRunning ||
                                                _savingStatus != null ||
                                                evalRow.validationState == 'OCR_PROCESSING'
                                            ? null
                                            : () => _retrySingleRow(raw),
                                        icon: const Icon(LucideIcons.refreshCw, size: 12),
                                        label: const Text('Thử lại', style: TextStyle(fontSize: 11)),
                                      ),
                                      const SizedBox(width: 2),
                                      InkWell(
                                        borderRadius: BorderRadius.circular(6),
                                        onTap: () {
                                          setState(() {
                                            _readingControllers[localKey]?.dispose();
                                            _readingControllers.remove(localKey);
                                            _noteControllers[localKey]?.dispose();
                                            _noteControllers.remove(localKey);
                                            _items.removeWhere((r) => r['localId'] == localId);
                                          });
                                        },
                                        child: const Tooltip(
                                          message: 'Xóa ảnh',
                                          child: Padding(
                                            padding: EdgeInsets.all(5),
                                            child: Icon(LucideIcons.trash2, size: 15, color: AppColors.slate400),
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            );
                          }).toList(),
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],

        const SizedBox(height: 16),

        // Summary Bar & Action Buttons
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AppColors.slate50,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: AppColors.border),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Wrap(
                spacing: 8,
                children: [
                  AppBadge(label: 'Hợp lệ: ${evaluation.summary.saveableCount}', variant: AppBadgeVariant.emerald),
                  if (evaluation.summary.abnormalSaveableCount > 0)
                    AppBadge(
                      label: 'Cảnh báo >${widget.anomalyThresholdPct}%: ${evaluation.summary.abnormalSaveableCount}',
                      variant: AppBadgeVariant.amber,
                    ),
                  if (evaluation.summary.duplicateCount > 0)
                    AppBadge(label: 'Trùng: ${evaluation.summary.duplicateCount}', variant: AppBadgeVariant.red),
                  if (evaluation.summary.skippedCount > 0)
                    AppBadge(label: 'Bỏ qua: ${evaluation.summary.skippedCount}', variant: AppBadgeVariant.slate),
                ],
              ),
              Row(
                children: [
                  AppButton(
                    text: 'Lưu nháp',
                    variant: AppButtonVariant.outline,
                    loading: _savingStatus == 'DRAFT',
                    onPressed: evaluation.saveableRows.isEmpty || _isQueueRunning
                        ? null
                        : () => _handleSaveBatch('DRAFT'),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Lưu & Chốt chỉ số',
                    variant: AppButtonVariant.primary,
                    loading: _savingStatus == 'CONFIRMED',
                    onPressed: evaluation.saveableRows.isEmpty || _isQueueRunning
                        ? null
                        : () => _handleSaveBatch('CONFIRMED'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildTipBox() {
    Widget buildCodeSnippet(String text) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.85),
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: const Color(0xFFC7D2FE)),
        ),
        child: Text(
          text,
          style: const TextStyle(
            fontFamily: 'monospace',
            fontSize: 11,
            fontWeight: FontWeight.w600,
            color: Color(0xFF3730A3),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFEEF2FF), // Indigo-50
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFC7D2FE)), // Indigo-200
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(LucideIcons.info, size: 16, color: Color(0xFF4F46E5)), // Indigo-600
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Mẹo đặt tên ảnh để tự động nhận diện phòng & công tơ nhanh nhất:',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF312E81), // Indigo-900
                  ),
                ),
                const SizedBox(height: 6),
                Padding(
                  padding: const EdgeInsets.only(left: 4.0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        crossAxisAlignment: WrapCrossAlignment.center,
                        spacing: 4,
                        runSpacing: 4,
                        children: [
                          const Text(
                            '• Có tên phòng + loại đồng hồ:',
                            style: TextStyle(fontSize: 11, color: Color(0xFF3730A3)),
                          ),
                          buildCodeSnippet('A1001_dien.jpg'),
                          buildCodeSnippet('A1001_nuoc.png'),
                          buildCodeSnippet('A1001-E.jpg'),
                          buildCodeSnippet('A1001-W.jpg'),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Wrap(
                        crossAxisAlignment: WrapCrossAlignment.center,
                        spacing: 4,
                        runSpacing: 4,
                        children: [
                          const Text(
                            '• Chỉ ghi tên phòng:',
                            style: TextStyle(fontSize: 11, color: Color(0xFF3730A3)),
                          ),
                          buildCodeSnippet('A1001 (1).jpg'),
                          buildCodeSnippet('A1001 (2).jpg'),
                          const Text(
                            '— AI sẽ tự nhìn đơn vị kWh / m³ trên mặt đồng hồ để phân biệt Điện hay Nước!',
                            style: TextStyle(fontSize: 11, color: Color(0xFF3730A3)),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Wrap(
                        crossAxisAlignment: WrapCrossAlignment.center,
                        spacing: 4,
                        runSpacing: 4,
                        children: [
                          const Text(
                            '• Ảnh từ điện thoại chưa kịp đổi tên (',
                            style: TextStyle(fontSize: 11, color: Color(0xFF3730A3)),
                          ),
                          buildCodeSnippet('IMG_4021.jpg'),
                          const Text(
                            ') vẫn đọc chỉ số AI bình thường và chọn lại công tơ ngay tại cột Công tơ đích.',
                            style: TextStyle(fontSize: 11, color: Color(0xFF3730A3)),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
